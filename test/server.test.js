const test = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { createControlServer } = require("../src/server");

async function withServer(callback) {
  const state = { auto_refresh_enabled: true, total_rows: "42" };
  const pool = { async query() { return { rows: [state] }; } };
  const collector = {
    running: false,
    refreshCalls: 0,
    async refresh() { this.refreshCalls += 1; return { accepted: true }; },
    async retryRill() { return { ok: true }; },
    async setAutoRefresh(enabled) { state.auto_refresh_enabled = enabled; return state; },
  };
  const server = createControlServer({ collector, pool });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await callback({ base, collector, state }); } finally { server.close(); await once(server, "close"); }
}

test("control page and state endpoint expose no-store responses", async () => withServer(async ({ base }) => {
  const page = await fetch(base);
  assert.equal(page.status, 200);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.match(page.headers.get("content-security-policy"), /frame-ancestors 'none'/);
  assert.match(await page.text(), /Refresh now/);
  const state = await fetch(`${base}/api/state`);
  assert.equal(state.headers.get("cache-control"), "no-store");
  assert.equal((await state.json()).total_rows, "42");
}));

test("manual refresh endpoint accepts one run and reports busy state", async () => withServer(async ({ base, collector }) => {
  let response = await fetch(`${base}/api/refresh`, { method: "POST" });
  assert.equal(response.status, 202);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(collector.refreshCalls, 1);
  collector.running = true;
  response = await fetch(`${base}/api/refresh`, { method: "POST" });
  assert.equal(response.status, 409);
}));

test("cross-origin state changes are rejected", async () => withServer(async ({ base, collector }) => {
  const response = await fetch(`${base}/api/refresh`, {
    method: "POST",
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(response.status, 403);
  assert.equal(collector.refreshCalls, 0);
}));

test("scheduler toggle requires a boolean and persists valid changes", async () => withServer(async ({ base, state }) => {
  let response = await fetch(`${base}/api/auto-refresh`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: false }),
  });
  assert.equal(response.status, 200);
  assert.equal(state.auto_refresh_enabled, false);
  response = await fetch(`${base}/api/auto-refresh`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: "no" }),
  });
  assert.equal(response.status, 400);
}));
