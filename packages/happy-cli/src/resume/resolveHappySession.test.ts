import { describe, expect, it, vi, beforeEach } from 'vitest';

import { resolveSessionRecordByPrefix } from './resolveHappySession';

describe('resolveSessionRecordByPrefix', () => {
    const sessions = [
        { id: 'cmmij8olq00dp5jcxr3wtbpau' },
        { id: 'cmmhiilo00dv7y7e8wjdr5s9x' },
    ];

    it('resolves an exact match', () => {
        expect(resolveSessionRecordByPrefix(sessions, 'cmmhiilo00dv7y7e8wjdr5s9x')).toEqual({
            id: 'cmmhiilo00dv7y7e8wjdr5s9x',
        });
    });

    it('resolves by unique prefix', () => {
        expect(resolveSessionRecordByPrefix(sessions, 'cmmij8')).toEqual({
            id: 'cmmij8olq00dp5jcxr3wtbpau',
        });
    });

    it('rejects unknown prefixes', () => {
        expect(() => resolveSessionRecordByPrefix(sessions, 'missing')).toThrow(
            'No Happy session found matching "missing"',
        );
    });

    it('rejects ambiguous prefixes', () => {
        expect(() => resolveSessionRecordByPrefix(sessions, 'cmm')).toThrow(
            'Ambiguous Happy session "cmm" matches 2 sessions. Be more specific.',
        );
    });
});

// ─────────────────────────────────────────────────────────────────
// reconnectToExistingSession — contract tests
//
// These tests verify the timeout/fallback behavior and
// null-handling for the server response shape changes.
// ─────────────────────────────────────────────────────────────────

const { mockGet } = vi.hoisted(() => ({
    mockGet: vi.fn(),
}));

vi.mock('axios', () => {
    class MockAxiosError extends Error {
        code: string | undefined;
        response: { status: number } | undefined;
        constructor(message: string, code?: string, _config?: any, _req?: any, response?: any) {
            super(message);
            this.name = 'AxiosError';
            this.code = code;
            this.response = response;
        }
    }
    return {
        default: { get: mockGet },
        AxiosError: MockAxiosError,
    };
});

vi.mock('tweetnacl', () => ({
    default: {
        box: {
            open: vi.fn(() => new Uint8Array(32)),
        },
    },
}));

vi.mock('@/api/encryption', () => ({
    decodeBase64: vi.fn(() => new Uint8Array(64)),
    decryptLegacy: vi.fn(() => ({ path: '/test', flavor: 'claude' })),
    decryptWithDataKey: vi.fn(() => ({ path: '/test', flavor: 'claude' })),
}));

vi.mock('@/configuration', () => ({
    configuration: {
        serverUrl: 'https://api.example.com',
        happyHomeDir: '/tmp/.happy-test',
    },
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() },
}));

vi.mock('./localHappyAgentAuth', () => ({
    getLocalHappyAgentCredentialPath: vi.fn(() => '/tmp/.happy-dev/agent.key'),
    readLocalHappyAgentCredentials: vi.fn(() => ({
        token: 'test-token',
        secret: new Uint8Array(32),
        contentKeyPair: {
            publicKey: new Uint8Array(32),
            secretKey: new Uint8Array(64),
        },
    })),
}));

// Import AFTER mocks are set up
const { reconnectToExistingSession, resolveHappySession } = await import('./resolveHappySession');
const { AxiosError } = await import('axios');

function makeServerResponse(sessions: any[]) {
    return { data: { sessions } };
}

function makeSampleSession(overrides: Record<string, any> = {}) {
    return {
        id: 'cmmij8olq00dp5jcxr3wtbpau',
        seq: 42,
        active: true,
        metadata: 'encrypted-metadata-base64',
        metadataVersion: 3,
        agentState: null,
        agentStateVersion: 5,
        dataEncryptionKey: 'encrypted-dek-base64',
        ...overrides,
    };
}

describe('reconnectToExistingSession', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('returns ReconnectableSession on success', async () => {
        const session = makeSampleSession();
        mockGet.mockResolvedValueOnce(makeServerResponse([session]));

        const result = await reconnectToExistingSession(session.id);

        expect(result).not.toBeNull();
        expect(result!.id).toBe(session.id);
        expect(result!.seq).toBe(42);
        expect(result!.agentState).toBeNull();
        expect(result!.agentStateVersion).toBe(5);
        expect(result!.metadataVersion).toBe(3);
    });

    it('returns null on network timeout (ECONNABORTED)', async () => {
        mockGet.mockRejectedValueOnce(new AxiosError('timeout', 'ECONNABORTED'));

        const result = await reconnectToExistingSession('some-id');
        expect(result).toBeNull();
    });

    it('returns null on connection refused', async () => {
        mockGet.mockRejectedValueOnce(new AxiosError('connect refused', 'ECONNREFUSED'));

        const result = await reconnectToExistingSession('some-id');
        expect(result).toBeNull();
    });

    it('returns null when session not found in server list', async () => {
        const other = makeSampleSession({ id: 'different-id' });
        mockGet.mockResolvedValueOnce(makeServerResponse([other]));

        const result = await reconnectToExistingSession('nonexistent-session');
        expect(result).toBeNull();
    });

    it('throws on 401 (auth expired)', async () => {
        const error = new AxiosError('Unauthorized', undefined);
        (error as any).response = { status: 401 };
        mockGet.mockRejectedValueOnce(error);

        await expect(reconnectToExistingSession('some-id'))
            .rejects.toThrow('authentication expired');
    });

    it('handles agentState: null from server (no crash on missing blob)', async () => {
        const session = makeSampleSession({ agentState: null, agentStateVersion: 10 });
        mockGet.mockResolvedValueOnce(makeServerResponse([session]));

        const result = await reconnectToExistingSession(session.id);
        expect(result).not.toBeNull();
        expect(result!.agentState).toBeNull();
        expect(result!.agentStateVersion).toBe(10);
    });

    it('sends request with timeout option', async () => {
        mockGet.mockResolvedValueOnce(makeServerResponse([makeSampleSession()]));

        await reconnectToExistingSession('cmmij8olq00dp5jcxr3wtbpau');

        expect(mockGet).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ timeout: expect.any(Number) }),
        );
        const timeout = mockGet.mock.calls[0][1].timeout;
        expect(timeout).toBeGreaterThan(0);
        expect(timeout).toBeLessThanOrEqual(30_000);
    });
});

describe('resolveHappySession — timeout handling', () => {
    beforeEach(() => {
        mockGet.mockReset();
    });

    it('throws descriptive error on timeout', async () => {
        mockGet.mockRejectedValueOnce(new AxiosError('timeout', 'ECONNABORTED'));

        await expect(resolveHappySession('some-id'))
            .rejects.toThrow('timed out');
    });

    it('sends request with timeout option', async () => {
        mockGet.mockResolvedValueOnce(makeServerResponse([makeSampleSession()]));

        await resolveHappySession('cmmij8');

        expect(mockGet).toHaveBeenCalledWith(
            expect.any(String),
            expect.objectContaining({ timeout: expect.any(Number) }),
        );
    });
});
