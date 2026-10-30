import { Logger, Module } from '@nestjs/common';
import { HealthController } from './controllers/health.controller';
import { TerminusModule } from '@nestjs/terminus';
import { ConfigModule } from '../config/config.module';
import { HttpModule } from '@nestjs/axios';
import { AuthIndicator } from './indicators/auth.indicator';
import { AuthModule } from '../auth/auth.module';
import { ElasticsearchIndicator } from './indicators/elasticsearch.indicator';
import { DatabaseModule } from '../database/database.module';

@Module({
  controllers: [HealthController],
  imports: [
    HttpModule,
    TerminusModule,
    ConfigModule,
    AuthModule,
    DatabaseModule,
  ],
  providers: [AuthIndicator, ElasticsearchIndicator, Logger],
})
export class HealthModule {}
