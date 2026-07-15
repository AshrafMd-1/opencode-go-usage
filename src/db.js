const { Pool } = require("pg");

const UPSERT_COLUMNS = [
  "fingerprint", "request_id", "workspace_id", "time_created", "model", "provider", "plan", "session_id", "key_id",
  "input_tokens", "output_tokens", "reasoning_tokens", "cache_read_tokens", "cache_write_5m_tokens",
  "cache_write_1h_tokens", "raw_cost", "cost_usd",
];

function createPool(env = process.env) {
  return new Pool({
    host: env.POSTGRES_HOST || "postgres",
    port: Number(env.POSTGRES_PORT || 5432),
    database: env.POSTGRES_DB || "opencode_usage",
    user: env.POSTGRES_USER || "opencode",
    password: env.POSTGRES_PASSWORD,
    max: 5,
    connectionTimeoutMillis: 10_000,
  });
}

async function waitForDatabase(pool, attempts = 30) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await pool.query("SELECT 1");
      return;
    } catch (error) {
      lastError = error;
      await new Promise(resolve => setTimeout(resolve, Math.min(1000 * attempt, 5000)));
    }
  }
  throw lastError;
}

async function getCachedFingerprints(client) {
  const result = await client.query("SELECT fingerprint FROM usage_requests ORDER BY time_created DESC, fingerprint DESC");
  return result.rows.map(row => row.fingerprint);
}

async function upsertUsageRows(client, rows) {
  if (!rows.length) return { added: 0 };
  const fingerprints = rows.map(row => row.fingerprint);
  const existingResult = await client.query("SELECT fingerprint FROM usage_requests WHERE fingerprint = ANY($1::text[])", [fingerprints]);
  const existing = new Set(existingResult.rows.map(row => row.fingerprint));
  const values = [];
  const tuples = rows.map((row, rowIndex) => {
    const rowValues = [
      row.fingerprint, row.requestId, row.workspaceId, row.timeCreated, row.model, row.provider, row.plan,
      row.sessionId, row.keyId, row.inputTokens, row.outputTokens, row.reasoningTokens, row.cacheReadTokens,
      row.cacheWrite5mTokens, row.cacheWrite1hTokens, row.rawCost, row.costUsd,
    ];
    values.push(...rowValues);
    return `(${rowValues.map((_, columnIndex) => `$${rowIndex * rowValues.length + columnIndex + 1}`).join(", ")})`;
  });

  await client.query(`
    INSERT INTO usage_requests (${UPSERT_COLUMNS.join(", ")})
    VALUES ${tuples.join(",\n")}
    ON CONFLICT (fingerprint) DO UPDATE SET
      request_id = EXCLUDED.request_id,
      workspace_id = EXCLUDED.workspace_id,
      time_created = EXCLUDED.time_created,
      model = EXCLUDED.model,
      provider = EXCLUDED.provider,
      plan = EXCLUDED.plan,
      session_id = EXCLUDED.session_id,
      key_id = EXCLUDED.key_id,
      input_tokens = EXCLUDED.input_tokens,
      output_tokens = EXCLUDED.output_tokens,
      reasoning_tokens = EXCLUDED.reasoning_tokens,
      cache_read_tokens = EXCLUDED.cache_read_tokens,
      cache_write_5m_tokens = EXCLUDED.cache_write_5m_tokens,
      cache_write_1h_tokens = EXCLUDED.cache_write_1h_tokens,
      raw_cost = EXCLUDED.raw_cost,
      cost_usd = EXCLUDED.cost_usd,
      last_seen_at = NOW()
  `, values);
  return { added: rows.reduce((count, row) => count + (existing.has(row.fingerprint) ? 0 : 1), 0) };
}

async function readState(pool) {
  const result = await pool.query("SELECT * FROM collector_state WHERE singleton = TRUE");
  return result.rows[0];
}

async function initializeState(pool, autoRefreshEnabled) {
  await pool.query(
    `INSERT INTO collector_state (singleton, auto_refresh_enabled)
     VALUES (TRUE, $1)
     ON CONFLICT (singleton) DO NOTHING`,
    [autoRefreshEnabled],
  );
  return readState(pool);
}

async function updateState(client, fields) {
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (!entries.length) return;
  const assignments = entries.map(([key], index) => `${key} = $${index + 1}`);
  await client.query(
    `UPDATE collector_state SET ${assignments.join(", ")}, updated_at = NOW() WHERE singleton = TRUE`,
    entries.map(([, value]) => value),
  );
}

module.exports = {
  createPool,
  getCachedFingerprints,
  initializeState,
  readState,
  updateState,
  upsertUsageRows,
  waitForDatabase,
};
