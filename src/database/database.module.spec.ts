import { ConfigService } from '../config/config/config.service';
import { buildDatabaseOptions, DatabaseModule } from './database.module';
import { Test } from '@nestjs/testing';

describe('DatabaseModule', () => {
  const options = (values: Record<string, string>) => {
    const config = new ConfigService();
    jest.spyOn(config, 'get').mockImplementation((name) => values[name] || '');
    return buildDatabaseOptions(config);
  };

  afterEach(() => jest.restoreAllMocks());

  it('supports local development without authentication', () => {
    expect(options({ 'database.hosts': 'http://localhost:9200' })).toEqual({
      nodes: ['http://localhost:9200'],
      tls: { rejectUnauthorized: true },
    });
  });

  it('uses an explicit API key and verified HTTPS for all hosts', () => {
    expect(
      options({
        'database.hosts': 'https://one.example:9243, https://two.example:9243',
        'database.apiKey': 'encoded-key',
      }),
    ).toMatchObject({
      auth: { apiKey: 'encoded-key' },
      nodes: ['https://one.example:9243', 'https://two.example:9243'],
      tls: { rejectUnauthorized: true },
    });
  });

  it.each([
    'https://user:password@example.com',
    'https://example.com?api_key=secret',
    'https://example.com/path',
    'ftp://example.com',
    '',
  ])('rejects invalid or credential-bearing endpoints (%s)', (host) => {
    expect(() => options({ 'database.hosts': host })).toThrow();
  });

  it('rejects API keys over plaintext, including mixed endpoints', () => {
    expect(() =>
      options({
        'database.hosts': 'https://one.example,http://localhost:9200',
        'database.apiKey': 'encoded-key',
      }),
    ).toThrow('requires HTTPS');
  });

  it('requires an explicit Elastic credential in Entra mode', () => {
    expect(() =>
      options({
        'database.hosts': 'https://one.example',
        'auth.type': 'entra',
      }),
    ).toThrow('DB_API_KEY is required');
  });

  it('fails explicitly when a configured CA file cannot be read', () => {
    expect(() =>
      options({
        'database.hosts': 'https://one.example',
        'database.caFile': '/nonexistent/ejr-ca.pem',
      }),
    ).toThrow();
  });

  it('closes the client on shutdown', async () => {
    const module = await Test.createTestingModule({
      imports: [DatabaseModule],
    }).compile();
    await module.close();
  });
});
