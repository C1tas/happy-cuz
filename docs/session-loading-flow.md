# Session 加载与消息同步流程分析

## 一、启动 → 数据就绪 时序

```
App Launch
   │
   ├─ loadFonts()                 [AsyncLock，加载后短路]
   ├─ await sodium.ready          [libsodium WASM 初始化]
   │
   ├─ TokenStorage.getCredentials()
   │
   ├─ Encryption.create(secret)   [纯 CPU：HMAC-SHA512 派生 + box_seed_keypair]
   │
   ├─ apiSocket.initialize()      [启动 Socket.IO WebSocket 连接，后台异步]
   │
   └─ sync.restore(credentials, encryption)
      │
      └─ #init()
         │
         ├─ subscribeToUpdates()          [注册 WS 事件：update, ephemeral, reconnect]
         │
         ├─ 并发 invalidate 11 个 sync：
         │   sessionsSync, settingsSync, profileSync, purchasesSync,
         │   machinesSync, pushTokenSync, nativeUpdateSync,
         │   friendsSync, friendRequestsSync, artifactsSync, feedSync
         │
         └─ Promise.all([sessionsSync, machinesSync]).then(applyReady)
            │                                          [fire-and-forget，不阻塞 #init 返回]
            │
            ▼
         UI 渲染 (setInitState) ─── splash hide (100ms delay)
```

**关键路径**：`sodium.ready` → `Encryption.create` → `apiSocket.initialize` → `#init` invalidate

`#init` 本身不阻塞等待数据加载完成（restore 路径）。`applyReady()` 在 sessions + machines 都加载后才标记 `isDataReady=true`。

---

## 二、Session 列表加载

```
sessionsSync.invalidate()
   │
   └─ backoff(() => fetchSessions())
      │
      ├─ HTTP GET /v1/sessions                [无锁]
      │
      ├─ 每个 session:
      │   ├─ encryption.decryptEncryptionKey(dataEncryptionKey)  [libsodium box 解密]
      │   └─ → 得到 per-session AES key
      │
      ├─ encryption.initializeSessions(sessionKeys)  [创建 SessionEncryption 实例]
      │
      ├─ 每个 session:
      │   ├─ decryptMetadata()      [AES-GCM]
      │   └─ decryptAgentState()    [AES-GCM]
      │
      └─ applySessions() → Zustand set()       [UI 更新 session 列表]
```

**依赖链**：`auth token` → `Encryption` → `fetchSessions` → `decryptEncryptionKey` → `initializeSessions` → session 可用

---

## 三、会话内容加载（用户点击 session）

```
SessionView useLayoutEffect
   │
   └─ sync.onSessionVisible(sessionId)
      │
      ├─ messagesSync[sid].invalidate()     → fetchMessages(sid)
      ├─ gitStatusSync.invalidate(sid)      → fetchGitStatus(sid)
      └─ voiceHooks.onSessionFocus(sid)

fetchMessages(sid):
   │
   └─ sessionMessageLock[sid].inLock(async () => {
      │
      ├─ encryption.getSessionEncryption(sid)  [若 null → throw → backoff 重试]
      │
      ├── [首次加载，有缓存]:
      │    ├─ messageCache.load(sid)            [MMKV 本地缓存]
      │    ├─ applyMessages(sid, cached)        [直接写入 Zustand]
      │    ├─ applyMessagesLoaded(sid, true)
      │    └─ 增量获取 after_seq=cache.lastSeq  [HTTP 循环分页]
      │
      ├── [首次加载，无缓存]:
      │    ├─ HTTP GET /v3/.../messages?before_seq=999999999&limit=50
      │    ├─ decryptMessages()                [AES-GCM 批量解密]
      │    ├─ normalizeRawMessage() 每条       [Zod schema 验证]
      │    ├─ applyMessages(sid, normalized)   [直接写入 Zustand → UI 渲染]
      │    ├─ messageCache.save()
      │    └─ applyMessagesLoaded(sid, hasMore)
      │
      └── [后续刷新]:
           └─ 增量获取 after_seq=lastSeq       [HTTP 循环分页]
      })

      5 秒后: recheckMessages(sid) — 一致性校验
```

---

## 四、实时消息更新（WebSocket）

```
WS event: 'update' { t: 'new-message', sid, message }
   │
   └─ handleUpdate()
      │
      ├─ 解密 message.content (AES-GCM)
      │
      ├─ [Fast path: incomingSeq === lastSeq + 1]
      │    ├─ enqueueMessages(sid, [msg])     [推入队列]
      │    ├─ sessionLastSeq = incomingSeq
      │    ├─ messageCache.save()
      │    └─ gitStatusSync (仅 mutable tool)
      │
      └─ [Gap detected: seq 不连续]
           ├─ log: Fast path miss
           └─ messagesSync[sid].invalidate()  [触发 fetchMessages HTTP 补齐]
```

---

## 五、锁和同步原语清单

### AsyncLock 实例

| 锁 | 作用域 | 文件 | 持有时做什么 |
|----|--------|------|-------------|
| `sessionMessageLock[sid]` | per-session | `sync.ts:96` | fetchMessages / fetchOlder / recheckMessages / scheduleQueuedMessagesProcessing |
| `refreshLock` | per-session-cache | `suggestionFile.ts:40` | sessionRipgrep RPC |
| `lock` (fonts) | 全局 | `_layout.tsx:89` | Fonts.loadAsync |

### InvalidateSync 实例

| 名称 | 命令 | 文件 |
|------|------|------|
| `sessionsSync` | `fetchSessions` | `sync.ts:123` |
| `settingsSync` | `syncSettings` | `sync.ts:124` |
| `profileSync` | `fetchProfile` | `sync.ts:125` |
| `purchasesSync` | `syncPurchases` | `sync.ts:126` |
| `machinesSync` | `fetchMachines` | `sync.ts:127` |
| `pushTokenSync` | `registerPushToken` | `sync.ts:128` |
| `nativeUpdateSync` | `fetchNativeUpdate` | `sync.ts:132` |
| `friendsSync` | `fetchFriends` | `sync.ts:133` |
| `friendRequestsSync` | `fetchFriendRequests` | `sync.ts:134` |
| `artifactsSync` | `fetchArtifactsList` | `sync.ts:136` |
| `feedSync` | `fetchFeed` | `sync.ts:141` |
| `messagesSync[sid]` | `fetchMessages(sid)` | `sync.ts:260` (per-session, lazy) |
| `sendSync[sid]` | `flushOutbox(sid)` | `sync.ts:269` (per-session, lazy) |
| gitStatus per-project | `fetchGitStatusForProject` | `gitStatusSync.ts:48` |

### 死锁分析

**结论：无死锁。** 所有 `AsyncLock` 实例相互独立，没有嵌套获取锁的代码路径。

- `sessionMessageLock[sid]` — 仅在 `fetchMessages`、`fetchOlderMessages`、`recheckMessages`、`scheduleQueuedMessagesProcessing` 中获取，持有时不获取其他锁
- `refreshLock` — 仅在 `ensureCacheValid` 中获取，持有时调用 RPC（无锁）
- `InvalidateSync` 内部没有使用 `AsyncLock`，通过布尔标志序列化

### 已修复的伪死锁

原先 `fetchMessages` 在持有 `sessionMessageLock` 的同时调用 `enqueueMessages` → `scheduleQueuedMessagesProcessing` → `sessionMessageLock.inLock()`，导致消息排队到锁释放后才处理。但 `applyMessagesLoaded` 在锁内先执行并设置 `isLoaded=true`，造成 UI 看到空消息。

**已修复**：`fetchMessages` 内改为直接调用 `applyMessages`，不经过队列。

---

## 六、已知错误分析

### `FileSearchCache: Failed to fetch files RPC call failed`

**调用链**：
```
suggestionFile.ensureCacheValid()
  → sessionRipgrep(sid, ['--files', '--follow'])
    → apiSocket.sessionRPC(sid, 'ripgrep', ...)
      → socket.emitWithAck('rpc-call', {...})
        → 服务端转发到 CLI → CLI 不在线 → 服务端返回 { ok: false }
      → throw new Error('RPC call failed')
    → catch → return { success: false, error: 'RPC call failed' }
  → console.error('FileSearchCache: Failed to fetch files', 'RPC call failed')
```

**原因**：`suggestionFile.ts` 没有检查 session presence（CLI 是否在线），直接发送 RPC。Web 端或 CLI 离线时必然失败。

**影响**：
- 错误被 catch 且不抛出，锁正常释放
- 不阻塞 session 加载、消息同步等任何其他流程
- `@` 文件补全返回空结果，功能降级但不崩溃
- 每次触发补全都会重试（5 分钟缓存过期或缓存为空时），console 中持续输出错误

**对比 `gitStatusSync.ts` 的做法**：`gitStatusSync` 在 RPC 前检查 `session.presence !== 'online'` 并提前返回，避免无效 RPC。`suggestionFile.ts` 缺少此检查。

---

## 七、性能瓶颈排查方向

crypto 已排除（亚毫秒级），排查方向：

| 方向 | 排查方法 |
|------|---------|
| **网络延迟** | DevTools Network 面板，关注 `apiSocket.request()` 的 TTFB |
| **WebSocket 连接建立** | 检查 Socket.IO connect 事件时间，以及是否反复断连重连 |
| **`backoff` 重试** | Console 中搜索 `console.warn` 输出，`backoff` 失败时会 warn |
| **React 渲染** | React DevTools Profiler，关注 `ChatList` / `MessageView` 渲染次数和耗时 |
| **Zustand 级联更新** | `applyMessages` 每次调用都 `set()` 创建新 state，大批量消息时可能频繁触发 |
| **JSON.parse 大消息** | Agent 输出含大量 tool results 时，单条 JSON 可达几十 KB |
| **`recheckMessages` 5s 后触发** | 首次加载后 5 秒又发一轮 HTTP，无必要时浪费资源 |
