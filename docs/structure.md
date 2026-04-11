# Happy 项目架构深度分析

## 一、项目全景

Happy Coder 是一个**端到端加密的 AI 编程代理远程控制系统**，由 6 个 workspace 包组成：

| 包 | 路径 | 职责 |
|---|---|---|
| `happy-cli` | `packages/happy-cli/` | CLI 工具，包装 Claude/Codex/Gemini 等代理 |
| `happy-app` | `packages/happy-app/` | 移动端 + Web 客户端 (Expo/React Native) |
| `happy-server` | `packages/happy-server/` | 中继服务器 (Fastify + PostgreSQL + Redis + Socket.IO) |
| `happy-agent` | `packages/happy-agent/` | 远程代理控制 CLI |
| `happy-wire` | `packages/happy-wire/` | 共享线协议类型和 Zod Schema |
| `happy-app-logs` | `packages/happy-app-logs/` | 简单日志服务器 |

**核心工作流**：用户在电脑上运行 `happy claude` 替代 `claude`，即可通过手机远程控制编程会话，所有数据端到端加密，服务器无法读取。

**技术栈**：
- CLI: Node.js + ink (React 终端 UI)
- App: Expo SDK 55 + React Native 0.83 + Expo Router v6
- Server: Fastify 5 + Prisma ORM + PostgreSQL + Redis + Socket.IO
- 加密: TweetNaCl + libsodium + AES-256-GCM
- 协议: Zod Schema 校验 + Socket.IO 传输

---

## 二、Relay Server 交互架构

### 2.1 三层连接模型

Server 通过 Socket.IO（路径 `/v1/updates`）维护三种连接类型：

| 连接类型 | 认证参数 | 代表 |
|---|---|---|
| `session-scoped` | token + sessionId | CLI 运行中的单个代理会话 |
| `machine-scoped` | token + machineId | 开发机上的守护进程 |
| `user-scoped` | token | 手机/Web 客户端（全局视角） |

Socket.IO 配置：ping 间隔 15s，超时 45s，支持 websocket + polling 升级。

### 2.2 EventRouter —— 中继核心引擎

`packages/happy-server/sources/app/events/eventRouter.ts` 是整个中继的心脏，维护内存映射：

```
userConnections: Map<userId, Set<ClientConnection>>
```

#### 两类事件

| 类别 | 传输方式 | 类型 |
|---|---|---|
| **持久更新 (update)** | 带 seq 序列号，支持离线追赶 | `new-message`, `update-session`, `new-machine`, `new-artifact` 等 13 种 |
| **临时事件 (ephemeral)** | 即时投递，不持久化 | `activity`(会话心跳), `machine-activity`(机器在线), `usage`(token统计), `machine-status` |

#### 路由过滤器 (RecipientFilter)

| 过滤器 | 接收者 | 用途 |
|---|---|---|
| `all-interested-in-session` | user-scoped + 匹配的 session-scoped | 会话消息/状态更新 |
| `user-scoped-only` | 仅手机/Web | 在线状态、用量、Artifact |
| `machine-scoped-only` | user-scoped + 匹配的 machine-scoped | 机器元数据/守护状态 |

#### 关键机制 —— skipSender

CLI 发消息后，中继广播给其他连接但**不回送给自己**，避免重复处理。

### 2.3 序列号双轨制

- **userSeq**：PostgreSQL `Account.seq` 原子递增，提供用户全部更新的全序排列，支持离线追赶
- **sessionSeq**：per-session 单调递增计数器，保证会话消息顺序

---

## 三、数据上报与中转

### 3.1 会话消息

HTTP 批量 + WebSocket 推送：

```
CLI 加密消息 → POST /v3/sessions/{id}/messages (批量,最多50条)
                → Server 存储 {t:'encrypted', c: base64}
                → 分配 userSeq + sessionSeq
                → EventRouter 广播 'new-message' update
                → 手机/Web 接收、解密、展示
```

消息内容永远是加密的 `{t: 'encrypted', c: '<base64>'}`，Server 看不到明文。

### 3.2 会话元数据 & Agent 状态

使用 `version` 字段做 CAS（Compare-And-Swap）乐观并发控制：
- CLI 发送 `expectedVersion` + 加密的 metadata/agentState
- Server 校验版本 → 匹配则原子更新并递增版本 → 广播给相关连接
- 不匹配则返回当前版本和数据 → 客户端合并后重试

### 3.3 机器状态 —— 守护进程心跳

- 守护进程每 20 秒发送 `machine-alive` 事件
- 连接时立即推送 `daemonState: {status:'running', pid, httpPort}`
- Server 广播 `machine-activity` ephemeral 给 user-scoped 连接

### 3.4 用量统计 (Usage Report)

```
CLI → socket.emit('usage-report', {key, sessionId, tokens, cost})
     → Server upsert UsageReport 表
     → 广播 'usage' ephemeral 给 user-scoped
```

tokens 包含 `total/input/output/cache_creation/cache_read`，cost 包含 `total/input/output`。

### 3.5 RPC 跨域控制

Server 作为纯中继，实现用户内跨 Socket 的远程过程调用：

```
手机 → rpc-call({method: 'machineId:spawn-happy-session', params: encrypted})
     → Server 查找注册该方法的 socket
     → emitWithAck('rpc-request', ..., 30s timeout) 转发到守护进程
     → 守护进程解密参数 → 执行 → 加密响应
     → Server 返回加密响应给手机
```

已注册的 RPC 方法：`spawn-happy-session`, `stop-session`, `stop-daemon`, `resume-happy-session`

RPC 方法名命名空间：`${scopePrefix}:${method}`，session 用 sessionId，machine 用 machineId。

---

## 四、端到端加密体系

### 4.1 三层加密算法

| 算法 | 用途 | 密钥 | Nonce |
|---|---|---|---|
| NaCl SecretBox (XSalsa20-Poly1305) | 遗留模式，无 DEK 时用 | 32 字节 master secret | 24 字节随机 |
| NaCl Box (Curve25519-XSalsa20-Poly1305) | 加密 DEK（密钥包装） | 临时密钥对 + 接收方公钥 | 24 字节随机 |
| AES-256-GCM | 主加密算法，每个实体独立 DEK | 32 字节随机 DEK | 12 字节 |

### 4.2 密钥层次结构

```
Master Secret (用户根凭证)
    │
    ├─ HMAC-SHA512 KeyTree 派生
    │   ├─ contentDataKey → crypto_box_seed_keypair → contentKeyPair
    │   │   ├─ 公钥：存储到服务器
    │   │   └─ 私钥：解密 DEK
    │   └─ analyticsId (匿名统计 ID)
    │
    └─ Per-Entity DEK (每个 session/machine/artifact 独立)
        ├─ 32 字节随机生成
        ├─ 用 Box 加密到 contentKeyPair.publicKey（密钥包装）
        ├─ 包装后的 DEK 存储到服务器的 dataEncryptionKey 字段
        └─ 内容用 AES-256-GCM 加密
```

### 4.3 加密 vs 明文

| 加密（Server 不可读） | 明文（Server 可见） |
|---|---|
| 会话消息内容 | 所有 ID、版本号、序列号 |
| 会话元数据（路径、工具、摘要等） | 时间戳、活跃状态 |
| Agent 状态（权限请求等） | 事件类型标识符 |
| 机器元数据/守护状态 | 用量统计数字 |
| Artifact header/body | 临时事件数据 |
| DEK（包装后） | 社交关系、Feed |

---

## 五、文件传输方式

Happy **没有独立的文件传输功能**，数据交换通过以下机制实现：

### 5.1 图片上传（REST/HTTP）

`packages/happy-server/sources/storage/uploadImage.ts`:
1. 查询 UploadedFile 表去重（by reuseKey）
2. 处理图片（缩放、提取 thumbhash）
3. 存储到 S3/MinIO 或本地文件系统
4. 路径模式: `public/users/{userId}/{directory}/{randomKey}.{format}`

### 5.2 Session 文件事件（Wire Protocol 引用）

```typescript
sessionFileEventSchema: { t: 'file', ref, name, size, mimeType?, image?: {width, height, thumbhash} }
```

这是**文件引用**而非文件内容，指向已上传的图片/文件。

### 5.3 Artifact 系统（加密文档/文件共享）

Artifact 是端到端加密的结构化数据对象：

```
Artifact {
  id: UUID
  header: encrypted { title, sessions?, draft? }    // 独立版本控制
  body: encrypted { body: string | null }           // 独立版本控制
  dataEncryptionKey: encrypted(wrapped DEK)         // Box 加密
  headerVersion / bodyVersion                       // OCC 双版本号
}
```

- 每个 Artifact 有独立 32 字节随机 DEK
- Header 和 Body 可独立更新，各自有乐观并发版本号
- Artifact 与 Session 的关联是加密 header 内的 `sessions[]` 数组，Server 无感知
- CRUD：`POST /v1/artifacts`（创建，幂等）、`GET`（列表不含 body / 单条含 body）、`POST /v1/artifacts/:id`（更新，含 OCC）、`DELETE`

### 5.4 Git 状态同步

App 端有 `gitStatusSync.ts` / `gitStatusFiles.ts` / `git-parsers/` 解析 CLI 上报的 git 仓库状态。

---

## 六、本地 Claude 交互方式与实现原理

### 6.1 双模式架构

```
┌─────────────────────────────────────────────────┐
│                    loop.ts                       │
│          while(true) { mode switch }             │
│                                                  │
│   ┌──────────────┐      ┌───────────────────┐   │
│   │  Local Mode  │ ←──→ │   Remote Mode     │   │
│   │ (交互式终端) │      │  (SDK 驱动)       │   │
│   └──────────────┘      └───────────────────┘   │
└─────────────────────────────────────────────────┘
```

用户双击空格或从手机发消息时，两种模式之间切换。

### 6.2 Local Mode —— 进程劫持 + 文件监听

**启动**：`child_process.spawn('node', ['claude_local_launcher.cjs', ...])`

- `stdio: ['inherit', 'inherit', 'inherit', 'pipe']` —— stdin/stdout/stderr 直接继承给 Claude
- **fd 3**用于接收 thinking 状态

**claude_local_launcher.cjs 的核心**：Monkey-patch `global.fetch`，每次 API 请求通过 fd 3 发送 `fetch-start` / `fetch-end` 事件，Happy 据此判断 thinking 状态（500ms 去抖）。

**Session ID 发现**：
```
Claude SessionStart Hook → session_hook_forwarder.cjs → HTTP POST → Hook Server → onSessionHook(sessionId) → SessionScanner 开始监听 JSONL
```

Hook 配置文件：`~/.happy/tmp/hooks/session-hook-<pid>.json`，通过 `--settings` 传给 Claude。

**消息捕获**（Local 模式独有）：
```
Claude 写入 JSONL 文件
  → FileWatcher → SessionScanner.invalidate()
  → 解析 JSONL → mapClaudeLogMessageToSessionEnvelopes()
  → 加密 → POST /v3/sessions/{id}/messages → Server → 手机
```

### 6.3 Remote Mode —— SDK 流式控制

**启动**：通过 `@anthropic-ai/claude-code` SDK，以 `--output-format stream-json --input-format stream-json` 模式启动 Claude。

**消息流**：
```
手机消息 → WebSocket → CLI 解密 → MessageQueue2
    → nextMessage() 解析 → PushableAsyncIterable<SDKUserMessage>
    → 写入 Claude stdin (JSON lines)
    → Claude stdout 输出 SDKMessage (JSON lines)
    → Query.readMessages() 解析
    → for-await 循环分发:
        ├─ formatClaudeMessageForInk() (终端UI)
        ├─ sdkToLogConverter → JSONL
        ├─ sessionProtocolMapper → SessionEnvelope
        └─ 加密 → HTTP POST → Server → 手机
```

**权限控制流**：
```
Claude 请求工具权限 → SDK control_request (can_use_tool)
    → Query 调用 canCallTool()
    → PermissionHandler 发送权限请求到手机
    → 手机批准/拒绝 → WebSocket RPC
    → Query 写入 control_response 到 Claude stdin
```

### 6.4 MCP Server

`packages/happy-cli/src/claude/utils/startHappyServer.ts` 启动 MCP 服务器（随机端口，StreamableHTTP）：
- 注册工具：`change_title` —— 让 Claude 能主动修改会话标题
- 每次请求创建新的 McpServer + Transport（MCP SDK >=1.27 要求）

### 6.5 协议翻译链

```
Raw Claude JSONL
  → RawJSONLines (Zod 校验)
  → SessionEnvelope (@slopus/happy-wire)
  → 加密 (AES-256-GCM with per-session DEK)
  → HTTP POST (批量发送)
  → Server 存储 + 路由
  → WebSocket 推送
  → 手机解密 + 展示
```

`sessionProtocolMapper.ts` 是关键翻译层，负责：
- **Turn 追踪**：每个 user-assistant 交换包裹在 `turn-start` / `turn-end` 中
- **子代理映射**：识别 `Task` / `Agent` 工具调用为子代理，生成稳定 subagentId
- **消息类型映射**：text block → `agent {t:'text'}`，thinking → `agent {t:'text', thinking:true}`，tool_use → `tool-call-start/end`

---

## 七、架构关键特性总结

| 特性 | 实现方式 |
|---|---|
| **端到端加密** | Server 只看到 opaque base64，不持有任何解密密钥 |
| **乐观并发控制** | 所有可变状态使用 version CAS 模式，冲突时返回当前数据 |
| **双序号保证** | userSeq（全序）+ sessionSeq（会话序）支持离线追赶 |
| **Skip-Sender 中继** | 发送方不会收到自己的消息回声 |
| **连接类型路由** | 不同客户端只收到相关事件，避免噪声 |
| **InvalidateSync 合并** | 多次失效信号合并为一次 HTTP 请求，防止冗余 |
| **双捕获策略** | Local 用文件监听，Remote 用 SDK stdout，都汇聚到同一 protocolMapper |
| **RPC 跨域控制** | 手机通过 RPC 触发守护进程 spawn/stop session |
| **幂等操作** | 消息 localId 去重、Artifact 创建幂等、UsageReport upsert |

---

## 八、关键文件索引

### Server 中继
- `packages/happy-server/sources/app/api/socket.ts` —— Socket.IO 连接管理
- `packages/happy-server/sources/app/events/eventRouter.ts` —— 核心路由引擎
- `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts` —— 会话更新中继
- `packages/happy-server/sources/app/api/socket/rpcHandler.ts` —— RPC 中继
- `packages/happy-server/sources/app/api/socket/artifactUpdateHandler.ts` —— Artifact 中继
- `packages/happy-server/sources/app/api/socket/usageHandler.ts` —— 用量统计
- `packages/happy-server/sources/app/api/socket/machineUpdateHandler.ts` —— 机器状态中继

### CLI 通信
- `packages/happy-cli/src/api/apiSession.ts` —— 会话 WebSocket 客户端
- `packages/happy-cli/src/api/apiMachine.ts` —— 机器 WebSocket 客户端
- `packages/happy-cli/src/api/encryption.ts` —— 加密工具
- `packages/happy-cli/src/api/api.ts` —— REST API 客户端

### Claude 集成
- `packages/happy-cli/src/claude/claudeLocal.ts` —— 本地模式
- `packages/happy-cli/src/claude/claudeRemote.ts` —— 远程模式
- `packages/happy-cli/src/claude/runClaude.ts` —— 主编排器
- `packages/happy-cli/src/claude/loop.ts` —— 控制循环
- `packages/happy-cli/src/claude/sdk/query.ts` —— SDK 查询包装
- `packages/happy-cli/src/claude/utils/sessionProtocolMapper.ts` —— 协议映射

### Wire 协议
- `packages/happy-wire/src/sessionProtocol.ts` —— 会话信封和事件 Schema
- `packages/happy-wire/src/messages.ts` —— 线消息 Schema
- `packages/happy-wire/src/legacyProtocol.ts` —— 遗留协议
- `packages/happy-wire/src/messageMeta.ts` —— 消息元数据

### 加密
- `packages/happy-app/sources/sync/encryption/encryption.ts` —— 主加密类
- `packages/happy-app/sources/sync/encryption/encryptor.ts` —— 三种加密实现
- `packages/happy-app/sources/sync/encryption/sessionEncryption.ts` —— 会话加密
- `packages/happy-app/sources/encryption/deriveKey.ts` —— 密钥派生
- `packages/happy-app/sources/encryption/libsodium.ts` —— NaCl 原语

---

## 九、跨平台代码共享架构

Happy App 采用 **Expo SDK 54 + React Native** 构建，目标平台包括 iOS、Android、Web 和 macOS 桌面（Tauri）。约 **95% 的代码在所有平台上完全共享**，平台差异仅集中在渲染原语和原生 SDK 绑定层。

### 9.1 共享策略

代码共享依赖三个机制：

1. **Metro bundler 平台扩展名**：`.web.ts`、`.native.ts`、`.ios.tsx`、`.android.tsx` 由 Metro/webpack 根据目标平台自动选择，约 20 个文件使用此模式
2. **运行时 `Platform.OS` / `Platform.select`**：约 40+ 个文件中用于微调行为（hover 效果、键盘处理、布局间距等）
3. **共享接口 + 平台实现**：定义 `types.ts` 接口，提供 `.ts`（native）和 `.web.ts` 两个实现，通过 `index.ts` 重导出

### 9.2 各层共享情况

| 层 | 共享程度 | 平台特有文件数 |
|---|---|---|
| **Sync 引擎** (sync.ts, storage.ts, 全部 API 模块) | 100% | 0 |
| **状态管理** (Zustand store, reducer) | 100% | 0 |
| **加密逻辑** (libsodium.ts, aes.ts, deriveKey.ts) | 100% | 0 |
| **Auth** (AuthContext, tokenStorage, QR 流程) | 100% | 0 |
| **Hooks** (25 个) | 100% | 0 |
| **路由** (50+ 页面, Expo Router v6) | 100% | 1 (web: `+html.tsx`) |
| **组件** (~70 个) | ~90% | 10 (6 组件有平台分支) |
| **加密原语** (libsodium.lib, base64, hmac) | 共享接口 | 5 |
| **实时语音** | 共享逻辑 | 4 (2 组件 × 2 变体) |
| **应用内购买** (RevenueCat) | 共享类型 | 2 |
| **触觉反馈** (Haptics) | — | 2 (native + web no-op) |

### 9.3 加密原语层 —— 平台分歧点

高层加密 API 完全共享，仅底层原语库有平台分支：

| 模块 | Native (iOS/Android) | Web |
|---|---|---|
| `libsodium.lib` | `@more-tech/react-native-libsodium` | `libsodium-wrappers` (纯 JS) |
| `base64` | `react-native-quick-base64` | `atob` / `btoa` |
| `hmac_sha512` | `expo-crypto` Crypto.digest | `@noble/hashes` (纯 JS) |

### 9.4 有平台分支的 UI 组件

仅 6 个组件因原生 API 差异需要平台特定实现：

| 组件 | iOS | Android | Web | 分歧原因 |
|---|---|---|---|---|
| `SessionActionsNativeMenu` | SwiftUI `ContextMenu` | Jetpack Compose `DropdownMenu` | 空壳 (用 Popover 代替) | 原生菜单 API |
| `AgentContentView` | Reanimated 键盘动画 | 默认键盘处理 | 默认键盘处理 | iOS 键盘动画 |
| `AvatarSkia` | Skia Canvas | Skia Canvas | 内联 `<svg>` | Skia Web 不可用 |
| `QRCode` | Skia Canvas | Skia Canvas | 内联 `<svg>` | Skia Web 不可用 |
| `MultiTextInput` | RN TextInput + setNativeProps | RN TextInput + setNativeProps | `react-textarea-autosize` | 输入框行为差异 |
| `PlusPlus` | LinearGradient + MaskedView | LinearGradient + MaskedView | CSS `background-clip: text` | 渐变文字实现 |

### 9.5 平台服务抽象

| 服务 | Native | Web | 共享接口 |
|---|---|---|---|
| **RevenueCat** | `react-native-purchases` + 原生 PaywallUI | `@revenuecat/purchases-js` | `revenueCat/types.ts` |
| **实时语音** | `@elevenlabs/react-native` | `@elevenlabs/react` + `getUserMedia` | 相同的 hook 结构 |
| **Haptics** | `expo-haptics` | no-op stubs | 相同 API |
| **Skia 加载** | 自动加载 (no-op) | `LoadSkia()` 手动初始化 | — |

### 9.6 架构图

```
共享入口 (index.ts)
    → Expo Router 统一路由 (sources/app/)           ← 100% 共享
        → 共享页面 + 组件 (~90% UI)                 ← 仅 6 组件有平台分支
            → 共享 Hooks (25 个)                    ← 100% 共享
                → 共享 Sync / Storage / Auth        ← 100% 共享
                    → 共享加密逻辑                   ← 100% 共享
                        → 平台加密原语               ← Metro 自动选择
                            ├─ .native.ts (iOS/Android)
                            └─ .web.ts (Web/Tauri)
```

### 9.7 实际影响

- **Sync/Storage 层的修改**（如消息懒加载）在所有平台自动生效，无需额外适配
- **组件层的修改**需注意是否触及平台分支文件，尤其是 `SessionActionsNativeMenu` 和 `AgentContentView`
- **新增功能**默认在所有平台可用；仅当涉及原生 API（菜单、动画、渲染引擎）时才需要平台分支
- **Web 为次要平台**：有 ~3 个 Web-only 文件（`FaviconPermissionIndicator`、`faviconGenerator`、`+html.tsx`）
- **Tauri 桌面版**复用 Web 代码路径，通过 `window.__TAURI_INTERNALS__` 检测并微调字体加载行为
