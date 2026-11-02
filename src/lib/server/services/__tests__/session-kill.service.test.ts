// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { revokeGrantsForPlaySession } = vi.hoisted(() => ({
    revokeGrantsForPlaySession: vi.fn().mockResolvedValue(0),
}));
vi.mock('$lib/server/services/playback-grant.js', () => ({ revokeGrantsForPlaySession }));

// ─── Shared mock state ────────────────────────────────────────────────────────

let mockValkeyStore: Map<string, string> = new Map();

// ─── Hoisted mocks ────────────────────────────────────────────────────────────

const { mockKillSession, mockNotifySessionKilled, mockGetValkeyClient } = vi.hoisted(() => {
    const mockKillSession = vi.fn();
    const mockNotifySessionKilled = vi.fn();
    const mockGetValkeyClient = vi.fn();
    return {
        mockKillSession,
        mockNotifySessionKilled,
        mockGetValkeyClient,
    };
});

vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    killSession: mockKillSession,
}));

vi.mock('$lib/server/services/play-session-events.service.js', () => ({
    notifySessionKilled: mockNotifySessionKilled,
}));

vi.mock('$lib/server/cache/valkey.js', () => ({
    getValkeyClient: mockGetValkeyClient,
    getCoordinationClient: mockGetValkeyClient,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
        }),
    },
}));

// Import after mocks
const { killSessionUnified, checkSessionKickCooldown } = await import('../session-kill.service.js');

// ─── Test setup ───────────────────────────────────────────────────────────────

function makeValkeyMock() {
    return {
        set: vi.fn(async (key: string, value: string) => {
            mockValkeyStore.set(key, value);
            return 'OK';
        }),
        get: vi.fn(async (key: string) => {
            return mockValkeyStore.get(key) ?? null;
        }),
    };
}

const mockSql = {} as Parameters<typeof killSessionUnified>[0];

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('killSessionUnified', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValkeyStore = new Map();

        mockKillSession.mockResolvedValue(null);
        mockGetValkeyClient.mockReturnValue(makeValkeyMock());
    });

    it('returns null when session not found in DB', async () => {
        const result = await killSessionUnified(mockSql, 'session-1', 'admin');
        expect(result).toBeNull();
        expect(revokeGrantsForPlaySession).not.toHaveBeenCalled();
    });

    it('kills DB session and sets kick cooldown', async () => {
        mockKillSession.mockResolvedValue({
            user_id: 'alice',
            id: 'session-1',
            owner_username: 'alice',
        });

        const result = await killSessionUnified(mockSql, 'session-1', 'admin');

        expect(result).toEqual({
            killed: true,
            source: 'database',
            username: 'alice',
        });
        expect(mockNotifySessionKilled).toHaveBeenCalledWith('session-1', 'admin');
        const valkey = mockGetValkeyClient();
        expect(valkey.set).toHaveBeenCalled();
    });

    it('sets kick cooldown with correct key prefix', async () => {
        const valkey = makeValkeyMock();
        mockGetValkeyClient.mockReturnValue(valkey);
        mockKillSession.mockResolvedValue({
            user_id: 'carol',
            id: 'session-3',
            owner_username: 'carol',
        });

        await killSessionUnified(mockSql, 'session-3', 'operator');

        expect(valkey.set).toHaveBeenCalledWith(
            'sessions:v1:kicked:carol',
            expect.stringContaining('admin:operator'),
            expect.objectContaining({
                expiry: expect.objectContaining({ count: 120 }),
            }),
        );
    });

    it('does not throw when Valkey is unavailable', async () => {
        mockGetValkeyClient.mockReturnValue(null);
        mockKillSession.mockResolvedValue({
            user_id: 'dave',
            id: 'session-4',
            owner_username: 'dave',
        });

        const result = await killSessionUnified(mockSql, 'session-4', 'admin');
        expect(result?.killed).toBe(true);
    });
});

describe('checkSessionKickCooldown', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockValkeyStore = new Map();
        mockGetValkeyClient.mockReturnValue(makeValkeyMock());
    });

    it('returns kicked: false when no key in Valkey', async () => {
        const status = await checkSessionKickCooldown('alice');
        expect(status).toEqual({ kicked: false });
    });

    it('returns kicked: false when Valkey unavailable', async () => {
        mockGetValkeyClient.mockReturnValue(null);
        const status = await checkSessionKickCooldown('alice');
        expect(status).toEqual({ kicked: false });
    });

    it('returns kicked: true with remaining seconds when key exists', async () => {
        const kickedAt = Date.now() - 30_000; // 30 seconds ago
        mockValkeyStore.set(
            'sessions:v1:kicked:alice',
            JSON.stringify({
                reason: 'admin:operator',
                sessionId: 'session-1',
                kickedAt,
            }),
        );
        mockGetValkeyClient.mockReturnValue(makeValkeyMock());

        const status = await checkSessionKickCooldown('alice');

        expect(status.kicked).toBe(true);
        expect(status.reason).toBe('admin:operator');
        expect(status.remainingSeconds).toBeGreaterThan(85);
        expect(status.remainingSeconds).toBeLessThanOrEqual(90);
    });

    it('returns kicked: false safely when Valkey get throws', async () => {
        mockGetValkeyClient.mockReturnValue({
            get: vi.fn().mockRejectedValue(new Error('connection lost')),
        });

        const status = await checkSessionKickCooldown('alice');
        expect(status).toEqual({ kicked: false });
    });
});
