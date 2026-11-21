# Local AI Studio

A coding agent that runs on **your** machine. Chat in the browser or straight
from a terminal; the agent reads files, writes code and runs commands inside a
workspace folder — and asks for your approval before every action.

```
browser (public/)  ─┐             node server.js                 model provider
                    ├──────────►  /api/chat  (SSE)  ──────────►  NVIDIA NIM
 terminal (cli.js) ─┘             /api/tool  (read, write, shell)  or any
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

## Terminal client (CLI)

No browser needed. `cli.js` drives the same agent over the local API, and starts
the server itself when nothing is listening:

```bash
npm run cli                                    # interactive session
npm run cli -- --mock                          # offline demo, no key
npm run cli -- --key nvapi-...                 # save the key once, then chat
npm run cli -- --list-models                   # show every provider model
npm run cli -- --yes "add a README.md"         # run one task, then exit
```

### Provider key

The first time you run `npm run cli` without a key, it asks for one (input is
hidden) and saves it. You can also supply it explicitly:

```bash
npm run cli -- --key nvapi-xxxxxxxx
PROVIDER_KEY=nvapi-xxxxxxxx npm run cli
```

Precedence is `--key` → `PROVIDER_KEY` / `NVIDIA_API_KEY` → saved config.
Keys are stored in

```
~/.config/local-ai-studio/config.json     (mode 600)
```

Change it later with the `/key <value>` command, or delete that file to forget
it. If you point at an existing server with `--url`, that server's environment
holds the key, so the CLI cannot change it for you.

### Models

The model list comes from the provider's `GET /models`, so it includes every
model your key can use — for NVIDIA NIM, the whole catalogue:

```bash
npm run cli -- --list-models
```

Inside the session:

```
/models                 list all models (numbered)
/models kimi            filter by name
/model 12               switch to model #12
/model moonshotai/...   switch by id
```

The current model is marked `*`; a choice made with `/model` is saved and reused
next time. `--model <id>` (or `--model 12`) overrides it for a single run.

Flags:

| Flag | Meaning |
|---|---|
| `--key <key>` | provider API key (saved to the config file) |
| `--base <url>` | OpenAI-compatible base URL (saved) |
| `--list-models` | print provider models and exit |
| `--mock` | offline demo provider |
| `--yes`, `-y` | auto-approve every tool call (dangerous) |
| `--model <id>` | model to use (or pick a number from `/models`) |
| `--root <dir>` | workspace (default `./workspace`) |
| `--port <n>` | server port (default `4317`) |
| `--url <base>` | use an already running server instead of spawning one |
| `--help`, `-h` | usage |

Every tool call is printed with its arguments and waits for
`[y]es / [n]o / [a]lways`. `a` turns on auto-approve for the rest of the
session. In one-shot mode with no TTY attached, approval cannot be asked, so
`--yes` is required — otherwise the command exits with status 2.

Inside the interactive session:

| Command | Does |
|---|---|
| `/help` | show commands |
| `/models [filter]` | list available models |
| `/model [n\|id]` | show or change the model (saved) |
| `/key [value]` | show, set or replace the provider key |
| `/files [path]` | list workspace files |
| `/cat <path>` | print a file |
| `/new` | clear the conversation |
| `/exit` | leave (stops a server it started) |

If the CLI starts the server, it stops it on exit. If you point it at an
existing server with `--url`, that server is left running.

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
- Nothing is persisted: closing the tab or CLI ends the conversation.

## Files

```
server.js          HTTP server, SSE streaming, tool executor, agent prompt
cli.js             terminal client (starts the server if needed)
public/index.html  chat shell, workspace tree, tool cards
public/app.js      streaming client, approval loop, file preview, markdown
public/app.css     dark UI, responsive drawer
workspace/         the sandbox the agent works in (put your project here)
```

## How a turn works

1. The client (browser or CLI) posts the conversation to `/api/chat`.
2. The server streams the model reply, holding back ` ```tool ` blocks.
3. Text arrives as `delta` events; a completed block becomes a `tool` event.
4. The UI shows the tool card and waits.
5. On approve, `POST /api/tool` executes it and returns the output.
6. The output is appended as a `TOOL RESULT …` message and the model is called
   again — until it replies without a tool call.

## Limitations

- One tool call per model turn (keeps approvals explicit and the loop simple).
- Text-only tools: no image input, no browser automation.
- Conversation state lives in the client; a reload (or a new CLI run) starts
  fresh.
- Models are imperfect at the tool format. If one ignores it, try a stronger
  instruct/coder model or restate the task.
