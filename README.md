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
| **PWA** | **无需下载安装**——前端由电脑端网关自动托管，手机浏览器打开 `http://<电脑IP>:8443/` 即自动加载（前端代码在仓库 `public/` 目录，随网关分发）。仅需 Android Chrome / iOS Safari 14+；「添加到主屏幕」只是创建桌面快捷方式，不是下载安装；「任务提醒」需授予通知权限（仅前台有效） |
| **Android App** | Android 8.0+（minSdk 26）；需要下载 APK 安装（或自行构建）；安装需允许"未知来源"；部分国产 ROM 需在系统设置允许后台运行 |

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

## 从零开始部署（新手教程）

> 本节面向完全没接触过本项目的用户。按顺序做完每一步，即可在手机上看到 DSH 的实时状态。

### 第 0 步：先理解要装什么（3 样东西）

| 角色 | 是什么 | 装在哪 |
|---|---|---|
| **DSH** | DeepSeek Harness 本体（被监控的对象） | 电脑（你已经有，正在运行） |
| **网关** | 本项目的核心程序（把 DSH 的信息转发给手机） | 电脑（本仓库，需下载） |
| **手机端** | 浏览器打开页面（PWA）或安装 APK | 手机（不需要"装"任何东西，打开即用） |

关系：`手机 ⇄ 网关（电脑上） ⇄ DSH（电脑上）`。网关是手机和 DSH 之间的"翻译官"。

### 第 1 步：电脑准备

**1.1 安装 Node.js（若已装可跳过）**
1. 打开 https://nodejs.org/ ，下载 **LTS 版**（推荐 ≥ 22，本项目要求 ≥ 21）
2. 双击安装包，一路"下一步"即可
3. 验证是否装好：按 `Win+R` → 输入 `cmd` 回车 → 输入 `node -v` 回车 → 看到 `v24.x.x` 之类的版本号即成功

**1.2 确认 DSH 已安装并正在运行**
- 打开 DSH Desktop，能看到对话界面即可（网关会自动找到它）

**1.3 获取本项目代码**（二选一）
- **方式 A（推荐，有 git）**：打开命令行，运行
  ```
  git clone https://github.com/Matrix2097/dsh-mobile.git
  ```
- **方式 B（没有 git）**：浏览器打开仓库页面 → 绿色 **Code** 按钮 → **Download ZIP** → 解压到任意文件夹

### 第 2 步：启动网关（电脑端）

**2.1** 进入解压/克隆出来的 `dsh-mobile` 文件夹，**双击 `start-gateway.bat`**

**2.2** 首次运行，Windows 会弹"防火墙"提示 → 勾选「专用网络」→ 点「允许访问」（只需一次）

**2.3** 看黑色窗口的输出，确认三行关键信息：
```
探测到 DSH 端口: 55613      ← 网关已连上 DSH（没有这行请查常见问题）
手机访问:  http://192.168.1.5:8443/   ← 手机要打开的地址
访问令牌:  a1b2c3d4e5f6       ← 手机连接要用的密码
```
> ⚠️ **这个窗口要一直开着**——关掉窗口 = 关掉网关，手机就连不上了。

**2.4** 自检：电脑浏览器打开 `http://127.0.0.1:8443/`，能看到「DSH 监管」页面即网关正常。

### 第 3 步：手机连接（PWA 方式，无需下载）

**3.1** 手机连**和电脑同一个 WiFi**

**3.2** 打开手机浏览器（Chrome / Safari），地址栏输入第 2.3 步的地址，例如 `http://192.168.1.5:8443/`

**3.3** 首次进入显示「设置」页，填写三项：
| 填写项 | 填什么 |
|---|---|
| 电脑 IP | `192.168.1.5`（**不带** `http://`，**不带**端口） |
| 网关端口 | `8443` |
| 访问令牌 | 网关窗口里"访问令牌:"后面那串字符 |

**3.4** 点 **「一键连接」** → 顶部变成绿色 **「已连接」** → 部署完成 🎉

**3.5（可选）** 浏览器菜单 → **「添加到主屏幕」** → 桌面出现图标，以后像 App 一样点击进入

**3.6（可选）** 设置页 → **「开启任务提醒」** → 允许通知（任务完成/需要授权时会弹提醒）

### 第 4 步：验证是否真的通了

1. 电脑上让 DSH 的 agent 跑一个任务（比如"帮我列出当前文件夹的文件"）
2. 手机打开「会话」页 → 点正在运行的会话 → 应看到 agent 的**实时流式输出**
3. 手机「状态」页应显示"运行中"的会话卡片

### 第 5 步（可选）：Android App 方式（支持后台提醒）

1. 获取 APK：下载构建好的 `app-debug.apk`（或按下方「Android App」章节自行构建）
2. APK 传到手机（微信/网盘/数据线）→ 点击安装 → 允许"未知来源"
3. 打开 App → 填和第 3.3 步相同的三项 → 「连接并启动后台监控」
4. 通知栏出现"DSH 监控运行中" = 后台服务生效，**锁屏/切后台也能收到任务通知**

### 常见问题排查

| 现象 | 排查步骤 |
|---|---|
| 手机打不开页面 | ① 手机和电脑是否同一 WiFi？② 网关黑色窗口还开着吗？③ 防火墙放行了吗（重看 2.2）？④ 地址里的 IP 是否和窗口显示的一致？ |
| 连接失败：令牌不正确 | 令牌**每次启动都会变**，以当前窗口显示的为准，重新复制一遍 |
| 连接失败：Failed to fetch | IP 填错 / 网关没开 / 手机不在同一网络 |
| 窗口红字"端口已被占用" | 旧网关没关干净：关掉所有黑色网关窗口，重新双击 |
| 网关没探测到 DSH 端口 | 确认 DSH Desktop 正在运行，然后重启网关 |
| 手机页面功能是旧的 | 关闭浏览器标签页重新打开（旧页面有缓存） |

## Android App（进阶：自行构建）

> 日常使用直接装现成的 `app-debug.apk` 即可（见新手教程第 5 步）。以下仅供需要自己重新打包时参考。

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
