import { Injectable, Logger } from '@nestjs/common';
import {
  HealthCheckError,
  HealthIndicator,
  HealthIndicatorResult,
} from '@nestjs/terminus';
import { Client } from '@elastic/elasticsearch';
import { ConfigService } from '../../config/config/config.service';

@Injectable()
export class ElasticsearchIndicator extends HealthIndicator {
  constructor(
    private readonly client: Client,
    private readonly configService: ConfigService,
    private readonly logger: Logger,
  ) {
    super();
  }

  async isHealthy(): Promise<HealthIndicatorResult> {
    try {
      // Use the runtime's index read privilege, not cluster-monitor privileges.
      await this.client.search(
        { index: this.configService.get('database.jobsIdx'), size: 0 },
        {
          requestTimeout: this.configService.get('health.es.timeout'),
          maxRetries: 0,
        },
      );
      return this.getStatus('elasticsearch', true);
    } catch {
      this.logger.error('Elasticsearch readiness check failed');
      throw new HealthCheckError('Elasticsearch unavailable', {
        elasticsearch: { status: 'down' },
      });
    }
  }
}
