import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { Client, errors } from '@elastic/elasticsearch';
import { ExtendedPatchJob, Job } from '../../models/job.dto';
import { ConfigService } from '../../../config/config/config.service';
import { UtilsService } from '../../../utils/services/utils/utils.service';
import { Pagination } from '../../models/pagination.dto';

@Injectable()
export class DatabaseService {
  private JOBS_INDEX = '';

  constructor(
    private configService: ConfigService,
    private elasticSearch: Client,
    private logger: Logger,
  ) {
    this.JOBS_INDEX = this.configService.get('database.jobsIdx');

    this.logger.debug(
      `Starting up databse service for jobs at index ${this.JOBS_INDEX}`,
    );
  }

  /**
   * Save a list of jobs to the database
   * @param job - OpenEO job to store
   */
  public async saveJobs(job: Job): Promise<Job> {
    try {
      const response = await this.elasticSearch.index({
        index: this.JOBS_INDEX,
        document: job,
      });

      if (response.result !== 'created') {
        throw new Error('Elasticsearch did not create the job document');
      }
      return job;
    } catch (error: any) {
      const message = this.databaseError(error);
      this.logger.error(
        `Could not store job ${job.job_id} in elasticsearch: ${message}`,
      );
      throw new HttpException(
        `Could not store jobs in database: ${message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Given an ElasticSearch query, return the list of jobs that matches the query
   * @param query - ElasticSearch query to execute
   * @param page - Page to request
   * @param limit - The amount of documents to fetch (optional)
   * @param deleted - Flag indicating if the deleted docs should be included (true) or not (false)
   * @param idsOnly - Only return the IDs of the document
   */

  /* istanbul ignore next */
  public async queryJobs(
    query: any,
    page?: number,
    limit?: number,
    deleted?: boolean,
    idsOnly?: boolean,
  ): Promise<Pagination> {
    let retries = 1;

    while (retries <= 5) {
      const results = await this.executeJobQuery(
        query,
        page,
        limit,
        deleted,
        idsOnly,
      );

      if (results.jobs.length > 0) {
        return results;
      } else {
        await UtilsService.sleep(500);
        retries++;
      }
    }
    return {
      jobs: [],
      pagination: {},
    };
  }

  /**
   * Execute a query on the jobs index.
   * @param query - ElasticSearch query to execute
   * @param page - Page to search
   * @param deleted - Flag indicating if the deleted docs should be included (true) or not (false)
   * @param limit - The amount of documents to fetch (optional)
   * @param idsOnly - Only return the IDs of the document
   */

  /* istanbul ignore next */
  public async executeJobQuery(
    query: any,
    page?: number,
    limit?: number,
    deleted?: boolean,
    idsOnly?: boolean,
  ): Promise<Pagination> {
    const size = limit || this.configService.get('database.maxResults');
    const from = (page || 0) * size;

    if (Object.keys(query).length === 0) {
      throw new Error(`empty query`);
    }

    if (!deleted) {
      query = this.addDeletedFilter(query);
    }
    // Perform initial search
    try {
      const body = await this.elasticSearch.search<Job>({
        index: this.JOBS_INDEX,
        track_total_hits: false,
        body: { ...query },
        from,
        size,
        sort: ['created:desc', 'job_id:asc', 'backend_id:asc'],
      });

      return {
        jobs: idsOnly
          ? body.hits.hits.map((hit) => hit._id)
          : body.hits.hits.map((hit) => hit._source),
        pagination: {
          previous: page > 0 ? { size, page: page - 1 } : null,
          next:
            body.hits.hits.length === size ? { size, page: page + 1 } : null,
        },
      };
    } catch (error) {
      const message = this.databaseError(error);
      this.logger.error(`Could not query jobs in elasticsearch: ${message}`);
      throw new HttpException(
        `Could not query jobs in database: ${message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  /**
   * Partially update a document in ElasticSearch
   * @param docId - ID of the ElasticSearch document to update
   * @param update - Partial update that should be applied
   */
  async patchJob(docId: string, update: ExtendedPatchJob): Promise<Job> {
    try {
      await this.elasticSearch.update<Job, ExtendedPatchJob>({
        index: this.JOBS_INDEX,
        id: docId,
        doc: update,
      });
      const updated = await this.elasticSearch.get<Job>({
        index: this.JOBS_INDEX,
        id: docId,
      });
      return updated._source;
    } catch (error: any) {
      const message = this.databaseError(error);
      this.logger.error(
        `Could not update job ${docId} in elasticsearch: ${message}`,
      );
      throw new HttpException(
        `Could not update jobs in database: ${message}`,
        HttpStatus.INTERNAL_SERVER_ERROR,
      );
    }
  }

  private databaseError(error: unknown): string {
    // Transport errors can carry request headers, including the Elastic API key.
    return error instanceof errors.ResponseError
      ? `Elasticsearch request failed (HTTP ${error.statusCode})`
      : 'Elasticsearch request failed';
  }

  /**
   * Get the elasticsearch document ID of the job linked to the specified job id
   * @param jobId - Job ID to search for
   */
  async getJobDocId(jobId: string): Promise<string> {
    const { jobs } = await this.queryJobs(
      this.getJobQuery(jobId),
      null,
      1,
      false,
      true,
    );
    return jobs.length > 0 ? (jobs[0] as string) : undefined;
  }

  /**
   * Adds a filter to the request body to filter out the docs that are marked for deletion
   * @param body - Body that is sent to ES
   */
  addDeletedFilter(body: any): any {
    return {
      ...body,
      query: {
        ...body?.query,
        bool: {
          ...body?.query?.bool,
          must_not: [
            ...(body?.query?.bool?.must_not || []),
            {
              term: {
                deleted: 'true',
              },
            },
          ],
        },
      },
    };
  }

  /**
   * Create the ElasticSearch job query based on a job id
   * @param id - Job ID to search for
   */
  /* istanbul ignore next */
  private getJobQuery = (id: string): any => ({
    query: {
      bool: {
        must: [
          {
            match: {
              job_id: id,
            },
          },
        ],
      },
    },
  });
}
