import { Injectable, Logger } from '@nestjs/common';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import { estypes } from '@elastic/elasticsearch';
import { ResponseError } from '@elastic/elasticsearch/lib/errors';
import { ConfigService } from '../../config/config/config.service';
import { SearchJobs } from '../models/job.v2.dto';
import {
  JobSource,
  JobStore,
  JobStoreConflictError,
  JobStoreInvalidInputError,
  JobStoreNotFoundError,
  JobStoreUnavailableError,
  StoredJob,
  StoredJobPage,
} from './job-store';

@Injectable()
export class ElasticsearchJobStore extends JobStore {
  private readonly index: string;
  private readonly logger = new Logger(ElasticsearchJobStore.name);

  constructor(
    private readonly elastic: ElasticsearchService,
    config: ConfigService,
  ) {
    super();
    this.index = config.get('database.jobsIdx');
  }

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (
        error instanceof JobStoreInvalidInputError ||
        error instanceof JobStoreConflictError ||
        error instanceof JobStoreNotFoundError
      ) {
        throw error;
      }
      if (error instanceof ResponseError) {
        if (error.statusCode === 409) throw new JobStoreConflictError();
        if (error.statusCode === 404) throw new JobStoreNotFoundError();
      }
      this.logger.error('Job storage operation failed');
      throw new JobStoreUnavailableError();
    }
  }

  private record(
    source: JobSource,
    metadata: { _version?: number; _seq_no?: number; _primary_term?: number },
  ): StoredJob {
    if (
      !Number.isInteger(metadata._version) ||
      metadata._version < 1 ||
      !Number.isInteger(metadata._seq_no) ||
      metadata._seq_no < 0 ||
      !Number.isInteger(metadata._primary_term) ||
      metadata._primary_term < 1
    ) {
      throw new Error('Storage returned invalid version metadata');
    }
    return {
      source,
      version: metadata._version,
      concurrencyToken: JSON.stringify([
        metadata._seq_no,
        metadata._primary_term,
      ]),
    };
  }

  get(jobId: string): Promise<StoredJob> {
    return this.execute(async () => {
      const { body } = await this.elastic.get<estypes.GetResponse<JobSource>>({
        index: this.index,
        id: jobId,
      });
      return this.record(body._source, body);
    });
  }

  create(source: JobSource): Promise<StoredJob> {
    return this.execute(async () => {
      if (Buffer.byteLength(source.job_id, 'utf8') > 512) {
        throw new JobStoreInvalidInputError(
          'Job ID must not exceed 512 UTF-8 bytes',
        );
      }
      const { body } = await this.elastic.create<estypes.CreateResponse>({
        index: this.index,
        id: source.job_id,
        body: source,
        refresh: 'wait_for',
      });
      return this.record(source, body);
    });
  }

  replace(source: JobSource, concurrencyToken: string): Promise<StoredJob> {
    return this.execute(async () => {
      const token: unknown = JSON.parse(concurrencyToken);
      if (
        !Array.isArray(token) ||
        token.length !== 2 ||
        !token.every((value) => Number.isInteger(value) && value >= 0) ||
        token[1] < 1
      ) {
        throw new Error('Invalid storage concurrency token');
      }
      const { body } = await this.elastic.index<estypes.IndexResponse>({
        index: this.index,
        id: source.job_id,
        if_seq_no: token[0],
        if_primary_term: token[1],
        refresh: 'wait_for',
        body: source,
      });
      return this.record(source, body);
    });
  }

  search(search: SearchJobs): Promise<StoredJobPage> {
    return this.execute(async () => {
      const filters = search.filters || {};
      const filter: estypes.QueryDslQueryContainer[] = [];
      if (filters.backend_id !== undefined) {
        filter.push({ term: { backend_id: filters.backend_id } });
      }
      const mustNot: estypes.QueryDslQueryContainer[] = [
        { term: { deleted: true } },
      ];
      if (filters.job_id !== undefined) {
        filter.push({ term: { job_id: filters.job_id } });
      }
      if (filters.user_ids) {
        filter.push({ terms: { user_id: filters.user_ids } });
      }
      if (filters.statuses) {
        filter.push({ terms: { status: filters.statuses } });
      }
      if (filters.infra_id !== undefined) {
        filter.push({ term: { infra_id: filters.infra_id } });
      }
      if (filters.has_application_id !== undefined) {
        const target = filters.has_application_id ? filter : mustNot;
        target.push({ exists: { field: 'application_id' } });
      }
      for (const [field, since, until] of [
        ['created', filters.created_since, filters.created_until],
        ['updated', filters.updated_since, filters.updated_until],
      ] as const) {
        if (since || until) {
          filter.push({
            range: {
              [field]: {
                ...(since ? { gte: since } : {}),
                ...(until ? { lte: until } : {}),
              },
            },
          });
        }
      }
      const query = { bool: { filter, must_not: mustNot } };
      const after = search.position
        ? [search.position.created, search.position.job_id]
        : undefined;
      const { body } = await this.elastic.search<
        estypes.SearchResponse<Partial<JobSource>>
      >({
        index: this.index,
        size: search.limit + 1,
        body: {
          query,
          track_total_hits: false,
          _source: search.fields || { excludes: ['_registry', 'deleted'] },
          sort: [{ created: 'desc' }, { job_id: 'asc' }],
          ...(after ? { search_after: after } : {}),
        },
      });
      const hits = body.hits.hits;
      const page = hits.slice(0, search.limit);
      const more = hits.length > search.limit;
      const last = page[page.length - 1];
      if (
        more &&
        (!last.sort ||
          last.sort.length !== 2 ||
          !(
            last.sort[0] === null ||
            (typeof last.sort[0] === 'number' && Number.isFinite(last.sort[0]))
          ) ||
          !(last.sort[1] === null || typeof last.sort[1] === 'string'))
      ) {
        throw new Error('Storage returned an invalid pagination position');
      }
      return {
        jobs: page.map((hit) => hit._source),
        next_position: more
          ? {
              created: typeof last.sort[0] === 'number' ? last.sort[0] : null,
              job_id: typeof last.sort[1] === 'string' ? last.sort[1] : null,
            }
          : null,
      };
    });
  }
}
