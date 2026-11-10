import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'crypto';
import {
  CreateJob,
  JobMetadata,
  SearchJobs,
  JOB_FIELDS,
  ListJobs,
  ListUserJobs,
  ListActiveJobs,
  ListCleanupCandidates,
} from '../models/job.v2.dto';
import {
  JobKey,
  JobPage,
  JobSource,
  JobStore,
  JobStoreConflictError,
  JobStoreInvalidInputError,
  JobStoreNotFoundError,
  JobStoreUnavailableError,
  MutationOptions,
  StoredJob,
  VersionedJob,
} from '../stores/job-store';

function canonical(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

function publicJob<T extends Partial<JobSource>>(source: T): T {
  const job = { ...source };
  delete job._registry;
  delete job.deleted;
  return job;
}

function versioned(record: StoredJob): VersionedJob {
  const job = publicJob(record.source);
  return {
    job,
    etag: `"${hash({
      job,
      revision: record.source._registry?.revision,
      deleted: record.source.deleted === true,
      documentVersion: record.version,
    })}"`,
  };
}

@Injectable()
export class JobRegistryService {
  constructor(private readonly store: JobStore) {}

  private async execute<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error: unknown) {
      if (error instanceof JobStoreInvalidInputError) {
        throw new BadRequestException(error.message);
      }
      if (error instanceof JobStoreNotFoundError) {
        throw new NotFoundException('Job not found');
      }
      if (error instanceof JobStoreUnavailableError) {
        throw new ServiceUnavailableException('Job storage is unavailable');
      }
      throw error;
    }
  }

  private async find(key: JobKey): Promise<StoredJob> {
    const record = await this.store.get(key.job_id);
    if (
      record.source.job_id !== key.job_id ||
      (key.user_id !== undefined && record.source.user_id !== key.user_id)
    ) {
      throw new NotFoundException('Job not found');
    }
    return record;
  }

  create(input: CreateJob): Promise<VersionedJob> {
    return this.execute(async () => {
      const creationFingerprint = hash(input);
      const now = new Date().toISOString();
      const source: JobSource = {
        ...input,
        status: input.status || 'created',
        created: input.created || now,
        updated: input.updated || now,
        _registry: { revision: randomUUID(), creationFingerprint },
      };
      try {
        return versioned(await this.store.create(source));
      } catch (error: unknown) {
        if (!(error instanceof JobStoreConflictError)) throw error;
        let found: StoredJob;
        try {
          found = await this.find({ job_id: input.job_id });
        } catch (lookupError: unknown) {
          if (
            lookupError instanceof JobStoreNotFoundError ||
            lookupError instanceof NotFoundException
          ) {
            throw new ConflictException('Job ID is already reserved');
          }
          throw lookupError;
        }
        if (found.source.backend_id !== input.backend_id) {
          throw new ConflictException('Job ID is already reserved');
        }
        if (found.source.deleted) {
          throw new ConflictException('Job ID belongs to a deleted job');
        }
        if (!found.source._registry?.creationFingerprint) {
          throw new ConflictException(
            'Original creation input is unavailable for this job',
          );
        }
        if (
          found.source._registry.creationFingerprint !== creationFingerprint
        ) {
          throw new ConflictException(
            'Job ID was created with different input',
          );
        }
        return versioned(found);
      }
    });
  }

  get(key: JobKey): Promise<VersionedJob> {
    return this.execute(async () => {
      const record = await this.find(key);
      if (record.source.deleted) throw new NotFoundException('Job not found');
      return versioned(record);
    });
  }

  patch(
    key: JobKey,
    update: JobMetadata,
    options: MutationOptions,
  ): Promise<VersionedJob> {
    return this.execute(() => this.mutate('patch', key, update, options));
  }

  delete(key: JobKey, options: MutationOptions): Promise<void> {
    return this.execute(async () => {
      await this.mutate('delete', key, {}, options);
    });
  }

  private async mutate(
    method: 'patch' | 'delete',
    key: JobKey,
    update: JobMetadata,
    options: MutationOptions,
  ): Promise<VersionedJob> {
    if (method === 'patch' && Object.keys(update).length === 0) {
      throw new BadRequestException(
        'An update must contain at least one field',
      );
    }
    if (!options.ifMatch) {
      throw new HttpException('If-Match is required; read the job first', 428);
    }
    if (!/^"[a-f0-9]{64}"$/.test(options.ifMatch)) {
      throw new BadRequestException(
        'If-Match must contain one strong job ETag',
      );
    }
    const found = await this.find(key);
    if (versioned(found).etag !== options.ifMatch) {
      throw new PreconditionFailedException('Job changed; read it again');
    }
    if (found.source.deleted) throw new NotFoundException('Job not found');
    const source: JobSource = {
      ...found.source,
      ...(method === 'patch'
        ? { ...update, updated: update.updated || new Date().toISOString() }
        : { deleted: true }),
      _registry: {
        revision: randomUUID(),
        creationFingerprint: found.source._registry?.creationFingerprint,
      },
    };
    try {
      return versioned(
        await this.store.replace(source, found.concurrencyToken),
      );
    } catch (error: unknown) {
      if (error instanceof JobStoreConflictError) {
        throw new PreconditionFailedException('Job changed; read it again');
      }
      throw error;
    }
  }

  listUserJobs(input: ListUserJobs): Promise<JobPage> {
    return this.list('user', input, () => ({
      filters: { backend_id: input.backend_id, user_ids: [input.user_id] },
      fields: input.fields || JOB_FIELDS.filter((field) => field !== 'process'),
      limit: input.limit,
    }));
  }

  listActiveJobs(input: ListActiveJobs): Promise<JobPage> {
    return this.list('active', input, () => {
      return {
        filters: {
          backend_id: input.backend_id,
          statuses: ['created', 'queued', 'running'],
          has_application_id: input.require_application_id ? true : undefined,
          infra_id: input.infra_id,
        },
        fields: input.fields,
        limit: input.limit,
      };
    });
  }

  listCleanupCandidates(input: ListCleanupCandidates): Promise<JobPage> {
    return this.list('cleanup', input, () => ({
      filters: {
        backend_id: input.backend_id,
        statuses: ['queued', 'running', 'finished', 'error', 'canceled'],
        updated_until: input.updated_until,
        user_ids: input.user_ids,
      },
      fields: input.fields,
      limit: input.limit,
    }));
  }

  private list(
    kind: 'user' | 'active' | 'cleanup',
    input: ListJobs,
    buildSearch: () => SearchJobs,
  ): Promise<JobPage> {
    return this.execute(async () => {
      const { next_page, ...parameters } = input;
      const fingerprint = hash({ kind, parameters });
      if (next_page && next_page.fingerprint !== fingerprint) {
        throw new BadRequestException(
          'Continuation does not match listing parameters',
        );
      }
      const asOf = next_page?.as_of || new Date(Date.now()).toISOString();
      const cutoff = (days: number | undefined): string | undefined => {
        if (days === undefined) return undefined;
        const time = Date.parse(asOf) - days * 86400000;
        if (!Number.isFinite(time) || Math.abs(time) > 8640000000000000) {
          throw new BadRequestException(
            'Age filter is outside the supported date range',
          );
        }
        return new Date(time).toISOString();
      };
      const search = buildSearch();
      const page = await this.store.search({
        ...search,
        filters: {
          ...search.filters,
          created_since: cutoff(input.max_age),
          updated_since: cutoff(input.max_updated_ago),
        },
        position: next_page?.position,
      });
      return {
        jobs: page.jobs.map(publicJob),
        next_page:
          page.next_position === null
            ? null
            : { fingerprint, as_of: asOf, position: page.next_position },
      };
    });
  }
}
