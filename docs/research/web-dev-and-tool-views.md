# 本地 Web 应用构建与工具视图扩展指南

## 一、本地启动 Web 应用

### 1.1 前置条件

- Node.js 18+
- Yarn 1 (Classic)
- 操作系统：macOS / Linux / WSL2

### 1.2 方式 A：一键启动（推荐）

使用内置环境管理器，一条命令创建完整本地环境（后端 + Web + 认证）：

```bash
cd /home/administrator/happy

# 安装依赖
yarn install

# 一键启动：创建环境 + 启动服务 + 认证
yarn env:up:authenticated
```

输出示例：
```
Environment "clever-ocean" is up!
  Server: http://localhost:31234
  Web:    http://localhost:31235
  Open:   http://localhost:31235/?dev_token=xxx&dev_secret=xxx
```

在浏览器中打开 `Open` URL 即可，URL 参数中已包含认证凭据。

### 1.3 方式 B：手动分步启动

如果需要更多控制：

```bash
cd /home/administrator/happy

# 1. 安装依赖
yarn install

# 2. 构建 happy-wire（Web 应用依赖此包）
yarn workspace @slopus/happy-wire build

# 3. 创建环境（不自动启动）
yarn env:new

# 4. 启动后端服务
yarn env:server

# 5. 在另一个终端：种子认证
yarn env:seed

# 6. 在另一个终端：启动 Web 应用
yarn env:web
```

查看当前环境信息：`yarn env:current`

### 1.4 方式 C：仅 Web 应用（连接生产服务器）

```bash
cd /home/administrator/happy
yarn install
yarn workspace @slopus/happy-wire build

# 指向生产服务器
export EXPO_PUBLIC_HAPPY_SERVER_URL="https://api.cluster-fluster.com"

# 启动 Web 应用
cd packages/happy-app && yarn web
```

访问 `http://localhost:8081`。注意：此方式无法自动认证，需要手动输入凭据。

### 1.5 环境管理命令速查

| 命令 | 用途 |
|---|---|
| `yarn env:new` | 创建新环境 |
| `yarn env:up:authenticated` | 一键创建+启动+认证 |
| `yarn env:server` | 启动后端 |
| `yarn env:web` | 启动 Web 应用 |
| `yarn env:seed` | 种子认证凭据 |
| `yarn env:current` | 查看当前环境 |
| `yarn env:cli` | 在当前环境中运行 CLI |
| `yarn env:down` | 停止环境 |
| `yarn env:list` | 列出所有环境 |

### 1.6 环境变量说明

| 变量 | 用途 | 生产默认值 |
|---|---|---|
| `EXPO_PUBLIC_HAPPY_SERVER_URL` | 后端服务器地址 | `https://api.cluster-fluster.com` |
| `EXPO_PUBLIC_DEV_TOKEN` | 开发认证 Token | 无 |
| `EXPO_PUBLIC_DEV_SECRET` | 开发认证密钥 | 无 |
| `APP_ENV` | 环境变体 | `development` |

### 1.7 Web 认证机制

Web 应用支持三种认证方式：

1. **URL 参数**（推荐）：`?dev_token=xxx&dev_secret=xxx`，应用读取后存入 localStorage 并清除 URL
2. **环境变量**：设置 `EXPO_PUBLIC_DEV_TOKEN` + `EXPO_PUBLIC_DEV_SECRET`，开发模式自动认证
3. **QR 码扫描**：仅原生端可用（需要相机）

凭据存储：Web 端使用 `localStorage`（key: `auth_credentials`），原生端使用 `expo-secure-store`。

### 1.8 Web 平台兼容性

以下原生模块在 Web 端有专门适配（`.web.tsx` / `.web.ts` 后缀）：

| 原生模块 | Web 适配 |
|---|---|
| `@more-tech/react-native-libsodium` | `libsodium-wrappers` (纯 JS) |
| `react-native-quick-base64` | 浏览器 `atob`/`btoa` |
| `@livekit/react-native` | `@elevenlabs/react` (WebRTC) |
| `react-native-purchases` | `@revenuecat/purchases-js` |
| `@shopify/react-native-skia` | WASM 版本 |
| `expo-secure-store` | `localStorage` |
| `expo-camera` / QR 扫描 | Web 不可用 |

---

## 二、远程项目的本地可视化与 CLI 切换

### 2.1 远程会话创建流程

当用户从手机 App 创建一个远程会话时，完整链路如下：

```
手机 App 调用 machineRPC('spawn-happy-session', {directory, agent})
  → Server 通过 Socket.IO 转发到守护进程
  → 守护进程 spawnSession():
      1. 创建工作目录（需要审批流程）
      2. 解析认证 Token 为环境变量
      3. 选择 spawn 方式：tmux（如果可用）或 detached process
      4. 执行: node ... index.mjs <agent> --happy-starting-mode remote --started-by daemon
  → 新进程自报给守护进程 /session-started
  → 守护进程解析 awaiter → 返回 sessionId 给手机
```

### 2.2 本地可视化远程会话

**当前支持的观察方式**：

| 方式 | 命令/路径 | 说明 |
|---|---|---|
| tmux attach | `tmux attach -t <session>` | 仅当 tmux 可用且 `TMUX_SESSION_NAME` 已配置 |
| 守护进程列表 | `happy daemon list` | 显示 startedBy, happySessionId, pid |
| 守护进程状态 | `happy doctor` | 显示所有 Happy 进程 |
| 日志文件 | `happy daemon logs` | 查看守护进程日志路径 |
| 手机 App | 实时 WebSocket | 完整的实时消息流 |
| Web 应用 | 本地启动后访问 | 完整的实时消息流（推荐） |

**注意**：当前**没有** `happy attach` 命令可以直接将本地终端附加到正在运行的远程会话。

### 2.3 切换到本地 CLI 控制

**模式切换机制**（`packages/happy-cli/src/claude/loop.ts`）：

```
while(true) {
  if mode === 'local': claudeLocalLauncher()
  if mode === 'remote': claudeRemoteLauncher()
  // 返回 'switch' 时切换模式
}
```

**触发切换的方式**：

| 方向 | 触发方式 |
|---|---|
| Local → Remote | 手机发消息（自动切换）、手机发送 `switch` RPC |
| Remote → Local | TUI 中双击空格、手机发送 `switch` RPC |

**远程会话切换到本地**的步骤：

1. 如果会话运行在 tmux 中：`tmux attach -t <session>`，然后双击空格
2. 如果没有 TTY（daemon detached 模式）：当前无法直接切换，需要通过手机 App 发送 `switch` RPC

### 2.4 守护进程 HTTP 控制接口

守护进程启动后监听 `127.0.0.1:<random-port>`，端口记录在 `~/.happy/daemon.state.json`。

| 端点 | 方法 | 用途 |
|---|---|---|
| `/session-started` | POST | 会话自报 webhook |
| `/list` | POST | 列出追踪的会话 |
| `/stop-session` | POST | 停止指定会话 |
| `/spawn-session` | POST | 创建新会话 |
| `/stop` | POST | 优雅关闭守护进程 |

---

## 三、Web 应用架构与工具视图系统

### 3.1 核心渲染链

```
SessionView → ChatList → MessageView → [按 message.kind 分发]
                                            ├─ 'user-text'  → UserTextBlock
                                            ├─ 'agent-text' → AgentTextBlock
                                            ├─ 'tool-call'  → ToolCallBlock → ToolView
                                            └─ 'agent-event'→ AgentEventBlock
```

### 3.2 ToolView 分发逻辑

```
ToolView 接收 tool: ToolCall
  → 检查 knownTools[tool.name].hidden → 如果 true，返回 null
  → 检查 knownTools[tool.name].minimal → 如果 true，仅渲染 header
  → 查找 toolViewRegistry[tool.name] → 如果存在，渲染专属组件
  → 否则渲染默认 JSON 输入/输出视图
```

### 3.3 工具视图注册表

**内联视图** (`toolViewRegistry`)：

| 工具名 | 组件 | 说明 |
|---|---|---|
| `Bash` | `BashView` | 紧凑：仅显示命令，隐藏输出 |
| `Edit` | `EditView` | diff 视图 |
| `MultiEdit` | `MultiEditView` | 多文件 diff |
| `Write` | `WriteView` | 写入 diff |
| `Task`/`Agent` | `TaskView` | 子代理：最近 3 个子工具 + 状态 |
| `TodoWrite` | `TodoView` | 待办列表 |
| `CodexBash` | `CodexBashView` | Codex 专用 Bash |
| `AskUserQuestion` | `AskUserQuestionView` | 交互式问答 |

**展开视图** (`toolFullViewRegistry`)：

| 工具名 | 组件 | 说明 |
|---|---|---|
| `Bash` | `BashViewFull` | 完整：命令 + stdout + stderr |
| `Edit` | `EditViewFull` | 带行号 |
| `MultiEdit` | `MultiEditViewFull` | 多文件完整 diff |

### 3.4 关键数据类型

```typescript
// packages/happy-app/sources/sync/typesMessage.ts
type ToolCall = {
    name: string;              // 工具名称，如 'Bash', 'Edit'
    state: 'running' | 'completed' | 'error';
    input: any;                // 工具输入参数
    createdAt: number;
    startedAt: number | null;
    completedAt: number | null;
    description: string | null;
    result?: any;              // 工具执行结果
    permission?: {
        id: string;
        status: 'pending' | 'approved' | 'denied' | 'canceled';
        // ... 更多权限字段
    };
}

type ToolCallMessage = {
    kind: 'tool-call';
    id: string;
    localId?: string;
    createdAt: number;
    tool: ToolCall;
    children: Message[];       // 子消息（Task/Agent 的子工具调用）
    meta?: MessageMeta;
}
```

### 3.5 knownTools 配置结构

```typescript
// packages/happy-app/sources/components/tools/knownTools.tsx
{
    title?: string | ((opts) => string);        // 标题
    icon: (size, color) => ReactNode;           // 图标工厂
    minimal?: boolean | ((opts) => boolean);    // 紧凑模式
    hidden?: boolean;                           // 完全隐藏
    isMutable?: boolean;                        // 是否修改文件
    noStatus?: boolean;                         // 隐藏运行状态
    hideDefaultError?: boolean;                 // 隐藏默认错误
    input?: z.ZodObject;                        // 输入 Zod Schema
    result?: z.ZodObject;                       // 结果 Zod Schema
    extractDescription?: (opts) => string;      // Task 子工具标题
    extractSubtitle?: (opts) => string | null;  // 副标题
    extractStatus?: (opts) => string | null;    // 状态文本
}
```

### 3.6 样式系统

使用 `react-native-unistyles`，所有样式通过 `StyleSheet.create((theme, runtime) => ({...}))` 定义。

**终端相关颜色**（`theme.colors.terminal.*`）：

| 键 | 亮色值 | 用途 |
|---|---|---|
| `background` | `#1E1E1E` | 终端背景 |
| `prompt` | `#34C759` | `$` 提示符 |
| `command` | `#E0E0E0` | 命令文本 |
| `stdout` | `#E0E0E0` | 标准输出 |
| `stderr` | `#FFB86C` | 错误输出 |
| `error` | `#FF5555` | 错误信息 |

---

## 四、工具视图扩展方案

### 4.1 扩展点总览

```
方案 A: 新增工具专属视图组件 → 注册到 toolViewRegistry
方案 B: 添加悬浮式工具调用列表面板 → 在 SessionView 中添加绝对定位面板
方案 C: 添加侧边栏工具执行历史 → 利用 SidebarNavigator 扩展
方案 D: 添加底部工具执行状态栏 → 类似 VoiceAssistantStatusBar 模式
```

### 4.2 方案 A：新增/修改工具视图组件

**场景**：增强 BashView 在内联模式下也显示关键输出摘要。

**步骤**：
1. 在 `sources/components/tools/views/` 中创建或修改视图组件
2. 在 `views/_all.tsx` 中注册到 `toolViewRegistry`
3. 在 `knownTools.tsx` 中添加配置

**Demo 代码 — 增强版 BashView（显示输出摘要）**：

```typescript
// ============================================
// DEMO: EnhancedBashView.tsx
// 概念演示：在内联 Bash 视图中显示输出摘要
// 仅用于调研，不修改仓库代码
// ============================================
import * as React from 'react';
import { View, Text, Pressable } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ToolCall } from '@/sync/typesMessage';
import { ToolSectionView } from '../../tools/ToolSectionView';
import { CommandView } from '@/components/CommandView';
import { knownTools } from '@/components/tools/knownTools';
import { Metadata } from '@/sync/storageTypes';

const styles = StyleSheet.create((theme) => ({
    outputSummary: {
        marginTop: 4,
        paddingHorizontal: 8,
        paddingVertical: 4,
        backgroundColor: theme.colors.terminal.background,
        borderRadius: 4,
        maxHeight: 60,
        overflow: 'hidden',
    },
    outputText: {
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 11,
        color: theme.colors.terminal.stdout,
    },
    stderrText: {
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 11,
        color: theme.colors.terminal.stderr,
    },
    expandHint: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        marginTop: 2,
    },
}));

interface EnhancedBashViewProps {
    tool: ToolCall;
    metadata: Metadata | null;
}

export const EnhancedBashView = React.memo((props: EnhancedBashViewProps) => {
    const { input, result, state } = props.tool;

    let parsedResult: { stdout?: string; stderr?: string } | null = null;
    let unparsedOutput: string | null = null;
    let error: string | null = null;

    if (state === 'completed' && result) {
        if (typeof result === 'string') {
            unparsedOutput = result;
        } else {
            const parsed = knownTools.Bash.result.safeParse(result);
            if (parsed.success) {
                parsedResult = parsed.data;
            } else {
                unparsedOutput = JSON.stringify(result);
            }
        }
    } else if (state === 'error' && typeof result === 'string') {
        error = result;
    }

    // 提取输出摘要：截取前 3 行
    const getSummary = (text: string | null | undefined, maxLines = 3): string | null => {
        if (!text) return null;
        const lines = text.split('\n').filter(l => l.trim());
        if (lines.length === 0) return null;
        return lines.slice(0, maxLines).join('\n') + (lines.length > maxLines ? '\n...' : '');
    };

    const stdoutSummary = getSummary(parsedResult?.stdout || unparsedOutput);
    const stderrSummary = getSummary(parsedResult?.stderr);

    return (
        <>
            <ToolSectionView>
                <CommandView
                    command={input.command}
                    stdout={null}
                    stderr={null}
                    error={error}
                    hideEmptyOutput
                />
            </ToolSectionView>
            {/* 新增：输出摘要区域 */}
            {stdoutSummary && (
                <View style={styles.outputSummary}>
                    <Text style={styles.outputText} numberOfLines={3}>{stdoutSummary}</Text>
                    <Text style={styles.expandHint}>Tap to expand</Text>
                </View>
            )}
            {stderrSummary && (
                <View style={styles.outputSummary}>
                    <Text style={styles.stderrText} numberOfLines={3}>{stderrSummary}</Text>
                </View>
            )}
        </>
    );
});
```

**注册方式**（在 `_all.tsx` 中替换 Bash 视图）：
```typescript
// 将 toolViewRegistry 中的 Bash 条目替换
toolViewRegistry['Bash'] = EnhancedBashView;
```

### 4.3 方案 B：悬浮式工具调用列表面板

**场景**：在会话界面悬浮显示当前正在运行和最近完成的工具调用列表。

**架构参考**：
- `FloatingOverlay` — 已有的浮动容器组件
- `CommandPaletteModal` — Web 端浮动面板范例
- SessionView 中的 CLI Warning Pill — 绝对定位浮动元素

**Demo 代码 — 悬浮工具执行面板**：

```typescript
// ============================================
// DEMO: ToolExecutionPanel.tsx
// 概念演示：悬浮在会话界面右侧的工具调用列表面板
// 仅用于调研，不修改仓库代码
// ============================================
import * as React from 'react';
import { View, Text, Pressable, Platform, FlatList } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useSessionMessages } from '@/sync/storage';
import { ToolCall, ToolCallMessage, Message } from '@/sync/typesMessage';
import { knownTools } from '@/components/tools/knownTools';

const styles = StyleSheet.create((theme, runtime) => ({
    container: {
        position: 'absolute',
        right: 8,
        top: runtime.insets.top + 56,
        width: 260,
        maxHeight: 400,
        borderRadius: 12,
        backgroundColor: theme.colors.surfaceHigh,
        borderWidth: 1,
        borderColor: theme.colors.divider,
        shadowColor: theme.colors.shadow.color,
        shadowOffset: { width: 0, height: 4 },
        shadowRadius: 8,
        shadowOpacity: theme.colors.shadow.opacity,
        elevation: 8,
        overflow: 'hidden',
        zIndex: 999,
    },
    header: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 8,
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    headerTitle: {
        fontSize: 12,
        fontWeight: '600',
        color: theme.colors.text,
    },
    headerCount: {
        fontSize: 11,
        color: theme.colors.textSecondary,
    },
    toolItem: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        gap: 8,
    },
    toolItemBorder: {
        borderBottomWidth: 1,
        borderBottomColor: theme.colors.divider,
    },
    toolIcon: {
        width: 20,
        alignItems: 'center',
    },
    toolInfo: {
        flex: 1,
        minHeight: 20,
        justifyContent: 'center',
    },
    toolName: {
        fontSize: 12,
        fontWeight: '500',
        color: theme.colors.text,
    },
    toolSubtitle: {
        fontSize: 10,
        color: theme.colors.textSecondary,
        marginTop: 1,
    },
    statusDot: {
        width: 6,
        height: 6,
        borderRadius: 3,
    },
    statusRunning: {
        backgroundColor: theme.colors.warning,
    },
    statusCompleted: {
        backgroundColor: theme.colors.success,
    },
    statusError: {
        backgroundColor: theme.colors.box.error.background,
    },
    emptyText: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        textAlign: 'center',
        paddingVertical: 16,
    },
}));

interface ToolExecutionPanelProps {
    sessionId: string;
    visible: boolean;
    onClose: () => void;
}

interface ToolExecutionEntry {
    id: string;
    name: string;
    state: ToolCall['state'];
    subtitle: string | null;
    createdAt: number;
}

function extractToolExecutions(messages: Message[]): ToolExecutionEntry[] {
    const entries: ToolExecutionEntry[] = [];

    for (const msg of messages) {
        if (msg.kind !== 'tool-call') continue;
        const toolMsg = msg as ToolCallMessage;
        const tool = toolMsg.tool;

        // 跳过隐藏工具
        const known = knownTools[tool.name as keyof typeof knownTools];
        if (known?.hidden) continue;

        let subtitle: string | null = null;
        if (known?.extractSubtitle) {
            subtitle = known.extractSubtitle({ tool, metadata: null });
        } else if (tool.name === 'Bash' && tool.input?.command) {
            subtitle = tool.input.command;
        } else if (tool.name === 'Edit' && tool.input?.file_path) {
            subtitle = tool.input.file_path;
        } else if (tool.name === 'Write' && tool.input?.file_path) {
            subtitle = tool.input.file_path;
        }

        entries.push({
            id: toolMsg.id,
            name: known?.title
                ? typeof known.title === 'function'
                    ? known.title({ tool, metadata: null })
                    : known.title
                : tool.name,
            state: tool.state,
            subtitle,
            createdAt: toolMsg.createdAt,
        });
    }

    // 按时间倒序，运行中的排在前面
    return entries.sort((a, b) => {
        if (a.state === 'running' && b.state !== 'running') return -1;
        if (a.state !== 'running' && b.state === 'running') return 1;
        return b.createdAt - a.createdAt;
    });
}

function formatTimeAgo(timestamp: number): string {
    const diff = Date.now() - timestamp;
    if (diff < 5000) return 'just now';
    if (diff < 60000) return `${Math.floor(diff / 1000)}s ago`;
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    return `${Math.floor(diff / 3600000)}h ago`;
}

export const ToolExecutionPanel = React.memo((props: ToolExecutionPanelProps) => {
    const { sessionId, visible, onClose } = props;
    const { messages } = useSessionMessages(sessionId);

    if (!visible || Platform.OS !== 'web') return null;

    const toolEntries = extractToolExecutions(messages);
    const runningCount = toolEntries.filter(e => e.state === 'running').length;

    const renderItem = ({ item, index }: { item: ToolExecutionEntry; index: number }) => (
        <View style={[styles.toolItem, index < toolEntries.length - 1 && styles.toolItemBorder]}>
            <View style={styles.toolIcon}>
                <View style={[
                    styles.statusDot,
                    item.state === 'running' && styles.statusRunning,
                    item.state === 'completed' && styles.statusCompleted,
                    item.state === 'error' && styles.statusError,
                ]} />
            </View>
            <View style={styles.toolInfo}>
                <Text style={styles.toolName} numberOfLines={1}>{item.name}</Text>
                {item.subtitle && (
                    <Text style={styles.toolSubtitle} numberOfLines={1}>{item.subtitle}</Text>
                )}
            </View>
            <Text style={styles.headerCount}>{formatTimeAgo(item.createdAt)}</Text>
        </View>
    );

    return (
        <Animated.View
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
            style={styles.container}
        >
            <View style={styles.header}>
                <Text style={styles.headerTitle}>Tool Calls</Text>
                <Text style={styles.headerCount}>
                    {runningCount > 0 ? `${runningCount} running` : `${toolEntries.length} total`}
                </Text>
            </View>
            <FlatList
                data={toolEntries.slice(0, 20)}
                keyExtractor={(item) => item.id}
                renderItem={renderItem}
                ListEmptyComponent={<Text style={styles.emptyText}>No tool calls yet</Text>}
            />
        </Animated.View>
    );
});
```

**在 SessionView 中集成（概念性）**：

```typescript
// 在 SessionViewLoaded 中添加状态和面板
const [showToolPanel, setShowToolPanel] = React.useState(false);

// 在 AgentContentView 内部，与 ChatList 同级添加：
{showToolPanel && (
    <ToolExecutionPanel
        sessionId={sessionId}
        visible={showToolPanel}
        onClose={() => setShowToolPanel(false)}
    />
)}
```

### 4.4 方案 C：Web 端键盘快捷键触发面板

参考 `CommandPaletteProvider` 的实现模式，添加全局快捷键：

```typescript
// ============================================
// DEMO: useToolPanelHotkey.ts
// 概念演示：Web 端通过快捷键切换工具面板
// 仅用于调研，不修改仓库代码
// ============================================
import * as React from 'react';
import { Platform } from 'react-native';
import { useGlobalKeyboard } from '@/hooks/useGlobalKeyboard';

export function useToolPanelHotkey(onToggle: () => void) {
    // 仅 Web 端生效
    const enabled = Platform.OS === 'web';

    useGlobalKeyboard({
        key: 't',
        metaKey: true,
        shiftKey: true,
        enabled,
        onPress: (e: KeyboardEvent) => {
            e.preventDefault();
            onToggle();
        },
    });
}

// 在 SessionView 中使用：
// useToolPanelHotkey(() => setShowToolPanel(prev => !prev));
```

### 4.5 方案 D：底部工具执行状态栏

参考 `VoiceAssistantStatusBar` 的实现模式，在聊天输入框上方添加一个可折叠的状态栏：

```typescript
// ============================================
// DEMO: ToolStatusBar.tsx
// 概念演示：在输入框上方显示当前运行中的工具摘要
// 仅用于调研，不修改仓库代码
// ============================================
import * as React from 'react';
import { View, Text, Pressable, ActivityIndicator } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSessionMessages } from '@/sync/storage';
import { ToolCall, ToolCallMessage, Message } from '@/sync/typesMessage';
import { knownTools } from '@/components/tools/knownTools';

const styles = StyleSheet.create((theme) => ({
    container: {
        flexDirection: 'row',
        alignItems: 'center',
        paddingHorizontal: 12,
        paddingVertical: 6,
        backgroundColor: theme.colors.surfaceHigh,
        borderTopWidth: 1,
        borderTopColor: theme.colors.divider,
        gap: 8,
    },
    runningDot: {
        width: 8,
        height: 8,
        borderRadius: 4,
        backgroundColor: theme.colors.warning,
    },
    text: {
        fontSize: 12,
        color: theme.colors.textSecondary,
        flex: 1,
    },
    detail: {
        fontSize: 11,
        color: theme.colors.textSecondary,
        maxWidth: '70%',
    },
    expandButton: {
        paddingHorizontal: 8,
        paddingVertical: 2,
        borderRadius: 4,
        backgroundColor: theme.colors.surfaceHighest,
    },
    expandText: {
        fontSize: 10,
        color: theme.colors.textSecondary,
    },
}));

interface ToolStatusBarProps {
    sessionId: string;
    onExpand: () => void;
}

export const ToolStatusBar = React.memo((props: ToolStatusBarProps) => {
    const { sessionId, onExpand } = props;
    const { messages } = useSessionMessages(sessionId);

    // 提取运行中的工具
    const runningTools: Array<{ name: string; subtitle: string | null }> = [];
    for (const msg of messages) {
        if (msg.kind !== 'tool-call') continue;
        const toolMsg = msg as ToolCallMessage;
        if (toolMsg.tool.state !== 'running') continue;

        const known = knownTools[toolMsg.tool.name as keyof typeof knownTools];
        if (known?.hidden) continue;

        const title = known?.title
            ? typeof known.title === 'function'
                ? known.title({ tool: toolMsg.tool, metadata: null })
                : known.title
            : toolMsg.tool.name;

        const subtitle = known?.extractSubtitle
            ? known.extractSubtitle({ tool: toolMsg.tool, metadata: null })
            : null;

        runningTools.push({ name: title, subtitle });
    }

    if (runningTools.length === 0) return null;

    const firstTool = runningTools[0];
    const moreCount = runningTools.length - 1;

    return (
        <View style={styles.container}>
            <View style={styles.runningDot} />
            <Text style={styles.text}>
                {firstTool.name}
                {firstTool.subtitle ? `: ${firstTool.subtitle}` : ''}
                {moreCount > 0 ? ` +${moreCount} more` : ''}
            </Text>
            <Pressable onPress={onExpand} style={styles.expandButton}>
                <Text style={styles.expandText}>Details</Text>
            </Pressable>
        </View>
    );
});
```

---

## 五、关键文件索引

### Web 应用入口与配置
- `packages/happy-app/app.config.js` — Expo 配置（web 设置在 85-89 行）
- `packages/happy-app/metro.config.js` — Metro 配置（CSS/WASM 支持）
- `packages/happy-app/babel.config.js` — Babel 配置
- `packages/happy-app/sources/app/_layout.tsx` — 根布局（Provider 嵌套）
- `packages/happy-app/sources/app/+html.tsx` — Web HTML 壳

### 会话与消息
- `packages/happy-app/sources/-session/SessionView.tsx` — 主会话界面
- `packages/happy-app/sources/components/ChatList.tsx` — 消息列表
- `packages/happy-app/sources/components/MessageView.tsx` — 消息渲染分发
- `packages/happy-app/sources/sync/storage.ts` — Zustand 存储
- `packages/happy-app/sources/sync/reducer/reducer.ts` — 消息处理流水线

### 工具视图系统
- `packages/happy-app/sources/components/tools/ToolView.tsx` — 工具视图主分发器
- `packages/happy-app/sources/components/tools/views/_all.tsx` — 视图注册表
- `packages/happy-app/sources/components/tools/knownTools.tsx` — 工具配置注册表
- `packages/happy-app/sources/components/tools/views/BashView.tsx` — Bash 紧凑视图
- `packages/happy-app/sources/components/tools/views/BashViewFull.tsx` — Bash 展开视图
- `packages/happy-app/sources/components/CommandView.tsx` — 终端渲染原语
- `packages/happy-app/sources/sync/typesMessage.ts` — ToolCall 类型定义

### 悬浮/覆盖组件参考
- `packages/happy-app/sources/components/FloatingOverlay.tsx` — 浮动容器
- `packages/happy-app/sources/components/CommandPalette/CommandPaletteModal.tsx` — 命令面板
- `packages/happy-app/sources/modal/ModalManager.ts` — 模态框命令式 API
- `packages/happy-app/sources/modal/ModalProvider.tsx` — 模态框 Provider

### 环境管理
- `environments/environments.ts` — 环境管理器
- `environments/lab-rat-todo-project/` — 测试项目模板
- `docs/dev-environments.md` — 环境管理文档

### 服务器连接
- `packages/happy-app/sources/sync/apiSocket.ts` — Socket.IO 客户端
- `packages/happy-app/sources/sync/serverConfig.ts` — 服务器 URL 解析
- `packages/happy-app/sources/auth/tokenStorage.ts` — 认证凭据存储
