import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { ElasticsearchService } from '@nestjs/elasticsearch';
import { ResponseError } from '@elastic/elasticsearch/lib/errors';
import * as request from 'supertest';
import { JobsModule } from '../jobs.module';
import { JobStore, JobStoreUnavailableError } from './job-store';
import { ElasticsearchJobStore } from './elasticsearch-job-store';

describe('Domain jobs API and legacy compatibility', () => {
  let app: INestApplication;
  const elastic = {
    search: jest.fn(),
    create: jest.fn(),
    index: jest.fn(),
    update: jest.fn(),
    get: jest.fn(),
  };
  const base = '/v2/jobs';
  const job = {
    backend_id: 'qa',
    job_id: 'j-1',
    user_id: 'alice',
    created: '2026-11-09T12:00:00.000Z',
    updated: '2026-11-09T12:00:00.000Z',
    status: 'created',
  };
  const hit = {
    _id: 'j-1',
    _source: job,
    _seq_no: 4,
    _primary_term: 1,
    _version: 1,
    sort: [1794225600000, 'j-1'],
  };
  const result = (hits = [hit]) => ({ body: { hits: { hits } } });
  let etag: string;
  const esError = (statusCode: number) =>
    new ResponseError({
      statusCode,
      body: {},
      headers: {},
      warnings: null,
      meta: null,
    });

  beforeAll(async () => {
    const module = await Test.createTestingModule({ imports: [JobsModule] })
      .overrideProvider(ElasticsearchService)
      .useValue(elastic)
      .compile();
    expect(module.get(JobStore)).toBeInstanceOf(ElasticsearchJobStore);
    app = module.createNestApplication();
    app.useLogger(false);
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidUnknownValues: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  beforeEach(async () => {
    for (const mock of Object.values(elastic)) {
      mock.mockReset();
    }
    elastic.search.mockResolvedValue(result());
    elastic.create.mockResolvedValue({
      body: { _version: 1, _seq_no: 0, _primary_term: 1 },
    });
    elastic.update.mockResolvedValue({});
    elastic.get.mockResolvedValue({ body: hit });
    elastic.index.mockResolvedValue({
      body: { _version: 2, _seq_no: 5, _primary_term: 1 },
    });
    const response = await request(app.getHttpServer())
      .get(`${base}/j-1`)
      .expect(200);
    etag = response.headers.etag;
    elastic.get.mockClear();
  });

  afterAll(() => app.close());

  it('creates a domain job and supplies defaults without changing legacy storage', async () => {
    elastic.search.mockResolvedValue(result([]));
    const response = await request(app.getHttpServer())
      .post(base)
      .send({
        backend_id: 'qa',
        job_id: 'j-1',
        user_id: 'alice',
        process: { process_graph: {} },
      })
      .expect(201);
    expect(response.body).toMatchObject({
      backend_id: 'qa',
      job_id: 'j-1',
      user_id: 'alice',
      status: 'created',
    });
    expect(Number.isNaN(Date.parse(response.body.created))).toBe(false);
    expect(response.body.updated).toBe(response.body.created);
    expect(elastic.create).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'j-1',
        body: expect.objectContaining(response.body),
        refresh: 'wait_for',
      }),
    );
    expect(elastic.search).not.toHaveBeenCalled();
    expect(elastic.get).not.toHaveBeenCalled();
    expect(response.headers.etag).toMatch(/^"[a-f0-9]{64}"$/);
  });

  it('rejects creation retries when the original creation input is unavailable', async () => {
    elastic.create.mockRejectedValue(esError(409));
    await request(app.getHttpServer())
      .post(base)
      .send({ backend_id: 'qa', job_id: 'j-1', user_id: 'alice' })
      .expect(409);
    expect(elastic.create).toHaveBeenCalledTimes(1);
    expect(elastic.index).not.toHaveBeenCalled();
  });

  it('returns 409 on an atomic create conflict', async () => {
    elastic.get.mockResolvedValue({
      body: { ...hit, _source: { ...job, backend_id: 'prod' } },
    });
    elastic.create.mockRejectedValue(
      new ResponseError({
        statusCode: 409,
        body: {},
        headers: {},
        warnings: null,
        meta: null,
      }),
    );
    await request(app.getHttpServer())
      .post(base)
      .send({ backend_id: 'qa', job_id: 'j-1', user_id: 'alice' })
      .expect(409);
  });

  it('gets an existing job by global ID with optional user scope', async () => {
    await request(app.getHttpServer())
      .get(`${base}/j-1?user_id=alice`)
      .expect(200, job);
    expect(elastic.get).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'j-1' }),
    );
    expect(elastic.search).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .get(`${base}/j-1?user_id=bob`)
      .expect(404);
  });

  it('returns 404 for absent jobs and tombstones without search fallback', async () => {
    elastic.get.mockRejectedValueOnce(esError(404));
    await request(app.getHttpServer()).get(`${base}/absent`).expect(404);
    elastic.get.mockResolvedValueOnce({
      body: { ...hit, _source: { ...job, deleted: true } },
    });
    await request(app.getHttpServer()).get(`${base}/j-1`).expect(404);
    expect(elastic.search).not.toHaveBeenCalled();
  });

  it('updates a direct document with the client version and an atomic concurrency guard', async () => {
    await request(app.getHttpServer())
      .patch(`${base}/j-1?user_id=alice`)
      .set('If-Match', etag)
      .send({
        status: 'running',
        application_id: 'spark-1',
        dependencies: null,
        dependency_status: null,
        results_metadata_uri: 's3://results/j-1.json',
        usage: { cpu: { value: 10 } },
        costs: 1.5,
      })
      .expect(200);
    expect(elastic.index).toHaveBeenCalledWith(
      expect.objectContaining({
        id: hit._id,
        if_seq_no: 4,
        if_primary_term: 1,
        refresh: 'wait_for',
        body: expect.objectContaining({
          status: 'running',
          dependencies: null,
          dependency_status: null,
          updated: expect.any(String),
        }),
      }),
    );
  });

  it('uses the committed storage version for mutation ETags without rereading', async () => {
    elastic.index.mockResolvedValue({
      body: { _version: 17, _seq_no: 29, _primary_term: 3 },
    });
    const changed = await request(app.getHttpServer())
      .patch(`${base}/j-1`)
      .set('If-Match', etag)
      .send({ status: 'running' })
      .expect(200);
    expect(elastic.get).toHaveBeenCalledTimes(1);
    const written = elastic.index.mock.calls[0][0].body;
    elastic.get.mockResolvedValue({
      body: {
        ...hit,
        _source: written,
        _version: 17,
        _seq_no: 29,
        _primary_term: 3,
      },
    });
    const current = await request(app.getHttpServer())
      .get(`${base}/j-1`)
      .expect(200);
    expect(current.headers.etag).toBe(changed.headers.etag);
    await request(app.getHttpServer())
      .patch(`${base}/j-1`)
      .set('If-Match', current.headers.etag)
      .send({ status: 'finished' })
      .expect(200);
    expect(elastic.index.mock.calls[1][0]).toMatchObject({
      if_seq_no: 29,
      if_primary_term: 3,
    });
  });

  it('fails explicitly when storage omits committed version metadata', async () => {
    elastic.index.mockResolvedValue({ body: {} });
    await request(app.getHttpServer())
      .patch(`${base}/j-1`)
      .set('If-Match', etag)
      .send({ status: 'running' })
      .expect(503);
    expect(elastic.index).toHaveBeenCalledTimes(1);
    expect(elastic.get).toHaveBeenCalledTimes(1);
  });

  it.each([
    '[0,0]',
    '[0,-1]',
    '[-1,1]',
    '[0,1.5]',
    '[0,"1"]',
    '[0]',
    'null',
    'invalid JSON',
  ])('rejects invalid concurrency token %s before writing', async (token) => {
    const store = app.get(JobStore);
    const stored = await store.get(job.job_id);
    await expect(store.replace(stored.source, token)).rejects.toBeInstanceOf(
      JobStoreUnavailableError,
    );
    expect(elastic.index).not.toHaveBeenCalled();
  });

  it('accepts sequence number zero with primary term one', async () => {
    const store = app.get(JobStore);
    const stored = await store.get(job.job_id);
    await store.replace(stored.source, '[0,1]');
    expect(elastic.index).toHaveBeenCalledWith(
      expect.objectContaining({ if_seq_no: 0, if_primary_term: 1 }),
    );
  });

  it('soft-deletes the scoped document and returns an empty 204 response', async () => {
    const response = await request(app.getHttpServer())
      .delete(`${base}/j-1`)
      .set('If-Match', etag)
      .expect(204);
    expect(response.text).toBe('');
    expect(elastic.index).toHaveBeenCalledWith(
      expect.objectContaining({
        id: hit._id,
        body: expect.objectContaining({ deleted: true }),
      }),
    );
  });

  it.each(['patch', 'delete'] as const)(
    'returns 412 on a concurrent %s without retrying the write',
    async (method) => {
      elastic.index.mockRejectedValue(
        new ResponseError({
          statusCode: 409,
          body: {},
          headers: {},
          warnings: null,
          meta: null,
        }),
      );
      await request(app.getHttpServer())
        [method](`${base}/j-1`)
        .set('If-Match', etag)
        .send(method === 'patch' ? { status: 'running' } : undefined)
        .expect(412);
      expect(elastic.index).toHaveBeenCalledTimes(1);
    },
  );

  it('translates active-job filters without leaking ES response metadata', async () => {
    const response = await request(app.getHttpServer())
      .post(`${base}/active`)
      .send({
        backend_id: 'qa',
        infra_id: 'aks-qa',
        require_application_id: true,
        max_age: 30,
        max_updated_ago: 7,
        fields: ['job_id', 'status'],
        limit: 10,
      })
      .expect(200);
    expect(response.body).toEqual({ jobs: [job], next_page: null });
    expect(elastic.search).toHaveBeenCalledWith(
      expect.objectContaining({
        size: 11,
        body: {
          track_total_hits: false,
          query: {
            bool: {
              filter: [
                { term: { backend_id: 'qa' } },
                { terms: { status: ['created', 'queued', 'running'] } },
                { term: { infra_id: 'aks-qa' } },
                { exists: { field: 'application_id' } },
                {
                  range: {
                    created: {
                      gte: expect.any(String),
                    },
                  },
                },
                {
                  range: {
                    updated: {
                      gte: expect.any(String),
                    },
                  },
                },
              ],
              must_not: [{ term: { deleted: true } }],
            },
          },
          _source: ['job_id', 'status'],
          sort: [{ created: 'desc' }, { job_id: 'asc' }],
        },
      }),
    );
  });

  it('preserves inclusive lower and upper date bounds without counting matches', async () => {
    await app.get(JobStore).search({
      limit: 10,
      filters: {
        created_since: '2026-10-01T00:00:00.000Z',
        created_until: '2026-11-01T00:00:00.000Z',
        updated_since: '2026-11-01T00:00:00.000Z',
        updated_until: '2026-11-10T00:00:00.000Z',
      },
    });
    expect(elastic.search).toHaveBeenCalledWith(
      expect.objectContaining({
        size: 11,
        body: expect.objectContaining({
          track_total_hits: false,
          query: {
            bool: {
              filter: [
                {
                  range: {
                    created: {
                      gte: '2026-10-01T00:00:00.000Z',
                      lte: '2026-11-01T00:00:00.000Z',
                    },
                  },
                },
                {
                  range: {
                    updated: {
                      gte: '2026-11-01T00:00:00.000Z',
                      lte: '2026-11-10T00:00:00.000Z',
                    },
                  },
                },
              ],
              must_not: [{ term: { deleted: true } }],
            },
          },
        }),
      }),
    );
  });

  it('lists user jobs without process by default and supports cross-backend listing', async () => {
    elastic.search.mockResolvedValue(result([]));
    await request(app.getHttpServer())
      .post(`${base}/user`)
      .send({ user_id: 'alice' })
      .expect(200, { jobs: [], next_page: null });
    expect(elastic.search).toHaveBeenCalledTimes(1);
    expect(elastic.search.mock.calls[0][0]).toMatchObject({
      size: 101,
      body: {
        query: {
          bool: {
            filter: [{ terms: { user_id: ['alice'] } }],
            must_not: [{ term: { deleted: true } }],
          },
        },
      },
    });
    expect(elastic.search.mock.calls[0][0].body._source).not.toContain(
      'process',
    );
  });

  it('returns structured continuations and rejects changed listings or backends', async () => {
    const second = {
      ...hit,
      _source: { ...job, job_id: 'j-2' },
      sort: [1794225600000, 'j-2'],
    };
    elastic.search.mockResolvedValueOnce(result([hit, second]));
    const first = await request(app.getHttpServer())
      .post(`${base}/user`)
      .send({ user_id: 'alice', limit: 1 })
      .expect(200);
    expect(first.body.jobs).toEqual([job]);
    expect(first.body.next_page).toEqual({
      as_of: expect.any(String),
      fingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      position: { created: hit.sort[0], job_id: hit.sort[1] },
    });
    elastic.search.mockResolvedValueOnce(result([second]));
    await request(app.getHttpServer())
      .post(`${base}/user`)
      .send({ user_id: 'alice', limit: 1, next_page: first.body.next_page })
      .expect(200, { jobs: [second._source], next_page: null });
    expect(elastic.search.mock.calls[1][0].body.search_after).toEqual(hit.sort);
    for (const [url, query] of [
      [`${base}/user`, { user_id: 'alice', limit: 2 }],
      [`${base}/user`, { user_id: 'alice', limit: 1, backend_id: 'prod' }],
      [`${base}/user`, { user_id: 'bob', limit: 1 }],
      [`${base}/active`, { limit: 1 }],
    ] as const) {
      await request(app.getHttpServer())
        .post(url)
        .send({ ...query, next_page: first.body.next_page })
        .expect(400);
    }
    expect(elastic.search).toHaveBeenCalledTimes(2);
  });

  it.each([
    { query: 'match_all' },
    { filters: 'arbitrary' },
    { backend_id: '' },
    { statuses: 'finished' },
    { user_id: '' },
    { fields: '_id' },
    { fields: '' },
    { fields: 'job_id,job_id' },
    { fields: ['job_id', 'job_id'] },
    { limit: 0 },
    { limit: 1001 },
    { limit: 'no-number' },
    { limit: 1.5 },
    { limit: '10' },
    { next_page: '' },
    { next_page: 'not-json' },
    { next_page: null },
    { next_page: [] },
    { next_page: {} },
    {
      next_page: {
        as_of: 'not-a-date',
        fingerprint: '0'.repeat(64),
        position: { created: 1, job_id: 'j-1' },
      },
    },
    {
      next_page: {
        as_of: '2026-02-30T00:00:00Z',
        fingerprint: '0'.repeat(64),
        position: { created: 1, job_id: 'j-1' },
      },
    },
    {
      next_page: {
        as_of: '2026-11-10T00:00:00Z',
        fingerprint: '0'.repeat(64),
        position: { created: '1', job_id: 'j-1' },
      },
    },
    {
      next_page: {
        as_of: '2026-11-10T00:00:00Z',
        fingerprint: '0'.repeat(64),
        position: { job_id: 'j-1' },
      },
    },
    {
      next_page: {
        as_of: '2026-11-10T00:00:00Z',
        fingerprint: '0'.repeat(64),
        position: { created: 1, job_id: 1 },
      },
    },
    {
      next_page: {
        as_of: '2026-11-10T00:00:00Z',
        fingerprint: '0'.repeat(64),
        position: null,
      },
    },
  ])('rejects invalid user-job listings: %j', async (query) => {
    await request(app.getHttpServer())
      .post(`${base}/user`)
      .send({ user_id: 'alice', ...query })
      .expect(400);
    expect(elastic.search).not.toHaveBeenCalled();
  });

  it('round-trips missing sort values as explicit nulls in the public continuation', async () => {
    const missing = { ...hit, sort: [null, null] };
    elastic.search.mockResolvedValueOnce(result([missing, hit]));
    const first = await request(app.getHttpServer())
      .post(`${base}/user`)
      .send({ user_id: 'alice', limit: 1 })
      .expect(200);
    expect(first.body.next_page.position).toEqual({
      created: null,
      job_id: null,
    });
    elastic.search.mockResolvedValueOnce(result([]));
    await request(app.getHttpServer())
      .post(`${base}/user`)
      .send({ user_id: 'alice', limit: 1, next_page: first.body.next_page })
      .expect(200, { jobs: [], next_page: null });
    expect(elastic.search.mock.calls[1][0].body.search_after).toEqual([
      null,
      null,
    ]);
  });

  it('lists cleanup candidates by updated cutoff, including queued/running but excluding created', async () => {
    await request(app.getHttpServer())
      .post(`${base}/cleanup-candidates`)
      .send({
        backend_id: 'qa',
        updated_until: '2026-11-09T00:00:00Z',
        user_ids: ['alice', 'bob'],
        fields: ['job_id', 'status'],
        limit: 10,
      })
      .expect(200);
    expect(elastic.search.mock.calls[0][0].body).toMatchObject({
      query: {
        bool: {
          filter: [
            { term: { backend_id: 'qa' } },
            { terms: { user_id: ['alice', 'bob'] } },
            {
              terms: {
                status: ['queued', 'running', 'finished', 'error', 'canceled'],
              },
            },
            { range: { updated: { lte: '2026-11-09T00:00:00Z' } } },
          ],
          must_not: [{ term: { deleted: true } }],
        },
      },
      _source: ['job_id', 'status'],
    });
  });

  it.each([
    [`${base}/user`, {}],
    [`${base}/active`, { max_age: -1 }],
    [`${base}/active`, { max_updated_ago: 'NaN' }],
    [`${base}/active`, { max_age: 'Infinity' }],
    [`${base}/active`, { max_age: '1e100' }],
    [`${base}/active`, { max_age: '999999999999999999' }],
    [`${base}/active`, { require_application_id: 'yes' }],
    [`${base}/active`, { require_application_id: '1' }],
    [`${base}/active`, { user_id: 'alice' }],
    [`${base}/active`, { statuses: 'finished' }],
    [`${base}/cleanup-candidates`, {}],
    [`${base}/cleanup-candidates`, { updated_until: 'now-30d' }],
    [`${base}/cleanup-candidates`, { updated_until: '2026-11-09' }],
    [`${base}/cleanup-candidates`, { updated_until: '2026-02-30T00:00:00Z' }],
    [
      `${base}/cleanup-candidates`,
      { updated_until: '2026-11-09T00:00:00Z', user_ids: '' },
    ],
  ])('rejects invalid listing parameters on %s: %j', async (url, query) => {
    await request(app.getHttpServer()).post(url).send(query).expect(400);
    expect(elastic.search).not.toHaveBeenCalled();
  });

  it('treats zero ages as now and false application-ID requirement as no existence filter', async () => {
    await request(app.getHttpServer())
      .post(`${base}/active`)
      .send({
        max_age: 0,
        max_updated_ago: 0,
        require_application_id: false,
      })
      .expect(200);
    const filters = elastic.search.mock.calls[0][0].body.query.bool.filter;
    expect(filters).toEqual([
      { terms: { status: ['created', 'queued', 'running'] } },
      { range: { created: { gte: expect.any(String) } } },
      { range: { updated: { gte: expect.any(String) } } },
    ]);
    expect(filters[1].range.created.gte).toBe(filters[2].range.updated.gte);
  });

  it('removes public v2 search while retaining the legacy search endpoint', async () => {
    await request(app.getHttpServer())
      .post(`${base}/search`)
      .send({})
      .expect(404);
    expect(elastic.search).not.toHaveBeenCalled();
  });

  it.each(['user', 'active', 'cleanup-candidates'])(
    'allows job ID %s because POST listings do not shadow CRUD routes',
    async (job_id) => {
      const created = await request(app.getHttpServer())
        .post(base)
        .send({ job_id, backend_id: 'qa', user_id: 'alice' })
        .expect(201);
      elastic.get.mockResolvedValue({
        body: { ...hit, _source: elastic.create.mock.calls[0][0].body },
      });
      await request(app.getHttpServer())
        .get(`${base}/${job_id}`)
        .expect(200, created.body);
    },
  );

  it.each([
    {},
    { backend_id: 'prod' },
    { job_id: 'replacement' },
    { user_id: 'bob' },
    { deleted: true },
    { status: 'invalid' },
    { status: null },
  ])('rejects invalid or identity-changing patches: %j', async (body) => {
    await request(app.getHttpServer())
      .patch(`${base}/j-1`)
      .send(body)
      .expect(400);
    expect(elastic.update).not.toHaveBeenCalled();
  });

  it('rejects invalid creation identities and query-scope overrides', async () => {
    for (const body of [
      { job_id: 'j-1', user_id: 'alice', backend_id: '' },
      { job_id: 'j-1', user_id: 'alice', backend_id: null },
      { job_id: 'j-1', user_id: 'alice', backend_id: 42 },
      { job_id: 1, user_id: 'alice' },
      { job_id: 'j-1', user_id: '' },
      { job_id: 'j-1', user_id: 'alice', status: null },
    ]) {
      await request(app.getHttpServer())
        .post(base)
        .send({ backend_id: 'qa', ...body })
        .expect(400);
    }
    await request(app.getHttpServer())
      .post(base)
      .send({ job_id: 'j-1', user_id: 'alice' })
      .expect(400);
    await request(app.getHttpServer())
      .get(`${base}/j-1?backend_id=prod`)
      .expect(400);
    expect(elastic.search).not.toHaveBeenCalled();
  });

  it('surfaces storage failures without exposing ES error details', async () => {
    elastic.get.mockRejectedValue(new Error('secret ES transport details'));
    const response = await request(app.getHttpServer())
      .get(`${base}/j-1`)
      .expect(503);
    expect(response.body.message).toBe('Job storage is unavailable');
    expect(JSON.stringify(response.body)).not.toContain('secret');
  });

  it('does not emit an unusable next_page when the storage response is invalid', async () => {
    elastic.search.mockResolvedValue(
      result([{ ...hit, sort: undefined }, hit]),
    );
    await request(app.getHttpServer())
      .post(`${base}/user`)
      .send({ user_id: 'alice', limit: 1 })
      .expect(503);
  });

  it('retains the legacy create and raw-ES search response contracts', async () => {
    elastic.index.mockResolvedValue({ statusCode: 201 });
    await request(app.getHttpServer()).post('/jobs').send(job).expect(201, job);
    await request(app.getHttpServer())
      .post('/jobs/search')
      .send({ query: { bool: { filter: [{ term: { user_id: 'alice' } }] } } })
      .expect(200, [job]);
    await request(app.getHttpServer())
      .post('/jobs/search/paginated?size=10&page=0')
      .send({ query: { bool: { filter: [{ term: { job_id: 'j-1' } }] } } })
      .expect(200, {
        jobs: [job],
        pagination: { previous: null, next: null },
      });
    expect(elastic.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      summary: 'test',
      process_graph: {
        add: { process_id: 'add', arguments: { x: 3, y: 5 }, result: true },
      },
    },
    '{"summary":"test","process_graph":{}}',
  ])(
    'preserves the driver creation payload with process %j',
    async (process) => {
      elastic.search.mockResolvedValue(result([]));
      const payload = {
        job_id: 'j-1',
        user_id: 'alice',
        process,
        job_options: { 'executor-memory': '2G', nested: { flag: true } },
        title: null,
        description: 'driver job',
        parent_id: null,
        application_id: null,
        api_version: '1.2.0',
        status: 'created',
        created: job.created,
        updated: job.updated,
      };
      const response = await request(app.getHttpServer())
        .post(base)
        .send({ backend_id: 'qa', ...payload })
        .expect(201);
      expect(response.body).toEqual({ ...payload, backend_id: 'qa' });
      expect(elastic.create.mock.calls[0][0].body).toMatchObject(response.body);
    },
  );

  it('stores the driver setter fields and metadata-conversion inputs unchanged', async () => {
    const update = {
      status: 'finished',
      updated: '2026-11-10T12:00:00Z',
      started: '2026-11-10T11:00:00Z',
      finished: '2026-11-10T12:00:00Z',
      infra_id: 'aks-qa',
      application_id: 'spark-1',
      proxy_user: 'proxy-alice',
      dependencies: [{ collection_id: 'S2', batch_request_id: 'dep-1' }],
      dependency_status: 'available',
      dependency_usage: '12345678901234567890.12345678901234567890',
      costs: 0,
      usage: {
        input_pixel: { value: 42, unit: 'pixel' },
        custom: { value: 1 },
      },
      input_pixel: 42,
      cpu_time_seconds: 12.5,
      memory_time_megabyte_seconds: 512.25,
      results_metadata_uri: 's3://results/j-1.json',
      results_metadata: {
        geometry: { type: 'Point', coordinates: [4, 51] },
        bbox: [4, 50, 5, 51],
        start_datetime: '2026-01-01T00:00:00Z',
        end_datetime: '2026-02-01T00:00:00Z',
        instruments: ['MSI'],
        epsg: 4326,
        links: [{ rel: 'derived_from', href: 's3://source' }],
        'proj:shape': [100, 100],
        'proj:bbox': [0, 0, 100, 100],
        custom: { extension: true },
      },
    };
    await request(app.getHttpServer())
      .patch(`${base}/j-1`)
      .set('If-Match', etag)
      .send(update)
      .expect(200, { ...job, ...update });
    expect(elastic.index.mock.calls[0][0].body).toMatchObject(update);
    elastic.get.mockResolvedValue({
      body: { ...hit, _source: { ...job, ...update } },
    });
    elastic.search.mockResolvedValue({
      body: { hits: { hits: [{ ...hit, _source: { ...job, ...update } }] } },
    });
    await request(app.getHttpServer())
      .get(`${base}/j-1`)
      .expect(200, { ...job, ...update });
    await request(app.getHttpServer())
      .post(`${base}/user`)
      .send({
        user_id: 'alice',
        fields: [
          'cpu_time_seconds',
          'memory_time_megabyte_seconds',
          'results_metadata',
        ],
      })
      .expect(200);
    expect(elastic.search.mock.calls[0][0].body._source).toEqual([
      'cpu_time_seconds',
      'memory_time_megabyte_seconds',
      'results_metadata',
    ]);
  });

  it.each(['awaiting', 'available', 'awaiting_retry', 'error', null])(
    'accepts dependency status %j including removal',
    async (dependency_status) => {
      await request(app.getHttpServer())
        .patch(`${base}/j-1`)
        .set('If-Match', etag)
        .send({ dependency_status, dependencies: null })
        .expect(200);
      expect(elastic.index.mock.calls[0][0].body).toMatchObject({
        dependency_status,
        dependencies: null,
      });
    },
  );

  it.each(['0', '-0.0001', '1E+20', '1.234567890123456789E-30'])(
    'preserves decimal dependency usage %s without numeric coercion',
    async (dependency_usage) => {
      await request(app.getHttpServer())
        .patch(`${base}/j-1`)
        .set('If-Match', etag)
        .send({ dependency_usage })
        .expect(200);
      expect(elastic.index.mock.calls[0][0].body.dependency_usage).toBe(
        dependency_usage,
      );
    },
  );

  it.each([
    { dependency_status: 'running' },
    { dependency_usage: 1.5 },
    { dependency_usage: 'NaN' },
    { dependency_usage: 'Infinity' },
    { dependency_usage: 'not-a-decimal' },
    { dependencies: ['dep-1'] },
    { dependencies: [{ id: 1 }] },
    { dependencies: [null] },
    { application_id: 123 },
    { proxy_user: false },
    { infra_id: {} },
    { title: ['title'] },
    { costs: '1.5' },
    { input_pixel: '42' },
    { cpu_time_seconds: '10' },
    { memory_time_megabyte_seconds: [] },
    { usage: [] },
    { results_metadata: 'metadata' },
    { results_metadata_uri: 123 },
  ])('rejects invalid driver-model field types: %j', async (body) => {
    await request(app.getHttpServer())
      .patch(`${base}/j-1`)
      .send(body)
      .expect(400);
    expect(elastic.update).not.toHaveBeenCalled();
  });

  it.each([
    { process: 'not-json' },
    { process: '[]' },
    { process: 'null' },
    { process: '"string"' },
    { process: [] },
    { process: 42 },
    { job_options: [] },
    { job_options: 'options' },
    { parent_id: 123 },
  ])('rejects invalid creation metadata: %j', async (body) => {
    await request(app.getHttpServer())
      .post(base)
      .send({ backend_id: 'qa', job_id: 'j-1', user_id: 'alice', ...body })
      .expect(400);
    expect(elastic.create).not.toHaveBeenCalled();
  });

  it.each(['patch', 'delete'] as const)(
    'requires a valid client version for %s',
    async (method) => {
      const body = method === 'patch' ? { status: 'running' } : undefined;
      await request(app.getHttpServer())
        [method](`${base}/j-1`)
        .send(body)
        .expect(428);
      for (const token of ['*', `W/${etag}`, `${etag}, ${etag}`, 'invalid']) {
        await request(app.getHttpServer())
          [method](`${base}/j-1`)
          .set('If-Match', token)
          .send(body)
          .expect(400);
      }
      await request(app.getHttpServer())
        [method](`${base}/j-1`)
        .set('If-Match', `"${'0'.repeat(64)}"`)
        .send(body)
        .expect(412);
      expect(elastic.index).not.toHaveBeenCalled();
    },
  );

  it('rejects storage metadata injection', async () => {
    await request(app.getHttpServer())
      .post(base)
      .send({
        backend_id: 'qa',
        job_id: 'j-1',
        user_id: 'alice',
        _registry: { revision: 'fake' },
      })
      .expect(400);
    expect(elastic.create).not.toHaveBeenCalled();
  });

  it.each([
    ['a'.repeat(512), 201],
    ['a'.repeat(513), 400],
    ['\u00e9'.repeat(256), 201],
    ['\u00e9'.repeat(257), 400],
  ])('enforces the UTF-8 byte limit for job ID %j', async (jobId, status) => {
    await request(app.getHttpServer())
      .post(base)
      .send({ backend_id: 'qa', job_id: jobId, user_id: 'alice' })
      .expect(status);
    expect(elastic.create).toHaveBeenCalledTimes(status === 201 ? 1 : 0);
  });

  describe('create-if-absent and conditional mutations', () => {
    beforeEach(() => {
      let document: object | undefined;
      let seq = 0;
      elastic.create.mockImplementation(async ({ body }) => {
        if (document) throw esError(409);
        document = body;
        return { body: { _version: 1, _seq_no: seq, _primary_term: 1 } };
      });
      elastic.get.mockImplementation(async () => {
        if (!document) throw esError(404);
        return {
          body: {
            _id: 'j-1',
            _source: document,
            _seq_no: seq,
            _primary_term: 1,
            _version: seq + 1,
          },
        };
      });
      elastic.index.mockImplementation(async ({ body, if_seq_no }) => {
        if (if_seq_no !== seq) throw esError(409);
        seq++;
        document = body;
        return { body: { _version: seq + 1, _seq_no: seq, _primary_term: 1 } };
      });
    });

    const create = () =>
      request(app.getHttpServer())
        .post(base)
        .send({
          backend_id: 'qa',
          job_id: 'j-1',
          user_id: 'alice',
          process: { process_graph: {} },
        });

    it('reserves job ID 1 for CDSE and rejects creation by OTC', async () => {
      const input = { job_id: '1', user_id: 'alice' };
      const first = await request(app.getHttpServer())
        .post(base)
        .send({ ...input, backend_id: 'CDSE' })
        .expect(201);
      expect(first.body).toMatchObject({ ...input, backend_id: 'CDSE' });
      expect(elastic.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: '1' }),
      );

      await request(app.getHttpServer())
        .post(base)
        .send({ ...input, backend_id: 'OTC' })
        .expect(409);

      const replay = await request(app.getHttpServer())
        .post(base)
        .send({ ...input, backend_id: 'CDSE' })
        .expect(201);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers.etag).toBe(first.headers.etag);
      const current = await request(app.getHttpServer())
        .get(`${base}/1`)
        .expect(200);
      expect(current.body).toEqual(first.body);
      expect(current.headers.etag).toBe(first.headers.etag);
      expect(elastic.index).not.toHaveBeenCalled();
      expect(elastic.search).not.toHaveBeenCalled();
    });

    it('replays creation after updates without resetting the job or regenerating timestamps', async () => {
      const first = await create().expect(201);
      const changed = await request(app.getHttpServer())
        .patch(`${base}/j-1`)
        .set('If-Match', first.headers.etag)
        .send({ status: 'running' })
        .expect(200);
      const replay = await create().expect(201);
      expect(replay.body).toEqual(changed.body);
      expect(replay.body.created).toBe(first.body.created);
      expect(replay.headers.etag).toBe(changed.headers.etag);
      expect(elastic.index).toHaveBeenCalledTimes(1);
      expect(elastic.index.mock.calls[0][0].body._registry).toEqual({
        revision: expect.any(String),
        creationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(
        elastic.index.mock.calls[0][0].body._registry.creationFingerprint,
      ).toBe(
        elastic.create.mock.calls[0][0].body._registry.creationFingerprint,
      );
      const current = await request(app.getHttpServer())
        .get(`${base}/j-1`)
        .expect(200);
      expect(current.body.status).toBe('running');
      expect(current.headers.etag).toBe(changed.headers.etag);
      await request(app.getHttpServer())
        .post(base)
        .send({
          backend_id: 'qa',
          job_id: 'j-1',
          user_id: 'bob',
          title: 'different',
        })
        .expect(409);
      await request(app.getHttpServer())
        .post(base)
        .send({ backend_id: 'prod', job_id: 'j-1', user_id: 'alice' })
        .expect(409);
      expect(elastic.search).not.toHaveBeenCalled();
    });

    it('rejects repeated mutations with stale ETags and never resurrects deleted jobs', async () => {
      const first = await create().expect(201);
      const patch = () =>
        request(app.getHttpServer())
          .patch(`${base}/j-1`)
          .set('If-Match', first.headers.etag)
          .send({ status: 'running', usage: { cpu: { value: 1 } } });
      const changed = await patch().expect(200);
      const next = await request(app.getHttpServer())
        .patch(`${base}/j-1`)
        .set('If-Match', changed.headers.etag)
        .send({ status: 'finished', usage: { ram: { value: 2 } } })
        .expect(200);
      expect(next.body.usage).toEqual({ ram: { value: 2 } });
      await patch().expect(412);
      expect(elastic.index).toHaveBeenCalledTimes(2);
      await request(app.getHttpServer())
        .patch(`${base}/j-1`)
        .set('If-Match', first.headers.etag)
        .send({ status: 'error' })
        .expect(412);
      await request(app.getHttpServer())
        .patch(`${base}/j-1`)
        .set('If-Match', changed.headers.etag)
        .send({ status: 'error' })
        .expect(412);
      const remove = () =>
        request(app.getHttpServer())
          .delete(`${base}/j-1`)
          .set('If-Match', next.headers.etag);
      await remove().expect(204);
      await remove().expect(412);
      await patch().expect(412);
      await request(app.getHttpServer()).get(`${base}/j-1`).expect(404);
      await create().expect(409);
      await request(app.getHttpServer()).get(`${base}/j-1`).expect(404);
      expect(elastic.index).toHaveBeenCalledTimes(3);
      expect(elastic.search).not.toHaveBeenCalled();
    });

    it('returns an existing job without replacing metadata or incrementing its version', async () => {
      const first = await request(app.getHttpServer())
        .post(base)
        .send({
          backend_id: 'qa',
          job_id: 'j-1',
          user_id: 'alice',
          job_options: { b: 2, a: 1 },
        })
        .expect(201);
      const replay = await request(app.getHttpServer())
        .post(base)
        .send({
          backend_id: 'qa',
          user_id: 'alice',
          job_options: { a: 1, b: 2 },
          job_id: 'j-1',
        })
        .expect(201);
      expect(replay.body).toEqual(first.body);
      expect(replay.headers.etag).toBe(first.headers.etag);
      expect(elastic.index).not.toHaveBeenCalled();
      expect(elastic.create.mock.calls[0][0].body._registry).toEqual({
        revision: expect.any(String),
        creationFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
    });

    it.each([
      { parent_id: 'parent-b' },
      { user_id: 'bob' },
      { title: 'different' },
      { job_options: { retries: 2 } },
      { process: { process_graph: { different: {} } } },
      { status: 'running' },
      { created: '2026-11-10T00:00:00Z' },
      { description: null },
    ])(
      'rejects changed creation fields %j without modifying the job',
      async (changes) => {
        const input = {
          job_id: 'j-1',
          user_id: 'alice',
          parent_id: 'parent-a',
          process: { process_graph: {} },
        };
        const first = await request(app.getHttpServer())
          .post(base)
          .send({ backend_id: 'qa', ...input })
          .expect(201);
        await request(app.getHttpServer())
          .post(base)
          .send({ backend_id: 'qa', ...input, ...changes })
          .expect(409);
        const current = await request(app.getHttpServer())
          .get(`${base}/j-1`)
          .expect(200);
        expect(current.body).toEqual(first.body);
        expect(current.headers.etag).toBe(first.headers.etag);
        expect(elastic.index).not.toHaveBeenCalled();
        expect(elastic.search).not.toHaveBeenCalled();
      },
    );

    it('compares retries against original input rather than matching updated metadata', async () => {
      const first = await create().expect(201);
      const changed = await request(app.getHttpServer())
        .patch(`${base}/j-1`)
        .set('If-Match', first.headers.etag)
        .send({ status: 'running' })
        .expect(200);
      await request(app.getHttpServer())
        .post(base)
        .send({
          backend_id: 'qa',
          job_id: 'j-1',
          user_id: 'alice',
          process: { process_graph: {} },
          status: 'running',
        })
        .expect(409);
      const replay = await create().expect(201);
      expect(replay.body).toEqual(changed.body);
      expect(replay.headers.etag).toBe(changed.headers.etag);
      expect(elastic.index).toHaveBeenCalledTimes(1);
    });
  });
});
