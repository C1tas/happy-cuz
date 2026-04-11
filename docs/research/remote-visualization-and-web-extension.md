# 调研：远程项目本地可视化 & Web端扩展

## 一、远程创建的 Session 如何在本地可视化

### 1.1 当前现状

远程 Session（由手机通过 RPC `spawn-happy-session` 创建）有以下本地可视化途径：

| 方式 | 前提条件 | 可见内容 |
|---|---|---|
| **tmux attach** | TMUX_SESSION_NAME 环境变量已设置 | 完整终端交互（local mode 的 Claude CLI） |
| **`happy daemon list`** | 守护进程运行中 | PID、sessionId、startedBy 列表 |
| **守护进程日志** | `~/.happy-dev/logs/` | 进程级日志，非会话内容 |
| **手机 App** | WebSocket 连接 | 完整实时消息流 |

**关键限制**：守护进程 spawn 的远程 Session 使用 `stdio: 'ignore'` + `detached: true`，**无法从新终端 attach**。没有 `happy attach` 命令。

### 1.2 远程 Session 创建流程

```
手机 App → machineRPC('spawn-happy-session', {directory, agent})
         → Server 路由到目标机器守护进程
         → daemon/run.ts spawnSession()
             ├─ tmux 路径: 在 tmux window 中 spawn
             └─ 常规路径: detached + stdio:ignore
         → Happy 进程启动 → --happy-starting-mode remote --started-by daemon
         → 进程 POST /session-started 到 daemon 控制服务器
         → daemon 解析 awaiter，返回 sessionId 给手机
```

源码位置：`packages/happy-cli/src/daemon/run.ts` (lines 198-478)

### 1.3 切换到本地 CLI 的方式

**方式 1：模式切换 RPC**

手机 App 可发送 `switch` RPC 将远程 Session 切换到本地模式：
```
手机 → sessionRPC(sessionId, 'switch', {})
     → CLI 的 RpcHandlerManager 处理
     → doSwitch() → exitReason = {type: 'switch'}
     → loop.ts 切换到 local mode
     → 重新 spawn Claude 为交互式终端进程
```

但如果 Session 是 daemon-spawned 且 `stdio: 'ignore'`，切换到 local mode 后也无法交互（没有 TTY）。

**方式 2：`happy resume <sessionId>`**

```
happy resume <sessionId>
  → resolveHappySession() 从服务器获取所有 Session，解密 metadata 匹配
  → buildResumeLaunch() 构造参数: ['claude', '--resume', claudeSessionId]
  → spawnResumeChild() 以 stdio: 'inherit' spawn happy 子进程
```

源码位置：`packages/happy-cli/src/resume/handleResumeCommand.ts`

**这是最可行的方案**：`happy resume` 会用 `stdio: 'inherit'` 启动一个新的 Happy 进程，用户可以直接在终端交互。

**方式 3：tmux attach**

仅当 tmux 可用时。daemon spawn 的结果消息会提示：
```
Use 'tmux attach -t <sessionName>' to view the session
```

### 1.4 缺失能力与改进方向

当前缺失：

1. **没有 `happy attach` 命令** —— 无法实时查看远程 Session 的消息流
2. **daemon 没有消息流暴露** —— 控制服务器只有 CRUD 端点，没有消息流 WebSocket
3. **远程 Session 无 TUI** —— daemon-spawned 的进程没有 TTY，RemoteModeDisplay 不渲染

**可行的改进方案 A：添加 Session 消息流监控**

```typescript
// 伪代码：happy watch <sessionId>
// 连接到 Server 的 session-scoped WebSocket
// 接收加密消息，解密后在终端渲染

async function watchSession(sessionId: string) {
  const credentials = await loadCredentials();
  const client = new ApiSessionClient({
    sessionId,
    token: credentials.token,
    encryptionKey: credentials.key,
  });

  // 连接 WebSocket
  await client.connect();

  // 监听消息
  client.on('message', (message: SessionEnvelope) => {
    switch (message.ev.t) {
      case 'text':
        console.log(message.role === 'user' ? '👤 ' : '🤖 ', message.ev.text);
        break;
      case 'tool-call-start':
        console.log(`  🔧 ${message.ev.name}: ${message.ev.title}`);
        break;
      case 'tool-call-end':
        console.log(`  ✅ ${message.ev.call}`);
        break;
      case 'turn-end':
        console.log(`--- turn ${message.ev.status} ---`);
        break;
    }
  });
}
```

**可行的改进方案 B：daemon 控制服务器增加 SSE/WebSocket 端点**

```typescript
// 伪代码：在 daemon 控制服务器添加 /sessions/:id/stream
// daemon 已经跟踪了所有 session，可以订阅其消息流

fastify.get('/sessions/:id/stream', { websocket: true }, (socket, req) => {
  const session = trackedSessions.get(req.params.id);
  if (!session) {
    socket.close(404);
    return;
  }
  // 订阅 session 的消息事件
  session.onMessage((msg) => {
    socket.send(JSON.stringify(msg));
  });
});
```

---

## 二、Web 端源码位置与架构

### 2.1 Web 端入口

| 文件 | 职责 |
|---|---|
| `packages/happy-app/app.config.js` | Web 配置: `bundler: "metro"`, `output: "single"` (SPA) |
| `packages/happy-app/sources/app/+html.tsx` | Web HTML Shell |
| `packages/happy-app/sources/app/_layout.tsx` | 根布局，含 Tauri 检测、Web 特有 provider 注入 |

**平台检测**：`Platform.OS === 'web'` 或 `.web.tsx` 文件扩展名

**Web 特有组件**：
- `sources/components/web/FaviconPermissionIndicator.tsx` —— 浏览器 favicon 显示待审批权限
- `sources/components/PlusPlus.web.tsx` —— Web 特有变体
- `sources/modal/components/WebAlertModal.tsx` / `WebPromptModal.tsx` —— Web 弹窗
- `sources/components/CommandPalette/` —— **仅 Web** 的命令面板

### 2.2 Session 会话界面组件层次

```
app/(app)/session/[id].tsx
  └─ SessionView (sources/-session/SessionView.tsx, 667行)
       ├─ ChatHeaderView (绝对定位, zIndex:1000)
       ├─ VoiceAssistantStatusBar (条件渲染)
       ├─ AgentContentView (内容 + 输入 + 占位插槽)
       │    ├─ ChatList (FlatList inverted)
       │    │    └─ MessageView (消息分发器)
       │    │         ├─ 'user-text' → UserTextBlock
       │    │         ├─ 'agent-text' → AgentTextBlock
       │    │         ├─ 'tool-call' → ToolCallBlock → ToolView
       │    │         └─ 'agent-event' → AgentEventBlock
       │    └─ AgentInput (底部输入栏)
       └─ CLI版本警告pill (绝对定位, zIndex:998)
```

### 2.3 Tool Call 渲染体系

**核心组件**：`sources/components/tools/ToolView.tsx`

```
ToolView
  ├─ knownTools 注册表 → 获取工具配置 (title, icon, minimal, hidden...)
  ├─ hidden 工具 → 返回 null
  ├─ minimal 工具 → 仅显示 header (icon + title + status)
  └─ 完整工具 → header + content
       ├─ toolViewRegistry[name] → 特定视图组件
       └─ 默认 → JSON input/output 显示
```

**工具视图注册表** (`sources/components/tools/views/_all.tsx`)：

| 工具名 | 紧凑视图 | 展开视图 |
|---|---|---|
| `Bash` | `BashView` (仅命令) | `BashViewFull` (命令+stdout+stderr) |
| `Edit` | `EditView` | `EditViewFull` |
| `MultiEdit` | `MultiEditView` | `MultiEditViewFull` |
| `Write` | `WriteView` | - |
| `Task`/`Agent` | `TaskView` | `TaskView` |
| `TodoWrite` | `TodoView` | - |
| `AskUserQuestion` | `AskUserQuestionView` | - |
| Gemini `edit` | `GeminiEditView` | - |
| Gemini `execute` | `GeminiExecuteView` | - |

**Bash 命令渲染**：
- 紧凑 (`BashView`)：仅显示命令文本
- 展开 (`BashViewFull`)：命令 + stdout + stderr，水平可滚动
- `CommandView` 组件：终端风格渲染，等宽字体，主题色区分 prompt/command/stdout/stderr

### 2.4 现有浮动/覆盖组件模式

| 模式 | 组件 | 实现方式 |
|---|---|---|
| 浮动弹出 | `FloatingOverlay` | `position: absolute` + 圆角阴影 + 内部滚动 |
| 命令面板 | `CommandPaletteModal` | `Modal.show()` + 30vh 定位 + 90%宽度 |
| 状态栏 | `VoiceAssistantStatusBar` | 条件渲染的固定高度横条 |
| 警告药丸 | CLI版本警告 | `position: absolute` + zIndex:998 + 圆角100 |
| 通用弹窗 | `BaseModal` | backdrop + fade动画 + keyboard avoidance |

**没有使用** `@gorhom/bottom-sheet` 或类似库，所有覆盖层都基于：
- React Native `Modal` / 绝对定位
- `Animated.View` / `react-native-reanimated` 过渡动画
- `Modal.show({ component, props })` 命令式 API

### 2.5 状态管理

- **Zustand** 单一 store：`sources/sync/storage.ts`
- 消息 hook：`useSessionMessages(sessionId)` → 返回 `Message[]`
- 消息过滤：`Message.kind === 'tool-call'` + `Message.tool.name` + `Message.tool.state`
- 实时更新：Zustand store 通过 `applyMessages()` 自动触发 React 重渲染

---

## 三、扩展方案：悬浮 Tool Call / Bash 执行列表

### 3.1 设计思路

在 Session 会话界面添加一个**可折叠的悬浮面板**，实时显示当前 Session 中所有 tool call 和 bash 命令的执行状态，类似 IDE 的 Terminal/Problems 面板。

**核心数据源**：
```typescript
// 从 Zustand store 获取所有 tool-call 类型消息
const messages = useSessionMessages(sessionId);
const toolCalls = messages.filter(m => m.kind === 'tool-call');
const activeToolCalls = toolCalls.filter(m => m.tool.state === 'running');
```

### 3.2 Demo 代码：悬浮工具执行面板

> 以下代码仅为调研 Demo，不修改仓库现有代码

```tsx
// ===== ToolExecutionPanel.tsx =====
// 悬浮在 SessionView 右侧或底部的工具执行列表面板

import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, FlatList, LayoutAnimation, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSessionMessages } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';

// 消息类型定义 (参考 sources/sync/typesMessage.ts)
interface ToolCall {
  name: string;
  state: 'running' | 'completed' | 'error';
  input: any;
  result?: any;
  description?: string;
  startedAt?: number;
  completedAt?: number;
}

interface ToolCallMessage {
  kind: 'tool-call';
  id: string;
  tool: ToolCall;
  children: any[];
}

// 面板展开状态
type PanelMode = 'collapsed' | 'compact' | 'expanded';

interface ToolExecutionPanelProps {
  sessionId: string;
}

export function ToolExecutionPanel({ sessionId }: ToolExecutionPanelProps) {
  const [mode, setMode] = useState<PanelMode>('collapsed');
  const { theme } = useUnistyles();
  const messages = useSessionMessages(sessionId);

  // 提取所有 tool-call 消息
  const toolCalls = useMemo(() => {
    return (messages as any[])
      .filter((m): m is ToolCallMessage => m.kind === 'tool-call')
      .map(m => ({
        id: m.id,
        name: m.tool.name,
        state: m.tool.state,
        description: m.tool.description || extractDescription(m.tool),
        elapsed: m.tool.completedAt && m.tool.startedAt
          ? m.tool.completedAt - m.tool.startedAt
          : m.tool.startedAt
            ? Date.now() - m.tool.startedAt
            : null,
        isBash: m.tool.name === 'Bash' || m.tool.name === 'CodexBash',
        command: m.tool.name === 'Bash' ? m.tool.input?.command : undefined,
      }))
      .reverse(); // 最新的在上面
  }, [messages]);

  const activeCount = toolCalls.filter(t => t.state === 'running').length;

  // 折叠状态：仅显示计数药丸
  if (mode === 'collapsed') {
    if (activeCount === 0 && toolCalls.length === 0) return null;

    return (
      <Pressable
        style={[styles.collapsedPill, { backgroundColor: theme.colors.primary }]}
        onPress={() => setMode('compact')}
      >
        <Text style={styles.pillText}>
          {activeCount > 0 ? `${activeCount} running` : `${toolCalls.length} tools`}
        </Text>
      </Pressable>
    );
  }

  // 紧凑状态：底部固定面板，显示最近 N 条
  return (
    <View style={[styles.panel, { backgroundColor: theme.colors.surfaceHigh, borderTopColor: theme.colors.divider }]}>
      {/* 面板头 */}
      <View style={styles.panelHeader}>
        <Text style={[styles.panelTitle, { color: theme.colors.textSecondary }]}>
          Tool Execution
          {activeCount > 0 && (
            <Text style={{ color: theme.colors.primary }}> ({activeCount} running)</Text>
          )}
        </Text>
        <View style={styles.panelControls}>
          <Pressable onPress={() => setMode('expanded')}>
            <Text style={{ color: theme.colors.primary, fontSize: 12 }}>Expand</Text>
          </Pressable>
          <Pressable onPress={() => setMode('collapsed')}>
            <Text style={{ color: theme.colors.textSecondary, fontSize: 12 }}>Close</Text>
          </Pressable>
        </View>
      </View>

      {/* 工具列表 */}
      <FlatList
        data={mode === 'compact' ? toolCalls.slice(0, 5) : toolCalls}
        keyExtractor={item => item.id}
        renderItem={({ item }) => <ToolExecutionItem item={item} theme={theme} />}
        style={styles.toolList}
      />
    </View>
  );
}

// 单条工具执行项
function ToolExecutionItem({ item, theme }: { item: any; theme: any }) {
  const stateIcon = item.state === 'running' ? '⏳' : item.state === 'error' ? '❌' : '✅';
  const elapsed = item.elapsed ? `${(item.elapsed / 1000).toFixed(1)}s` : '';

  return (
    <View style={[styles.toolItem, { borderBottomColor: theme.colors.divider }]}>
      <Text style={styles.toolState}>{stateIcon}</Text>
      <View style={styles.toolInfo}>
        <Text style={{ color: theme.colors.text, fontSize: 13 }} numberOfLines={1}>
          {item.isBash ? `$ ${item.command || item.name}` : item.name}
        </Text>
        {item.description ? (
          <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }} numberOfLines={1}>
            {item.description}
          </Text>
        ) : null}
      </View>
      {elapsed ? (
        <Text style={{ color: theme.colors.textSecondary, fontSize: 11 }}>{elapsed}</Text>
      ) : null}
    </View>
  );
}

// 从 tool input 中提取描述 (参考 knownTools.tsx 的 extractDescription 模式)
function extractDescription(tool: ToolCall): string | undefined {
  if (tool.name === 'Bash' && tool.input?.command) {
    return tool.input.command;
  }
  if (tool.name === 'Edit' && tool.input?.file_path) {
    return `Edit ${tool.input.file_path}`;
  }
  if (tool.name === 'Write' && tool.input?.file_path) {
    return `Write ${tool.input.file_path}`;
  }
  return undefined;
}

const styles = StyleSheet.create((theme, runtime) => ({
  collapsedPill: {
    position: 'absolute',
    bottom: 80,
    right: 16,
    borderRadius: 100,
    paddingHorizontal: 12,
    paddingVertical: 6,
    zIndex: 999,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.2,
    shadowRadius: 4,
    elevation: 5,
  },
  pillText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
  },
  panel: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    maxHeight: 240,
    borderTopWidth: 1,
    zIndex: 997,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: -2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
    elevation: 8,
  },
  panelHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  panelTitle: {
    fontSize: 12,
    fontWeight: '600',
  },
  panelControls: {
    flexDirection: 'row',
    gap: 12,
  },
  toolList: {
    maxHeight: 180,
  },
  toolItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderBottomWidth: 0.5,
    gap: 8,
  },
  toolState: {
    fontSize: 12,
  },
  toolInfo: {
    flex: 1,
  },
}));
```

### 3.3 Demo 代码：Web 端侧边栏工具面板

> 利用 Web 端更宽的屏幕空间，在右侧添加固定侧边栏

```tsx
// ===== WebToolSidebar.tsx (仅 Web) =====
// 在 SessionView 中，当 Platform.OS === 'web' 且窗口足够宽时显示

import React, { useMemo, useState } from 'react';
import { View, Text, Pressable, FlatList, Platform } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { useSessionMessages } from '@/sync/storage';
import { useUnistyles } from 'react-native-unistyles';

interface WebToolSidebarProps {
  sessionId: string;
  visible: boolean;
  onToggle: () => void;
}

export function WebToolSidebar({ sessionId, visible, onToggle }: WebToolSidebarProps) {
  if (Platform.OS !== 'web' || !visible) return null;

  const { theme } = useUnistyles();
  const messages = useSessionMessages(sessionId);

  const toolCalls = useMemo(() => {
    return (messages as any[])
      .filter(m => m.kind === 'tool-call')
      .map(m => ({
        id: m.id,
        name: m.tool.name,
        state: m.tool.state,
        description: m.tool.description,
        isBash: m.tool.name === 'Bash',
        command: m.tool.name === 'Bash' ? m.tool.input?.command : undefined,
        filePath: m.tool.input?.file_path,
        startedAt: m.tool.startedAt,
        completedAt: m.tool.completedAt,
      }))
      .reverse();
  }, [messages]);

  const bashCommands = toolCalls.filter(t => t.isBash);
  const fileEdits = toolCalls.filter(t => !t.isBash);

  return (
    <View style={[styles.sidebar, { backgroundColor: theme.colors.surfaceHigh, borderLeftColor: theme.colors.divider }]}>
      {/* Bash 命令区域 */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>
            Terminal ({bashCommands.length})
          </Text>
        </View>
        <FlatList
          data={bashCommands}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <View style={[styles.bashItem, { borderBottomColor: theme.colors.divider }]}>
              <Text style={styles.terminalPrompt}>$</Text>
              <Text style={{ color: theme.colors.text, fontSize: 12, flex: 1 }} numberOfLines={1}>
                {item.command}
              </Text>
              <Text style={{ fontSize: 10 }}>
                {item.state === 'running' ? '⏳' : item.state === 'error' ? '❌' : '✅'}
              </Text>
            </View>
          )}
        />
      </View>

      {/* 文件编辑区域 */}
      <View style={styles.section}>
        <View style={styles.sectionHeader}>
          <Text style={[styles.sectionTitle, { color: theme.colors.textSecondary }]}>
            File Operations ({fileEdits.length})
          </Text>
        </View>
        <FlatList
          data={fileEdits}
          keyExtractor={item => item.id}
          renderItem={({ item }) => (
            <View style={[styles.fileItem, { borderBottomColor: theme.colors.divider }]}>
              <Text style={{ fontSize: 10 }}>
                {item.state === 'running' ? '⏳' : item.state === 'error' ? '❌' : '✅'}
              </Text>
              <View style={{ flex: 1 }}>
                <Text style={{ color: theme.colors.text, fontSize: 12 }}>{item.name}</Text>
                {item.filePath ? (
                  <Text style={{ color: theme.colors.textSecondary, fontSize: 10 }} numberOfLines={1}>
                    {item.filePath}
                  </Text>
                ) : null}
              </View>
            </View>
          )}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  sidebar: {
    width: 280,
    borderLeftWidth: 1,
    flexShrink: 0,
  },
  section: {
    flex: 1,
    minHeight: 100,
  },
  sectionHeader: {
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  },
  bashItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    gap: 6,
  },
  terminalPrompt: {
    color: theme.colors.terminal?.prompt || '#34C759',
    fontSize: 12,
    fontFamily: 'monospace',
  },
  fileItem: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 4,
    borderBottomWidth: 0.5,
    gap: 6,
  },
}));
```

### 3.4 Demo 代码：集成到 SessionView

> 展示如何在 SessionView 中集成上述组件（仅示意，不实际修改）

```tsx
// ===== 在 SessionView.tsx 中集成的伪代码 =====
// 在 SessionViewLoaded 组件中添加：

import { ToolExecutionPanel } from '@/components/ToolExecutionPanel';
import { WebToolSidebar } from '@/components/WebToolSidebar';

// 在 SessionViewLoaded 中添加状态
const [showToolSidebar, setShowToolSidebar] = useState(false);

// 在 AgentContentView 之后添加:
<>
  {/* 现有内容 */}
  <AgentContentView ... />

  {/* 新增：移动端/通用悬浮面板 */}
  <ToolExecutionPanel sessionId={sessionId} />

  {/* 新增：Web 端侧边栏 */}
  <WebToolSidebar
    sessionId={sessionId}
    visible={showToolSidebar}
    onToggle={() => setShowToolSidebar(v => !v)}
  />
</>

// 在 ChatHeaderView 中添加切换按钮 (Web only):
{Platform.OS === 'web' && (
  <Pressable onPress={() => setShowToolSidebar(v => !v)}>
    <Text style={{ fontSize: 14, color: theme.colors.primary }}>
      {showToolSidebar ? 'Hide' : 'Tools'}
    </Text>
  </Pressable>
)}
```

### 3.5 扩展点总结

| 扩展目标 | 扩展点 | 方式 |
|---|---|---|
| 自定义工具渲染 | `sources/components/tools/views/_all.tsx` | 在 `toolViewRegistry` 注册新组件 |
| 工具配置 | `sources/components/tools/knownTools.tsx` | 添加工具的 icon/title/minimal/hidden 配置 |
| 悬浮面板 | `SessionView.tsx` 内绝对定位 | 参考 FloatingOverlay 模式 |
| Web 侧边栏 | `SessionView.tsx` AgentContentView 同级 | 利用 Web 宽屏空间 |
| 命令式弹窗 | `Modal.show({ component, props })` | 参考 CommandPalette 模式 |
| 消息数据 | `useSessionMessages(sessionId)` | Zustand hook，自动响应更新 |
| 主题集成 | `useUnistyles()` → `theme` | 使用统一配色体系 |

### 3.6 推荐实现路径

1. **Phase 1**：在 `SessionView` 添加折叠药丸（collapsed pill），仅显示活跃 tool count，点击展开
2. **Phase 2**：展开为底部面板（compact panel），显示最近 5 条 tool call，支持滚动
3. **Phase 3**（Web only）：右侧固定侧边栏，分区显示 Bash 命令历史和文件操作列表
4. **Phase 4**：点击工具项导航到消息详情页 `session/[id]/message/[messageId]`
