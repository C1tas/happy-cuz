# Yolo 模式 Plan 退出后未恢复问题

> **状态**: ✅ 已修复（`cuz` 分支，commit `6fc88a60`）

## 问题描述

在 Remote 模式下，如果会话以 Yolo 模式（`--dangerously-skip-permissions` / `bypassPermissions`）启动，当 Claude 自动进入 Plan 模式后，退出 Plan 模式时权限模式无法恢复为 Yolo，而是停留在 `plan` 模式，导致后续所有编辑操作都需要手动审批。

## 根因分析

### 涉及文件

| 文件 | 职责 |
|------|------|
| `packages/happy-cli/src/claude/utils/permissionHandler.ts` | 权限决策核心，管理 `permissionMode` 和 `prePlanMode` |
| `packages/happy-cli/src/claude/claudeRemoteLauncher.ts` | Remote 会话编排，消费消息队列、调用 `handleModeChange` |
| `packages/happy-cli/src/claude/runClaude.ts` | 入口，解析初始权限模式，构建带 mode hash 的消息队列 |

### 关键数据结构

```typescript
// permissionHandler.ts
class PermissionHandler {
    private permissionMode: PermissionMode = 'default';  // 当前生效的权限模式
    private prePlanMode: PermissionMode | null = null;    // plan 前保存的模式
}
```

### Bug 时序（修复前）

```
步骤 1: 会话以 yolo 启动
  → handleModeChange('bypassPermissions')
  → permissionMode = 'bypassPermissions'

步骤 2: App 发送 plan 模式消息
  → handleModeChange('plan')
  → permissionMode = 'plan'          ← 原始模式已被覆盖！

步骤 3: Claude 调用 ExitPlanMode
  → handleToolCall 中执行:
      if (this.prePlanMode === null) {
          this.prePlanMode = this.permissionMode;  ← 保存了 'plan' 而非 'bypassPermissions'
      }

步骤 4: 用户批准 Plan
  → handlePermissionResponse 中执行:
      restoredMode = this.prePlanMode ?? 'default'  ← 得到 'plan'
      this.permissionMode = restoredMode             ← 恢复成了 'plan'！
      queue.unshift(PLAN_FAKE_RESTART, { permissionMode: 'plan' })

步骤 5: Claude 重新启动
  → 以 plan 模式重新 spawn，所有编辑需要手动审批
```

**核心问题**：`prePlanMode` 的保存时机错误 — 在 `ExitPlanMode` 工具调用时保存，此时 `permissionMode` 已经被 `handleModeChange('plan')` 覆盖为 `'plan'`，丢失了原始的 `'bypassPermissions'`。

### 修复方案

将 `prePlanMode` 的保存从 `handleToolCall`（ExitPlanMode 时）移到 `handleModeChange`（进入 plan 时）：

**修改 1：`handleModeChange` — 进入 plan 时保存原始模式**

```typescript
// 修复前
handleModeChange(mode: PermissionMode) {
    this.permissionMode = mode;
}

// 修复后
handleModeChange(mode: PermissionMode) {
    if (mode === 'plan' && this.permissionMode !== 'plan' && this.prePlanMode === null) {
        this.prePlanMode = this.permissionMode;  // 在覆盖前保存
    }
    this.permissionMode = mode;
}
```

**修改 2：`handleToolCall` — 移除 ExitPlanMode 中的 prePlanMode 保存**

```typescript
// 修复前
if (descriptor.exitPlan) {
    if (this.prePlanMode === null) {
        this.prePlanMode = this.permissionMode;  // ← 此时已经是 'plan'，保存无意义
    }
    // ...
}

// 修复后
if (descriptor.exitPlan) {
    // prePlanMode 已在 handleModeChange 进入 plan 时保存，此处无需再存
    // ...
}
```

### 修复后时序

```
步骤 1: permissionMode = 'bypassPermissions'
步骤 2: handleModeChange('plan')
  → prePlanMode = 'bypassPermissions'  ← 在覆盖前保存！
  → permissionMode = 'plan'
步骤 3: ExitPlanMode 调用 — 无额外操作
步骤 4: Plan 批准
  → restoredMode = 'bypassPermissions' ← 正确恢复
  → queue.unshift(PLAN_FAKE_RESTART, { permissionMode: 'bypassPermissions' })
步骤 5: Claude 以 bypassPermissions 重新 spawn — yolo 模式恢复
```

## 相关机制说明

### Plan 模式退出流程

1. Claude SDK 进程调用 `ExitPlanMode` 工具
2. `handleToolCall` 将请求发送到手机 App 等待审批
3. 手机批准后 `handlePermissionResponse` 执行恢复逻辑：
   - 恢复 `permissionMode` 为 `prePlanMode`
   - 向队列头部注入 `PLAN_FAKE_RESTART` 消息（"PlEaZe Continue with plan."）
   - 对 Claude 返回 `deny`（`PLAN_FAKE_REJECT`），触发当前 SDK 进程退出
4. `claudeRemoteLauncher` 循环拾取 `PLAN_FAKE_RESTART`，以恢复的权限模式重新 spawn Claude
5. 新的 Claude 进程带 `--resume` 继续执行 plan

### `reset()` 与 `permissionMode` 的关系

`reset()` 在每次 `claudeRemote` 退出后调用，清除 `prePlanMode`、`allowedTools`、`pendingRequests` 等，但**不清除** `permissionMode`。这是预期行为 — 权限模式在同一会话内跨 spawn 保持不变。

### `unshift` 的 partial EnhancedMode

`queue.unshift(PLAN_FAKE_RESTART, { permissionMode: restoredMode })` 传递了不完整的 `EnhancedMode`（缺少 `model`、`fallbackModel` 等字段）。这会导致 mode hash 变化，但这是预期的 — hash 变化正是触发 `claudeRemote` 退出并重新 spawn 的机制。
