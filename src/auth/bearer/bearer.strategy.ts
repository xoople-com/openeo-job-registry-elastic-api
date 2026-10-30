import { ForbiddenException, Injectable, Logger } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { Strategy } from 'passport-http-bearer';
import { ConfigService } from '../../config/config/config.service';
import { Client, custom, IntrospectionResponse, Issuer } from 'openid-client';
import { UtilsService } from '../../utils/services/utils/utils.service';
import { CachingService } from '../../caching/services/cache.service';

export enum VERIFICATION_ERRORS {
  NO_CLIENT = 'no_client',
  TOKEN_INVALID = 'token_invalid',
  GENERAL = 'token_validation_error',
}

/* istanbul ignore next */
export const buildBearerClient = async (configService: ConfigService) => {
  const issuer = await Issuer.discover(
    `${configService.get('auth.oidc.issuer')}/.well-known/openid-configuration`,
  );
  const client = new issuer.Client({
    client_id: configService.get('auth.oidc.clientId'),
    client_secret: configService.get('auth.oidc.clientSecret'),
  });
  client[custom.http_options] = (options: any) => ({
    ...options,
    timeout: 5000,
    retry: 2,
  });
  return client;
};

@Injectable()
export class BearerStrategy extends PassportStrategy(Strategy, 'bearer') {
  client: Client;
  logger: Logger;
  cachingService: CachingService;

  requiredRoles: string[];

  constructor(
    client: Client,
    cachingService: CachingService,
    requiredRoles: string[] = [],
  ) {
    super({}, (token, verified) => this.verify(token, verified, 5));
    this.client = client;
    this.cachingService = cachingService;
    this.requiredRoles = requiredRoles;
    this.logger = new Logger('BearerStrategy');
  }

  /**
   * Decodes the JWT payload without verifying the signature. Only use this after
   * the token has been confirmed active through introspection.
   */
  private decodePayload(token: string): any {
    try {
      const payload = JSON.parse(
        Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
      );
      return payload && typeof payload === 'object' ? payload : {};
    } catch {
      return {};
    }
  }

  private hasRequiredRole(payload: any): boolean {
    const roles = payload?.realm_access?.roles;
    return (
      Array.isArray(roles) &&
      this.requiredRoles.some((role) => roles.includes(role))
    );
  }

  private getCacheKey(token: string): string {
    return `bearer:${token}`;
  }

  public async verify(
    token: string,
    verified: (error, user, info) => void,
    attempts: number,
  ) {
    const cacheKey = this.getCacheKey(token);
    const cachedResult = await this.cachingService.checkCache<{
      error?: VERIFICATION_ERRORS | ForbiddenException;
      user?: any;
      info?: string;
    }>(cacheKey);

    if (cachedResult !== undefined) {
      this.logger.debug('Token found in cache, skipping introspection');
      verified(cachedResult.error, cachedResult.user, cachedResult.info);
      return;
    }

    let attempt = 1;
    let introspectResult;

    this.logger.debug('Starting bearer token verification');
    while (attempt <= attempts) {
      this.logger.debug(`Inspecting token (${attempt}/${attempts})`);
      introspectResult = await this.introspectToken(token);
      if (introspectResult.error !== VERIFICATION_ERRORS.GENERAL) {
        break;
      }
      await UtilsService.sleep(1000);
      attempt += 1;
    }

    if (!introspectResult.error && introspectResult.user) {
      await this.cachingService.store(cacheKey, introspectResult);
    }

    verified(
      introspectResult.error,
      introspectResult.user,
      introspectResult.info,
    );
  }

  public async introspectToken(token: string): Promise<{
    error?: VERIFICATION_ERRORS | ForbiddenException;
    user?: any;
    info?: string;
  }> {
    if (!this.client) {
      return {
        error: VERIFICATION_ERRORS.NO_CLIENT,
        user: null,
        info: null,
      };
    } else {
      try {
        const response: IntrospectionResponse = await this.client.introspect(
          token,
        );
        if (response.active) {
          this.logger.debug('Token is valid');
          if (this.requiredRoles.length > 0) {
            const payload = this.decodePayload(token);
            if (!this.hasRequiredRole(payload)) {
              this.logger.warn(
                `Access denied for user ${payload.sub}
                 : token has none of the required roles [${this.requiredRoles.join(
                   ', ',
                 )}]`,
              );
              return {
                error: new ForbiddenException(),
                user: null,
                info: null,
              };
            }
          }
          return {
            error: null,
            user: {},
            info: null,
          };
        } else {
          this.logger.error(`Token is not active`);
          // We pass it through info to indicate that the token is invalid and trigger a fail vs an error.
          // See strategy.js for more information on the implementation
          return {
            error: null,
            user: null,
            info: VERIFICATION_ERRORS.TOKEN_INVALID,
          };
        }
      } catch (e) {
        this.logger.error('An error occurred while verifying token');
        return {
          error: VERIFICATION_ERRORS.GENERAL,
          user: null,
          info: null,
        };
      }
    }
  }
}
