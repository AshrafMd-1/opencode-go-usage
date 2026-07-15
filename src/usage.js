const crypto = require("node:crypto");

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function integerString(value) {
  return String(Math.trunc(number(value)));
}

function fingerprintParts(row, defaultWorkspaceId = "") {
  const timestamp = row?.timeCreated ? new Date(row.timeCreated) : null;
  const isoTime = timestamp && Number.isFinite(timestamp.getTime()) ? timestamp.toISOString() : "";
  return [
    row?.id || "",
    row?.workspaceID || defaultWorkspaceId,
    isoTime,
    row?.model || "",
    row?.provider || "",
    number(row?.inputTokens),
    number(row?.outputTokens),
    number(row?.reasoningTokens),
    number(row?.cacheReadTokens),
    number(row?.cacheWrite5mTokens),
    number(row?.cacheWrite1hTokens),
    number(row?.cost),
    row?.keyID || "",
    row?.sessionID || "",
    row?.enrichment?.plan || "",
  ];
}

function fingerprint(row, defaultWorkspaceId = "") {
  return crypto.createHash("sha256").update(JSON.stringify(fingerprintParts(row, defaultWorkspaceId))).digest("hex");
}

function normalizeRow(row, defaultWorkspaceId = "") {
  if (!row || typeof row !== "object") return null;
  const timestamp = new Date(row.timeCreated);
  if (!Number.isFinite(timestamp.getTime())) return null;

  const inputTokens = integerString(row.inputTokens);
  const outputTokens = integerString(row.outputTokens);
  const reasoningTokens = integerString(row.reasoningTokens);
  const cacheReadTokens = integerString(row.cacheReadTokens);
  const cacheWrite5mTokens = integerString(row.cacheWrite5mTokens);
  const cacheWrite1hTokens = integerString(row.cacheWrite1hTokens);
  const rawCost = integerString(row.cost);

  if ([inputTokens, outputTokens, reasoningTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, rawCost].some(v => Number(v) < 0)) {
    return null;
  }

  return {
    fingerprint: fingerprint(row, defaultWorkspaceId),
    requestId: String(row.id || ""),
    workspaceId: String(row.workspaceID || defaultWorkspaceId),
    timeCreated: timestamp.toISOString(),
    model: String(row.model || "unknown"),
    provider: String(row.provider || "unknown"),
    plan: String(row.enrichment?.plan || "unknown"),
    sessionId: String(row.sessionID || ""),
    keyId: String(row.keyID || ""),
    inputTokens,
    outputTokens,
    reasoningTokens,
    cacheReadTokens,
    cacheWrite5mTokens,
    cacheWrite1hTokens,
    rawCost,
    costUsd: String(number(row.cost) / 1e8),
  };
}

function dedupeRows(rows, defaultWorkspaceId = "") {
  const seen = new Set();
  const output = [];
  for (const row of rows) {
    const key = fingerprint(row, defaultWorkspaceId);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(row);
  }
  return output;
}

function findSequentialOverlap(fetchedKeys, cachedKeys, minimumRun = 5) {
  if (!fetchedKeys.length || !cachedKeys.length) return null;
  const positions = new Map();
  cachedKeys.forEach((key, index) => {
    if (!positions.has(key)) positions.set(key, []);
    positions.get(key).push(index);
  });
  const needed = Math.min(minimumRun, cachedKeys.length);

  for (let fetchedIndex = 0; fetchedIndex < fetchedKeys.length; fetchedIndex += 1) {
    for (const cachedIndex of positions.get(fetchedKeys[fetchedIndex]) || []) {
      let count = 0;
      while (
        fetchedIndex + count < fetchedKeys.length &&
        cachedIndex + count < cachedKeys.length &&
        fetchedKeys[fetchedIndex + count] === cachedKeys[cachedIndex + count]
      ) count += 1;
      if (count >= needed) return { fetchedIndex, cachedIndex, count };
    }
  }
  return null;
}

function sanitizeError(error) {
  let message = String(error?.message || error || "Unknown error");
  message = message
    .replace(/auth=[^\s;"']+/gi, "auth=[REDACTED]")
    .replace(/(password|passwd|pwd)=([^\s&;]+)/gi, "$1=[REDACTED]")
    .replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "postgresql://[REDACTED]")
    .replace(/Cookie:\s*[^\r\n]+/gi, "Cookie: [REDACTED]");
  return message.slice(0, 1000);
}

module.exports = {
  dedupeRows,
  findSequentialOverlap,
  fingerprint,
  fingerprintParts,
  normalizeRow,
  number,
  sanitizeError,
};
