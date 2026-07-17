# AGENTS.md

Guidance for coding agents working in this repository.

## Project purpose

This repository is a self-hosted Docker Compose dashboard for OpenCode usage:

```text
OpenCode → Node collector/control service → PostgreSQL → Rill/DuckDB → dashboard
```

The supported product is the collector, PostgreSQL store, controls page, and Rill dashboard. Do not add separate reporting surfaces or file-based caches.

## Important files

- `src/server.js` — control HTTP server and process lifecycle
- `src/collector.js` — refresh scheduling, pagination, database and Rill orchestration
- `src/opencode.js` — OpenCode page/runtime discovery and API fetcher
- `src/usage.js` — fingerprinting, normalization, overlap, and sanitization
- `src/db.js` — PostgreSQL access and parameterized upserts
- `postgres/init.sql` — initial database schema
- `rill/` — Rill data/AI connectors, model, metrics view, and Explore dashboard
- `rill/connectors/openai.yaml` — OpenAI-compatible Rill AI connector using environment references only
- `compose.yaml` — service topology and loopback-only published ports
- `Dockerfile.rill` — pinned architecture-aware Rill binary and checksums
- `.env.example` — safe configuration template
- `.env` — real secrets; never commit or print

## Security rules

Never commit or print secrets. `OPENCODE_AUTH` is an auth cookie and `OPENAI_API_KEY` is an AI-provider credential; both must be treated as live credentials.

The ignored `.env` file contains live local secrets and must never be read aloud, printed, or committed. Keep AI credentials in `.env`/deployment secrets and reference them from connector YAML; never embed them in tracked files.

Additional requirements:

- Keep PostgreSQL internal to Compose.
- Keep direct host bindings for controls and Rill on `127.0.0.1`; remote access must pass through an authenticated proxy such as Coolify plus Cloudflare Access.
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

PostgreSQL is the durable source of truth. A new database performs a clean refetch from OpenCode.

Manual and automatic refreshes must share one pipeline. Guard runs with both the in-process flag and PostgreSQL advisory lock. A PostgreSQL success must not be rolled back merely because Rill is down; retain state and permit a Rill-only retry.

## Rill conventions

- Keep one request-grain metrics view named `opencode_usage`, displayed as **OpenCode Usage**.
- Keep Rill AI on the tracked `openai` connector, with API key, compatible base URL, and model supplied through runtime environment variables.
- Do not mix quota snapshots into this metrics view.
- PostgreSQL timestamps are UTC; Rill controls display timezone.
- The collector triggers model refreshes. Do not add a competing Rill cron.
- Rill release archives must be pinned and checksum-verified for both AMD64 and ARM64.
- Keep Rill in `--preview` mode for its dashboard-only interface; Cloudflare Access provides the authentication boundary for remote deployment.

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
