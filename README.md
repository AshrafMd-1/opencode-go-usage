# OPC — OpenCode Usage CLI

`OPC` is a small Bash/Node script that shows your OpenCode usage with full pagination, local caching, quota reset times, and cost breakdowns.

It is designed to fix the main limitation of the OpenCode web usage table: the web UI only shows paginated rows, while `OPC` fetches and merges all usage records so totals are accurate.

## What it shows

Running:

```bash
./OPC
```

shows:

- OpenCode Go quota windows:
  - rolling/session usage
  - weekly usage
  - monthly usage
  - reset duration and exact reset time
- request count and spend for:
  - today
  - last 7 days
  - this month
  - all time
- by-model breakdown:
  - requests
  - input tokens
  - cache read tokens
  - cache write tokens
  - input + cache tokens
  - output tokens
  - reasoning tokens
  - cost

Optional views:

```bash
./OPC --by-day
```

Shows daily request/token/cost breakdown.

```bash
./OPC --latest 20
```

Shows the latest 20 raw usage requests.

```bash
./OPC --json
```

Prints a machine-readable JSON summary.

## Files

```text
usage/
  OPC             # executable script
  .env            # local config with your OpenCode URL/auth
  .env.example    # config template
  README.md       # this file
  data/
    usage.json    # merged cached usage records
    meta.json     # cache/fetch metadata
```

`data/pages/` is **not** created by default. Page snapshots are only written when debugging with `--save-pages`.

## Setup

Copy/edit `.env` next to the `OPC` script:

```bash
OPENCODE_USAGE_URL=https://opencode.ai/workspace/<workspace-id>/usage
OPENCODE_AUTH=<raw auth cookie value>
```

`OPENCODE_AUTH` can be either:

```bash
OPENCODE_AUTH=actual_cookie_value_here
```

or a full cookie-style value:

```bash
OPENCODE_AUTH=auth=actual_cookie_value_here
```

Optional:

```bash
OPC_DATA_DIR=./data
```

Relative `OPC_DATA_DIR` paths are resolved relative to the script directory.

## Run from anywhere

Add this directory to your shell PATH in `~/.zshrc`:

```bash
export PATH="/Users/ashraf/Documents/Projects/Scripts/usage:$PATH"
```

Then reload your shell:

```bash
source ~/.zshrc
```

Now you can run:

```bash
OPC
```

from any terminal directory.

## How it works

### 1. Loads config

`OPC` first loads `.env` from the same directory as the script.

Then it reads:

- `OPENCODE_USAGE_URL`
- `OPENCODE_AUTH`
- optional `OPC_DATA_DIR`

Shell environment variables override `.env` values if already set.

### 2. Fetches the OpenCode usage page

It requests your OpenCode usage page using the auth cookie.

Example URL shape:

```text
https://opencode.ai/workspace/<workspace-id>/usage
```

### 3. Discovers OpenCode's internal usage API

OpenCode does not expose the table as a simple static JSON endpoint in the page.

So `OPC` reads the page's JavaScript assets and dynamically finds the internal SolidStart server function used by the web UI for:

```text
usage.list
```

This is the same function the OpenCode web page uses when you click pagination.

### 4. Fetches paginated usage rows

OpenCode usage pages are fetched in pages of 50 requests.

On first run, `OPC` fetches every page until the final page has fewer than 50 rows.

Then it merges all rows into:

```text
data/usage.json
```

### 5. Uses incremental cache after first run

On later runs, `OPC` avoids refetching all historical pages.

It fetches page 0, then checks whether at least 5 sequential fetched requests match 5 sequential cached requests.

The overlap check uses a full request fingerprint, not just the OpenCode ID:

- request id
- workspace id
- timestamp
- model
- provider
- input tokens
- output tokens
- reasoning tokens
- cache read tokens
- cache write tokens
- cost
- key id
- session id
- plan

If overlap is found:

1. requests above the overlap are treated as new
2. new requests are prepended to the existing cache
3. duplicated records are removed
4. fetching stops early

This keeps the command fast while preserving accurate all-time totals.

### 6. Parses quota/reset windows

For OpenCode Go quota bars, `OPC` fetches:

```text
https://opencode.ai/workspace/<workspace-id>/go
```

It parses the page data for:

- rolling usage
- weekly usage
- monthly usage
- reset seconds

Then it displays both relative reset time and exact local reset time.

## Commands

```bash
OPC
```

Default summary.

```bash
OPC --by-day
```

Include daily breakdown.

```bash
OPC --latest 20
```

Show latest 20 usage requests.

```bash
OPC --refresh
```

Ignore cache and refetch all pages.

```bash
OPC --save-pages
```

Debug mode: save fetched page snapshots under `data/pages/`.

```bash
OPC --json
```

Output JSON summary.

```bash
OPC --utc
```

Group/display dates in UTC instead of local time.

```bash
OPC --help
```

Show help.

## Cache behavior

Normal cache files:

```text
data/usage.json
data/meta.json
```

Debug page snapshots are disabled by default to avoid unnecessary disk writes.

If you want to rebuild everything:

```bash
OPC --refresh
```

If you want to delete cache manually:

```bash
rm -rf data
```

Then run:

```bash
OPC
```

## Security note

`.env` contains your OpenCode auth cookie. Do not commit it or share it.

If this directory ever becomes a git repo, add this to `.gitignore`:

```gitignore
.env
data/
```
