# DSH 手机监管网关（dsh-mobile）

局域网内用手机实时监管电脑上的 **DeepSeek Harness**：任务进度实时监控、流式对话、模型/权限切换、任务完成/审批/出错提醒、只读可视化浏览电脑文件系统。

零外部依赖：纯 Node.js（≥21，内置 fetch/WebSocket），无需 npm install，无需 Tailscale（局域网直连）。

## 架构

```
手机 PWA（添加到主屏幕）         电脑
┌────────────────────┐         ┌──────────────────────────────┐
│ 状态 / 会话 / 文件 / │◄────────►│ 网关 server.js (0.0.0.0:8443) │
│ 设置 四页 + 详情页   │  局域网   │  ├─ PWA 静态页面              │
│ SSE 实时 + 系统通知  │  直连    │  ├─ 事件泵：DSH 实时事件流     │
└────────────────────┘         │  ├─ /fs 只读文件服务（白名单） │
                               │  └─ RPC：审批/中断/发消息/模型/  │
                               │      权限命令                   │
                               │             │ 127.0.0.1:动态端口 │
                               │        DSH Desktop /api        │
                               └──────────────────────────────┘
```

- 网关以「回环客户端」身份连接 DSH 的 `/api`（HTTP RPC + `events.mux`/`events.host` 双 WebSocket 事件流），自动探测 DSH 当前端口（桌面 profile 端口是动态分配的）。
- 手机通过局域网 IP 访问网关，带访问令牌保护；DSH 本身保持 127.0.0.1 不变。

## 快速开始

### 电脑端

双击 `start-gateway.bat`（或 `powershell -ExecutionPolicy Bypass -File start-gateway.ps1`）。

脚本自动：
1. 检查端口占用（旧实例未关会红字提示）
2. 添加防火墙入站规则（首次需管理员）
3. 探测 DSH Desktop 当前监听端口
4. 显示本机局域网 IP 和访问令牌，启动网关

直接 `node server.js` 参数：

| 参数 | 默认 | 说明 |
|---|---|---|
| `--port` | 8443 | 网关监听端口 |
| `--dsh-port` | 自动探测 | 指定 DSH 端口（跳过探测） |
| `--root` | `C:\Users\Lenovo\Desktop` | 文件白名单根目录（或环境变量 `GATEWAY_ROOT`） |
| `--token` | 随机生成 | 访问令牌；`--no-token` 关闭（不推荐） |

### 手机端

1. 手机连接**同一局域网**（同一 WiFi）
2. 浏览器打开 `http://<电脑IP>:8443/`
3. 设置页填写：电脑 IP、网关端口（8443）、访问令牌（网关窗口显示）
4. 点「一键连接」→ 自动记住配置，下次自动连接
5. 浏览器「添加到主屏幕」→ 全屏 App 体验
6. 设置页「开启任务提醒」→ 授权系统通知

## 功能

### 状态页
- DSH 版本 / 模型 / 端口 / 会话数
- 运行中的 Agent 卡片（任务 jobs 进度；无运行时显示最近活跃会话）
- 待处理审批（🔐 一键同意/拒绝）与提问（❓）

### 会话页 / 详情页
- 全部会话列表（运行状态、目录、preset、jobs 状态），点击进入详情
- **流式消息流**：思考过程（折叠）、正文逐字流式、工具调用+结果折叠条、实时心跳指示
- **聊天交互**：输入框发消息（Enter 发送），可切换「纠正模式」（steer 立即打断引导当前任务）
- **模型切换**：下拉选择（DeepSeek 官方 / modlens 视觉，v4-flash / v4-pro）
- **权限切换**：🔒只读 / 📝工作区可写 / ⚠️完全访问（完全访问有确认弹窗），实时生效并高亮

### 文件页
- 只读浏览白名单目录、面包屑导航、文本预览（≤512KB）、下载到手机

### 通知（前台有效）
- 任务完成/失败、需要授权、Agent 提问、Agent 出错 → 系统通知（同类合并防刷屏）
- 连接状态/授权结果只记录事件日志，不弹通知

### 设置页
- 连接配置（IP/端口/令牌，自动重连）
- 通知权限状态 + 开启按钮
- 事件日志（折叠，调试用）

## API（手机端 PWA 使用）

| 端点 | 说明 |
|---|---|
| `GET /api/state` | 聚合状态快照（会话/jobs/审批/事件） |
| `GET /api/stream?token=` | SSE 实时推送（snapshot + 事件帧 + 通知） |
| `GET /api/history?sessionId=` | 会话消息流（服务端过滤增量帧，消息级事件） |
| `GET /api/models?sessionId=` | 模型列表与当前选择 |
| `POST /api/select-model` | 切换模型 `{sessionId, provider, model}` |
| `POST /api/permission` | 切换工作模式 `{sessionId, mode}`（走 commands/execute） |
| `POST /api/approval` | 审批应答 `{approvalId, outcome}` |
| `POST /api/interrupt` | 中断会话 `{sessionId}` |
| `POST /api/prompt` | 发消息 `{sessionId, content, mode?}`（queue/steer） |
| `POST /api/commands` | 会话支持的命令列表 `{sessionId}` |
| `GET /fs/list?path=` / `GET /fs/read?path=` / `GET /fs/download?path=` | 只读文件服务 |

认证：`X-Gateway-Token` 请求头（SSE 用 `?token=`）。

## 安全说明

- 网关绑定 0.0.0.0，**局域网内任何人拿到令牌即可完全控制 DSH**（令牌默认随机生成，仅显示在启动窗口）。
- 文件服务**只读**且限制在 `--root` 白名单内。
- 不要在不受信任的网络上运行。
- 通知仅前台有效：浏览器切后台/锁屏后标签页会被挂起，提醒丢失；后台通知需 HTTPS + Web Push 或原生壳（见下）。

## 已知限制 / 后续

- **后台通知**：局域网 HTTP PWA 无法后台驻留；升级路线为 HTTPS（自签证书）+ Web Push（Android 可行）或 TWA 原生壳
- **提问应答**：`question/requested` 提醒已显示，但手机上直接回答的功能尚未接入（可走消息输入框回复）
- 事件日志默认折叠，展开可看调试信息

## 目录结构

```
dsh-mobile/
├── server.js            # 网关主程序（HTTP + SSE + /fs + 状态聚合 + RPC 代理）
├── dsh.js               # DSH /api 协议客户端（RPC + 事件流 + 端口探测 + 重连）
├── start-gateway.ps1    # 一键启动（端口探测/防火墙/占用检查）
├── start-gateway.bat    # 双击入口
├── package.json         # 零依赖
└── public/              # PWA 前端（index.html / app.js / style.css / sw.js / manifest / 图标）
```

## 逆向的 DSH 协议要点（备忘）

- RPC：`POST /api/<method>`，信封 `{type:"client-request", rpcId, method, payload}` → `{type:"server-response", rpcId, result:{ok,value|error}}`
- 端点域是**单数**：`session.list`、`session.prompt`、`session.history`、`session.interrupt`、`session.models`、`session.selectModel`、`workspace.list`、`commands/execute`
- Typert 端点：`namespace/method` 斜杠命名 + payload 需 `{args:{...}}` 包装（如 `commands/execute` 的 `{args:{agentId, line}}`）
- 事件流：`ws://127.0.0.1:port/api/events.mux`（会话事件）+ `/api/events.host`（全局状态）；帧 = `{type:"server-request", rpcId, method, payload}`
- 流式增量帧：`assistant/chunk` 含 `block-start` / `reasoning-delta` / `text-delta` / `tool-call-delta` / `block-end`
- 审批应答：`POST /api/respond` + `{type:"client-response", rpcId:<请求的rpcId>, result:{ok:true, value:{sessionId, approvalId, outcome}}}`
- 权限切换：`commands/execute` 执行 `/permission <mode>` slash 命令（GUI 同机制，不进模型上下文）
- 用户消息会以 `user/message` 与 `agent/inbox/spliced` 双形态落库（渲染需按 id 去重）
