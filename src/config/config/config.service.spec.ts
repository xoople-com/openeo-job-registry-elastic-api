import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from './config.service';

describe('ConfigService', () => {
  let service: ConfigService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [ConfigService],
    }).compile();

    service = module.get<ConfigService>(ConfigService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('fails startup when Entra trust or caller configuration is missing', () => {
    const previous = process.env;
    process.env = { ...previous, AUTH_TYPE: 'entra' };
    try {
      expect(() => new ConfigService()).toThrow('ENTRA_ISSUER');
      process.env.ENTRA_ISSUER =
        'https://login.microsoftonline.com/8f0cef0d-4bae-4451-bc81-9b45fc92d79d/v2.0';
      expect(() => new ConfigService()).toThrow('audience');
      process.env.ENTRA_AUDIENCE = 'api-audience';
      expect(() => new ConfigService()).toThrow('clientIds');
      process.env.ENTRA_CLIENT_IDS = 'caller-id';
      expect(new ConfigService().get('auth.type')).toBe('entra');
      process.env.ENTRA_ROLES = ', ,';
      expect(() => new ConfigService()).toThrow('roles');
    } finally {
      process.env = previous;
    }
  });
});
