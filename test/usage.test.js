const test = require("node:test");
const assert = require("node:assert/strict");
const { fingerprint, normalizeRow, sanitizeError } = require("../src/usage");

function row(overrides = {}) {
  return {
    id: "usg_1",
    workspaceID: "wrk_1",
    timeCreated: "2026-07-14T12:00:00.000Z",
    model: "model-a",
    provider: "provider-a",
    inputTokens: 10,
    outputTokens: 20,
    reasoningTokens: 3,
    cacheReadTokens: 4,
    cacheWrite5mTokens: 5,
    cacheWrite1hTokens: 6,
    cost: 123456789,
    keyID: "key-1",
    sessionID: "session-1",
    enrichment: { plan: "go" },
    ...overrides,
  };
}

test("fingerprint is stable and includes every overlap field", () => {
  const original = row();
  assert.equal(fingerprint(original), fingerprint(structuredClone(original)));
  const mutations = [
    { id: "usg_2" }, { workspaceID: "wrk_2" }, { timeCreated: "2026-07-14T12:00:01Z" },
    { model: "model-b" }, { provider: "provider-b" }, { inputTokens: 11 }, { outputTokens: 21 },
    { reasoningTokens: 4 }, { cacheReadTokens: 5 }, { cacheWrite5mTokens: 6 },
    { cacheWrite1hTokens: 7 }, { cost: 123456790 }, { keyID: "key-2" }, { sessionID: "session-2" },
    { enrichment: { plan: "free" } },
  ];
  for (const mutation of mutations) assert.notEqual(fingerprint(original), fingerprint(row(mutation)));
});

test("normalization derives precision-safe strings and USD cost", () => {
  const normalized = normalizeRow(row());
  assert.equal(normalized.rawCost, "123456789");
  assert.equal(normalized.costUsd, "1.23456789");
  assert.equal(normalized.inputTokens, "10");
  assert.equal(normalizeRow(row({ timeCreated: "invalid" })), null);
  assert.equal(normalizeRow(row({ inputTokens: -1 })), null);
});

test("errors redact cookies, credentials, and database URLs", () => {
  const cleaned = sanitizeError("Cookie: auth=secret password=hunter2 api_key=provider-credential Bearer bearer-secret postgresql://user:pass@db/name");
  assert.doesNotMatch(cleaned, /secret|hunter2|provider-credential|user:pass/);
  assert.match(cleaned, /REDACTED/);
});
