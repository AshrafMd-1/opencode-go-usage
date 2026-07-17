const test = require("node:test");
const assert = require("node:assert/strict");
const { parseConfig } = require("../src/opencode");

test("OpenCode config wraps raw cookie values even when they contain base64 padding", () => {
  const config = parseConfig({
    OPENCODE_USAGE_URL: "https://opencode.ai/workspace/wrk_1/usage",
    OPENCODE_AUTH: "raw-token==",
  });
  assert.equal(config.cookieHeader, "auth=raw-token==");
  assert.equal(config.workspaceId, "wrk_1");
});

test("OpenCode config preserves an explicit cookie header", () => {
  const config = parseConfig({
    OPENCODE_USAGE_URL: "https://opencode.ai/workspace/wrk_1/usage",
    OPENCODE_AUTH: "auth=token; other=value",
  });
  assert.equal(config.cookieHeader, "auth=token; other=value");
});
