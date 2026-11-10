import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiHeader, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { JobRegistryService } from '../../services/job-registry.service';
import {
  CreateJob,
  ListUserJobs,
  ListActiveJobs,
  ListCleanupCandidates,
  JobScope,
  UpdateJob,
} from '../../models/job.v2.dto';

@ApiTags('jobs-v2')
@Controller('v2/jobs')
export class JobsController {
  constructor(private readonly registry: JobRegistryService) {}

  @Post()
  @ApiOperation({ summary: 'Create a job using the domain contract' })
  async create(
    @Body() job: CreateJob,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.registry.create(job);
    response.setHeader('ETag', result.etag);
    return result.job;
  }

  @Post('user')
  @HttpCode(200)
  @ApiOperation({ summary: 'List jobs belonging to a user' })
  listUserJobs(@Body() query: ListUserJobs) {
    return this.registry.listUserJobs(query);
  }

  @Post('active')
  @HttpCode(200)
  @ApiOperation({ summary: 'List created, queued and running jobs' })
  listActiveJobs(@Body() query: ListActiveJobs) {
    return this.registry.listActiveJobs(query);
  }

  @Post('cleanup-candidates')
  @HttpCode(200)
  @ApiOperation({
    summary: 'List non-created jobs updated at or before a cutoff',
  })
  listCleanupCandidates(@Body() query: ListCleanupCandidates) {
    return this.registry.listCleanupCandidates(query);
  }

  @Get(':jobId')
  async get(
    @Param('jobId') jobId: string,
    @Query() scope: JobScope,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.registry.get({
      job_id: jobId,
      ...scope,
    });
    response.setHeader('ETag', result.etag);
    return result.job;
  }

  @Patch(':jobId')
  @ApiHeader({ name: 'If-Match', required: true })
  async patch(
    @Param('jobId') jobId: string,
    @Query() scope: JobScope,
    @Body() update: UpdateJob,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ) {
    const result = await this.registry.patch(
      { job_id: jobId, ...scope },
      update,
      { ifMatch },
    );
    response.setHeader('ETag', result.etag);
    return result.job;
  }

  @Delete(':jobId')
  @HttpCode(204)
  @ApiHeader({ name: 'If-Match', required: true })
  async delete(
    @Param('jobId') jobId: string,
    @Query() scope: JobScope,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<void> {
    await this.registry.delete(
      {
        job_id: jobId,
        ...scope,
      },
      { ifMatch },
    );
  }
}
