#!/usr/bin/env node
/**
 * Local AI Studio — a coding agent that runs on your machine.
 *
 *   node server.js
 *
 * The browser UI talks to this local server only. The server holds the model
 * key, streams replies, and executes file / shell tools inside AGENT_ROOT
 * after the user approves each call in the UI.
 *
 * Environment:
 *   PORT             default 4317
 *   HOST             default 127.0.0.1 (never exposed by default)
 *   AGENT_ROOT       workspace the agent may touch (default ./workspace)
 *   PROVIDER_BASE    OpenAI-compatible base URL (default NVIDIA NIM)
 *   PROVIDER_KEY     API key (or NVIDIA_API_KEY)
 *   MODEL            default model id
 *   MOCK=1           offline demo provider, no key needed
 */

import http from "node:http";
import { readFile, writeFile, mkdir, readdir, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(__dirname, "public");
const ROOT = path.resolve(process.env.AGENT_ROOT || path.join(__dirname, "workspace"));
const HOST = process.env.HOST || "127.0.0.1";
const PORT = Number(process.env.PORT || 4317);
const MOCK = process.env.MOCK === "1";
const BASE = (process.env.PROVIDER_BASE || "https://integrate.api.nvidia.com/v1")
  .replace(/\/+$/, "");
const KEY = process.env.PROVIDER_KEY || process.env.NVIDIA_API_KEY || "";
const DEFAULT_MODEL = process.env.MODEL || "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning";

const MAX_BODY = 8 * 1024 * 1024;
const MAX_FILE = 200 * 1024;
const MAX_OUTPUT = 20_000;
const MAX_TOKENS = Number(process.env.MAX_TOKENS || 4096);
const CMD_TIMEOUT = Number(process.env.CMD_TIMEOUT_MS || 60_000);
const MAX_STEPS = 16;

const IGNORE = new Set([
  "node_modules", ".git", ".venv", "venv", "dist", "build", ".next",
  "__pycache__", ".cache", ".idea", ".DS_Store", "target", "vendor",
]);

/* ------------------------------------------------------------------ tools -- */

function safePath(rel = ".") {
  const raw = String(rel ?? ".").trim() || ".";
  const resolved = path.resolve(ROOT, raw);
  if (resolved !== ROOT && !resolved.startsWith(ROOT + path.sep)) {
    throw new Error(`path escapes the workspace: ${raw}`);
  }
  return resolved;
}

const relPath = (abs) => path.relative(ROOT, abs) || ".";

function human(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function looksBinary(text) {
  return text.includes("\u0000");
}

async function listDir(args) {
  const abs = safePath(args.path || ".");
  const entries = await readdir(abs, { withFileTypes: true });
  const rows = [];
  for (const e of entries.slice(0, 500)) {
    if (IGNORE.has(e.name)) continue;
    if (e.isDirectory()) {
      rows.push(`${e.name}/`);
    } else {
      const info = await stat(path.join(abs, e.name)).catch(() => null);
      rows.push(`${e.name}  (${info ? human(info.size) : "?"})`);
    }
  }
  rows.sort((a, b) => {
    const ad = a.endsWith("/"), bd = b.endsWith("/");
    if (ad !== bd) return ad ? -1 : 1;
    return a.localeCompare(b);
  });
  return `${relPath(abs)}:\n${rows.join("\n") || "(empty)"}`;
}

async function readFileTool(args) {
  const abs = safePath(args.path);
  const info = await stat(abs);
  if (info.isDirectory()) throw new Error(`${args.path} is a directory`);
  if (info.size > MAX_FILE) throw new Error(`file is ${human(info.size)} (limit ${human(MAX_FILE)})`);
  const text = await readFile(abs, "utf8");
  if (looksBinary(text)) throw new Error("file looks binary; refusing to read it as text");
  const lines = text.split("\n");
  const from = Math.max(1, Number(args.start || 1));
  const to = Math.min(lines.length, Number(args.end || lines.length));
  const slice = lines.slice(from - 1, to)
    .map((l, i) => `${String(from + i).padStart(4)} | ${l}`).join("\n");
  const note = to < lines.length ? `\n… (${lines.length} lines total)` : "";
  return slice + note;
}

async function writeFileTool(args) {
  const abs = safePath(args.path);
  const content = String(args.content ?? "");
  if (content.length > MAX_FILE * 4) throw new Error("content too large");
  await mkdir(path.dirname(abs), { recursive: true });
  await writeFile(abs, content, "utf8");
  return `wrote ${content.length} bytes to ${relPath(abs)}`;
}

function runCommand(args) {
  const command = String(args.command || "").trim();
  if (!command) throw new Error("command is empty");
  const timeout = Math.min(CMD_TIMEOUT, Math.max(1000, Number(args.timeout_ms || CMD_TIMEOUT)));

  return new Promise((resolve, reject) => {
    execFile("/bin/bash", ["-lc", command], {
      cwd: ROOT,
      timeout,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, PWD: ROOT },
    }, (err, stdout, stderr) => {
      const out = `${stdout || ""}${stderr ? (stdout ? "\n" : "") + stderr : ""}`;
      const trimmed = out.length > MAX_OUTPUT
        ? out.slice(0, MAX_OUTPUT) + `\n… (output truncated, ${out.length} chars total)`
        : out;
      if (err && err.killed) {
        resolve({ exit: "timeout", output: trimmed || "(no output)" });
        return;
      }
      const exit = err ? (err.code ?? 1) : 0;
      resolve({ exit, output: trimmed || "(no output)" });
    });
  });
}

async function* walk(dir, depth = 0) {
  if (depth > 8) return;
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    if (IGNORE.has(e.name)) continue;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(abs, depth + 1);
    else yield abs;
  }
}

async function searchTool(args) {
  const q = String(args.query || "");
  if (!q) throw new Error("query is empty");
  const start = safePath(args.path || ".");
  const useRe = args.regex === true;
  let re = null;
  if (useRe) {
    try { re = new RegExp(q, "i"); } catch (e) { throw new Error(`bad regex: ${e.message}`); }
  }
  const hits = [];
  for await (const file of walk(start)) {
    if (hits.length >= 80) break;
    const info = await stat(file).catch(() => null);
    if (!info || info.size > 1024 * 1024) continue;
    let text;
    try { text = await readFile(file, "utf8"); } catch { continue; }
    if (looksBinary(text)) continue;
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const match = useRe ? re.test(line) : line.toLowerCase().includes(q.toLowerCase());
      if (!match) continue;
      hits.push(`${relPath(file)}:${i + 1}: ${line.trim().slice(0, 200)}`);
      if (hits.length >= 80) break;
    }
  }
  return hits.length ? hits.join("\n") : `no matches for "${q}"`;
}

const TOOL_NAMES = ["list_dir", "read_file", "write_file", "run_command", "search"];

async function executeTool(call) {
  const name = call && call.name;
  const args = (call && call.arguments) || {};
  if (!TOOL_NAMES.includes(name)) throw new Error(`unknown tool: ${name}`);

  switch (name) {
    case "list_dir": return listDir(args);
    case "read_file": return readFileTool(args);
    case "write_file": return writeFileTool(args);
    case "search": return searchTool(args);
    case "run_command": {
      const r = await runCommand(args);
      return `exit ${r.exit}\n${r.output}`;
    }
    default: throw new Error(`unhandled tool: ${name}`);
  }
}

/* ------------------------------------------------------------ system prompt */

const SYSTEM = `You are Local AI Studio, a coding agent running on the user's own machine.

Workspace root: ${ROOT}
Every path you use is relative to that root. You cannot touch anything outside it.

You work by calling tools. To call a tool, emit exactly one fenced block like this:

\`\`\`tool
{"name":"read_file","arguments":{"path":"src/app.js"}}
\`\`\`

Available tools:

- list_dir      {"path":"."}                         list a directory
- read_file     {"path":"file.js","start":1,"end":200} read a text file (line numbers)
- write_file    {"path":"file.js","content":"..."}   create or overwrite a file
- search        {"query":"text","path":".","regex":false} case-insensitive search
- run_command   {"command":"npm test","timeout_ms":60000} run a shell command in the workspace

Rules:
1. Inspect before you change: read the files a task touches.
2. One tool call per reply, then stop and wait for the result. Never invent tool output.
3. Prefer write_file with complete file contents over partial patches.
4. Keep shell commands short and non-interactive. Never run destructive commands
   (rm -rf /, mkfs, dd, shutdown) or touch paths outside the workspace.
5. When the task is finished, reply with a short summary of what changed and how
   to run or test it. Do not call a tool in the final reply.
6. Match the existing style of the code you edit. Do not add dependencies unless asked.
7. If a request is ambiguous, ask one short question instead of guessing.`;

/* ----------------------------------------------------------------- provider */

let modelCache = { at: 0, models: [] };

async function listModels() {
  if (MOCK) {
    return [{ id: "mock/model", owned_by: "local" }];
  }
  if (!KEY) throw new Error("PROVIDER_KEY (or NVIDIA_API_KEY) is not set");
  if (Date.now() - modelCache.at < 30 * 60_000) return modelCache.models;

  const res = await fetch(`${BASE}/models`, {
    headers: { Authorization: `Bearer ${KEY}`, Accept: "application/json" },
  });
  if (!res.ok) throw new Error(`provider /models returned ${res.status}`);
  const body = await res.json();
  const models = (body.data || []).map((m) => ({
    id: String(m.id || ""),
    owned_by: String(m.owned_by || ""),
  })).filter((m) => m.id);
  modelCache = { at: Date.now(), models };
  return models;
}

/* ------------------------------------------------------------------ parser */

const MARK = "```tool";


class ToolParser {
  constructor(onText, onTool) {
    this.onText = onText;
    this.onTool = onTool;
    this.state = "text";
    this.buf = "";
    this.toolBuf = "";
    this.found = null;
  }

  emitText(text) {
    if (text) this.onText(text);
  }

  feed(chunk) {
    this.buf += chunk;
    let guard = 0;
    while (this.buf && guard++ < 10_000) {
      if (this.state === "text") {
        const i = this.buf.indexOf(MARK);
        if (i === -1) {
          // hold back the longest suffix that could start a marker
          const keep = longestSuffixPrefix(this.buf, MARK);
          const cut = this.buf.length - keep;
          if (cut > 0) {
            this.emitText(this.buf.slice(0, cut));
            this.buf = this.buf.slice(cut);
          }
          break;
        }
        if (i > 0) {
          this.emitText(this.buf.slice(0, i));
          this.buf = this.buf.slice(i);
        }
        this.state = "tool";
        this.buf = this.buf.slice(MARK.length);
        this.toolBuf = "";
      } else {
        const j = this.buf.indexOf("```");
        if (j === -1) {
          // hold back up to two backticks that may start the closing fence
          const keep = longestSuffixPrefix(this.buf, "```");
          const cut = this.buf.length - keep;
          if (cut > 0) {
            this.toolBuf += this.buf.slice(0, cut);
            this.buf = this.buf.slice(cut);
          }
          break;
        }
        this.toolBuf += this.buf.slice(0, j);
        this.buf = this.buf.slice(j + 3);
        this.handleTool();
        this.state = "text";
      }
    }
  }

  handleTool() {
    const raw = this.toolBuf.trim();
    this.toolBuf = "";
    let call = null;
    try {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.name) {
        call = { name: String(parsed.name), arguments: parsed.arguments || {} };
      }
    } catch {
      call = null;
    }
    if (call && !this.found) {
      this.found = call;
      this.onTool(call);
    } else if (!call) {
      this.emitText(`\n\`\`\`tool\n${raw}\n\`\`\`\n`);
    }
  }

  flush() {
    if (this.state === "tool") {
      this.emitText(`\n\`\`\`tool\n${(this.toolBuf + this.buf).trim()}\n\`\`\`\n`);
      this.buf = "";
      this.toolBuf = "";
      this.state = "text";
    } else if (this.buf) {
      this.emitText(this.buf);
      this.buf = "";
    }
  }
}

function longestSuffixPrefix(text, mark) {
  const max = Math.min(text.length, mark.length - 1);
  for (let n = max; n > 0; n--) {
    if (text.endsWith(mark.slice(0, n))) return n;
  }
  return 0;
}

/* ----------------------------------------------------------------- helpers */

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
};

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new Error("request body too large");
    chunks.push(chunk);
  }
  if (!size) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function sse(res) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders?.();
  return {
    send(obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); },
    end() { res.end(); },
  };
}

/* -------------------------------------------------------------- mock stream */

function mockChunks(messages) {
  const last = [...messages].reverse().find((m) => m.role === "user");
  const text = String(last?.content || "");
  const trimmed = text.trim();

  // Follow-up after a tool ran: report what happened instead of repeating it.
  const result = trimmed.match(/^TOOL RESULT\s+(\w+):\s*\n?([\s\S]*)$/);
  if (result) {
    const [, name, raw] = result;
    const wrote = raw.match(/wrote \d+ bytes to (.+)/);
    if (wrote) return [`Done. \`${wrote[1].trim()}\` is written.`];
    const first = raw.trim().split("\n")[0] || "ok";
    return [`Done — ${name}: ${first}`];
  }

  // Write request: honour a real filename and any "with …" content.
  const wantsFile = /(create|write|make|save|add)\b/i.test(text) && /\bfile\b/i.test(text);
  if (wantsFile) {
    const file = text.match(
      /([\w./-]+\.(?:txt|md|js|mjs|cjs|ts|jsx|tsx|py|json|html|css|sh|go|rs|java|c|cpp|rb|yml|yaml))/i,
    );
    const filePath = file ? file[1] : "hello.txt";
    let content = "hello world\n";
    const withMatch = text.match(/\b(?:with|containing|that says|saying)\s+["'`]?([^"'`]+?)["'`]?\s*$/i);
    if (withMatch && withMatch[1].trim()) content = withMatch[1].trim() + "\n";
    return [
      `I'll write \`${filePath}\` for you.\n\n`,
      "```tool\n" + JSON.stringify({
        name: "write_file",
        arguments: { path: filePath, content },
      }) + "\n```",
    ];
  }

  return [`(mock) I received: ${text.slice(0, 200) || "nothing"}`];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function mockTurn(stream) {
  const chunks = mockChunks(stream.messages);
  let raw = "";
  const parser = new ToolParser(
    (text) => { raw += text; stream.send({ type: "delta", text }); },
    (call) => stream.send({ type: "tool", call }),
  );
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 8) {
      parser.feed(chunk.slice(i, i + 8));
      await sleep(12);
    }
  }
  parser.flush();
  stream.send({ type: "done", content: raw });
  stream.end();
}

/* --------------------------------------------------------------- chat route */

async function chat(req, res, body) {
  const messages = Array.isArray(body.messages) ? body.messages : null;
  if (!messages || !messages.length) return json(res, 400, { error: "messages required" });
  if (messages.length > 120) return json(res, 400, { error: "too many messages" });

  const model = String(body.model || DEFAULT_MODEL);
  const stream = sse(res);

  if (MOCK) {
    stream.messages = messages;
    await mockTurn(stream);
    return;
  }

  if (!KEY) {
    stream.send({ type: "error", error: "PROVIDER_KEY is not set on the server" });
    stream.end();
    return;
  }

  const controller = new AbortController();
  req.on("close", () => { try { controller.abort(); } catch {} });

  const payload = {
    model,
    messages: [{ role: "system", content: SYSTEM }, ...messages],
    temperature: 0.2,
    max_tokens: MAX_TOKENS,
    stream: true,
  };

  let upstream;
  try {
    upstream = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${KEY}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    stream.send({ type: "error", error: `cannot reach provider: ${err.message}` });
    stream.end();
    return;
  }

  if (!upstream.ok || !upstream.body) {
    const detail = (await upstream.text().catch(() => "")).slice(0, 500);
    stream.send({ type: "error", error: `provider returned ${upstream.status}`, detail });
    stream.end();
    return;
  }

  let raw = "";
  const parser = new ToolParser(
    (text) => { raw += text; stream.send({ type: "delta", text }); },
    (call) => stream.send({ type: "tool", call }),
  );

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const event = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        for (const line of event.split("\n")) {
          if (!line.startsWith("data:")) continue;
          const data = line.slice(5).trim();
          if (!data || data === "[DONE]") continue;
          let obj;
          try { obj = JSON.parse(data); } catch { continue; }
          if (obj.usage) stream.send({ type: "usage", usage: obj.usage });
          const delta = obj.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === "string" && delta.content) parser.feed(delta.content);
          if (typeof delta.reasoning_content === "string" && delta.reasoning_content) {
            stream.send({ type: "reasoning", text: delta.reasoning_content });
          }
        }
      }
    }
    parser.flush();
    stream.send({ type: "done", content: raw });
  } catch (err) {
    if (err.name !== "AbortError") {
      stream.send({ type: "error", error: String(err.message || err) });
    }
  } finally {
    stream.end();
  }
}

/* ----------------------------------------------------------------- routing */

async function api(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/health") {
    return json(res, 200, {
      ok: true,
      root: ROOT,
      mock: MOCK,
      has_key: Boolean(KEY) || MOCK,
      provider: MOCK ? "mock" : BASE,
      model: DEFAULT_MODEL,
      tools: TOOL_NAMES,
      max_steps: MAX_STEPS,
    });
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    try {
      const models = await listModels();
      return json(res, 200, { ok: true, models, default: DEFAULT_MODEL });
    } catch (err) {
      return json(res, 502, { ok: false, error: String(err.message || err) });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/tree") {
    const abs = safePath(url.searchParams.get("path") || ".");
    const entries = await readdir(abs, { withFileTypes: true });
    const nodes = [];
    for (const e of entries.slice(0, 500)) {
      if (IGNORE.has(e.name)) continue;
      const full = path.join(abs, e.name);
      const info = e.isFile() ? await stat(full).catch(() => null) : null;
      nodes.push({
        name: e.name,
        dir: e.isDirectory(),
        size: info ? info.size : 0,
      });
    }
    nodes.sort((a, b) => (a.dir !== b.dir ? (a.dir ? -1 : 1) : a.name.localeCompare(b.name)));
    return json(res, 200, { ok: true, path: relPath(abs), entries: nodes });
  }

  if (req.method === "GET" && url.pathname === "/api/file") {
    const abs = safePath(url.searchParams.get("path") || "");
    const info = await stat(abs);
    if (info.isDirectory()) return json(res, 400, { ok: false, error: "is a directory" });
    if (info.size > MAX_FILE) return json(res, 413, { ok: false, error: "file too large" });
    const text = await readFile(abs, "utf8");
    return json(res, 200, { ok: true, path: relPath(abs), size: info.size, text });
  }

  if (req.method === "POST" && url.pathname === "/api/chat") {
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: err.message }); }
    return chat(req, res, body);
  }

  if (req.method === "POST" && url.pathname === "/api/tool") {
    let body;
    try { body = await readBody(req); } catch (err) { return json(res, 400, { error: err.message }); }
    const call = body.call;
    if (!call || !call.name) return json(res, 400, { ok: false, error: "call required" });
    try {
      const started = Date.now();
      const output = await executeTool(call);
      return json(res, 200, { ok: true, output: String(output), ms: Date.now() - started });
    } catch (err) {
      return json(res, 200, { ok: false, error: String(err.message || err) });
    }
  }

  return json(res, 404, { error: "not found" });
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function staticFile(req, res, url) {
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const abs = path.join(PUBLIC, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
  if (!abs.startsWith(PUBLIC)) { res.writeHead(403); res.end("forbidden"); return; }
  createReadStream(abs)
    .on("error", () => { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not found"); })
    .once("open", () => {
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(abs)] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
    })
    .pipe(res);
}

/* ------------------------------------------------------------------- start */

await mkdir(ROOT, { recursive: true });

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (url.pathname.startsWith("/api/")) return await api(req, res, url);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405); res.end("method not allowed"); return;
    }
    return staticFile(req, res, url);
  } catch (err) {
    if (!res.headersSent) json(res, 500, { error: String(err.message || err) });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Local AI Studio`);
  console.log(`  ---------------`);
  console.log(`  UI       http://${HOST}:${PORT}`);
  console.log(`  workspace ${ROOT}`);
  console.log(`  provider ${MOCK ? "mock (offline demo)" : BASE}`);
  console.log(`  key      ${MOCK ? "not needed" : KEY ? "set" : "MISSING — set PROVIDER_KEY or NVIDIA_API_KEY"}`);
  console.log(`  model    ${DEFAULT_MODEL}\n`);
});
