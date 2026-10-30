import {
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-http-bearer';
import {
  createRemoteJWKSet,
  errors,
  jwtVerify,
  JWTPayload,
  JWTVerifyGetKey,
} from 'jose';
import { Issuer } from 'openid-client';
import { ConfigService } from '../../config/config/config.service';

export interface EntraOptions {
  issuer: string;
  audience: string;
  roles: string[];
  clientIds: string[];
}

export const configList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

export async function buildEntraStrategy(config: ConfigService) {
  const issuer: string = config.get('auth.entra.issuer');
  const discovered = await Issuer.discover(issuer);
  if (
    discovered.issuer !== issuer ||
    !discovered.metadata.jwks_uri ||
    new URL(discovered.metadata.jwks_uri).protocol !== 'https:'
  ) {
    throw new Error(
      'Entra discovery must match the configured issuer and provide HTTPS signing keys',
    );
  }
  return new EntraStrategy(
    {
      issuer,
      audience: config.get('auth.entra.audience'),
      roles: configList(config.get('auth.entra.roles')),
      clientIds: configList(config.get('auth.entra.clientIds')),
    },
    createRemoteJWKSet(new URL(discovered.metadata.jwks_uri), {
      timeoutDuration: 5000,
      cooldownDuration: 30000,
    }),
  );
}

@Injectable()
export class EntraStrategy extends PassportStrategy(Strategy, 'bearer') {
  private readonly logger = new Logger(EntraStrategy.name);

  constructor(
    private readonly options: EntraOptions,
    private readonly key: JWTVerifyGetKey,
  ) {
    super();
  }

  async validate(token: string) {
    let payload: JWTPayload;
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: ['RS256'],
        issuer: this.options.issuer,
        audience: this.options.audience,
        requiredClaims: ['exp', 'iat', 'sub', 'iss', 'aud'],
      }));
    } catch (error) {
      if (
        error instanceof errors.JWTExpired ||
        error instanceof errors.JWTClaimValidationFailed ||
        error instanceof errors.JWSSignatureVerificationFailed ||
        error instanceof errors.JWSInvalid ||
        error instanceof errors.JWTInvalid ||
        error instanceof errors.JOSEAlgNotAllowed ||
        error instanceof errors.JWKSNoMatchingKey
      ) {
        this.logger.warn(`Access token rejected (${error.code})`);
        throw new UnauthorizedException();
      }
      this.logger.error('Entra signing-key validation unavailable');
      throw new ServiceUnavailableException('Token validation unavailable');
    }
    const roles = payload.roles;
    if (
      payload.ver !== '2.0' ||
      payload.scp !== undefined ||
      typeof payload.azp !== 'string' ||
      !this.options.clientIds.includes(payload.azp) ||
      !Array.isArray(roles) ||
      !this.options.roles.some((role) => roles.includes(role))
    ) {
      this.logger.warn('Application access denied by caller or role policy');
      throw new ForbiddenException();
    }
    return payload;
  }
}
