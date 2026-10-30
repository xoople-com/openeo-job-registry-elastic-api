import { HealthIndicator, HealthIndicatorResult } from '@nestjs/terminus';
import {
  ForbiddenException,
  Headers,
  Injectable,
  Logger,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthService } from '../../auth/services/auth.service';

enum TokenStatus {
  MISSING = 'missing',
  OK = 'ok',
  INVALID = 'invalid',
  EXPIRED = 'expired',
}

@Injectable()
export class AuthIndicator extends HealthIndicator {
  constructor(private authService: AuthService) {
    super();
  }
  async isHealthy(headers: Headers): Promise<HealthIndicatorResult> {
    const token = headers['authorization'];
    const state = await this.getTokenStatus(token);
    return {
      auth: {
        status: state === TokenStatus.OK ? 'up' : 'down',
        state,
      },
    };
  }

  private async getTokenStatus(token: string): Promise<TokenStatus> {
    if (!token) {
      return TokenStatus.MISSING;
    } else {
      // Check if token has the correct format
      const bearer = token.split('Bearer ');
      if (bearer.length !== 2) {
        return TokenStatus.INVALID;
      }

      // Check if token is still valid
      try {
        return (await this.authService.isTokenActive(bearer[1]))
          ? TokenStatus.OK
          : TokenStatus.EXPIRED;
      } catch (error) {
        if (
          error instanceof UnauthorizedException ||
          error instanceof ForbiddenException
        ) {
          return TokenStatus.INVALID;
        }
        new Logger(AuthIndicator.name).error(
          'Authentication health check unavailable',
        );
        throw error;
      }
    }
  }
}
