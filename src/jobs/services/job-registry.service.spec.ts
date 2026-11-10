import {
  BadRequestException,
  ConflictException,
  NotFoundException,
  PreconditionFailedException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { JobRegistryService } from './job-registry.service';
import { ListJobs, SearchJobs } from '../models/job.v2.dto';
import {
  JobSource,
  JobStore,
  JobStoreConflictError,
  JobStoreInvalidInputError,
  JobStoreNotFoundError,
  JobStoreUnavailableError,
  StoredJob,
  StoredJobPage,
} from '../stores/job-store';

class MemoryJobStore extends JobStore {
  private readonly records = new Map<string, StoredJob>();
  private writes = 0;

  private snapshot(record: StoredJob): StoredJob {
    return JSON.parse(JSON.stringify(record));
  }

  private save(source: JobSource): StoredJob {
    this.writes++;
    const record = this.snapshot({
      source,
      version: `memory-version-${this.writes}`,
      concurrencyToken: `memory-token-${this.writes}`,
    });
    this.records.set(source.job_id, record);
    return this.snapshot(record);
  }

  async create(source: JobSource): Promise<StoredJob> {
    if (this.records.has(source.job_id)) throw new JobStoreConflictError();
    return this.save(source);
  }

  async get(jobId: string): Promise<StoredJob> {
    const record = this.records.get(jobId);
    if (!record) throw new JobStoreNotFoundError();
    return this.snapshot(record);
  }

  async replace(
    source: JobSource,
    concurrencyToken: string,
  ): Promise<StoredJob> {
    if (
      this.records.get(source.job_id)?.concurrencyToken !== concurrencyToken
    ) {
      throw new JobStoreConflictError();
    }
    return this.save(source);
  }

  search = jest.fn<Promise<StoredJobPage>, [SearchJobs]>();
}

describe('JobRegistryService with a non-Elasticsearch store', () => {
  let store: MemoryJobStore;
  let registry: JobRegistryService;
  const input = {
    job_id: '1',
    backend_id: 'CDSE',
    user_id: 'alice',
    parent_id: 'parent-a',
    job_options: { b: 2, a: 1 },
  };
  const key = { job_id: '1' };

  beforeEach(() => {
    store = new MemoryJobStore();
    registry = new JobRegistryService(store);
  });

  afterEach(() => jest.restoreAllMocks());

  it('creates defaults, canonicalizes input, and hides private metadata', async () => {
    const first = await registry.create(input);
    expect(first.job).toMatchObject({ ...input, status: 'created' });
    expect(first.job.updated).toBe(first.job.created);
    expect(Number.isNaN(Date.parse(first.job.created))).toBe(false);
    expect(first.job).not.toHaveProperty('_registry');
    expect(first.job).not.toHaveProperty('deleted');
    const record = await store.get('1');
    expect(record.source._registry).toEqual({
      revision: expect.any(String),
      creationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const replay = await registry.create({
      ...input,
      job_options: { a: 1, b: 2 },
    });
    expect(replay).toEqual(first);
    expect(await store.get('1')).toEqual(record);
  });

  it.each([
    { backend_id: 'OTC' },
    { parent_id: 'parent-b' },
    { user_id: 'bob' },
    { description: null },
    { job_options: { a: 1, b: 3 } },
  ])('rejects changed creation input %j without writing', async (changes) => {
    await registry.create(input);
    const record = await store.get('1');
    await expect(
      registry.create({ ...input, ...changes }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(await store.get('1')).toEqual(record);
  });

  it('preserves the original fingerprint and returns current state on create retries', async () => {
    const first = await registry.create(input);
    const original = await store.get('1');
    const changed = await registry.patch(
      key,
      { status: 'running', usage: { cpu: { value: 1 } } },
      { ifMatch: first.etag },
    );
    const next = await registry.patch(
      key,
      { usage: { ram: { value: 2 } } },
      { ifMatch: changed.etag },
    );
    expect(next.job.usage).toEqual({ ram: { value: 2 } });
    expect(next.etag).not.toBe(changed.etag);
    expect((await store.get('1')).source._registry.creationFingerprint).toBe(
      original.source._registry.creationFingerprint,
    );
    expect(await registry.create(input)).toEqual(next);
    await expect(
      registry.create({ ...input, status: 'running' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('checks user scope independently of the adapter', async () => {
    const first = await registry.create(input);
    await expect(
      registry.get({ ...key, user_id: 'bob' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      registry.patch(
        { ...key, user_id: 'bob' },
        { status: 'running' },
        { ifMatch: first.etag },
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await registry.get({ ...key, user_id: 'alice' })).toEqual(first);
    await expect(registry.get({ job_id: 'absent' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('accepts only one concurrent writer using store-enforced compare-and-swap', async () => {
    const first = await registry.create(input);
    const results = await Promise.allSettled(
      (['running', 'queued'] as const).map((status) =>
        registry.patch(key, { status }, { ifMatch: first.etag }),
      ),
    );
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(1);
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    expect(failures[0].reason).toBeInstanceOf(PreconditionFailedException);
    await expect(
      registry.patch(key, { status: 'finished' }, { ifMatch: first.etag }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
  });

  it('detects writes that restore identical content without changing the app revision', async () => {
    const first = await registry.create(input);
    const original = await store.get('1');
    const intermediate = await store.replace(
      { ...original.source, status: 'running' },
      original.concurrencyToken,
    );
    await store.replace(original.source, intermediate.concurrencyToken);
    const current = await registry.get(key);
    expect(current.job).toEqual(first.job);
    expect(current.etag).not.toBe(first.etag);
    await expect(
      registry.patch(key, { status: 'finished' }, { ifMatch: first.etag }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
  });

  it('retains the existing ETag representation for numeric storage versions', async () => {
    await registry.create(input);
    const record = await store.get('1');
    jest.spyOn(store, 'get').mockResolvedValue({ ...record, version: 7 });
    const response = await registry.get(key);
    const expected = JSON.stringify({
      deleted: false,
      documentVersion: 7,
      job: Object.fromEntries(
        Object.entries({ ...response.job, job_options: { a: 1, b: 2 } }).sort(
          ([a], [b]) => a.localeCompare(b),
        ),
      ),
      revision: record.source._registry.revision,
    });
    expect(response.etag).toBe(
      `"${createHash('sha256').update(expected).digest('hex')}"`,
    );
  });

  it('soft-deletes without allowing retries to overwrite or resurrect the job', async () => {
    const first = await registry.create(input);
    await registry.delete(key, { ifMatch: first.etag });
    expect((await store.get('1')).source.deleted).toBe(true);
    await expect(registry.get(key)).rejects.toBeInstanceOf(NotFoundException);
    await expect(registry.create(input)).rejects.toBeInstanceOf(
      ConflictException,
    );
    await expect(
      registry.delete(key, { ifMatch: first.etag }),
    ).rejects.toBeInstanceOf(PreconditionFailedException);
  });

  it('validates preconditions, empty updates and age range before store access', async () => {
    const get = jest.spyOn(store, 'get');
    await expect(
      registry.patch(key, { status: 'running' }, { ifMatch: undefined }),
    ).rejects.toMatchObject({ status: 428 });
    await expect(registry.delete(key, { ifMatch: '*' })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    await expect(
      registry.patch(key, {}, { ifMatch: `"${'0'.repeat(64)}"` }),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      registry.listActiveJobs({
        limit: 10,
        require_application_id: false,
        max_age: 1e100,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(get).not.toHaveBeenCalled();
    expect(store.search).not.toHaveBeenCalled();
  });

  it('strips internal metadata from search results even if an adapter returns it', async () => {
    await registry.create(input);
    const record = await store.get('1');
    store.search.mockResolvedValue({
      jobs: [{ ...record.source, deleted: false }],
      next_position: { created: 1000, job_id: 'j-next' },
    });
    const response = await registry.listUserJobs({
      limit: 10,
      user_id: 'alice',
    });
    expect(response.next_page).toEqual({
      as_of: expect.any(String),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      position: { created: 1000, job_id: 'j-next' },
    });
    expect(response.jobs[0]).not.toHaveProperty('_registry');
    expect(response.jobs[0]).not.toHaveProperty('deleted');
    expect((await store.get('1')).source._registry).toEqual(
      record.source._registry,
    );
  });

  it.each(['user', 'active', 'cleanup'] as const)(
    'freezes %s age cutoffs across pages even when the clock advances',
    async (kind) => {
      const time = Date.parse('2026-11-10T12:00:00Z');
      const now = jest.spyOn(Date, 'now').mockReturnValue(time);
      const query: ListJobs = {
        limit: 1,
        max_age: 30,
        max_updated_ago: 0.5,
      };
      const list = (parameters: ListJobs) => {
        if (kind === 'user')
          return registry.listUserJobs({ ...parameters, user_id: 'alice' });
        if (kind === 'cleanup')
          return registry.listCleanupCandidates({
            ...parameters,
            updated_until: '2026-11-10T01:00:00Z',
          });
        return registry.listActiveJobs({
          ...parameters,
          require_application_id: true,
        });
      };
      store.search.mockResolvedValueOnce({
        jobs: [],
        next_position: { created: 1000, job_id: 'j-next' },
      });
      const first = await list(query);
      const original = store.search.mock.calls[0][0];
      expect(
        Date.parse(original.filters.updated_since) -
          Date.parse(original.filters.created_since),
      ).toBe(29.5 * 86400000);
      expect(original.filters.created_since).toBe('2026-10-11T12:00:00.000Z');
      expect(original.filters.updated_since).toBe('2026-11-10T00:00:00.000Z');
      if (kind === 'cleanup') {
        expect(original.filters.updated_until).toBe('2026-11-10T01:00:00Z');
      }
      now.mockReturnValue(time + 86400000);
      store.search.mockResolvedValue({ jobs: [], next_position: null });
      await list({ ...query, next_page: first.next_page });
      expect(store.search.mock.calls[1][0]).toEqual({
        ...original,
        position: { created: 1000, job_id: 'j-next' },
      });
      await expect(
        list({
          ...query,
          max_age: 31,
          next_page: first.next_page,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(store.search).toHaveBeenCalledTimes(2);
      now.mockRestore();
    },
  );

  it.each([
    [new JobStoreInvalidInputError('Invalid next_page'), BadRequestException],
    [new JobStoreUnavailableError(), ServiceUnavailableException],
  ])('maps storage errors %j to HTTP errors', async (error, expected) => {
    jest.spyOn(store, 'get').mockRejectedValue(error);
    await expect(registry.get(key)).rejects.toBeInstanceOf(expected);
  });

  it.each(['0'.repeat(64), '1'.repeat(64)])(
    'rejects a mismatched continuation fingerprint %j without accessing storage',
    async (fingerprint) => {
      await expect(
        registry.listUserJobs({
          user_id: 'alice',
          limit: 10,
          next_page: {
            as_of: '2026-11-10T00:00:00Z',
            fingerprint,
            position: { created: 1000, job_id: 'j-next' },
          },
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(store.search).not.toHaveBeenCalled();
    },
  );

  it('lets the adapter reject invalid positions without exposing its errors', async () => {
    store.search.mockResolvedValueOnce({
      jobs: [],
      next_position: { created: 1000, job_id: 'j-next' },
    });
    const first = await registry.listUserJobs({ user_id: 'alice', limit: 10 });
    store.search.mockRejectedValueOnce(
      new JobStoreInvalidInputError('Invalid next_page'),
    );
    await expect(
      registry.listUserJobs({
        user_id: 'alice',
        limit: 10,
        next_page: first.next_page,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
