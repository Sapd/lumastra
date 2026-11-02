// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for play-session-events.service admin messaging + maintenance notice.
 *
 * Covers:
 * - broadcastAdminMessage (per-session + broadcast-all + local fallback)
 * - setMaintenanceNotice / clearMaintenanceNotice / getActiveMaintenanceNotice
 * - deliverMaintenanceOnConnect (SSE replay on connect)
 * - adminEvents EventEmitter for cross-module (user-SSE) fan-out
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Valkey mock — in-memory store + pub/sub callbacks
// ---------------------------------------------------------------------------

interface MockValkeyState {
    kv: Map<string, string>;
    ttl: Map<string, number>;
    channels: Map<string, Set<(msg: string) => void>>;
    publishEnabled: boolean;
    publishLog: Array<{ channel: string; message: string }>;
    healthy: boolean;
}

const mockState: MockValkeyState = {
    kv: new Map(),
    ttl: new Map(),
    channels: new Map(),
    publishEnabled: true,
    publishLog: [],
    healthy: true,
};

vi.mock('../cache/valkey.js', () => ({
    publishMessage: vi.fn(async (channel: string, message: string) => {
        mockState.publishLog.push({ channel, message });
        if (!mockState.publishEnabled) return false;
        const subs = mockState.channels.get(channel);
        if (subs) {
            for (const cb of subs) {
                // invoke async — behave like network pub/sub
                queueMicrotask(() => cb(message));
            }
        }
        return true;
    }),
    subscribeToChannel: vi.fn(async (channel: string, callback: (msg: string) => void) => {
        let set = mockState.channels.get(channel);
        if (!set) {
            set = new Set();
            mockState.channels.set(channel, set);
        }
        set.add(callback);
        return async () => {
            set?.delete(callback);
        };
    }),
    cacheGet: vi.fn(async (key: string) => mockState.kv.get(key) ?? null),
    setIfNotExists: vi.fn(async (key: string, value: string, ttlSeconds?: number) => {
        if (!mockState.healthy) return false;
        if (mockState.kv.has(key)) return false;
        mockState.kv.set(key, value);
        if (ttlSeconds) {
            mockState.ttl.set(key, ttlSeconds);
        }
        return true;
    }),
    isValkeyHealthy: vi.fn(async () => mockState.healthy),
    isCoordinationValkeyHealthy: vi.fn(async () => mockState.healthy),
    cacheDel: vi.fn(async (key: string | string[]) => {
        const keys = Array.isArray(key) ? key : [key];
        let count = 0;
        for (const k of keys) {
            if (mockState.kv.delete(k)) count++;
            mockState.ttl.delete(k);
        }
        return count;
    }),
}));

vi.mock('../utils/logger.js', () => ({
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
const serviceModule = await import('./play-session-events.service.js');
const {
    sessionControllers,
    broadcastAdminMessage,
    shouldDeliverAdminMessageToUserId,
    setMaintenanceNotice,
    clearMaintenanceNotice,
    getActiveMaintenanceNotice,
    deliverMaintenanceOnConnect,
    adminEvents,
    classifyStopReason,
    notifySessionTerminated,
    notifySessionKilled,
} = serviceModule;
const valkey = await import('../cache/valkey.js');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface CapturedController {
    controller: ReadableStreamDefaultController<Uint8Array>;
    frames: string[];
}

function makeController(): CapturedController {
    const frames: string[] = [];
    const decoder = new TextDecoder();
    const controller: ReadableStreamDefaultController<Uint8Array> = {
        enqueue(chunk: Uint8Array): void {
            frames.push(decoder.decode(chunk));
        },
        close(): void {
            /* no-op */
        },
        error(_e?: unknown): void {
            /* no-op */
        },
        desiredSize: null,
    } as ReadableStreamDefaultController<Uint8Array>;
    return { controller, frames };
}

function registerSession(sessionId: string): CapturedController {
    const cap = makeController();
    let set = sessionControllers.get(sessionId);
    if (!set) {
        set = new Set();
        sessionControllers.set(sessionId, set);
    }
    set.add(cap.controller);
    return cap;
}

function parseSseFrame(frame: string): Record<string, unknown> | null {
    const line = frame.split('\n').find((l) => l.startsWith('data: '));
    if (!line) return null;
    try {
        return JSON.parse(line.slice('data: '.length)) as Record<string, unknown>;
    } catch {
        return null;
    }
}

async function flushMicrotasks(): Promise<void> {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
}

beforeEach(() => {
    mockState.kv.clear();
    mockState.ttl.clear();
    mockState.publishLog.length = 0;
    mockState.publishEnabled = true;
    mockState.healthy = true;
    sessionControllers.clear();
    adminEvents.removeAllListeners();
});

afterEach(() => {
    vi.clearAllMocks();
});

// ===========================================================================
// broadcastAdminMessage
// ===========================================================================

describe('broadcastAdminMessage', () => {
    it('publishes to admin channel with correct payload shape', async () => {
        broadcastAdminMessage({
            target: { kind: 'session', session_id: 'sess-1' },
            severity: 'info',
            message: 'Hello',
            sentBy: 'admin',
        });
        await flushMicrotasks();

        expect(mockState.publishLog.length).toBe(1);
        const entry = mockState.publishLog[0];
        expect(entry.channel).toBe('play-sessions:admin-message');
        const payload = JSON.parse(entry.message) as Record<string, unknown>;
        expect(payload.type).toBe('admin_message');
        expect(payload.target).toEqual({
            kind: 'session',
            session_id: 'sess-1',
        });
        expect(payload.severity).toBe('info');
        expect(payload.message).toBe('Hello');
        expect(payload.sentBy).toBe('admin');
        expect(typeof payload.sentAt).toBe('number');
    });

    it('for target.kind=session delivers only to that session controllers', async () => {
        const s1 = registerSession('sess-1');
        const s2 = registerSession('sess-2');

        broadcastAdminMessage({
            target: { kind: 'session', session_id: 'sess-1' },
            severity: 'warning',
            message: 'Only you',
            sentBy: 'admin',
        });
        await flushMicrotasks();

        expect(s1.frames.length).toBe(1);
        expect(s2.frames.length).toBe(0);
        const parsed = parseSseFrame(s1.frames[0]);
        expect(parsed).toMatchObject({
            type: 'admin_message',
            severity: 'warning',
            message: 'Only you',
        });
    });

    it('for target.kind=all delivers to every registered controller', async () => {
        const s1 = registerSession('sess-1');
        const s2 = registerSession('sess-2');
        const s3 = registerSession('sess-3');

        broadcastAdminMessage({
            target: { kind: 'all' },
            severity: 'error',
            message: 'Shutting down',
            durationMs: 10_000,
            sentBy: 'admin',
        });
        await flushMicrotasks();

        expect(s1.frames.length).toBe(1);
        expect(s2.frames.length).toBe(1);
        expect(s3.frames.length).toBe(1);
        const parsed = parseSseFrame(s1.frames[0]);
        expect(parsed).toMatchObject({
            type: 'admin_message',
            severity: 'error',
            durationMs: 10_000,
        });
    });

    it('falls back to local delivery when Valkey publish returns false', async () => {
        const s1 = registerSession('sess-local');
        mockState.publishEnabled = false;

        broadcastAdminMessage({
            target: { kind: 'session', session_id: 'sess-local' },
            severity: 'info',
            message: 'Fallback works',
            sentBy: 'admin',
        });
        await flushMicrotasks();

        expect(s1.frames.length).toBe(1);
        const parsed = parseSseFrame(s1.frames[0]);
        expect(parsed?.message).toBe('Fallback works');
    });

    it('emits admin_message_broadcast on adminEvents', async () => {
        const listener = vi.fn();
        adminEvents.on('admin_message_broadcast', listener);

        broadcastAdminMessage({
            target: { kind: 'all' },
            severity: 'info',
            message: 'hi',
            sentBy: 'admin',
        });
        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
        const arg = listener.mock.calls[0][0] as Record<string, unknown>;
        expect(arg).toMatchObject({
            type: 'admin_message',
            severity: 'info',
            message: 'hi',
        });
    });
});

describe('shouldDeliverAdminMessageToUserId', () => {
    const OWNER = '22222222-2222-4222-8222-222222222222';
    const OTHER = '33333333-3333-4333-8333-333333333333';

    it('allows broadcast-all payloads for every user', () => {
        expect(
            shouldDeliverAdminMessageToUserId(
                {
                    type: 'admin_message',
                    id: 'msg-1',
                    target: { kind: 'all' },
                    severity: 'info',
                    message: 'Hello',
                    sentBy: 'admin',
                    sentAt: Date.now(),
                },
                OWNER,
            ),
        ).toBe(true);
    });

    it('allows session-targeted payloads only for the owning user id', () => {
        // The target carries a users.id UUID, not a handle. It was named
        // `username` while receiving exactly this value, which made the
        // comparison against the SSE connection's handle never match — see
        // defs/admin/sessions/admin-session-commands.test.ts for the seam
        // test that catches the producer side of that.
        const payload = {
            type: 'admin_message' as const,
            id: 'msg-2',
            target: {
                kind: 'session' as const,
                session_id: 'sess-1',
                userId: OWNER,
            },
            severity: 'warning' as const,
            message: 'Only the owner',
            playSessionId: 'sess-1',
            sentBy: 'admin',
            sentAt: Date.now(),
        };

        expect(shouldDeliverAdminMessageToUserId(payload, OWNER)).toBe(true);
        expect(shouldDeliverAdminMessageToUserId(payload, OTHER)).toBe(false);
    });

    it('reads the legacy `username` key a pre-rename pod publishes', () => {
        // Rolling-deploy compatibility. The old pod wrote the owner's UUID into
        // a field it called `username`, so the value is right and only the key
        // is wrong — read it rather than dropping the message.
        const legacy = {
            type: 'admin_message' as const,
            id: 'msg-3',
            target: { kind: 'session' as const, session_id: 'sess-1', username: OWNER },
            severity: 'info' as const,
            message: 'Published by the previous build',
            sentBy: 'admin',
            sentAt: Date.now(),
        } as unknown as Parameters<typeof shouldDeliverAdminMessageToUserId>[0];

        expect(shouldDeliverAdminMessageToUserId(legacy, OWNER)).toBe(true);
        expect(shouldDeliverAdminMessageToUserId(legacy, OTHER)).toBe(false);
    });

    it('fails CLOSED for a session target that names nobody at all', () => {
        // Failing open here would fan one user's operator message out to EVERY
        // connected user — a cross-user disclosure. Dropping it is the correct
        // failure: a session-targeted message with no owner is unroutable.
        expect(
            shouldDeliverAdminMessageToUserId(
                {
                    type: 'admin_message',
                    id: 'msg-4',
                    target: { kind: 'session', session_id: 'sess-1' },
                    severity: 'info',
                    message: 'Unroutable',
                    sentBy: 'admin',
                    sentAt: Date.now(),
                },
                OWNER,
            ),
        ).toBe(false);
    });
});

// ===========================================================================
// setMaintenanceNotice
// ===========================================================================

describe('setMaintenanceNotice', () => {
    it('writes Valkey key with correct JSON + TTL', async () => {
        const endsAt = Date.now() + 10 * 60_000;
        const notice = await setMaintenanceNotice({
            message: 'Server restart soon',
            endsAt,
            createdBy: 'admin',
        });

        const stored = mockState.kv.get('v1:maintenance:notice');
        expect(stored).toBeDefined();
        const parsed = JSON.parse(stored ?? '{}') as Record<string, unknown>;
        expect(parsed.id).toBe(notice.id);
        expect(parsed.message).toBe('Server restart soon');
        expect(parsed.endsAt).toBe(endsAt);
        expect(parsed.createdBy).toBe('admin');

        const ttl = mockState.ttl.get('v1:maintenance:notice');
        expect(ttl).toBeGreaterThan(0);
        // ~ 10 minutes + 60s buffer
        expect(ttl).toBeLessThanOrEqual(10 * 60 + 61);
        expect(ttl).toBeGreaterThanOrEqual(10 * 60);
    });

    it('publishes to maintenance channel', async () => {
        const endsAt = Date.now() + 5 * 60_000;
        await setMaintenanceNotice({
            message: 'Restart',
            endsAt,
            createdBy: 'admin',
        });

        const maintenancePublishes = mockState.publishLog.filter(
            (p) => p.channel === 'play-sessions:maintenance',
        );
        expect(maintenancePublishes.length).toBe(1);
        const payload = JSON.parse(maintenancePublishes[0].message) as Record<string, unknown>;
        expect(payload.type).toBe('maintenance_notice');
        expect(payload.message).toBe('Restart');
    });

    it('rejects if endsAt < now', async () => {
        await expect(
            setMaintenanceNotice({
                message: 'x',
                endsAt: Date.now() - 1000,
                createdBy: 'admin',
            }),
        ).rejects.toThrow(/past/i);
    });

    it('rejects if endsAt > now + 24h', async () => {
        await expect(
            setMaintenanceNotice({
                message: 'x',
                endsAt: Date.now() + 25 * 60 * 60 * 1000,
                createdBy: 'admin',
            }),
        ).rejects.toThrow();
    });

    it('rejects if a notice is already active', async () => {
        const endsAt = Date.now() + 10 * 60_000;
        await setMaintenanceNotice({
            message: 'first',
            endsAt,
            createdBy: 'admin',
        });
        await expect(
            setMaintenanceNotice({
                message: 'second',
                endsAt: endsAt + 60_000,
                createdBy: 'admin',
            }),
        ).rejects.toThrow(/already/i);
    });

    it('rejects with Valkey-unavailable when setnx fails and health probe is unhealthy', async () => {
        mockState.healthy = false;
        await expect(
            setMaintenanceNotice({
                message: 'x',
                endsAt: Date.now() + 10 * 60_000,
                createdBy: 'admin',
            }),
        ).rejects.toThrow(/valkey unavailable/i);
    });

    it('assigns a UUID id', async () => {
        const endsAt = Date.now() + 10 * 60_000;
        const notice = await setMaintenanceNotice({
            message: 'x',
            endsAt,
            createdBy: 'admin',
        });
        // RFC 4122 UUID pattern
        expect(notice.id).toMatch(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
    });

    it('emits maintenance_notice on adminEvents', async () => {
        const listener = vi.fn();
        adminEvents.on('maintenance_notice', listener);

        const endsAt = Date.now() + 10 * 60_000;
        await setMaintenanceNotice({
            message: 'hello',
            endsAt,
            createdBy: 'admin',
        });
        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
        const arg = listener.mock.calls[0][0] as Record<string, unknown>;
        expect(arg.message).toBe('hello');
        expect(arg.endsAt).toBe(endsAt);
    });

    it('delivers maintenance notice to registered session controllers', async () => {
        const s1 = registerSession('sess-1');
        const endsAt = Date.now() + 5 * 60_000;

        await setMaintenanceNotice({
            message: 'Broadcast me',
            endsAt,
            createdBy: 'admin',
        });
        await flushMicrotasks();

        expect(s1.frames.length).toBeGreaterThanOrEqual(1);
        const parsed = parseSseFrame(s1.frames[0]);
        expect(parsed?.type).toBe('maintenance_notice');
        expect(parsed?.message).toBe('Broadcast me');
        expect(typeof parsed?.remainingMs).toBe('number');
        expect(parsed?.remainingMs as number).toBeGreaterThan(0);
    });
});

// ===========================================================================
// clearMaintenanceNotice
// ===========================================================================

describe('clearMaintenanceNotice', () => {
    it('deletes the key', async () => {
        const endsAt = Date.now() + 5 * 60_000;
        await setMaintenanceNotice({
            message: 'x',
            endsAt,
            createdBy: 'admin',
        });
        expect(mockState.kv.get('v1:maintenance:notice')).toBeDefined();

        await clearMaintenanceNotice();
        expect(mockState.kv.get('v1:maintenance:notice')).toBeUndefined();
    });

    it('publishes maintenance_cleared to channel', async () => {
        const endsAt = Date.now() + 5 * 60_000;
        await setMaintenanceNotice({
            message: 'x',
            endsAt,
            createdBy: 'admin',
        });
        mockState.publishLog.length = 0;

        await clearMaintenanceNotice();
        const clearedPublishes = mockState.publishLog.filter(
            (p) => p.channel === 'play-sessions:maintenance',
        );
        expect(clearedPublishes.length).toBe(1);
        const payload = JSON.parse(clearedPublishes[0].message) as Record<string, unknown>;
        expect(payload.type).toBe('maintenance_cleared');
    });

    it('is safe to call when no notice exists', async () => {
        await expect(clearMaintenanceNotice()).resolves.toBeUndefined();
    });

    it('emits maintenance_cleared on adminEvents', async () => {
        const listener = vi.fn();
        adminEvents.on('maintenance_cleared', listener);

        const endsAt = Date.now() + 5 * 60_000;
        await setMaintenanceNotice({
            message: 'x',
            endsAt,
            createdBy: 'admin',
        });
        await clearMaintenanceNotice();
        await flushMicrotasks();

        expect(listener).toHaveBeenCalled();
    });
});

// ===========================================================================
// getActiveMaintenanceNotice
// ===========================================================================

describe('getActiveMaintenanceNotice', () => {
    it('returns null if key absent', async () => {
        const result = await getActiveMaintenanceNotice();
        expect(result).toBeNull();
    });

    it('returns null if endsAt has passed (defensive check)', async () => {
        // Manually set a stale notice bypassing validation
        mockState.kv.set(
            'v1:maintenance:notice',
            JSON.stringify({
                id: 'stale',
                message: 'old',
                endsAt: Date.now() - 10_000,
                createdBy: 'admin',
                createdAt: Date.now() - 30_000,
            }),
        );

        const result = await getActiveMaintenanceNotice();
        expect(result).toBeNull();
    });

    it('returns parsed notice when active', async () => {
        const endsAt = Date.now() + 5 * 60_000;
        const stored = await setMaintenanceNotice({
            message: 'active',
            endsAt,
            createdBy: 'admin',
        });

        const result = await getActiveMaintenanceNotice();
        expect(result).not.toBeNull();
        expect(result?.id).toBe(stored.id);
        expect(result?.message).toBe('active');
        expect(result?.endsAt).toBe(endsAt);
    });
});

// ===========================================================================
// deliverMaintenanceOnConnect
// ===========================================================================

describe('deliverMaintenanceOnConnect', () => {
    it('pushes active notice as SSE frame when one exists', async () => {
        const endsAt = Date.now() + 5 * 60_000;
        await setMaintenanceNotice({
            message: 'pending',
            endsAt,
            createdBy: 'admin',
        });

        const cap = makeController();
        await deliverMaintenanceOnConnect(cap.controller);

        expect(cap.frames.length).toBe(1);
        const parsed = parseSseFrame(cap.frames[0]);
        expect(parsed?.type).toBe('maintenance_notice');
        expect(parsed?.message).toBe('pending');
        expect(parsed?.endsAt).toBe(endsAt);
        expect(typeof parsed?.remainingMs).toBe('number');
        expect(parsed?.remainingMs as number).toBeGreaterThan(0);
    });

    it('sends maintenance_cleared frame when no notice is active', async () => {
        // Reconnecting clients may have missed the cleared event during an
        // SSE flap. Sending a cleared frame on connect lets them converge
        // on server state instead of sitting on a stale notice until endsAt.
        const cap = makeController();
        await deliverMaintenanceOnConnect(cap.controller);
        expect(cap.frames.length).toBe(1);
        const parsed = parseSseFrame(cap.frames[0]);
        expect(parsed?.type).toBe('maintenance_cleared');
    });

    it('remainingMs is computed at delivery time, not at publish time', async () => {
        vi.useFakeTimers();
        const now = Date.now();
        const durationMs = 10 * 60_000; // 10 minutes
        const endsAt = now + durationMs;

        // Set the notice at t=0
        await setMaintenanceNotice({
            message: 'timer-test',
            endsAt,
            createdBy: 'admin',
        });

        // Advance clock by 5 seconds to simulate time passing before a new
        // client connects and triggers the on-connect replay.
        vi.advanceTimersByTime(5_000);

        const cap = makeController();
        await deliverMaintenanceOnConnect(cap.controller);

        const parsed = parseSseFrame(cap.frames[0]);
        expect(parsed?.type).toBe('maintenance_notice');

        // remainingMs at delivery is ~(durationMs - 5000); allow ±200ms
        const remaining = parsed?.remainingMs as number;
        expect(remaining).toBeGreaterThanOrEqual(durationMs - 5_000 - 200);
        expect(remaining).toBeLessThanOrEqual(durationMs - 5_000 + 200);

        vi.useRealTimers();
    });
});

// ===========================================================================
// Cross-pod fan-out: adminEvents must fire on the RECEIVING pod (not just the
// publishing pod). The fix moved adminEvents.emit into the pub/sub subscriber
// callback — these tests lock in that contract.
// ===========================================================================

describe('Valkey pub/sub fan-out → adminEvents', () => {
    it('delivers admin_message via adminEvents on the receiving pod', async () => {
        const listener = vi.fn();
        adminEvents.on('admin_message_broadcast', listener);

        // Directly invoke the subscriber callback — this simulates a remote
        // pod publishing an admin message that this pod receives off the
        // wire without having called broadcastAdminMessage() locally.
        const payload = {
            type: 'admin_message',
            target: { kind: 'all' },
            severity: 'info',
            message: 'remote pod broadcast',
            sentBy: 'other-admin',
            sentAt: Date.now(),
        };
        const subs = mockState.channels.get('play-sessions:admin-message');
        expect(subs).toBeDefined();
        for (const cb of subs!) cb(JSON.stringify(payload));

        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0]).toMatchObject({
            type: 'admin_message',
            message: 'remote pod broadcast',
        });
    });

    it('delivers maintenance_notice via adminEvents on the receiving pod', async () => {
        const listener = vi.fn();
        adminEvents.on('maintenance_notice', listener);

        const notice = {
            id: 'abc',
            message: 'remote maintenance',
            endsAt: Date.now() + 60_000,
            createdBy: 'other-admin',
            createdAt: Date.now(),
        };
        const wire = { type: 'maintenance_notice' as const, ...notice };
        const subs = mockState.channels.get('play-sessions:maintenance');
        expect(subs).toBeDefined();
        for (const cb of subs!) cb(JSON.stringify(wire));

        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
        // Listener receives the MaintenanceNotice shape (discriminator stripped).
        expect(listener.mock.calls[0][0]).toMatchObject({
            id: 'abc',
            message: 'remote maintenance',
        });
        expect((listener.mock.calls[0][0] as Record<string, unknown>).type).toBeUndefined();
    });

    it('delivers maintenance_cleared via adminEvents on the receiving pod', async () => {
        const listener = vi.fn();
        adminEvents.on('maintenance_cleared', listener);

        const subs = mockState.channels.get('play-sessions:maintenance');
        expect(subs).toBeDefined();
        for (const cb of subs!) cb(JSON.stringify({ type: 'maintenance_cleared' }));

        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('fires adminEvents via local-fallback path when Valkey publish returns false', async () => {
        // Single-pod deployments (or any time Valkey is unavailable) skip
        // the subscriber path entirely — the fallback branch must still
        // notify user-SSE listeners.
        mockState.publishEnabled = false;
        const listener = vi.fn();
        adminEvents.on('admin_message_broadcast', listener);

        broadcastAdminMessage({
            target: { kind: 'all' },
            severity: 'info',
            message: 'fallback',
            sentBy: 'admin',
        });
        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(listener.mock.calls[0][0]).toMatchObject({
            type: 'admin_message',
            message: 'fallback',
        });
    });

    it('publishing pod does NOT double-emit on adminEvents (1 publish → 1 emit total)', async () => {
        // Critical regression guard: with Valkey enabled the publisher must
        // NOT emit locally — only the subscriber callback emits. Otherwise
        // the publishing pod would fire the event twice (once synchronously
        // at publish time, once when the subscriber receives its own msg).
        const listener = vi.fn();
        adminEvents.on('admin_message_broadcast', listener);

        broadcastAdminMessage({
            target: { kind: 'all' },
            severity: 'info',
            message: 'single emit please',
            sentBy: 'admin',
        });
        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('publishing pod does NOT double-emit on maintenance_notice', async () => {
        const listener = vi.fn();
        adminEvents.on('maintenance_notice', listener);

        await setMaintenanceNotice({
            message: 'solo',
            endsAt: Date.now() + 5 * 60_000,
            createdBy: 'admin',
        });
        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('publishing pod does NOT double-emit on maintenance_cleared', async () => {
        const listener = vi.fn();
        adminEvents.on('maintenance_cleared', listener);

        await setMaintenanceNotice({
            message: 'x',
            endsAt: Date.now() + 5 * 60_000,
            createdBy: 'admin',
        });
        await clearMaintenanceNotice();
        await flushMicrotasks();

        expect(listener).toHaveBeenCalledTimes(1);
    });
});

// ===========================================================================
// classifyStopReason — table-driven over the reason space
// ===========================================================================

describe('classifyStopReason', () => {
    // Lock the mapping in. Adding a new reason kind requires updating both
    // the helper AND this table — keeps the spec §4.1 contract honest.
    const cases: Array<[string | null, 'superseded' | 'kicked' | 'session_ended']> = [
        ['superseded', 'superseded'],
        ['kicked', 'kicked'],
        ['admin:alice', 'kicked'],
        ['admin:', 'kicked'],
        // Defensive case folding — a future producer that writes a typo'd
        // case should still be classified correctly so the user gets the
        // right UX (toast/modal, not silent kill).
        ['Superseded', 'superseded'],
        ['SUPERSEDED', 'superseded'],
        ['Admin:Alice', 'kicked'],
        ['KICKED', 'kicked'],
        // Plain 'admin' (no colon) — not produced by current code, but
        // defensively classified as kicked.
        ['admin', 'kicked'],
        // Stream-limit reconciler's kick reason — same UX class as admin kicks.
        ['stream_limit', 'kicked'],
        ['STREAM_LIMIT', 'kicked'],
        ['user', 'session_ended'],
        ['completed', 'session_ended'],
        ['heartbeat_timeout', 'session_ended'],
        ['crash', 'session_ended'],
        ['', 'session_ended'],
        [null, 'session_ended'],
        ['some_future_value', 'session_ended'],
    ];
    for (const [input, expected] of cases) {
        it(`maps ${JSON.stringify(input)} → '${expected}'`, () => {
            expect(classifyStopReason(input)).toBe(expected);
        });
    }
});

// ===========================================================================
// notifySessionTerminated — SSE 1:1 mapping (spec §4.2)
// ===========================================================================

describe('notifySessionTerminated', () => {
    it("publishes 'session_terminated' with reason='superseded' on the terminated channel", async () => {
        notifySessionTerminated('sess-x', 'superseded');
        await flushMicrotasks();

        const entries = mockState.publishLog.filter(
            (p) => p.channel === 'play-sessions:terminated',
        );
        expect(entries.length).toBe(1);
        const payload = JSON.parse(entries[0].message) as Record<string, unknown>;
        expect(payload).toMatchObject({
            session_id: 'sess-x',
            reason: 'superseded',
        });
    });

    // The signature is narrowed to `reason: 'superseded'` — passing 'kicked'
    // or 'session_ended' is a compile-time error. The "kicked uses legacy
    // kill shape" invariant is locked in by the SSE 1:1 mapping test below
    // and by classifyStopReason's table-driven test.

    it('delivers session_terminated SSE frame to local controllers', async () => {
        const cap = registerSession('sess-1');

        notifySessionTerminated('sess-1', 'superseded');
        await flushMicrotasks();

        expect(cap.frames.length).toBe(1);
        const parsed = parseSseFrame(cap.frames[0]);
        expect(parsed?.type).toBe('session_terminated');
        expect(parsed?.reason).toBe('superseded');
    });
});

describe('SSE 1:1 mapping invariant — no double-emit per termination', () => {
    it("notifySessionTerminated('superseded') does NOT also publish a 'kill' frame", async () => {
        const cap = registerSession('sess-1');

        notifySessionTerminated('sess-1', 'superseded');
        await flushMicrotasks();

        const types = cap.frames.map(parseSseFrame).map((f) => f?.type);
        expect(types).toContain('session_terminated');
        expect(types).not.toContain('kill');
    });

    it("notifySessionKilled('admin:alice') does NOT also publish a 'session_terminated' frame", async () => {
        const cap = registerSession('sess-1');

        notifySessionKilled('sess-1', 'admin:alice');
        await flushMicrotasks();

        const types = cap.frames.map(parseSseFrame).map((f) => f?.type);
        expect(types).toContain('kill');
        expect(types).not.toContain('session_terminated');
    });
});

// Keep reference to valkey mock to avoid unused import warning
void valkey;
