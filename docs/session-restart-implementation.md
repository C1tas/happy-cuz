# Session Restart: Implementation & Code Flow

## Overview

Session restart allows users to stop a running (or reconnect a disconnected) CLI agent process and relaunch it with the same Happy session, preserving conversation history and encryption context. This is achieved by reusing the existing Happy session ID instead of creating a new one.

Key goals:
- Reuse the **same Happy session** (same encryption key, same message history)
- Resume the **same Claude/Codex backend session** via `--resume`
- Preserve permission mode, model mode, and other local settings
- Provide staged progress UI feedback
- Support both online (connected) and offline (disconnected) sessions

---

## Architecture: Three-Stack Flow

```
┌──────────────┐     RPC: stop-session      ┌──────────────┐
│   happy-app   │ ───────────────────────────▶│   daemon      │──▶ kill(pid)
│  (React Native)│     RPC: resume-session     │ (happy-cli)  │──▶ spawnTrackedHappyProcess()
│               │ ◀──────────────────────────│               │
└──────┬───────┘                              └──────┬───────┘
       │                                             │
       │  WebSocket: update-metadata                 │ CLI: --happy-session-id <id>
       │                                             │      --resume <claudeSessionId>
       ▼                                             ▼
┌──────────────┐                              ┌──────────────┐
│ happy-server  │                              │  new CLI proc │
│  (Fastify)    │ ◀─ socket ──────────────────│  (runClaude)  │
│               │   update-metadata + active:true              │
└──────────────┘                              └──────────────┘
```

---

## Code Flow: Step by Step

### 1. App: User taps "Restart Session"

**File:** `packages/happy-app/sources/hooks/useSessionQuickActions.ts`

`getRestartAvailability()` gates the button — requires `machineId`, backend session ID (`claudeSessionId` or `codexThreadId`), machine online, and daemon RPC available. Unlike resume, the `isConnected` gate is **removed** so both online and offline sessions can be restarted.

```
getRestartAvailability(session, machine, isConnected)
  → machineId? → backendId? → machineOnline? → rpcAvailable?
  → { canRestart: true }
```

### 2. App: Staged Progress Modal

**File:** `packages/happy-app/sources/components/RestartProgressModal.tsx`

`performRestart` opens a `RestartProgressModal` via `Modal.show()`. The modal and the async flow communicate through module-level functions:

- `updateRestartStage(stage)` — pushes stage updates to React state
- `requestRestartConfirmation(state)` — returns `Promise<boolean>`, pauses the async flow until user confirms/cancels

```
performRestart()
  ├─ Modal.show(RestartProgressModal) → modalId
  ├─ Stage: checking
  ├─ if (isConnected):
  │   ├─ requestRestartConfirmation(state) → await user confirm/cancel
  │   ├─ Stage: stopping (PID + sessionId)
  │   ├─ machineStopSession(machineId, sessionId) → daemon RPC
  │   ├─ Stage: stopped
  │   └─ wait 1.5s (process cleanup)
  ├─ Stage: starting
  ├─ machineResumeSession({ machineId, sessionId }) → daemon RPC
  ├─ Stage: started
  ├─ Stage: loading
  ├─ sync.refreshSessions() (up to 3 attempts)
  ├─ preserve permissionMode, modelMode
  ├─ Modal.hide(modalId)
  └─ navigateToSession(resultSessionId)
```

Backdrop dismiss is blocked during in-progress stages via `guardedOnClose` — only allowed during `confirm_active` and `error` stages. `HappyError` is caught and shown inline in the modal error stage (not re-thrown to avoid double-modal from `useHappyAction`).

### 3. Daemon: Stop + Resume

**File:** `packages/happy-cli/src/daemon/run.ts`

`stopSession(sessionId)` finds the tracked process by Happy session ID and sends SIGTERM.

`resumeSession(happySessionId)` does:

```
resumeSession(happySessionId)
  ├─ resolveHappySession(happySessionId)      // GET /v1/sessions, decrypt metadata
  ├─ buildResumeLaunch(previousSession, {
  │     startedBy: 'daemon',
  │     claudeStartingMode: 'remote',
  │     happySessionId: previousSession.id,    // ← KEY: pass Happy session ID
  │     dangerouslySkipPermissions: metadata.dangerouslySkipPermissions ?? true,
  │   })
  ├─ fs.access(launch.cwd)                    // validate working directory
  └─ spawnTrackedHappyProcess(args, cwd, env)
```

### 4. CLI args: `buildResumeLaunch`

**File:** `packages/happy-cli/src/resume/handleResumeCommand.ts`

Constructs CLI arguments for the new process:

```
claude
  --happy-starting-mode remote
  --started-by daemon
  --happy-session-id <happySessionId>          // ← NEW: reconnect to existing session
  --dangerously-skip-permissions               // ← NEW: preserve permission mode
  --resume <claudeSessionId>                   // resume Claude conversation
```

### 5. CLI: `index.ts` arg parsing

**File:** `packages/happy-cli/src/index.ts`

New arg `--happy-session-id` is parsed and passed to `options.happySessionId`:

```typescript
} else if (arg === '--happy-session-id') {
    options.happySessionId = args[++i]
}
```

### 6. CLI: `runClaude` session reconnection

**File:** `packages/happy-cli/src/claude/runClaude.ts`

The critical branching point — reconnect to existing session vs create new:

```
runClaude(credentials, options)
  ├─ if options.happySessionId:
  │     reconnectToExistingSession(happySessionId)  // reuse encryption key
  │   else:
  │     api.getOrCreateSession({ tag: randomUUID(), metadata, state })
  ├─ session = api.sessionSyncClient(response)      // single instance for ALL operations
  ├─ if reconnected: session.updateMetadata(() => metadata)  // push fresh metadata
  ├─ extractSDKMetadataAsync → session.updateMetadata(...)   // tools, slashCommands
  └─ start claude loop with session
```

### 7. CLI: `reconnectToExistingSession`

**File:** `packages/happy-cli/src/resume/resolveHappySession.ts`

Fetches session from server, recovers encryption key:

```
reconnectToExistingSession(sessionId)
  ├─ readAgentCredentials()                          // ~/.happy/local-credentials.json
  ├─ GET /v1/sessions → all sessions (encrypted)
  ├─ resolveSessionRecordByPrefix(sessions, sessionId)
  ├─ resolveSessionEncryption(matched, credentials)
  │     if dataEncryptionKey:
  │       decryptBoxBundle(encrypted.slice(1), secretKey)  // asymmetric decrypt
  │     else:
  │       use legacy shared secret
  ├─ decryptSessionMetadata(matched, credentials)
  └─ return { id, seq, encryptionKey, encryptionVariant, metadata, metadataVersion, agentState: null, agentStateVersion }
```

### 8. Server: Session Reactivation

**File:** `packages/happy-server/sources/app/api/socket/sessionUpdateHandler.ts`

When the reconnected CLI pushes fresh metadata via `update-metadata`, the server sets `active: true` on the DB record. This reactivates the session after the old process sent `session-end` (which set `active: false`).

The version check (`metadataVersion === expectedVersion`) prevents stale clients from accidentally reactivating — only the client with the current version can update.

---

## Session Metadata Additions

### CLI-side (`packages/happy-cli/src/api/types.ts`)

```typescript
gitCommitHash?: string | null    // Git commit hash of the CLI build
```

### App-side (`packages/happy-app/sources/sync/storageTypes.ts`)

```typescript
gitCommitHash: z.string().nullish()
```

Populated in `runClaude` metadata:

```typescript
metadata = {
    ...
    dangerouslySkipPermissions,      // boolean — permission mode
    gitCommitHash: getGitCommitHash() ?? null,  // e.g. "abc1234"
}
```

Displayed in session info as `version (commitHash)`.

---

## Key Design Decisions

### Why reuse the Happy session ID (not create a new one)?

Each Happy session has a unique **encryption key** (`dataEncryptionKey`). If a new session is created:
- New encryption key is generated
- Old messages encrypted with the old key become unreadable
- App cannot load conversation history

By reconnecting to the existing session, we decrypt the existing `dataEncryptionKey` and continue using it for all message operations.

### Why a single `ApiSessionClient` instance?

`api.sessionSyncClient(response)` creates a new `ApiSessionClient` with its own socket, version counters, and lock. Multiple instances for the same session cause:
- Independent `metadataVersion` tracking → version-mismatch conflicts
- Multiple socket connections to the same session
- Concurrent metadata updates racing through different locks

Solution: create one instance at `const session = api.sessionSyncClient(response)` and use it for all subsequent operations (reconnect metadata push, SDK metadata extraction, and the main loop).

### Why block backdrop dismiss during restart?

The restart operation is **non-cancellable** once it starts — `machineStopSession` and `machineResumeSession` are fire-and-forget RPC calls. If the user taps the backdrop:
- The modal disappears
- The async operation continues silently
- `useHappyAction`'s `loadingRef` stays `true`, blocking further actions
- No UI feedback for the ongoing/completed operation

Solution: `guardedOnClose` only allows dismiss during `confirm_active` (user choice) and `error` (terminal state) stages.

### Why `active: true` in `update-metadata` is safe?

- **Deleted sessions:** hard-deleted from DB → `findUnique` returns null → handler exits early
- **Stale clients:** must match `metadataVersion` (optimistic concurrency) → stale version rejected
- **Race with `session-end`:** the new process starts 1.5s after the old one stops; `session-end` runs first, then the new process's `update-metadata` correctly reactivates

---

## Known Limitations & Edge Cases

1. **`agentState: null` on reconnect** — `reconnectToExistingSession` returns `agentState: null`. Any pre-existing agent state (e.g., `controlledByUser`) is overwritten on first `updateAgentState`. Acceptable because the new process has fresh state.

2. **Double session list fetch** — daemon's `resolveHappySession` and CLI's `reconnectToExistingSession` both fetch `GET /v1/sessions`. No caching between the two calls. Could be optimized by passing encrypted session data through CLI args, but adds complexity.

3. **`dangerouslySkipPermissions` defaults to `true`** — for legacy sessions missing this field. This matches the project's default behavior where daemon-managed remote sessions run without permission prompts.

4. **Polling retry (3 × 150ms)** — after `machineResumeSession` returns, the app polls `sync.refreshSessions()` up to 3 times. If session propagation takes longer than ~450ms, navigation may briefly show stale state. Acceptable for typical latency.

---

## Resume Fallback: Missing JSONL Recovery

### Problem

When `--resume <claudeSessionId>` is passed but the JSONL file doesn't exist (session archived, different machine, file deleted), the CLI previously entered an infinite retry loop:

```
Loop iteration N:
  claudeRemote({ claudeArgs: ['--resume', 'cd4f58a1-...'] })
    → SDK: error_during_execution "No conversation found"
    → catch: sendSessionEvent('Process exited unexpectedly')
    → consumeOneTimeFlags() NOT CALLED → --resume persists
    → continue → same error on iteration N+1 → ∞
```

### Fix

`consumeOneTimeFlags()` is now called on the **error path** in both `claudeRemoteLauncher.ts` and `claudeLocalLauncher.ts`. This strips `--resume` and its argument from `session.claudeArgs`, so the next loop iteration starts a fresh Claude session in the same project directory.

Additionally, the generic "Process exited unexpectedly" is replaced with a classified error event carrying full detail:

```typescript
session.client.sendSessionEvent({
    type: 'error',
    source: 'claude',   // classified by SDK result or error message pattern
    detail: 'No conversation found with session ID: cd4f58a1-...'
});
session.consumeOneTimeFlags(); // strips --resume flag
```

The error appears in the App chat as red text (untruncated), providing full visibility. Restart errors from `useSessionQuickActions.ts` are also injected into the chat via `sync.injectLocalEvent()`.

See [Error Handling & Resume Fallback](./error-handling-and-resume-fallback.md) for the full implementation reference.
