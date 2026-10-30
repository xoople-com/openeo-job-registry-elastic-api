import { Test } from '@nestjs/testing';
import { Client } from '@elastic/elasticsearch';
import { Logger } from '@nestjs/common';
import { DatabaseService } from './database.service';
import { ConfigModule } from '../../../config/config.module';
import { JOB } from '../../mocks/job.mock';
import { QUERIES } from '../../mocks/query.mock';
import { UtilsService } from '../../../utils/services/utils/utils.service';

describe('DatabaseService', () => {
  let service: DatabaseService;
  const client = {
    index: jest.fn(),
    update: jest.fn(),
    get: jest.fn(),
    search: jest.fn(),
  };

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [ConfigModule],
      providers: [
        DatabaseService,
        Logger,
        { provide: Client, useValue: client },
      ],
    }).compile();
    service = module.get(DatabaseService);
  });

  afterEach(() => jest.restoreAllMocks());
  afterEach(() => jest.resetAllMocks());

  it('stores the existing job document and preserves the response', async () => {
    client.index.mockResolvedValue({ result: 'created' });
    expect(await service.saveJobs(JOB)).toEqual(JOB);
    expect(client.index).toHaveBeenCalledWith({
      index: 'openeo-jobs-dev',
      document: JOB,
    });
  });

  it('surfaces failed writes without leaking transport credentials', async () => {
    client.index.mockRejectedValue(new Error('Authorization: ApiKey secret'));
    await expect(service.saveJobs(JOB)).rejects.toThrow(
      'Could not store jobs in database: Elasticsearch request failed',
    );
    client.index.mockResolvedValue({ result: 'noop' });
    await expect(service.saveJobs(JOB)).rejects.toThrow();
  });

  it('patches and returns the original job response shape', async () => {
    client.update.mockResolvedValue({ result: 'updated' });
    client.get.mockResolvedValue({ _source: JOB });
    expect(await service.patchJob('document-id', JOB)).toEqual(JOB);
    expect(client.update).toHaveBeenCalledWith({
      index: 'openeo-jobs-dev',
      id: 'document-id',
      doc: JOB,
    });
  });

  it('surfaces failed updates', async () => {
    client.update.mockRejectedValue(new Error('request with credentials'));
    await expect(service.patchJob('document-id', JOB)).rejects.toThrow(
      'Could not update jobs in database: Elasticsearch request failed',
    );
  });

  it('preserves query filters and pagination without restricted _id sorting', async () => {
    client.search.mockResolvedValue({
      hits: { hits: [{ _id: 'doc', _source: JOB }] },
    });
    const result = await service.executeJobQuery(QUERIES[1].input, 1, 1);
    expect(result).toEqual({
      jobs: [JOB],
      pagination: {
        previous: { size: 1, page: 0 },
        next: { size: 1, page: 2 },
      },
    });
    expect(client.search).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 1,
        size: 1,
        body: service.addDeletedFilter(QUERIES[1].input),
        sort: ['created:desc', 'job_id:asc', 'backend_id:asc'],
      }),
    );
    expect(
      await service.executeJobQuery(QUERIES[1].input, 0, 10, true, true),
    ).toEqual({ jobs: ['doc'], pagination: { previous: null, next: null } });
    expect(client.search).toHaveBeenLastCalledWith(
      expect.objectContaining({
        body: QUERIES[1].input,
      }),
    );
  });

  it('rejects empty queries and surfaces connection errors', async () => {
    await expect(service.executeJobQuery({})).rejects.toThrow('empty query');
    client.search.mockRejectedValue(new Error('connection failed'));
    await expect(service.queryJobs(QUERIES[1].input)).rejects.toThrow(
      'Elasticsearch request failed',
    );
  });

  it('returns matching document IDs and retries missing jobs', async () => {
    client.search.mockResolvedValue({
      hits: { hits: [{ _id: 'doc', _source: JOB }] },
    });
    expect(await service.getJobDocId(JOB.job_id)).toBe('doc');
    expect(client.search).toHaveBeenCalledTimes(1);
    client.search.mockClear();
    client.search.mockResolvedValue({ hits: { hits: [] } });
    jest.spyOn(UtilsService, 'sleep').mockResolvedValue();
    expect(await service.getJobDocId('missing')).toBeUndefined();
    expect(client.search).toHaveBeenCalledTimes(5);
  });

  it('preserves all existing deletion filter cases', () => {
    for (const query of QUERIES) {
      expect(service.addDeletedFilter(query.input)).toEqual(query.output);
    }
  });
});
