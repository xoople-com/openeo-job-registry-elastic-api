import { Test, TestingModule } from '@nestjs/testing';
import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { readJobFile } from './utils/io';
import { JobsModule } from '../src/jobs/jobs.module';
import { Job } from '../src/jobs/models/job.dto';
import { sleep } from './utils';
import { Client } from '@elastic/elasticsearch';
import { ConfigService } from '../src/config/config/config.service';

describe('E2E - Jobs', () => {
  let app: INestApplication;
  let esService: Client;
  let configService: ConfigService;

  const jobs: Job[] = [];

  const removeJob = (id: string) => {
    return request(app.getHttpServer()).delete(`/jobs/${id}`).expect(200);
  };

  const searchJobById = (id: string) => {
    return request(app.getHttpServer())
      .post('/jobs/search/paginated')
      .send({
        query: {
          bool: {
            filter: [
              {
                term: {
                  job_id: id,
                },
              },
            ],
          },
        },
      });
  };

  const searchJobByUserId = (id: string) => {
    return request(app.getHttpServer())
      .post('/jobs/search/paginated')
      .send({
        query: {
          bool: {
            filter: [
              {
                term: {
                  user_id: id,
                },
              },
            ],
          },
        },
      });
  };

  beforeAll(() => {
    // Read all the jobs files before starting the tests
    for (const file of ['job1.json', 'job2.json', 'job3.json']) {
      jobs.push(readJobFile(file));
    }
  });

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [JobsModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    esService = moduleFixture.get<Client>(Client);
    configService = moduleFixture.get<ConfigService>(ConfigService);
    await app.init();
  });

  it('Store a job ID', async () => {
    for (const job of jobs) {
      await request(app.getHttpServer())
        .post('/jobs')
        .send(job)
        .expect(201)
        .expect(job);
    }
  });

  it('Should search for the job based on its ID and return it', async () => {
    await searchJobById(jobs[0].job_id)
      .expect(200)
      .expect({
        jobs: [jobs[0]],
        pagination: { previous: null, next: null },
      });
  });

  it('Should remove the job from based on the ID and confirm its removal', async () => {
    await removeJob(jobs[0].job_id);

    await sleep(2000); // Ensure ES was able to store the result

    await searchJobById(jobs[0].job_id).expect(200).expect({
      jobs: [],
      pagination: {},
    });
  }, 10000);

  it('Should search for the job based on the user_id and return all matches except the deleted', async () => {
    await searchJobByUserId(jobs[0].user_id)
      .expect(200)
      .expect({
        jobs: [jobs[2], jobs[1]],
        pagination: { previous: null, next: null },
      });
  });

  it('It should update the second job and verify it by requesting its content', async () => {
    const patchedData = {
      title: 'test',
    };
    const patchedJob = {
      ...jobs[2],
      ...patchedData,
    };

    await request(app.getHttpServer())
      .patch(`/jobs/${jobs[2].job_id}`)
      .send(patchedData)
      .expect(200)
      .expect(patchedJob);

    await sleep(2000); // Ensure ES was able to store the result

    await searchJobById(jobs[2].job_id)
      .expect(200)
      .expect({
        jobs: [patchedJob],
        pagination: { previous: null, next: null },
      });
  }, 10000);

  afterAll(async () => {
    // Execute proper cleanup of the records in the database
    for (const job of jobs) {
      await esService.deleteByQuery({
        query: {
          match: {
            job_id: job.job_id,
          },
        },
        index: configService.get('database.jobsIdx'),
      });
    }
    await app.close();
  });
});
