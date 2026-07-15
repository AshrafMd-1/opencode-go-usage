# AGENTS.md

Guidance for coding agents working in this repository.

## Project purpose

This repository is a localhost-only Docker Compose dashboard for OpenCode usage:

```text
OpenCode → Node collector/control service → PostgreSQL → Rill/DuckDB → dashboard
```

It replaces the former `OPC` CLI. Do not reintroduce CLI summaries or the JSON cache unless explicitly requested.

## Important files

- `src/server.js` — control HTTP server and process lifecycle
- `src/collector.js` — refresh scheduling, pagination, database and Rill orchestration
- `src/opencode.js` — OpenCode page/runtime discovery and API fetcher
- `src/usage.js` — fingerprinting, normalization, overlap, and sanitization
- `src/db.js` — PostgreSQL access and parameterized upserts
- `postgres/init.sql` — initial database schema
- `rill/` — Rill connector, model, metrics view, and Explore dashboard
- `compose.yaml` — service topology and loopback-only published ports
- `Dockerfile.rill` — pinned architecture-aware Rill binary and checksums
- `.env.example` — safe configuration template
- `.env` — real secrets; never commit or print

## Security rules

Never commit or print secrets. `OPENCODE_AUTH` is an auth cookie and must be treated as a live credential.

Ignored sensitive/local paths include:

```gitignore
.env
data/
```

Additional requirements:

- Keep PostgreSQL internal to Compose.
- Keep controls and Rill published only on `127.0.0.1` for the MVP.
- Do not expose key IDs, auth cookies, DSNs, raw OpenCode payloads, or stack traces in the controls page/API.
- Keep errors sanitized through `sanitizeError`.
- Rill Developer has no production authentication boundary; never document direct public exposure as safe.

## Collection invariants

Preserve the five-sequential-request overlap logic for incremental updates. The fingerprint intentionally includes:

- request ID
- workspace ID
- timestamp
- model/provider
- input/output/reasoning token counts
- cache-read, 5-minute cache-write, and 1-hour cache-write counts
- raw cost
- key ID/session ID
- plan

Page size is 50. Page snapshots remain disabled. If no overlap is found, fetch to the final short page and use idempotent PostgreSQL upserts.

PostgreSQL is the durable source of truth. Do not import `data/usage.json`; a new database performs a clean refetch.

Manual and automatic refreshes must share one pipeline. Guard runs with both the in-process flag and PostgreSQL advisory lock. A PostgreSQL success must not be rolled back merely because Rill is down; retain state and permit a Rill-only retry.

## Rill conventions

- Keep one request-grain metrics view named `opencode_usage`, displayed as **OpenCode Usage**.
- Do not mix quota snapshots into this metrics view.
- PostgreSQL timestamps are UTC; Rill controls display timezone.
- The collector triggers model refreshes. Do not add a competing Rill cron.
- Rill release archives must be pinned and checksum-verified for both AMD64 and ARM64.

## Dependencies

Keep dependencies minimal. The collector uses Node.js built-ins plus `pg`. Do not add a web framework for the small local controls page without a demonstrated need.

## Verification

Run before finishing code changes:

```bash
npm test
docker compose config --quiet
docker compose build
docker compose up -d
docker compose ps
```

When credentials and network access are available, also verify:

1. an empty volume performs a full refetch;
2. the Rill dashboard loads at `http://localhost:9009`;
3. PostgreSQL and dashboard totals agree;
4. a no-change refresh normally fetches one API page;
5. refresh/toggle state persists across restarts;
6. invalid auth or Rill downtime retains existing data;
7. published ports resolve only to `127.0.0.1`.

Never run `docker compose down -v` without explicit user approval because it permanently deletes the database and Rill volumes.
