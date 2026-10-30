import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Client } from '@elastic/elasticsearch';
import * as request from 'supertest';
import { JobsModule } from '../src/jobs/jobs.module';
import { JOB } from '../src/jobs/mocks/job.mock';
import * as definition from '../src/jobs/services/database/config/index_create.json';

jest.setTimeout(30000);

// Run only against an approved disposable test cluster, never a production registry.
describe('Elasticsearch 9 contract', () => {
  let app: INestApplication;
  let client: Client;
  const index = `ejr-test-${Date.now()}`;
  const previousIndex = process.env.DB_JOBS_IDX;

  beforeAll(async () => {
    process.env.DB_JOBS_IDX = index;
    const module = await Test.createTestingModule({
      imports: [JobsModule],
    }).compile();
    app = module.createNestApplication();
    client = module.get(Client);
    const info = await client.info();
    expect(info.version.number.split('.')[0]).toBe('9');
    await client.transport.request({
      method: 'PUT',
      path: `/${index}`,
      body: { mappings: definition.mappings, settings: definition.settings },
    });
    await app.init();
  });

  afterAll(async () => {
    try {
      if (client && (await client.indices.exists({ index }))) {
        await client.indices.delete({ index });
      }
    } finally {
      if (app) await app.close();
      if (previousIndex === undefined) delete process.env.DB_JOBS_IDX;
      else process.env.DB_JOBS_IDX = previousIndex;
    }
  });

  it('creates, searches, paginates, patches and soft-deletes without _id fielddata', async () => {
    const second = { ...JOB, job_id: `${JOB.job_id}-second` };
    await request(app.getHttpServer())
      .post('/jobs')
      .send(JOB)
      .expect(201)
      .expect(JOB);
    await request(app.getHttpServer())
      .post('/jobs')
      .send(second)
      .expect(201)
      .expect(second);
    await client.indices.refresh({ index });
    const query = {
      query: {
        bool: { filter: [{ term: { backend_id: JOB.backend_id } }] },
      },
    };
    await request(app.getHttpServer())
      .post('/jobs/search/paginated?size=1&page=0')
      .send(query)
      .expect(200)
      .expect({
        jobs: [JOB],
        pagination: { previous: null, next: { size: 1, page: 1 } },
      });
    await request(app.getHttpServer())
      .post('/jobs/search/paginated?size=1&page=1')
      .send(query)
      .expect(200)
      .expect({
        jobs: [second],
        pagination: {
          previous: { size: 1, page: 0 },
          next: { size: 1, page: 2 },
        },
      });
    await request(app.getHttpServer())
      .patch(`/jobs/${JOB.job_id}`)
      .send({ title: 'updated' })
      .expect(200)
      .expect({ ...JOB, title: 'updated' });
    await client.indices.refresh({ index });
    await request(app.getHttpServer())
      .delete(`/jobs/${JOB.job_id}`)
      .expect(200);
    await client.indices.refresh({ index });
    const result = await client.search({
      index,
      query: { term: { deleted: true } },
    });
    expect(result.hits.hits).toHaveLength(1);
    await request(app.getHttpServer())
      .post('/jobs/search/paginated?size=10')
      .send(query)
      .expect(200)
      .expect({
        jobs: [second],
        pagination: { previous: null, next: null },
      });
  });
});
