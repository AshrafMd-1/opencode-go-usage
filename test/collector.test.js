const test = require("node:test");
const assert = require("node:assert/strict");
const { Collector, collectPages } = require("../src/collector");
const { fingerprint } = require("../src/usage");

function rows(count, start = 0) {
  return Array.from({ length: count }, (_, index) => ({
    id: `usg_${start + index}`,
    workspaceID: "wrk_1",
    timeCreated: new Date(Date.UTC(2026, 6, 14, 12, 0, 0) - (start + index) * 1000).toISOString(),
    model: "m",
    provider: "p",
  }));
}

test("pagination detects an overlap spanning a page boundary", async () => {
  const all = rows(100);
  const cached = all.slice(48).map(row => fingerprint(row, "wrk_1"));
  const result = await collectPages(async page => all.slice(page * 50, page * 50 + 50), cached, "wrk_1", 3);
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.overlap.fetchedIndex, 48);
  assert.equal(result.rows.length, 48);
});

test("pagination performs a complete fallback when no overlap exists", async () => {
  const all = rows(53);
  const cached = rows(5, 1000).map(row => fingerprint(row, "wrk_1"));
  const result = await collectPages(async page => all.slice(page * 50, page * 50 + 50), cached, "wrk_1");
  assert.equal(result.pagesFetched, 2);
  assert.equal(result.overlap, null);
  assert.equal(result.fullScan, true);
  assert.equal(result.rows.length, 53);
});

test("pagination stops after the first short page", async () => {
  let calls = 0;
  const result = await collectPages(async () => { calls += 1; return rows(12); }, [], "wrk_1");
  assert.equal(calls, 1);
  assert.equal(result.pagesFetched, 1);
});

test("collector rejects concurrent refreshes before opening a database connection", async () => {
  const collector = new Collector({ pool: { connect() { throw new Error("must not connect"); } } });
  collector.running = true;
  assert.deepEqual(await collector.refresh(), { accepted: false, busy: true });
});

test("collector clears its running flag when database connection fails", async () => {
  const pool = {
    async connect() { throw new Error("database unavailable"); },
    async query() { throw new Error("database unavailable"); },
  };
  const collector = new Collector({ pool });
  await assert.rejects(collector.refresh(), /database unavailable/);
  assert.equal(collector.running, false);
});
