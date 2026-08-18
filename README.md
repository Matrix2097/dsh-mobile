# DSH 手机监管（DSH Monitor）

在手机上实时监管电脑上的 **DeepSeek Harness**：任务进度实时监控、流式对话、模型/权限切换、任务完成/审批/出错提醒、只读可视化浏览电脑文件系统。支持 **PWA（浏览器）** 与 **Android App（常驻后台）** 两种形态。

零外部依赖：网关为纯 Node.js（≥21，内置 fetch/WebSocket），无需 npm install；Android App 零第三方库（原生 WebView + 前台服务）。

## 功能特性

| 能力 | 说明 |
|---|---|
| 实时监控 | 会话/任务进度秒级实时（SSE 推送，非轮询） |
| 流式对话 | agent 思考/回复逐字流式显示，思考与工具调用折叠 |
| 消息交互 | 输入框发消息、纠正模式（steer 打断引导） |
| Slash 命令 | 输入框 `/` 开头自动走命令通道（`/goal` `/permission` `/compact` 等） |
| 模型切换 | 多模型/多 provider 下拉切换，即时生效 |
| 权限切换 | 只读 / 工作区可写 / 完全访问，实时生效（命令通道） |
| 审批应答 | 需要授权时一键同意/拒绝 |
| 任务提醒 | 任务完成/失败、需要授权、Agent 出错 → 系统通知 |
| **后台常驻** | Android App 前台服务：锁屏/后台仍保持连接并推送通知 |
| 文件浏览 | 只读白名单目录、文本预览、下载到手机 |
| 外观主题 | 深色/浅色两档 |

## 架构

```
┌──────────── 手机 ────────────┐        ┌──────────── 电脑 ────────────┐
│  Android App / 浏览器 PWA     │        │                             │
│  ├─ WebView/PWA 界面          │        │  网关 server.js (0.0.0.0:8443)│
│  ├─ 前台服务（后台连接+通知）   │◄──────►│  ├─ PWA 静态页面              │
│  └─ SSE 实时推送              │ 局域网/  │  ├─ 事件泵：DSH 实时事件流     │
└─────────────────────────────┘ Tailscale│  ├─ /fs 只读文件服务（白名单） │
                                          │  └─ RPC：命令/模型/权限/审批    │
                                          │             │ 127.0.0.1:动态端口 │
                                          │        DSH Desktop /api        │
                                          └──────────────────────────────┘
```

- 网关以「回环客户端」身份连接 DSH 的 `/api`（HTTP RPC + `events.mux`/`events.host` 双 WebSocket 事件流），自动探测 DSH 当前端口（桌面 profile 端口是动态分配的）。
- 手机通过局域网 IP（或 Tailscale 虚拟网）访问网关，访问令牌保护；DSH 本身保持 127.0.0.1 不变。

## 目录结构

```
dsh-mobile/
├── server.js            # 网关主程序（HTTP + SSE + /fs + 状态聚合 + RPC 代理）
├── dsh.js               # DSH /api 协议客户端（RPC + 事件流 + 端口探测 + 重连）
├── start-gateway.ps1    # 一键启动（端口探测/防火墙/占用检查）
├── start-gateway.bat    # 双击入口
├── package.json         # 零依赖
├── public/              # PWA 前端（index.html / app.js / style.css / sw.js / manifest / 图标）
└── android-app/         # Android App（WebView 壳 + 前台服务）
    ├── app/src/main/java/com/matrix/dshmonitor/
    │   ├── MainActivity.kt      # 配置 + WebView（自动注入配置到 PWA）
    │   └── MonitorService.kt    # 前台服务：SSE 长连接 + 任务通知
    └── app/src/main/res/        # 布局 / 主题 / 图标
```

## 使用前置条件

### 电脑端（运行网关）

| 条件 | 说明 |
|---|---|
| 操作系统 | Windows 10/11（一键脚本为 PowerShell/.bat；其他系统需手动运行 `node server.js`） |
| Node.js | **≥ 21**（网关依赖内置 fetch/WebSocket；零 npm 依赖，无需 `npm install`） |
| DSH | 已安装并正在运行的 **DSH Desktop**（或 `dsh web`，端口需手动指定） |
| 防火墙 | 入站 TCP 8443 放行（`start-gateway.bat` 首次运行自动添加，需管理员一次） |

### 手机端（查看与交互）

| 形态 | 条件 |
|---|---|
| **PWA** | Android Chrome / iOS Safari 14+；同一局域网可访问电脑 IP；「任务提醒」需授予通知权限（仅前台有效） |
| **Android App** | Android 8.0+（minSdk 26）；安装 APK 需允许"未知来源"；部分国产 ROM 需在系统设置允许后台运行 |

### 网络

| 场景 | 要求 |
|---|---|
| 局域网使用 | 手机与电脑**同一 WiFi/网段**，能互通即可（无需公网 IP） |
| 远程使用（可选） | 手机与电脑均安装 **Tailscale**（同一账号），App 中电脑 IP 填 Tailscale 分配的 `100.x.x.x` 地址 |

### 仅构建 Android App 时需要（进阶）

| 工具 | 版本 |
|---|---|
| JDK | 17+ |
| Android SDK | platform 34 + build-tools 34（命令行 `sdkmanager` 或 Android Studio 均可） |
| Gradle | 8.10+（或使用项目自带 wrapper） |

> 日常使用**不需要**任何这些开发工具——只有你想自己重新打包 APK 时才需要。

## 快速开始

### 1. 启动网关（电脑端）

双击 `start-gateway.bat`，脚本自动：
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

### 2. 手机连接

**PWA 方式**（任何手机）：手机连同一局域网 → 浏览器打开 `http://<电脑IP>:8443/` → 设置页填 IP/端口/令牌 → 一键连接 → 添加到主屏幕。

**Android App**（推荐，支持后台提醒）：见下文。

### 3. 任务提醒

- **PWA**：设置页「开启任务提醒」（仅 App 前台有效）
- **Android App**：前台服务常驻，锁屏/后台也能推送

## Android App

### 构建 APK（命令行，无需 Android Studio）

前置：JDK 17+、Android SDK（platform 34 + build-tools 34）、Gradle 8.10+。

```bash
# 在 android-app/ 下创建 local.properties 指定 SDK 路径：
#   sdk.dir=C\:\\path\\to\\android-sdk
gradle assembleDebug
# 产物：app/build/outputs/apk/debug/app-debug.apk
```

### 安装与使用

1. 将 `app-debug.apk` 传到手机安装（允许"未知来源"）
2. 首次打开：填电脑 IP / 端口 / 令牌 → 「连接并启动后台监控」
3. 配置自动注入 PWA，界面直接可用；右上角 ⚙️ 可随时改配置
4. 通知栏出现"DSH 监控运行中" = 后台服务运行中，锁屏也能收到任务通知

注意：部分国产 ROM（小米/华为等）默认限制后台，请在系统设置中允许该 App 后台运行/自启动。

## API（PWA 与 Android 共用）

| 端点 | 说明 |
|---|---|
| `GET /api/state` | 聚合状态快照（会话/jobs/审批/事件） |
| `GET /api/stream?token=` | SSE 实时推送（snapshot + 事件帧 + 通知） |
| `GET /api/history?sessionId=` | 会话消息流（服务端过滤增量帧） |
| `GET /api/models?sessionId=` | 模型列表与当前选择 |
| `POST /api/select-model` | 切换模型 `{sessionId, provider, model}` |
| `POST /api/permission` | 切换工作模式 `{sessionId, mode}` |
| `POST /api/approval` | 审批应答 `{approvalId, outcome}` |
| `POST /api/interrupt` | 中断会话 `{sessionId}` |
| `POST /api/prompt` | 发消息 `{sessionId, content, mode?}`（`/` 开头自动转命令） |
| `POST /api/command` | 执行 slash 命令 `{sessionId, line}` |
| `GET /fs/list` / `GET /fs/read` / `GET /fs/download` | 只读文件服务 |

认证：`X-Gateway-Token` 请求头（SSE 用 `?token=`）。

## 安全说明

- 网关绑定 0.0.0.0，**局域网内任何人拿到令牌即可完全控制 DSH**（令牌默认随机生成，仅显示在启动窗口）。
- 文件服务**只读**且限制在 `--root` 白名单内。
- 不要在不受信任的网络上运行；远程访问建议走 Tailscale（设备认证 + 加密）。
- DSH 本身没有认证层，令牌是唯一防线。

## 已知限制

- **PWA 通知仅前台有效**（浏览器挂起后台标签页）；后台提醒请用 Android App
- 提问（ask_user_question）有提醒但暂未支持手机上直接回答
- 依赖 DSH 运行时接口（非官方稳定 API），DSH 大版本升级后可能需要小幅适配

## 逆向的 DSH 协议要点（备忘）

- RPC：`POST /api/<method>`，信封 `{type:"client-request", rpcId, method, payload}` → `{type:"server-response", rpcId, result:{ok,value|error}}`
- 端点域是**单数**：`session.list`、`session.prompt`、`session.history`、`session.interrupt`、`session.models`、`session.selectModel`、`workspace.list`
- Typert 端点：`namespace/method` 斜杠命名 + payload 需 `{args:{...}}` 包装（如 `commands/execute` 的 `{args:{agentId, line}}`）
- 事件流：`ws://127.0.0.1:port/api/events.mux`（会话事件）+ `/api/events.host`（全局状态）；帧 = `{type:"server-request", rpcId, method, payload}`
- 流式增量帧：`assistant/chunk` 含 `block-start` / `reasoning-delta` / `text-delta` / `tool-call-delta` / `block-end`
- 审批应答：`POST /api/respond` + `{type:"client-response", rpcId:<请求的rpcId>, result:{ok:true, value:{sessionId, approvalId, outcome}}}`
- 权限切换：`commands/execute` 执行 `/permission <mode>` slash 命令（不进模型上下文）
- 用户消息以 `user/message` 与 `agent/inbox/spliced` 双形态落库（渲染需按 id 去重）；插件注入的 `role:"user"` 上下文消息需按 `source.kind` 过滤
