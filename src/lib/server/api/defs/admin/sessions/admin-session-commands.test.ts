// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test: POST /api/admin/sessions/{id}/commands (ui.message) → the frame a client
 * decodes, or a device command when the session's device takes commands.
 *
 * ============================================================================
 * WHY THIS TEST EXISTS AND WHY IT IS AT THIS SEAM
 * ============================================================================
 * `shouldDeliverAdminMessageToUserId` already had unit coverage, and that
 * coverage was green while the feature was BROKEN end-to-end. The test built
 * its own payload with `username: 'testviewer'` and asserted the comparison; the
 * real producer passed `session.user_id` — a UUID — into a field named
 * `username`, which was then compared against the SSE connection's handle. The
 * equality never held, so every session-targeted toast was dropped from the
 * per-user stream and only the web player's own session channel ever saw one.
 *
 * A test of the comparison function cannot catch that. This one runs the real
 * route handler, captures the payload that really goes out on `adminEvents`,
 * and asks the real filter about it — so producer and consumer are checked
 * against each other rather than each against a fixture.
 *
 * It also pins the two wire fields a client filters on (`playSessionId`,
 * `deviceId`), because the per-user stream cannot narrow to one of a user's
 * several clients and those fields are the only thing that can.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';
const OWNER_USER_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_USER_ID = '33333333-3333-4333-8333-333333333333';
const DEVICE_ID = 'appletv-livingroom';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

// Valkey down → broadcastAdminMessage takes its local-delivery fallback, which
// emits on adminEvents from the publishing "pod". That is the same payload the
// cross-pod subscriber would emit, so the assertion holds either way.
vi.mock('$lib/server/cache/valkey.js', () => ({
    publishMessage: vi.fn().mockResolvedValue(false),
    subscribeToChannel: vi.fn().mockResolvedValue(null),
    cacheGet: vi.fn().mockResolvedValue(null),
    cacheDel: vi.fn().mockResolvedValue(true),
    setIfNotExists: vi.fn().mockResolvedValue(true),
    isValkeyHealthy: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn().mockReturnValue({}),
}));

// vi.mock factories are hoisted above the const declarations above, so the ids
// are inlined here rather than referenced.
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getSessionById: vi.fn().mockResolvedValue({
        id: '11111111-1111-4111-8111-111111111111',
        // The stable users.id UUID — NOT a handle. This is the value that used
        // to be handed to a field called `username`.
        user_id: '22222222-2222-4222-8222-222222222222',
        device_id: 'appletv-livingroom',
        status: 'ACTIVE',
    }),
}));

vi.mock('$lib/server/utils/audit-log.js', () => ({ auditLog: vi.fn(), auditActor: () => ({}) }));

vi.mock('$lib/server/database/queries/user-devices.queries.js', () => ({
    findDeviceSessionIdForDevice: vi.fn().mockResolvedValue(null),
}));

vi.mock('$lib/server/services/session-kill.service.js', () => ({
    killSessionUnified: vi.fn().mockResolvedValue({ username: 'owner' }),
}));

vi.mock('$lib/server/services/device-presence.service.js', () => ({
    getHeartbeat: vi.fn().mockResolvedValue(null),
    isDeviceStreamOpen: vi.fn().mockResolvedValue(false),
}));

vi.mock('$lib/server/services/device-commands.service.js', () => ({
    sendDeviceCommand: vi.fn(),
}));

vi.mock('$lib/server/oauth/device-session-liveness.js', () => ({
    isDeviceSessionTombstoned: vi.fn(() => false),
    onDeviceSessionsRevoked: vi.fn(),
}));

const toastLimit = { allowed: true };
vi.mock('$lib/server/middleware/valkey-rate-limit.js', () => ({
    checkRateLimit: vi.fn(async () => ({
        allowed: toastLimit.allowed,
        remaining: 0,
        resetAt: Math.floor(Date.now() / 1000) + 30,
        total: 10,
    })),
}));

// ── Import after mocks ───────────────────────────────────────────────────────

import { def as commandsDef } from './[id]/commands.js';
import {
    adminEvents,
    shouldDeliverAdminMessageToUserId,
    type AdminMessagePayload,
} from '$lib/server/services/play-session-events.service.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(body: unknown): RequestEvent {
    const bodyStr = JSON.stringify(body);
    const url = `http://localhost/api/admin/sessions/${SESSION_ID}/commands`;
    return {
        url: new URL(url),
        request: new Request(url, {
            method: 'POST',
            body: bodyStr,
            headers: { 'content-type': 'application/json' },
        }),
        params: { id: SESSION_ID },
        route: { id: '/api/admin/sessions/[id]/commands' as const },
        locals: {
            user: {
                userId: toUserId('44444444-4444-4444-8444-444444444444'),
                username: 'testuser',
                groups: '',
                userGroups: [] as string[],
                hasWatchPermission: true,
                hasLiveTvPermission: true,
                hasRequestPermission: true,
                ownerIsAdmin: true,
                isModerator: false,
                maxAgeRating: null as null | number,
                isAgeRestricted: false,
                liveTvPriority: 'low' as const,
            },
        },
        cookies: {} as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        setHeaders: vi.fn(),
        isDataRequest: false,
        isSubRequest: false,
        isRemoteRequest: false,
        tracing: { enabled: false, root: undefined, current: undefined },
    } as unknown as RequestEvent;
}

/** Run the real handler and return the payload that reached adminEvents. */
async function sendMessage(body: unknown): Promise<AdminMessagePayload> {
    const emitted: AdminMessagePayload[] = [];
    const listener = (p: unknown) => emitted.push(p as AdminMessagePayload);
    adminEvents.on('admin_message_broadcast', listener);
    try {
        const event = makeEvent(body);
        const parsed = commandsDef.request?.body?.parse(body);
        const res = await commandsDef.handlers.POST!(event, {
            surface: 'internal',
            input: { params: { id: SESSION_ID }, body: parsed },
        } as never);
        expect(res.status).toBe(202);
        expect(((await res.json()) as { delivery: string }).delivery).toBe('toast');

        // broadcastAdminMessage publishes on a floating promise and emits in
        // its .then(); yield the microtask queue so the emit has landed.
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(emitted).toHaveLength(1);
        return emitted[0];
    } finally {
        adminEvents.off('admin_message_broadcast', listener);
    }
}

const msg = (text: string, severity: 'info' | 'warning' | 'error') => ({
    type: 'ui.message',
    args: { text, severity },
});

// ── Tests ────────────────────────────────────────────────────────────────────

describe('admin session ui.message → per-user SSE targeting (toast path)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('reaches the session owner and nobody else', async () => {
        const payload = await sendMessage(msg('Restarting shortly', 'warning'));

        // THE regression: this was false for every real send, because the
        // producer put a UUID in a field the filter compared to a username.
        expect(shouldDeliverAdminMessageToUserId(payload, OWNER_USER_ID)).toBe(true);
        expect(shouldDeliverAdminMessageToUserId(payload, OTHER_USER_ID)).toBe(false);
    });

    it('names the target on the frame so one of a user’s clients can filter', async () => {
        const payload = await sendMessage(msg('Hello', 'info'));

        // Without these the frame is indistinguishable from a broadcast, and a
        // user with two signed-in Apple TVs sees the message on both.
        expect(payload.playSessionId).toBe(SESSION_ID);
        expect(payload.deviceId).toBe(DEVICE_ID);
    });

    it('carries the operator-supplied body through unchanged', async () => {
        const payload = await sendMessage(msg('Back in 5', 'error'));

        expect(payload.type).toBe('admin_message');
        expect(payload.message).toBe('Back in 5');
        expect(payload.severity).toBe('error');
        expect(payload.sentBy).toBe('testuser');
        expect(typeof payload.id).toBe('string');
    });
});

describe('admin session commands → a device that takes commands', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('sends the message as a tracked device command from the administrator', async () => {
        const devices = await import('$lib/server/database/queries/user-devices.queries.js');
        const presence = await import('$lib/server/services/device-presence.service.js');
        const commands = await import('$lib/server/services/device-commands.service.js');
        vi.mocked(devices.findDeviceSessionIdForDevice).mockResolvedValueOnce('tv-session-1');
        vi.mocked(presence.getHeartbeat).mockResolvedValueOnce({
            capabilities: { commands: { 'ui.message': {} } },
        } as never);
        vi.mocked(presence.isDeviceStreamOpen).mockResolvedValueOnce(true);
        vi.mocked(commands.sendDeviceCommand).mockResolvedValueOnce({
            ok: true,
            value: {
                command: {
                    id: 'cmd_x',
                    deviceSessionId: 'tv-session-1',
                    type: 'ui.message',
                    args: { text: 'Restarting in 5 minutes', severity: 'warning' },
                    delivery: 'live',
                    source: 'admin',
                    sender: { username: 'testuser', admin: true },
                    status: 'pending',
                    createdAt: '2026-10-16T20:00:00.000Z',
                    updatedAt: '2026-10-16T20:00:00.000Z',
                    expiresAt: '2026-10-16T20:00:30.000Z',
                },
                replayed: false,
            },
        });

        const body = msg('Restarting in 5 minutes', 'warning');
        const res = await commandsDef.handlers.POST!(makeEvent(body), {
            surface: 'internal',
            input: { params: { id: SESSION_ID }, body: commandsDef.request?.body?.parse(body) },
        } as never);

        expect(res.status).toBe(202);
        expect(((await res.json()) as { delivery: string }).delivery).toBe('command');
        expect(commands.sendDeviceCommand).toHaveBeenCalledWith(
            expect.objectContaining({
                deviceSessionId: 'tv-session-1',
                ownerUserId: OWNER_USER_ID,
                request: {
                    type: 'ui.message',
                    args: { text: 'Restarting in 5 minutes', severity: 'warning' },
                },
                sender: expect.objectContaining({ source: 'admin', admin: true }),
            }),
        );
    });

    it('stops the session with playback.stop', async () => {
        const kill = await import('$lib/server/services/session-kill.service.js');
        const body = { type: 'playback.stop' };
        const res = await commandsDef.handlers.POST!(makeEvent(body), {
            surface: 'internal',
            input: { params: { id: SESSION_ID }, body: commandsDef.request?.body?.parse(body) },
        } as never);
        expect(res.status).toBe(200);
        expect(((await res.json()) as { delivery: string }).delivery).toBe('stopped');
        expect(kill.killSessionUnified).toHaveBeenCalledWith(
            expect.anything(),
            SESSION_ID,
            'testuser',
        );
    });

    it('rejects command types an administrator may not send', () => {
        expect(() =>
            commandsDef.request?.body?.parse({ type: 'playback.seekBy', args: { seconds: 10 } }),
        ).toThrow();
    });
});

describe('admin session commands → limits are not bypassed by the toast', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        toastLimit.allowed = true;
    });

    async function post(body: unknown): Promise<Response> {
        return commandsDef.handlers.POST!(makeEvent(body), {
            surface: 'internal',
            input: { params: { id: SESSION_ID }, body: commandsDef.request?.body?.parse(body) },
        } as never);
    }

    it('a rate-limited device command answers 429 instead of falling back to a toast', async () => {
        const devices = await import('$lib/server/database/queries/user-devices.queries.js');
        const presence = await import('$lib/server/services/device-presence.service.js');
        const commands = await import('$lib/server/services/device-commands.service.js');
        vi.mocked(devices.findDeviceSessionIdForDevice).mockResolvedValueOnce('tv-session-1');
        vi.mocked(presence.getHeartbeat).mockResolvedValueOnce({
            capabilities: { commands: { 'ui.message': {} } },
        } as never);
        vi.mocked(presence.isDeviceStreamOpen).mockResolvedValueOnce(true);
        vi.mocked(commands.sendDeviceCommand).mockResolvedValueOnce({
            ok: false,
            error: { kind: 'rate_limited', message: 'Too many messages', retryAfter: 20 },
        });
        const emitted: unknown[] = [];
        const listener = (p: unknown) => emitted.push(p);
        adminEvents.on('admin_message_broadcast', listener);
        try {
            const res = await post(msg('Hello', 'info'));
            expect(res.status).toBe(429);
            await new Promise((r) => setTimeout(r, 0));
            expect(emitted).toHaveLength(0);
        } finally {
            adminEvents.off('admin_message_broadcast', listener);
        }
    });

    it('the toast path has its own message limit', async () => {
        toastLimit.allowed = false;
        expect((await post(msg('Hello', 'info'))).status).toBe(429);
    });
});
