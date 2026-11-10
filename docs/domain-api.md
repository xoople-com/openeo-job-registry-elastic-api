# Backend-neutral job registry API

## Decision and implementation scope

Keep the existing `/jobs` API unchanged and add an independent domain contract at
`/v2/jobs`. Both run in the same service over the same
Elasticsearch index. The caller selects the contract by URL, not by guessing a
request body's format. There is no automatic fallback between contracts.
The former experimental `/backends/{backend_id}/jobs` routes are replaced,
not retained as aliases. Domain clients must use the flat routes, send
`backend_id` in creation bodies, and explicitly filter listings when needed.
The experimental `POST /v2/jobs/search` is also removed in favor of dedicated
POST listings with JSON bodies. Legacy `/jobs/search` and `/jobs/search/paginated`
are unchanged. Earlier experimental GET listings and encoded cursors are not
retained as aliases.

The v2 controller depends on `JobRegistryService`, which applies shared domain
rules and delegates persistence to `JobStore`. Nest injects
`ElasticsearchJobStore` initially. A later SQL/document-store implementation must
implement the same atomic persistence interface and contract tests; it must not accept ES DSL.
No second storage engine, database migration, Python client implementation or
deployment configuration change is included in this initial implementation.

The existing API is already mostly domain-shaped on writes and responses. Its
main storage coupling is arbitrary search requests (`query`, `_source`, ES
operators). Preserve job field names and JSON metadata instead of inventing a
replacement job model or a general-purpose query language.

## Architecture and selection

```text
Existing ElasticJobRegistry client -> /jobs -> existing DatabaseService -> ES
New domain client -> /v2/jobs -> JobRegistryService -> JobStore -> ES adapter
                                                              -> future adapter
```

`JobRegistryService` owns canonical creation fingerprints, duplicate-input
comparison, defaults, revisions, ETags, optional user scope, conditional-write
policy, shallow patching, soft deletion, listing semantics, frozen age cutoffs
and public response
sanitization. These rules are not reimplemented by each adapter.

`JobStore` provides only:
- `create(source)`: atomically create if absent; conflict if the ID is reserved.
- `get(jobId)`: read the source, including private metadata and tombstones.
- `replace(source, concurrencyToken)`: atomically replace only the read version.
- `search(search)`: translate typed filters/projection/pagination, excluding
  tombstones. Positions use the shared creation-time/job-ID ordering.

Reads and writes return a `StoredJob` with source, an opaque storage version
(string or number), and an opaque concurrency token. The version must change on
every write, including legacy/external writes that restore identical content.
The service hashes it into the ETag but never interprets or increments it.
The token is passed unchanged to `replace`. Adapters must enforce it at write
time: a service-side read/check followed by an unconditional write is not safe.
Writes return the actual committed version, not a predicted version or a later
reread that could observe another writer.

The ES adapter uses `_version` as the storage version and encodes sequence number
and primary term into its private concurrency token. An SQL adapter could use a
row version and conditional `UPDATE`; neither leaks engine-specific fields into
the public contract. ES document-ID limits and transport-error translation stay
in the ES adapter. Adapters log unexpected failures without credentials and
raise storage-neutral conflict/not-found/invalid-input/unavailable errors.
The service maps them to the existing HTTP behavior.

Both paths remain available, with unchanged global authentication and throttling.
The new paths are not anonymous. Backend filters and user scope are data-selection constraints,
not a new authorization system: the existing machine-to-machine trust model
remains in force. A caller-supplied user ID is not proof of end-user identity.

For a future Python integration, implement a `DomainJobRegistry` alongside
`ElasticJobRegistry`, both satisfying `JobRegistryInterface`. Backend and tracker
construction should explicitly select `legacy` (default) or `domain`; both
consumers must use the same backend ID. Unknown selections must fail startup.
The new Python client should pass day-count age limits to the active listing
and iterate all pages, not silently take the first page. The server freezes
the cutoffs in the first-page continuation; clients resend unchanged parameters.
This server change does not make an unmodified openEO client use v2.

Storage selection is separate from API selection. Replacing the `JobStore` DI
binding changes only v2. The arbitrary legacy ES contract still needs ES; do not
pretend a future SQL adapter can support every existing raw ES query. Legacy
endpoints must remain on ES until their users migrate. Moving data between stores
needs a separate consistency/cutover plan; do not add uncoordinated dual writes.

## HTTP contract

| Method and suffix relative to the v2 base | Request | Success |
|---|---|---|
| `POST /` | Job fields; `job_id`, `backend_id` and `user_id` required | 201, full job |
| `GET /{job_id}` | Optional `user_id` query parameter | 200, full job and strong `ETag` |
| `PATCH /{job_id}` | Driver-based `JobMetadata` fields; required `If-Match`, optional `user_id` | 200, full job and new `ETag` |
| `DELETE /{job_id}` | Required `If-Match`, optional `user_id` | 204, no body |
| `POST /user` | JSON: required `user_id`, common listing fields | 200, job page |
| `POST /active` | JSON: active-job fields below | 200, job page |
| `POST /cleanup-candidates` | JSON: required `updated_until`, optional `user_ids`, common fields | 200, job page |

`backend_id` comes from the creation body and remains immutable. Retrieval and
mutations use the globally unique job ID, with optional user scope, not a backend
path parameter. Listings optionally accept `backend_id`; omitting it
lists across backends. This is intentional cross-backend access under the
existing trusted service authorization model, not end-user isolation.
Create defaults `status` to
`created`, and `created`/`updated` to current UTC time if absent. Patch sets
`updated` to current UTC time if absent. Supplied timestamps remain supported.
Updates are shallow field replacements; JSON metadata is not recursively merged.
Omitted fields are unchanged; `null` clears nullable metadata fields, including
dependencies and dependency status. Status cannot be null. Empty patches, identity
changes, raw ES fields and unknown properties are rejected.

Keep all existing metadata capabilities: process and job options at creation;
application ID, proxy user, dependencies, status/timestamps, infrastructure ID,
result metadata URI, legacy inline result metadata, assets, usage and costs.
As with the legacy API, the caller computes costs and `input_pixel`; the registry
stores them and does not infer billing from usage. Assets/log files themselves
remain in external storage. V2 uses an independent driver-based model rather than
inheriting the loosely typed legacy DTO. Legacy `/jobs` validation is unchanged.

### Driver-based job model

The supplied `JobRegistryInterface`, `ElasticJobRegistry` setters and
`ejr_job_info_to_metadata` define the v2 field names and types. `Job` is the
stored/returned job, `CreateJob` includes the required backend ID, and `UpdateJob`
contains only mutable metadata. `JobStore` and the ES adapter use these v2 types.

| Fields | Representation |
|---|---|
| `job_id`, `backend_id`, `user_id` | Non-empty strings; immutable identity |
| `process` | JSON object or a JSON-encoded object from `preserialize_process` |
| `job_options` | JSON object or null |
| `parent_id`, `title`, `description`, `api_version` | Strings or null |
| `status` | The six `JOB_STATUS` values, never null |
| `created`, `updated`, `started`, `finished` | ISO-8601 timestamp strings or null |
| `application_id`, `proxy_user`, `infra_id` | Strings or null |
| `dependencies` | Array of string-valued dictionaries, or null |
| `dependency_status` | `awaiting`, `available`, `awaiting_retry`, `error`, or null |
| `dependency_usage` | Decimal string (including scientific notation) or null |
| `usage` | Extensible JSON dictionary or null |
| `costs`, `input_pixel` | Finite JSON numbers or null |
| `cpu_time_seconds`, `memory_time_megabyte_seconds` | Finite numeric durations or null |
| `results_metadata` | Extensible results dictionary or null |
| `results_metadata_uri` | String or null; no HTTP-only restriction |

Preserve decimal strings verbatim instead of coercing through floating point.
Dependency removal still writes both `dependencies: null` and
`dependency_status: null`. Usage and inline result dictionaries retain unknown
nested keys without stripping them.

`ResultsMetadata` describes the fields consumed by the converter: `geometry`,
`bbox`, `start_datetime`, `end_datetime`, `instruments`, `epsg`, `links`,
`proj:shape`, `proj:bbox`. It also permits additional JSON keys. Runtime validation
checks the dictionary container, not a closed STAC schema. The two duration fields
remain top-level, as the converter expects, and can be requested in projections.
They need no index mapping migration because this API only stores/projects them;
the existing `dynamic: false` mapping retains unindexed fields in `_source`.

The Python `PARTIAL_JOB_STATUS` is a derived view, not another stored status field.
Spatial/result fields stay nested under `results_metadata`; do not flatten them
into the registry job or rename `job_id` to the public API's `id`.
For compatibility, the pre-existing extension fields `oidc_issuer`, `links`,
`assets`, and `unique_process_ids` remain supported. They are not inferred from
the supplied registry interface.

Creation requires `job_id`, `backend_id` and `user_id` and permits omission of
`process`. It does not generate an ID as
the Python method does. Creation defaults and explicit status/timestamp support
remain unchanged. A future client is responsible for Python-specific defaults,
base-field projection and `input_pixel` derivation; these are not silently added
to the server model. Legacy serialized processes are stored/returned unchanged;
the Python client's existing deserializer can turn them back into objects.

### Dedicated listings

```http
POST /v2/jobs/active
Content-Type: application/json

{
  "backend_id": "qa",
  "max_age": 30,
  "max_updated_ago": 7,
  "require_application_id": true,
  "infra_id": "aks-qa",
  "fields": ["job_id", "user_id", "application_id", "status"],
  "limit": 100
}
```

```json
{
  "jobs": [
    {
      "job_id": "j-1",
      "user_id": "alice",
      "application_id": "spark-1",
      "status": "running"
    }
  ],
  "next_page": null
}
```

| Common JSON body field | Meaning |
|---|---|
| `backend_id` | Optional exact backend; omit for cross-backend listings |
| `fields` | Optional JSON array of allowlisted top-level field names |
| `limit` | Integer 1-1000, default 100 |
| `max_age` | Optional maximum creation age in days |
| `max_updated_ago` | Optional maximum time since last update in days |
| `next_page` | Previous response's structured continuation; omit on the first request |

`POST /v2/jobs/user` requires one non-empty `user_id`. Without explicit `fields`, it
projects all supported job fields except `process`, matching the Python
interface's intent. Explicit projections may include `process`.

All three listings support optional `max_age` and `max_updated_ago` as finite non-negative day counts,
including fractional days. Omitted means no age limit; zero means a cutoff of
now, not "ignore this filter". The first page computes inclusive creation/update
lower bounds from one UTC instant. That instant is retained in `next_page.as_of`.

`POST /v2/jobs/active` fixes statuses to `created`, `queued`, `running`.
`require_application_id=true` excludes missing/null application IDs; false
(default) adds no existence filter. Optional `infra_id` matches exactly.

`POST /v2/jobs/cleanup-candidates` fixes statuses to `queued`, `running`, `finished`,
`error`, `canceled`, and requires an inclusive absolute ISO-8601 `updated_until`
with timezone. It is not a started-time or finished-only listing. Optional
`user_ids` accepts a non-empty JSON string array (at most 1000 distinct IDs).
This endpoint only lists candidates; it does not delete jobs.
Relative ages are ANDed with `updated_until`: when `max_updated_ago` is supplied,
the updated timestamp must fall between that relative lower bound and the
absolute upper bound. If the bounds do not overlap, the listing is empty.

All listings exclude tombstones. Active and cleanup listings return full public
jobs unless `fields` is supplied. Filters are ANDed; users within `user_ids` are
ORed. Arbitrary statuses/filters, raw ES bodies, full-text queries and caller-defined
sorting are not exposed. Booleans and numbers must be native JSON values, not strings.
Unknown fields, invalid numbers/timestamps/fields, missing user IDs/cutoffs and malformed continuations
return 400. No `_id`, hit wrappers or `_source` syntax are public. Projection
does not imply authorization to those fields; nested metadata remains JSON.

### Pagination

`limit` defaults to 100 and must be an integer from 1 through 1000. Every listing
returns exactly `{jobs, next_page}`; empty results are `{jobs: [], next_page:
null}`. Send the previous `next_page` object in the request body with otherwise unchanged
listing parameters and endpoint. Stop when it is null.

Ordering is fixed: `created` descending, then globally unique `job_id` ascending.
The ES adapter uses keyset pagination (`search_after`) with one extra
hit as lookahead, avoiding offset-window limits and unnecessary empty pages.
Total-hit counting is disabled because pagination only needs the lookahead hit.
The structured continuation is part of the public contract:

```json
{
  "as_of": "2026-11-10T12:00:00.000Z",
  "fingerprint": "<64 lowercase hexadecimal characters>",
  "position": {
    "created": 1794225600000,
    "job_id": "j-123"
  }
}
```

`as_of` is an ISO-8601 UTC reference time, `fingerprint` binds the listing type
and request fields, and `position` is the last returned job's sort position.
`position.created` is Unix milliseconds or null if missing; `position.job_id`
is a string or null if missing. Missing values sort last. This is a domain
keyset position, not an Elasticsearch response wrapper. Every adapter must map
it to the same fixed ordering. No Base64 encoding, adapter cursor, or URL is used.
The client sends the object back unchanged; `next_page: null` marks completion
in the response, not a valid request continuation. Changed endpoint, backend,
parameters, projection or page size produces 400. Continuations are not signed
credentials: all scope predicates are reapplied independently.

Traversal is a live view, not a snapshot. Concurrent changes to filtering/sort
fields can change page membership. Consumers needing a fixed snapshot or durable
resume across storage-adapter migrations need a future explicit contract.
Unique job identities are required for tie ordering; resolve legacy duplicate
backend/job records before enabling v2 traversal. Large result sets must be
iterated until completion; there is no silent server-side 1000-job total cap.

## Feature mapping to openEO consumers

| Existing operation | v2 equivalent |
|---|---|
| `create_job` | POST job, initial `created` status |
| `get_job` | GET by global job ID, optionally constrained by user |
| `list_user_jobs` | POST `/v2/jobs/user` with `user_id`, project fields, follow `next_page` |
| `list_active_jobs` | POST `/v2/jobs/active`, pass age/application/infra fields |
| `get_all_started_jobs_before` | POST `/v2/jobs/cleanup-candidates` with `updated_until`, optional user list |
| `set_status` | PATCH status plus updated/started/finished/infra fields |
| `set_application_id`, `set_proxy_user` | PATCH corresponding field |
| Dependency setters/removal | PATCH dependency fields, including null clearing |
| `set_results_metadata`, `set_results_metadata_uri` | PATCH costs/usage/input_pixel/metadata or URI |
| `delete_job` | Scoped soft delete |

The cleanup method's historic name is misleading: the inspected Python client
filters by `updated <= upper`, not by `started`. Preserve that behavior when
building the new client. Relative `max_age` and `max_updated_ago` are converted
internally to fixed `created_since` and `updated_since` store filters.

Source contract references:
- [Python registry interface/client](https://github.com/Open-EO/openeo-python-driver/blob/ab7c2eff6d6ef846ac1072f73650300cfc62a7f0/openeo_driver/jobregistry.py)
- [GeoPySpark tracker](https://github.com/Open-EO/openeo-geopyspark-driver/blob/3b00a11debebdbf66b6f26a3c7e36277261ba873/openeogeotrellis/job_tracker_v2.py)

These are source references, not verification of a deployed/pinned runtime.

## Persistence, errors and compatibility

### Direct job IDs and migration

Job IDs are globally unique within the registry index, not just within a backend.
V2 uses the literal `job_id` as the Elasticsearch document ID. Create uses ES
create-only semantics. GET, PATCH and DELETE use real-time document GET by ID,
never a search; job and optional user predicates are verified against
the fetched document before returning data or performing a mutation. Incorrect
scope returns 404. Creation additionally verifies backend ownership: creating an
ID reserved by another backend returns 409.
IDs must fit Elasticsearch's 512 UTF-8 byte limit.

Only list/filter operations still use ES search. They must not be used as a
fallback for single-job access. There is no empty-search polling on creation.
Writes use one atomic document operation.

This changes the initial v2 ID layout (formerly a backend/job hash) deliberately.
Legacy random-ID and earlier v2 hashed-ID documents require an explicit migration
to literal job IDs before direct access works. No automatic migration or fallback
is included. First inventory every writer, resolve global ID collisions and
duplicates, stop writes, back up, reindex with `_id = job_id`, verify data and
counts, then switch consumers. Preserve tombstones and private revision state.
The same physical index must never retain both old- and new-ID copies of a job.
If preserving existing v2 ETags matters, preserve ES document versions as well;
otherwise require clients to reread after cutover.

The legacy `/jobs` implementation is unchanged and can still create random-ID
duplicates. Do not mix legacy and v2 creation for the same job. Without searches,
v2 cannot discover old copies under another ID. Legacy updates of a direct-ID
job change its version and invalidate previously read v2 ETags.

### Replayable creation

POST uses create-if-absent semantics and returns 201 with the job and its `ETag`.
If the ID already exists in the same backend, identical original creation input
returns the current job and current ETag without a write. Any changed creation
field, including `parent_id` or `user_id`, returns 409. The existing job's ownership
and metadata are never overwritten. Valid request fields are still required;
an existing ID does not bypass input validation. Identical concurrent creates
converge; different concurrent bodies yield one success and one conflict.

A SHA-256 creation fingerprint covers backend ID and submitted fields before
server defaults. Object key order is irrelevant; array order and explicit null
versus omission are significant. Callers must resend supplied timestamps exactly.
Only the fingerprint is retained, not the original body or response.
The fingerprint is preserved through mutations, so an identical create retry
still succeeds after status or other metadata changes. A job that has progressed
is returned in its current state, not its initial state.
Existing records without a creation fingerprint return 409 on create retries:
the original input cannot reliably be reconstructed from current mutable data.
They remain readable and conditionally mutable; do not infer a fingerprint from
their current state during migration.
An ID reserved by another backend or a soft-deleted job returns 409.
Creation never resets or resurrects a job.
Listing routes use POST, so IDs such as `user`, `active` and `cleanup-candidates`
remain usable with GET/PATCH/DELETE and are not reserved.

### Conditional writes and retries

GET returns a strong opaque ETag. PATCH and DELETE require that value in
`If-Match`, rejecting missing preconditions with 428 and stale versions with 412.
Wildcards, weak ETags and multiple ETags are not accepted. The service checks
the client ETag, then the adapter uses Elasticsearch sequence-number/primary-term
preconditions to close the race between its own read and write. It never reads
a newer version and silently applies an old client's update to it.
The ETag incorporates document version and revision as well as content, so
intervening writes that restore identical content also invalidate stale clients.
The ES version fields themselves are not part of the public job model.

Example:

```http
GET /v2/jobs/j-123
```

```http
HTTP/1.1 200 OK
ETag: "<opaque-version-from-response>"
```

```http
PATCH /v2/jobs/j-123
If-Match: "<opaque-version-from-response>"
Content-Type: application/json

{"status":"finished","costs":1.5}
```

A successful mutation followed by a retry with its old ETag returns 412 without
another write. This also applies to DELETE retries and concurrent identical
updates. Reread and reconcile after a lost response: the API cannot distinguish
your earlier successful request from another writer's change.
`Idempotency-Key` replay is not supported; no request history or response
snapshots are retained.

Private `_registry` metadata contains a revision, changed on every mutation,
and an optional immutable creation fingerprint. Both are excluded from all v2
bodies/projections. Full legacy raw-source queries can
still see this metadata. The existing `dynamic: false` mapping retains it
unindexed. Full document replacement implements shallow metadata replacement.
Any receipt metadata from the earlier implementation is discarded on the next
v2 mutation; its original-response replay guarantees no longer apply.
Soft-deleted IDs remain reserved. Physically removing a document ends its
ID reservation and is an explicit lifecycle action.

Writes wait for ES refresh so subsequent searches see them. V2 search has no
response cache or empty-result retries. Legacy query caching and eventual
consistency behavior are unchanged; a v2 write may remain hidden by a legacy
cached query until its normal TTL expires.

Errors use Nest's existing HTTP error envelope:
- 400: invalid fields, filters, timestamps, cursors or empty updates.
- 404: no visible job matching all identity/scope predicates.
- 409: ID reserved by another backend or a soft-deleted job, changed creation
  input, or original creation input unavailable.
- 412: stale If-Match or an intervening concurrent write.
- 428: missing If-Match.
- 503: storage operation failed; log a generic error, never transport credentials.
- Authentication/authorization and throttling retain their existing HTTP errors.

Do not silently fall back to legacy search or switch storage on errors. V2's
status/defaults/pagination/204/error behavior is versioned, not retrofitted onto
legacy routes. Existing legacy status codes, arbitrary searches and response
shapes remain unchanged.

## Validation and rollout

The initial HTTP tests instantiate the real `JobsModule`, validation pipe,
controllers, shared registry service and ES adapter with a mocked Elasticsearch transport. They exercise
scope, query translation, cursor traversal, validation, concurrency/error
mapping, direct document IDs, create-if-absent, CRUD and retained legacy response shapes.
The existing legacy tests remain in place.
Service tests also use a test-only in-memory adapter with string versions and
tokens, without any ES dependency, to verify shared creation/retry rules,
compare-and-swap races, external-write invalidation, metadata hiding and errors.

The opt-in integration suite creates a uniquely named index using the existing
mappings, removes it on completion, and refuses non-local ES URLs:

```sh
EJR_TEST_ES_URL=http://127.0.0.1:<disposable-port> \
  npm run test:e2e -- --runInBand domain-jobs.e2e-spec.ts
```

Run it only against a disposable local instance, never a production registry.
It checks direct-ID access without searches, create-if-absent without overwrites,
stale retries and concurrent writes, legacy-version invalidation,
multi-page traversal with equal timestamps, more than 1000 results, and
concurrent v2 creates. Local validation uses Elasticsearch 7.17.14, matching this
branch's client generation; it is not acceptance of another deployed server,
production authentication or infrastructure.

Before production rollout, repeat integration tests against the selected
client/server combination in an approved test environment.
Future storage adapters must pass the same domain behavior tests against their
real engine. Health/readiness is still ES-specific and must be adapted alongside
any future storage selection.

Roll out additively: deploy both APIs, add the domain Python client, migrate
backend and tracker together using explicit selection, then compare behavior.
Rollback selects the legacy Python implementation; do not resume legacy creation
for direct-ID jobs or discard revision state.
Do not remove the legacy contract or change storage until consumers and operational
scripts have migrated and data consistency/recovery have been accepted.
