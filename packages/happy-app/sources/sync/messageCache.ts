/**
 * Message cache module
 * Caches decrypted messages in MMKV for instant session loading + incremental sync.
 *
 * Cache level: DecryptedMessage (post-decrypt, pre-normalize)
 * - Skips decryption on cache hit
 * - Reducer always re-runs so logic changes auto-apply
 * - Retains seq for pagination cursors
 */

import { MMKV } from 'react-native-mmkv';
import { DecryptedMessage } from './storageTypes';

interface CachedMessage {
    id: string;
    seq: number;
    localId: string | null;
    createdAt: number;
    content: any;
}

interface CachedSessionData {
    version: 1;
    lastSeq: number;
    oldestSeq: number;
    lastAccessedAt: number;
    messages: CachedMessage[];
}

const MAX_MESSAGES = 500;
const MAX_SESSIONS = 50;
const DEBOUNCE_MS = 2000;
const KEY_PREFIX = 'mc:';

const mmkv = new MMKV({ id: 'message-cache' });

class MessageCache {
    // In-memory cache to avoid repeated MMKV reads + JSON.parse
    private memCache = new Map<string, CachedSessionData>();
    // Dirty sessions that need flushing to MMKV
    private dirty = new Set<string>();
    // Debounce timer
    private debounceTimer: ReturnType<typeof setTimeout> | null = null;

    /**
     * Load cached messages for a session.
     * Returns null if no cache or cache is corrupted.
     */
    load(sessionId: string): CachedSessionData | null {
        // Check memory first
        const mem = this.memCache.get(sessionId);
        if (mem) {
            mem.lastAccessedAt = Date.now();
            return mem;
        }

        // Try MMKV
        const raw = mmkv.getString(KEY_PREFIX + sessionId);
        if (!raw) return null;

        try {
            const data = JSON.parse(raw) as CachedSessionData;
            if (data.version !== 1 || !Array.isArray(data.messages)) {
                return null;
            }
            data.lastAccessedAt = Date.now();
            this.memCache.set(sessionId, data);
            return data;
        } catch {
            // Corrupted cache — remove it
            mmkv.delete(KEY_PREFIX + sessionId);
            return null;
        }
    }

    /**
     * Save decrypted messages into cache for a session.
     * Merges with existing cache by id, sorts by seq, trims to MAX_MESSAGES.
     * Writing to MMKV is debounced.
     */
    save(sessionId: string, decryptedMessages: DecryptedMessage[]): void {
        // Filter out messages without seq (optimistic sends not confirmed yet)
        const toCache: CachedMessage[] = [];
        for (const msg of decryptedMessages) {
            if (msg.seq === null) continue;
            toCache.push({
                id: msg.id,
                seq: msg.seq,
                localId: msg.localId,
                createdAt: msg.createdAt,
                content: msg.content,
            });
        }
        if (toCache.length === 0) return;

        const existing = this.load(sessionId);
        let messages: CachedMessage[];

        if (existing) {
            // Merge: dedupe by id
            const byId = new Map<string, CachedMessage>();
            for (const m of existing.messages) {
                byId.set(m.id, m);
            }
            for (const m of toCache) {
                byId.set(m.id, m);
            }
            messages = Array.from(byId.values());
        } else {
            messages = toCache;
        }

        // Sort by seq ascending
        messages.sort((a, b) => a.seq - b.seq);

        // Trim to MAX_MESSAGES — keep newest
        if (messages.length > MAX_MESSAGES) {
            messages = messages.slice(messages.length - MAX_MESSAGES);
        }

        const lastSeq = messages[messages.length - 1].seq;
        const oldestSeq = messages[0].seq;

        const data: CachedSessionData = {
            version: 1,
            lastSeq,
            oldestSeq,
            lastAccessedAt: Date.now(),
            messages,
        };

        this.memCache.set(sessionId, data);
        this.dirty.add(sessionId);
        this.scheduleFlush();

        // LRU eviction for global session count
        this.evictIfNeeded();
    }

    /**
     * Clear cache for a single session.
     */
    clearSession(sessionId: string): void {
        this.memCache.delete(sessionId);
        this.dirty.delete(sessionId);
        mmkv.delete(KEY_PREFIX + sessionId);
    }

    /**
     * Clear all cached messages.
     */
    clearAll(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        this.memCache.clear();
        this.dirty.clear();
        mmkv.clearAll();
    }

    /**
     * Immediately write all dirty sessions to MMKV.
     */
    flush(): void {
        if (this.debounceTimer) {
            clearTimeout(this.debounceTimer);
            this.debounceTimer = null;
        }
        for (const sessionId of this.dirty) {
            const data = this.memCache.get(sessionId);
            if (data) {
                mmkv.set(KEY_PREFIX + sessionId, JSON.stringify(data));
            }
        }
        this.dirty.clear();
    }

    private scheduleFlush(): void {
        if (this.debounceTimer) return;
        this.debounceTimer = setTimeout(() => {
            this.debounceTimer = null;
            this.flush();
        }, DEBOUNCE_MS);
    }

    private evictIfNeeded(): void {
        const allKeys = mmkv.getAllKeys().filter(k => k.startsWith(KEY_PREFIX));
        // Include in-memory dirty sessions that haven't been flushed yet
        const sessionIds = new Set<string>();
        for (const k of allKeys) {
            sessionIds.add(k.slice(KEY_PREFIX.length));
        }
        for (const sid of this.memCache.keys()) {
            sessionIds.add(sid);
        }

        if (sessionIds.size <= MAX_SESSIONS) return;

        // Collect lastAccessedAt for all sessions
        const entries: { sessionId: string; lastAccessedAt: number }[] = [];
        for (const sid of sessionIds) {
            const mem = this.memCache.get(sid);
            if (mem) {
                entries.push({ sessionId: sid, lastAccessedAt: mem.lastAccessedAt });
            } else {
                const raw = mmkv.getString(KEY_PREFIX + sid);
                if (raw) {
                    try {
                        const data = JSON.parse(raw) as CachedSessionData;
                        entries.push({ sessionId: sid, lastAccessedAt: data.lastAccessedAt });
                    } catch {
                        // Corrupted — evict immediately
                        mmkv.delete(KEY_PREFIX + sid);
                    }
                }
            }
        }

        // Sort by lastAccessedAt ascending (oldest first)
        entries.sort((a, b) => a.lastAccessedAt - b.lastAccessedAt);

        // Evict oldest until we're within limit
        const toEvict = entries.length - MAX_SESSIONS;
        for (let i = 0; i < toEvict; i++) {
            const sid = entries[i].sessionId;
            this.memCache.delete(sid);
            this.dirty.delete(sid);
            mmkv.delete(KEY_PREFIX + sid);
        }
    }
}

export const messageCache = new MessageCache();
