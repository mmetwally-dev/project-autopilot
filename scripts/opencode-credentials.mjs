// OpenCode 2 sandbox provider credentials.
//
// OpenCode 1.x keeps provider keys in auth.json, which the bubblewrap
// envelope already exposes through the adapter's permission_files. OpenCode
// 2.x keeps them in its own data store (opencode.db under
// $XDG_DATA_HOME/opencode), so a sandbox with a fresh HOME knows only the
// built-in free `opencode` provider and a paid model fails with
// PROVIDER_ERROR `provider.no-route` "Model unavailable".
//
// The least-exposure fix uses the official commands only:
//   host:    opencode auth export <provider>            (stdout is a secret)
//   sandbox: opencode auth import                       (reads stdin)
// The secret is piped directly from one child's stdout into the other's
// stdin. It never touches argv, a file outside the private XDG data root,
// or any log/run/state artifact. The private root is a fresh 0700 directory
// removed after the relay; the implementer reuses its persistent per-task
// session store as that root so there is exactly one adapter data dir.
//
// 1.x and the built-in `opencode` provider never take this path: their
// launches are byte-for-byte unchanged.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawn} from "node:child_process";
import {spawnAgentSync} from "./agent-process.mjs";
import {
  OPENCODE_GENERATION_2,
  detectOpenCodeGeneration,
  isOpenCodeAdapter
} from "./opencode-generation.mjs";

// The adapter data dir inside the envelope, relative to SANDBOX_HOME.
export const OPENCODE_SANDBOX_DATA_SUBPATH = ".local/share/opencode";
export const OPENCODE_CREDENTIAL_TEMP_PREFIX = "ap-opencode-credentials-";

export const AUTH_REQUIRED_FAILURE_CLASS = "AUTH_REQUIRED";

// "deepseek/deepseek-flash#low" -> "deepseek". No slash (a bare model id, or
// the CLI default) has no provider to export, so it returns null.
export function openCodeModelProvider(model) {
  const text = String(model ?? "").trim();
  if (!text) return null;
  const hash = text.indexOf("#");
  const base = hash >= 0 ? text.slice(0, hash) : text;
  const slash = base.indexOf("/");
  if (slash <= 0) return null;
  return base.slice(0, slash).trim() || null;
}

// True only for an OpenCode 2 role whose model names a non-built-in
// provider. Every caller uses this one predicate, and the generation answer
// comes from the existing scripts/opencode-generation.mjs probe/cache (never
// a second probe).
export function openCodeSandboxCredentialsRequired({
  adapterId = null,
  adapter = null,
  model = "",
  detect = detectOpenCodeGeneration
} = {}) {
  const opencode = adapterId === "opencode" || isOpenCodeAdapter(adapter);
  if (!opencode) return false;
  const provider = openCodeModelProvider(model);
  if (!provider || provider.toLowerCase() === "opencode") return false;
  return detect(adapter) === OPENCODE_GENERATION_2;
}

// `opencode auth list` prints one integration per line (no secrets). Accept
// the first column of every non-header line, case-insensitively: the real
// 2.x output starts with the integration id/name ("DeepSeek  DeepSeek
// stored"), and tests/future formats use "deepseek  DeepSeek  stored".
export function parseOpenCodeAuthList(text) {
  const providers = new Set();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^(?:name|provider|integration|id)\b/i.test(trimmed)) continue;
    const first = trimmed.replace(/^[-*•]\s*/, "").split(/\s+/)[0];
    if (!first || !/^[A-Za-z0-9._/-]+$/.test(first)) continue;
    providers.add(first.toLowerCase());
  }
  return [...providers];
}

export function openCodeAuthListProviders({binary = "opencode", spawnImpl = spawnAgentSync} = {}) {
  let result;
  try {
    result = spawnImpl(binary || "opencode", ["auth", "list"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000
    });
  } catch {
    return {ok: false, providers: []};
  }
  const providers = parseOpenCodeAuthList(result?.stdout || "");
  return {ok: result?.status === 0, providers};
}

function authRequiredError(provider) {
  const error = new Error(
    `AUTH_REQUIRED: OpenCode 2 has no stored credential for provider '${provider}' available to the sandbox. `
    + "Fix it with `opencode auth login` on OpenCode 2 (select that provider), then retry."
  );
  error.failureClass = AUTH_REQUIRED_FAILURE_CLASS;
  error.provider = provider;
  return error;
}

// OpenCode 2.2.0 exports a JSON array of stored accounts
// ([{id, integrationID, label, active, value}]). Older builds exported an
// object keyed by provider. Accept both; only the integration id identifies
// the provider in the array form.
export function exportHasProvider(text, provider) {
  try {
    const parsed = JSON.parse(String(text ?? ""));
    const wanted = String(provider ?? "").toLowerCase();
    if (Array.isArray(parsed)) {
      return parsed.some((entry) =>
        entry != null && typeof entry === "object" && !Array.isArray(entry)
        && typeof entry.integrationID === "string"
        && entry.integrationID.toLowerCase() === wanted);
    }
    if (!parsed || typeof parsed !== "object") return false;
    return Object.keys(parsed).some((key) =>
      key.toLowerCase() === wanted && parsed[key] != null && typeof parsed[key] === "object");
  } catch {
    return false;
  }
}

function ensurePrivateDirectory(directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  try { fs.chmodSync(directory, 0o700); } catch { /* Windows/FS without POSIX modes */ }
}

// Pipe `opencode auth export <provider>` straight into `opencode auth import`
// with the private XDG root as its data home. The export bytes are buffered in
// memory only to validate that the provider is actually present; the buffer is
// never written to disk, logged, attached to an error, or persisted.
export function importOpenCodeProviderCredentials({
  binary = "opencode",
  provider,
  xdgRoot,
  spawnImpl = spawn
} = {}) {
  return new Promise((resolve, reject) => {
    let exportClosed = false;
    let importClosed = false;
    let exportStatus = null;
    let importStatus = null;
    let settled = false;
    let exportText = "";
    let exportError = null;
    let importError = null;

    // The host-side export must read the operator's real data store, which may
    // live under a non-default XDG_DATA_HOME (OpenCode 2 installs commonly set
    // XDG_DATA_HOME=~/.opencode2/xdg/data). childEnv therefore inherits the
    // operator's env verbatim, XDG_* included. Only the sandbox-side import is
    // redirected to the private xdgRoot; its credential bytes never touch the
    // operator's store.
    const childEnv = {...process.env};
    const importEnv = {
      ...childEnv,
      XDG_DATA_HOME: xdgRoot,
      XDG_STATE_HOME: path.join(xdgRoot, "state"),
      XDG_CACHE_HOME: path.join(xdgRoot, "cache")
    };

    let exportChild;
    let importChild;
    try {
      exportChild = spawnImpl(binary || "opencode", ["auth", "export", provider], {
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      });
      // 2.x routes `opencode auth ...` through its shared background service
      // unless --standalone is passed. With a private XDG root the shared
      // service reports "Managed service port 49374 ... already in use", so
      // the import must run standalone against that root.
      importChild = spawnImpl(binary || "opencode", ["auth", "import", "--standalone"], {
        env: importEnv,
        stdio: ["pipe", "pipe", "pipe"],
        shell: false,
        windowsHide: true
      });
    } catch {
      reject(authRequiredError(provider));
      return;
    }

    // Drain the import child's stdout; only stderr is useful for a generic
    // failure, and even that is never surfaced (it could echo input).
    importChild.stdout?.resume();
    importChild.stderr?.resume();
    exportChild.stderr?.resume();
    // The import child may exit before the export stream ends; writing to a
    // closed stdin is expected and must not become an unhandled error.
    importChild.stdin?.on("error", () => {});

    const settle = () => {
      if (settled || !exportClosed || !importClosed) return;
      settled = true;
      if (exportError || importError || exportStatus !== 0 || importStatus !== 0 || !exportHasProvider(exportText, provider)) {
        reject(authRequiredError(provider));
        return;
      }
      resolve({provider});
    };

    exportChild.stdout?.on("data", (chunk) => {
      exportText += chunk.toString("utf8");
      try {
        if (!importChild.stdin?.destroyed) importChild.stdin.write(chunk);
      } catch { /* import exited early; settle() reports the failure */ }
    });
    exportChild.stdout?.on("end", () => {
      try { importChild.stdin?.end(); } catch { /* already closed */ }
    });

    exportChild.on("error", () => { exportError = true; });
    importChild.on("error", () => { importError = true; });
    exportChild.on("close", (status) => { exportStatus = status; exportClosed = true; settle(); });
    importChild.on("close", (status) => { importStatus = status; importClosed = true; settle(); });
  });
}

// Resolve the XDG root to import into. An implementer already has a
// persistent per-task session-store bind at the sandbox data path; reuse its
// host dir as the XDG root instead of creating a second data dir.
export function openCodeCredentialDataRoot({sessionStoreMounts = [], sandboxDataPath} = {}) {
  const match = (Array.isArray(sessionStoreMounts) ? sessionStoreMounts : [])
    .find((mount) => mount && mount.sandbox === sandboxDataPath && typeof mount.host === "string");
  return match ? match.host : null;
}

// Prepare (and import into) the private data root for one launch. Returns
// null when this role needs nothing (1.x / built-in provider / bare model).
// `existingDataRoot` is the implementer's session store: it is imported into
// directly and never removed. Otherwise a fresh 0700 temp root is created and
// its cleanup() removes it after the relay (success, failure or kill).
export async function prepareOpenCodeSandboxCredentials({
  adapter = null,
  adapterId = null,
  model = "",
  sandboxDataPath,
  existingDataRoot = null,
  spawnImpl = spawn
} = {}) {
  const provider = openCodeModelProvider(model);
  if (!provider || provider.toLowerCase() === "opencode") return null;
  const opencode = adapterId === "opencode" || isOpenCodeAdapter(adapter);
  if (!opencode) return null;

  const temporary = !existingDataRoot;
  let xdgRoot = existingDataRoot;
  if (!xdgRoot) {
    xdgRoot = fs.mkdtempSync(path.join(os.tmpdir(), OPENCODE_CREDENTIAL_TEMP_PREFIX));
  }
  ensurePrivateDirectory(xdgRoot);
  const dataDir = path.join(xdgRoot, "opencode");
  ensurePrivateDirectory(dataDir);

  try {
    await importOpenCodeProviderCredentials({
      binary: adapter?.binary || "opencode",
      provider,
      xdgRoot,
      spawnImpl
    });
  } catch (error) {
    if (temporary) {
      try { fs.rmSync(xdgRoot, {recursive: true, force: true}); } catch { /* best-effort */ }
    }
    throw error;
  }

  let removed = false;
  return {
    provider,
    xdgRoot,
    dataDir,
    temporary,
    mount: {host: dataDir, sandbox: sandboxDataPath},
    cleanup() {
      if (!temporary || removed) return;
      removed = true;
      try { fs.rmSync(xdgRoot, {recursive: true, force: true}); } catch { /* best-effort */ }
    }
  };
}

// Mission-start preflight (backlog #14, beside preflightPrimaryModels): for
// every OpenCode 2 role naming a non-`opencode` provider, `opencode auth list`
// must actually list that provider on the host. It is deliberately
// injectable (listProviders/detect) for tests, like the model discover hook.
export async function preflightOpenCodeSandboxCredentials({
  config,
  agents,
  listProviders = openCodeAuthListProviders,
  detect = detectOpenCodeGeneration
} = {}) {
  const problems = [];
  const listings = new Map();
  const listingFor = (binary) => {
    const key = String(binary || "opencode");
    if (!listings.has(key)) {
      listings.set(key, Promise.resolve()
        .then(() => listProviders({binary: key}))
        .catch(() => ({ok: false, providers: []})));
    }
    return listings.get(key);
  };

  for (const [roleName, role] of Object.entries(config?.roles || {})) {
    if (!role || typeof role !== "object" || Array.isArray(role)) continue;
    const adapterId = role.adapter;
    const adapter = agents?.[adapterId];
    if (!adapter) continue;
    const model = typeof role.model === "string" ? role.model.trim() : "";
    if (!openCodeSandboxCredentialsRequired({adapterId, adapter, model, detect})) continue;
    const provider = openCodeModelProvider(model);
    const listing = await listingFor(adapter.binary);
    const listed = (listing?.providers || []).some((id) => id.toLowerCase() === provider.toLowerCase());
    if (!listed) problems.push({role: roleName, adapter: adapterId, provider});
  }
  return {ok: problems.length === 0, problems};
}

export function openCodeSandboxCredentialsPreflightMessage(result, agents = {}) {
  const problems = Array.isArray(result?.problems) ? result.problems : [];
  return [
    "Preflight failed: OpenCode 2 sandbox credentials are missing (AUTH_REQUIRED).",
    ...problems.map((problem) => {
      const binary = agents?.[problem.adapter]?.binary || problem.adapter;
      return ` - role '${problem.role}' (adapter '${problem.adapter}'): provider '${problem.provider}' is not listed by '${binary} auth list'.`;
    }),
    "",
    "Fix it with `opencode auth login` on OpenCode 2 (select the provider), then retry. No role was launched.",
  ].join("\n");
}
