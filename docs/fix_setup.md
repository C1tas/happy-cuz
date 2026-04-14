# cuz 分支优化修复摘要

本文档汇总 `cuz` 分支的全部优化项目，作为各专项文档的入口索引。

---

## 1. 错误分类与事件上报

**问题**: CLI 所有错误统一上报为 "Process exited unexpectedly"，App 端无法区分错误来源，无详细信息。

**修复**: 新增 `error` 事件类型，携带 `source`（happy/claude/codex）和完整 `detail` 字符串，通过持久化管道传递到 App，红色文字渲染，不截断。

**涉及文件**:
- CLI: `apiSession.ts`, `claudeRemoteLauncher.ts`, `claudeLocalLauncher.ts`
- App: `typesRaw.ts`, `theme.ts`, `MessageView.tsx`

**详细文档**: [error-handling-and-resume-fallback.md](./error-handling-and-resume-fallback.md)

---

## 2. Resume Fallback（会话恢复降级）

**问题**: `--resume <sessionId>` 的 JSONL 文件不存在时，CLI 进入无限重试循环。`consumeOneTimeFlags()` 仅在成功路径调用，失败路径不消费 `--resume` 标志。

**修复**: 在 catch 路径调用 `consumeOneTimeFlags()`，剥离 `--resume` 参数，下一轮迭代以同项目目录启动新 Claude 会话。

**涉及文件**:
- CLI: `claudeRemoteLauncher.ts`, `claudeLocalLauncher.ts`

**详细文档**: [error-handling-and-resume-fallback.md](./error-handling-and-resume-fallback.md#resume-fallback-mechanism) | [session-restart-implementation.md](./session-restart-implementation.md#resume-fallback-missing-jsonl-recovery)

---

## 3. App 重启错误注入聊天

**问题**: 重启会话的错误仅在 `RestartProgressModal` 弹窗中显示，容量有限且不持久。

**修复**: 新增 `sync.injectLocalEvent()` 方法，将错误作为 `error` 事件注入会话聊天记录，与弹窗并存，完整展示错误信息。

**涉及文件**:
- App: `sync.ts`, `useSessionQuickActions.ts`

**详细文档**: [error-handling-and-resume-fallback.md](./error-handling-and-resume-fallback.md#6-app-local-event-injection)

---

## 4. Yolo 模式修复

**问题**: 权限模式哈希仅使用 `isPlan` 布尔值，导致 yolo/safe-yolo 切换不触发 SDK 重启；Plan 退出后 prePlanMode 未正确恢复。

**修复**: 哈希改用完整 `permissionMode` 字符串；`PermissionHandler` 在 plan 模式进入时保存 `prePlanMode`，退出时恢复。

**涉及文件**:
- CLI: `permissionHandler.ts`, `claudeRemoteLauncher.ts`

**详细文档**: [permission-resolution.md](./permission-resolution.md) | [yolo_problem.md](./yolo_problem.md) | [research/yolo-mode-investigation.md](./research/yolo-mode-investigation.md)

---

## 5. 跨栈数据管道（Ephemeral + Persistent）

**问题**: 新增 HUD 状态栏、压缩状态、权限模式等字段需要贯穿 CLI -> Server -> App 三层。

**修复**: 扩展 ephemeral 管道（volatile socket）传输实时状态；扩展 persistent 管道（HTTP POST 加密消息）传输错误事件。文档化 7 层扩展流程和显著变更刷新规则。

**详细文档**: [cross-stack-patterns.md](./cross-stack-patterns.md)

---

## 6. prod-cuz 构建流程

**问题**: 构建过程中遇到 Gradle 缓存损坏、Kotlin 并行编译竞争、npx 在 monorepo 中无法解析 expo 等问题。

**修复**: 文档化完整构建流程、变体切换规则、Firebase 项目隔离配置、故障排除方案。

**涉及文件**:
- 配置: `app.config.js`, `google-services-cuz.json`, `eas.json`

**详细文档**: [cuz-build.md](./cuz-build.md)

---

## 7. CLI 架构扩展

**问题**: 新增 resume 菜单、remote 模式 CLI 参数、codex 支持等需要文档跟进。

**详细文档**: [cli-architecture.md](./cli-architecture.md)

---

## 8. App 重启会话 Fallback（无 Backend ID 时新建会话）

**问题**: 当会话缺少 `claudeSessionId`/`codexThreadId`（例如进程崩溃未上报 backend ID、或 metadata 被清除）时，重启按钮被禁用，用户无法从 App 端触发重启，只能手动新建会话。

**修复**: 当 backend session ID 缺失时，重启操作自动 fallback 为在相同目录下 spawn 一个全新的 CLI 会话（通过 `machineSpawnNewSession`），然后归档旧会话，导航到新会话。

**核心逻辑变更**:
- `getRestartAvailability` 新增 `isFreshRestart` 标志，区分"resume 重启"和"fresh 重启"
- 将 machine/online 检查前置于 backend ID 检查之前，确保 fresh restart 仍需在线机器
- `performRestart` 分流：fresh 路径调用 `machineSpawnNewSession`，成功后 `sessionKill` 归档旧会话；resume 路径保持不变
- `RestartProgressModal` 新增 `spawning_fresh` 阶段，展示新会话创建进度

**涉及文件**:
- App: `useSessionQuickActions.ts`（主逻辑）, `RestartProgressModal.tsx`（新阶段 UI）
- i18n: `_default.ts` + 10 个翻译文件（新增 `restartSessionFreshSubtitle`, `restartProgressSpawningFresh`）

---

## 9. Remote→Local 切换双光标修复（Ink stdin 守卫）

**问题**: 从 remote 模式通过双空格切换回 local 模式后，Claude Code 输入区出现两个光标，文本输入和自动补全完全异常。

**根因**: Ink 框架在 `unmount()` 时内部清理逻辑与 launcher 的终端状态管理冲突：
- `useInput` cleanup → `disableRawMode()` → `stdin.setRawMode(false)` + `stdin.unref()`
- `App.js` cleanup → `cliCursor.show(stdout)` 写入 `\x1b[?25h`
- `log.done()` → `cliCursor.show(stream)` 再次写入 `\x1b[?25h`

尽管 launcher 的注释明确标注 "Do NOT call setRawMode(false)"，Ink 的内部清理仍会：
1. 打开 cooked-mode 窗口，键盘输入被 kernel 行规则回显和缓冲
2. `stdin.unref()` 将 stdin 从事件循环引用计数中移除
3. 多次 cursor-show 写入仍在 alt screen 中执行，导致终端光标状态不一致

**修复**: 在 switch 路径的 `inkInstance.unmount()` 前，monkey-patch `process.stdin.setRawMode` 和 `process.stdin.unref` 为 no-op，unmount 完成后通过 `try/finally` 立即恢复。

**终端状态流（修复后）**:
1. Ink unmount: stdin 保持 raw 模式（guard 阻止了 setRawMode(false)）
2. 排空 Node.js stdin 缓冲区
3. 退出 alt screen，显示光标，重置 SGR
4. `claudeLocal.ts`: `stdin.pause()` + `setRawMode(false)` — 单次干净过渡
5. `claudeLocal.ts`: spawn 子进程继承干净的终端

**涉及文件**:
- CLI: `claudeRemoteLauncher.ts`（lines 620-634，stdin guard 逻辑）

**调试方法**:
```bash
HAPPY_TERMINAL_DEBUG=1 ./bin/happy.mjs daemon start
# 查看 /tmp/happy-terminal-debug-{pid}.log
# 预期日志: "guarding stdin from Ink raw-mode teardown" → "stdin guard removed"
```

---

## 文档索引

| 文档 | 内容 |
|------|------|
| [error-handling-and-resume-fallback.md](./error-handling-and-resume-fallback.md) | 错误分类、事件流、resume fallback 完整实现 |
| [session-restart-implementation.md](./session-restart-implementation.md) | 三栈重启流程 + resume fallback 章节 |
| [cross-stack-patterns.md](./cross-stack-patterns.md) | 跨栈特性实现模式（ephemeral/persistent 管道、HUD、压缩、错误事件） |
| [cuz-build.md](./cuz-build.md) | prod-cuz Android 构建指南与故障排除 |
| [cli-architecture.md](./cli-architecture.md) | CLI 架构、resume 菜单、remote 模式参数 |
| [permission-resolution.md](./permission-resolution.md) | 权限模式解析、yolo/plan 模式交互 |
| [yolo_problem.md](./yolo_problem.md) | Yolo 模式问题分析与修复状态 |
| [research/yolo-mode-investigation.md](./research/yolo-mode-investigation.md) | Yolo 模式根因调查 |
| [session-restart-fallback.md](#8-app-重启会话-fallback无-backend-id-时新建会话) | App 重启 fallback：无 backend ID 时 spawn 新会话 |
| *(inline)* | Remote→Local 切换 Ink stdin 守卫，防止双光标和输入异常 |

---

## 10. 输入框状态栏重构 + Header Avatar 响应式布局

### 10a. 状态栏重构

**问题**: 输入框上方状态栏使用单行 `flexDirection: 'row'` + `justifyContent: 'space-between'` 布局，所有信息（在线状态、CLI 状态、模型名、上下文占比、权限模式等）挤在一行。窄屏溢出截断，CLI 同步状态显示 `(cli:bypassPermissions)` 冗长且难读。权限徽章使用 IIFE 模式，可读性差。

**修复**:
- 外层容器改用 `flexWrap: 'wrap'`，`gap: 8`，`rowGap: 2`，项目自动换行
- 移除内层 `<View style={{ flex: 1, gap: 11 }}>` 包裹层，所有项目成为外层直接子元素
- 在权限徽章前插入 `<View style={{ flex: 1, minWidth: 8 }} />` 弹性间距，宽屏时推向右侧，窄屏时自然换行
- CLI 状态项（claude/codex/gemini）合并为单个紧凑 chip，check/cross 与名称在同一 `<Text>` 中
- CLI 同步指示器从 `(cli:bypassPermissions)` 文本改为 `sync-outline` 图标（10px，半透明）
- 上下文警告移除条件 `marginLeft` 和 `'• '` 前缀，由容器 `gap` 统一控制间距
- 权限徽章变量（`effectivePermKey`、`isPermSyncing`、`permColor`、`permIcon`、`effectivePermName`）从 IIFE 提取到组件体
- `getPermissionColor` 提取为模块级函数，与 `getContextWarning` 并列

**涉及文件**:
- App: `AgentInput.tsx`（状态栏渲染 + 新增 `getPermissionColor` 函数）

### 10b. Header Avatar 响应式显示

**问题**: 手机端（<800px）header 同时显示 `...` info 按钮和 avatar 按钮，两者导航到同一页面，冗余且浪费空间。

**修复**: 使用 `useWindowDimensions()` 获取窗口宽度，`windowWidth >= 800` 时显示 avatar，否则隐藏。`...` 按钮始终显示作为主入口。

**涉及文件**:
- App: `ChatHeaderView.tsx`（新增 `useWindowDimensions` 导入 + `showAvatar` 条件渲染）

---

## 11. Plan 模式同步修复（权限模式卡死）

**问题**: 进入 plan 模式后，App 端长期显示为计划模式，无法同步 CLI 已退出 plan 模式的状态。当 Claude 已开始执行编辑和工具调用后，App 端仍显示计划模式。

**根因分析 — 双重断裂**:

### Gap 1: CLI 端 `session.currentPermissionMode` 未随 plan 退出更新

ExitPlanMode 审批后，`permissionHandler` 内部正确恢复模式（`this.permissionMode = restoredMode`），并注入 `PLAN_FAKE_RESTART` 到队列。`claudeRemoteLauncher.ts` 的 `nextMessage()` 调用 `permissionHandler.handleModeChange()` — 但从未调用 `session.onPermissionModeChange()`。

`session.onPermissionModeChange()` 唯一的调用点在 `runClaude.ts` 的 `onUserMessage` 处理器（line 319），仅在 App 发送新消息时触发。

结果：`session.currentPermissionMode` 停留在 `'plan'`，keepAlive（每 2 秒）持续向 App 报告 `cliPermissionMode: 'plan'`。

### Gap 2: App 端 `applyMessages()` 只进入 plan 模式，不退出

`storage.ts` 的 `applyMessages()` 检测 `EnterPlanMode` 时设置 `session.permissionMode = 'plan'`；检测 `ExitPlanMode` 时仅设 `shouldEnterPlanMode = false`（防止历史重放重入），但**不主动恢复** `session.permissionMode` 为 `prePlanPermissionMode`。

### 修复方案（三层保障）

**Fix 1 (CLI)**: `claudeRemoteLauncher.ts` — 在 `nextMessage()` 中每次调用 `permissionHandler.handleModeChange()` 后，同步调用 `session.onPermissionModeChange(mode.permissionMode)`，确保 keepAlive 立即报告正确模式。

**Fix 2 (App storage)**: `storage.ts` — `applyMessages()` 新增 `shouldExitPlanMode` 跟踪。当批量消息中 `ExitPlanMode` 是最终状态且 `session.permissionMode === 'plan'` 时，恢复为 `session.prePlanPermissionMode`。同步持久化。

**Fix 3 (App sync)**: `sync.ts` — `flushActivityUpdates()` 中新增调和逻辑：当 CLI 通过 keepAlive 报告非 plan 模式，但 App 本地仍为 `'plan'` 时，自动调用 `updateSessionPermissionMode()` 同步为 CLI 报告的模式。这是兜底方案，覆盖 Fix 1/2 未覆盖的边缘情况。

**涉及文件**:
- CLI: `claudeRemoteLauncher.ts`（`nextMessage` 两处新增 `session.onPermissionModeChange()`）
- App: `storage.ts`（`applyMessages` 新增 `shouldExitPlanMode` + plan 退出逻辑 + 持久化）
- App: `sync.ts`（`flushActivityUpdates` 新增 plan 模式调和）

---

## 12. 滑动到底部按钮 + 加载最新消息

**问题**: 会话聊天列表没有快速返回底部（最新消息）的功能。用户向上滚动查看历史后，无法一键跳回最新内容。

**修复**: 在输入框操作栏中添加「滑动到底部」按钮（down-arrow 图标），点击后加载最新 20 条消息（合并到缓存），并滚动到底部。

**实现细节**:

1. **Sync 层** (`sync.ts`): 新增 `loadLatestMessages(sessionId, count)` 公共方法。使用 `before_seq=999999999&limit=count` 获取最新 N 条消息，经过 decrypt → normalize → `applyMessages` 合并到 store（id 去重安全），同步缓存到 `messageCache`，更新 `sessionLastSeq`。

2. **ChatList 重构** (`ChatList.tsx`): 导出 `ChatListHandle` 类型。`ChatList` 和 `ChatListInternal` 改为 `forwardRef` 模式，FlatList 添加 ref。通过 `useImperativeHandle` 暴露 `scrollToBottom()` 方法（调用 `scrollToOffset({ offset: 0, animated: true })`，因为列表是 inverted 的，offset 0 即视觉底部）。

3. **SessionView 接线** (`SessionView.tsx`): 创建 `chatListRef`，传递给 `ChatList`。创建 `handleScrollToBottom` 回调：await `sync.loadLatestMessages(sessionId, 20)` 然后 `chatListRef.current?.scrollToBottom()`。传递 `onScrollToBottom` prop 给 `AgentInput`。

4. **按钮 UI** (`AgentInput.tsx`): 新增 `onScrollToBottom` prop 和 `ScrollToBottomButton` 组件。按钮位于 GitStatusButton 之后、Send 按钮之前。32px 高度、pill 形状，匹配现有按钮样式。加载中显示 ActivityIndicator。

**涉及文件**:
- App: `sync.ts`（新增 `loadLatestMessages` 方法）
- App: `ChatList.tsx`（`forwardRef` + `scrollToBottom` imperative handle）
- App: `SessionView.tsx`（接线 ref + 回调）
- App: `AgentInput.tsx`（新增 `onScrollToBottom` prop + `ScrollToBottomButton` 组件）

---

## 13. APK 更新编译与安装流程

**问题**: cuz 分支的所有功能修改（状态栏、plan 同步、scroll-to-bottom、重启 fallback、stdin 守卫等）需要编译为 APK 并部署到真机验证。需要明确 prod-cuz 变体的完整构建链路。

**构建流程**:

### Step 1: Prebuild（生成 Android 原生目录）

```bash
cd packages/happy-app
APP_ENV=prod-cuz yarn expo prebuild --platform android --clean
```

- `--clean` 清除旧的 android 目录后重新生成，确保变体配置一致
- `APP_ENV=prod-cuz` 选择 prod-cuz 变体（bundle ID `com.c1tas.happycuz`，app name `HappyCUZ`）
- 输出：`packages/happy-app/android/` 原生工程目录

### Step 2: Gradle assembleRelease（编译 APK）

```bash
cd packages/happy-app/android
./gradlew assembleRelease -PreactNativeArchitectures=arm64-v8a
```

- `-PreactNativeArchitectures=arm64-v8a` 仅编译 arm64，减少体积（~108MB vs ~180MB 全架构）
- 编译时间约 8 分钟（首次，后续增量更快）
- 输出：`packages/happy-app/android/app/build/outputs/apk/release/app-release.apk`

### Step 3: ADB 安装

```bash
adb install -r packages/happy-app/android/app/build/outputs/apk/release/app-release.apk
```

- `-r` 覆盖安装，保留用户数据
- 支持 USB 或无线 ADB（`adb connect <ip>:5555`）

**注意事项**:
- Step 1 和 Step 2 必须顺序执行（prebuild 生成 android 目录后才能 gradle 编译）
- 切换变体时（如 dev → prod-cuz），必须重新 `prebuild --clean`，原生目录是变体专属的
- Release APK 使用 debug keystore 签名（非生产签名）
- 服务端部署（`deploy-server.sh`）与 APK 编译相互独立，可并行执行

---

## 14. Session Resume 任务重放修复（lastSeq 初始化 + drain 模式）

**问题**: 通过 `happy claude --resume claude_session_id`（本地 CLI 或 daemon）重启会话时，服务端尚未下发的历史消息被重新拉取并执行。CLI 自动进入 remote 控制模式，重复执行已完成的任务。

**根因**: `ApiSessionClient` 构造函数将 `lastSeq` 硬编码为 `0`（`apiSession.ts:100`），忽略 `Session` 类型中已携带的 `seq` 值。重连时 `fetchMessages(after_seq=0)` 拉取全部历史消息，UserMessage 路由到 `MessageQueue2`，触发 Claude 重新执行。同时 `claudeLocalLauncher.ts:99` 检测到队列非空后自动切换至 remote 模式。

**修复（三层保障）**:

1. **lastSeq 初始化**（`apiSession.ts`）: `lastSeq = session.seq`，仅拉取 seq > session.seq 的新消息。
2. **Drain 模式**（`apiSession.ts`）: 新增 `setDrainMode()` / `drainAndReady()` 方法。resume/reconnect 时启用 drain，`routeIncomingMessage()` 中 UserMessage 被记录日志后丢弃，不投递到回调或缓冲区。
3. **Queue 重置**（`runClaude.ts`）: drain 结束后调用 `messageQueue.reset()` 清空残留消息，防止 auto-switch 到 remote 模式。

**涉及文件**:
- CLI: `apiSession.ts`（lastSeq 初始化 + drain 模式逻辑）
- CLI: `runClaude.ts`（resume 场景下启用 drain、结束 drain、重置队列、退出前暂停 stdin）

---

## 15. PTY/Ink 双光标修复（Phase 2 — stdin/stdout 生命周期）

**问题**: Section 9 的 stdin 守卫仅解决了 remote→local 切换时的 raw-mode 冲突。但以下场景仍存在双光标、双会话感、C-d 需两次退出的问题：

1. **stdin 在子进程退出后无条件 resume**（`claudeLocal.ts:399`）: Claude Code 退出后 `process.stdin.resume()` 使 stdin 进入流式状态，但 `runClaude.ts` 的异步清理（flush、close）尚未完成，导致终端显示光标，用户感觉 "另一个会话" 仍在运行。
2. **模式切换间隙 stdin 无 handler**：Ink unmount 后到 `claudeLocal.ts:189` 调用 `stdin.pause()` 之间，stdin 处于 raw + flowing 状态，输入无接收方。
3. **Ink unmount 时 stdout cursor-show 写入未被拦截**：`cliCursor.show()` 在 alt screen 中写入 `\x1b[?25h`，导致双缓冲区都显示光标。
4. **Ink cleanup 排空时间不足**：`process.nextTick` 仅给一个微任务周期，Ink React unmount 涉及多轮异步。

**修复**:
- **`claudeLocal.ts`**: 移除 finally 中的无条件 `process.stdin.resume()`，改由调用方管理 stdin 生命周期。
- **`claudeRemoteLauncher.ts`**: switch 路径中 drain stdin buffer 后立即 `process.stdin.pause()`；stdin 守卫同时 monkey-patch `process.stdout.write` 拦截 cursor-show 序列；cleanup drain 时间从 `process.nextTick` 改为 `setTimeout(50ms)`。
- **`loop.ts`**: remote→local 切换前显式 `process.stdin.pause()`，确保 local launcher 接管时 stdin 处于已暂停状态。
- **`runClaude.ts`**: loop 退出后、异步清理前立即 `process.stdin.pause()` + `setRawMode(false)`，消除 "第二层退出" 感。

**涉及文件**:
- CLI: `claudeLocal.ts`（移除 finally 中 stdin.resume）
- CLI: `claudeRemoteLauncher.ts`（stdin pause + stdout guard + 50ms drain）
- CLI: `loop.ts`（切换前 stdin.pause）
- CLI: `runClaude.ts`（退出前 stdin 静默）

**调试方法**:
```bash
HAPPY_TERMINAL_DEBUG=1 ./bin/happy.mjs daemon start
# 查看 /tmp/happy-terminal-debug-{pid}.log
# 预期新增日志:
#   "suppressed cursor-show write during Ink unmount"
#   "stdin + stdout guards removed"
```

---

## 16. Web App 页面加载性能分析与 nginx 优化

**问题**: 部署到 `https://happy-web.sg.c1tas.pw` 的 Expo Web 应用页面加载极慢（>2 分钟超时），浏览器报 `net::ERR_HTTP2_PROTOCOL_ERROR`，页面始终白屏。

**分析工具**: Playwright CDP 级性能分析脚本 `test-results/perf-audit.mjs`，收集 Performance Timing API、CDP 网络瀑布图、JS/CSS Coverage、Chrome Performance Trace。

### 根因分析

**根因 1（致命）: nginx `gzip_types` 未启用**

nginx 全局配置中 `gzip on;` 已开启，但 `gzip_types` 行被注释。默认 nginx 仅压缩 `text/html`。导致：
- `index-*.js`（7.5 MB）和 `__common-*.js`（2.5 MB）以原始大小传输
- 10+ MB 未压缩 JS 通过 HTTP/2 下载，触发协议错误 `net::ERR_HTTP2_PROTOCOL_ERROR`
- Chromium 在 132 秒后放弃下载，页面永远白屏

**根因 2: 无缓存控制头**

所有静态资源（hash-named JS/CSS/字体/图片）未设置 `Cache-Control` 或 `expires`，每次访问重新下载全部资源。

**根因 3: JS Bundle 体积**

| Bundle | 原始大小 | gzip 后 | 压缩率 |
|--------|---------|---------|--------|
| `index-*.js` | 7.47 MB | 1.90 MB | 75% |
| `__common-*.js` | 2.47 MB | 594 KB | 76% |
| `canvaskit.wasm` | 7.7 MB | 未加载 | - |
| **JS 合计** | **9.94 MB** | **2.48 MB** | **75%** |

JS Coverage 显示初始加载仅使用 69% 代码（30.7% = 7.5 MB 未使用）。

### 修复

**nginx 配置更新**（`deploy-webapp.sh` + 远程应用）:

```nginx
# gzip 压缩
gzip on;
gzip_vary on;
gzip_proxied any;
gzip_comp_level 6;
gzip_min_length 256;
gzip_types text/plain text/css text/javascript application/javascript
           application/json application/wasm application/xml image/svg+xml;
gzip_static on;

# 传输优化
sendfile on;
tcp_nopush on;
tcp_nodelay on;

# hash-named 静态资源长缓存（1 年，immutable）
location /_expo/ {
    expires 1y;
    add_header Cache-Control "public, immutable";
}

# SPA 入口不缓存
location / {
    add_header Cache-Control "no-cache";
}
```

### 修复前后对比

| 指标 | 修复前 | 修复后 | 改善 |
|------|--------|--------|------|
| DOM Content Loaded | >120s（超时） | **1.75s** | **68x** |
| FCP | N/A（白屏） | **2.51s** | 可用 |
| Network Idle | 不可达 | **3.88s** | 可用 |
| 总传输量 | 5.2 KB（失败） | **4.24 MB** | 完整加载 |
| Console Errors | 1（h2 协议错误） | **0** | 清零 |
| 压缩率 | 0%（未压缩） | **63.7%** | - |

### 进一步优化方向（未实施）

1. **Bundle 分割**: `index.js` 包含 30% 未使用代码（5 MB），可通过 Expo Router lazy import 拆分
2. **字体子集化**: 11 个字体文件共 1.74 MB，大部分字符未使用
3. **`canvaskit.wasm` 延迟加载**: 7.7 MB Skia WASM 当前仅在使用图表时才懒加载，但仍可预压缩为 `.wasm.gz`
4. **预压缩**: 构建时生成 `.gz` 文件配合 `gzip_static on;`，避免运行时压缩开销
5. **V8 编译**: 1.22s 用于 JS 编译解析，可通过 Code Splitting 减少初始编译量

**涉及文件**:
- 部署: `deploy-webapp.sh`（nginx 配置模板更新）
- 工具: `test-results/perf-audit.mjs`（Playwright CDP 性能分析脚本）

---

## 17. Local Auth — CLI 本地密钥生成

**问题**: CLI 认证仅支持两种方式：手机 App 扫码（Mobile）和浏览器登录（Web），均依赖外部设备或浏览器。在纯终端环境（服务器、容器、SSH）中不便使用。

**修复**: 新增第三种认证方式 "Local Key"，完全在本地完成账号创建：

1. CLI 生成 32 字节随机密钥（Ed25519 seed）
2. 通过 `authGetToken(secret)` 向服务端 `POST /v1/auth` 发起 challenge-response 认证
3. 服务端根据 Ed25519 公钥 upsert Account，返回 token
4. 本地存储 legacy credentials（`writeCredentialsLegacy`）
5. 使用 `formatSecretKeyForBackup()` 将密钥格式化为 Base32 `XXXXX-XXXXX-...` 格式显示给用户

用户保存此 backup key 后，可在任意设备/Web App 通过 "Restore" 功能恢复账号（App 端 `restore/manual.tsx` 已支持）。

**无需服务端修改**: `POST /v1/auth` 已原生支持 Ed25519 challenge-response + Account upsert。

**涉及文件**:
- CLI: `ui/ink/AuthSelector.tsx`（新增 `'local'` 选项，`AuthMethod` 类型扩展）
- CLI: `ui/auth.ts`（新增 `doLocalAuth()` 函数，`doAuth()` 重构为 local 短路）

---

## 文档索引（更新）

| 文档 | 内容 |
|------|------|
| [error-handling-and-resume-fallback.md](./error-handling-and-resume-fallback.md) | 错误分类、事件流、resume fallback 完整实现 |
| [session-restart-implementation.md](./session-restart-implementation.md) | 三栈重启流程 + resume fallback 章节 |
| [cross-stack-patterns.md](./cross-stack-patterns.md) | 跨栈特性实现模式（ephemeral/persistent 管道、HUD、压缩、错误事件） |
| [cuz-build.md](./cuz-build.md) | prod-cuz Android 构建指南与故障排除 |
| [cli-architecture.md](./cli-architecture.md) | CLI 架构、resume 菜单、remote 模式参数 |
| [permission-resolution.md](./permission-resolution.md) | 权限模式解析、yolo/plan 模式交互 |
| [yolo_problem.md](./yolo_problem.md) | Yolo 模式问题分析与修复状态 |
| [research/yolo-mode-investigation.md](./research/yolo-mode-investigation.md) | Yolo 模式根因调查 |
| *(Section 9, inline)* | Remote→Local 切换 Ink stdin 守卫，防止双光标和输入异常 |
| *(Section 14, inline)* | Session Resume 任务重放修复：lastSeq 初始化 + drain 模式 |
| *(Section 15, inline)* | PTY/Ink 双光标 Phase 2：stdin/stdout 生命周期管理 |
| *(Section 16, inline)* | Web App 页面加载性能：nginx gzip/缓存 + Playwright 分析工具 |
| *(Section 17, inline)* | Local Auth：CLI 本地密钥生成，无需 QR/URL 登录 |
