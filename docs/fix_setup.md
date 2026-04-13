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
