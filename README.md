# openEO Elasticsearch job registry API

NestJS API for persistent openEO job metadata. Result assets and application logs
are stored separately. Existing job endpoints and response shapes are retained.

## Development

Use Node.js 24 LTS and the committed dependency lockfile:

```sh
npm ci
npm run build
npm run start:prod
npm test -- --runInBand
npm run test:cov -- --runInBand
```

For development, `npm run start:dev` enables watch mode.

## Azure / AKS configuration

The Azure mode validates Entra application access tokens locally using trusted
OIDC discovery and rotating signing keys. It does not use token introspection or
require an API-side client secret.

Example non-secret QA configuration:

```sh
AUTH_TYPE=entra
ENTRA_ISSUER=https://login.microsoftonline.com/8f0cef0d-4bae-4451-bc81-9b45fc92d79d/v2.0
ENTRA_AUDIENCE=4228c6e7-d99d-4ef2-8739-cb0ad724da43
ENTRA_ROLES=JobRegistry.Access
ENTRA_CLIENT_IDS=e0d2c71d-ec17-46b0-aacb-6b169f2aaa17
DB_HOSTS=https://<approved-private-elasticsearch-host>:9243
DB_JOBS_IDX=openeo-jobs-qa
PORT=3000
LOG_LEVEL=info
```

Supply `DB_API_KEY` from an approved Kubernetes Secret / Key Vault delivery path.
Its value is the **encoded** Elasticsearch data-plane API key, not an Elastic
Cloud control-plane key or an Azure access token. Do not put credentials in
`DB_HOSTS`, command arguments, configuration committed to Git, or log output.
API-key authentication requires HTTPS for every host; certificate verification
cannot be disabled. Publicly trusted certificates use Node's default trusted CA
bundle; `DB_CA_FILE` optionally points to a mounted PEM CA bundle.

`ENTRA_AUDIENCE` must match the actual access-token `aud` claim. For Entra v2 this
is normally the API application UUID, **not** its `api://...` Application ID URI
or the caller's `.default` scope. Configure the API registration to issue v2
access tokens. Issuer and audience are exact matches.

The validator accepts only RS256 signatures, checks issuer/audience/expiry and
not-before, requires `exp`, `iat` and `sub`, and requires both:

- an `azp` caller in `ENTRA_CLIENT_IDS`;
- at least one configured application role in the top-level `roles` claim.

Delegated tokens (`scp` present), v1 tokens, other tenants and other callers are
rejected. Invalid tokens return 401; caller/role denial returns 403. Signing-key
infrastructure failures return 503. JWT authorization is evaluated on every
request, without caching a successful authorization beyond token expiry.
Remote signing keys are cached and refreshed on unknown key IDs, with a
30-second refresh cooldown and a 5-second fetch timeout. Discovery failure
prevents startup; there is no anonymous or introspection fallback.

### Caller responsibilities

The backend and tracker must request
`api://4228c6e7-d99d-4ef2-8739-cb0ad724da43/.default` using their explicitly selected
caller application and a renewable AKS federated assertion. Configure the actual
AKS issuer and service-account subject in that application's federation.
Do not replace the backend's existing Blob managed-identity annotation.
Caller assertion/scope support belongs in the backend/client repository and is
not implemented by this API.

### Existing introspection deployments

`AUTH_TYPE=bearer` remains the default. It uses `OIDC_ISSUER`, `OIDC_CLIENT_ID`,
`OIDC_CLIENT_SECRET` and optional comma-separated `AUTH_ROLES` checked against
`realm_access.roles`. Select `AUTH_TYPE=entra` explicitly for Azure. The Entra
role/caller checks cannot be disabled by leaving their configuration empty.

## Elasticsearch compatibility and index setup

This branch targets **Elasticsearch 9.5.1 or later 9.x**, using the official
JavaScript client `~9.5.1`. It replaces the 7.17 client; Elasticsearch 7/8 are
not supported by this branch. Elastic Cloud had **not been provisioned** when
this branch was prepared. There is no observed deployed server version; confirm
the offer-created version before deploying. If it differs from this compatibility
target, resolve and test the client/server combination rather than assuming it
works or provisioning an obsolete server.

The index is deliberately **not created or migrated by the API**. An operator
with bootstrap privileges must create the environment-specific index using
[`index_create.json`](src/jobs/services/database/config/index_create.json).
Replace/remove the example `openeo-jobs-dev` alias before applying it to QA.
Preserve the mappings, especially keyword `job_id`/`backend_id`, date `created`
and boolean `deleted`. Do not rely on dynamic index auto-creation: the mapping
has `dynamic: false`.

Use a separate runtime API key limited to the configured index, with `read` and
`write` index privileges and **no cluster or index-creation privileges**.
Readiness performs a size-zero index search with this same authenticated client,
not an unauthenticated cluster-health request. Verify the exact privileges with
the provisioned server. Bootstrap/index lifecycle administration uses a separate
identity; never give administrator credentials to the application.

Searches preserve the existing filters, offset pagination, document IDs and
response shapes. Results are ordered by `created:desc`, then keyword
`job_id:asc` and `backend_id:asc`. The tie ordering intentionally replaces
`_id` sorting, which modern Elasticsearch restricts; no fielddata override or
document-model migration is needed. Jobs must have unique job/backend identities;
duplicate records are not repaired by this change.

Connection/write failures are surfaced, without serializing transport objects
that might contain authorization headers. Request logging redacts authorization
and cookie headers and omits query strings (legacy bearer authentication also
accepts query tokens). No credentials or access tokens should appear in logs.

### Compatibility tests

Unit tests include real RSA-signed JWTs, signing-key rotation, HTTP guard/probe
contracts and Elasticsearch client/configuration/error contracts.

CI additionally runs the following against a disposable Elasticsearch 9.5.1
service and builds the image:

```sh
DB_HOSTS=http://localhost:9200 npm run test:e2e -- --runInBand elastic-cloud.e2e-spec.ts
```

This suite creates and deletes a uniquely named `ejr-test-*` index and exercises
index mappings, create/search/pagination/patch/soft-delete operations with modern
`_id` restrictions. Run it only against an approved **disposable test cluster**
using a bootstrap credential. It is not a production health check.
The older e2e suites still require their separately configured OIDC/Elastic
fixtures. Unit tests require neither Azure credentials nor an external database.

## Container and AKS health probes

The multi-stage image uses Node.js 24, lockfile-based installs, production-only
runtime dependencies and the non-root `node` user. It listens on port 3000 by
default and supports graceful shutdown.

```sh
docker build -t ejr:azure .
```

The application still serves HTTP. Terminate trusted internal HTTPS at an
approved TLS proxy / chart-supported TLS layer; an internal Service alone does
not encrypt traffic. Arrange issuance, renewal and client trust separately.
Do not expose a public ingress or bypass TLS verification.

Configure probes on the internal application port:

| Purpose | Endpoint | Behaviour |
|---|---|---|
| Startup / liveness | `/health/live` | Process-only check, no Elastic or Entra request |
| Readiness | `/health/ready` | Authenticated index read; 503 when unavailable |
| Existing diagnostic | `/health` | Elastic plus supplied bearer-token status |

The new probes need no bearer token and are exempt from throttling. Keep their
network exposure internal. Set `HEALTH_ES_TIMEOUT` (milliseconds; default 500)
and Kubernetes probe timeouts/thresholds to suit private-network latency.
Entra discovery is performed during startup; allow enough startup time for it.
An Elastic outage removes readiness but does not cause a liveness restart loop.

## Remaining rollout gates

These source changes do not provision resources, purchase Elastic, distribute
secrets, deploy Helm releases, or prove live Azure compatibility. Before enabling
consumers, verify:

- actual Hosted version, image source/digest, index mappings and runtime-key privileges;
- InfraOps private endpoint approval, Elastic access policy, private DNS/routing,
  TLS trust and rejection of unapproved public access;
- actual Entra token `iss`/`aud`/`roles`/`azp`, app-role assignment, AKS assertion
  renewal, access-token reacquisition and caller/client compatibility;
- internal API HTTPS, readiness/liveness, credential and certificate rotation;
- snapshots/restore, retention and the broader batch/result-storage rollout gates.

No live Azure acceptance is implied by passing local or CI tests.
