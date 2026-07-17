const { fingerprint, normalizeRow, sanitizeError } = require("./usage");
const { createUsageFetcher, parseConfig } = require("./opencode");
const {
  getCachedFingerprints,
  readState,
  updateState,
  upsertUsageRows,
} = require("./db");

const ADVISORY_LOCK_ID = 73024191;

async function collectPages(fetchPage, cachedKeys, workspaceId, maxPages = 5000) {
  const fetched = [];
  let overlap = null;
  let pagesFetched = 0;
  const cachedPositions = new Map();
  cachedKeys.forEach((key, index) => {
    if (!cachedPositions.has(key)) cachedPositions.set(key, []);
    cachedPositions.get(key).push(index);
  });
  const needed = Math.min(5, cachedKeys.length);

  for (let page = 0; page < maxPages; page += 1) {
    const rows = await fetchPage(page);
    pagesFetched += 1;
    fetched.push(...rows);

    if (cachedKeys.length) {
      const keys = fetched.map(row => fingerprint(row, workspaceId));
      const scanStart = Math.max(0, fetched.length - rows.length - 4);
      outer: for (let i = scanStart; i < keys.length; i += 1) {
        for (const cachedIndex of cachedPositions.get(keys[i]) || []) {
          let count = 0;
          while (i + count < keys.length && cachedIndex + count < cachedKeys.length && keys[i + count] === cachedKeys[cachedIndex + count]) count += 1;
          if (count >= needed) {
            overlap = { fetchedIndex: i, cachedIndex, count };
            break outer;
          }
        }
      }
      if (overlap) break;
    }

    if (rows.length < 50) break;
    if (page === maxPages - 1) throw new Error(`Pagination exceeded safety limit of ${maxPages} pages`);
  }

  return {
    pagesFetched,
    overlap,
    rows: overlap ? fetched.slice(0, overlap.fetchedIndex) : fetched,
    fullScan: !cachedKeys.length || !overlap,
  };
}

class Collector {
  constructor({ pool, intervalMinutes = 360, rillUrl = "http://rill:9009" }) {
    this.pool = pool;
    this.intervalMs = Math.max(1, Number(intervalMinutes) || 360) * 60_000;
    this.rillUrl = rillUrl.replace(/\/$/, "");
    this.running = false;
    this.timer = null;
  }

  async schedule() {
    clearTimeout(this.timer);
    this.timer = null;
    const state = await readState(this.pool);
    if (!state.auto_refresh_enabled) {
      await updateState(this.pool, { next_run_at: null });
      return;
    }
    const nextRun = new Date(Date.now() + this.intervalMs);
    await updateState(this.pool, { next_run_at: nextRun });
    this.timer = setTimeout(() => {
      this.refresh("scheduled")
        .catch(error => console.error(`Scheduled refresh failed: ${sanitizeError(error)}`))
        .finally(() => this.schedule().catch(error => console.error(`Scheduler setup failed: ${sanitizeError(error)}`)));
    }, this.intervalMs);
    this.timer.unref?.();
  }

  async setAutoRefresh(enabled) {
    await updateState(this.pool, { auto_refresh_enabled: Boolean(enabled) });
    await this.schedule();
    return readState(this.pool);
  }

  async refresh(reason = "manual") {
    if (this.running) return { accepted: false, busy: true };
    this.running = true;
    let client;
    let locked = false;
    let fetcher;
    const startedAt = new Date();
    try {
      client = await this.pool.connect();
      const lock = await client.query("SELECT pg_try_advisory_lock($1) AS locked", [ADVISORY_LOCK_ID]);
      locked = lock.rows[0].locked;
      if (!locked) return { accepted: false, busy: true };

      await updateState(client, {
        last_started_at: startedAt,
        last_completed_at: null,
        last_success: null,
        last_error: null,
        last_reason: reason,
      });

      const config = parseConfig();
      const cachedKeys = await getCachedFingerprints(client);
      fetcher = await createUsageFetcher(config);
      const collected = await collectPages(fetcher.fetchPage, cachedKeys, config.workspaceId);
      fetcher.close();
      fetcher = null;
      const normalized = [];
      const seen = new Set();
      let invalidRows = 0;
      for (const raw of collected.rows) {
        const row = normalizeRow(raw, config.workspaceId);
        if (!row) {
          invalidRows += 1;
          continue;
        }
        if (seen.has(row.fingerprint)) continue;
        seen.add(row.fingerprint);
        normalized.push(row);
      }

      await client.query("BEGIN");
      let added = 0;
      for (let index = 0; index < normalized.length; index += 500) {
        const result = await upsertUsageRows(client, normalized.slice(index, index + 500));
        added += result.added;
      }
      const totalResult = await client.query("SELECT COUNT(*)::bigint AS count FROM usage_requests");
      const total = totalResult.rows[0].count;
      await updateState(client, {
        last_completed_at: new Date(),
        last_success: true,
        last_error: invalidRows ? `${invalidRows} malformed row(s) skipped` : null,
        pages_fetched: collected.pagesFetched,
        rows_added: added,
        invalid_rows: invalidRows,
        total_rows: total,
      });
      await client.query("COMMIT");

      let rill;
      try {
        rill = await this.retryRill();
      } catch (error) {
        rill = { ok: false, error: sanitizeError(error) };
      }
      return { accepted: true, busy: false, added, total, invalidRows, pagesFetched: collected.pagesFetched, rill };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch {}
      const message = sanitizeError(error);
      await updateState(client || this.pool, {
        last_completed_at: new Date(),
        last_success: false,
        last_error: message,
      }).catch(() => {});
      throw new Error(message);
    } finally {
      fetcher?.close();
      if (locked) await client.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_ID]).catch(() => {});
      client?.release();
      this.running = false;
    }
  }

  async retryRill() {
    try {
      return await this.triggerRill();
    } catch (error) {
      const message = sanitizeError(error);
      await updateState(this.pool, { last_rill_status: `failed: ${message}`, last_rill_trigger_at: new Date() });
      throw new Error(message);
    }
  }

  async triggerRill() {
    const instancesResponse = await fetch(`${this.rillUrl}/v1/instances`, { signal: AbortSignal.timeout(10_000) });
    if (!instancesResponse.ok) throw new Error(`Rill instance discovery returned HTTP ${instancesResponse.status}`);
    const body = await instancesResponse.json();
    const instanceId = body.instances?.[0]?.instanceId || body.instances?.[0]?.instance_id;
    if (!instanceId) throw new Error("Rill has no active local project instance");

    const triggerResponse = await fetch(`${this.rillUrl}/v1/instances/${encodeURIComponent(instanceId)}/trigger`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ models: [{ model: "opencode_usage" }] }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!triggerResponse.ok) throw new Error(`Rill model trigger returned HTTP ${triggerResponse.status}`);
    await updateState(this.pool, { last_rill_status: "accepted", last_rill_trigger_at: new Date() });
    return { ok: true, instanceId };
  }
}

module.exports = { Collector, collectPages };
