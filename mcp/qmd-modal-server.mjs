#!/usr/bin/env node
/**
 * qmd-modal MCP server (stdio, newline-delimited JSON-RPC 2.0).
 *
 * Exposes the qmd-modal Modal deployment to pi-mcp:
 *   deploy            modal deploy infra.py           (qmd-mcp + phoenix)
 *   status            modal run infra.py::status      (last caretaker run)
 *   sync_data         ./sync_data.sh                  (all *.md + index.yml)
 *   sync_memory       ./sync_memory.sh                (pi-memory only + rebuild)
 *   reindex           modal run infra.py::reindex
 *   embed_batch       modal run infra.py::embed_batch
 *   pull_models       modal run infra.py::pull_models
 *   rebuild_pi_memory modal run infra.py::rebuild_pi_memory
 *   diag              modal run infra.py::diag
 *   caretaker         modal run infra.py::caretaker
 *   check_llm_env     modal run infra.py::check_llm_env
 *   health            probe qmd-mcp /health + phoenix /ping
 *   search            remote QMD query (lex | vec | hybrid)
 *
 * No npm dependencies. Reads the unified config
 * ~/.local/etc/pi-memory.conf (override PI_MEMORY_CONF=/path).
 * Locates qmd-modal via QMD_MODAL_DIR, the package tree, or /usr/local/share.
 *
 * Logs go to stderr only — stdout is reserved for the MCP protocol.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, "..");
const SERVER_INFO = { name: "qmd-modal", version: "1.0.0" };
const DEFAULT_PROTOCOL = "2024-11-05";
const MAX_OUTPUT = 40_000;

// --------------------------------------------------------------- locations

function findModalDir() {
  const env = process.env.QMD_MODAL_DIR;
  const candidates = [
    env,
    join(PACKAGE_ROOT, "qmd-modal"),
    join(homedir(), "pi-memory-master", "qmd-modal"),
    "/usr/local/share/qmd-modal",
    join(homedir(), ".local", "share", "qmd-modal"),
    join(homedir(), ".pi", "agent", "git", "github.com", "zombiegirlcz", "pi-memory-master", "qmd-modal"),
  ].filter(Boolean);
  for (const dir of candidates) {
    try {
      if (existsSync(join(dir, "infra.py"))) return dir;
    } catch {
      /* keep looking */
    }
  }
  return env || candidates[1];
}

const MODAL_DIR = findModalDir();

function confPath() {
  return process.env.PI_MEMORY_CONF ?? join(homedir(), ".local", "etc", "pi-memory.conf");
}

function loadConf() {
  const conf = {};
  try {
    for (const line of readFileSync(confPath(), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m) conf[m[1]] = m[2];
    }
  } catch {
    /* no conf */
  }
  return conf;
}

// ------------------------------------------------------------------ runner

function run(cmd, args, { cwd = MODAL_DIR, timeoutMs = 600_000, env = process.env } = {}) {
  return new Promise((done) => {
    let finished = false;
    let child;
    try {
      child = spawn(cmd, args, { cwd, env });
    } catch (e) {
      return done({ code: null, stdout: "", stderr: String(e?.message ?? e), error: true });
    }
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      if (out.length < MAX_OUTPUT) out += d.toString();
    });
    child.stderr.on("data", (d) => {
      if (err.length < MAX_OUTPUT) err += d.toString();
    });
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 5_000).unref?.();
      done({ code: null, stdout: out, stderr: `${err}\n[timeout after ${timeoutMs} ms]`, timedOut: true });
    }, timeoutMs);
    child.on("error", (e) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ code: null, stdout: out, stderr: `${err}\n${String(e?.message ?? e)}`, error: true });
    });
    child.on("close", (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      done({ code, stdout: out, stderr: err });
    });
  });
}

function trunc(s, n = MAX_OUTPUT) {
  s = String(s ?? "");
  return s.length > n ? `${s.slice(0, n)}\n…(+${s.length - n} chars truncated)` : s;
}

function fmt(label, r) {
  const status = r.timedOut ? "TIMEOUT" : r.code === null ? "ERROR" : `exit ${r.code}`;
  const parts = [`$ ${label}`, status];
  if (r.stdout?.trim()) parts.push("", "--- stdout ---", trunc(r.stdout).trimEnd());
  if (r.stderr?.trim()) parts.push("", "--- stderr ---", trunc(r.stderr).trimEnd());
  return parts.join("\n");
}

const modalRun = (fn, timeoutMs) => run("modal", ["run", `infra.py::${fn}`], { timeoutMs });
const modalDeploy = () => run("modal", ["deploy", "infra.py"], { timeoutMs: 1_800_000 });
const bashScript = (name, timeoutMs = 1_800_000) => run("bash", [join(MODAL_DIR, name)], { timeoutMs });

// -------------------------------------------------------------- HTTP tools

function qmdToken(conf) {
  // The deployed qmd-mcp proxy checks PROXY_TOKEN == PHOENIX_TOKEN (Modal
  // proxy token, wk-...ws-...). MODAL_KEY/MODAL_SECRET (ak-...as-...) is the
  // Modal API token and is NOT accepted by the web endpoints.
  if (process.env.QMD_PROXY_TOKEN) return process.env.QMD_PROXY_TOKEN;
  if (conf.PI_PHOENIX_TOKEN) return conf.PI_PHOENIX_TOKEN;
  if (conf.MODAL_KEY && conf.MODAL_SECRET) return `${conf.MODAL_KEY}.${conf.MODAL_SECRET}`;
  return "";
}

async function probe(label, url, token, path) {
  if (!url) return `${label}: URL not configured`;
  try {
    const r = await fetch(`${url.replace(/\/$/, "")}${path}`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: AbortSignal.timeout(30_000),
    });
    const body = trunc((await r.text()).replace(/\s+/g, " ").trim(), 200);
    return `${label}: HTTP ${r.status}${body ? ` ${body}` : ""}`;
  } catch (e) {
    return `${label}: ERROR ${e?.message ?? e}`;
  }
}

// -------------------------------------------------------------- tool table

const TOOLS = [
  {
    name: "deploy",
    description:
      "Deploy the qmd-modal Modal app 'ai-services' (labels qmd-mcp + phoenix). Runs `modal deploy infra.py`. Use after editing infra.py or when endpoints return 404.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("modal deploy infra.py", await modalDeploy()),
  },
  {
    name: "status",
    description: "Show the last qmd-modal caretaker run (runtime, pending embeddings, log). Runs `modal run infra.py::status`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("modal run infra.py::status", await modalRun("status", 300_000)),
  },
  {
    name: "sync_data",
    description: "Full sync: tar all *.md + index.yml from the phone, upload to the Modal volume, extract. Runs ./sync_data.sh.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("bash sync_data.sh", await bashScript("sync_data.sh")),
  },
  {
    name: "sync_memory",
    description: "Fast sync: push only the pi-memory directory to Modal and rebuild its collection. Runs ./sync_memory.sh.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("bash sync_memory.sh", await bashScript("sync_memory.sh")),
  },
  {
    name: "reindex",
    description: "Re-scan all collections into the index (no embeddings). Runs `modal run infra.py::reindex`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("modal run infra.py::reindex", await modalRun("reindex", 3_600_000)),
  },
  {
    name: "embed_batch",
    description: "Embed pending documents (resumable; repeat until PENDING_AFTER is 0). Runs `modal run infra.py::embed_batch`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("modal run infra.py::embed_batch", await modalRun("embed_batch", 3_600_000)),
  },
  {
    name: "pull_models",
    description: "Download the three GGUF models into the Modal volume cache. Runs `modal run infra.py::pull_models`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("modal run infra.py::pull_models", await modalRun("pull_models", 1_800_000)),
  },
  {
    name: "rebuild_pi_memory",
    description: "Drop and rebuild the pi-memory collection (fixes FTS for changed docs). Runs `modal run infra.py::rebuild_pi_memory`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("modal run infra.py::rebuild_pi_memory", await modalRun("rebuild_pi_memory", 1_800_000)),
  },
  {
    name: "diag",
    description: "In-container diagnostics: glob tests, index.sqlite state, collection/doc listing. Runs `modal run infra.py::diag`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("modal run infra.py::diag", await modalRun("diag", 900_000)),
  },
  {
    name: "caretaker",
    description: "Run the periodic caretaker manually (pi-memory rebuild + update + embed loop). Runs `modal run infra.py::caretaker`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("modal run infra.py::caretaker", await modalRun("caretaker", 3_600_000)),
  },
  {
    name: "check_llm_env",
    description: "Check Phoenix playground LLM env (OPENAI_API_KEY/BASE_URL) and do a live opencode test. Runs `modal run infra.py::check_llm_env`.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => fmt("modal run infra.py::check_llm_env", await modalRun("check_llm_env", 300_000)),
  },
  {
    name: "health",
    description: "Probe the remote qmd-mcp /health and phoenix /ping endpoints with the configured tokens.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async () => {
      const conf = loadConf();
      const [qmd, phx] = await Promise.all([
        probe("qmd-mcp", conf.QMD_REMOTE_URL, qmdToken(conf), "/health"),
        probe("phoenix", conf.PI_PHOENIX_URL, conf.PI_PHOENIX_TOKEN, "/ping"),
      ]);
      return `${qmd}\n${phx}`;
    },
  },
  {
    name: "search",
    description: "Query the remote QMD index. type=lex (BM25) | vec (embeddings) | hybrid (lex+vec), optional collection/limit/rerank.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query." },
        type: { type: "string", enum: ["lex", "vec", "hybrid"], description: "Search type (default lex)." },
        limit: { type: "number", description: "Max results (default 5)." },
        rerank: { type: "boolean", description: "Enable reranking (slower on CPU)." },
        collection: { type: "string", description: "Restrict to a collection, e.g. pi-memory." },
      },
      required: ["query"],
      additionalProperties: false,
    },
    handler: async (args) => {
      const conf = loadConf();
      const url = conf.QMD_REMOTE_URL;
      if (!url) return { isError: true, text: `QMD_REMOTE_URL not configured in ${confPath()}` };
      const type = args.type || "lex";
      const searches =
        type === "hybrid"
          ? [{ type: "lex", query: args.query }, { type: "vec", query: args.query }]
          : [{ type, query: args.query }];
      const body = { searches, limit: args.limit ?? 5, rerank: !!args.rerank };
      if (args.collection) body.collections = [args.collection];
      try {
        const r = await fetch(`${url.replace(/\/$/, "")}/query`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${qmdToken(conf)}`,
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(120_000),
        });
        return { isError: !r.ok, text: `HTTP ${r.status}\n${trunc(await r.text())}` };
      } catch (e) {
        return { isError: true, text: `request failed: ${e?.message ?? e}` };
      }
    },
  },
];

const TOOLS_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// ------------------------------------------------------------ JSON-RPC core

function send(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

async function handle(msg) {
  const { id, method, params } = msg;
  if (id === undefined) return; // notification — no response
  try {
    if (method === "initialize") {
      const pv = params && typeof params.protocolVersion === "string" ? params.protocolVersion : DEFAULT_PROTOCOL;
      send({ jsonrpc: "2.0", id, result: { protocolVersion: pv, capabilities: { tools: {} }, serverInfo: SERVER_INFO } });
    } else if (method === "ping") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else if (method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      });
    } else if (method === "tools/call") {
      const name = params?.name;
      const tool = TOOLS_BY_NAME.get(name);
      if (!tool) {
        send({ jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } });
        return;
      }
      const out = await tool.handler(params?.arguments ?? {});
      const text = typeof out === "string" ? out : (out?.text ?? "");
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError: !!out?.isError } });
    } else if (method === "resources/list") {
      send({ jsonrpc: "2.0", id, result: { resources: [] } });
    } else if (method === "prompts/list") {
      send({ jsonrpc: "2.0", id, result: { prompts: [] } });
    } else if (method === "logging/setLevel") {
      send({ jsonrpc: "2.0", id, result: {} });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (e) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } });
  }
}

let chain = Promise.resolve();
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let idx;
  while ((idx = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    chain = chain.then(() => handle(msg)).catch(() => {});
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));

process.stderr.write(`[qmd-modal-mcp] ready (modal dir: ${MODAL_DIR}, conf: ${confPath()})\n`);
