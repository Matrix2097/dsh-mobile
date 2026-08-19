// app.js — DSH 监管 PWA 前端
"use strict";

const $ = (id) => document.getElementById(id);
const cfg = {
  get() {
    try { return JSON.parse(localStorage.getItem("dshm.cfg") || "{}"); } catch { return {}; }
  },
  save(c) { localStorage.setItem("dshm.cfg", JSON.stringify(c)); },
};
const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString("zh-CN", { hour12: false }) : "—");
const fmtSize = (n) => (n == null ? "" : n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let api = null; // { base, token }
let es = null;
let state = null;
let fsPath = "";

// ---------- 连接 ----------
async function connect(silent) {
  const c = cfg.get();
  if (!c.host) { toast("请先填写电脑 IP"); return; }
  // 容错清洗：IP 栏允许误填 http:// 前缀、端口、尾部斜杠
  let host = c.host.trim().replace(/^https?:\/\//i, "").replace(/\/+$/, "");
  const hm = host.match(/^([^:/]+)(?::(\d+))?$/);
  if (hm && hm[2]) { host = hm[1]; c.port = Number(hm[2]) || c.port; }
  c.host = host;
  // 令牌取第一段连续字符（防复制时带上尾部说明文字）
  const tm = (c.token || "").trim().match(/^[A-Za-z0-9_-]+/);
  c.token = tm ? tm[0] : "";
  cfg.save(c);
  api = { base: `http://${c.host}:${c.port || 8443}`, token: c.token };
  try {
    const res = await fetch(`${api.base}/api/state`, { headers: { "x-gateway-token": api.token } });
    if (res.status === 401) throw new Error("令牌不正确（对照网关窗口重新填写）");
    if (!res.ok) throw new Error(`网关返回 HTTP ${res.status}`);
    state = await res.json();
    cfg.save(c);
    setBadge(true);
    $("conn-result").textContent = `已连接：端口 ${state.dshPort ?? "探测中"} · 版本 ${state.describe?.version ?? "—"}`;
    startSse();
    renderAll();
    if (!silent) toast("连接成功");
    return true;
  } catch (err) {
    setBadge(false);
    const hint = String(err.message).toLowerCase().includes("fetch")
      ? "（检查：① IP 是否填对 ② 电脑网关窗口是否还开着 ③ 手机和电脑是否同一 WiFi）"
      : "";
    $("conn-result").textContent = `连接失败：${err.message}${hint}`;
    if (!silent) toast("连接失败");
    return false;
  }
}

function startSse() {
  if (es) es.close();
  const q = api.token ? `?token=${encodeURIComponent(api.token)}` : "";
  es = new EventSource(`${api.base}/api/stream${q}`);
  es.onopen = () => setBadge(true);
  es.onerror = () => setBadge(false);
  es.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    onMessage(msg);
  };
}

function setBadge(on) {
  const b = $("conn-badge");
  b.textContent = on ? "已连接" : "未连接";
  b.className = "badge " + (on ? "badge-on" : "badge-off");
}

// ---------- 消息处理 ----------
function onMessage(msg) {
  switch (msg.type) {
    case "snapshot":
      state = msg.state;
      renderAll();
      break;
    case "notify":
      pushEventLog(`[通知] ${msg.title}：${msg.body}`);
      // 只对任务相关的提醒弹系统通知；连接状态/授权结果仅记录日志
      if (["job", "approval", "question", "agent-error"].includes(msg.kind)) {
        systemNotify(msg.title, msg.body, msg.kind);
      }
      break;
    case "session-event":
      if (msg.sessionId === currentDetail) ingestEvent(msg.event);
      if (msg.event?.type !== "assistant/chunk") pushEventLog(`[事件] ${msg.sessionId.slice(0, 8)}… ${label(msg.event?.type)}`);
      break;
    case "jobs":
      if (state) { state.jobs[msg.sessionId] = msg.jobs; renderSessions(); }
      break;
    case "sessions":
      if (state) renderSessions();
      break;
    case "workspaces":
      if (state) renderSessions();
      break;
    default:
      break;
  }
}

function systemNotify(title, body, kind = "info") {
  if (!("Notification" in window)) return;
  if (Notification.permission !== "granted") return;
  try {
    new Notification(title, { body, tag: "dshm-" + kind });
  } catch { /* noop */ }
}

// ---------- 渲染 ----------
function renderAll() {
  if (!state) return;
  renderOverview();
  renderPending();
  renderRunning();
  renderSessions();
  renderEventLog();
  if (currentDetail) renderPermChips(); // 详情页打开时同步权限状态
}

function renderOverview() {
  $("ov-port").textContent = state.dshPort ?? "—";
  $("ov-version").textContent = state.describe?.version ?? "—";
  $("ov-cwd").textContent = state.describe?.cwd ?? "—";
  $("ov-model").textContent = [state.describe?.provider, state.describe?.model].filter(Boolean).join(" / ") || "—";
  $("ov-sessions").textContent = String(state.sessions?.length ?? 0);
}

const JOB_LABEL = { running: "进行中", stopping: "停止中", completed: "已完成", killed: "已终止", failed: "失败" };
const EVENT_LABEL = {
  "user/message": "用户消息",
  "assistant/message": "Agent 回复",
  "tool/call": "工具调用",
  "tool/result": "工具结果",
  "session/title": "会话标题更新",
  "goal/change": "目标变更",
  "todo/write": "任务清单更新",
  "session/jobs": "任务进度",
  "approval/requested": "请求授权",
  "approval/resolved": "授权已处理",
  "question/requested": "Agent 提问",
  "question/resolved": "提问已处理",
  "host/session-added": "新会话",
  "host/session-removed": "会话移除",
  "host/session-status": "会话状态变化",
  "host/agent-error": "Agent 出错",
  "host/workspace-changed": "工作区变化",
  "host/workspace-removed": "工作区移除",
  "stream/error": "流错误",
};
const label = (t) => EVENT_LABEL[t] || t;

function renderPending() {
  const card = $("pending-card");
  const list = $("pending-list");
  const items = [...(state.approvals ?? []), ...(state.questions ?? [])];
  card.hidden = items.length === 0;
  if (items.length === 0) return;
  list.innerHTML = items.map((it) => {
    if (it.toolName) {
      // 审批
      return `<div class="pending"><h4>🔐 需要授权：${esc(it.toolName)}</h4>
        <p>会话 ${esc(it.sessionId.slice(0, 12))}…${it.reason ? `<br>原因：${esc(it.reason)}` : ""}</p>
        <div class="row">
          <button class="btn allow" onclick="answerApproval('${esc(it.approvalId)}','allowed-once')">同意</button>
          <button class="btn reject" onclick="answerApproval('${esc(it.approvalId)}','rejected')">拒绝</button>
        </div></div>`;
    }
    // 提问
    const qs = it.questions ?? [];
    return `<div class="pending"><h4>❓ 新提问</h4>
      <p>${qs.map((q) => esc(q.question)).join("<br>")}</p></div>`;
  }).join("");
}

function sessionCard(s) {
  const running = !!s.running;
  const jobs = (state?.jobs ?? {})[s.sessionId] ?? [];
  const title = s.projections?.values?.title;
  // 只展开显示进行中的任务；已结束的历史任务收成一行计数
  const activeJobs = jobs.filter((j) => j.status === "running" || j.status === "stopping");
  const doneCount = jobs.length - activeJobs.length;
  const jobsHtml = (activeJobs.length ? activeJobs.map((j) => {
    const dot = j.status in { running: 1, stopping: 1 } ? "dot-running" : `dot-${j.status}`;
    return `<div class="job"><span class="dot ${dot}"></span><span>${esc(j.label)}</span><span style="color:var(--dim)">${JOB_LABEL[j.status] ?? j.status}</span></div>`;
  }).join("") : "")
    + (doneCount > 0 ? `<div class="job"><span style="color:var(--dim)">🕓 已结束的历史任务 ${doneCount} 个</span></div>` : "");
  return `<div class="session" onclick="openSession('${esc(s.sessionId)}')">
    <div class="session-head">
      <span class="session-id">${esc(title || s.sessionId)}</span>
      <span class="pill ${running ? "pill-running" : "pill-idle"}">${running ? "运行中" : "空闲"}</span>
    </div>
    <div class="session-meta">
      ${s.cwd ? "📁 " + esc(s.cwd) + "<br>" : ""}
      ${s.agentPreset ? "🧩 " + esc(s.agentPreset) + "<br>" : ""}
      🕐 更新于 ${fmtTime(s.updatedAt)}${s.sessionId ? "<br>🆔 " + esc(s.sessionId) : ""}
    </div>
    ${jobsHtml ? `<div style="margin-top:6px">${jobsHtml}</div>` : ""}
  </div>`;
}

function renderRunning() {
  const sessions = state?.sessions ?? [];
  const running = sessions.filter((s) => s.running);
  const recent = [...sessions].sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0)).slice(0, 3);
  const el = $("running-list");
  if (running.length) {
    el.innerHTML = running.map(sessionCard).join("");
  } else if (recent.length) {
    el.innerHTML = `<div class="empty" style="padding:8px 0">当前无运行中的 Agent，最近活跃会话：</div>` + recent.map(sessionCard).join("");
  } else {
    el.innerHTML = `<div class="empty">暂无会话</div>`;
  }
}

// ---------- 会话详情（消息流 + 实时 + 发送） ----------
let currentDetail = null;   // 当前打开的 sessionId
let detailEvents = [];      // 渲染源：过滤后的完整事件
let detailStream = null;    // 进行中（流式）缓冲 {texts, reasoning, tools}
let streamTimer = null;
let detailClosed = false;
let lastLiveAt = 0;         // 最近一次收到当前会话事件的时间
let liveTimer = null;

function updateLiveIndicator() {
  const el = $("detail-live");
  if (!el) return;
  const ago = lastLiveAt ? Math.round((Date.now() - lastLiveAt) / 1000) : -1;
  if (ago >= 0 && ago <= 8) {
    el.className = "live-indicator live";
    el.innerHTML = `<span class="dot"></span>● 实时：${ago === 0 ? "刚刚" : ago + " 秒前"}收到事件`;
  } else if (ago > 8) {
    el.className = "live-indicator";
    el.innerHTML = `<span class="dot"></span>● 实时：${ago} 秒前（可能空闲）`;
  } else {
    el.className = "live-indicator";
    el.innerHTML = `<span class="dot"></span>● 实时：等待事件…`;
  }
}

function scheduleLiveTick() {
  if (liveTimer) return;
  liveTimer = setTimeout(() => {
    liveTimer = null;
    updateLiveIndicator();
  }, 2000);
}

async function openSession(sessionId) {
  if (!api) return;
  currentDetail = sessionId;
  detailEvents = [];
  detailStream = null;
  detailClosed = false;
  lastLiveAt = 0;
  updateLiveIndicator();
  document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
  document.querySelector('[data-view="view-sessions"]').classList.add("active");
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  $("view-detail").hidden = false;
  $("detail-title").textContent = "会话详情";
  $("detail-meta").textContent = "🆔 " + sessionId;
  $("detail-messages").innerHTML = `<div class="empty">加载中…</div>`;
  try {
    const res = await fetch(`${api.base}/api/history?sessionId=${encodeURIComponent(sessionId)}&maxMessages=40`, { headers: { "x-gateway-token": api.token } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "unknown");
    const title = state?.sessions?.find((s) => s.sessionId === sessionId)?.projections?.values?.title;
    if (title) $("detail-title").textContent = title;
    detailEvents = data.value?.events ?? [];
    renderDetail();
    loadModels(sessionId);
    renderPermChips();
  } catch (err) {
    $("detail-messages").innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
  }
}

// ---------- 模型 / 权限切换 ----------
function toggleTools(forceOpen) {
  const tools = $("detail-tools");
  const btn = $("tools-toggle");
  const open = forceOpen !== undefined ? forceOpen : tools.hidden;
  tools.hidden = !open;
  btn.classList.toggle("open", open);
  btn.textContent = open ? "⚙️ 模型与权限 ▴" : "⚙️ 模型与权限 ▾";
}

async function loadModels(sessionId) {
  const sel = $("detail-model");
  sel.innerHTML = `<option>加载中…</option>`;
  try {
    const res = await fetch(`${api.base}/api/models?sessionId=${encodeURIComponent(sessionId)}`, { headers: { "x-gateway-token": api.token } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!data.ok) throw new Error(data.error ?? "unknown");
    const v = data.value;
    let html = "";
    for (const g of v.groups ?? []) {
      html += `<optgroup label="${esc(g.name)}">`;
      for (const m of g.models ?? []) {
        const selected = v.current?.provider === g.id && v.current?.model === m.id ? " selected" : "";
        html += `<option value="${esc(g.id)}|${esc(m.id)}"${selected}>${esc(m.name)}</option>`;
      }
      html += `</optgroup>`;
    }
    if (!html) html = `<option>（无可用模型）</option>`;
    sel.innerHTML = html;
  } catch (err) {
    sel.innerHTML = `<option>加载失败</option>`;
    toast("模型列表加载失败：" + err.message);
  }
}

function currentPermission() {
  const s = state?.sessions?.find((x) => x.sessionId === currentDetail);
  return s?.projections?.values?.permissions?.currentValue ?? null;
}

function renderPermChips() {
  const cur = currentPermission();
  document.querySelectorAll("#detail-perm .perm-chip").forEach((b) => {
    const active = cur === b.dataset.mode;
    b.classList.toggle("active", active);
    b.classList.toggle("danger", b.dataset.mode === "danger-full-access");
  });
}

async function changeModel(sessionId) {
  const sel = $("detail-model");
  const [provider, model] = (sel.value || "").split("|");
  if (!provider || !model) return;
  try {
    const res = await fetch(`${api.base}/api/select-model`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": api.token },
      body: JSON.stringify({ sessionId, provider, model }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    toast("模型已切换：" + (data.value?.selected?.model ?? model));
    toggleTools(false); // 切换成功后收起
  } catch (err) {
    toast("切换失败：" + err.message);
    loadModels(sessionId); // 回滚下拉显示
  }
}

async function changePermission(mode) {
  if (!api || !currentDetail) return;
  if (mode === "danger-full-access") {
    if (!confirm("切换到「完全访问」？Agent 将可以读写电脑上任意位置并执行任意命令。\n\n仅在你信任当前任务时启用。")) return;
  }
  try {
    const res = await fetch(`${api.base}/api/permission`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": api.token },
      body: JSON.stringify({ sessionId: currentDetail, mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    const r = data.value?.result;
    const labels = { "read-only": "只读", "workspace-write": "工作区可写", "danger-full-access": "完全访问" };
    if (r?.kind === "success") {
      toast("权限已切换：" + labels[mode]);
      toggleTools(false); // 切换成功后收起
    }
    else if (r?.kind === "error") toast("切换失败：" + (r.text ?? "命令报错"));
    else toast("未找到 /permission 命令");
  } catch (err) {
    toast("切换失败：" + err.message);
  }
}

/** 只渲染真正来自用户的输入；插件注入的上下文（如 goal 完成通知，role 也是 user）跳过 */
function isRealUserMsg(m) {
  return m?.role === "user" && (m.source == null || m.source.kind === "user");
}

/** SSE 推送的会话事件 → 增量接入详情页 */
function ingestEvent(ev) {
  if (detailClosed) return;
  lastLiveAt = Date.now();
  updateLiveIndicator();
  scheduleLiveTick();
  if (ev.type === "assistant/chunk") {
    const c = ev.data?.chunk;
    if (!c) return;
    // 逐字流式：按块 index 累积 reasoning-delta / text-delta / tool-call-delta
    if (!detailStream) detailStream = { blocks: {}, order: [] };
    const b = detailStream.blocks[c.index] ?? { type: null, parts: [], name: null };
    if (c.type === "block-start") {
      b.type = c.blockType;
    } else if (c.type === "reasoning-delta") {
      b.type = "reasoning";
      b.parts.push(c.text ?? "");
    } else if (c.type === "text-delta") {
      b.type = "text";
      b.parts.push(c.text ?? "");
    } else if (c.type === "tool-call-delta") {
      b.type = "tool-call";
      b.name = c.name ?? b.name;
      b.parts.push(c.argumentsDelta ?? "");
    } else if (c.type === "block-end" && c.block) {
      // 兜底：delta 缺失时用完整块；已有累积则保留（避免重复）
      if (!b.parts?.length) {
        if (c.block.type === "text" || c.block.type === "reasoning") b.parts = [c.block.text ?? ""];
        else if (c.block.type === "tool-call") { b.parts = [c.block.arguments ?? ""]; b.name = c.block.name; }
        b.type = c.block.type;
      }
    }
    detailStream.blocks[c.index] = b;
    if (!detailStream.order.includes(c.index)) detailStream.order.push(c.index);
    scheduleStreamFlush();
    return;
  }
  if (ev.type === "assistant/message") detailStream = null;
  const RENDERABLE = new Set(["user/message", "agent/inbox/spliced", "assistant/message", "tool/call", "tool/result", "session/title", "goal/change", "todo/write"]);
  if (RENDERABLE.has(ev.type)) {
    // 收到真实的用户消息回显时，替换本地乐观插入（插件注入的上下文消息不算）
    const splicedHasRealUser = ev.type === "agent/inbox/spliced" && (ev.data?.inserted ?? []).some(isRealUserMsg);
    const userMsgIsReal = ev.type === "user/message" && isRealUserMsg(ev.data?.message || ev.data);
    if (splicedHasRealUser || userMsgIsReal) {
      const localIdx = detailEvents.findIndex((e) => e._local);
      if (localIdx >= 0) detailEvents.splice(localIdx, 1);
    }
    // 统一为 history 条目的 {event} 包装格式（渲染层只认这种）
    detailEvents.push({ event: ev });
    renderDetail();
  }
}

function scheduleStreamFlush() {
  if (streamTimer) return;
  streamTimer = setTimeout(() => {
    streamTimer = null;
    renderDetail();
  }, 80);
}

function renderDetail() {
  renderEventList(detailEvents, detailStream);
}

function renderEventList(events, stream) {
  const el = $("detail-messages");
  const userMsg = (m) => {
    const text = (m.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join("\n");
    return `<div class="msg msg-user"><div class="msg-bubble">${esc(text || "(空)")}</div></div>`;
  };
  const assistantMsg = (m) => {
    let body = "";
    for (const b of m.content ?? []) {
      if (b.type === "text" && b.text) body += `<div class="msg-text">${esc(b.text)}</div>`;
      else if (b.type === "reasoning" && b.text) {
        body += `<details class="collapse"><summary>💭 思考过程</summary><div class="collapse-body"><div class="msg-reason">${esc(b.text)}</div></div></details>`;
      }
      // tool-call 块由 tool/call + tool/result 事件渲染，这里跳过避免重复
    }
    return body ? `<div class="msg msg-assistant">${body}</div>` : "";
  };
  const oneLine = (s) => String(s ?? "").replace(/\s+/g, " ").trim();
  let html = "";
  let pendingTool = null; // 等待 tool/result 配对的 tool/call
  const flushTool = () => {
    if (!pendingTool) return;
    html += `<details class="collapse"><summary>🛠 ${esc(pendingTool.name)} <span class="collapse-sum">${esc(oneLine(pendingTool.args).slice(0, 80))}</span></summary><div class="collapse-body"><div class="msg-tool">📤 ${esc(pendingTool.args)}</div></div></details>`;
    pendingTool = null;
  };
  const seenUser = new Set(); // 同一条用户消息可能同时以 user/message 与 agent/inbox/spliced 落库，按 id 去重
  for (const entry of events) {
    const ev = entry?.event ?? entry; // 兼容 {event} 包装与裸事件两种形态
    const d = ev.data || {};
    if (ev.type === "agent/inbox/spliced") {
      for (const m of d.inserted ?? []) {
        if (!isRealUserMsg(m)) continue;
        if (m.id && seenUser.has(m.id)) continue;
        if (m.id) seenUser.add(m.id);
        html += userMsg(m);
      }
      continue;
    }
    if (ev.type === "user/message") {
      const m = d.message || d;
      if (isRealUserMsg(m)) {
        if (m.id && seenUser.has(m.id)) continue;
        if (m.id) seenUser.add(m.id);
        html += userMsg(m);
      }
      continue;
    }
    if (ev.type === "assistant/message") {
      if (d.message?.role === "assistant") html += assistantMsg(d.message);
      continue;
    }
    if (ev.type === "tool/call") {
      flushTool();
      const args = typeof d.arguments === "string" ? d.arguments : JSON.stringify(d.arguments ?? "");
      pendingTool = { name: d.name, args };
      continue;
    }
    if (ev.type === "tool/result") {
      const ok = d.ok === false ? "❌" : "✅";
      const texts = [];
      const walk = (b) => {
        if (b.type === "text") texts.push(b.text);
        else if (b.type === "tool-result") { for (const c of b.content ?? []) walk(c); }
        else if (Array.isArray(b.content)) { for (const c of b.content) walk(c); }
      };
      for (const b of d.message?.content ?? []) walk(b);
      const full = texts.join(" ");
      const sum = oneLine(full).slice(0, 100);
      if (pendingTool) {
        html += `<details class="collapse"><summary>🛠 ${esc(pendingTool.name)} ${ok} <span class="collapse-sum">${esc(sum)}</span></summary><div class="collapse-body"><div class="msg-tool">📤 ${esc(pendingTool.args)}</div><div class="msg-tool">📥 ${esc(full)}</div></div></details>`;
        pendingTool = null;
      } else {
        html += `<details class="collapse"><summary>${ok} 工具结果 <span class="collapse-sum">${esc(sum)}</span></summary><div class="collapse-body"><div class="msg-tool">${esc(full)}</div></div></details>`;
      }
      continue;
    }
    if (ev.type === "session/title") {
      html += `<div class="msg msg-system">📝 标题：${esc(String(d.title ?? ""))}</div>`;
      continue;
    }
    if (ev.type === "goal/change") {
      html += `<div class="msg msg-system">🎯 ${esc(String(d.action ?? d.status ?? "目标变更"))}</div>`;
      continue;
    }
    if (ev.type === "todo/write") {
      html += `<div class="msg msg-system">📋 任务清单更新（${(d.todos ?? []).length} 项）</div>`;
    }
  }
  flushTool();
  // 进行中的流式气泡（按块顺序渲染累积的增量）
  if (stream) {
    const reasonings = [];
    const texts = [];
    const tools = [];
    for (const idx of stream.order ?? []) {
      const b = stream.blocks?.[idx];
      if (!b) continue;
      const content = (b.parts ?? []).join("");
      if (b.type === "reasoning" && content) reasonings.push(content);
      else if (b.type === "text" && content) texts.push(content);
      else if (b.type === "tool-call") tools.push(b.name || "工具");
    }
    const parts = [];
    if (reasonings.length) parts.push(`<details class="collapse" open><summary>💭 思考中…</summary><div class="collapse-body"><div class="msg-reason">${esc(reasonings.join(""))}</div></div></details>`);
    if (texts.length) parts.push(`<div class="msg-text">${esc(texts.join(""))}</div>`);
    if (tools.length) parts.push(`<div class="msg-tool">🔧 ${esc(tools.join("，"))}</div>`);
    if (parts.length) html += `<div class="msg msg-assistant">${parts.join("")}<div class="msg-streaming">⏳ 正在响应…</div></div>`;
    else html += `<div class="msg msg-assistant"><div class="msg-streaming">⏳ Agent 正在思考…</div></div>`;
  }
  const stickToBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 150;
  el.innerHTML = html || `<div class="empty">无可显示消息</div>`;
  if (stickToBottom) el.scrollTop = el.scrollHeight;
}

/** 执行 slash 命令（走 commands/execute 命令通道，不进入模型上下文） */
async function runCommand(line) {
  try {
    const res = await fetch(`${api.base}/api/command`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": api.token },
      body: JSON.stringify({ sessionId: currentDetail, line }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    const r = data.value?.result;
    if (r?.kind === "success") toast(`✅ ${line} 执行成功${r.text ? "：" + r.text : ""}`);
    else if (r?.kind === "error") toast(`❌ ${line} 执行失败：${r.text ?? "?"}`);
    else toast(`⚠️ 未找到命令 ${line.split(/\s+/)[0]}（可用：/compact /goal /permission /plan /feedback /export /standing）`);
  } catch (err) {
    toast("命令执行失败：" + err.message);
  }
}

/** 发送消息：queue（排队）或 steer（纠正打断）；/ 开头自动走命令通道 */
async function sendMessage() {
  const input = $("composer-input");
  const text = input.value.trim();
  if (!text || !api || !currentDetail) return;
  if (text.startsWith("/")) {
    input.value = "";
    await runCommand(text);
    return;
  }
  const mode = $("composer-steer").checked ? "steer" : "queue";
  // 乐观插入（本地标记，收到真实回显时替换）
  detailEvents.push({
    _local: true,
    event: {
      type: "user/message", seq: Date.now(), time: Date.now(),
      data: { message: { role: "user", content: [{ type: "text", text }] } },
    },
  });
  renderDetail();
  input.value = "";
  const btn = $("composer-send");
  btn.disabled = true;
  try {
    const res = await fetch(`${api.base}/api/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": api.token },
      body: JSON.stringify({ sessionId: currentDetail, content: text, mode }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    toast(mode === "steer" ? "已发送（纠正模式）" : "已发送");
  } catch (err) {
    toast("发送失败：" + err.message);
    // 回滚乐观消息
    const idx = detailEvents.findIndex((e) => e._local);
    if (idx >= 0) detailEvents.splice(idx, 1);
    renderDetail();
  } finally {
    btn.disabled = false;
  }
}

function renderSessions() {
  const list = state?.sessions ?? [];
  const el = $("session-list");
  el.innerHTML = list.length
    ? [...list].sort((a, b) => (b.running - a.running) || (b.updatedAt - a.updatedAt)).map(sessionCard).join("")
    : `<div class="empty">暂无会话</div>`;
}

function pushEventLog(line) {
  const el = $("event-log");
  const d = document.createElement("div");
  d.textContent = `${new Date().toLocaleTimeString("zh-CN", { hour12: false })} ${line}`;
  el.prepend(d);
  while (el.children.length > 100) el.lastChild.remove();
}

function renderEventLog() {
  if (!state) return;
  const el = $("event-log");
  el.innerHTML = "";
  for (const ev of [...(state.events ?? [])].reverse().slice(0, 50)) {
    const d = document.createElement("div");
    if (ev.type === "notify") d.textContent = `${fmtTime(ev.at)} [通知] ${ev.title}：${ev.body}`;
    else if (ev.type === "frame") d.textContent = `${fmtTime(ev.at)} [帧] ${label(ev.frame?.type)}`;
    else d.textContent = `${fmtTime(ev.at)} ${JSON.stringify(ev).slice(0, 120)}`;
    el.appendChild(d);
  }
}

// ---------- 操作 ----------
async function answerApproval(approvalId, outcome) {
  if (!api) return;
  try {
    const res = await fetch(`${api.base}/api/approval`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": api.token },
      body: JSON.stringify({ approvalId, outcome }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    toast(data.receipt?.accepted ? "已提交" : `未受理：${data.receipt?.reason ?? "?"}`);
    if (data.receipt?.accepted) { /* 等待 approval/resolved 帧清理 */ }
  } catch (err) {
    toast("操作失败：" + err.message);
  }
}

async function interruptSession(sessionId) {
  if (!api) return;
  try {
    const res = await fetch(`${api.base}/api/interrupt`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-gateway-token": api.token },
      body: JSON.stringify({ sessionId }),
    });
    const data = await res.json();
    toast(data.ok ? "已发送中断" : "失败：" + (data.error ?? ""));
  } catch (err) {
    toast("操作失败：" + err.message);
  }
}

// ---------- 文件浏览 ----------
let fsEntries = [];   // 当前列表缓存（供复制路径用）
let fsQuickPaths = []; // 常用目录快捷入口缓存（onclick 走索引，避免路径引号问题）

/** 点击常用目录快捷按钮（如 桌面/下载） */
function fsQuickGo(i) {
  const q = fsQuickPaths[i];
  if (q) fsOpen(q.path);
}

/** 判断是否为隐藏项（Windows 点开头 / 常见系统隐藏目录） */
function isHiddenName(name) {
  return typeof name === "string" && (name.startsWith(".") || /^(AppData|ProgramData|System Volume Information|\$RECYCLE\.BIN)$/.test(name));
}

async function fsOpen(p) {
  if (!api) return;
  fsPath = p || "";
  $("fs-preview").hidden = true;
  const list = $("fs-list");
  list.innerHTML = `<div class="empty">加载中…</div>`;
  // 盘符层（未限制且空路径）显示常用目录快捷入口
  const quick = $("fs-quick");
  quick.hidden = true;
  if (!fsPath) {
    try {
      const qr = await fetch(`${api.base}/fs/quick`, { headers: { "x-gateway-token": api.token } });
      if (qr.ok) {
        const qd = await qr.json();
        if (qd?.length) {
          fsQuickPaths = qd;
          quick.hidden = false;
          quick.innerHTML = qd.map((q, i) => `<button class="fs-quick-btn" onclick="fsQuickGo(${i})">📍 ${esc(q.name)}</button>`).join("");
        }
      }
    } catch { /* 快捷入口加载失败不阻塞 */ }
  }
  try {
    const res = await fetch(`${api.base}/fs/list?path=${encodeURIComponent(fsPath)}`, { headers: { "x-gateway-token": api.token } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    fsEntries = data.entries ?? [];
    $("fs-crumb").textContent = data.path || (data.drives ? "全部磁盘" : "文件系统");
    $("fs-crumb").title = data.path || "";
    // 上一级按钮可用性
    $("fs-up").disabled = !fsPath && !data.drives;
    list.innerHTML = fsEntries.length
      ? fsEntries.map((e, i) => {
          const hidden = isHiddenName(e.name);
          return `<div class="fs-row ${hidden ? "fs-hidden" : ""}" onclick="fsTap(${i})">
          <span class="fs-icon ${e.type === "dir" ? "fs-dir" : ""}">${e.drive ? "💽" : e.type === "dir" ? "📁" : "📄"}</span>
          <span class="fs-name">${esc(e.drive ? e.name : e.name)}</span>
          <span class="fs-size">${e.type === "dir" ? "" : fmtSize(e.size)}</span>
          <span class="fs-row-btns">
            ${e.type === "file" ? `<button class="fs-copy" onclick="event.stopPropagation(); fsDownload(${i})" title="下载到手机">⬇</button>` : ""}
            <button class="fs-copy" onclick="event.stopPropagation(); fsCopyPath(${i})" title="复制完整路径">📋</button>
          </span>
        </div>`;
        }).join("")
      : `<div class="empty">空目录</div>`;
  } catch (err) {
    fsEntries = [];
    list.innerHTML = `<div class="empty">加载失败：${esc(err.message)}</div>`;
  }
}

/** 返回上一级（盘符层再上级 = 快捷入口层） */
async function fsUp() {
  if (!api) return;
  try {
    const res = await fetch(`${api.base}/fs/parent?path=${encodeURIComponent(fsPath)}`, { headers: { "x-gateway-token": api.token } });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
    if (data.drives) fsOpen(""); // 回到盘符层
    else fsOpen(data.path);
  } catch (err) {
    toast("返回上一级失败：" + err.message);
  }
}

/** 输入路径直达 */
async function fsGoto() {
  if (!api) return;
  const input = $("fs-path-input");
  const p = input.value.trim();
  if (!p) { toast("请输入路径"); return; }
  // 路径清洗：反斜杠、首尾空格
  const clean = p.replace(/^["']|["']$/g, "");
  const res = await fetch(`${api.base}/fs/list?path=${encodeURIComponent(clean)}`, { headers: { "x-gateway-token": api.token } });
  if (res.ok) {
    fsOpen(clean);
    $("fs-goto-row").hidden = true;
    toast("已跳转：" + clean);
  } else {
    const data = await res.json().catch(() => ({}));
    toast("路径无效：" + (data.error ?? res.status));
  }
}

function fsToggleGoto() {
  const row = $("fs-goto-row");
  row.hidden = !row.hidden;
  if (!row.hidden) {
    $("fs-path-input").value = fsPath || "";
    $("fs-path-input").focus();
  }
}

async function fsTap(i) {
  const e = fsEntries[i];
  if (!e) return;
  const target = e.drive ? e.name : fsPath ? fsPath.replace(/[\\/]+$/, "") + "\\" + e.name : e.name;
  try {
    const res = await fetch(`${api.base}/fs/list?path=${encodeURIComponent(target)}`, { headers: { "x-gateway-token": api.token } });
    if (res.ok) { fsOpen(target); return; }
  } catch { /* 不是目录则按文件处理 */ }
  // 文件：尝试预览
  const preview = $("fs-preview");
  try {
    const res = await fetch(`${api.base}/fs/read?path=${encodeURIComponent(target)}`, { headers: { "x-gateway-token": api.token } });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      toast(data.error ?? "无法打开");
      return;
    }
    const data = await res.json();
    preview.hidden = false;
    preview.textContent = `${target}\n${"=".repeat(40)}\n${data.text}`;
  } catch (err) {
    toast("无法预览：" + err.message);
  }
}

function fsDownload(i) {
  if (!api) return;
  const e = fsEntries[i];
  if (!e || e.type !== "file") return;
  const target = e.drive ? e.name : fsPath ? fsPath.replace(/[\\/]+$/, "") + "\\" + e.name : e.name;
  window.open(`${api.base}/fs/download?path=${encodeURIComponent(target)}&token=${encodeURIComponent(api.token)}`, "_blank");
}

/** 复制某个条目/当前目录的完整路径到剪贴板 */
async function fsCopyPath(i) {
  if (!api) return;
  const e = fsEntries[i];
  if (!e) return;
  const target = e.drive ? e.name : fsPath ? fsPath.replace(/[\\/]+$/, "") + "\\" + e.name : e.name;
  await copyText(target);
}

async function fsCopyCurrent() {
  if (!api) return;
  const p = $("fs-crumb").title || fsPath;
  if (!p) { toast("当前在磁盘列表，请先进入目录"); return; }
  await copyText(p);
}

/** 复制文本到剪贴板（兼容非 https 的局域网环境） */
async function copyText(txt) {
  const fallback = () => {
    const ta = document.createElement("textarea");
    ta.value = txt;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    try { document.execCommand("copy"); } catch { /* noop */ }
    document.body.removeChild(ta);
  };
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(txt);
    else fallback();
    toast("✅ 已复制路径：" + txt);
  } catch {
    fallback();
    toast("已复制路径：" + txt);
  }
}

/** 把手机上选择的文件上传到当前目录 */
async function fsUploadFiles(fileList) {
  if (!api || !fileList?.length) return;
  const dir = fsPath || "";
  const files = [...fileList];
  let done = 0;
  const failCount = [];
  for (const f of files) {
    toast(`上传中：${f.name}…`);
    try {
      const res = await fetch(`${api.base}/fs/upload?dir=${encodeURIComponent(dir)}&name=${encodeURIComponent(f.name)}`, {
        method: "POST",
        headers: { "x-gateway-token": api.token, "x-file-name": encodeURIComponent(f.name) },
        body: f,
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      done++;
    } catch (err) {
      failCount.push(`${f.name}（${err.message}）`);
    }
  }
  if (failCount.length === 0) toast(`✅ 上传完成：${done} 个文件`);
  else toast(`⚠️ ${done} 成功，${failCount.length} 失败：${failCount.join("；")}`);
  fsOpen(fsPath); // 刷新列表
}

// ---------- 外观主题（深/浅两档） ----------
const BG_COLORS = { default: "#0f1117", light: "#f4f5f7" };
// 旧版多主题值兼容映射
const BG_LEGACY = { paper: "light", "warm-paper": "light", "light-blue": "light", "blue-gray": "default", forest: "default", "violet-dark": "default" };

function applyBg(bg) {
  let v = bg || "default";
  if (!(v in BG_COLORS)) v = BG_LEGACY[v] || "default";
  document.documentElement.dataset.bg = v;
  try { localStorage.setItem("dshm.bg", v); } catch { /* noop */ }
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", BG_COLORS[v]);
  document.querySelectorAll("#bg-picker .bg-option").forEach((b) => {
    b.classList.toggle("active", b.dataset.bg === v);
  });
}

// ---------- 通知 ----------
function renderNotifyStatus() {
  const el = $("notify-status");
  if (!el) return;
  if (!("Notification" in window)) { el.textContent = "此浏览器不支持系统通知"; return; }
  const p = Notification.permission;
  if (p === "granted") el.textContent = "✅ 通知已开启：任务完成/需要授权/出错时会弹通知（前台有效）";
  else if (p === "denied") el.textContent = "⛔ 通知被拒绝：请在浏览器设置中允许本站通知";
  else el.textContent = "⚠️ 未授权：点上方按钮开启任务提醒";
}

async function enableNotifications() {
  if (!("Notification" in window)) { toast("此浏览器不支持通知"); return; }
  const p = await Notification.requestPermission();
  renderNotifyStatus();
  toast(p === "granted" ? "通知已开启" : "通知未授权");
}

// ---------- UI 事件 ----------
function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.hidden = true; }, 2200);
}

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    detailClosed = true; // 离开详情页时停止增量接收
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
    $(tab.dataset.view).hidden = false;
    if (tab.dataset.view === "view-files") fsOpen(fsPath);
  });
});

$("btn-connect").addEventListener("click", () => {
  const c = cfg.get();
  c.host = $("cfg-host").value.trim();
  c.port = Number($("cfg-port").value) || 8443;
  c.token = $("cfg-token").value.trim();
  cfg.save(c);
  connect();
});
$("btn-notify").addEventListener("click", enableNotifications);
$("fs-home").addEventListener("click", () => fsOpen(""));
$("fs-up").addEventListener("click", fsUp);
$("fs-goto").addEventListener("click", fsToggleGoto);
$("fs-goto-go").addEventListener("click", fsGoto);
$("fs-path-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); fsGoto(); }
});
$("fs-copy-path")?.addEventListener("click", fsCopyCurrent);
$("fs-upload").addEventListener("click", () => $("fs-file-input").click());
$("fs-file-input").addEventListener("change", (e) => {
  fsUploadFiles(e.target.files);
  e.target.value = ""; // 允许再次选择同一文件
});
/** 关闭会话详情，回到会话列表 */
function closeDetail() {
  detailClosed = true;
  currentDetail = null;
  if (streamTimer) { clearTimeout(streamTimer); streamTimer = null; }
  if (liveTimer) { clearTimeout(liveTimer); liveTimer = null; }
  document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
  $("view-sessions").hidden = false;
}

/** Android App 返回键处理：PWA 有上一级界面则处理，否则返回 "exit" 让 App 退出 */
window.__dshBack = function () {
  // 1) 模型/权限面板展开中 → 先收起
  const tools = $("detail-tools");
  if (tools && !tools.hidden) { toggleTools(false); return "handled"; }
  // 2) 会话详情打开中 → 回会话列表
  if (currentDetail && !$("view-detail").hidden) { closeDetail(); return "handled"; }
  // 3) 无更上级界面 → 交给 App 退出
  return "exit";
};

$("detail-back").addEventListener("click", closeDetail);
$("composer-send").addEventListener("click", sendMessage);
$("composer-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
$("tools-toggle").addEventListener("click", () => toggleTools());
$("detail-model").addEventListener("change", () => { if (currentDetail) changeModel(currentDetail); });
document.querySelectorAll("#detail-perm .perm-chip").forEach((b) => {
  b.addEventListener("click", () => changePermission(b.dataset.mode));
});
document.querySelectorAll("#bg-picker .bg-option").forEach((b) => {
  b.addEventListener("click", () => applyBg(b.dataset.bg));
});

// ---------- 初始化 ----------
(async function init() {
  const c = cfg.get();
  $("cfg-host").value = c.host || "";
  $("cfg-port").value = c.port || 8443;
  $("cfg-token").value = c.token || "";
  applyBg((() => { try { return localStorage.getItem("dshm.bg") || "default"; } catch { return "default"; } })());
  renderNotifyStatus();
  if (c.host) {
    $("conn-result").textContent = "正在自动连接…";
    await connect(true);
  } else {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelector('[data-view="view-settings"]').classList.add("active");
    document.querySelectorAll(".view").forEach((v) => (v.hidden = true));
    $("view-settings").hidden = false;
  }
  if ("serviceWorker" in navigator) {
    try { navigator.serviceWorker.register("/sw.js"); } catch { /* noop */ }
  }
})();
