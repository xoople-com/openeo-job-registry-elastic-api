import * as convict from 'convict';
import { AuthType } from '../../auth/models/authtypes.enum';

export interface AppConfig {
  port: number;
}

export const schema: convict.Schema<AppConfig> = {
  general: {
    port: {
      doc: 'Port that is used to bind the API',
      format: 'port',
      default: 3000,
      env: 'PORT',
      arg: 'port',
    },
    loglevel: {
      doc: 'Set the log level',
      format: 'String',
      default: 'error',
      env: 'LOG_LEVEL',
      arg: 'loglevel',
    },
    pretty: {
      doc: 'Enable pretty logging',
      format: 'Boolean',
      default: false,
      env: 'PRETTY',
      arg: 'pretty',
    },
  },
  auth: {
    type: {
      doc: 'Authentication type to use within the API',
      format: Object.values(AuthType),
      default: AuthType.BEARER,
      env: 'AUTH_TYPE',
      arg: 'auth_type',
    },
    roles: {
      doc: 'Comma separated list of roles. If set, the token must contain at least one of them in realm_access.roles. Empty disables the role check',
      format: 'String',
      default: '',
      env: 'AUTH_ROLES',
      arg: 'auth_roles',
    },
    oidc: {
      issuer: {
        doc: 'OIDC issuer URL',
        format: 'String',
        env: 'OIDC_ISSUER',
        default: 'https://example.com',
        arg: 'oidc_issuer',
      },
      clientId: {
        doc: 'OpenID Connect Client ID',
        format: '*',
        env: 'OIDC_CLIENT_ID',
        default: 'client_id',
        arg: 'oidc_client_id',
      },
      clientSecret: {
        doc: 'OpenID Connect Client Secret',
        format: '*',
        env: 'OIDC_CLIENT_SECRET',
        default: 'client_secret',
        arg: 'oidc_client_secret',
        sensitive: true,
      },
    },
    entra: {
      issuer: {
        doc: 'Tenant-specific Entra v2 access-token issuer',
        format: 'String',
        default: '',
        env: 'ENTRA_ISSUER',
      },
      audience: {
        doc: 'Exact access-token audience (normally the API application UUID for v2 tokens)',
        format: 'String',
        default: '',
        env: 'ENTRA_AUDIENCE',
      },
      roles: {
        doc: 'Comma separated application roles; at least one must be present',
        format: 'String',
        default: 'JobRegistry.Access',
        env: 'ENTRA_ROLES',
      },
      clientIds: {
        doc: 'Comma separated allowed caller application IDs (azp claim)',
        format: 'String',
        default: '',
        env: 'ENTRA_CLIENT_IDS',
      },
    },
  },
  database: {
    hosts: {
      doc: 'Comma seperated value list of elasticsearch hosts to use',
      format: '*',
      default: 'http://localhost:9200,http://localhost:9201',
      env: 'DB_HOSTS',
      arg: 'db_hosts',
    },
    jobsIdx: {
      doc: 'Name of the ElasticSearch index that will be used to store the job information',
      format: '*',
      default: 'openeo-jobs-dev',
      env: 'DB_JOBS_IDX',
      arg: 'db_jobs_idx',
    },
    maxResults: {
      doc: 'Max results to return for query',
      format: 'Number',
      default: 1000,
      env: 'DB_MAX_RESULTS',
      arg: 'db_max_results',
    },
    apiKey: {
      doc: 'Encoded Elasticsearch API key; requires HTTPS hosts',
      format: 'String',
      default: '',
      env: 'DB_API_KEY',
      sensitive: true,
    },
    caFile: {
      doc: 'Optional PEM CA bundle path for Elasticsearch TLS',
      format: 'String',
      default: '',
      env: 'DB_CA_FILE',
    },
  },
  cache: {
    ttl: {
      doc: 'TTL in milliseconds for caching the results',
      format: 'Number',
      default: 5000,
      env: 'CACHE_TTL',
      arg: 'cache_ttl',
    },
    max: {
      doc: 'Maximum number of results to store in cache',
      format: 'Number',
      default: 100,
      env: 'CACHE_MAX_ENTRIES',
      arg: 'cache_max_entries',
    },
  },
  throttle: {
    ttl: {
      doc: 'TTL in milliseconds for throttling the requests',
      format: 'Number',
      default: 60000,
      env: 'THROTTLE_TTL',
      arg: 'throttle_ttl',
    },
    limit: {
      doc: 'Limit for throttling the requests',
      format: 'Number',
      default: 1000,
      env: 'THROTTLE_LIMIT',
      arg: 'throttle_limit',
    },
  },
  health: {
    es: {
      timeout: {
        doc: 'Timeout in milliseconds for ES health checks',
        format: 'Number',
        default: 500,
        env: 'HEALTH_ES_TIMEOUT',
        arg: 'health_es_teimout',
      },
    },
  },
};
