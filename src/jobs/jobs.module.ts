import { Logger, Module } from '@nestjs/common';
import { JobsController } from './controllers/jobs/jobs.controller';
import { ElasticsearchModule } from '@nestjs/elasticsearch';
import { ConfigModule } from '../config/config.module';
import { ConfigService } from '../config/config/config.service';
import { DatabaseService } from './services/database/database.service';
import { CachingModule } from '../caching/caching.module';
import { JobsController as JobsV2Controller } from './controllers/jobs-v2/jobs-v2.controller';
import { JobStore } from './stores/job-store';
import { ElasticsearchJobStore } from './stores/elasticsearch-job-store';
import { JobRegistryService } from './services/job-registry.service';

@Module({
  controllers: [JobsController, JobsV2Controller],
  imports: [
    ConfigModule,
    CachingModule,
    ElasticsearchModule.registerAsync({
      imports: [ConfigModule],
      useFactory: async (configService: ConfigService) => ({
        nodes: configService
          .get('database.hosts')
          .split(',')
          .map((h) => h.trim()),
      }),
      inject: [ConfigService],
    }),
  ],
  providers: [
    DatabaseService,
    JobRegistryService,
    Logger,
    { provide: JobStore, useClass: ElasticsearchJobStore },
  ],
})
export class JobsModule {}
