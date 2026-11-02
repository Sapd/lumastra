// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the Valkey-backed SSE replay hub's transport behavior.
 *
 * Focus: the prelude/keepalive flush that fixes the "stuck on Reconnecting…"
 * symptom. On a quiet system (empty replay buffer, no live events) the stream
 * must still write bytes immediately so the proxy chain forwards the response
 * headers and the browser's EventSource fires `onopen`.
 *
 * Also covers the cross-user replay-drain security fix: when a consumer has
 * a targetUserId set, only frames whose data.targetUserId matches (or is
 * absent) must be replayed — other users' frames must be filtered out.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

// Valkey unavailable → readReplaySince() returns [] so the stream has no
// replay frames to emit; the only early bytes are the prelude. It also means
// the P1 per-user connection ceiling below falls back to its in-process Map
// path (acquireUserConnectionSlot's Valkey branch is unreachable with
// getCoordinationClient() -> null), which is exactly what these tests exercise.
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: vi.fn(() => null),
}));

// Small connection ceilings so the P1 tests don't need to open thousands of
// real connections to exercise the cap. sse-replay-hub.ts reads ONLY these two
// config keys.
vi.mock('$lib/server/config.js', () => ({
    config: {
        SSE_MAX_CONNECTIONS_PER_USER: 3,
        SSE_MAX_CONNECTIONS: 1000,
    },
}));

import { getCoordinationClient } from '$lib/server/cache/valkey.js';
import { createSseReplayHub } from './sse-replay-hub.js';

const decoder = new TextDecoder();

function makeEvent(url = 'http://localhost/api/v1/runs/stream'): RequestEvent {
    const request = new Request(url);
    return {
        url: new URL(url),
        request,
    } as unknown as RequestEvent;
}

afterEach(() => {
    vi.useRealTimers();
});

describe('sse-replay-hub streamResponse — prelude flush', () => {
    it('emits an immediate prelude comment so EventSource fires onopen on a quiet stream', async () => {
        const hub = createSseReplayHub({
            replayKey: 'test:replay',
            replayIdKey: 'test:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test]',
        });

        const res = await hub.streamResponse(makeEvent());
        const reader = res.body!.getReader();
        const { value } = await reader.read();
        const text = decoder.decode(value);

        // SSE comment line — ignored by EventSource, but forces the proxy to
        // flush response headers so onopen fires immediately.
        expect(text.startsWith(':')).toBe(true);
        expect(text).toContain('\n\n');
        await reader.cancel();
    });

    it('writes a keepalive comment on the configured interval', async () => {
        vi.useFakeTimers();
        const hub = createSseReplayHub({
            replayKey: 'test:replay',
            replayIdKey: 'test:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test]',
            keepaliveIntervalMs: 1000,
        });

        const res = await hub.streamResponse(makeEvent());
        const reader = res.body!.getReader();
        // Drain the prelude first.
        await reader.read();
        // Advance past one keepalive tick; the start() replay drain is a
        // resolved microtask (Valkey null → []), so let it settle.
        await vi.advanceTimersByTimeAsync(1000);
        const { value } = await reader.read();
        expect(decoder.decode(value)).toContain(': ping');
        await reader.cancel();
    });

    it('stops the keepalive timer when the client aborts', async () => {
        vi.useFakeTimers();
        const hub = createSseReplayHub({
            replayKey: 'test:replay',
            replayIdKey: 'test:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test]',
            keepaliveIntervalMs: 1000,
        });

        const controller = new AbortController();
        const url = 'http://localhost/api/v1/runs/stream';
        const event = {
            url: new URL(url),
            request: new Request(url, { signal: controller.signal }),
        } as unknown as RequestEvent;

        const res = await hub.streamResponse(event);
        const reader = res.body!.getReader();
        await reader.read(); // prelude
        controller.abort();
        // After abort the consumer is pruned and the timer cleared — no further
        // frames are buffered for it.
        expect(hub.consumers.size).toBe(0);
        await reader.cancel().catch(() => {});
    });
});

// ---------------------------------------------------------------------------
// Cross-user replay-drain isolation (security fix)
// ---------------------------------------------------------------------------

/**
 * Helper: build a Valkey LRANGE response (newest-first) from a list of
 * plain-object frames.  The hub stores `"<id>:<json>"` via LPUSH, so
 * LRANGE returns them in reverse insertion order (newest first).
 */
function buildLrangeResponse(
    frames: Array<{ id: number; type: string; data: Record<string, unknown> }>,
): string[] {
    // LPUSH newest-first in Valkey → reverse the logical order for the mock.
    return [...frames]
        .reverse()
        .map((f) => `${f.id}:${JSON.stringify({ type: f.type, data: f.data })}`);
}

/** Drain all currently available chunks from a stream reader without blocking. */
async function _drainAll(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const dec = new TextDecoder();
    let result = '';
    // readReplaySince resolves synchronously when Valkey is mocked — one
    // microtask tick is enough for the replay drain to settle.
    await Promise.resolve();
    for (;;) {
        const { value, done } = await reader.read();
        if (done || value === undefined) break;
        result += dec.decode(value);
        // Stop once we've seen the replay tail marker: an empty line after
        // the last event (the hub flips replayDone after the loop).
        // A simpler heuristic: stop after a short settled read.
        break;
    }
    return result;
}

describe('sse-replay-hub streamResponse — cross-user replay isolation', () => {
    afterEach(() => {
        vi.mocked(getCoordinationClient).mockReturnValue(null);
    });

    it('does NOT replay frames targeted at a different user (cross-user leak fix)', async () => {
        // Seed the replay buffer with three frames:
        //   frame 1 — targeted at user-A
        //   frame 2 — targeted at user-B  ← must NOT reach user-A's consumer
        //   frame 3 — global (no targetUserId)  ← must reach user-A's consumer
        const lrangeData = buildLrangeResponse([
            { id: 1, type: 'notification', data: { targetUserId: 'user-A', msg: 'for A' } },
            { id: 2, type: 'notification', data: { targetUserId: 'user-B', msg: 'for B' } },
            { id: 3, type: 'notification', data: { msg: 'broadcast' } },
        ]);

        const mockClient = {
            // EVAL is the per-user connection-slot acquire/refresh script
            // (sse-connection-ceiling.ts) — return 1 (admitted) so the
            // connection under test is actually granted a slot, same as the
            // old INCR-based mock's default `0` (under any cap) used to.
            customCommand: vi.fn(async (cmd: string[]) => {
                if (cmd[0] === 'LRANGE') return lrangeData;
                if (cmd[0] === 'EVAL') return 1;
                return 0;
            }),
        };
        vi.mocked(getCoordinationClient).mockReturnValue(
            mockClient as unknown as ReturnType<typeof getCoordinationClient>,
        );

        const hub = createSseReplayHub({
            replayKey: 'test:replay',
            replayIdKey: 'test:lastId',
            defaultFrameType: 'notification',
            evictionLogPrefix: '[test]',
            keepaliveIntervalMs: 0, // disable keepalive for test simplicity
        });

        const url = 'http://localhost/api/v1/events?since=0';
        const event = {
            url: new URL(url),
            request: new Request(url),
        } as unknown as RequestEvent;

        // Connect as user-A.
        const res = await hub.streamResponse(event, { targetUserId: 'user-A' });
        const reader = res.body!.getReader();

        const dec = new TextDecoder();

        // Read the prelude comment.
        const { value: prelude } = await reader.read();
        expect(dec.decode(prelude)).toContain(':');

        // Let the async replay drain settle (readReplaySince is async).
        await new Promise((r) => setTimeout(r, 0));

        // Collect all replay chunks.
        let replayText = '';
        // We expect 2 frames: frame 1 (user-A) and frame 3 (global).
        // Read until we have collected both or exhaust without error.
        for (let i = 0; i < 5; i++) {
            const { value, done } = await reader.read();
            if (done || value === undefined) break;
            replayText += dec.decode(value);
            // Both expected frames observed — stop early.
            if (replayText.includes('for A') && replayText.includes('broadcast')) break;
        }

        // Frame 1 (user-A) must be present.
        expect(replayText).toContain('for A');
        // Frame 3 (global/broadcast) must be present.
        expect(replayText).toContain('broadcast');
        // Frame 2 (user-B) must NOT appear.
        expect(replayText).not.toContain('for B');

        await reader.cancel().catch(() => {});
    });

    it('replays all frames when no targetUserId is set (global consumer)', async () => {
        const lrangeData = buildLrangeResponse([
            { id: 1, type: 'notification', data: { targetUserId: 'user-A', msg: 'for A' } },
            { id: 2, type: 'notification', data: { targetUserId: 'user-B', msg: 'for B' } },
        ]);

        const mockClient = {
            // EVAL is the per-user connection-slot acquire/refresh script
            // (sse-connection-ceiling.ts) — return 1 (admitted) so the
            // connection under test is actually granted a slot, same as the
            // old INCR-based mock's default `0` (under any cap) used to.
            customCommand: vi.fn(async (cmd: string[]) => {
                if (cmd[0] === 'LRANGE') return lrangeData;
                if (cmd[0] === 'EVAL') return 1;
                return 0;
            }),
        };
        vi.mocked(getCoordinationClient).mockReturnValue(
            mockClient as unknown as ReturnType<typeof getCoordinationClient>,
        );

        const hub = createSseReplayHub({
            replayKey: 'test:replay',
            replayIdKey: 'test:lastId',
            defaultFrameType: 'notification',
            evictionLogPrefix: '[test]',
            keepaliveIntervalMs: 0,
        });

        const url = 'http://localhost/api/v1/runs/stream?since=0';
        const event = {
            url: new URL(url),
            request: new Request(url),
        } as unknown as RequestEvent;

        // No targetUserId — admin/ops consumer that should see everything.
        const res = await hub.streamResponse(event);
        const reader = res.body!.getReader();
        const dec = new TextDecoder();

        // Drain prelude.
        await reader.read();

        // Let replay drain.
        await new Promise((r) => setTimeout(r, 0));

        let replayText = '';
        for (let i = 0; i < 5; i++) {
            const { value, done } = await reader.read();
            if (done || value === undefined) break;
            replayText += dec.decode(value);
            if (replayText.includes('for A') && replayText.includes('for B')) break;
        }

        expect(replayText).toContain('for A');
        expect(replayText).toContain('for B');

        await reader.cancel().catch(() => {});
    });
});

// ---------------------------------------------------------------------------
// P1 (2026-09-13 fix plan): per-user + process-wide SSE connection ceilings
// ---------------------------------------------------------------------------

describe('sse-replay-hub streamResponse — connection ceilings (P1)', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    function makeUserEvent(username: string): {
        event: RequestEvent;
        controller: AbortController;
    } {
        const controller = new AbortController();
        const url = 'http://localhost/api/v1/runs/stream';
        const event = {
            url: new URL(url),
            request: new Request(url, { signal: controller.signal }),
            locals: { user: { username } },
        } as unknown as RequestEvent;
        return { event, controller };
    }

    /** Open a connection and drain its prelude so the consumer is registered. */
    async function openConnection(
        hub: ReturnType<typeof createSseReplayHub>,
        username: string,
    ): Promise<{ res: Response; controller: AbortController }> {
        const { event, controller } = makeUserEvent(username);
        const res = await hub.streamResponse(event);
        if (res.status === 200) {
            const reader = res.body!.getReader();
            await reader.read();
            reader.releaseLock();
        }
        return { res, controller };
    }

    it('refuses the CAP+1th connection for one user (429) while consumers.size stays at CAP; aborting one frees a slot; keepalive count matches CAP after reconnect', async () => {
        vi.useFakeTimers();
        const CAP = 3; // mocked config.SSE_MAX_CONNECTIONS_PER_USER above

        const hub = createSseReplayHub({
            replayKey: 'test:conn:replay',
            replayIdKey: 'test:conn:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test-conn]',
            keepaliveIntervalMs: 1000,
        });

        const opened: Array<{ res: Response; controller: AbortController }> = [];
        for (let i = 0; i < CAP; i++) {
            opened.push(await openConnection(hub, 'alice'));
        }
        for (const { res } of opened) expect(res.status).toBe(200);
        expect(hub.consumers.size).toBe(CAP);

        // CAP+1th connection for the SAME user → 429, and the consumer set does
        // NOT grow — the refused connection never got a slot.
        const overCapacity = await openConnection(hub, 'alice');
        expect(overCapacity.res.status).toBe(429);
        expect(hub.consumers.size).toBe(CAP);

        // A DIFFERENT user is unaffected by alice's per-user ceiling.
        const bob = await openConnection(hub, 'bob');
        expect(bob.res.status).toBe(200);
        expect(hub.consumers.size).toBe(CAP + 1);
        bob.controller.abort();
        expect(hub.consumers.size).toBe(CAP);

        // Abort one of alice's connections — frees exactly one slot.
        opened[0].controller.abort();
        expect(hub.consumers.size).toBe(CAP - 1);

        // The next connect for alice now succeeds again.
        const reconnected = await openConnection(hub, 'alice');
        expect(reconnected.res.status).toBe(200);
        expect(hub.consumers.size).toBe(CAP);

        // Advance past one keepalive tick for every live connection — the
        // consumer count must still read exactly CAP (no leaked timer from the
        // aborted connection kept it registered, and no duplicate registration
        // from the reconnect).
        await vi.advanceTimersByTimeAsync(1000);
        expect(hub.consumers.size).toBe(CAP);

        // Cleanup.
        reconnected.controller.abort();
        for (let i = 1; i < opened.length; i++) opened[i].controller.abort();
        expect(hub.consumers.size).toBe(0);
    });

    it('refuses a new connection process-wide once consumers.size reaches SSE_MAX_CONNECTIONS, independent of per-user budget', async () => {
        const hub = createSseReplayHub({
            replayKey: 'test:conn2:replay',
            replayIdKey: 'test:conn2:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test-conn2]',
            keepaliveIntervalMs: 0,
        });

        // Simulate the process already being at its global ceiling by seeding
        // the consumer set directly — cheaper than opening 1000 real connections
        // (the mocked SSE_MAX_CONNECTIONS is 1000) and exercises the exact
        // condition streamResponse() checks (`consumers.size >= maxConnections`).
        for (let i = 0; i < 1000; i++) {
            hub.consumers.add({
                controller: {} as ReadableStreamDefaultController<Uint8Array>,
                localBuffer: [],
                replayDone: true,
            });
        }

        // A BRAND NEW user, nowhere near their own per-user ceiling, is still
        // refused because the hub itself is full.
        const { res } = await openConnection(hub, 'zed');
        expect(res.status).toBe(503);
    });
});

// ---------------------------------------------------------------------------
// closeConsumersForUsername — security fix C28 (2026-09-16)
// ---------------------------------------------------------------------------
//
// An already-open per-user SSE stream used to have no teardown path when its
// session was revoked (disable, password reset, delete) — auth checks only
// ran at connect, and the hub exposed no per-user close. This closes the
// underlying consumer's controller, which the route layer's read-loop
// observes as stream completion and tears the rest of the connection down
// from there (see events/index.ts's merged-stream pump).

describe('sse-replay-hub — closeConsumersForUsername (C28)', () => {
    it('closes the stream and prunes the consumer for a matching targetUsername', async () => {
        const hub = createSseReplayHub({
            replayKey: 'test:close:replay',
            replayIdKey: 'test:close:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test-close]',
            keepaliveIntervalMs: 0,
        });

        const res = await hub.streamResponse(makeEvent(), {
            targetUserId: 'uuid-alice',
            targetUsername: 'alice',
        });
        const reader = res.body!.getReader();
        await reader.read(); // prelude
        expect(hub.consumers.size).toBe(1);

        const closed = hub.closeConsumersForUsername('alice');
        expect(closed).toBe(1);
        expect(hub.consumers.size).toBe(0);

        const { done } = await reader.read();
        expect(done).toBe(true);
    });

    it('does not close a consumer for a different username', async () => {
        const hub = createSseReplayHub({
            replayKey: 'test:close2:replay',
            replayIdKey: 'test:close2:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test-close2]',
            keepaliveIntervalMs: 0,
        });

        const res = await hub.streamResponse(makeEvent(), {
            targetUserId: 'uuid-bob',
            targetUsername: 'bob',
        });
        const reader = res.body!.getReader();
        await reader.read();

        const closed = hub.closeConsumersForUsername('someone-else');
        expect(closed).toBe(0);
        expect(hub.consumers.size).toBe(1);

        await reader.cancel();
    });

    it('closes a consumer regardless of case difference between connect-time and revocation-time username (fix round 1)', async () => {
        // Standing rule: case-fold EVERY username comparison — the
        // connect-time source (locals.principal?.username) and the
        // revocation-time source (the DB row's username) have diverged in
        // case before (HLS 404s, selfOrAdmin, duplicate identity rows). An
        // exact-match comparison here would leave a case-variant session's
        // stream open past revocation.
        const hub = createSseReplayHub({
            replayKey: 'test:close4:replay',
            replayIdKey: 'test:close4:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test-close4]',
            keepaliveIntervalMs: 0,
        });

        const res = await hub.streamResponse(makeEvent(), {
            targetUserId: 'uuid-carol',
            targetUsername: 'Carol',
        });
        const reader = res.body!.getReader();
        await reader.read();

        const closed = hub.closeConsumersForUsername('carol');
        expect(closed).toBe(1);
        expect(hub.consumers.size).toBe(0);

        const { done } = await reader.read();
        expect(done).toBe(true);
    });

    it('is a no-op when no consumer matches (e.g. the user has no open stream)', () => {
        const hub = createSseReplayHub({
            replayKey: 'test:close3:replay',
            replayIdKey: 'test:close3:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test-close3]',
        });
        expect(hub.closeConsumersForUsername('nobody')).toBe(0);
    });

    it('does not throw on a non-string username (malformed pub/sub frame, fix round 2)', () => {
        // onRemoteUserAdminInvalidate's callback (notification-events.service.ts)
        // receives `username` from auth-cache-bus.ts's unvalidated JSON.parse
        // of a cross-replica pub/sub message — a malformed
        // {kind:'user-admin'} frame could hand this a non-string. Before
        // this fix, `.toLowerCase()` threw instead of the previous
        // (harmless) `!==` no-op.
        const hub = createSseReplayHub({
            replayKey: 'test:close5:replay',
            replayIdKey: 'test:close5:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test-close5]',
        });
        expect(() => hub.closeConsumersForUsername(null as never)).not.toThrow();
        expect(hub.closeConsumersForUsername(null as never)).toBe(0);
        expect(() => hub.closeConsumersForUsername(42 as never)).not.toThrow();
    });
});

// ---------------------------------------------------------------------------
// closeConsumersForDeviceSessions — device logout / revoke closes that
// device's open stream, and only that device's.
// ---------------------------------------------------------------------------

describe('sse-replay-hub — closeConsumersForDeviceSessions', () => {
    it('closes only the consumers opened by the revoked device session', async () => {
        const hub = createSseReplayHub({
            replayKey: 'test:closedev:replay',
            replayIdKey: 'test:closedev:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test-closedev]',
            keepaliveIntervalMs: 0,
        });

        const resA = await hub.streamResponse(makeEvent(), {
            targetUserId: 'uuid-dana',
            targetUsername: 'dana',
            targetDeviceSessionId: 'dev-a',
        });
        const resB = await hub.streamResponse(makeEvent(), {
            targetUserId: 'uuid-dana',
            targetUsername: 'dana',
            targetDeviceSessionId: 'dev-b',
        });
        const readerA = resA.body!.getReader();
        const readerB = resB.body!.getReader();
        await readerA.read();
        await readerB.read();
        expect(hub.consumers.size).toBe(2);

        expect(hub.closeConsumersForDeviceSessions(['dev-a'])).toBe(1);
        expect(hub.consumers.size).toBe(1);
        expect((await readerA.read()).done).toBe(true);

        await readerB.cancel();
    });

    it('ignores a malformed payload', () => {
        const hub = createSseReplayHub({
            replayKey: 'test:closedev2:replay',
            replayIdKey: 'test:closedev2:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test-closedev2]',
            keepaliveIntervalMs: 0,
        });
        expect(hub.closeConsumersForDeviceSessions(undefined as unknown as string[])).toBe(0);
    });
});

describe('sse-replay-hub — device-addressed frames (remote control)', () => {
    /** Reads whatever arrives within 30 ms; one pending read per stream survives between calls. */
    const pendingReads = new WeakMap<
        ReadableStreamDefaultReader<Uint8Array>,
        ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>
    >();
    async function readAvailable(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
        const decoder = new TextDecoder();
        let text = '';
        for (;;) {
            const pending = pendingReads.get(reader) ?? reader.read();
            pendingReads.set(reader, pending);
            const next = await Promise.race([
                pending,
                new Promise<null>((resolve) => setTimeout(() => resolve(null), 30)),
            ]);
            if (!next) return text;
            pendingReads.delete(reader);
            if (next.done) return text;
            text += decoder.decode(next.value);
        }
    }

    it("reaches only the target device's stream, not the account's other streams", async () => {
        const hub = createSseReplayHub({
            replayKey: 'test:devcmd:replay',
            replayIdKey: 'test:devcmd:lastId',
            defaultFrameType: 'test.event',
            evictionLogPrefix: '[test-devcmd]',
            keepaliveIntervalMs: 0,
        });
        const open = async (targetDeviceSessionId?: string) => {
            const res = await hub.streamResponse(makeEvent(), {
                targetUserId: 'uuid-alice',
                targetUsername: 'alice',
                ...(targetDeviceSessionId ? { targetDeviceSessionId } : {}),
            });
            const reader = res.body!.getReader();
            await readAvailable(reader); // prelude + replay
            return reader;
        };
        const tv = await open('tv-1');
        const ipad = await open('ipad-1');
        const browser = await open();

        // Ids far above anything an earlier test left in the mocked replay LIST
        // (the bootstrap drain drops buffered frames at or below the replay max).
        hub.broadcast({
            id: 9_000_001,
            type: 'device.command',
            data: {
                targetUserId: 'uuid-alice',
                targetDeviceSessionId: 'tv-1',
                kind: 'device.command',
                data: {},
            },
        });
        hub.broadcast({
            id: 9_000_002,
            type: 'device.state',
            data: { targetUserId: 'uuid-alice', kind: 'device.state', data: {} },
        });

        const [tvText, ipadText, browserText] = await Promise.all([
            readAvailable(tv),
            readAvailable(ipad),
            readAvailable(browser),
        ]);
        expect(tvText).toContain('event: device.command');
        expect(tvText).toContain('event: device.state');
        expect(ipadText).not.toContain('event: device.command\n');
        expect(ipadText).toContain('event: device.state');
        expect(browserText).not.toContain('event: device.command\n');
        expect(browserText).toContain('event: device.state');

        await Promise.all([tv.cancel(), ipad.cancel(), browser.cancel()]);
    });
});
