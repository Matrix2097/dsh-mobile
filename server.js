// server.js — DSH 手机监管网关
// 手机 PWA（局域网）→ 本网关 → DSH /api（回环）
// 零依赖：node:http + Node 24 全局 fetch/WebSocket
//
// 用法: node server.js [--port 8443] [--dsh-port <auto>] [--root <白名单根目录>] [--token <xxx>] [--no-token] [--max-upload-mb <MB>]
// 默认不传 --root = 浏览整个磁盘（Windows 显示所有盘符；上传可写到任意目录）
import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DshClient, discoverDshPort } from "./dsh.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const MAX_TEXT_READ = 512 * 1024; // /fs/read 文本上限

// ---------- CLI ----------
function parseArgs(argv) {
  const args = {
    port: 8443,
    dshPort: null,
    root: process.env.GATEWAY_ROOT || null, // null = 整个磁盘
    token: process.env.GATEWAY_TOKEN || null,
    noToken: false,
    maxUploadMb: 1024,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === "--port") args.port = Number(next());
    else if (a === "--dsh-port") args.dshPort = Number(next());
    else if (a === "--root") args.root = next() || null;
    else if (a === "--token") args.token = next();
    else if (a === "--no-token") args.noToken = true;
    else if (a === "--max-upload-mb") args.maxUploadMb = Number(next()) || 1024;
  }
  if (!args.token && !args.noToken) args.token = crypto.randomBytes(6).toString("hex");
  return args;
}

const args = parseArgs(process.argv.slice(2));
const root = args.root ? path.resolve(args.root) : null;
const token = args.token;
const MAX_UPLOAD = args.maxUploadMb * 1024 * 1024;

// ---------- 状态聚合 ----------
const state = {
  connected: false,
  dshPort: null,
  describe: null,
  sessions: new Map(),   // sessionId -> summary
  workspaces: [],        // workspaceView[]
  jobs: new Map(),       // sessionId -> taskView[]
  approvals: new Map(),  // approvalId -> {approvalId, sessionId, toolName, callId, reason, rpcId, at}
  questions: new Map(),  // rpcId -> {rpcId, sessionId, questions, at}
  events: [],            // 最近事件环形缓冲
  lastRefresh: 0,
};
const EVENT_RING = 200;

function pushEvent(entry) {
  state.events.push({ at: Date.now(), ...entry });
  if (state.events.length > EVENT_RING) state.events.splice(0, state.events.length - EVENT_RING);
}

function snapshot() {
  return {
    ok: true,
    connected: state.connected,
    dshPort: state.dshPort,
    describe: state.describe,
    gatewayRoot: root,
    sessions: [...state.sessions.values()],
    workspaces: state.workspaces,
    jobs: Object.fromEntries([...state.jobs.entries()]),
    approvals: [...state.approvals.values()],
    questions: [...state.questions.values()],
    events: state.events.slice(-50),
  };
}

// ---------- SSE 客户端 ----------
const sseClients = new Set();

function broadcast(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch { /* 客户端已断开 */ }
  }
}

function notify(level, title, body, extra = {}) {
  const n = { type: "notify", level, title, body, at: Date.now(), ...extra };
  pushEvent({ type: "notify", level, title, body });
  broadcast(n);
}

// ---------- DSH 连接管理 ----------
let dsh = null;
let discoveryTimer = null;

function handleFrame(frame, channel, rpcId) {
  const t = frame?.type;
  if (!t) return;
  // 过滤细碎增量帧，避免事件缓冲被刷屏
  const isDelta = t === "session/event" && frame.event?.type === "assistant/chunk";
  if (!isDelta) pushEvent({ type: "frame", channel, frame });

  if (channel === "mux") {
    switch (t) {
      case "session/event": {
        const ev = frame.event;
        broadcast({ type: "session-event", sessionId: frame.sessionId, event: ev });
        break;
      }
      case "session/jobs": {
        state.jobs.set(frame.sessionId, frame.jobs);
        for (const job of frame.jobs) {
          if (job.status === "completed" || job.status === "failed" || job.status === "killed") {
            notify(job.status === "completed" ? "info" : "warn", `任务${job.status === "completed" ? "完成" : job.status === "failed" ? "失败" : "已终止"}`, `${job.label}${job.detail ? `：${job.detail}` : ""}`, { kind: "job", job, sessionId: frame.sessionId });
          }
        }
        broadcast({ type: "jobs", sessionId: frame.sessionId, jobs: frame.jobs });
        break;
      }
      case "approval/requested": {
        const item = { approvalId: frame.approvalId, sessionId: frame.sessionId, toolName: frame.toolName, callId: frame.callId, reason: frame.reason, rpcId, at: Date.now() };
        state.approvals.set(frame.approvalId, item);
        notify("warn", "需要授权", `${frame.toolName} 请求批准${frame.reason ? `（${frame.reason}）` : ""}`, { kind: "approval", approval: item });
        break;
      }
      case "approval/resolved": {
        const item = state.approvals.get(frame.approvalId);
        state.approvals.delete(frame.approvalId);
        if (item) notify("info", "授权已处理", `${item.toolName} → ${frame.outcome}`, { kind: "approval-resolved", approvalId: frame.approvalId, outcome: frame.outcome });
        else notify("info", "授权已处理", `结果：${frame.outcome}`, { kind: "approval-resolved", approvalId: frame.approvalId, outcome: frame.outcome });
        break;
      }
      case "question/requested": {
        const item = { rpcId, sessionId: frame.sessionId, questions: frame.questions, at: Date.now() };
        state.questions.set(rpcId, item);
        notify("info", "有新提问", frame.questions[0]?.question ?? "（无标题）", { kind: "question", question: item });
        break;
      }
      case "question/resolved": {
        state.questions.delete(frame.questionRpcId);
        break;
      }
      default:
        break;
    }
  } else {
    switch (t) {
      case "host/session-added": {
        state.sessions.set(frame.sessionId, { sessionId: frame.sessionId, running: false, blank: frame.blank ?? false, cwd: frame.cwd, agentPreset: frame.agentPreset, origin: frame.origin, parentSessionId: frame.parentSessionId, updatedAt: Date.now() });
        broadcast({ type: "sessions" });
        break;
      }
      case "host/session-removed": {
        state.sessions.delete(frame.sessionId);
        state.jobs.delete(frame.sessionId);
        broadcast({ type: "sessions" });
        break;
      }
      case "host/session-status": {
        const s = state.sessions.get(frame.sessionId);
        if (s) { s.running = frame.running; s.updatedAt = Date.now(); }
        broadcast({ type: "sessions" });
        break;
      }
      case "host/agent-error": {
        notify("error", "Agent 出错", frame.message, { kind: "agent-error", sessionId: frame.sessionId });
        break;
      }
      case "host/workspace-changed": {
        const idx = state.workspaces.findIndex((w) => w.workspaceId === frame.workspace.workspaceId);
        if (idx >= 0) state.workspaces[idx] = frame.workspace;
        else state.workspaces.push(frame.workspace);
        broadcast({ type: "workspaces" });
        break;
      }
      case "host/workspace-removed": {
        state.workspaces = state.workspaces.filter((w) => w.workspaceId !== frame.workspaceId);
        broadcast({ type: "workspaces" });
        break;
      }
      default:
        break;
    }
  }
}

async function refresh() {
  if (!dsh) return;
  try {
    const [sessions, workspaces] = await Promise.all([
      dsh.call("session.list", {}),
      dsh.call("workspace.list", {}),
    ]);
    const seen = new Set();
    for (const s of sessions.items ?? []) {
      seen.add(s.sessionId);
      const prev = state.sessions.get(s.sessionId);
      state.sessions.set(s.sessionId, { ...s, running: prev?.running ?? s.running ?? false });
    }
    for (const id of [...state.sessions.keys()]) if (!seen.has(id)) state.sessions.delete(id);
    state.workspaces = workspaces.items ?? [];
    state.lastRefresh = Date.now();
    broadcast({ type: "snapshot", state: snapshot() });
  } catch (err) {
    // DSH 可能已重启/换端口 → 触发重新发现
    state.connected = false;
    broadcast({ type: "snapshot", state: snapshot() });
    scheduleRediscovery();
  }
}

let rediscoveryScheduled = false;
function scheduleRediscovery() {
  if (rediscoveryScheduled) return;
  rediscoveryScheduled = true;
  setTimeout(async () => {
    rediscoveryScheduled = false;
    await connectToDsh();
  }, 10000);
}

async function connectToDsh() {
  if (dsh) { dsh.stop(); dsh = null; }
  const found = await discoverDshPort(args.dshPort);
  if (!found) {
    state.connected = false;
    state.dshPort = null;
    scheduleRediscovery();
    return;
  }
  const { port, describe } = found;
  state.dshPort = port;
  dsh = new DshClient(port);
  dsh.on("frame", handleFrame);
  dsh.on("streams-up", async () => {
    state.connected = true;
    try { await dsh.describeHost(); state.describe = dsh.describe; } catch { /* noop */ }
    notify("info", "已连接 DSH", `端口 ${port}${describe ? ` · v${describe.version}` : ""}`, { kind: "connection" });
    broadcast({ type: "snapshot", state: snapshot() });
    await refresh();
  });
  dsh.on("disconnected", () => {
    state.connected = false;
    notify("warn", "DSH 连接断开", "事件流已断开，正在重连…", { kind: "connection" });
  });
  dsh.startStreams();
  if (dsh.describe == null) {
    try { await dsh.describeHost(); } catch { /* 稍后重试 */ }
  }
}

// ---------- 文件系统（默认整个磁盘；--root 可收窄为白名单） ----------
function resolvePath(p) {
  const abs = path.resolve(String(p ?? ""));
  if (root && abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error(`路径不在允许范围内: ${abs}`);
  }
  return abs;
}

/** 列出本机所有盘符（Windows）/ 根目录（POSIX） */
async function listDrives() {
  const drives = [];
  if (process.platform === "win32") {
    for (let i = 65; i <= 90; i++) {
      const letter = String.fromCharCode(i);
      const d = `${letter}:\\`;
      try {
        await fsp.access(d);
        const st = await fsp.stat(d);
        drives.push({ name: d, type: "dir", size: null, mtime: st.mtimeMs, drive: true });
      } catch {
        // 不存在的盘符，跳过
      }
    }
  } else {
    try { drives.push({ name: "/", type: "dir", size: null, mtime: null, drive: true }); } catch { /* noop */ }
  }
  return drives;
}

/** 常用目录快捷入口（桌面/下载/文档/图片/视频/音乐/用户目录/盘符） */
async function fsQuick() {
  const items = [];
  const add = (name, p) => {
    try {
      if (fs.existsSync(p)) items.push({ name, path: p });
    } catch { /* noop */ }
  };
  const home = process.env.USERPROFILE || process.env.HOME || null;
  if (process.platform === "win32") {
    if (home) {
      // OneDrive 可能接管桌面
      add("桌面", path.join(home, "OneDrive", "Desktop"));
      add("桌面", path.join(home, "Desktop"));
      add("下载", path.join(home, "Downloads"));
      add("文档", path.join(home, "Documents"));
      add("图片", path.join(home, "Pictures"));
      add("视频", path.join(home, "Videos"));
      add("音乐", path.join(home, "Music"));
      add("用户目录", home);
    }
    for (let i = 65; i <= 90; i++) {
      const d = `${String.fromCharCode(i)}:\\`;
      try {
        fs.accessSync(d);
        items.push({ name: d, path: d });
      } catch { /* noop */ }
    }
  } else if (home) {
    add("主目录", home);
    add("根目录", "/");
  }
  return items;
}

/** 计算上一级目录（盘符根再上一级 = 盘符列表 ""；白名单模式下停在白名单根） */
function fsParent(p) {
  const abs = resolvePath(String(p ?? ""));
  const parent = path.dirname(abs);
  if (root) {
    if (parent === root || parent.startsWith(root + path.sep)) return { path: parent };
    return { path: root, atRoot: true }; // 越界 → 停在白名单根
  }
  if (parent === abs) return { path: "", drives: true }; // 盘符根
  return { path: parent };
}

const TEXT_EXT = new Set([".txt", ".md", ".json", ".js", ".ts", ".jsx", ".tsx", ".css", ".html", ".htm", ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".log", ".csv", ".ps1", ".py", ".c", ".h", ".cpp", ".java", ".go", ".rs", ".sh", ".bat", ".cmd", ".vue", ".svelte", ".sql", ".env"]);

async function fsList(p) {
  // 未限制时，空路径 = 盘符列表
  if (!root && !String(p ?? "").trim()) {
    return { path: "", scope: "all", drives: true, entries: await listDrives() };
  }
  const abs = resolvePath(p);
  const entries = await fsp.readdir(abs, { withFileTypes: true });
  const items = [];
  for (const e of entries) {
    try {
      const st = await fsp.stat(path.join(abs, e.name));
      items.push({
        name: e.name,
        type: e.isDirectory() ? "dir" : "file",
        size: e.isDirectory() ? null : st.size,
        mtime: st.mtimeMs,
      });
    } catch { /* 跳过无法访问的项 */ }
  }
  items.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1));
  return { path: abs, scope: root ? "whitelist" : "all", drives: false, entries: items };
}

async function fsRead(p) {
  const abs = resolvePath(p);
  const st = await fsp.stat(abs);
  if (!st.isFile()) throw new Error("不是文件");
  if (st.size > MAX_TEXT_READ) throw new Error(`文件过大（${st.size} 字节 > ${MAX_TEXT_READ}）`);
  const ext = path.extname(abs).toLowerCase();
  let content = await fsp.readFile(abs, "utf8");
  if (content.charCodeAt(0) === 0xFEFF) content = content.slice(1); // strip BOM
  return { path: abs, size: st.size, text: content, previewable: TEXT_EXT.has(ext) };
}

/** 接收上传的原始字节流并写入目标文件（流式，不整读进内存） */
function saveUpload(req, target, maxBytes) {
  return new Promise((resolve, reject) => {
    const out = fs.createWriteStream(target, { flags: "wx" });
    let size = 0;
    let failed = false;
    const fail = (msg) => {
      if (failed) return;
      failed = true;
      out.destroy();
      fs.unlink(target, () => {});
      reject(new Error(msg));
    };
    req.on("data", (c) => {
      size += c.length;
      if (size > maxBytes) {
        req.unpipe(out);
        fail(`文件过大（超过 ${args.maxUploadMb} MB 上限）`);
      }
    });
    req.on("error", (e) => fail(`上传中断: ${e.message}`));
    out.on("error", (e) => fail(`写入失败: ${e.message}`));
    out.on("finish", () => resolve(size));
    req.pipe(out);
  });
}

async function fsUpload(req, dir, name) {
  const absDir = resolvePath(dir);
  const st = await fsp.stat(absDir);
  if (!st.isDirectory()) throw new Error("目标不是目录");
  // 文件名清洗：只取 basename，防止路径穿越
  let base = String(name ?? "").replace(/[\\/]+/g, path.sep);
  base = path.basename(base);
  if (!base || base === "." || base === "..") throw new Error("非法文件名");
  const target = path.join(absDir, base);
  const size = await saveUpload(req, target, MAX_UPLOAD);
  return { path: target, size };
}

// ---------- HTTP 服务 ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

function authOk(req) {
  if (!token) return true;
  const h = req.headers["x-gateway-token"];
  const q = new URL(req.url, "http://x").searchParams.get("token");
  return h === token || q === token;
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => { data += c; if (data.length > 1e6) { reject(new Error("body too large")); req.destroy(); } });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
  const p = url.pathname;

  try {
    // ---- API（需 token）----
    if (p.startsWith("/api/")) {
      if (!authOk(req)) return sendJson(res, 401, { ok: false, error: "missing or bad token" });
      if (req.method === "GET" && p === "/api/state") return sendJson(res, 200, snapshot());
      if (req.method === "GET" && p === "/api/stream") return handleSse(req, res);
      if (req.method === "GET" && p === "/api/models") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
        try {
          const value = await dsh.call("session.models", { sessionId });
          return sendJson(res, 200, { ok: true, value });
        } catch (err) {
          if (err.rpcError) return sendJson(res, 400, { ok: false, error: err.rpcError.message ?? err.rpcError.code ?? "rpc error", code: err.rpcError.code });
          throw err;
        }
      }
      if (req.method === "GET" && p === "/api/history") {
        const sessionId = url.searchParams.get("sessionId");
        if (!sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
        // 原始 history 返回完整事件流（含海量 assistant/chunk 增量），这里过滤成消息级事件
        const maxMessages = Math.min(Number(url.searchParams.get("maxMessages") || 40), 200);
        const value = await dsh.call("session.history", { sessionId, maxMessages });
        const KEEP = new Set([
          "user/message", "agent/inbox/spliced", "assistant/message",
          "tool/call", "tool/result", "session/title", "goal/change", "todo/write",
        ]);
        const events = (value.events ?? []).filter((e) => KEEP.has(e.event?.type)).slice(-300);
        return sendJson(res, 200, { ok: true, value: { events, hasMore: value.hasMore ?? false } });
      }

      if (req.method === "POST") {
        const body = JSON.parse((await readBody(req)) || "{}");
        if (p === "/api/approval") {
          const item = state.approvals.get(body.approvalId);
          if (!item) return sendJson(res, 404, { ok: false, error: "approval not pending", receipt: { accepted: false, reason: "not-pending" } });
          const outcome = body.outcome === "rejected" ? "rejected" : "allowed-once";
          const message = { type: "client-response", rpcId: item.rpcId, result: { ok: true, value: { sessionId: item.sessionId, approvalId: item.approvalId, outcome } } };
          const resp = await dsh.callRaw("respond", message);
          return sendJson(res, 200, { ok: true, receipt: resp.result?.value ?? resp });
        }
        if (p === "/api/interrupt") {
          if (!body.sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
          try {
            const value = await dsh.call("session.interrupt", { sessionId: body.sessionId });
            return sendJson(res, 200, { ok: true, value });
          } catch (err) {
            if (err.rpcError) return sendJson(res, 400, { ok: false, error: err.rpcError.message ?? err.rpcError.code ?? "rpc error", code: err.rpcError.code });
            throw err;
          }
        }
        if (p === "/api/prompt") {
          if (!body.sessionId || !body.content) return sendJson(res, 400, { ok: false, error: "sessionId and content required" });
          // 兜底：/ 开头的输入自动走命令通道（即使前端是旧版缓存，命令也能生效）
          const line = String(body.content ?? "").trim();
          if (line.startsWith("/")) {
            try {
              const value = await dsh.call("commands/execute", { args: { agentId: body.sessionId, line } });
              return sendJson(res, 200, { ok: true, value, command: true });
            } catch (err) {
              if (err.rpcError) return sendJson(res, 400, { ok: false, error: err.rpcError.message ?? err.rpcError.code ?? "rpc error", code: err.rpcError.code });
              throw err;
            }
          }
          try {
            const value = await dsh.call("session.prompt", {
              sessionId: body.sessionId,
              mode: body.mode === "steer" ? "steer" : "queue",
              content: [{ type: "text", text: body.content }],
            });
            return sendJson(res, 200, { ok: true, value });
          } catch (err) {
            if (err.rpcError) return sendJson(res, 400, { ok: false, error: err.rpcError.message ?? err.rpcError.code ?? "rpc error", code: err.rpcError.code });
            throw err;
          }
        }
        if (p === "/api/select-model") {
          if (!body.sessionId || !body.provider || !body.model) return sendJson(res, 400, { ok: false, error: "sessionId, provider, model required" });
          try {
            const value = await dsh.call("session.selectModel", { sessionId: body.sessionId, provider: body.provider, model: body.model });
            return sendJson(res, 200, { ok: true, value });
          } catch (err) {
            if (err.rpcError) return sendJson(res, 400, { ok: false, error: err.rpcError.message ?? err.rpcError.code ?? "rpc error", code: err.rpcError.code });
            throw err;
          }
        }
        if (p === "/api/permission") {
          const MODES = ["read-only", "workspace-write", "danger-full-access"];
          if (!body.sessionId || !MODES.includes(body.mode)) return sendJson(res, 400, { ok: false, error: "sessionId and mode (read-only|workspace-write|danger-full-access) required" });
          try {
            // 与 DSH GUI 同机制：Typert commands/execute 执行 /permission slash 命令（不进入模型上下文）
            const value = await dsh.call("commands/execute", { args: { agentId: body.sessionId, line: `/permission ${body.mode}` } });
            return sendJson(res, 200, { ok: true, value });
          } catch (err) {
            if (err.rpcError) return sendJson(res, 400, { ok: false, error: err.rpcError.message ?? err.rpcError.code ?? "rpc error", code: err.rpcError.code });
            throw err;
          }
        }
        if (p === "/api/commands") {
          if (!body.sessionId) return sendJson(res, 400, { ok: false, error: "sessionId required" });
          try {
            const value = await dsh.call("commands/list", { args: { agentId: body.sessionId } });
            return sendJson(res, 200, { ok: true, value });
          } catch (err) {
            if (err.rpcError) return sendJson(res, 400, { ok: false, error: err.rpcError.message ?? err.rpcError.code ?? "rpc error", code: err.rpcError.code });
            throw err;
          }
        }
        if (p === "/api/command") {
          if (!body.sessionId || !body.line) return sendJson(res, 400, { ok: false, error: "sessionId and line required" });
          try {
            const value = await dsh.call("commands/execute", { args: { agentId: body.sessionId, line: body.line } });
            return sendJson(res, 200, { ok: true, value });
          } catch (err) {
            if (err.rpcError) return sendJson(res, 400, { ok: false, error: err.rpcError.message ?? err.rpcError.code ?? "rpc error", code: err.rpcError.code });
            throw err;
          }
        }
        if (p === "/api/refresh") { await refresh(); return sendJson(res, 200, { ok: true }); }
      }
      return sendJson(res, 404, { ok: false, error: "unknown api" });
    }

    // ---- 文件系统（需 token）----
    if (p.startsWith("/fs/")) {
      if (!authOk(req)) return sendJson(res, 401, { ok: false, error: "missing or bad token" });
      try {
        if (req.method === "POST" && p === "/fs/upload") {
          const dir = url.searchParams.get("dir") ?? "";
          const name = url.searchParams.get("name") ?? req.headers["x-file-name"] ?? "";
          const r = await fsUpload(req, dir, name);
          return sendJson(res, 200, { ok: true, path: r.path, size: r.size });
        }
        if (req.method !== "GET") return sendJson(res, 405, { ok: false, error: "method not allowed" });
        if (p === "/fs/list") return sendJson(res, 200, await fsList(url.searchParams.get("path") ?? ""));
        if (p === "/fs/quick") return sendJson(res, 200, await fsQuick());
        if (p === "/fs/parent") return sendJson(res, 200, fsParent(url.searchParams.get("path") ?? ""));
        if (p === "/fs/read") return sendJson(res, 200, await fsRead(url.searchParams.get("path") ?? ""));
        if (p === "/fs/download") {
          const abs = resolvePath(url.searchParams.get("path") ?? "");
          const st = await fsp.stat(abs);
          if (!st.isFile()) return sendJson(res, 400, { ok: false, error: "not a file" });
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": st.size,
            "content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(abs))}`,
          });
          fs.createReadStream(abs).pipe(res);
          return;
        }
      } catch (err) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
      return sendJson(res, 404, { ok: false, error: "unknown fs api" });
    }

    // ---- 静态文件（PWA，无需 token；no-cache 保证前端改动即时生效）----
    let file = p === "/" ? "/index.html" : p;
    const abs = path.normalize(path.join(PUBLIC_DIR, file));
    if (!abs.startsWith(PUBLIC_DIR + path.sep) && abs !== PUBLIC_DIR) return sendJson(res, 403, { ok: false, error: "forbidden" });
    if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) return sendJson(res, 404, { ok: false, error: "not found" });
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(abs).pipe(res);
  } catch (err) {
    console.error("[gateway] request error:", err);
    if (!res.headersSent) sendJson(res, 500, { ok: false, error: err.message });
    else res.destroy();
  }
});

function handleSse(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  res.write(`data: ${JSON.stringify({ type: "snapshot", state: snapshot() })}\n\n`);
  sseClients.add(res);
  const heartbeat = setInterval(() => {
    try { res.write(": ping\n\n"); } catch { clearInterval(heartbeat); }
  }, 15000);
  req.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(res);
  });
}

// ---------- 启动 ----------
console.log("==============================================");
console.log("  DSH 手机监管网关");
console.log("==============================================");
console.log(`  网关监听:   0.0.0.0:${args.port}`);
console.log(`  文件范围:   ${root ? "白名单 " + root : "整个磁盘（全部盘符，可读+可上传）"}`);
console.log(`  上传上限:   ${args.maxUploadMb} MB/文件`);
if (token) console.log(`  访问令牌:   ${token}   ← 手机 App 连接时填写`);
else console.log("  访问令牌:   已禁用（局域网无保护！）");
console.log("----------------------------------------------");
server.listen(args.port, "0.0.0.0", () => {
  console.log(`  手机访问:   http://<本机局域网IP>:${args.port}/`);
  console.log("  正在探测 DSH 端口…");
  connectToDsh();
  setInterval(refresh, 5000);
});
