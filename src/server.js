const http = require("node:http");
const { URL } = require("node:url");
const { Collector } = require("./collector");
const { createPool, initializeState, readState, waitForDatabase } = require("./db");
const { sanitizeError } = require("./usage");

const CONTROL_PORT = Number(process.env.CONTROL_PORT || 3000);
const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>OpenCode Usage Controls</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { max-width: 760px; margin: 0 auto; padding: 3rem 1.25rem; background: #0b1020; color: #e8ecf7; }
    h1 { margin-bottom: .3rem; } .muted { color: #a9b2c7; line-height: 1.5; }
    .card { background: #151c30; border: 1px solid #29324c; border-radius: 14px; padding: 1.25rem; margin: 1rem 0; }
    .actions { display: flex; gap: .75rem; flex-wrap: wrap; align-items: center; }
    button, .button { border: 0; border-radius: 8px; padding: .72rem 1rem; font-weight: 650; cursor: pointer; background: #6d7cff; color: white; text-decoration: none; }
    button.secondary { background: #303a57; } button:disabled { opacity: .55; cursor: wait; }
    dl { display: grid; grid-template-columns: minmax(135px, 1fr) 2fr; gap: .7rem 1rem; }
    dt { color: #9da9c3; } dd { margin: 0; overflow-wrap: anywhere; }
    .ok { color: #75db9b; } .bad { color: #ff8b8b; } code { color: #bdc7ff; }
  </style>
</head>
<body>
  <h1>OpenCode Usage</h1>
  <p class="muted">These controls fetch new records from OpenCode, store them in PostgreSQL, and ask Rill to reload its analytics model.</p>
  <div class="card actions">
    <button id="refresh">Refresh now</button>
    <button id="rill" class="secondary">Retry Rill only</button>
    <button id="toggle" class="secondary">Loading…</button>
    <a class="button" href="http://localhost:9009" target="_blank" rel="noreferrer">Open dashboard</a>
  </div>
  <div class="card"><dl id="state"><dt>Status</dt><dd>Loading…</dd></dl></div>
  <p class="muted">Changing dashboard filters only re-queries data already loaded into Rill. <strong>Refresh now</strong> updates the complete OpenCode → PostgreSQL → Rill pipeline. The automatic interval is 6 hours by default.</p>
<script>
const $ = id => document.getElementById(id);
const fmt = value => value ? new Date(value).toLocaleString() : "—";
async function request(path, options) {
  const response = await fetch(path, options);
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || "Request failed");
  return body;
}
async function load() {
  try {
    const s = await request('/api/state');
    $('toggle').textContent = s.auto_refresh_enabled ? 'Disable auto-refresh' : 'Enable auto-refresh';
    $('toggle').dataset.enabled = String(s.auto_refresh_enabled);
    const status = s.running ? 'Refreshing…' : (s.last_success == null ? 'Not run yet' : (s.last_success ? 'Successful' : 'Failed'));
    $('state').innerHTML =
      '<dt>Last refresh</dt><dd class="' + (s.last_success === false ? 'bad' : 'ok') + '">' + status + '</dd>' +
      '<dt>Started</dt><dd>' + fmt(s.last_started_at) + '</dd>' +
      '<dt>Completed</dt><dd>' + fmt(s.last_completed_at) + '</dd>' +
      '<dt>Next automatic run</dt><dd>' + fmt(s.next_run_at) + '</dd>' +
      '<dt>Rows added</dt><dd>' + (s.rows_added ?? 0) + '</dd>' +
      '<dt>Total rows</dt><dd>' + (s.total_rows ?? 0) + '</dd>' +
      '<dt>API pages fetched</dt><dd>' + (s.pages_fetched ?? 0) + '</dd>' +
      '<dt>Rill trigger</dt><dd id="rill-status"></dd>' +
      '<dt>Message</dt><dd class="' + (s.last_success === false ? 'bad' : '') + '"></dd>';
    $('rill-status').textContent = s.last_rill_status || '—';
    $('state').lastElementChild.textContent = s.last_error || '—';
  } catch (error) { $('state').textContent = error.message; }
}
async function act(button, path, body) {
  button.disabled = true;
  try { await request(path, { method: 'POST', headers: {'content-type':'application/json'}, body: JSON.stringify(body || {}) }); }
  catch (error) { alert(error.message); }
  finally { button.disabled = false; await load(); }
}
$('refresh').onclick = () => act($('refresh'), '/api/refresh');
$('rill').onclick = () => act($('rill'), '/api/rill-refresh');
$('toggle').onclick = () => act($('toggle'), '/api/auto-refresh', { enabled: $('toggle').dataset.enabled !== 'true' });
load(); setInterval(load, 5000);
</script>
</body></html>`;

function json(response, status, payload) {
  const data = JSON.stringify(payload);
  response.writeHead(status, { ...SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(data), "cache-control": "no-store" });
  response.end(data);
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 4096) throw new Error("Request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function createControlServer({ collector, pool }) {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      const origin = request.headers.origin;
      if (request.method === "POST" && origin) {
        let originHost;
        try { originHost = new URL(origin).host; } catch { return json(response, 403, { error: "Cross-origin request rejected" }); }
        if (originHost !== request.headers.host) return json(response, 403, { error: "Cross-origin request rejected" });
      }
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, { ...SECURITY_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
        return response.end(HTML);
      }
      if (request.method === "GET" && url.pathname === "/health") return json(response, 200, { ok: true });
      if (request.method === "GET" && url.pathname === "/api/state") return json(response, 200, { ...(await readState(pool)), running: collector.running });
      if (request.method === "POST" && url.pathname === "/api/refresh") {
        if (collector.running) return json(response, 409, { error: "A refresh is already running" });
        collector.refresh("manual").catch(error => console.error(`Manual refresh failed: ${sanitizeError(error)}`));
        return json(response, 202, { accepted: true });
      }
      if (request.method === "POST" && url.pathname === "/api/rill-refresh") {
        if (collector.running) return json(response, 409, { error: "A usage refresh is currently running" });
        const result = await collector.retryRill();
        return json(response, 200, result);
      }
      if (request.method === "POST" && url.pathname === "/api/auto-refresh") {
        const body = await readJson(request);
        if (typeof body.enabled !== "boolean") return json(response, 400, { error: "enabled must be a boolean" });
        return json(response, 200, await collector.setAutoRefresh(body.enabled));
      }
      return json(response, 404, { error: "Not found" });
    } catch (error) {
      return json(response, 500, { error: sanitizeError(error) });
    }
  });
}

async function main() {
  const pool = createPool();
  await waitForDatabase(pool);
  const initialAutoRefresh = !["0", "false", "no", "off"].includes(String(process.env.AUTO_REFRESH_ENABLED || "true").toLowerCase());
  const initialState = await initializeState(pool, initialAutoRefresh);
  const collector = new Collector({
    pool,
    intervalMinutes: process.env.AUTO_REFRESH_INTERVAL_MINUTES || 360,
    rillUrl: process.env.RILL_INTERNAL_URL || "http://rill:9009",
  });
  const server = createControlServer({ collector, pool });
  server.listen(CONTROL_PORT, "0.0.0.0", () => console.log(`Control page listening on port ${CONTROL_PORT}`));

  const shouldRefreshOnStartup = initialState.auto_refresh_enabled || Number(initialState.total_rows || 0) === 0;
  const startup = shouldRefreshOnStartup
    ? collector.refresh("startup").catch(error => console.error(`Startup refresh failed: ${sanitizeError(error)}`))
    : Promise.resolve();
  startup.finally(() => collector.schedule().catch(error => console.error(`Scheduler setup failed: ${sanitizeError(error)}`)));

  const shutdown = async () => {
    clearTimeout(collector.timer);
    server.close();
    await pool.end();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (require.main === module) main().catch(error => {
  console.error(`Collector failed to start: ${sanitizeError(error)}`);
  process.exit(1);
});

module.exports = { createControlServer, readJson };
