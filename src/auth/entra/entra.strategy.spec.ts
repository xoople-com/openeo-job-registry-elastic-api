import {
  ForbiddenException,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import {
  createLocalJWKSet,
  createRemoteJWKSet,
  exportJWK,
  generateKeyPair,
  JWTPayload,
  JWTVerifyGetKey,
  KeyLike,
  SignJWT,
} from 'jose';
import { createServer, Server } from 'http';
import { AddressInfo } from 'net';
import {
  EntraOptions,
  EntraStrategy,
  buildEntraStrategy,
  configList,
} from './entra.strategy';
import { Issuer } from 'openid-client';
import { ConfigService } from '../../config/config/config.service';
import { Test } from '@nestjs/testing';
import { Client } from '@elastic/elasticsearch';
import * as request from 'supertest';
import { AppModule } from '../../app.module';
import { JOB } from '../../jobs/mocks/job.mock';

export const entraOptions: EntraOptions = {
  issuer:
    'https://login.microsoftonline.com/8f0cef0d-4bae-4451-bc81-9b45fc92d79d/v2.0',
  audience: '4228c6e7-d99d-4ef2-8739-cb0ad724da43',
  roles: ['JobRegistry.Access'],
  clientIds: ['e0d2c71d-ec17-46b0-aacb-6b169f2aaa17'],
};

describe('EntraStrategy', () => {
  let privateKey: KeyLike;
  let strategy: EntraStrategy;
  let localKeys: JWTVerifyGetKey;

  const sign = (claims: JWTPayload = {}, key = privateKey, kid = 'first') =>
    new SignJWT({
      iss: entraOptions.issuer,
      aud: entraOptions.audience,
      sub: 'service-principal',
      azp: entraOptions.clientIds[0],
      ver: '2.0',
      roles: ['JobRegistry.Access'],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 60,
      ...claims,
    })
      .setProtectedHeader({ alg: 'RS256', kid })
      .sign(key);

  beforeAll(async () => {
    const pair = await generateKeyPair('RS256');
    privateKey = pair.privateKey;
    localKeys = createLocalJWKSet({
      keys: [
        { ...(await exportJWK(pair.publicKey)), kid: 'first', alg: 'RS256' },
      ],
    });
  });

  beforeEach(() => {
    strategy = new EntraStrategy(entraOptions, localKeys);
  });

  afterEach(() => jest.restoreAllMocks());

  it('accepts a signed application access token', async () => {
    expect(await strategy.validate(await sign())).toMatchObject({
      azp: entraOptions.clientIds[0],
      roles: ['JobRegistry.Access'],
    });
  });

  it.each([
    { exp: Math.floor(Date.now() / 1000) - 60 },
    { exp: undefined },
    { aud: 'other-api' },
    { iss: 'https://login.microsoftonline.com/other-tenant/v2.0' },
    { nbf: Math.floor(Date.now() / 1000) + 3600 },
  ])(
    'rejects invalid temporal, issuer and audience claims (%j)',
    async (claims) => {
      await expect(
        strategy.validate(await sign(claims)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    },
  );

  it.each([
    { roles: undefined },
    { roles: ['Other.Role'] },
    { roles: 'JobRegistry.Access' },
    { azp: 'other-caller' },
    { ver: '1.0' },
    { scp: 'delegated.permission' },
  ])(
    'rejects missing roles, unapproved callers and delegated tokens (%j)',
    async (claims) => {
      await expect(
        strategy.validate(await sign(claims)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    },
  );

  it('rejects forged signatures, unsigned tokens and malformed tokens', async () => {
    const other = await generateKeyPair('RS256');
    await expect(
      strategy.validate(await sign({}, other.privateKey)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(strategy.validate('not-a-token')).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    const unsigned = `${Buffer.from('{"alg":"none"}').toString(
      'base64url',
    )}.${Buffer.from('{}').toString('base64url')}.`;
    await expect(strategy.validate(unsigned)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('does not cache authorization past token expiry', async () => {
    const token = await sign({ exp: Math.floor(Date.now() / 1000) + 1 });
    await strategy.validate(token);
    jest.useFakeTimers();
    try {
      jest.setSystemTime(Date.now() + 2000);
      await expect(strategy.validate(token)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('surfaces signing-key infrastructure failures', async () => {
    const unavailable = new EntraStrategy(entraOptions, async () => {
      throw new Error('network error with sensitive details');
    });
    await expect(unavailable.validate(await sign())).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('refreshes signing keys after rotation', async () => {
    const first = await generateKeyPair('RS256');
    const second = await generateKeyPair('RS256');
    let keys = [
      { ...(await exportJWK(first.publicKey)), kid: 'first', alg: 'RS256' },
    ];
    const server: Server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ keys }));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    try {
      const address = server.address() as AddressInfo;
      const remote = new EntraStrategy(
        entraOptions,
        createRemoteJWKSet(new URL(`http://127.0.0.1:${address.port}/keys`), {
          cooldownDuration: 0,
        }),
      );
      await remote.validate(await sign({}, first.privateKey));
      keys = [
        { ...(await exportJWK(second.publicKey)), kid: 'second', alg: 'RS256' },
      ];
      await remote.validate(await sign({}, second.privateKey, 'second'));
      await expect(
        remote.validate(await sign({}, first.privateKey)),
      ).rejects.toBeInstanceOf(UnauthorizedException);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it('uses trusted discovery without needing a client secret', async () => {
    const values = {
      'auth.entra.issuer': entraOptions.issuer,
      'auth.entra.audience': entraOptions.audience,
      'auth.entra.roles': ' JobRegistry.Access, ',
      'auth.entra.clientIds': entraOptions.clientIds.join(','),
    };
    const config = new ConfigService();
    jest.spyOn(config, 'get').mockImplementation((name) => values[name]);
    const discover = jest.spyOn(Issuer, 'discover').mockResolvedValue(
      new Issuer({
        issuer: entraOptions.issuer,
        jwks_uri: 'https://login.microsoftonline.com/keys',
      }),
    );
    expect(await buildEntraStrategy(config)).toBeInstanceOf(EntraStrategy);
    expect(discover).toHaveBeenCalledWith(entraOptions.issuer);
    expect(configList(' one, two, ')).toEqual(['one', 'two']);
    discover.mockResolvedValue(new Issuer({ issuer: 'https://other-issuer' }));
    await expect(buildEntraStrategy(config)).rejects.toThrow('Entra discovery');
  });

  it('enforces JWT authentication on HTTP job routes and leaves probes unauthenticated', async () => {
    const database = {
      index: jest.fn().mockResolvedValue({ result: 'created' }),
      search: jest
        .fn()
        .mockResolvedValue({ hits: { hits: [{ _id: 'doc', _source: JOB }] } }),
      close: jest.fn(),
    };
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider('BearerStrategy')
      .useValue(strategy)
      .overrideProvider(Client)
      .useValue(database)
      .compile();
    const app = module.createNestApplication();
    await app.init();
    try {
      await request(app.getHttpServer()).post('/jobs').send(JOB).expect(401);
      await request(app.getHttpServer())
        .post('/jobs')
        .set('Authorization', 'Bearer invalid')
        .send(JOB)
        .expect(401);
      await request(app.getHttpServer())
        .post('/jobs')
        .set('Authorization', `Bearer ${await sign({ roles: [] })}`)
        .send(JOB)
        .expect(403);
      await request(app.getHttpServer())
        .post('/jobs')
        .set('Authorization', `Bearer ${await sign()}`)
        .send(JOB)
        .expect(201)
        .expect(JOB);
      await request(app.getHttpServer())
        .post('/jobs/search/paginated')
        .set('Authorization', `Bearer ${await sign()}`)
        .send({ query: { match_all: {} } })
        .expect(200)
        .expect({
          jobs: [JOB],
          pagination: { previous: null, next: null },
        });
      await request(app.getHttpServer()).get('/health/ready').expect(200);
      database.search.mockRejectedValue(new Error('Elastic unavailable'));
      await request(app.getHttpServer()).get('/health/ready').expect(503);
      await request(app.getHttpServer())
        .get('/health/live')
        .expect(200)
        .expect({ status: 'ok' });
    } finally {
      await app.close();
    }
  });
});
