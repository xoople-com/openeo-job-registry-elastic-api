import {
  Job,
  SearchJobs,
  JobContinuation,
  JobPosition,
} from '../models/job.v2.dto';

export interface VersionedJob {
  job: Job;
  etag: string;
}

export interface MutationOptions {
  ifMatch: string | undefined;
}

export interface JobKey {
  job_id: string;
  user_id?: string;
}

export interface JobPage {
  jobs: Partial<Job>[];
  next_page: JobContinuation | null;
}

export interface RegistryState {
  revision: string;
  creationFingerprint?: string;
}

export type JobSource = Job & { deleted?: boolean; _registry?: RegistryState };

export interface StoredJob {
  source: JobSource;
  // Changes on every write, including writes outside the registry service.
  version: string | number;
  concurrencyToken: string;
}

export interface StoredJobPage {
  jobs: Partial<JobSource>[];
  next_position: JobPosition | null;
}

export class JobStoreConflictError extends Error {}
export class JobStoreNotFoundError extends Error {}
export class JobStoreInvalidInputError extends Error {}
export class JobStoreUnavailableError extends Error {}

export abstract class JobStore {
  abstract create(source: JobSource): Promise<StoredJob>;
  abstract get(jobId: string): Promise<StoredJob>;
  abstract replace(
    source: JobSource,
    concurrencyToken: string,
  ): Promise<StoredJob>;
  abstract search(search: SearchJobs): Promise<StoredJobPage>;
}
