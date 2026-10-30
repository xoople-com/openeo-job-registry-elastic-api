import { Injectable } from '@nestjs/common';
import * as convict from 'convict';
import * as convict_validator from 'convict-format-with-validator';
import { AppConfig, schema } from '../schema/config.schema';
import * as dotenv from 'dotenv';
import { AuthType } from '../../auth/models/authtypes.enum';

@Injectable()
export class ConfigService {
  config: convict.Config<AppConfig>;

  constructor() {
    dotenv.config();
    convict.addFormats(convict_validator);
    this.config = convict(schema);
    this.config.validate({ allowed: 'strict' });
    if (this.get('auth.type') === AuthType.ENTRA) {
      if (
        !/^https:\/\/login\.microsoftonline\.com\/[0-9a-f-]{36}\/v2\.0$/.test(
          this.get('auth.entra.issuer'),
        )
      ) {
        throw new Error(
          'ENTRA_ISSUER must be a tenant-specific Entra v2 issuer',
        );
      }
      for (const key of ['audience', 'roles', 'clientIds']) {
        if (
          !this.get(`auth.entra.${key}`)
            .split(',')
            .some((v: string) => v.trim())
        ) {
          throw new Error(`auth.entra.${key} is required in entra mode`);
        }
      }
    }
  }

  get(configName: string) {
    return this.config.get(configName);
  }
}
