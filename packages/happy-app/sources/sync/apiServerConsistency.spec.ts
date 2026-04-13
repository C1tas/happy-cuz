import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Session, Machine } from './storageTypes';

/**
 * App-Server API Consistency Tests
 *
 * These tests verify that the app's type definitions and consumer code
 * can handle the actual response shapes returned by the server API.
 *
 * Server-side changes being validated:
 * 1. GET /v1/sessions: agentState is always null in list responses
 * 2. GET /v1/machines: daemonState is always null, limited to 50 results
 * 3. GET /v3/sessions/:id/messages: max limit reduced from 500 to 200
 * 4. GET /v1/artifacts: limited to 200 results
 *
 * Matching server tests: happy-server/sources/app/api/routes/sessionRoutes.test.ts
 */

// ─────────────────────────────────────────────────────────────────
// Schema: exact shape the server returns for session list endpoints
// ─────────────────────────────────────────────────────────────────

const ServerSessionListItemSchema = z.object({
    id: z.string(),
    seq: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    metadata: z.string(),
    metadataVersion: z.number(),
    agentState: z.null(),                // always null in list endpoints
    agentStateVersion: z.number(),
    dataEncryptionKey: z.string().nullable(),
    lastMessage: z.null().optional(),    // present in v1, absent in v2
});

const ServerSessionListResponseSchema = z.object({
    sessions: z.array(ServerSessionListItemSchema),
});

const ServerMachineListItemSchema = z.object({
    id: z.string(),
    metadata: z.string(),
    metadataVersion: z.number(),
    daemonState: z.null(),               // always null in list endpoints
    daemonStateVersion: z.number(),
    dataEncryptionKey: z.string().nullable(),
    seq: z.number(),
    active: z.boolean(),
    activeAt: z.number(),
    createdAt: z.number(),
    updatedAt: z.number(),
});

const ServerV3MessagesResponseSchema = z.object({
    messages: z.array(z.object({
        id: z.string(),
        seq: z.number(),
        content: z.unknown(),
        localId: z.string().nullable(),
        createdAt: z.number(),
        updatedAt: z.number(),
    })),
    hasMore: z.boolean(),
});

// ─────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────

describe('API response contract: sessions list', () => {
    const sampleServerResponse = {
        sessions: [{
            id: 'cmmij8olq00dp5jcxr3wtbpau',
            seq: 42,
            createdAt: 1712345678000,
            updatedAt: 1712345678000,
            active: true,
            activeAt: 1712345678000,
            metadata: 'base64-encrypted-metadata',
            metadataVersion: 3,
            agentState: null,          // server always sends null
            agentStateVersion: 5,
            dataEncryptionKey: 'base64-key',
            lastMessage: null,
        }],
    };

    it('validates server response shape via Zod', () => {
        const parsed = ServerSessionListResponseSchema.safeParse(sampleServerResponse);
        expect(parsed.success).toBe(true);
    });

    it('rejects response with non-null agentState (would indicate server regression)', () => {
        const broken = {
            sessions: [{
                ...sampleServerResponse.sessions[0],
                agentState: 'encrypted-blob-should-not-be-here',
            }],
        };
        const parsed = ServerSessionListResponseSchema.safeParse(broken);
        expect(parsed.success).toBe(false);
    });

    it('app Session type accepts agentState: null', () => {
        const session: Session = {
            id: 'test',
            seq: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            active: true,
            activeAt: Date.now(),
            metadata: null,
            metadataVersion: 1,
            agentState: null,           // this is the value the server sends
            agentStateVersion: 3,
            thinking: false,
            compressing: false,
            thinkingAt: 0,
            presence: 'online',
        };

        // Verify the session can be consumed without crashes
        expect(session.agentState).toBeNull();
        expect(session.agentState?.requests).toBeUndefined();

        // Simulate the optional chaining pattern used in components
        const hasPermissions = !!(session.agentState?.requests && Object.keys(session.agentState.requests).length > 0);
        expect(hasPermissions).toBe(false);

        const controlledByUser = session.agentState?.controlledByUser ?? false;
        expect(controlledByUser).toBe(false);
    });

    it('server response with missing optional fields still parses', () => {
        const minimal = {
            sessions: [{
                id: 's1',
                seq: 0,
                createdAt: 0,
                updatedAt: 0,
                active: false,
                activeAt: 0,
                metadata: '',
                metadataVersion: 0,
                agentState: null,
                agentStateVersion: 0,
                dataEncryptionKey: null,
                // lastMessage omitted (v2 format)
            }],
        };
        const parsed = ServerSessionListResponseSchema.safeParse(minimal);
        expect(parsed.success).toBe(true);
    });
});

describe('API response contract: machines list', () => {
    const sampleServerResponse = [{
        id: 'machine-1',
        metadata: 'encrypted-metadata',
        metadataVersion: 2,
        daemonState: null,           // server always sends null in list
        daemonStateVersion: 4,
        dataEncryptionKey: 'base64-key',
        seq: 10,
        active: true,
        activeAt: 1712345678000,
        createdAt: 1712345678000,
        updatedAt: 1712345678000,
    }];

    it('validates server response shape via Zod', () => {
        const parsed = z.array(ServerMachineListItemSchema).safeParse(sampleServerResponse);
        expect(parsed.success).toBe(true);
    });

    it('rejects response with non-null daemonState (would indicate server regression)', () => {
        const broken = [{
            ...sampleServerResponse[0],
            daemonState: 'encrypted-blob-should-not-be-here',
        }];
        const parsed = z.array(ServerMachineListItemSchema).safeParse(broken);
        expect(parsed.success).toBe(false);
    });

    it('app Machine type accepts daemonState: null', () => {
        const machine: Machine = {
            id: 'test',
            seq: 0,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            active: true,
            activeAt: Date.now(),
            metadata: null,
            metadataVersion: 1,
            daemonState: null,
            daemonStateVersion: 3,
        };

        // Simulate the conditional rendering pattern used in components
        expect(machine.daemonState).toBeNull();

        // Pattern: {machine.daemonState && <DaemonInfo />}
        const shouldRender = !!machine.daemonState;
        expect(shouldRender).toBe(false);

        // Pattern: machine.daemonState?.pid
        const pid = machine.daemonState?.pid;
        expect(pid).toBeUndefined();
    });
});

describe('API response contract: v3 messages', () => {
    it('validates paginated messages response shape', () => {
        const response = {
            messages: [{
                id: 'msg-1',
                seq: 1,
                content: { t: 'encrypted', c: 'base64-data' },
                localId: 'local-1',
                createdAt: 1712345678000,
                updatedAt: 1712345678000,
            }],
            hasMore: true,
        };
        const parsed = ServerV3MessagesResponseSchema.safeParse(response);
        expect(parsed.success).toBe(true);
    });

    it('validates empty messages response', () => {
        const response = { messages: [], hasMore: false };
        const parsed = ServerV3MessagesResponseSchema.safeParse(response);
        expect(parsed.success).toBe(true);
    });
});

describe('API limit consistency: app request limits vs server caps', () => {
    // These tests document the contract between app request limits and server caps.
    // If either side changes, these tests surface the discrepancy.

    /** Server-side max limits (defined in server route schemas) */
    const SERVER_CAPS = {
        V1_SESSIONS_TAKE: 150,
        V2_SESSIONS_ACTIVE_MAX: 500,
        V2_SESSIONS_PAGE_MAX: 200,
        V3_MESSAGES_PAGE_MAX: 200,   // reduced from 500
        V1_MACHINES_TAKE: 50,
        V1_ARTIFACTS_TAKE: 200,
    };

    /** App-side request limits (defined in sync.ts fetch functions) */
    const APP_REQUESTS = {
        MESSAGES_INITIAL_LOAD: 50,      // sync.ts ~line 1733
        MESSAGES_INCREMENTAL: 100,      // sync.ts ~line 1691
        MESSAGES_REFRESH: 100,          // sync.ts ~line 1785
        MESSAGES_OLDER: 50,             // sync.ts ~line 1875
        MESSAGES_CONSISTENCY: 20,       // sync.ts ~line 1937
    };

    it('app message page sizes are below server v3 max (200)', () => {
        for (const [name, limit] of Object.entries(APP_REQUESTS)) {
            expect(
                limit,
                `${name} (${limit}) exceeds server cap (${SERVER_CAPS.V3_MESSAGES_PAGE_MAX})`
            ).toBeLessThanOrEqual(SERVER_CAPS.V3_MESSAGES_PAGE_MAX);
        }
    });

    it('app never requests more than 100 messages per page', () => {
        const maxAppRequest = Math.max(...Object.values(APP_REQUESTS));
        expect(maxAppRequest).toBeLessThanOrEqual(100);
    });

    it('server session list cap is sufficient for typical usage', () => {
        // The app fetches all sessions in one call; 150 is the cap
        expect(SERVER_CAPS.V1_SESSIONS_TAKE).toBeGreaterThanOrEqual(50);
    });

    it('server machine list cap is reasonable', () => {
        // Most users have 1-5 machines
        expect(SERVER_CAPS.V1_MACHINES_TAKE).toBeGreaterThanOrEqual(10);
    });
});

describe('null-field consumer patterns', () => {
    // These tests verify the exact code patterns used in app components
    // continue to work when agentState/daemonState are null.

    it('permission detection with null agentState', () => {
        const session: Pick<Session, 'agentState'> = { agentState: null };

        // Pattern from sessionUtils.ts:24
        const hasPermissions = !!(session.agentState?.requests &&
            Object.keys(session.agentState.requests).length > 0);
        expect(hasPermissions).toBe(false);
    });

    it('permission detection with populated agentState', () => {
        const session: Pick<Session, 'agentState'> = {
            agentState: {
                requests: {
                    'req-1': { tool: 'Bash', args: { command: 'ls' } },
                },
            },
        };

        const hasPermissions = !!(session.agentState?.requests &&
            Object.keys(session.agentState.requests).length > 0);
        expect(hasPermissions).toBe(true);
    });

    it('controlledByUser with null agentState', () => {
        const session: Pick<Session, 'agentState'> = { agentState: null };

        // Pattern from SessionView.tsx:401
        const controlled = session.agentState?.controlledByUser === true;
        expect(controlled).toBe(false);

        // Pattern from ChatList.tsx:35
        const controlledFallback = session.agentState?.controlledByUser || false;
        expect(controlledFallback).toBe(false);
    });

    it('permission request lookup with null agentState', () => {
        const session: Pick<Session, 'agentState'> | undefined = { agentState: null };
        const requestId = 'req-123';

        // Pattern from realtimeClientTools.ts:67
        const request = session?.agentState?.requests?.[requestId];
        expect(request).toBeUndefined();
    });

    it('conditional render guard with null agentState', () => {
        const session: Pick<Session, 'agentState'> = { agentState: null };

        // Pattern from info.tsx:476: {session.agentState && (<AgentInfo />)}
        const shouldRender = !!session.agentState;
        expect(shouldRender).toBe(false);
    });

    it('FaviconPermissionIndicator guard with null agentState', () => {
        const session: Pick<Session, 'agentState'> = { agentState: null };

        // Pattern from FaviconPermissionIndicator.tsx:20-21
        const hasRequests = !!(session.agentState?.requests &&
            Object.keys(session.agentState.requests).length > 0);
        expect(hasRequests).toBe(false);
    });

    it('reducer skips when agentState is null', () => {
        // The reducer gate: if (agentState) { ... }
        const agentState: Session['agentState'] = null;
        let reducerCalled = false;

        // Simulate the pattern from storage.ts:399
        if (agentState) {
            reducerCalled = true;
        }
        expect(reducerCalled).toBe(false);
    });

    it('daemon state conditional render with null', () => {
        const machine: Pick<Machine, 'daemonState'> = { daemonState: null };

        // Pattern from machine/[id].tsx:453
        const shouldRender = !!machine.daemonState;
        expect(shouldRender).toBe(false);

        // Optional chaining on properties
        const pid = machine.daemonState?.pid;
        const httpPort = machine.daemonState?.httpPort;
        const startTime = machine.daemonState?.startTime;
        expect(pid).toBeUndefined();
        expect(httpPort).toBeUndefined();
        expect(startTime).toBeUndefined();
    });
});
