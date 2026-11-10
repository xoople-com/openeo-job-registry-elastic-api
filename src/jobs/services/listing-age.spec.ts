import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { JobsController } from '../controllers/jobs-v2/jobs-v2.controller';
import { JobRegistryService } from './job-registry.service';
import { JobStore } from '../stores/job-store';
import * as request from 'supertest';

describe('Relative age filters on all listings', () => {
  let app: INestApplication;
  const search = jest.fn();
  const endpoints = [
    { path: 'user', body: { user_id: 'alice' } },
    { path: 'active', body: {} },
    {
      path: 'cleanup-candidates',
      body: { updated_until: '2026-11-09T00:00:00Z' },
    },
  ];

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [JobsController],
      providers: [
        JobRegistryService,
        { provide: JobStore, useValue: { search } },
      ],
    }).compile();
    app = module.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({
        transform: true,
        whitelist: true,
        forbidNonWhitelisted: true,
      }),
    );
    await app.init();
  });

  beforeEach(() => {
    search.mockReset().mockResolvedValue({ jobs: [], next_position: null });
  });

  afterAll(() => app.close());

  it.each(endpoints)(
    'applies optional ages to $path without removing other predicates',
    async ({ path, body }) => {
      await request(app.getHttpServer())
        .post(`/v2/jobs/${path}`)
        .send({ ...body, max_age: 30, max_updated_ago: 0.5 })
        .expect(200);
      const filters = search.mock.calls[0][0].filters;
      expect(
        Date.parse(filters.updated_since) - Date.parse(filters.created_since),
      ).toBe(29.5 * 86400000);
      if (path === 'user') expect(filters.user_ids).toEqual(['alice']);
      if (path === 'cleanup-candidates')
        expect(filters.updated_until).toBe(body.updated_until);
    },
  );

  it.each(endpoints)(
    'keeps ages optional and supports zero on $path',
    async ({ path, body }) => {
      await request(app.getHttpServer())
        .post(`/v2/jobs/${path}`)
        .send(body)
        .expect(200);
      expect(search.mock.calls[0][0].filters.created_since).toBeUndefined();
      expect(search.mock.calls[0][0].filters.updated_since).toBeUndefined();
      await request(app.getHttpServer())
        .post(`/v2/jobs/${path}`)
        .send({ ...body, max_age: 0, max_updated_ago: 0 })
        .expect(200);
      const filters = search.mock.calls[1][0].filters;
      expect(filters.created_since).toEqual(expect.any(String));
      expect(filters.created_since).toBe(filters.updated_since);
    },
  );

  it.each(endpoints)(
    'rejects invalid ages on $path',
    async ({ path, body }) => {
      for (const value of [-1, null, '7', 'Infinity', 1e100]) {
        for (const field of ['max_age', 'max_updated_ago']) {
          await request(app.getHttpServer())
            .post(`/v2/jobs/${path}`)
            .send({ ...body, [field]: value })
            .expect(400);
        }
      }
      expect(search).not.toHaveBeenCalled();
    },
  );
});
