/**
 * Minimal persistence functions for happy CLI
 * 
 * Handles settings and private key storage in ~/.happy/ or local .happy/
 */

import { FileHandle } from 'node:fs/promises'
import { readFile, writeFile, mkdir, open, unlink, rename, stat } from 'node:fs/promises'
import { existsSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { constants } from 'node:fs'
import { configuration } from '@/configuration'
import * as z from 'zod';
import { encodeBase64 } from '@/api/encryption';
import { logger } from '@/ui/logger';

export const SandboxConfigSchema = z.object({
  enabled: z.boolean().default(false),
  workspaceRoot: z.string().optional(),
  sessionIsolation: z.enum(['strict', 'workspace', 'custom']).default('workspace'),
  customWritePaths: z.array(z.string()).default([]),
  denyReadPaths: z.array(z.string()).default(['~/.ssh', '~/.aws', '~/.gnupg']),
  extraWritePaths: z.array(z.string()).default(['/tmp']),
  denyWritePaths: z.array(z.string()).default(['.env']),
  networkMode: z.enum(['blocked', 'allowed', 'custom']).default('allowed'),
  allowedDomains: z.array(z.string()).default([]),
  deniedDomains: z.array(z.string()).default([]),
  allowLocalBinding: z.boolean().default(true),
});

export type SandboxConfig = z.infer<typeof SandboxConfigSchema>;

// Settings schema version: Integer for overall Settings structure compatibility
// Incremented when Settings structure changes (e.g., adding profiles array was v1→v2)
// Used for migration logic in readSettings()
export const SUPPORTED_SCHEMA_VERSION = 2;

interface Settings {
  schemaVersion: number
  onboardingCompleted: boolean
  machineId?: string
  machineIdConfirmedByServer?: boolean
  daemonAutoStartWhenRunningHappy?: boolean
  chromeMode?: boolean
  sandboxConfig?: SandboxConfig
  remoteTerminal?: {
    suppressEmoji?: boolean
    forceNoColor?: boolean
  }
}

const defaultSettings: Settings = {
  schemaVersion: SUPPORTED_SCHEMA_VERSION,
  onboardingCompleted: false,
  sandboxConfig: undefined,
}

/**
 * Migrate settings from old schema versions to current
 * Always backwards compatible - preserves all data
 */
function migrateSettings(raw: any, fromVersion: number): any {
  let migrated = { ...raw };

  // Future migrations go here:
  // if (fromVersion < 3) { ... }

  return migrated;
}

/**
 * Daemon state persisted locally (different from API DaemonState)
 * This is written to disk by the daemon to track its local process state
 */
export interface DaemonLocallyPersistedState {
  pid: number;
  httpPort: number;
  startTime: string;
  startedWithCliVersion: string;
  lastHeartbeat?: string;
  daemonLogPath?: string;
}

export async function readSettings(): Promise<Settings> {
  if (!existsSync(configuration.settingsFile)) {
    return { ...defaultSettings }
  }

  try {
    // Read raw settings
    const content = await readFile(configuration.settingsFile, 'utf8')
    const raw = JSON.parse(content)

    // Check schema version (default to 1 if missing)
    const schemaVersion = raw.schemaVersion ?? 1;

    // Warn if schema version is newer than supported
    if (schemaVersion > SUPPORTED_SCHEMA_VERSION) {
      logger.warn(
        `⚠️ Settings schema v${schemaVersion} > supported v${SUPPORTED_SCHEMA_VERSION}. ` +
        'Update happy-cli for full functionality.'
      );
    }

    // Migrate if needed
    const migrated = migrateSettings(raw, schemaVersion);

    if (migrated.sandboxConfig !== undefined) {
      try {
        migrated.sandboxConfig = SandboxConfigSchema.parse(migrated.sandboxConfig);
      } catch (error: any) {
        logger.warn(`⚠️ Invalid sandbox config - skipping. Error: ${error.message}`);
        migrated.sandboxConfig = undefined;
      }
    }

    // Merge with defaults to ensure all required fields exist
    return { ...defaultSettings, ...migrated };
  } catch (error: any) {
    logger.warn(`Failed to read settings: ${error.message}`);
    // Return defaults on any error
    return { ...defaultSettings }
  }
}

export async function writeSettings(settings: Settings): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true })
  }

  // Ensure schema version is set before writing
  const settingsWithVersion = {
    ...settings,
    schemaVersion: settings.schemaVersion ?? SUPPORTED_SCHEMA_VERSION
  };

  await writeFile(configuration.settingsFile, JSON.stringify(settingsWithVersion, null, 2))
}

/**
 * Atomically update settings with multi-process safety via file locking
 * @param updater Function that takes current settings and returns updated settings
 * @returns The updated settings
 */
export async function updateSettings(
  updater: (current: Settings) => Settings | Promise<Settings>
): Promise<Settings> {
  // Timing constants
  const LOCK_RETRY_INTERVAL_MS = 100;  // How long to wait between lock attempts
  const MAX_LOCK_ATTEMPTS = 50;        // Maximum number of attempts (5 seconds total)
  const STALE_LOCK_TIMEOUT_MS = 10000; // Consider lock stale after 10 seconds

  const lockFile = configuration.settingsFile + '.lock';
  const tmpFile = configuration.settingsFile + '.tmp';
  let fileHandle;
  let attempts = 0;

  // Acquire exclusive lock with retries
  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      // O_CREAT | O_EXCL | O_WRONLY = create exclusively, fail if exists
      fileHandle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        // Lock file exists, wait and retry
        attempts++;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));

        // Check for stale lock
        try {
          const stats = await stat(lockFile);
          if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
            await unlink(lockFile).catch(() => { });
          }
        } catch { }
      } else {
        throw err;
      }
    }
  }

  if (!fileHandle) {
    throw new Error(`Failed to acquire settings lock after ${MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS / 1000} seconds`);
  }

  try {
    // Read current settings with defaults
    const current = await readSettings() || { ...defaultSettings };

    // Apply update
    const updated = await updater(current);

    // Ensure directory exists
    if (!existsSync(configuration.happyHomeDir)) {
      await mkdir(configuration.happyHomeDir, { recursive: true });
    }

    // Write atomically using rename
    await writeFile(tmpFile, JSON.stringify(updated, null, 2));
    await rename(tmpFile, configuration.settingsFile); // Atomic on POSIX

    return updated;
  } finally {
    // Release lock
    await fileHandle.close();
    await unlink(lockFile).catch(() => { }); // Remove lock file
  }
}

//
// Authentication
//

const credentialsSchema = z.object({
  token: z.string(),
  secret: z.string().base64().nullish(), // Legacy
  encryption: z.object({
    publicKey: z.string().base64(),
    machineKey: z.string().base64()
  }).nullish()
})

export type Credentials = {
  token: string,
  encryption: {
    type: 'legacy', secret: Uint8Array
  } | {
    type: 'dataKey', publicKey: Uint8Array, machineKey: Uint8Array
  }
}

export async function readCredentials(): Promise<Credentials | null> {
  if (!existsSync(configuration.privateKeyFile)) {
    return null
  }
  try {
    const keyBase64 = (await readFile(configuration.privateKeyFile, 'utf8'));
    const credentials = credentialsSchema.parse(JSON.parse(keyBase64));
    if (credentials.secret) {
      return {
        token: credentials.token,
        encryption: {
          type: 'legacy',
          secret: new Uint8Array(Buffer.from(credentials.secret, 'base64'))
        }
      };
    } else if (credentials.encryption) {
      return {
        token: credentials.token,
        encryption: {
          type: 'dataKey',
          publicKey: new Uint8Array(Buffer.from(credentials.encryption.publicKey, 'base64')),
          machineKey: new Uint8Array(Buffer.from(credentials.encryption.machineKey, 'base64'))
        }
      }
    }
  } catch {
    return null
  }
  return null
}

export async function writeCredentialsLegacy(credentials: { secret: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true })
  }
  await writeFile(configuration.privateKeyFile, JSON.stringify({
    secret: encodeBase64(credentials.secret),
    token: credentials.token
  }, null, 2));
}

export async function writeCredentialsDataKey(credentials: { publicKey: Uint8Array, machineKey: Uint8Array, token: string }): Promise<void> {
  if (!existsSync(configuration.happyHomeDir)) {
    await mkdir(configuration.happyHomeDir, { recursive: true })
  }
  await writeFile(configuration.privateKeyFile, JSON.stringify({
    encryption: { publicKey: encodeBase64(credentials.publicKey), machineKey: encodeBase64(credentials.machineKey) },
    token: credentials.token
  }, null, 2));
}

export async function clearCredentials(): Promise<void> {
  if (existsSync(configuration.privateKeyFile)) {
    await unlink(configuration.privateKeyFile);
  }
}

export async function clearMachineId(): Promise<void> {
  await updateSettings(settings => ({
    ...settings,
    machineId: undefined
  }));
}

/**
 * Read daemon state from local file
 */
export async function readDaemonState(): Promise<DaemonLocallyPersistedState | null> {
  try {
    if (!existsSync(configuration.daemonStateFile)) {
      return null;
    }
    const content = await readFile(configuration.daemonStateFile, 'utf-8');
    return JSON.parse(content) as DaemonLocallyPersistedState;
  } catch (error) {
    // State corrupted somehow :(
    console.error(`[PERSISTENCE] Daemon state file corrupted: ${configuration.daemonStateFile}`, error);
    return null;
  }
}

/**
 * Write daemon state to local file (synchronously for atomic operation)
 */
export function writeDaemonState(state: DaemonLocallyPersistedState): void {
  writeFileSync(configuration.daemonStateFile, JSON.stringify(state, null, 2), 'utf-8');
}

/**
 * Clean up daemon state file and lock file
 */
export async function clearDaemonState(): Promise<void> {
  if (existsSync(configuration.daemonStateFile)) {
    await unlink(configuration.daemonStateFile);
  }
  // Also clean up lock file if it exists (for stale cleanup)
  if (existsSync(configuration.daemonLockFile)) {
    try {
      await unlink(configuration.daemonLockFile);
    } catch {
      // Lock file might be held by running daemon, ignore error
    }
  }
}

/**
 * Acquire an exclusive lock file for the daemon.
 * The lock file proves the daemon is running and prevents multiple instances.
 * Returns the file handle to hold for the daemon's lifetime, or null if locked.
 */
export async function acquireDaemonLock(
  maxAttempts: number = 5,
  delayIncrementMs: number = 200
): Promise<FileHandle | null> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      // O_EXCL ensures we only create if it doesn't exist (atomic lock acquisition)
      const fileHandle = await open(
        configuration.daemonLockFile,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY
      );
      // Write PID to lock file for debugging
      await fileHandle.writeFile(String(process.pid));
      return fileHandle;
    } catch (error: any) {
      if (error.code === 'EEXIST') {
        // Lock file exists, check if process is still running
        try {
          const lockPid = readFileSync(configuration.daemonLockFile, 'utf-8').trim();
          if (lockPid && !isNaN(Number(lockPid))) {
            try {
              process.kill(Number(lockPid), 0); // Check if process exists
            } catch {
              // Process doesn't exist, remove stale lock
              unlinkSync(configuration.daemonLockFile);
              continue; // Retry acquisition
            }
          }
        } catch {
          // Can't read lock file, might be corrupted
        }
      }

      if (attempt === maxAttempts) {
        return null;
      }
      const delayMs = attempt * delayIncrementMs;
      await new Promise(resolve => setTimeout(resolve, delayMs));
    }
  }
  return null;
}

/**
 * Release daemon lock by closing handle and deleting lock file
 */
export async function releaseDaemonLock(lockHandle: FileHandle): Promise<void> {
  try {
    await lockHandle.close();
  } catch { }

  try {
    if (existsSync(configuration.daemonLockFile)) {
      unlinkSync(configuration.daemonLockFile);
    }
  } catch { }
}

//
// Session Mapping (agentSessionId -> happySessionId)
//

export interface SessionMappingEntry {
  happySessionId: string;
  createdAt: string;
  lastUsedAt: string;
  flavor: string;
}

export interface SessionMappingFile {
  mappings: Record<string, SessionMappingEntry>;
}

/**
 * Read session mapping from local file.
 * Returns empty mappings if file is missing or corrupted.
 */
export async function readSessionMapping(): Promise<SessionMappingFile> {
  try {
    if (!existsSync(configuration.sessionMappingFile)) {
      return { mappings: {} };
    }
    const content = await readFile(configuration.sessionMappingFile, 'utf-8');
    const parsed = JSON.parse(content);
    if (parsed && typeof parsed.mappings === 'object') {
      return parsed as SessionMappingFile;
    }
    return { mappings: {} };
  } catch {
    return { mappings: {} };
  }
}

/**
 * Atomically update session mapping with multi-process safety via file locking.
 * Uses the same lock pattern as updateSettings.
 */
export async function updateSessionMapping(
  updater: (current: SessionMappingFile) => SessionMappingFile
): Promise<SessionMappingFile> {
  const LOCK_RETRY_INTERVAL_MS = 100;
  const MAX_LOCK_ATTEMPTS = 50;
  const STALE_LOCK_TIMEOUT_MS = 10000;

  const lockFile = configuration.sessionMappingLockFile;
  const tmpFile = configuration.sessionMappingFile + '.tmp';
  let fileHandle: FileHandle | undefined;
  let attempts = 0;

  while (attempts < MAX_LOCK_ATTEMPTS) {
    try {
      fileHandle = await open(lockFile, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY);
      break;
    } catch (err: any) {
      if (err.code === 'EEXIST') {
        attempts++;
        await new Promise(resolve => setTimeout(resolve, LOCK_RETRY_INTERVAL_MS));
        try {
          const stats = await stat(lockFile);
          if (Date.now() - stats.mtimeMs > STALE_LOCK_TIMEOUT_MS) {
            await unlink(lockFile).catch(() => { });
          }
        } catch { }
      } else {
        throw err;
      }
    }
  }

  if (!fileHandle) {
    throw new Error(`Failed to acquire session mapping lock after ${MAX_LOCK_ATTEMPTS * LOCK_RETRY_INTERVAL_MS / 1000} seconds`);
  }

  try {
    const current = await readSessionMapping();
    const updated = updater(current);

    if (!existsSync(configuration.happyHomeDir)) {
      await mkdir(configuration.happyHomeDir, { recursive: true });
    }

    await writeFile(tmpFile, JSON.stringify(updated, null, 2));
    await rename(tmpFile, configuration.sessionMappingFile);

    return updated;
  } finally {
    await fileHandle.close();
    await unlink(lockFile).catch(() => { });
  }
}

/**
 * Register a binding between an agent session ID (Claude/Codex) and a Happy session ID.
 * Idempotent: updates lastUsedAt if the binding already exists for the same happySessionId.
 * Refuses to overwrite if the agent session is already bound to a different Happy session.
 */
export async function registerSessionMapping(
  agentSessionId: string,
  happySessionId: string,
  flavor: string
): Promise<void> {
  await updateSessionMapping((current) => {
    const existing = current.mappings[agentSessionId];
    if (existing && existing.happySessionId !== happySessionId) {
      logger.debug(`[PERSISTENCE] Session mapping conflict: agent=${agentSessionId} already bound to happy=${existing.happySessionId}, refusing rebind to ${happySessionId}`);
      return current;
    }

    const now = new Date().toISOString();
    return {
      mappings: {
        ...current.mappings,
        [agentSessionId]: {
          happySessionId,
          createdAt: existing?.createdAt ?? now,
          lastUsedAt: now,
          flavor,
        },
      },
    };
  });
}

/**
 * Look up which Happy session an agent session ID is bound to.
 * Returns null if no mapping exists.
 */
export async function lookupHappySessionForAgent(agentSessionId: string): Promise<string | null> {
  const mapping = await readSessionMapping();
  const entry = mapping.mappings[agentSessionId];
  return entry?.happySessionId ?? null;
}

/**
 * Remove session mapping entries older than maxAgeMs.
 * Returns the number of pruned entries.
 */
export async function pruneSessionMappings(maxAgeMs: number = 30 * 24 * 60 * 60 * 1000): Promise<number> {
  const cutoff = Date.now() - maxAgeMs;
  let pruned = 0;

  await updateSessionMapping((current) => {
    const remaining: Record<string, SessionMappingEntry> = {};
    for (const [key, entry] of Object.entries(current.mappings)) {
      const lastUsed = new Date(entry.lastUsedAt).getTime();
      if (isNaN(lastUsed) || lastUsed < cutoff) {
        pruned++;
      } else {
        remaining[key] = entry;
      }
    }
    return { mappings: remaining };
  });

  return pruned;
}

