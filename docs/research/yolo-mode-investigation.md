# Yolo 模式无法保持问题调查报告

## 问题描述

在 Web 端切换 Claude 为 yolo 模式后，多轮对话中无法保持自动批准状态，工具调用仍需反复确认。即使从 Web 端多次切换 yolo 模式也无法生效。

---

## 根因分析

### 根因 1：模式哈希仅检查 `isPlan`，不包含完整 `permissionMode`

**文件**: `packages/happy-cli/src/claude/runClaude.ts:247-255`

```typescript
const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
    isPlan: mode.permissionMode === 'plan',
    model: mode.model,
    fallbackModel: mode.fallbackModel,
    customSystemPrompt: mode.customSystemPrompt,
    appendSystemPrompt: mode.appendSystemPrompt,
    allowedTools: mode.allowedTools,
    disallowedTools: mode.disallowedTools
}));
```

哈希计算中 `permissionMode` 被降级为布尔值 `isPlan`，只有 `plan` 模式会改变哈希值。以下模式切换产生**相同的哈希**，不会触发 Claude SDK 会话重启：

| 从 | 到 | 哈希变化 | 会话重启 |
|---|---|---|---|
| `default` | `yolo` | 否 | **否** |
| `default` | `bypassPermissions` | 否 | **否** |
| `default` | `acceptEdits` | 否 | **否** |
| `default` | `plan` | **是** | **是** |
| `yolo` | `default` | 否 | **否** |

**后果**：在已运行的 SDK 会话中切换到 yolo 模式，Claude 进程仍以旧的 `--permission-mode default` 运行，Claude 自身仍会发送权限请求。

---

### 根因 2：PermissionHandler 不识别 `yolo` 模式

**文件**: `packages/happy-cli/src/claude/utils/permissionHandler.ts:159-161`

```typescript
// 自动批准逻辑
if (this.permissionMode === 'bypassPermissions') {
    return { decision: 'approved' };
}
```

`handleToolCall()` 的自动批准只检查 `=== 'bypassPermissions'`，**不检查 `'yolo'` 或 `'safe-yolo'`**。

尽管 `handleModeChange('yolo')` 会更新 `this.permissionMode = 'yolo'`，但后续工具调用走不到自动批准分支，仍会发送权限请求到 Web 端。

---

### 根因 3：`yolo` → `bypassPermissions` 映射仅在 SDK 启动时生效

**文件**: `packages/happy-cli/src/claude/utils/permissionMode.ts:19-26`

```typescript
export function mapToClaudeMode(mode: PermissionMode): ClaudeSdkPermissionMode {
    const codexToClaudeMap: Record<string, ClaudeSdkPermissionMode> = {
        'yolo': 'bypassPermissions',
        'safe-yolo': 'default',
        'read-only': 'default',
    };
    return codexToClaudeMap[mode] ?? (mode as ClaudeSdkPermissionMode);
}
```

`mapToClaudeMode()` 仅在 `claudeRemote.ts:120` 的 SDK 启动配置中被调用：

```typescript
const sdkOptions: QueryOptions = {
    permissionMode: mapToClaudeMode(initial.mode.permissionMode),  // 仅启动时
    ...
}
```

一旦 Claude 进程启动，`--permission-mode` 已经固定。运行中修改不会影响已启动的进程。

---

### 根因 4：permissionMode 不在 agentState 中持久化

**文件**: `packages/happy-cli/src/api/apiSession.ts` — `AgentState` 类型定义

```typescript
export type AgentState = {
    controlledByUser?: boolean | null;
    requests?: { ... };
    completedRequests?: { ... };
    // 注意：没有 permissionMode 字段
}
```

`permissionMode` 仅存储在 Web 端的 Zustand 本地存储中（`packages/happy-app/sources/sync/storage.ts:840-869`），不随 agentState 同步到服务器。每次消息通过 `meta.permissionMode` 传递，但如果 Web 端本地存储丢失或刷新，模式信息不会从服务器恢复。

---

## 完整数据流追踪

### 用户切换 yolo 模式后的消息流

```
Web App: 用户点击模式选择器 → yolo
  ↓
storage.updateSessionPermissionMode(sessionId, 'yolo')
  ↓ (本地存储更新，不同步到服务器)
  ↓
用户发送消息 → sync.sendMessage()
  ↓
resolveMessageModeMeta() → { permissionMode: 'yolo' }
  ↓
消息 meta 中嵌入 permissionMode: 'yolo'，加密发送到服务器
  ↓
CLI: session.onUserMessage() 接收消息
  ↓
提取 meta.permissionMode = 'yolo'
  ↓
currentPermissionMode = 'yolo'
  ↓
构建 EnhancedMode { permissionMode: 'yolo', ... }
  ↓
MessageQueue2.push(text, enhancedMode)
  ↓
计算哈希: hashObject({ isPlan: false, ... }) ← 与之前相同！
  ↓
nextMessage() 返回消息（无会话重启）
  ↓
permissionHandler.handleModeChange('yolo')  ← 内部状态更新
  ↓
Claude 请求工具权限 → SDK 发送 control_request(can_use_tool)
  ↓
PermissionHandler.handleToolCall()
  ↓
检查: this.permissionMode === 'bypassPermissions'? → 'yolo' !== 'bypassPermissions' → false
  ↓
不自动批准 → 发送权限请求到 Web 端 ← 用户需再次确认！
```

### 如果哈希变化（如切换到 plan 模式）

```
nextMessage() 检测到哈希变化
  ↓
返回 null（结束当前 SDK 会话）
  ↓
claudeRemoteLauncher 重新循环
  ↓
新的 claudeRemote() 启动，使用 mapToClaudeMode('yolo') = 'bypassPermissions'
  ↓
Claude 以 --permission-mode bypassPermissions 启动 ← 自动批准生效
```

---

## 模式兼容性矩阵

| 模式 | Claude SDK 识别 | mapToClaudeMode 结果 | PermissionHandler 自动批准 | 修复后自动批准 | 需要重启才生效 |
|---|---|---|---|---|---|
| `default` | 是 | `default` | 否 | 否 | - |
| `acceptEdits` | 是 | `acceptEdits` | 部分（仅编辑类工具） | 部分（仅编辑类工具） | 是 |
| `bypassPermissions` | 是 | `bypassPermissions` | 是 | 是 | 是 |
| `plan` | 是 | `plan` | 否 | 否 | 是（哈希变化自动重启） |
| `yolo` | **否** | `bypassPermissions` | **否**（已修复） | **是** | 是（修复后哈希变化会重启） |
| `safe-yolo` | **否** | `default` | **否**（已修复） | **是**（非编辑类工具） | 是（修复后哈希变化会重启） |
| `read-only` | **否** | `default` | 否 | 否 | 是（但映射为 default，无实际效果） |

---

## 修复方案（已实施：方案 C）

### 方案 A：修复哈希计算 ✅ 已实施

**改动文件**: `packages/happy-cli/src/claude/runClaude.ts:247`

将 `isPlan` 替换为完整的 `permissionMode`：

```typescript
// 修改前
const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
    isPlan: mode.permissionMode === 'plan',
    ...
}));

// 修改后
const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
    permissionMode: mode.permissionMode,
    ...
}));
```

**效果**：任何 `permissionMode` 变化都会导致哈希变化，触发 SDK 会话重启，新会话以 `mapToClaudeMode()` 映射后的模式启动。

**代价**：模式切换时会中断当前对话流（SDK 重启），Claude 需要重新加载上下文。

### 方案 B：修复 PermissionHandler 的模式检查 ✅ 已实施

**改动文件**: `packages/happy-cli/src/claude/utils/permissionHandler.ts:159`

```typescript
// 修改前
if (this.permissionMode === 'bypassPermissions') {
    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
}

// 修改后
if (this.permissionMode === 'bypassPermissions' || this.permissionMode === 'yolo') {
    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
}

if (this.permissionMode === 'safe-yolo' && !descriptor.edit) {
    return { behavior: 'allow', updatedInput: input as Record<string, unknown> };
}
```

- `yolo`：等同于 `bypassPermissions`，全部自动批准
- `safe-yolo`：只自动批准非编辑类工具（读取、bash 等），编辑类（Edit/Write/MultiEdit/NotebookEdit）仍需确认

### 方案 C：A + B 组合 ✅ 已实施

同时修复哈希计算和 PermissionHandler，双重保障：
1. 模式切换始终触发会话重启（SDK 层面生效）
2. 运行中如果因任何原因未重启，PermissionHandler 也能正确处理

---

## 补充问题：Web 端模式状态不同步

`permissionMode` 仅存储在客户端本地（Zustand + localStorage），不随 `agentState` 同步到服务器。以下场景会导致模式丢失：

1. 用户刷新浏览器页面 → Zustand 重新初始化 → `resolveMessageModeMeta()` 读取 localStorage 中的保存值
2. 多设备访问同一会话 → 各设备有独立的本地模式状态
3. 会话从 CLI 本地模式启动后再切换到远程 → CLI 初始模式可能与 Web 端不同

**建议**：将 `permissionMode` 加入 `agentState`，通过服务器的 OCC 机制同步。

---

## 关键文件索引

| 文件 | 行号 | 作用 | 状态 |
|---|---|---|---|
| `packages/happy-cli/src/claude/runClaude.ts` | 247 | 哈希计算 | ✅ 已修复 |
| `packages/happy-cli/src/claude/utils/permissionHandler.ts` | 159 | 自动批准检查 | ✅ 已修复 |
| `packages/happy-cli/src/claude/utils/permissionMode.ts` | 19-26 | `mapToClaudeMode()` 映射 | 无需修改 |
| `packages/happy-cli/src/claude/claudeRemote.ts` | 115-134 | SDK 启动时应用模式 |
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | 346-377 | 哈希变化检测与重启逻辑 |
| `packages/happy-app/sources/sync/storage.ts` | 840-869 | Web 端模式本地存储 |
| `packages/happy-app/sources/sync/messageMeta.ts` | 9-25 | 消息 meta 中嵌入模式 |
| `packages/happy-wire/src/messageMeta.ts` | 5 | Wire 协议模式 Schema |
| `packages/happy-cli/src/api/types.ts` | 35 | 完整模式类型定义 |
