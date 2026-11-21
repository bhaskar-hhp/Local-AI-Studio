/* Local AI Studio — chat + approval UI for the local agent. */

(() => {
  "use strict";

  const $ = (s, root = document) => root.querySelector(s);

  const LS = {
    model: "localstudio.model.v1",
    auto: "localstudio.auto.v1",
  };

  const state = {
    messages: [],          // {role, content} sent to the server
    items: [],             // richer list for rendering
    model: "",
    models: [],
    busy: false,
    controller: null,
    pending: null,         // tool call awaiting approval
    auto: false,
    stick: true,
    root: "",
    mock: false,
  };

  /* ---------------------------------------------------------------- utils */

  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

  const num = (n) => Number(n || 0).toLocaleString();

  const fmtBytes = (n) => {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / 1024 / 1024).toFixed(1)} MB`;
  };

  const fmtTime = () => new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  const short = (p, max = 46) => {
    const s = String(p || "");
    return s.length > max ? "…" + s.slice(-max) : s;
  };

  let toastTimer = 0;
  function toast(msg) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2400);
  }

  /* ------------------------------------------------------------- markdown */

  const FENCE = "\uE000";

  function codeBlock(lang, code) {
    return `<div class="code"><div class="code-head"><span>${esc(lang || "text")}</span>` +
      `<button class="copy-btn" type="button">Copy</button></div>` +
      `<pre><code>${esc(code.replace(/\n$/, ""))}</code></pre></div>`;
  }

  function inlineFmt(text) {
    return esc(text)
      .replace(/`([^`\n]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  }

  function renderMarkdown(src) {
    let text = String(src || "").replace(/\r\n/g, "\n");
    const blocks = [];

    text = text.replace(/```([\w.+-]*)[ \t]*\n([\s\S]*?)```/g, (_, lang, code) => {
      blocks.push({ lang, code });
      return `\n${FENCE}${blocks.length - 1}${FENCE}\n`;
    });
    text = text.replace(/```([\w.+-]*)[ \t]*\n([\s\S]*)$/, (_, lang, code) => {
      blocks.push({ lang, code });
      return `\n${FENCE}${blocks.length - 1}${FENCE}\n`;
    });

    const lines = text.split("\n");
    let html = "";
    let para = [];
    let list = "";

    const flushPara = () => {
      if (!para.length) return;
      html += `<p>${para.map(inlineFmt).join("<br>")}</p>`;
      para = [];
    };
    const closeList = () => {
      if (!list) return;
      html += `</${list}>`;
      list = "";
    };

    for (const rawLine of lines) {
      const line = rawLine.replace(/\s+$/, "");
      const ph = line.match(new RegExp(`^${FENCE}(\\d+)${FENCE}$`));
      if (ph) {
        flushPara(); closeList();
        const b = blocks[Number(ph[1])];
        html += codeBlock(b.lang, b.code);
        continue;
      }
      if (!line.trim()) { flushPara(); closeList(); continue; }

      const h = line.match(/^(#{1,4})\s+(.*)$/);
      if (h) {
        flushPara(); closeList();
        const level = Math.min(4, h[1].length + 1);
        html += `<h${level}>${inlineFmt(h[2])}</h${level}>`;
        continue;
      }
      if (/^\s*([-*_])\1{2,}\s*$/.test(line)) { flushPara(); closeList(); html += "<hr>"; continue; }

      const ul = line.match(/^\s*[-*+]\s+(.*)$/);
      if (ul) {
        flushPara();
        if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
        html += `<li>${inlineFmt(ul[1])}</li>`;
        continue;
      }
      const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
      if (ol) {
        flushPara();
        if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
        html += `<li>${inlineFmt(ol[1])}</li>`;
        continue;
      }
      const bq = line.match(/^>\s?(.*)$/);
      if (bq) { flushPara(); closeList(); html += `<blockquote>${inlineFmt(bq[1])}</blockquote>`; continue; }

      para.push(line);
    }
    flushPara(); closeList();
    return html;
  }

  /* ---------------------------------------------------------------- render */

  function scrollBottom(force) {
    const box = $("#chat");
    if (force || state.stick) box.scrollTop = box.scrollHeight;
  }

  function hero() {
    const el = document.createElement("div");
    el.className = "hero";
    el.innerHTML = `
      <div class="hero-mark" aria-hidden="true">&lt;/&gt;</div>
      <h2>A coding agent on your machine</h2>
      <p>It reads files, writes code and runs commands inside
         <code>${esc(short(state.root || "workspace", 40))}</code> — and asks before every action.</p>
      <div class="suggestions">
        <button type="button" data-prompt="List the files in this workspace and explain what the project does.">Explore this workspace</button>
        <button type="button" data-prompt="Create a small Python script that prints the current date and time, then run it.">Create and run a script</button>
        <button type="button" data-prompt="Find every TODO comment in the workspace and summarise them.">Find TODOs</button>
      </div>`;
    el.querySelectorAll(".suggestions button").forEach((b) => {
      b.onclick = () => { $("#prompt").value = b.dataset.prompt; autoGrow(); $("#prompt").focus(); };
    });
    return el;
  }

  function messageNode(item) {
    const wrap = document.createElement("div");

    if (item.role === "user") {
      wrap.className = "msg user";
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      bubble.textContent = item.content;
      wrap.appendChild(bubble);
      return wrap;
    }

    wrap.className = "msg assistant";
    wrap.dataset.id = item.id;

    const head = document.createElement("div");
    head.className = "msg-head";
    const mark = document.createElement("span");
    mark.className = "msg-mark";
    mark.textContent = "◆";
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = "agent";
    const when = document.createElement("span");
    when.className = "when";
    when.textContent = item.time || fmtTime();
    head.append(mark, who, when);
    wrap.appendChild(head);

    const body = document.createElement("div");
    body.className = "msg-body md";
    body.innerHTML = item.text
      ? renderMarkdown(item.text)
      : (item.error || item.tool ? "" : '<span class="thinking"><span class="spin"></span>thinking…</span>');
    wrap.appendChild(body);

    if (item.tool) wrap.appendChild(toolNode(item));
    if (item.error) {
      const e = document.createElement("div");
      e.className = "msg-error";
      e.textContent = item.error;
      wrap.appendChild(e);
    }
    return wrap;
  }

  function toolNode(item) {
    const call = item.tool;
    const target = call.arguments?.path || call.arguments?.command || call.arguments?.query || "";

    const box = document.createElement("div");
    box.className = "tool " + (item.toolState === "awaiting" ? "pending"
      : item.toolState === "done" ? (item.toolResult?.ok ? "ok" : "err")
      : item.toolState === "denied" ? "err" : "");

    const head = document.createElement("div");
    head.className = "tool-head";
    head.innerHTML = `<span class="tool-name">${esc(call.name)}</span>` +
      `<span class="tool-target" title="${esc(target)}">${esc(short(target, 60))}</span>` +
      `<span class="tool-state">${esc(item.toolState || "pending")}</span>`;
    box.appendChild(head);

    const body = document.createElement("div");
    body.className = "tool-body";
    const pre = document.createElement("pre");
    if (item.toolState === "done" || item.toolState === "denied") {
      pre.textContent = item.toolResult?.ok
        ? item.toolResult.output
        : (item.toolResult?.error || "denied by user");
      if (!item.toolResult?.ok) pre.className = "dim";
    } else {
      pre.textContent = JSON.stringify(call.arguments, null, 2).slice(0, 4000);
      pre.className = "dim";
    }
    body.appendChild(pre);
    box.appendChild(body);

    if (item.toolState === "awaiting") {
      const actions = document.createElement("div");
      actions.className = "tool-actions";
      const note = document.createElement("span");
      note.className = "tool-note";
      note.textContent = "Review the arguments, then approve or deny.";
      const deny = document.createElement("button");
      deny.type = "button";
      deny.className = "btn danger small";
      deny.textContent = "Deny";
      deny.onclick = () => decideTool(item, false);
      const ok = document.createElement("button");
      ok.type = "button";
      ok.className = "btn primary small";
      ok.textContent = "Approve";
      ok.onclick = () => decideTool(item, true);
      actions.append(note, deny, ok);
      box.appendChild(actions);
    }

    return box;
  }

  function renderChat() {
    const chat = $("#chat");
    chat.innerHTML = "";
    if (!state.items.length) {
      chat.appendChild(hero());
      state.stick = true;
      return;
    }
    const frag = document.createDocumentFragment();
    for (const item of state.items) {
      if (item.role === "user" && item.hidden) continue;
      frag.appendChild(messageNode(item));
    }
    chat.appendChild(frag);
    scrollBottom(true);
  }

  function updateItemNode(item) {
    const node = $(`.msg.assistant[data-id="${item.id}"]`);
    if (!node) { renderChat(); return; }
    const fresh = messageNode(item);
    node.replaceWith(fresh);
    scrollBottom(false);
  }

  /* ----------------------------------------------------------------- state */

  function pushAssistant() {
    const item = {
      id: "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      role: "assistant",
      text: "",
      content: "",
      tool: null,
      toolState: null,
      toolResult: null,
      error: "",
      time: fmtTime(),
      ms: 0,
    };
    state.items.push(item);
    return item;
  }

  function pushUser(content) {
    state.messages.push({ role: "user", content });
    state.items.push({ role: "user", content, time: fmtTime() });
    renderChat();
  }

  function pushToolResult(text) {
    state.messages.push({ role: "user", content: text });
    // shown inside the tool card, not as a bubble
    state.items.push({ role: "user", content: text, hidden: true });
  }

  function syncAssistant(item) {
    state.messages.push({ role: "assistant", content: item.content || item.text || "" });
  }

  /* ------------------------------------------------------------------- api */

  async function api(path, opts = {}) {
    const res = await fetch(path, opts);
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
    return body;
  }

  async function loadHealth() {
    try {
      const h = await api("/api/health");
      state.root = h.root;
      state.mock = !!h.mock;
      $("#root-path").textContent = short(h.root, 44);
      $("#root-path").title = h.root;
      setConn(h.has_key ? "live" : "warn",
        h.mock ? "mock mode" : h.has_key ? "local agent ready" : "no API key");
      if (!h.has_key) {
        $("#banner").hidden = false;
        $("#banner").textContent =
          "The server has no model key. Start it with PROVIDER_KEY=… (or NVIDIA_API_KEY=…) and reload.";
      }
      return h;
    } catch {
      setConn("down", "server unreachable");
      $("#banner").hidden = false;
      $("#banner").textContent = "Cannot reach the local server. Run `node server.js` and reload.";
      return null;
    }
  }

  function setConn(kind, text) {
    const el = $("#conn-state");
    el.className = "state " + kind;
    el.textContent = text;
  }

  async function loadModels(health) {
    let models = [];
    try {
      const body = await api("/api/models");
      models = body.models || [];
      state.model = localStorage.getItem(LS.model) || body.default || models[0]?.id || "";
      if (!models.some((m) => m.id === state.model)) state.model = models[0]?.id || "";
    } catch {
      models = [{ id: health?.model || "unknown", owned_by: "" }];
      state.model = models[0].id;
    }
    state.models = models;
    const sel = $("#model-select");
    sel.innerHTML = "";
    for (const m of models) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.id;
      sel.appendChild(opt);
    }
    sel.value = state.model;
  }

  /* --------------------------------------------------------------- file tree */

  async function loadTree(path = ".", container = $("#tree")) {
    container.innerHTML = "";
    let body;
    try { body = await api(`/api/tree?path=${encodeURIComponent(path)}`); }
    catch (err) { container.innerHTML = `<div class="tree-empty">${esc(err.message)}</div>`; return; }

    if (!body.entries.length) {
      container.innerHTML = '<div class="tree-empty">empty folder</div>';
      return;
    }
    for (const e of body.entries) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "tree-item" + (e.dir ? " dir" : "");
      row.style.paddingLeft = `${6 + (path.split("/").filter(Boolean).length) * 10}px`;
      row.innerHTML = `<span class="ico">${e.dir ? "▸" : "·"}</span>` +
        `<span class="name">${esc(e.name)}</span>` +
        (e.dir ? "" : `<span class="size">${fmtBytes(e.size)}</span>`);

      if (e.dir) {
        let open = false;
        let child = null;
        row.onclick = async () => {
          open = !open;
          row.querySelector(".ico").textContent = open ? "▾" : "▸";
          if (open) {
            child = document.createElement("div");
            row.after(child);
            await loadTree(path === "." ? e.name : `${path}/${e.name}`, child);
          } else if (child) {
            child.remove();
            child = null;
          }
        };
      } else {
        row.onclick = () => previewFile(path === "." ? e.name : `${path}/${e.name}`);
      }
      container.appendChild(row);
    }
  }

  async function previewFile(path) {
    try {
      const body = await api(`/api/file?path=${encodeURIComponent(path)}`);
      $("#preview-path").textContent = `${body.path} (${fmtBytes(body.size)})`;
      $("#preview-body").textContent = body.text;
      $("#preview").showModal();
    } catch (err) {
      toast(err.message);
    }
  }

  /* ------------------------------------------------------------------- send */

  function buildPayload() {
    return {
      model: state.model,
      messages: state.messages.map((m) => ({ role: m.role, content: m.content })),
    };
  }

  async function runTurn() {
    const item = pushAssistant();
    renderChat();
    state.busy = true;
    $("#stop").hidden = false;
    updateComposer();
    state.controller = new AbortController();
    const started = performance.now();

    let raf = 0;
    const live = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = 0; updateItemNode(item); });
    };

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(buildPayload()),
        signal: state.controller.signal,
      });

      if (!res.ok || !res.body) {
        const detail = await res.json().catch(() => ({}));
        throw new Error(detail.error || `HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

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
            if (!data) continue;
            let msg;
            try { msg = JSON.parse(data); } catch { continue; }

            if (msg.type === "delta") {
              item.text += msg.text;
              live();
            } else if (msg.type === "tool") {
              item.tool = msg.call;
              item.toolState = "awaiting";
              live();
            } else if (msg.type === "done") {
              item.content = msg.content || item.text;
            } else if (msg.type === "error") {
              item.error = msg.error + (msg.detail ? `: ${msg.detail}` : "");
            }
          }
        }
      }

      item.ms = Math.round(performance.now() - started);
      syncAssistant(item);

      if (item.error) {
        toast(item.error);
      } else if (item.tool) {
        if (state.auto) {
          await decideTool(item, true);
          return;
        }
        state.pending = item;
        toast("Approve the tool call to continue");
      } else if (!item.content && !item.text) {
        item.text = "_(no reply)_";
      }
    } catch (err) {
      if (err.name === "AbortError") item.error = "Stopped";
      else item.error = String(err.message || err);
    } finally {
      state.busy = false;
      state.controller = null;
      $("#stop").hidden = true;
      updateItemNode(item);
      updateComposer();
    }
  }

  async function send() {
    if (state.busy || state.pending) return;
    const text = $("#prompt").value.trim();
    if (!text) return;

    $("#prompt").value = "";
    autoGrow();
    pushUser(text);
    await runTurn();
  }

  async function decideTool(item, approve) {
    if (!item || item.toolState !== "awaiting") return;
    state.pending = null;
    state.busy = true;
    updateComposer();
    item.toolState = "running";
    updateItemNode(item);

    if (!approve) {
      item.toolState = "denied";
      item.toolResult = { ok: false, error: "Denied by the user." };
      pushToolResult(`TOOL RESULT ${item.tool.name}: denied by the user. Do not retry the same call; ask or try another approach.`);
      updateItemNode(item);
      await runTurn();
      return;
    }

    try {
      const res = await api("/api/tool", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ call: item.tool }),
      });
      item.toolState = "done";
      item.toolResult = res;
      const out = res.ok ? String(res.output) : `ERROR: ${res.error}`;
      pushToolResult(`TOOL RESULT ${item.tool.name}:\n${out.length > 12000 ? out.slice(0, 12000) + "\n…" : out}`);
      updateItemNode(item);
      if (res.ok) loadTree(".");
      if (!res.ok) toast(`${item.tool.name} failed`);
      await runTurn();
    } catch (err) {
      item.toolState = "done";
      item.toolResult = { ok: false, error: String(err.message || err) };
      pushToolResult(`TOOL RESULT ${item.tool.name}: ERROR: ${err.message}`);
      updateItemNode(item);
      await runTurn();
    }
  }

  /* ---------------------------------------------------------------- helpers */

  function autoGrow() {
    const t = $("#prompt");
    t.style.height = "auto";
    t.style.height = Math.min(220, t.scrollHeight) + "px";
  }

  function updateComposer() {
    const blocked = state.busy || !!state.pending;
    $("#send").disabled = blocked;
    $("#send").hidden = state.busy;
    $("#stop").hidden = !state.busy;
    $("#hint").textContent = state.pending
      ? "waiting for your approval"
      : state.busy ? "working…" : "";
  }

  function newChat() {
    if (state.busy) { toast("Stop the current run first"); return; }
    state.messages = [];
    state.items = [];
    state.pending = null;
    renderChat();
    updateComposer();
    closeSidebar();
  }

  function openSidebar() {
    $("#sidebar").classList.add("open");
    $("#scrim").hidden = false;
  }
  function closeSidebar() {
    $("#sidebar").classList.remove("open");
    $("#scrim").hidden = true;
  }

  /* ------------------------------------------------------------------ bind */

  function bind() {
    $("#sidebar-toggle").onclick = openSidebar;
    $("#sidebar-close").onclick = closeSidebar;
    $("#scrim").onclick = closeSidebar;

    $("#send").onclick = send;
    $("#stop").onclick = () => { if (state.controller) state.controller.abort(); };

    $("#prompt").addEventListener("input", autoGrow);
    $("#prompt").addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
    });

    $("#new-chat").onclick = newChat;
    $("#clear-chat").onclick = newChat;
    $("#tree-refresh").onclick = () => loadTree(".");

    $("#model-select").onchange = (e) => {
      state.model = e.target.value;
      localStorage.setItem(LS.model, state.model);
    };

    const auto = $("#auto-approve");
    auto.checked = localStorage.getItem(LS.auto) === "1";
    state.auto = auto.checked;
    auto.onchange = () => {
      state.auto = auto.checked;
      localStorage.setItem(LS.auto, auto.checked ? "1" : "0");
      if (state.auto && state.pending) decideTool(state.pending, true);
    };

    $("#chat").addEventListener("scroll", () => {
      const box = $("#chat");
      state.stick = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
    });

    $("#chat").addEventListener("click", async (e) => {
      const btn = e.target.closest(".copy-btn");
      if (!btn) return;
      const code = btn.closest(".code")?.querySelector("pre");
      if (!code) return;
      try {
        await navigator.clipboard.writeText(code.innerText);
        btn.textContent = "Copied";
      } catch {
        btn.textContent = "Failed";
      }
      setTimeout(() => { btn.textContent = "Copy"; }, 1400);
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && $("#sidebar").classList.contains("open")) closeSidebar();
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        $("#prompt").focus();
      }
    });
  }

  /* ------------------------------------------------------------------ init */

  async function init() {
    bind();
    renderChat();
    updateComposer();

    const health = await loadHealth();
    await loadModels(health);
    await loadTree(".");
    updateComposer();
    $("#prompt").focus();
  }

  init();
})();
