# Happy 项目开发工作日志

## 2026-04-10 — 架构分析、Web 开发环境搭建、Yolo 模式修复

### 一、项目架构深度分析

对 Happy 项目（6 包 monorepo）进行了完整架构梳理，产出文档：

- **`docs/structure.md`** — 项目架构分析
  - Relay Server 三层 Socket.IO 连接模型（session/machine/user-scoped）
  - EventRouter 核心中继引擎与 RecipientFilter 路由
  - 双序号机制（userSeq 全局排序 + sessionSeq 会话排序）
  - E2E 加密体系：NaCl SecretBox + NaCl Box 密钥包装 + AES-256-GCM 内容加密
  - HMAC-SHA512 KeyTree 密钥派生
  - 本地 Claude 模式：monkey-patch `global.fetch` + JSONL 文件监视
  - 远程 Claude 模式：SDK 驱动 `--output-format stream-json --input-format stream-json`

- **`docs/research/web-dev-and-tool-views.md`** — Web 开发与工具视图调研
  - 3 种 Web 启动方式及环境变量配置
  - 远程项目可视化方案分析
  - 工具视图扩展架构（knownTools → toolViewRegistry → toolFullViewRegistry）
  - 4 种扩展方案 Demo 代码

### 二、Web 开发环境搭建

#### 修复的问题

1. **`hmac_sha512.web.ts` — Web 端加密不可用**
   - `expo-crypto` 的 `Crypto.digest` 在 Web 平台不存在
   - 首次修复使用 `crypto.subtle`（Web Crypto API），但在非 HTTPS 源（http://192.168.x.x）下 `crypto.subtle` 为 `undefined`
   - 最终方案：使用 `@noble/hashes`（纯 JS 实现，无 Web Crypto 依赖）
   - 文件：`packages/happy-app/sources/encryption/hmac_sha512.web.ts`

2. **`EXPO_PUBLIC_LOG_SERVER_URL` 连接拒绝**
   - `env.sh` 默认设置 `http://localhost:8787`，但无 log server 运行
   - 修复：`restart.sh` 中 `export EXPO_PUBLIC_LOG_SERVER_URL=""`

3. **WSL2 网络隔离**
   - Windows 浏览器无法访问 WSL 的 `localhost`
   - 修复：自动检测 WSL IP（`ip addr show eth0`），覆盖所有 `EXPO_PUBLIC_*_URL`

#### 创建的工具

- **`restart.sh`** — 一键重启开发环境脚本
  - `--reset`：全量重置（删除所有环境数据，重新创建）
  - `--no-seed`：跳过 auth 种子
  - `--logs`：启动后 tail 日志
  - WSL 自动检测与 IP 覆盖
  - 端口占用检测与清理
  - 独立启动 server + web，带健康检查
  - Metro `--clear` 清除缓存

### 三、品牌定制

- 首页描述文字修改为"CUZ 构建的 Codex 和 Claude Code 移动客户端"
- 文件：`packages/happy-app/sources/text/_default.ts:711`
- 文件：`packages/happy-app/sources/text/translations/zh-Hans.ts:713`

### 四、Yolo 模式无法保持 — 根因分析与修复

#### 问题

Web 端切换 Claude 为 yolo 模式后，多轮对话中工具调用仍需反复确认。

#### 4 个根因

| # | 根因 | 文件 | 行号 |
|---|---|---|---|
| 1 | 哈希计算仅用 `isPlan` 布尔值，`yolo` 模式切换不改变哈希，不触发 SDK 会话重启 | `runClaude.ts` | 247 |
| 2 | PermissionHandler 自动批准仅检查 `=== 'bypassPermissions'`，不识别 `yolo` | `permissionHandler.ts` | 159 |
| 3 | `mapToClaudeMode('yolo')→'bypassPermissions'` 映射仅在 SDK 启动时调用 | `claudeRemote.ts` | 120 |
| 4 | `permissionMode` 不在 `agentState` 中持久化，多设备/刷新后丢失 | `apiSession.ts` | — |

#### 实施的修复（方案 C：组合修复）

**修复 A — 哈希计算**（`packages/happy-cli/src/claude/runClaude.ts:248`）

```diff
- isPlan: mode.permissionMode === 'plan',
+ permissionMode: mode.permissionMode,
```

效果：任何 `permissionMode` 变化都改变哈希，触发 SDK 会话重启，新会话以 `mapToClaudeMode()` 映射后的模式启动。

**修复 B — PermissionHandler 模式识别**（`packages/happy-cli/src/claude/utils/permissionHandler.ts:159`）

```diff
  if (this.permissionMode === 'bypassPermissions') {
      return { behavior: 'allow', updatedInput: input };
  }
+ if (this.permissionMode === 'yolo') {
+     return { behavior: 'allow', updatedInput: input };
+ }
+ if (this.permissionMode === 'safe-yolo' && !descriptor.edit) {
+     return { behavior: 'allow', updatedInput: input };
+ }
```

- `yolo`：等同于 `bypassPermissions`，全部自动批准
- `safe-yolo`：仅自动批准非编辑类工具，编辑类（Edit/Write/MultiEdit/NotebookEdit）仍需确认

双重保障：即使会话未重启，运行中的 PermissionHandler 也能正确处理。

#### 修复后模式兼容性

| 模式 | SDK 重启 | PermissionHandler 自动批准 |
|---|---|---|
| `yolo` | 哈希变化→重启→`bypassPermissions` | 全部批准 |
| `safe-yolo` | 哈希变化→重启→`default` | 非编辑类批准 |
| `default` | — | 需确认 |
| `plan` | 哈希变化→重启 | 需确认 |

#### 未修复项

- 根因 4（`permissionMode` 未持久化到 `agentState`）尚未实施，需同步修改 wire 协议和前后端类型

#### 相关文档

- **`docs/research/yolo-mode-investigation.md`** — 完整调查报告（含数据流追踪、4 根因分析、修复方案，已标记 ✅ 已实施）

### 五、当前环境状态

- 环境：`plush-maple`
- Server：`http://192.168.58.1:46653`
- Web：`http://192.168.58.1:41837`
- 运行中，HTTP 200，无 JS 错误
- 停止：`yarn env:down` 或 `./restart.sh`

### 六、未提交的文件

```
M   Dockerfile.server
M   yarn.lock
M   packages/happy-cli/src/claude/runClaude.ts          # yolo 哈希修复
M   packages/happy-cli/src/claude/utils/permissionHandler.ts  # yolo/safe-yolo 自动批准
??  docker-compose.yml
??  docs/local-build.md
??  docs/structure.md
??  docs/research/yolo-mode-investigation.md
??  docs/research/web-dev-and-tool-views.md
??  restart.sh
??  docs/changelog.md                                     # 本文件
```
