# Local AI Studio

A coding agent that runs on **your** machine. Chat in the browser; the agent
reads files, writes code and runs commands inside a workspace folder — and asks
for your approval before every action.

```
browser (public/)              node server.js                 model provider
 chat + tool approval  ──────►  /api/chat  (SSE)  ────────────►  NVIDIA NIM
 file tree / preview   ◄──────  /api/tool  (read, write, shell)   or any
                                workspace/  (the only folder)     OpenAI-compatible API
```

There is no cloud component and no database. Everything lives on localhost.

## Quick start

```bash
cd Local-AI-Studio
npm start
# open http://127.0.0.1:4317
```

`npm start` needs a model key:

```bash
PROVIDER_KEY=nvapi-... npm start
```

Without a key you can still explore the interface in offline demo mode, which
uses a scripted fake model:

```bash
npm run dev        # MOCK=1
```

Then ask *“create a file called hello.txt”* to watch the full approve → write →
reply loop.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `4317` | local port |
| `HOST` | `127.0.0.1` | bind address — do not expose publicly |
| `AGENT_ROOT` | `./workspace` | the only folder the agent may read/write |
| `PROVIDER_BASE` | `https://integrate.api.nvidia.com/v1` | OpenAI-compatible base URL |
| `PROVIDER_KEY` | – | API key (falls back to `NVIDIA_API_KEY`) |
| `MODEL` | `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning` | default model |
| `MAX_TOKENS` | `4096` | per-reply cap |
| `CMD_TIMEOUT_MS` | `60000` | shell command timeout |
| `MOCK` | – | `1` = offline demo provider |

### NVIDIA NIM

```bash
PROVIDER_KEY=nvapi-xxx MODEL=moonshotai/kimi-k3.1-pro npm start
```

The model picker loads `GET /v1/models`, so every NIM model is available.

### Local models (Ollama, LM Studio, llama.cpp)

Any OpenAI-compatible server works:

```bash
PROVIDER_BASE=http://127.0.0.1:11434/v1 MODEL=qwen2.5-coder:14b npm start
```

No key is needed for local servers; leave `PROVIDER_KEY` unset.

## Tools

The model calls tools by emitting one fenced block per reply:

````text
```tool
{"name":"read_file","arguments":{"path":"src/app.js"}}
```
````

| Tool | Arguments | Does |
|---|---|---|
| `list_dir` | `path` | list a directory |
| `read_file` | `path`, `start`, `end` | read text with line numbers |
| `write_file` | `path`, `content` | create or overwrite a file |
| `search` | `query`, `path`, `regex` | case-insensitive search |
| `run_command` | `command`, `timeout_ms` | run bash in the workspace |

Every call is rendered as a card showing the exact arguments. **Approve** runs
it, **Deny** returns an error to the model so it can try something else. Turn on
*auto-approve* only if you trust the task.

## Safety model

- The server binds to `127.0.0.1` and has no authentication — treat it as a
  local-only tool, never a public service.
- Paths are resolved and rejected if they escape `AGENT_ROOT`.
- Shell commands run with `bash -lc` in `AGENT_ROOT`, with a timeout and capped
  output.
- Write and shell calls require approval unless you enable auto-approve.
- The agent has no network tool; it can only run commands you approve.
- Nothing is persisted: closing the tab ends the conversation.

## Files

```
server.js          HTTP server, SSE streaming, tool executor, agent prompt
public/index.html  chat shell, workspace tree, tool cards
public/app.js      streaming client, approval loop, file preview, markdown
public/app.css     dark UI, responsive drawer
workspace/         the sandbox the agent works in (put your project here)
```

## How a turn works

1. The browser posts the conversation to `/api/chat`.
2. The server streams the model reply, holding back ` ```tool ` blocks.
3. Text arrives as `delta` events; a completed block becomes a `tool` event.
4. The UI shows the tool card and waits.
5. On approve, `POST /api/tool` executes it and returns the output.
6. The output is appended as a `TOOL RESULT …` message and the model is called
   again — until it replies without a tool call.

## Limitations

- One tool call per model turn (keeps approvals explicit and the loop simple).
- Text-only tools: no image input, no browser automation.
- Conversation state lives in the tab; a reload starts fresh.
- Models are imperfect at the tool format. If one ignores it, try a stronger
  instruct/coder model or restate the task.
