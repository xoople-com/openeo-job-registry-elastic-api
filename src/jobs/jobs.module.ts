import { Logger, Module } from '@nestjs/common';
import { JobsController } from './controllers/jobs/jobs.controller';
import { DatabaseModule } from '../database/database.module';
import { ConfigModule } from '../config/config.module';
import { DatabaseService } from './services/database/database.service';
import { CachingModule } from '../caching/caching.module';

@Module({
  controllers: [JobsController],
  imports: [ConfigModule, CachingModule, DatabaseModule],
  providers: [DatabaseService, Logger],
})
export class JobsModule {}
