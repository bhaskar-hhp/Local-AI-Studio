#!/usr/bin/env node
/**
 * Local AI Studio — terminal client.
 *
 *   npm run cli                       interactive session
 *   npm run cli -- "add a README"     one task, then exit
 *   npm run cli -- --mock "make hello.txt"
 *
 * Flags:
 *   --mock            force the offline demo provider
 *   --yes, -y         auto-approve every tool call (dangerous)
 *   --model <id>      model to use
 *   --root <dir>      workspace (default ./workspace)
 *   --port <n>        server port (default 4317)
 *   --url <base>      talk to an already running server
 *
 * If no server answers on the port, this command starts one, waits for it,
 * and stops it again on exit.
 */

import { spawn, execFileSync } from "node:child_process";
import { createInterface } from "node:readline";
import {
  readFileSync, writeFileSync, mkdirSync, chmodSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ----------------------------------------------------------------- config */

function defaultConfigFile() {
  const env = process.env.LOCAL_AI_STUDIO_CONFIG;
  if (env) return path.resolve(env);
  const dir = path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "local-ai-studio",
  );
  return path.join(dir, "config.json");
}

let CONFIG_FILE = defaultConfigFile();

function loadConfig() {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  try {
    const dir = path.dirname(CONFIG_FILE);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const next = { ...loadConfig(), ...patch };
    writeFileSync(CONFIG_FILE, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
    try { chmodSync(CONFIG_FILE, 0o600); } catch {}
    return true;
  } catch (err) {
    console.error(`  could not save ${CONFIG_FILE}: ${err.message}`);
    return false;
  }
}

let config = loadConfig();
/* ------------------------------------------------------------------- args */

const argv = process.argv.slice(2);
const opts = {
  mock: false,
  yes: false,
  key: "",
  base: "",
  listModels: false,
  model: process.env.MODEL || config.model || "",
  root: process.env.AGENT_ROOT || path.join(HERE, "workspace"),
  port: Number(process.env.PORT || 4317),
  url: "",
  task: [],
};

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--mock") opts.mock = true;
  else if (a === "--yes" || a === "-y") opts.yes = true;
  else if (a === "--key") opts.key = argv[++i] || "";
  else if (a === "--base") opts.base = argv[++i] || "";
  else if (a === "--config") { CONFIG_FILE = path.resolve(argv[++i] || ""); config = loadConfig(); }
  else if (a === "--list-models") opts.listModels = true;
  else if (a === "--model") opts.model = argv[++i] || "";
  else if (a === "--root") opts.root = path.resolve(argv[++i] || ".");
  else if (a === "--port") opts.port = Number(argv[++i] || 4317);
  else if (a === "--url") opts.url = argv[++i] || "";
  else if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  else if (a === "--version" || a === "-v") { console.log("local-ai-studio 0.1.0"); process.exit(0); }
  else if (a.startsWith("-") && a !== "-") { console.error(`unknown flag: ${a}\n`); printHelp(); process.exit(2); }
  else opts.task.push(a);
}

// Key precedence: --key > environment > saved config.
let KEY = opts.key
  || process.env.PROVIDER_KEY
  || process.env.NVIDIA_API_KEY
  || config.key
  || "";
let KEY_SOURCE = opts.key ? "--key"
  : (process.env.PROVIDER_KEY || process.env.NVIDIA_API_KEY) ? "environment"
  : config.key ? CONFIG_FILE
  : "none";

const BASE = opts.base || process.env.PROVIDER_BASE || config.base || "";

if (opts.mock) process.env.MOCK = "1";
if (opts.root) process.env.AGENT_ROOT = opts.root;
process.env.PORT = String(opts.port);
if (opts.model) process.env.MODEL = opts.model;
if (BASE) process.env.PROVIDER_BASE = BASE;
if (KEY && !opts.mock) process.env.PROVIDER_KEY = KEY;

function maskKey(k) {
  if (!k) return "(not set)";
  if (k.length <= 12) return k.slice(0, 2) + "…" + k.slice(-2);
  return k.slice(0, 7) + "…" + k.slice(-4);
}

function printHelp() {
  console.log(`Local AI Studio — terminal client

Usage
  npm run cli                         interactive session
  npm run cli -- "task description"   run one task and exit
  npm run cli -- --list-models        show provider models and exit

Options
  --key <key>       provider API key (saved to ${CONFIG_FILE})
  --base <url>      provider base URL (OpenAI-compatible)
  --config <path>   config file for saved key/model (default ~/.config/local-ai-studio/config.json)
  --list-models     list every model the provider advertises
  --mock            offline demo provider (no key)
  --yes, -y         auto-approve tool calls
  --model <id>      model id (or pick a number from /models)
  --root <dir>      workspace directory
  --port <n>        server port (default 4317)
  --url <base>      use an existing server
  -h, --help        this help

Inside the session
  /help             commands
  /models [filter]  list available models
  /model [n|id]     show or set the model (number from /models)
  /key [value]      show, set or replace the provider key
  /files [path]     list workspace files
  /cat <path>       print a file
  /new              clear the conversation
  /exit             leave

Headless (no TTY): one-shot mode auto-approves all tool calls. On a TTY, each
tool call prompts [y]es / [n]o / [a]lways. Pipe responses for interactive
approval: printf 'y\n' | node cli.js -- "task";
`);
}

/* ------------------------------------------------------------------ color */

const useColor = !process.env.NO_COLOR && process.stdout.isTTY;
const c = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));
const cyan = c("36"), green = c("32"), yellow = c("33"), red = c("31");
const dim = c("2"), bold = c("1");

// A key supplied on the command line is persisted so it is reused next time.
if (opts.key && !opts.mock) {
  const patch = { key: opts.key, ...(opts.base ? { base: opts.base } : {}) };
  if (saveConfig(patch)) console.log(dim(`  key saved to ${CONFIG_FILE}`));
}
if (opts.base && !opts.mock) saveConfig({ base: opts.base });

/* ------------------------------------------------------------------ input */

/**
 * Line reader with an internal queue. Unlike `readline.question`, every line
 * that arrives while a handler is running is kept, so piped input
 * (`printf '/help\n/exit\n' | node cli.js`) and pasted multi-line input work.
 */
function createReader() {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });
  const queue = [];
  const waiters = [];
  let closed = false;

  rl.on("line", (line) => {
    const wake = waiters.shift();
    if (wake) wake(line);
    else queue.push(line);
  });
  rl.on("close", () => {
    closed = true;
    while (waiters.length) waiters.shift()(null);
  });

  return {
    async ask(prompt) {
      if (prompt) process.stdout.write(prompt);
      if (queue.length) return queue.shift();
      if (closed) return null;
      return new Promise((resolve) => waiters.push(resolve));
    },
    close() { rl.close(); },
  };
}

/* ------------------------------------------------------------- key & models */

let echoOff = false;

function setEcho(on) {
  if (process.platform === "win32" || !process.stdin.isTTY) return;
  try {
    execFileSync("stty", [on ? "echo" : "-echo"], { stdio: ["inherit", "ignore", "ignore"] });
    echoOff = !on;
  } catch {}
}

/** Read a line without echoing it to the terminal. */
async function promptHidden(prompt) {
  process.stdout.write(prompt);
  setEcho(false);
  const answer = await new Promise((resolve) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });
    let got = false;
    rl.once("line", (line) => {
      got = true;
      resolve(line);
      rl.close();
    });
    rl.once("close", () => { if (!got) resolve(null); });
  });
  setEcho(true);
  process.stdout.write("\n");
  return answer === null ? null : answer.trim();
}

async function promptForKey() {
  console.log(yellow("\n  No provider key found."));
  console.log(dim("  Create one at https://build.nvidia.com → API keys."));
  const key = await promptHidden("  Paste key (input hidden): ");
  if (!key) {
    console.error(red("  no key entered"));
    return "";
  }
  if (saveConfig({ key })) {
    console.log(green("  ✓ key saved") + dim(` to ${CONFIG_FILE}`));
  }
  return key;
}

let MODELS = [];
let DEFAULT_MODEL = "";

async function loadModels() {
  const res = await fetch(`${base}/api/models`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.ok) throw new Error(body.error || `HTTP ${res.status}`);
  MODELS = Array.isArray(body.models) ? body.models : [];
  DEFAULT_MODEL = body.default || DEFAULT_MODEL;
  return MODELS;
}

function printModels(filter = "") {
  const f = filter.toLowerCase();
  const width = String(MODELS.length).length;
  let shown = 0;
  MODELS.forEach((m, i) => {
    if (f && !m.id.toLowerCase().includes(f)) return;
    shown++;
    const mark = m.id === MODEL ? cyan("*") : " ";
    console.log(`  ${mark} ${String(i + 1).padStart(width)}  ${m.id}`);
  });
  if (!shown) {
    console.log(dim(`  no models${f ? ` matching "${filter}"` : ""}`));
    return;
  }
  console.log(dim(`  ${shown} of ${MODELS.length} models · pick with /model <number|id>`));
}

async function currentModelList() {
  if (!MODELS.length) await loadModels();
  return MODELS;
}

/* ----------------------------------------------------------------- server */

let base = opts.url ? opts.url.replace(/\/+$/, "") : `http://127.0.0.1:${opts.port}`;
let child = null;
let ownsServer = false;

async function health(timeout = 700) {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeout);
    const res = await fetch(`${base}/api/health`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

async function ensureServer() {
  let h = await health();
  if (h) return h;

  if (opts.url) {
    console.error(red(`No server at ${base}. Start it with: npm start`));
    process.exit(1);
  }

  const env = { ...process.env };
  const proc = spawn(process.execPath, [path.join(HERE, "server.js")], {
    cwd: HERE,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child = proc;
  ownsServer = true;

  let bootLog = "";
  proc.stdout.on("data", (d) => { bootLog += d.toString(); });
  proc.stderr.on("data", (d) => { bootLog += d.toString(); });
  proc.on("exit", (code) => {
    if (child === proc) {
      console.error(red(`\nserver exited (code ${code})\n${bootLog}`));
      process.exit(1);
    }
  });

  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    h = await health(500);
    if (h) return h;
  }
  console.error(red("server did not start:\n" + bootLog));
  proc.kill();
  process.exit(1);
}

function stopServer() {
  if (child) {
    child.removeAllListeners("exit");
    child.kill("SIGTERM");
    child = null;
  }
  ownsServer = false;
}

/** Restart a server this process started (used after changing the key). */
async function restartServer() {
  if (opts.url || !ownsServer) return false;
  stopServer();
  for (let i = 0; i < 20; i++) {
    if (!(await health(300))) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  await ensureServer();
  return true;
}

/* ------------------------------------------------------------------ model */

let MODEL = "";
let AUTO = opts.yes;
const messages = [];

function toolLine(call) {
  const a = call.arguments || {};
  const target = a.path || a.command || a.query || "";
  return `${bold(call.name)} ${dim(String(target).slice(0, 90))}`;
}

function printArgs(call) {
  const a = call.arguments || {};
  if (call.name === "run_command") {
    console.log(dim("  $ " + a.command));
    return;
  }
  if (call.name === "write_file") {
    const body = String(a.content || "");
    const lines = body.split("\n");
    console.log(dim(`  path: ${a.path}  (${body.length} bytes, ${lines.length} lines)`));
    const preview = lines.slice(0, 12).map((l) => "  │ " + l).join("\n");
    console.log(dim(preview + (lines.length > 12 ? `\n  │ … ${lines.length - 12} more lines` : "")));
    return;
  }
  console.log(dim("  " + JSON.stringify(a)));
}

/* ------------------------------------------------------------------ tools */

async function runTool(call) {
  const res = await fetch(`${base}/api/tool`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ call }),
  });
  return res.json();
}

async function askApproval(io, call) {
  if (AUTO) return "yes";
  console.log(yellow("\n  tool call needs approval"));
  console.log("  " + toolLine(call));
  printArgs(call);
  if (!io) return "no";
  const raw = await io.ask("  run it? [y]es / [n]o / [a]lways › ");
  if (raw === null) return "no";
  const ans = raw.trim().toLowerCase();
  if (ans === "a" || ans === "always") { AUTO = true; return "yes"; }
  if (ans === "y" || ans === "yes") return "yes";
  return "no";
}

function showOutput(res) {
  const text = res.ok ? String(res.output ?? "") : `ERROR: ${res.error}`;
  const lines = text.split("\n");
  const head = lines.slice(0, 60);
  console.log("");
  for (const l of head) console.log(dim("  │ ") + l);
  if (lines.length > 60) console.log(dim(`  │ … ${lines.length - 60} more lines`));
  console.log(res.ok ? green("  ✓ done") : red("  ✗ failed"));
}

/* ------------------------------------------------------------------- chat */

async function runTurn(io) {
  const body = {
    model: MODEL,
    messages: messages.map((m) => ({ role: m.role, content: m.content })),
  };

  const res = await fetch(`${base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => ({}));
    throw new Error(detail.error || `HTTP ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let content = "";
  let tool = null;
  let error = "";
  let printed = 0;

  const flushText = () => {
    if (text.length <= printed) return;
    process.stdout.write(text.slice(printed));
    printed = text.length;
  };

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let i;
    while ((i = buffer.indexOf("\n\n")) !== -1) {
      const event = buffer.slice(0, i);
      buffer = buffer.slice(i + 2);
      for (const line of event.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const raw = line.slice(5).trim();
        if (!raw) continue;
        let m;
        try { m = JSON.parse(raw); } catch { continue; }
        if (m.type === "delta") {
          text += m.text;
          flushText();
        } else if (m.type === "tool") {
          tool = m.call;
        } else if (m.type === "reasoning") {
          // keep reasoning out of the main flow
        } else if (m.type === "done") {
          content = m.content || text;
        } else if (m.type === "error") {
          error = m.error + (m.detail ? `: ${m.detail}` : "");
        }
      }
    }
  }
  if (printed < text.length) process.stdout.write(text.slice(printed));
  if (text.trim()) process.stdout.write("\n");

  if (error) throw new Error(error);
  messages.push({ role: "assistant", content: content || text });

  if (!tool) return { done: true };

  const decision = await askApproval(io, tool);
  if (decision === "no") {
    messages.push({ role: "user", content:
      `TOOL RESULT ${tool.name}: denied by the user. Do not retry the same call; ask or try another approach.` });
    return { done: false };
  }

  const res2 = await runTool(tool);
  showOutput(res2);
  const out = res2.ok ? String(res2.output ?? "") : `ERROR: ${res2.error}`;
  messages.push({ role: "user", content:
    `TOOL RESULT ${tool.name}:\n${out.length > 12000 ? out.slice(0, 12000) + "\n…" : out}` });
  return { done: false };
}

async function task(prompt, io) {
  messages.push({ role: "user", content: prompt });
  for (let step = 0; step < 20; step++) {
    const { done } = await runTurn(io);
    if (done) return;
  }
  console.log(yellow("\n  stopped after 20 tool steps"));
}

/* ------------------------------------------------------------------- repl */

let ioRef = null;

async function repl() {
  const io = createReader();
  ioRef = io;

  console.log(bold("\n  Local AI Studio") + dim(` — ${MODEL || "model"}`));
  console.log(dim(`  workspace ${process.env.AGENT_ROOT}`));
  console.log(dim("  /help for commands, /exit to leave\n"));

  while (true) {
    const raw = await io.ask(cyan("  › "));
    if (raw === null) break;
    const line = raw.trim();
    if (!line) continue;

    if (line.startsWith("/")) {
      const [cmd, ...rest] = line.slice(1).split(/\s+/);
      const arg = rest.join(" ");
      try {
        if (cmd === "exit" || cmd === "quit") break;
        if (cmd === "help") { printHelp(); continue; }
        if (cmd === "new") { messages.length = 0; console.log(dim("  new conversation")); continue; }
        if (cmd === "models") {
          await currentModelList();
          printModels(arg);
          continue;
        }
        if (cmd === "model") {
          if (!arg) {
            console.log(dim(`  model ${MODEL || "(none)"}`));
            console.log(dim(`  ${MODELS.length ? `${MODELS.length} models known — /models to list` : "run /models to list models"}`));
            continue;
          }
          const n = Number(arg);
          if (Number.isInteger(n) && n > 0) {
            const list = await currentModelList();
            const pick = list[n - 1];
            if (!pick) throw new Error(`no model #${n} (valid: 1-${list.length})`);
            MODEL = pick.id;
          } else {
            MODEL = arg;
          }
          saveConfig({ model: MODEL });
          console.log(dim(`  model ${MODEL}`) + dim(" (saved)"));
          continue;
        }
        if (cmd === "key") {
          if (!arg) {
            console.log(dim(`  key ${maskKey(KEY)}`) + dim(` · source: ${KEY_SOURCE}`));
            console.log(dim(`  config ${CONFIG_FILE}`));
            continue;
          }
          KEY = arg;
          KEY_SOURCE = "session";
          process.env.PROVIDER_KEY = KEY;
          saveConfig({ key: KEY });
          MODELS = [];
          console.log(green("  ✓ key updated") + dim(` (${maskKey(KEY)})`));
          if (opts.url || !ownsServer) {
            console.log(yellow("  the running server keeps its own key — restart it to apply"));
          } else {
            console.log(dim("  restarting the local server…"));
            await restartServer();
            try { await loadModels(); } catch {}
            const hh = await health();
            console.log(hh?.has_key
              ? dim(`  server ready · ${hh.mock ? "mock" : "key ok"}`)
              : yellow("  server still has no key"));
          }
          continue;
        }
        if (cmd === "files") {
          const body = await (await fetch(`${base}/api/tree?path=${encodeURIComponent(arg || ".")}`)).json();
          if (!body.entries) throw new Error(body.error || "cannot list");
          for (const e of body.entries) console.log("  " + (e.dir ? cyan(e.name + "/") : e.name));
          continue;
        }
        if (cmd === "cat") {
          if (!arg) { console.log(dim("  usage: /cat path")); continue; }
          const body = await (await fetch(`${base}/api/file?path=${encodeURIComponent(arg)}`)).json();
          if (!body.ok) throw new Error(body.error);
          console.log(body.text);
          continue;
        }
        console.log(dim("  unknown command, try /help"));
      } catch (err) {
        console.log(red("  " + (err.message || err)));
      }
      continue;
    }

    try {
      await task(line, io);
    } catch (err) {
      console.log(red("\n  " + (err.message || err)));
    }
    console.log("");
  }

  io.close();
}

/* ------------------------------------------------------------------- main */

process.on("SIGINT", () => {
  if (echoOff) setEcho(true);
  stopServer();
  console.log("");
  process.exit(130);
});
process.on("exit", () => {
  if (echoOff) setEcho(true);
  stopServer();
});

// A server we spawn needs the key before it starts. Prompt for one on a TTY;
// otherwise fail with instructions rather than starting a useless server.
if (!opts.mock && !opts.url && !KEY) {
  if (process.stdin.isTTY) {
    KEY = await promptForKey();
    if (!KEY) {
      stopServer();
      process.exit(1);
    }
    process.env.PROVIDER_KEY = KEY;
    KEY_SOURCE = "session";
  } else {
    console.error(red("\n  No provider key."));
    console.error(dim("  Pass --key <key>, set PROVIDER_KEY / NVIDIA_API_KEY, or use --mock."));
    process.exit(1);
  }
}

const h = await ensureServer();
base = opts.url ? base : `http://127.0.0.1:${opts.port}`;

if (h.mock) console.log(yellow("\n  mock provider — replies are scripted"));
if (!h.has_key) {
  console.error(red("\n  The server has no model key."));
  console.error(dim(opts.url
    ? `  Restart ${base} with PROVIDER_KEY=… and try again.`
    : "  Pass --key <key> or set PROVIDER_KEY."));
  stopServer();
  process.exit(1);
}
if (!h.mock) {
  console.log(dim(`  key ${maskKey(KEY || "server-side")} · ${KEY_SOURCE}`));
  console.log(dim(`  provider ${h.provider}`));
}

try {
  await loadModels();
} catch (err) {
  console.log(yellow(`  could not load models: ${err.message}`));
}

if (opts.model && /^\d+$/.test(opts.model)) {
  const pick = MODELS[Number(opts.model) - 1];
  if (!pick) {
    console.error(red(`  no model #${opts.model} (valid: 1-${MODELS.length})`));
    stopServer();
    process.exit(1);
  }
  MODEL = pick.id;
} else if (opts.model) {
  MODEL = opts.model;
} else if (MODELS.some((m) => m.id === DEFAULT_MODEL)) {
  MODEL = DEFAULT_MODEL;
} else {
  MODEL = MODELS[0]?.id || DEFAULT_MODEL || h.model;
}

if (opts.listModels) {
  if (!MODELS.length) {
    console.error(red("  no models available — check the key and provider URL"));
    stopServer();
    process.exit(1);
  }
  printModels("");
  stopServer();
  process.exit(0);
}

if (opts.task.length) {
  // one-shot: interactive approval on a TTY; auto-approve headless (like OpenCode).
  const oneShot = opts.task.join(" ");
  if (!AUTO && !process.stdin.isTTY) {
    AUTO = true;
    console.error(yellow("\n  Headless mode: auto-approving all tool calls."));
    console.error(dim("  Pass --yes to silence this warning, or pipe responses for interactive approval."));
  }
  if (!AUTO) ioRef = createReader();
  try {
    await task(oneShot, ioRef);
  } catch (err) {
    console.error(red("error: " + (err.message || err)));
    stopServer();
    process.exit(1);
  }
  if (ioRef) ioRef.close();
  stopServer();
  process.exit(0);
}

await repl();
stopServer();
process.exit(0);
