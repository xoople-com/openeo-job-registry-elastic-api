import { Injectable } from '@nestjs/common';
import { ConfigService } from '../../config/config/config.service';
import { AuthType } from '../models/authtypes.enum';
import { BearerGuard } from '../bearer/bearer.guard';
import { Reflector } from '@nestjs/core';
import { BaseClient } from 'openid-client';

@Injectable()
export class AuthService {
  private client: BaseClient;
  private tokenValidator?: (token: string) => Promise<boolean>;

  constructor(private configService: ConfigService) {}

  public getAuthGuard(reflector: Reflector) {
    const type = this.configService.get('auth.type');
    switch (type) {
      case AuthType.BEARER:
      case AuthType.ENTRA:
        return new BearerGuard(reflector);
      default:
        throw new Error(`Auth guard of type ${type} is not supported!`);
    }
  }

  public setTokenValidator(validator: (token: string) => Promise<boolean>) {
    this.tokenValidator = validator;
  }

  public async isTokenActive(token: string): Promise<boolean> {
    if (this.tokenValidator) {
      return this.tokenValidator(token);
    }
    return (await this.client.introspect(token)).active;
  }

  /* istanbul ignore next */
  public setAuthClient(client: BaseClient) {
    this.client = client;
  }

  /* istanbul ignore next */
  public getAuthClient(): BaseClient {
    return this.client;
  }
}
