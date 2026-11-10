import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsISO8601,
  IsNotEmpty,
  IsNumber,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Matches,
  Min,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';

export const JOB_STATUSES = [
  'created',
  'queued',
  'running',
  'finished',
  'error',
  'canceled',
] as const;
export type JobStatus = typeof JOB_STATUSES[number];

export const DEPENDENCY_STATUSES = [
  'awaiting',
  'available',
  'awaiting_retry',
  'error',
] as const;
export type DependencyStatus = typeof DEPENDENCY_STATUSES[number];

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonObject
  | JsonValue[];
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface ResultsMetadata extends JsonObject {
  geometry?: JsonObject | null;
  bbox?: number[] | null;
  start_datetime?: string | null;
  end_datetime?: string | null;
  instruments?: string[] | null;
  epsg?: number | null;
  links?: JsonObject[] | null;
  'proj:shape'?: number[] | null;
  'proj:bbox'?: number[] | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isProcess(value: unknown): boolean {
  if (isObject(value)) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  try {
    return isObject(JSON.parse(value));
  } catch {
    return false;
  }
}

export class JobMetadata {
  @ApiPropertyOptional({ enum: [...JOB_STATUSES] })
  @ValidateIf((_, value) => value !== undefined)
  @IsIn(JOB_STATUSES)
  status?: JobStatus;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  title?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  description?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  api_version?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  application_id?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  proxy_user?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  infra_id?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  oidc_issuer?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsDateString()
  created?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsDateString()
  updated?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsDateString()
  started?: string | null;

  @ApiPropertyOptional({ format: 'date-time', nullable: true })
  @IsOptional()
  @IsDateString()
  finished?: string | null;

  @ApiPropertyOptional({
    type: 'array',
    items: { type: 'object', additionalProperties: { type: 'string' } },
    nullable: true,
  })
  @IsOptional()
  @IsArray()
  @ValidateBy(
    {
      name: 'isDependency',
      validator: {
        validate: (value: unknown) =>
          isObject(value) &&
          Object.values(value).every((item) => typeof item === 'string'),
        defaultMessage: () => 'dependencies must contain string-valued objects',
      },
    },
    { each: true },
  )
  dependencies?: Record<string, string>[] | null;

  @ApiPropertyOptional({ enum: [...DEPENDENCY_STATUSES], nullable: true })
  @IsOptional()
  @IsIn(DEPENDENCY_STATUSES)
  dependency_status?: DependencyStatus | null;

  @ApiPropertyOptional({
    type: String,
    description:
      'Decimal encoded as a string, without conversion to a JSON number',
    nullable: true,
  })
  @IsOptional()
  @IsString()
  @Matches(/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/)
  dependency_usage?: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  usage?: JsonObject | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber()
  costs?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber()
  input_pixel?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber()
  cpu_time_seconds?: number | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsNumber()
  memory_time_megabyte_seconds?: number | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    description: 'Inline results metadata consumed by ejr_job_info_to_metadata',
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  results_metadata?: ResultsMetadata | null;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  results_metadata_uri?: string | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  links?: string[] | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  assets?: JsonObject | null;

  @ApiPropertyOptional({ type: [String], nullable: true })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  unique_process_ids?: string[] | null;
}

export class Job extends JobMetadata {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  job_id: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  backend_id: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  user_id: string;

  @ApiPropertyOptional({ nullable: true })
  @IsOptional()
  @IsString()
  parent_id?: string | null;

  @ApiPropertyOptional({
    oneOf: [{ type: 'object', additionalProperties: true }, { type: 'string' }],
    description: 'Process dictionary or its JSON-object serialization',
    nullable: true,
  })
  @IsOptional()
  @ValidateBy({
    name: 'isProcess',
    validator: {
      validate: isProcess,
      defaultMessage: () =>
        'process must be an object or a JSON-encoded object',
    },
  })
  process?: JsonObject | string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
  })
  @IsOptional()
  @IsObject()
  job_options?: JsonObject | null;
}

export const JOB_FIELDS: (keyof Job)[] = [
  'job_id',
  'backend_id',
  'user_id',
  'parent_id',
  'process',
  'job_options',
  'proxy_user',
  'status',
  'api_version',
  'application_id',
  'created',
  'updated',
  'started',
  'finished',
  'title',
  'description',
  'dependencies',
  'dependency_status',
  'dependency_usage',
  'links',
  'assets',
  'unique_process_ids',
  'usage',
  'results_metadata',
  'results_metadata_uri',
  'input_pixel',
  'costs',
  'infra_id',
  'oidc_issuer',
  'cpu_time_seconds',
  'memory_time_megabyte_seconds',
];

export class JobScope {
  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  user_id?: string;
}

export class CreateJob extends Job {}

export class UpdateJob extends JobMetadata {}

export class JobFilters {
  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  backend_id?: string;

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  job_id?: string;

  @ApiPropertyOptional({ type: [String] })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  user_ids?: string[];

  @ApiPropertyOptional({ enum: [...JOB_STATUSES], isArray: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(JOB_STATUSES.length)
  @ArrayUnique()
  @IsIn(JOB_STATUSES, { each: true })
  statuses?: string[];

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  infra_id?: string;

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsBoolean()
  has_application_id?: boolean;

  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf((_, value) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  created_since?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf((_, value) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  created_until?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf((_, value) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  updated_since?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @ValidateIf((_, value) => value !== undefined)
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  updated_until?: string;
}

export class SearchJobs {
  @ApiPropertyOptional({ type: JobFilters })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => JobFilters)
  filters?: JobFilters;

  @ApiPropertyOptional({ enum: JOB_FIELDS, isArray: true })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(JOB_FIELDS.length)
  @ArrayUnique()
  @IsIn(JOB_FIELDS, { each: true })
  fields?: (keyof Job)[];

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 1000 })
  @IsInt()
  @Min(1)
  @Max(1000)
  limit = 100;

  position?: JobPosition;
}

export class JobPosition {
  @ApiProperty({
    nullable: true,
    description:
      'Creation timestamp in Unix milliseconds; null for missing timestamps',
  })
  @ValidateIf((_, value) => value !== null)
  @IsNumber()
  created: number | null;

  @ApiProperty({
    nullable: true,
    description: 'Tie-breaking job ID; null for missing IDs',
  })
  @ValidateIf((_, value) => value !== null)
  @IsString()
  job_id: string | null;
}

export class JobContinuation {
  @ApiProperty({
    format: 'date-time',
    description: 'Reference time frozen on the first page',
  })
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  as_of: string;

  @ApiProperty({
    description: 'Hash binding this continuation to its listing parameters',
  })
  @IsString()
  @Matches(/^[a-f0-9]{64}$/)
  fingerprint: string;

  @ApiProperty({ type: JobPosition })
  @IsObject()
  @ValidateNested()
  @Type(() => JobPosition)
  position: JobPosition;
}

export class ListJobs {
  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  backend_id?: string;

  @ApiPropertyOptional({
    enum: JOB_FIELDS,
    isArray: true,
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(JOB_FIELDS.length)
  @ArrayUnique()
  @IsIn(JOB_FIELDS, { each: true })
  fields?: (keyof Job)[];

  @ApiPropertyOptional({ default: 100, minimum: 1, maximum: 1000 })
  @IsInt()
  @Min(1)
  @Max(1000)
  limit = 100;

  @ApiPropertyOptional({ type: JobContinuation })
  @ValidateIf((_, value) => value !== undefined)
  @IsObject()
  @ValidateNested()
  @Type(() => JobContinuation)
  next_page?: JobContinuation;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Maximum creation age in days; zero means now',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsNumber()
  @Min(0)
  max_age?: number;

  @ApiPropertyOptional({
    minimum: 0,
    description: 'Maximum time since update in days; zero means now',
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsNumber()
  @Min(0)
  max_updated_ago?: number;
}

export class ListUserJobs extends ListJobs {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  user_id: string;
}

export class ListActiveJobs extends ListJobs {
  @ApiPropertyOptional({ default: false })
  @IsBoolean()
  require_application_id = false;

  @ApiPropertyOptional()
  @ValidateIf((_, value) => value !== undefined)
  @IsString()
  @IsNotEmpty()
  infra_id?: string;
}

export class ListCleanupCandidates extends ListJobs {
  @ApiProperty({
    format: 'date-time',
    description: 'Inclusive updated-time cutoff, not started time',
  })
  @IsISO8601({ strict: true })
  @Matches(/T.*(?:Z|[+-]\d{2}:\d{2})$/)
  updated_until: string;

  @ApiPropertyOptional({
    type: [String],
  })
  @ValidateIf((_, value) => value !== undefined)
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(1000)
  @ArrayUnique()
  @IsString({ each: true })
  @IsNotEmpty({ each: true })
  user_ids?: string[];
}
