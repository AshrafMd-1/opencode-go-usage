# OpenCode Usage Dashboard — Technical Audit

**Audit date:** 2026-07-14  
**Scope:** Current working tree and running Docker Compose deployment  
**Method:** Read-only code/configuration inspection, read-only OpenCode API fetch, PostgreSQL aggregate/schema queries, and read-only Rill model queries. No implementation files or runtime data were changed as part of this audit. This report is the requested output artifact.

## Evidence labels

- **Verified:** Directly established from code, configuration, the current API response, PostgreSQL, or Rill.
- **Inferred:** Strong conclusion from observed behavior, but not explicitly guaranteed by a contract in this repository.
- **Unknown:** The implementation and observed data do not establish the answer.

---

# 1. Architecture

## End-to-end data flow

```text
OpenCode workspace usage page
  → discover SolidStart usage.list server reference
  → fetch usage pages (50 rows/page)
  → normalize + fingerprint in Node
  → parameterized PostgreSQL upsert into usage_requests
  → Rill PostgreSQL connector
  → materialized Rill model opencode_usage in DuckDB
  → Rill metrics view opencode_usage
  → Rill Explore dashboard OpenCode Usage
```

## Files by stage

| Stage | File(s) | Responsibility |
|---|---|---|
| OpenCode authentication/config | `src/opencode.js:21-37`, `compose.yaml:30-41`, `.env.example` | Reads usage URL/auth cookie and derives workspace/origin. |
| API discovery | `src/opencode.js:39-86` | Downloads page JS assets, locates `usage.list`, its `createServerReference` ID, and SolidStart runtime. |
| API fetching | `src/opencode.js:88-124` | Creates the internal usage function and fetches pages by workspace/page number. |
| Pagination/incremental overlap | `src/collector.js:12-54` | Fetches 50-row pages, searches for five sequential cached fingerprints, stops on overlap or final short page. |
| Normalization/fingerprint/cost | `src/usage.js:3-73` | Converts nullable numerics to zero, validates timestamp/non-negative values, hashes fingerprint, converts cost to USD. |
| Refresh transaction/orchestration | `src/collector.js:88-169` | Locks, fetches, normalizes, batches, commits, updates status, and triggers Rill. |
| PostgreSQL client/upsert | `src/db.js:3-79` | Connection configuration, cached fingerprint order, parameterized batch upsert. |
| PostgreSQL schema | `postgres/init.sql` | Creates `usage_requests`, `collector_state`, checks, defaults, and indexes. |
| Rill refresh trigger | `src/collector.js:171-197` | Discovers local Rill instance and submits model trigger for `opencode_usage`. |
| Scheduler/control UI | `src/server.js` | 30-minute timer, enable/disable state, manual refresh, Rill-only retry, status page. |
| Rill connector | `rill/connectors/postgres.yaml` | PostgreSQL credentials and connector driver. |
| Rill SQL model | `rill/models/opencode_usage.yaml` | Selects PostgreSQL rows and materializes them into Rill's DuckDB. |
| Rill semantic layer | `rill/metrics/opencode_usage.yaml` | Time series, five dimensions, eleven measures. |
| Rill dashboard | `rill/dashboards/opencode_usage.yaml` | Explore dashboard, allowed fields, ranges, defaults, comparison mode. |
| Rill project | `rill/rill.yaml` | Project display name/description and compiler. |
| Deployment | `compose.yaml`, `Dockerfile.collector`, `Dockerfile.rill` | PostgreSQL, collector, and Rill services; health checks; volumes; loopback ports; ARM64/AMD64 build. |

## Source API versus JSON cache

- **Verified:** The running collector reads the live OpenCode internal API. It does not read `data/usage.json`.
- **Verified:** `data/usage.json` still exists locally as an ignored historical file. It contained 1,715 rows during this audit, while the live API and PostgreSQL each contained 1,721 rows. It is stale by six rows and is not part of the active pipeline.
- **Verified:** There is no supported JSON import path in the current implementation.

## Synchronization behavior

- API page size is assumed to be 50 (`src/collector.js:44`).
- Maximum page count is 5,000 (`src/collector.js:12,45`).
- Cached fingerprints are loaded in `time_created DESC, fingerprint DESC` order (`src/db.js:35-37`).
- Five sequential fingerprints are required, except a database with fewer than five rows uses its full row count (`src/collector.js:21`).
- Rows before the overlap are treated as new; overlap and older rows are not re-upserted (`src/collector.js:48-53`).
- If no overlap is found, every page is fetched and all returned rows are safely upserted.
- Batches contain at most 500 rows (`src/collector.js:128-133`).
- An in-process flag and PostgreSQL advisory lock `73024191` prevent overlapping runs (`src/collector.js:10,88-98`).
- After PostgreSQL commit, Rill receives an asynchronous refresh trigger (`src/collector.js:145-153,181-196`). “accepted” means the trigger was accepted, not that Rill finished materializing.
- There is no independent Rill cron. The collector owns scheduling.

---

# 2. Raw source fields

## Representative current API record

Identifiers are intentionally redacted. The values below came from a direct read-only API fetch during the audit.

```json
{
  "id": "[REDACTED]",
  "workspaceID": "[REDACTED]",
  "timeCreated": "2026-07-14T16:52:26.000Z",
  "timeUpdated": "2026-07-14T16:52:26.138Z",
  "timeDeleted": null,
  "model": "mimo-v2.5",
  "provider": "openrouter-xiaomi",
  "inputTokens": 1241,
  "outputTokens": 734,
  "reasoningTokens": 314,
  "cacheReadTokens": 192,
  "cacheWrite5mTokens": null,
  "cacheWrite1hTokens": null,
  "cost": 37980,
  "keyID": "[REDACTED]",
  "sessionID": "[REDACTED]",
  "enrichment": {
    "plan": "lite"
  }
}
```

The SolidStart runtime deserializes `timeCreated` and `timeUpdated` as JavaScript `Date` objects. When serialized as JSON, they appear as ISO-8601 strings as shown above.

## Current API field matrix (1,721 records)

Nullability below is **observed current data**, not a published OpenCode schema guarantee.

| Raw field | Observed raw type | Observed null/missing | Imported? | PostgreSQL destination | In Rill model? | Exposed in metrics view? | Current use |
|---|---|---:|---|---|---|---|---|
| `id` | string | 0 null, 0 missing | Yes | `request_id TEXT NOT NULL` | Yes | No | Fingerprint; hidden model column |
| `workspaceID` | string | 0/0 | Yes | `workspace_id TEXT NOT NULL` | Yes | Yes: `workspace` | Fingerprint and dimension |
| `timeCreated` | Date object / ISO string | 0/0 | Yes | `time_created TIMESTAMPTZ NOT NULL` | Yes | Yes, implicit time dimension | Fingerprint, filtering, grouping, comparisons |
| `timeUpdated` | Date object / ISO string | 0/0 | **No** | None | No | No | Unused |
| `timeDeleted` | null in all 1,721 | 1,721 null, 0 missing | **No** | None | No | No | Unused; no delete filtering |
| `model` | string | 0/0 | Yes | `model TEXT NOT NULL` | Yes | Yes: `model` | Fingerprint and dimension |
| `provider` | string | 0/0 | Yes | `provider TEXT NOT NULL` | Yes | Yes: `provider` | Fingerprint and dimension |
| `inputTokens` | number | 0/0 | Yes | `input_tokens BIGINT NOT NULL` | Yes | Yes | Fingerprint and token measures |
| `outputTokens` | number | 0/0 | Yes | `output_tokens BIGINT NOT NULL` | Yes | Yes | Fingerprint and token measures |
| `reasoningTokens` | number or null | 557 null, 0 missing | Yes; null→0 | `reasoning_tokens BIGINT NOT NULL` | Yes | Yes | Fingerprint and token measures |
| `cacheReadTokens` | number or null | 11 null, 0 missing | Yes; null→0 | `cache_read_tokens BIGINT NOT NULL` | Yes | Yes | Fingerprint, totals, ratio |
| `cacheWrite5mTokens` | number or null | 1,608 null, 0 missing | Yes; null→0 | `cache_write_5m_tokens BIGINT NOT NULL` | Yes | Combined in Rill | Fingerprint, totals, ratio |
| `cacheWrite1hTokens` | null in all 1,721 | 1,721 null, 0 missing | Yes; null→0 | `cache_write_1h_tokens BIGINT NOT NULL` | Yes | Combined in Rill | Fingerprint, totals, ratio |
| `cost` | number (observed integer) | 0/0 | Yes, twice | `raw_cost NUMERIC(30,0)` and `cost_usd NUMERIC(20,8)` | Only `cost_usd` | Yes: `usd_cost`, average | Fingerprint and cost measures |
| `keyID` | string | 0/0 | Yes | `key_id TEXT NOT NULL` | **No** | No | Fingerprint only |
| `sessionID` | string (may be empty) | 0/0; 709 DB rows are empty string | Yes | `session_id TEXT NOT NULL` | Yes | Yes: `session` | Fingerprint and dimension |
| `enrichment.plan` | string when present | 0 null, 35 missing | Yes; missing→`unknown` | `plan TEXT NOT NULL` | Yes | Yes: `plan` | Fingerprint and dimension |

## Normalization rules

From `src/usage.js:3-10,38-73`:

```js
function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integerString(value) {
  return String(Math.trunc(number(value)));
}
```

Consequences:

- Null, undefined, and non-finite numeric values become zero.
- Numeric values are truncated to whole numbers before storage, except `cost_usd` is computed directly from `number(row.cost)`.
- Invalid `timeCreated` rejects/skips the record.
- Any negative normalized token/cost rejects/skips the record.
- Missing model/provider/plan becomes `unknown`.
- Missing ID/session/key becomes an empty string; these do not cause rejection.
- The current API had no malformed records according to the last successful refresh state.

---

# 3. Database schema

## Migrations

- **Verified:** There is no migration framework and no versioned migration directory.
- **Verified:** `postgres/init.sql` is the only schema SQL file.
- **Verified:** Compose mounts it into `/docker-entrypoint-initdb.d/001-init.sql`; PostgreSQL executes it only when initializing an empty data volume.
- **Consequence:** Editing `postgres/init.sql` does not migrate an existing `postgres_data` volume.

## Exact table definitions

```sql
CREATE TABLE IF NOT EXISTS usage_requests (
  fingerprint TEXT PRIMARY KEY,
  request_id TEXT NOT NULL,
  workspace_id TEXT NOT NULL,
  time_created TIMESTAMPTZ NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  plan TEXT NOT NULL,
  session_id TEXT NOT NULL,
  key_id TEXT NOT NULL,
  input_tokens BIGINT NOT NULL CHECK (input_tokens >= 0),
  output_tokens BIGINT NOT NULL CHECK (output_tokens >= 0),
  reasoning_tokens BIGINT NOT NULL CHECK (reasoning_tokens >= 0),
  cache_read_tokens BIGINT NOT NULL CHECK (cache_read_tokens >= 0),
  cache_write_5m_tokens BIGINT NOT NULL CHECK (cache_write_5m_tokens >= 0),
  cache_write_1h_tokens BIGINT NOT NULL CHECK (cache_write_1h_tokens >= 0),
  raw_cost NUMERIC(30, 0) NOT NULL CHECK (raw_cost >= 0),
  cost_usd NUMERIC(20, 8) NOT NULL CHECK (cost_usd >= 0),
  first_ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS usage_requests_time_idx ON usage_requests (time_created DESC);
CREATE INDEX IF NOT EXISTS usage_requests_model_idx ON usage_requests (model);
CREATE INDEX IF NOT EXISTS usage_requests_provider_idx ON usage_requests (provider);
CREATE INDEX IF NOT EXISTS usage_requests_plan_idx ON usage_requests (plan);
CREATE INDEX IF NOT EXISTS usage_requests_workspace_idx ON usage_requests (workspace_id);

CREATE TABLE IF NOT EXISTS collector_state (
  singleton BOOLEAN PRIMARY KEY DEFAULT TRUE CHECK (singleton),
  auto_refresh_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_started_at TIMESTAMPTZ,
  last_completed_at TIMESTAMPTZ,
  last_success BOOLEAN,
  last_error TEXT,
  last_reason TEXT,
  pages_fetched INTEGER NOT NULL DEFAULT 0 CHECK (pages_fetched >= 0),
  rows_added BIGINT NOT NULL DEFAULT 0 CHECK (rows_added >= 0),
  invalid_rows BIGINT NOT NULL DEFAULT 0 CHECK (invalid_rows >= 0),
  total_rows BIGINT NOT NULL DEFAULT 0 CHECK (total_rows >= 0),
  next_run_at TIMESTAMPTZ,
  last_rill_status TEXT,
  last_rill_trigger_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

## Constraints and derivation

- Primary key/unique constraint: `usage_requests.fingerprint` only.
- There is no unique constraint on `request_id`.
- Current integrity check: 1,721 rows, 1,721 fingerprints, and 1,721 distinct request IDs. There are currently no duplicate logical request IDs.
- There are no PostgreSQL generated columns.
- `cost_usd` is derived in Node before insertion, not generated by PostgreSQL.
- `first_ingested_at` and `last_seen_at` default to `NOW()`.
- On exact fingerprint conflict, all imported business fields are updated and `last_seen_at` becomes `NOW()`; `first_ingested_at` remains unchanged.

## PostgreSQL views/materialized views

**None.** Rill reads the base table directly.

## Complete Rill model SQL

`rill/models/opencode_usage.yaml` materializes the following query into Rill's embedded DuckDB:

```sql
SELECT
  fingerprint,
  request_id,
  workspace_id,
  time_created,
  model,
  provider,
  plan,
  session_id,
  input_tokens,
  output_tokens,
  reasoning_tokens,
  cache_read_tokens,
  cache_write_5m_tokens,
  cache_write_1h_tokens,
  cost_usd
FROM usage_requests
```

The Rill model excludes `key_id`, `raw_cost`, `first_ingested_at`, and `last_seen_at`.

---

# 4. Cost normalization

## Formula and location

`src/usage.js:49,71-72`:

```js
const rawCost = integerString(row.cost);
// ...
costUsd: String(number(row.cost) / 1e8),
```

Formula:

```text
cost_usd = raw cost / 100,000,000
```

The conversion occurs during Node normalization, before PostgreSQL insertion. PostgreSQL stores the result as `NUMERIC(20,8)`.

## Evidence

1. The current database totals are:
   - raw cost: `317,922,959`
   - normalized cost: `3.17922959`
2. PostgreSQL verification:

```text
SUM(raw_cost) / 100000000 = 3.1792295900000000
SUM(cost_usd)             = 3.17922959
difference                = 0.0000000000000000
```

3. The previous tracked CLI used the same formula (`git show HEAD:OPC`, former line 448):

```js
function rowCost(r) { return num(r.cost) / 1e8; }
```

## Correctness conclusion

- **Verified internal arithmetic:** Every current stored total matches `raw_cost / 1e8` exactly.
- **Verified display consistency:** Rill's direct model query returned `3.17922959`; `currency_usd` displays this as approximately `$3.18`.
- **Unknown external contract:** This repository contains no authoritative OpenCode schema/documentation proving that one raw cost unit is exactly `10^-8 USD`. The divisor is inherited from the former CLI and is consistent with current display/data, but external semantic correctness is not independently proven here.

## Rounding

- Raw cost is converted through JavaScript `Number`, truncated for `raw_cost`, and divided for `cost_usd`.
- PostgreSQL stores eight fractional decimal places. An integer divided by `1e8` is exactly representable at that decimal scale conceptually; current rows show no aggregate decimal loss.
- Rill aggregates the stored decimal values.
- Display rounding occurs through `format_preset: currency_usd`, producing two decimal places in the UI.
- **Possible precision limit:** JavaScript `Number` cannot exactly represent integers above `2^53-1`. Current observed costs are far below that threshold, so this does not affect current totals.

---

# 5. Token semantics

## Raw-field normalization

All token fields pass through `integerString(number(value))`. Therefore null cache/reasoning values become `0`, and all stored token columns are non-null, non-negative `BIGINT`s.

## Current formulas

| Dashboard measure | Exact expression | Current all-time value |
|---|---|---:|
| Input tokens | `SUM(input_tokens)` | 5,416,202 |
| Cache-read tokens | `SUM(cache_read_tokens)` | 34,780,427 |
| Cache-write tokens | `SUM(cache_write_5m_tokens + cache_write_1h_tokens)` | 352,493 |
| Input + cache tokens | `SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens)` | 40,549,122 |
| Output tokens | `SUM(output_tokens)` | 856,403 |
| Reasoning tokens | `SUM(reasoning_tokens)` | 338,223 |
| Total tokens | `SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens + output_tokens + reasoning_tokens)` | 41,743,748 |
| Cache-read ratio | `COALESCE(SUM(cache_read_tokens) / NULLIF(SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens), 0), 0)` | 0.8577356373 (85.7736%) |

## Semantics: verified versus unknown

### `outputTokens` and reasoning

- **Verified:** The API supplies `outputTokens` and `reasoningTokens` separately.
- **Verified:** `Total tokens` explicitly adds both, so reasoning is counted in addition to output.
- **Verified observation:** No current row has `reasoning_tokens > output_tokens`; that fact does not prove whether reasoning is a subset of output.
- **Unknown:** The repository has no provider-normalized contract establishing whether `outputTokens` excludes reasoning for all 13 providers.
- **Possible consequence:** If a provider reports output inclusive of reasoning, `Total tokens` double counts reasoning for that provider. If output excludes reasoning, the formula is correct.

### Cache writes and context totals

- **Verified:** Both cache-write categories are added to “Input + cache tokens,” “Total tokens,” and the cache-read-ratio denominator.
- **Verified current data:** 53 rows have positive 5-minute cache writes totaling 352,493. No rows have positive 1-hour cache writes.
- **Unknown:** The API contract does not establish whether cache-write tokens are disjoint from `inputTokens` for every provider. If they are alternative billing categories, adding them is reasonable; if already included in input, totals overlap.

### Null behavior

- `reasoningTokens`: 557 API nulls → database zero.
- `cacheReadTokens`: 11 API nulls → zero.
- `cacheWrite5mTokens`: 1,608 API nulls → zero.
- `cacheWrite1hTokens`: all 1,721 API values null → zero.
- Because PostgreSQL values are non-null, SQL additions do not become null.

### Cache-read ratio meaning

The implementation defines it as:

```text
cache read / (fresh input + cache read + 5m cache write + 1h cache write)
```

This is a ratio of aggregate sums and therefore aggregates correctly across dimensions/time. Whether cache writes should be in the denominator is a product/semantic question not resolved by the source API contract.

---

# 6. Rill configuration

## Full connector YAML

`rill/connectors/postgres.yaml`:

```yaml
type: connector
driver: postgres
host: "{{ .env.POSTGRES_HOST }}"
port: "{{ .env.POSTGRES_PORT }}"
dbname: "{{ .env.POSTGRES_DB }}"
user: "{{ .env.POSTGRES_USER }}"
password: "{{ .env.POSTGRES_PASSWORD }}"
sslmode: disable
```

## Full model YAML

`rill/models/opencode_usage.yaml`:

```yaml
type: model
connector: postgres
materialize: true

sql: |
  SELECT
    fingerprint,
    request_id,
    workspace_id,
    time_created,
    model,
    provider,
    plan,
    session_id,
    input_tokens,
    output_tokens,
    reasoning_tokens,
    cache_read_tokens,
    cache_write_5m_tokens,
    cache_write_1h_tokens,
    cost_usd
  FROM usage_requests

tests:
  - name: unique_fingerprints
    sql: |
      SELECT fingerprint
      FROM opencode_usage
      GROUP BY fingerprint
      HAVING COUNT(*) > 1
  - name: valid_values
    assert: >-
      time_created IS NOT NULL AND
      input_tokens >= 0 AND output_tokens >= 0 AND reasoning_tokens >= 0 AND
      cache_read_tokens >= 0 AND cache_write_5m_tokens >= 0 AND
      cache_write_1h_tokens >= 0 AND cost_usd >= 0
```

## Full metrics-view YAML

`rill/metrics/opencode_usage.yaml`:

```yaml
version: 1
type: metrics_view

model: opencode_usage
display_name: OpenCode Usage
description: Request volume, token consumption, and normalized USD cost over time.
timeseries: time_created
smallest_time_grain: minute

dimensions:
  - name: model
    display_name: Model
    column: model
  - name: provider
    display_name: Provider
    column: provider
  - name: plan
    display_name: Plan
    column: plan
  - name: workspace
    display_name: Workspace
    column: workspace_id
  - name: session
    display_name: Session
    column: session_id

measures:
  - name: requests
    display_name: Requests
    expression: COUNT(*)
    format_preset: humanize
  - name: usd_cost
    display_name: Cost
    expression: SUM(cost_usd)
    format_preset: currency_usd
  - name: input_tokens
    display_name: Input tokens
    expression: SUM(input_tokens)
    format_preset: humanize
  - name: cache_read_tokens
    display_name: Cache-read tokens
    expression: SUM(cache_read_tokens)
    format_preset: humanize
  - name: cache_write_tokens
    display_name: Cache-write tokens
    expression: SUM(cache_write_5m_tokens + cache_write_1h_tokens)
    format_preset: humanize
  - name: input_plus_cache_tokens
    display_name: Input + cache tokens
    expression: SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens)
    format_preset: humanize
  - name: output_tokens
    display_name: Output tokens
    expression: SUM(output_tokens)
    format_preset: humanize
  - name: reasoning_tokens
    display_name: Reasoning tokens
    expression: SUM(reasoning_tokens)
    format_preset: humanize
  - name: total_tokens
    display_name: Total tokens
    expression: SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens + output_tokens + reasoning_tokens)
    format_preset: humanize
  - name: average_cost_per_request
    display_name: Average cost / request
    expression: COALESCE(SUM(cost_usd) / NULLIF(COUNT(*), 0), 0)
    format_preset: currency_usd
  - name: cache_read_ratio
    display_name: Cache-read ratio
    expression: COALESCE(SUM(cache_read_tokens) / NULLIF(SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens), 0), 0)
    format_preset: percentage
```

## Full dashboard YAML

`rill/dashboards/opencode_usage.yaml`:

```yaml
type: explore

display_name: OpenCode Usage
metrics_view: opencode_usage
description: Explore OpenCode request volume, token usage, costs, models, providers, plans, workspaces, and sessions.

dimensions: "*"
measures: "*"

time_ranges:
  - DTD
  - WTD
  - MTD
  - P7D
  - P30D
  - P3M
  - inf

allow_custom_time_range: true

defaults:
  dimensions:
    - model
    - provider
    - plan
  measures:
    - requests
    - usd_cost
    - total_tokens
    - cache_read_ratio
  time_range: P30D
  comparison_mode: time
```

## Time dimension

| Property | Value |
|---|---|
| Internal/source name | `time_created` |
| Display name | No explicit display name; Rill derives it from the source column |
| Source type | PostgreSQL `TIMESTAMPTZ`, materialized into DuckDB |
| Metrics-view declaration | `timeseries: time_created` |
| Smallest configured grain | `minute` |
| Largest configured grain | No maximum configured; broader Rill grains remain available |
| Earliest timestamp | `2026-06-24T02:12:41Z` |
| Latest timestamp | `2026-07-14T16:52:26Z` |
| Timezone | Storage is UTC instants; dashboard does not lock or pin a timezone, so Rill's user/browser-selected timezone behavior applies |

## Dimensions

No dimension has a configured description.

| Internal | Display | Source | In default dimension list? | Current cardinality/usefulness |
|---|---|---|---|---|
| `model` | Model | column `model` | Yes, first | 12 values; useful |
| `provider` | Provider | column `provider` | Yes, second | 13 values; useful |
| `plan` | Plan | column `plan` | Yes, third | 2 values (`lite`, `unknown`); useful mainly for identifying 35 un-enriched records |
| `workspace` | Workspace | column `workspace_id` | No | 1 value; currently provides no analytical breakdown and exposes an internal ID |
| `session` | Session | column `session_id` | No | 107 distinct values including empty string; 709 rows have empty session; high-cardinality drill-down |

## Measures

No measure has a configured description. All are valid across time/model/provider/plan/workspace/session aggregation in the SQL sense. Semantic caveats for overlapping token categories are separate.

| Internal | Display | Expression | Format | Default? | Divide-by-zero |
|---|---|---|---|---|---|
| `requests` | Requests | `COUNT(*)` | `humanize` | Yes, #1 | N/A |
| `usd_cost` | Cost | `SUM(cost_usd)` | `currency_usd` | Yes, #2 | N/A |
| `input_tokens` | Input tokens | `SUM(input_tokens)` | `humanize` | No | N/A |
| `cache_read_tokens` | Cache-read tokens | `SUM(cache_read_tokens)` | `humanize` | No | N/A |
| `cache_write_tokens` | Cache-write tokens | `SUM(cache_write_5m_tokens + cache_write_1h_tokens)` | `humanize` | No | N/A |
| `input_plus_cache_tokens` | Input + cache tokens | `SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens)` | `humanize` | No | N/A |
| `output_tokens` | Output tokens | `SUM(output_tokens)` | `humanize` | No | N/A |
| `reasoning_tokens` | Reasoning tokens | `SUM(reasoning_tokens)` | `humanize` | No | N/A |
| `total_tokens` | Total tokens | `SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens + output_tokens + reasoning_tokens)` | `humanize` | Yes, #3 | N/A |
| `average_cost_per_request` | Average cost / request | `COALESCE(SUM(cost_usd) / NULLIF(COUNT(*), 0), 0)` | `currency_usd` | No | Handled with `NULLIF` + `COALESCE` |
| `cache_read_ratio` | Cache-read ratio | `COALESCE(SUM(cache_read_tokens) / NULLIF(SUM(input_tokens + cache_read_tokens + cache_write_5m_tokens + cache_write_1h_tokens), 0), 0)` | `percentage` | Yes, #4 | Handled with `NULLIF` + `COALESCE` |

---

# 7. Current dashboard behavior

## Why “4 of 11 Measures”

There are eleven measures in `rill/metrics/opencode_usage.yaml`. The dashboard default list selects four (`rill/dashboards/opencode_usage.yaml:26-30`):

1. Requests
2. Cost
3. Total tokens
4. Cache-read ratio

The label means four are currently selected from eleven available, not that only four exist.

## Measure order

- The full measure selector order follows the metrics-view YAML order.
- The selected default order follows the `defaults.measures` list shown above.
- User interaction or URL state can change the current order/selection.

## Why Provider is the current breakdown

- **Verified configuration:** Provider is one of three default dimensions and is second in the list (`model`, `provider`, `plan`).
- **Verified:** It is not configured as a singular `default_dimension`; no such property exists in this dashboard file.
- **Unknown from repository state:** The exact reason the browser currently shows Provider rather than Model cannot be proven from YAML. It may reflect an in-session selection or URL/UI state. The configuration alone does not force Provider as the only breakdown.

## Available views and controls

- This is a single Rill **Explore** dashboard, not a custom Canvas dashboard.
- The small line/spark charts are not the only Rill Explore surface. Explore also supports leaderboard/table detail, time-series exploration, and a built-in flat/pivot table view.
- Pivot is not explicitly configured, customized, or hidden. Therefore the built-in pivot capability is available by default, but there is no project-specific pivot layout.
- Users can switch among Model, Provider, Plan, Workspace, and Session because `dimensions: "*"` exposes all five metrics-view dimensions.
- Users can select any of the eleven measures because `measures: "*"` exposes all measures.
- Time filters: today, week-to-date, month-to-date, 7 days, 30 days, 3 months, all time, and custom range.
- Categorical filters: Model, Provider, Plan, Workspace, Session.
- Rill supports searching dimension values in Explore leaderboards/tables. All five categorical dimensions are therefore searchable where Rill presents dimension-value search.
- Hidden raw/model fields: `fingerprint` and `request_id` are present in the Rill model but absent from the metrics view. `key_id`, `raw_cost`, and ingestion timestamps are absent even from the Rill model.

There are no other dashboard YAML files and no custom visual layout.

---

# 8. Delta and comparison behavior

## Configured behavior

```yaml
defaults:
  time_range: P30D
  comparison_mode: time
```

For the stated screen:

- Current period: 2026-06-15 through 2026-07-14
- Previous equal-length period: 2026-05-16 through 2026-06-14

## Data coverage

- Earliest row: 2026-06-24 02:12:41 UTC
- Latest row: 2026-07-14 16:52:26 UTC
- Current-period rows (using the stated UTC day boundaries): 1,721
- Previous-period rows: 0

Timezone boundary changes cannot move the earliest June 24 record into the previous period ending June 14, so the previous period is empty in any practical dashboard timezone.

## Why deltas show `—`

- **Verified data cause:** There is no prior-period baseline.
- **Inference from mathematics and observed UI:** Percentage change against absent/zero prior data is undefined, so Rill renders no delta (`—`) rather than a number.
- **Documentation limit:** The reviewed Rill documentation confirms previous-period comparison but does not explicitly document the exact glyph used for an empty baseline. The `—` behavior is observed on the current screen.
- **Classification:** Expected behavior caused by limited history, not an ingestion failure and not a metrics-view configuration error.

Once the selected previous period contains rows, comparison deltas should become computable. A baseline measure that is exactly zero may still yield no percentage delta because division by zero is undefined; this edge behavior is not explicitly configured in this repository.

---

# 9. Data validation

## Overall totals

PostgreSQL and a direct query of Rill's materialized `opencode_usage` model returned the same values:

| Metric | PostgreSQL | Rill | Difference |
|---|---:|---:|---:|
| Requests | 1,721 | 1,721 | 0 |
| Normalized cost | 3.17922959 | 3.17922959 | 0 |
| Fresh input tokens | 5,416,202 | 5,416,202 | 0 |
| Cache-read tokens | 34,780,427 | 34,780,427 | 0 |
| 5-minute cache writes | 352,493 | 352,493 | 0 |
| 1-hour cache writes | 0 | 0 | 0 |
| Output tokens | 856,403 | 856,403 | 0 |
| Reasoning tokens | 338,223 | 338,223 | 0 |
| Earliest | 2026-06-24T02:12:41Z | same | — |
| Latest | 2026-07-14T16:52:26Z | same | — |

Additional cardinalities:

| Field | Distinct count |
|---|---:|
| Models | 12 |
| Providers | 13 |
| Plans | 2 |
| Workspaces | 1 |
| Session values | 107 (includes empty string) |
| Non-empty session IDs | 106 |

Current default dashboard KPI values should therefore be approximately:

- Requests: `1.72K` (humanized)
- Cost: `$3.18`
- Total tokens: `41.74M` (humanized; exact configured value 41,743,748)
- Cache-read ratio: `85.77%`

The direct Rill model totals match PostgreSQL. No aggregate discrepancy was found. Display differences are expected formatting/rounding only.

## By model

| Model | Requests | Cost USD | Input | Cache read | Cache write 5m | Cache write 1h | Output | Reasoning |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| glm-5.1 | 46 | 1.37973616 | 344,754 | 3,140,736 | 0 | 0 | 18,293 | 0 |
| deepseek-v4-flash | 1,248 | 0.72470674 | 3,374,438 | 25,791,232 | 0 | 0 | 643,106 | 299,221 |
| mimo-v2.5-pro | 1 | 0.26489760 | 152,102 | 0 | 0 | 0 | 69 | 10 |
| qwen3.7-plus | 52 | 0.23214952 | 416 | 1,240,588 | 333,340 | 0 | 9,806 | 0 |
| minimax-m2.7 | 7 | 0.17351517 | 545,861 | 32,568 | 19,153 | 0 | 517 | 0 |
| minimax-m3 | 58 | 0.14640990 | 293,349 | 1,641,194 | 0 | 0 | 34,068 | 0 |
| mimo-v2.5 | 235 | 0.11328020 | 507,498 | 2,627,968 | 0 | 0 | 124,543 | 31,151 |
| deepseek-v4-pro | 34 | 0.10296616 | 43,639 | 159,232 | 0 | 0 | 7,105 | 1,561 |
| glm-5.2 | 4 | 0.03749554 | 11,476 | 15,709 | 0 | 0 | 3,942 | 0 |
| kimi-k2.6 | 1 | 0.00407260 | 68 | 0 | 0 | 0 | 1,002 | 750 |
| deepseek-v4-flash-free | 1 | 0.00000000 | 7,643 | 1,920 | 0 | 0 | 237 | 228 |
| hy3-free | 34 | 0.00000000 | 134,958 | 129,280 | 0 | 0 | 13,715 | 5,302 |

Rill model counts/costs matched every model row.

## By provider

| Provider | Requests | Cost USD | Input | Cache read | Cache write 5m | Cache write 1h | Output | Reasoning |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| console-go.oa-compat | 1,085 | 2.30385980 | 3,660,310 | 27,339,008 | 0 | 0 | 498,396 | 228,842 |
| alibaba-us.an | 52 | 0.23214952 | 416 | 1,240,588 | 333,340 | 0 | 9,806 | 0 |
| console-go.anthropic | 27 | 0.22229487 | 665,854 | 147,178 | 19,153 | 0 | 5,438 | 0 |
| deepseek | 254 | 0.17833105 | 317,895 | 1,980,160 | 0 | 0 | 171,562 | 72,549 |
| minimax.an | 34 | 0.09730918 | 173,028 | 1,525,933 | 0 | 0 | 28,459 | 0 |
| openrouter-xiaomi | 217 | 0.09401574 | 387,139 | 2,063,552 | 0 | 0 | 121,565 | 29,922 |
| fireworks-serverless | 3 | 0.03359474 | 10,632 | 15,709 | 0 | 0 | 3,324 | 0 |
| mimo | 8 | 0.00938027 | 57,087 | 336,448 | 0 | 0 | 1,593 | 630 |
| openrouter-moonshotai | 1 | 0.00407260 | 68 | 0 | 0 | 0 | 1,002 | 750 |
| deepinfra-glm-5.2 | 1 | 0.00390080 | 844 | 0 | 0 | 0 | 618 | 0 |
| minimax.oai | 4 | 0.00032102 | 328 | 651 | 0 | 0 | 688 | 0 |
| console.oai | 1 | 0.00000000 | 7,643 | 1,920 | 0 | 0 | 237 | 228 |
| openrouter-novita | 34 | 0.00000000 | 134,958 | 129,280 | 0 | 0 | 13,715 | 5,302 |

Rill model counts/costs matched every provider row.

## By UTC day

Dates absent from the table had zero rows.

| UTC day | Requests | Cost USD | Input | Cache read | Cache write | Output | Reasoning |
|---|---:|---:|---:|---:|---:|---:|---:|
| 2026-06-24 | 23 | 0.00484034 | 20,156 | 13,056 | 0 | 11,156 | 10,436 |
| 2026-06-25 | 63 | 0.01255444 | 6,224 | 5,593 | 0 | 41,512 | 34,612 |
| 2026-06-26 | 33 | 0.01674634 | 34,546 | 9,984 | 0 | 29,544 | 27,423 |
| 2026-06-28 | 48 | 0.02662973 | 51,630 | 592,818 | 0 | 49,723 | 4,520 |
| 2026-06-30 | 192 | 0.24824020 | 458,406 | 3,235,437 | 0 | 121,129 | 2,696 |
| 2026-07-02 | 75 | 0.07652997 | 350,308 | 1,880,014 | 0 | 22,634 | 6,287 |
| 2026-07-03 | 460 | 2.07484471 | 1,740,400 | 12,239,429 | 352,493 | 177,939 | 47,943 |
| 2026-07-04 | 205 | 0.12435564 | 601,856 | 5,127,040 | 0 | 91,929 | 50,398 |
| 2026-07-05 | 34 | 0.01286042 | 43,176 | 543,616 | 0 | 18,906 | 10,906 |
| 2026-07-06 | 23 | 0.03378312 | 210,920 | 1,040,896 | 0 | 4,785 | 631 |
| 2026-07-07 | 104 | 0.09077302 | 438,163 | 2,850,496 | 0 | 76,603 | 50,856 |
| 2026-07-08 | 50 | 0.02642396 | 133,913 | 258,944 | 0 | 24,825 | 11,819 |
| 2026-07-09 | 190 | 0.11971552 | 610,744 | 3,375,104 | 0 | 88,432 | 44,089 |
| 2026-07-10 | 70 | 0.02750721 | 274,134 | 582,080 | 0 | 37,839 | 16,898 |
| 2026-07-11 | 3 | 0.00181562 | 9,837 | 384 | 0 | 1,562 | 681 |
| 2026-07-12 | 23 | 0.21689998 | 118,766 | 313,472 | 0 | 10,412 | 2,704 |
| 2026-07-13 | 74 | 0.04258350 | 219,418 | 1,917,120 | 0 | 23,204 | 6,933 |
| 2026-07-14 | 51 | 0.02212587 | 93,605 | 794,944 | 0 | 24,269 | 8,391 |

Rill's direct UTC-day query matched PostgreSQL request and cost totals for every day.

---

# 10. Potential problems and status

| Area | Classification | Evidence-based finding |
|---|---|---|
| Cost conversion arithmetic | **Working correctly** | Raw total divided by `1e8` exactly equals stored/Rill total; UI `$3.18` is expected display rounding. External unit contract remains unverified. |
| Duplicate ingestion now | **Working correctly** | 1,721 fingerprints, rows, and distinct request IDs; no current duplicates. Exact fingerprint conflicts are idempotent. |
| Fingerprint as primary key | **Possible problem** | Fingerprint includes mutable usage fields. If one OpenCode request ID is later corrected, it gets a new fingerprint and can be inserted as a second row because `request_id` is not unique. No current occurrence. |
| Historical updates below overlap | **Possible problem** | Refresh stops after first five-row overlap and never inspects older rows. Older corrections/deletions cannot propagate during normal incremental refresh. |
| Tie ordering in overlap | **Possible problem** | DB ordering adds `fingerprint DESC` for equal timestamps; API tie ordering is unknown. A mismatch would cause an unnecessary full scan, primarily an efficiency issue. |
| `timeUpdated` omitted | **Confirmed implementation gap** | Present on every API row but not stored or used, so update provenance is lost. Current aggregates still match source. |
| Deleted records | **Possible problem** | `timeDeleted` is not stored/filtered and PostgreSQL rows are never deleted by sync. Current API has zero deleted records, so no current discrepancy. |
| JSON cache | **Cosmetic/usability issue** | Ignored `data/usage.json` is stale (1,715 vs 1,721) but inactive; its presence may confuse manual audits. |
| Migration support | **Confirmed operational limitation** | Only fresh-volume `init.sql`; no migrations for existing deployments. |
| Null handling | **Working correctly with caveat** | Null token fields become zero, preventing SQL null propagation. Non-numeric malformed values also silently become zero rather than being rejected. |
| `Total tokens` reasoning overlap | **Possible problem** | It adds output and reasoning. Correct only if output excludes reasoning for each provider; source contract is unknown. |
| Cache categories in totals | **Possible problem** | Cache writes/reads are added to fresh input. Correct only if API categories are disjoint; provider semantics are not documented here. |
| “Input + cache tokens” name | **Possible semantic/usability issue** | Exact formula includes fresh input, cache reads, and both cache-write types. Name does not reveal all components. |
| “Total tokens” name | **Possible semantic/usability issue** | Formula may represent billed categories rather than unique physical tokens and may double count reasoning/cache depending provider semantics. |
| Cache-read ratio | **Possible semantic/usability issue** | Denominator includes cache writes. This is valid SQL and zero-safe, but may differ from a user's expected cache-hit ratio. |
| Average cost/request | **Working correctly** | Ratio of sum to count; zero-safe and valid at all group levels. |
| Ratio aggregation | **Working correctly** | Uses ratio of aggregate sums, not average of per-row ratios. |
| Workspace dimension | **Cosmetic/usability issue** | Only one workspace exists, so it provides no current breakdown while exposing an internal identifier. |
| Session dimension | **Possible privacy/usability issue** | Exposes session IDs; 709 rows are blank and there are 106 non-empty IDs. Useful for drill-down but potentially sensitive/high-cardinality. |
| Key ID exposure | **Working correctly** | Stored for fingerprinting but excluded from the Rill model and dashboard. |
| Request ID/fingerprint exposure | **Working correctly** | Present in materialized model but not exposed by metrics view. |
| Missing field descriptions | **Cosmetic/usability issue** | Dimensions and measures have no individual descriptions, so formulas are not explained in the UI. |
| Provider default | **Working as configured, behavior uncertain** | Provider is one of three defaults, not sole default. Current Provider selection is not forced by YAML. |
| Comparison deltas `—` | **Working correctly** | Previous period has zero rows, so no comparison baseline exists. |
| Timezone | **Possible usability issue** | Data is UTC, but dashboard timezone is not pinned. Day boundaries may differ by user/browser setting; this is standard Rill behavior. |
| Rill trigger status | **Cosmetic/operational issue** | Controls record “accepted” before asynchronous Rill materialization completes. |
| Rill/PostgreSQL consistency | **Working correctly** | Overall, model, provider, and day aggregates queried from Rill match PostgreSQL. |
| PostgreSQL/Rill network scope | **Working correctly for localhost MVP** | PostgreSQL is internal; controls and Rill bind to `127.0.0.1`. |
| Rill connector secret exposure | **Possible local-security limitation** | Credentials are passed to local Rill via environment/CLI variables. Rill Developer is intentionally localhost-only and is not an authentication boundary. |
| SSL to PostgreSQL | **Working correctly for internal Compose network** | `sslmode: disable` is used only for the internal Compose connection. It would be inappropriate unchanged for an external DB. |
| One-hour cache write measure | **Working correctly but currently uninformative** | All source values are null/zero, so this component contributes nothing currently. |

---

# 11. Files and change surface

No changes are proposed here; this is only the map of where a future requested change would occur.

| Desired change | File(s) |
|---|---|
| Measure internal/display names | `rill/metrics/opencode_usage.yaml` |
| Measure formulas/formats/descriptions | `rill/metrics/opencode_usage.yaml` |
| Default selected measures/order | `rill/dashboards/opencode_usage.yaml` |
| Default dimension list/order | `rill/dashboards/opencode_usage.yaml` |
| Available dimensions/filters | `rill/metrics/opencode_usage.yaml` and `rill/dashboards/opencode_usage.yaml` |
| Dashboard title/description | `rill/dashboards/opencode_usage.yaml`; project/semantic title also appears in `rill/rill.yaml` and `rill/metrics/opencode_usage.yaml` |
| Time ranges/comparison defaults | `rill/dashboards/opencode_usage.yaml` |
| Time source/smallest grain/timezone policy | `rill/metrics/opencode_usage.yaml`, optionally `rill/dashboards/opencode_usage.yaml` |
| PostgreSQL columns/checks/indexes | `postgres/init.sql` plus a new migration mechanism/file for existing volumes |
| Imported source fields/null handling/cost conversion | `src/usage.js` |
| Fingerprint contents | `src/usage.js` |
| Pagination/overlap/synchronization behavior | `src/collector.js` |
| PostgreSQL upsert conflict/update behavior | `src/db.js` |
| OpenCode API discovery/auth | `src/opencode.js` |
| Refresh schedule/control behavior | `src/collector.js`, `src/server.js`, `.env.example`, `compose.yaml` |
| Columns copied into Rill | `rill/models/opencode_usage.yaml` |
| Rill PostgreSQL connection | `rill/connectors/postgres.yaml`, `compose.yaml` |
| Explore visual behavior/defaults | `rill/dashboards/opencode_usage.yaml` |
| Custom visual layout | No current file; would require adding a Canvas/custom dashboard definition rather than editing an existing custom layout |
| Deployment/ports/volumes/health | `compose.yaml`, `Dockerfile.collector`, `Dockerfile.rill` |
| Automated verification | `test/usage.test.js`, `test/collector.test.js`, `test/server.test.js`; Rill model tests in `rill/models/opencode_usage.yaml` |

---

# Final verified conclusions

1. The active pipeline is live API → Node collector → PostgreSQL base table → materialized Rill DuckDB model → metrics view → one Explore dashboard.
2. PostgreSQL and Rill currently agree exactly on request, cost, token, model, provider, and day aggregates.
3. The `$3.18` display is the correctly rounded presentation of stored `$3.17922959`, which exactly equals `317,922,959 / 100,000,000`.
4. The comparison dashes are expected because all data starts June 24 and the May 16–June 14 comparison period has zero rows.
5. The largest unresolved correctness question is token semantics across providers—especially whether output includes reasoning and whether cache categories overlap input. The implementation cannot prove those contracts.
6. The largest synchronization risks are omission of update/delete metadata and using a full-field fingerprint rather than a unique request ID for conflict identity. Neither has produced a current duplicate or aggregate discrepancy.
