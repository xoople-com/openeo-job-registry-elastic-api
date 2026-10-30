import { Controller, Get, Headers } from '@nestjs/common';
import { HealthCheck, HealthCheckService } from '@nestjs/terminus';
import { Public } from '../../auth/decorators/public.decorator';
import { ConfigService } from '../../config/config/config.service';
import { AuthIndicator } from '../indicators/auth.indicator';
import { ElasticsearchIndicator } from '../indicators/elasticsearch.indicator';
import { SkipThrottle } from '@nestjs/throttler';

@Public()
@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private configService: ConfigService,
    private authIndicator: AuthIndicator,
    private elasticSearchIndicator: ElasticsearchIndicator,
  ) {}

  @Get()
  @HealthCheck()
  @Public()
  async check(@Headers() headers: Headers) {
    return await this.health
      .check([
        () => this.elasticSearchIndicator.isHealthy(),
        () => this.authIndicator.isHealthy(headers),
      ])
      .then((result) => ({
        ...result,
        details: {},
      }));
  }

  @Get('live')
  @Public()
  @SkipThrottle()
  live() {
    return { status: 'ok' };
  }

  @Get('ready')
  @HealthCheck()
  @Public()
  @SkipThrottle()
  ready() {
    return this.health.check([() => this.elasticSearchIndicator.isHealthy()]);
  }
}
