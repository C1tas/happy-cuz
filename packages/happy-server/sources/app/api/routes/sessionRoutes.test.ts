import fastify from "fastify";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Fastify } from "../types";

/**
 * Tests for session list API response contract.
 *
 * Verifies that list endpoints (GET /v1/sessions, /v2/sessions/active,
 * /v2/sessions) return agentState: null to reduce response size,
 * and that result limits are enforced.
 *
 * These are the "server side" of the app-server consistency contract.
 * The matching "app side" tests are in happy-app/sources/sync/apiServerConsistency.spec.ts.
 */

type SessionRecord = {
    id: string;
    accountId: string;
    tag: string;
    seq: number;
    metadata: string;
    metadataVersion: number;
    agentState: string | null;
    agentStateVersion: number;
    dataEncryptionKey: Uint8Array | null;
    active: boolean;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
};

const {
    state,
    dbMock,
    resetState,
    seedSession,
} = vi.hoisted(() => {
    let nowMs = 1700000000000;

    const state = {
        sessions: [] as SessionRecord[],
    };

    const resetState = () => {
        state.sessions = [];
        nowMs = 1700000000000;
    };

    const seedSession = (input: {
        id: string;
        accountId: string;
        tag?: string;
        seq?: number;
        metadata?: string;
        metadataVersion?: number;
        agentState?: string | null;
        agentStateVersion?: number;
        dataEncryptionKey?: Uint8Array | null;
        active?: boolean;
        lastActiveAtOffset?: number;
    }) => {
        const ts = new Date(nowMs);
        nowMs += 1;
        state.sessions.push({
            id: input.id,
            accountId: input.accountId,
            tag: input.tag ?? `tag-${input.id}`,
            seq: input.seq ?? 0,
            metadata: input.metadata ?? "encrypted-metadata-blob",
            metadataVersion: input.metadataVersion ?? 1,
            agentState: input.agentState ?? "encrypted-agent-state-blob",
            agentStateVersion: input.agentStateVersion ?? 1,
            dataEncryptionKey: input.dataEncryptionKey ?? null,
            active: input.active ?? true,
            lastActiveAt: input.lastActiveAtOffset !== undefined
                ? new Date(Date.now() - input.lastActiveAtOffset)
                : ts,
            createdAt: ts,
            updatedAt: ts,
        });
    };

    const selectFields = <T extends Record<string, unknown>>(row: T, select?: Record<string, boolean>) => {
        if (!select) return { ...row };
        const picked: Record<string, unknown> = {};
        for (const [key, enabled] of Object.entries(select)) {
            if (enabled) picked[key] = row[key];
        }
        return picked;
    };

    const sessionFindMany = vi.fn(async (args: any) => {
        let rows = [...state.sessions];

        if (args?.where?.accountId) {
            rows = rows.filter(s => s.accountId === args.where.accountId);
        }
        if (args?.where?.active !== undefined) {
            rows = rows.filter(s => s.active === args.where.active);
        }
        if (args?.where?.lastActiveAt?.gt) {
            const threshold = args.where.lastActiveAt.gt as Date;
            rows = rows.filter(s => s.lastActiveAt > threshold);
        }
        if (args?.where?.id?.lt) {
            rows = rows.filter(s => s.id < args.where.id.lt);
        }
        if (args?.where?.updatedAt?.gt) {
            const threshold = args.where.updatedAt.gt as Date;
            rows = rows.filter(s => s.updatedAt > threshold);
        }

        if (args?.orderBy?.updatedAt === 'desc') {
            rows.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
        }
        if (args?.orderBy?.lastActiveAt === 'desc') {
            rows.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());
        }
        if (args?.orderBy?.id === 'desc') {
            rows.sort((a, b) => b.id.localeCompare(a.id));
        }

        if (typeof args?.take === "number") {
            rows = rows.slice(0, args.take);
        }

        return rows.map(row => selectFields(row as unknown as Record<string, unknown>, args?.select));
    });

    const sessionFindFirst = vi.fn(async (args: any) => {
        const row = state.sessions.find(s =>
            (!args?.where?.accountId || s.accountId === args.where.accountId) &&
            (!args?.where?.tag || s.tag === args.where.tag) &&
            (!args?.where?.id || s.id === args.where.id)
        );
        return row ? selectFields(row as unknown as Record<string, unknown>, args?.select) : null;
    });

    const sessionCreate = vi.fn(async (args: any) => {
        const ts = new Date(nowMs);
        nowMs += 1;
        const record: SessionRecord = {
            id: `created-${nowMs}`,
            accountId: args.data.accountId,
            tag: args.data.tag,
            seq: 0,
            metadata: args.data.metadata,
            metadataVersion: 1,
            agentState: null,
            agentStateVersion: 0,
            dataEncryptionKey: args.data.dataEncryptionKey ?? null,
            active: false,
            lastActiveAt: ts,
            createdAt: ts,
            updatedAt: ts,
        };
        state.sessions.push(record);
        return record;
    });

    const accountUpdate = vi.fn(async () => ({ seq: 1 }));

    const dbMock = {
        session: {
            findMany: sessionFindMany,
            findFirst: sessionFindFirst,
            create: sessionCreate,
        },
        account: { update: accountUpdate },
    };

    return { state, dbMock, resetState, seedSession };
});

vi.mock("@/storage/db", () => ({
    db: dbMock
}));

vi.mock("@/utils/log", () => ({
    log: vi.fn()
}));

vi.mock("@/utils/randomKeyNaked", () => ({
    randomKeyNaked: vi.fn(() => "update-id")
}));

vi.mock("@/storage/seq", () => ({
    allocateUserSeq: vi.fn(async () => 1)
}));

vi.mock("@/app/session/sessionDelete", () => ({
    sessionDelete: vi.fn(async () => true)
}));

vi.mock("@/app/events/eventRouter", () => ({
    eventRouter: { emitUpdate: vi.fn() },
    buildNewSessionUpdate: vi.fn(() => ({
        id: "update-id",
        seq: 1,
        body: { t: "new-session" },
        createdAt: Date.now()
    }))
}));

import { sessionRoutes } from "./sessionRoutes";

async function createApp() {
    const app = fastify();
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    const typed = app.withTypeProvider<ZodTypeProvider>() as unknown as Fastify;

    typed.decorate("authenticate", async (request: any, reply: any) => {
        const userId = request.headers["x-user-id"];
        if (typeof userId !== "string") {
            return reply.code(401).send({ error: "Unauthorized" });
        }
        request.userId = userId;
    });

    sessionRoutes(typed);
    await typed.ready();
    return typed;
}

// -------------------------------------------------------------------
// Expected response shape — this is the contract that the app depends on.
// If any field name, type, or nullability changes, these tests must fail.
// -------------------------------------------------------------------

/** Fields every session object in a list response MUST have */
const SESSION_LIST_REQUIRED_FIELDS = [
    "id", "seq", "createdAt", "updatedAt", "active", "activeAt",
    "metadata", "metadataVersion", "agentState", "agentStateVersion",
    "dataEncryptionKey",
] as const;

describe("sessionRoutes — response contract", () => {
    let app: Fastify;

    beforeEach(() => {
        resetState();
    });

    afterEach(async () => {
        if (app) await app.close();
    });

    // ──────────────────────────────────────────────────────────────
    // GET /v1/sessions
    // ──────────────────────────────────────────────────────────────
    describe("GET /v1/sessions", () => {
        it("returns agentState as null even when DB has a value", async () => {
            seedSession({
                id: "s1",
                accountId: "u1",
                agentState: "big-encrypted-blob",
                agentStateVersion: 5,
            });

            app = await createApp();
            const res = await app.inject({
                method: "GET",
                url: "/v1/sessions",
                headers: { "x-user-id": "u1" },
            });

            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.sessions).toHaveLength(1);

            const session = body.sessions[0];
            expect(session.agentState).toBeNull();
            expect(session.agentStateVersion).toBe(5);
        });

        it("returns all required fields with correct types", async () => {
            seedSession({
                id: "s1",
                accountId: "u1",
                seq: 42,
                metadata: "enc-meta",
                metadataVersion: 3,
                agentStateVersion: 2,
                active: true,
            });

            app = await createApp();
            const res = await app.inject({
                method: "GET",
                url: "/v1/sessions",
                headers: { "x-user-id": "u1" },
            });

            const session = res.json().sessions[0];

            // All required fields present
            for (const field of SESSION_LIST_REQUIRED_FIELDS) {
                expect(session).toHaveProperty(field);
            }

            // Type assertions
            expect(typeof session.id).toBe("string");
            expect(typeof session.seq).toBe("number");
            expect(typeof session.createdAt).toBe("number");
            expect(typeof session.updatedAt).toBe("number");
            expect(typeof session.active).toBe("boolean");
            expect(typeof session.activeAt).toBe("number");
            expect(typeof session.metadata).toBe("string");
            expect(typeof session.metadataVersion).toBe("number");
            expect(session.agentState).toBeNull();
            expect(typeof session.agentStateVersion).toBe("number");

            // lastMessage always null in list
            expect(session.lastMessage).toBeNull();
        });

        it("limits results to 150 sessions", async () => {
            for (let i = 0; i < 160; i++) {
                seedSession({ id: `s-${String(i).padStart(3, "0")}`, accountId: "u1" });
            }

            app = await createApp();
            const res = await app.inject({
                method: "GET",
                url: "/v1/sessions",
                headers: { "x-user-id": "u1" },
            });

            expect(res.json().sessions).toHaveLength(150);
        });

        it("returns dataEncryptionKey as base64 string or null", async () => {
            seedSession({ id: "s-with-key", accountId: "u1", dataEncryptionKey: new Uint8Array([1, 2, 3]) });
            seedSession({ id: "s-no-key", accountId: "u1", dataEncryptionKey: null });

            app = await createApp();
            const res = await app.inject({
                method: "GET",
                url: "/v1/sessions",
                headers: { "x-user-id": "u1" },
            });

            const sessions = res.json().sessions;
            const withKey = sessions.find((s: any) => s.id === "s-with-key");
            const noKey = sessions.find((s: any) => s.id === "s-no-key");

            expect(typeof withKey.dataEncryptionKey).toBe("string");
            expect(withKey.dataEncryptionKey.length).toBeGreaterThan(0);
            expect(noKey.dataEncryptionKey).toBeNull();
        });
    });

    // ──────────────────────────────────────────────────────────────
    // GET /v2/sessions/active
    // ──────────────────────────────────────────────────────────────
    describe("GET /v2/sessions/active", () => {
        it("returns agentState as null even when DB has a value", async () => {
            seedSession({
                id: "s1",
                accountId: "u1",
                active: true,
                agentState: "big-blob",
                agentStateVersion: 3,
                lastActiveAtOffset: 0, // just now
            });

            app = await createApp();
            const res = await app.inject({
                method: "GET",
                url: "/v2/sessions/active",
                headers: { "x-user-id": "u1" },
            });

            expect(res.statusCode).toBe(200);
            const session = res.json().sessions[0];
            expect(session.agentState).toBeNull();
            expect(session.agentStateVersion).toBe(3);
        });

        it("only returns active sessions within 15 minutes", async () => {
            seedSession({
                id: "recent",
                accountId: "u1",
                active: true,
                lastActiveAtOffset: 5 * 60 * 1000, // 5min ago
            });
            seedSession({
                id: "stale",
                accountId: "u1",
                active: true,
                lastActiveAtOffset: 20 * 60 * 1000, // 20min ago
            });
            seedSession({
                id: "inactive",
                accountId: "u1",
                active: false,
                lastActiveAtOffset: 0,
            });

            app = await createApp();
            const res = await app.inject({
                method: "GET",
                url: "/v2/sessions/active",
                headers: { "x-user-id": "u1" },
            });

            const ids = res.json().sessions.map((s: any) => s.id);
            expect(ids).toContain("recent");
            expect(ids).not.toContain("stale");
            expect(ids).not.toContain("inactive");
        });
    });

    // ──────────────────────────────────────────────────────────────
    // GET /v2/sessions (cursor-based)
    // ──────────────────────────────────────────────────────────────
    describe("GET /v2/sessions", () => {
        it("returns agentState as null in paginated results", async () => {
            seedSession({
                id: "s1",
                accountId: "u1",
                agentState: "encrypted-blob",
                agentStateVersion: 7,
            });

            app = await createApp();
            const res = await app.inject({
                method: "GET",
                url: "/v2/sessions",
                headers: { "x-user-id": "u1" },
            });

            expect(res.statusCode).toBe(200);
            const body = res.json();
            expect(body.sessions[0].agentState).toBeNull();
            expect(body.sessions[0].agentStateVersion).toBe(7);
            expect(body).toHaveProperty("nextCursor");
            expect(body).toHaveProperty("hasNext");
        });

        it("enforces page limit (default 50)", async () => {
            for (let i = 0; i < 60; i++) {
                seedSession({ id: `s-${String(i).padStart(3, "0")}`, accountId: "u1" });
            }

            app = await createApp();
            const res = await app.inject({
                method: "GET",
                url: "/v2/sessions",
                headers: { "x-user-id": "u1" },
            });

            const body = res.json();
            expect(body.sessions).toHaveLength(50);
            expect(body.hasNext).toBe(true);
            expect(body.nextCursor).toBeTruthy();
        });
    });

    // ──────────────────────────────────────────────────────────────
    // POST /v1/sessions — contrast: still returns full agentState
    // ──────────────────────────────────────────────────────────────
    describe("POST /v1/sessions", () => {
        it("returns full session data including agentState (not stripped)", async () => {
            seedSession({
                id: "existing",
                accountId: "u1",
                tag: "my-tag",
                agentState: "full-blob",
                agentStateVersion: 4,
            });

            app = await createApp();
            const res = await app.inject({
                method: "POST",
                url: "/v1/sessions",
                headers: { "x-user-id": "u1", "content-type": "application/json" },
                payload: {
                    tag: "my-tag",
                    metadata: "new-meta",
                },
            });

            expect(res.statusCode).toBe(200);
            const session = res.json().session;

            // POST returns the actual agentState (not null like list endpoints)
            expect(session.agentState).toBe("full-blob");
            expect(session.agentStateVersion).toBe(4);
        });
    });
});
