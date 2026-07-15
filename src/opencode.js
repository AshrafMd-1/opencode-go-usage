const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");

function headers(config, accept = "text/html") {
  return {
    "User-Agent": "Mozilla/5.0 (X11; Linux aarch64) OpenCode-Usage-Dashboard/1.0",
    Accept: accept,
    Cookie: config.cookieHeader,
    Referer: config.usageUrl,
  };
}

async function fetchText(url, config, accept = "text/html") {
  const response = await fetch(url, { headers: headers(config, accept) });
  if (!response.ok) throw new Error(`HTTP ${response.status} fetching ${new URL(url).origin}${new URL(url).pathname}`);
  return response.text();
}

function parseConfig(env = process.env) {
  const usageUrl = env.OPENCODE_USAGE_URL || "";
  const auth = env.OPENCODE_AUTH || "";
  if (!usageUrl) throw new Error("Missing OPENCODE_USAGE_URL");
  if (!auth) throw new Error("Missing OPENCODE_AUTH");

  let parsed;
  try { parsed = new URL(usageUrl); } catch { throw new Error("OPENCODE_USAGE_URL is invalid"); }
  const match = parsed.pathname.match(/\/workspace\/([^/]+)/);
  if (!match) throw new Error("OPENCODE_USAGE_URL must contain /workspace/<id>/usage");
  return {
    usageUrl: parsed.toString(),
    origin: parsed.origin,
    workspaceId: decodeURIComponent(match[1]),
    cookieHeader: auth.includes("=") ? auth : `auth=${auth}`,
  };
}

async function discoverUsageReference(html, config) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-usage-"));
  fs.writeFileSync(path.join(tempDir, "package.json"), JSON.stringify({ type: "module" }));
  try {
    const assets = [...new Set([...html.matchAll(/(?:src|href)="([^"]+\.js(?:\?[^\"]*)?)"/g)].map(match => match[1]))];
    if (!assets.length) {
      throw new Error("OpenCode usage page contains no JavaScript assets; the auth cookie may have expired or the page format changed");
    }

    const files = [];
    await Promise.all(assets.map(async asset => {
      const url = new URL(asset, config.origin).toString();
      const filename = path.basename(asset.split("?")[0]);
      const file = path.join(tempDir, filename);
      fs.writeFileSync(file, await fetchText(url, config, "application/javascript,*/*"));
      files.push(file);
    }));

    let usageFile;
    let usageCode;
    for (const file of files) {
      const code = fs.readFileSync(file, "utf8");
      if (code.includes("usage.list")) {
        usageFile = file;
        usageCode = code;
        break;
      }
    }
    if (!usageFile) throw new Error("Could not find OpenCode usage.list client bundle");

    const index = usageCode.indexOf("usage.list");
    const nearby = usageCode.slice(Math.max(0, index - 3000), index);
    const references = [...nearby.matchAll(/createServerReference\("([^"]+)"\)/g)];
    const serverId = references.at(-1)?.[1];
    if (!serverId) throw new Error("Could not discover OpenCode usage.list server function ID");

    const runtimeImport = usageCode.match(/from "\.\/([^"]*server-runtime[^"]*\.js)"/);
    let runtimeFile = runtimeImport ? path.join(tempDir, runtimeImport[1]) : "";
    if (!runtimeFile || !fs.existsSync(runtimeFile)) {
      runtimeFile = files.find(file => fs.readFileSync(file, "utf8").includes("function createServerReference")) || "";
    }
    if (!runtimeFile) throw new Error("Could not find OpenCode server runtime bundle");
    return { runtimeFile, serverId, tempDir };
  } catch (error) {
    fs.rmSync(tempDir, { recursive: true, force: true });
    throw error;
  }
}

async function createUsageFetcher(config) {
  const html = await fetchText(config.usageUrl, config);
  const discovered = await discoverUsageReference(html, config);
  let originalFetch;
  try {
    globalThis.self = globalThis;
    const runtime = await import(`${pathToFileURL(discovered.runtimeFile).href}?run=${Date.now()}`);
    const createServerReference = runtime.a || runtime.createServerReference;
    if (!createServerReference) throw new Error("OpenCode server runtime has no createServerReference export");

    originalFetch = globalThis.fetch;
    const realFetch = originalFetch.bind(globalThis);
    globalThis.fetch = (input, init = {}) => {
      let url = typeof input === "string" ? input : input.url;
      if (url.startsWith("/")) url = config.origin + url;
      init.headers = { ...(init.headers || {}), ...headers(config, "*/*") };
      return realFetch(url, init);
    };
    const getUsage = createServerReference(discovered.serverId);

    return {
      async fetchPage(page) {
        const rows = await getUsage(config.workspaceId, page);
        if (!Array.isArray(rows)) throw new Error(`Unexpected OpenCode usage response on page ${page}`);
        return rows;
      },
      close() {
        globalThis.fetch = originalFetch;
        fs.rmSync(discovered.tempDir, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (originalFetch) globalThis.fetch = originalFetch;
    fs.rmSync(discovered.tempDir, { recursive: true, force: true });
    throw error;
  }
}

module.exports = { createUsageFetcher, parseConfig };
