import { Logger, Module } from '@nestjs/common';
import { ConfigModule } from '../config/config.module';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { ConfigService } from '../config/config/config.service';
import { BearerStrategy, buildBearerClient } from './bearer/bearer.strategy';
import { AuthService } from './services/auth.service';
import { CachingModule } from '../caching/caching.module';
import { CachingService } from '../caching/services/cache.service';

const BearerStrategyFactory = {
  provide: 'BearerStrategy',
  useFactory: async (
    configService: ConfigService,
    authService: AuthService,
    cachingService: CachingService,
  ) => {
    const client = await buildBearerClient(configService); // secret sauce! build the dynamic client before injecting it into the strategy for use in the constructor super call.
    const roles = String(configService.get('auth.roles') ?? '')
      .split(',')
      .map((role) => role.trim())
      .filter((role) => role.length > 0);
    const strategy = new BearerStrategy(client, cachingService, roles);
    authService.setAuthClient(client);
    return strategy;
  },
  inject: [ConfigService, AuthService, CachingService],
};

@Module({
  imports: [ConfigModule, CachingModule],
  providers: [
    Logger,
    AuthService,
    BearerStrategyFactory,
    {
      provide: APP_GUARD,
      useFactory: (authService: AuthService, reflector: Reflector) =>
        authService.getAuthGuard(reflector),
      inject: [AuthService, Reflector],
    },
  ],
  exports: [AuthService],
})
export class AuthModule {}
