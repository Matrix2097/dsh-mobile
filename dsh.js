// dsh.js — DSH /api 协议客户端（回环身份）
// 协议依据：@deepseek-ai/dsh-client-connection 的 wire 格式（已逆向核实）
//   RPC:   POST /api/<method>  body {type:"client-request", rpcId, method, payload}
//          响应 {type:"server-response", rpcId, result:{ok:true,value}|{ok:false,error}}
//   事件流: ws://127.0.0.1:<port>/api/events.mux 与 /api/events.host
//          每条文本消息 = {type:"server-request", rpcId, method, payload:<帧>}
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";

const RPC_TIMEOUT_MS = 15000;

function rpcId() {
  return randomUUID();
}

/**
 * 探测 DSH Desktop 当前监听的端口（桌面 profile 使用 port:0 动态分配）。
 * 用 PowerShell 读取 DSH Desktop 进程的监听端口，随后用 host.describe RPC 验证。
 */
export async function discoverDshPort(forcedPort) {
  if (forcedPort) return { port: Number(forcedPort), describe: null };
  const candidates = await probeLoopbackPorts();
  for (const port of candidates) {
    try {
      const client = new DshClient(port);
      const describe = await client.call("host.describe", {});
      if (describe && typeof describe.version === "string") {
        return { port, describe };
      }
    } catch {
      // 不是 DSH，继续
    }
  }
  return null;
}

async function probeLoopbackPorts() {
  const script = [
    "$ErrorActionPreference = 'SilentlyContinue'",
    "$pids = (Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue).Id",
    "Get-NetTCPConnection -State Listen | Where-Object { $_.OwningProcess -in $pids } | ForEach-Object { $_.LocalPort }",
  ].join("; ");
  try {
    const out = await runPowershell(script);
    const ports = [...new Set(out.split(/\r?\n/).map((s) => s.trim()).filter((s) => /^\d+$/.test(s)).map(Number))];
    if (ports.length > 0) return ports.sort((a, b) => b - a);
  } catch {
    // fall through to netstat
  }
  try {
    const out = await runPowershell("netstat -ano | Select-String 'LISTENING'");
    const pids = await runPowershell("(Get-Process -Name 'DSH Desktop' -ErrorAction SilentlyContinue).Id");
    const pidSet = new Set(pids.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
    const ports = [];
    for (const line of out.split(/\r?\n/)) {
      const m = line.trim().match(/^TCP\s+127\.0\.0\.1:(\d+)\s+\S+\s+LISTENING\s+(\d+)$/);
      if (m && pidSet.has(m[2])) ports.push(Number(m[1]));
    }
    return [...new Set(ports)].sort((a, b) => b - a);
  } catch {
    return [];
  }
}

function runPowershell(script) {
  return new Promise((resolve, reject) => {
    execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true,
      timeout: 10000,
    }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });
}

/**
 * DSH 回环客户端：RPC + 双事件流。
 * 事件：'connected' | 'disconnected' | 'frame' (frame, channel) | 'describe' (describe)
 */
export class DshClient extends EventEmitter {
  constructor(port, { reconnectDelay = 2000, maxReconnectDelay = 15000 } = {}) {
    super();
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
    this.reconnectDelay = reconnectDelay;
    this.maxReconnectDelay = maxReconnectDelay;
    this.describe = null;
    this._sockets = new Set();
    this._stopped = false;
    this._retry = 0;
  }

  async call(method, payload = {}, signal) {
    const body = { type: "client-request", rpcId: rpcId(), method, payload };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const res = await fetch(`${this.base}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
      const full = await res.json();
      if (full.rpcId !== body.rpcId) throw new Error(`RPC ${method}: rpcId mismatch`);
      if (!full.result?.ok) {
        const rpcErr = full.result?.error;
        const e = new Error(`RPC ${method} failed: ${JSON.stringify(rpcErr) ?? "unknown"}`);
        e.rpcError = rpcErr; // {code, message, details}
        throw e;
      }
      return full.result.value;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", () => controller.abort());
    }
  }

  /** 发送完整信封（用于 client-response 类端点，如 /api/respond），返回服务端完整 JSON。 */
  async callRaw(method, fullBody, signal) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
    if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
    try {
      const res = await fetch(`${this.base}/api/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(fullBody),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`${method}: HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", () => controller.abort());
    }
  }

  async describeHost() {
    this.describe = await this.call("host.describe", {});
    this.emit("describe", this.describe);
    return this.describe;
  }

  /** 打开两条下行事件流并自动重连。 */
  startStreams() {
    this._stopped = false;
    this._openStream("/api/events.mux", "mux");
    this._openStream("/api/events.host", "host");
  }

  _openStream(path, channel) {
    if (this._stopped) return;
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}${path}`);
    this._sockets.add(ws);
    ws.addEventListener("open", () => {
      this._retry = 0;
      this.emit("connected", channel);
      if (this._sockets.size >= 2) this.emit("streams-up");
    });
    ws.addEventListener("message", (event) => {
      try {
        const full = JSON.parse(event.data);
        if (full?.type !== "server-request" || full?.payload == null) return;
        this.emit("frame", full.payload, channel, full.rpcId);
      } catch {
        // 丢弃坏帧
      }
    });
    ws.addEventListener("close", () => {
      this._sockets.delete(ws);
      this.emit("disconnected", channel);
      this._scheduleReconnect(path, channel);
    });
    ws.addEventListener("error", () => {
      try { ws.close(); } catch { /* noop */ }
    });
  }

  _scheduleReconnect(path, channel) {
    if (this._stopped) return;
    const delay = Math.min(this.reconnectDelay * 2 ** this._retry, this.maxReconnectDelay);
    this._retry += 1;
    setTimeout(() => this._openStream(path, channel), delay);
  }

  stop() {
    this._stopped = true;
    for (const ws of this._sockets) {
      try { ws.close(); } catch { /* noop */ }
    }
    this._sockets.clear();
  }
}
