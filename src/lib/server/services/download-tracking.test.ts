// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// trackDownload: lease + download log glue (queries and lease manager mocked, fake clock).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const mocks = vi.hoisted(() => ({
    getDb: vi.fn(),
    acquire: vi.fn(),
    start: vi.fn(),
    update: vi.fn(),
    end: vi.fn(),
    refused: vi.fn(),
    merge: vi.fn(),
}));

vi.mock('$lib/server/database/index.js', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/config.js', () => ({ config: { DOWNLOAD_THROTTLE_KBPS: 0 } }));
vi.mock('$lib/paraglide/messages', () => ({ downloads_limit_reached: () => 'limit' }));
vi.mock('$lib/server/services/download-leases.js', () => ({
    acquireDownloadLease: mocks.acquire,
    LEASE_REFRESH_INTERVAL_MS: 5_000,
}));
vi.mock('$lib/server/database/queries/download-events.queries.js', () => ({
    startDownloadEvent: mocks.start,
    updateDownloadEvent: mocks.update,
    endDownloadEvent: mocks.end,
    recordRefusedDownload: mocks.refused,
    mergeTinyRangeEvent: mocks.merge,
    TINY_RANGE_MERGE_BYTES: 1024 * 1024,
}));

import {
    deriveClientName,
    deriveDeviceKey,
    parseRangeStart,
    recordDownloadRefused,
    resetRefusalCoalescingForTests,
    trackDownload,
    untrackedDownload,
} from './download-tracking';

const USER = '11111111-1111-4111-8111-111111111111';
const ITEM = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

function event(locals: Record<string, unknown> = {}, ua = 'TestAgent/1'): RequestEvent {
    return {
        locals: { user: { userId: USER }, ...locals },
        request: new Request('http://localhost/x', { headers: { 'user-agent': ua } }),
    } as unknown as RequestEvent;
}

function fakeLease(rate = 1000) {
    return {
        rateBytesPerSec: vi.fn(() => rate),
        refresh: vi.fn(async () => rate),
        release: vi.fn(async () => {}),
        revoked: vi.fn(() => false),
    };
}

const target = { mediaItemId: ITEM, fileId: FILE, surface: 'api' as const, bytesTotal: 100 };

async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    vi.useFakeTimers();
    resetRefusalCoalescingForTests();
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({});
    mocks.start.mockResolvedValue('row-1');
    mocks.update.mockResolvedValue(undefined);
    mocks.end.mockResolvedValue(undefined);
    mocks.refused.mockResolvedValue(undefined);
    mocks.merge.mockResolvedValue(false);
});
afterEach(() => vi.useRealTimers());

describe('device key and client name', () => {
    it('prefers the Jellyfin device id, then the credential id, then a user-agent hash', () => {
        expect(
            deriveDeviceKey(
                event({ jfDevice: { deviceId: 'jf-1' }, principal: { credentialId: 'tok' } }),
            ),
        ).toBe('jf-1');
        expect(deriveDeviceKey(event({ principal: { credentialId: 'tok-9' } }))).toBe('tok-9');
        expect(deriveDeviceKey(event({ deviceSessionId: 'ds-1' }))).toBe('ds-1');
        expect(deriveDeviceKey(event())).toMatch(/^ua:[0-9a-f]{16}$/);
    });

    it('uses the Jellyfin client name, else the user agent', () => {
        expect(deriveClientName(event({ jfDevice: { clientName: 'Infuse' } }))).toBe('Infuse');
        expect(deriveClientName(event())).toBe('TestAgent/1');
    });

    it('reads the first byte of a Range header', () => {
        expect(parseRangeStart('bytes=100-')).toBe(100);
        expect(parseRangeStart('bytes=0-9')).toBe(0);
        expect(parseRangeStart(null)).toBeNull();
        expect(parseRangeStart('bytes=-5')).toBeNull();
    });
});

describe('trackDownload', () => {
    it('limit reached: 429 with Retry-After and a rate_limited row', async () => {
        mocks.acquire.mockResolvedValue({ ok: false, retryAfterSec: 5 });
        const res = await trackDownload(event(), target);
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.response.status).toBe(429);
        expect(res.response.headers.get('Retry-After')).toBe('5');
        await flush();
        expect(mocks.refused).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: USER, fileId: FILE, surface: 'api' }),
            'rate_limited',
        );
    });

    it('leases by (user, file, device) and exposes the lease rate', async () => {
        const lease = fakeLease(4242);
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event({ jfDevice: { deviceId: 'dev-1' } }), target);
        expect(mocks.acquire).toHaveBeenCalledWith({
            userId: USER,
            fileId: FILE,
            deviceKey: 'dev-1',
        });
        if (!res.ok) throw new Error('expected ok');
        expect(res.tracker.rate()).toBe(4242);
        res.tracker.onEnd('aborted');
    });

    it('a rendition download leases by the rendition id', async () => {
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        await trackDownload(event(), {
            mediaItemId: ITEM,
            renditionId: FILE,
            surface: 'api',
        });
        expect(mocks.acquire).toHaveBeenCalledWith(expect.objectContaining({ fileId: FILE }));
    });

    it('abort releases the lease and logs aborted, once', async () => {
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        res.tracker.onBytes(10);
        res.tracker.onEnd('aborted');
        res.tracker.onEnd('aborted');
        await flush();
        expect(lease.release).toHaveBeenCalledTimes(1);
        expect(mocks.end).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'row-1', 'aborted', {
            bytesSentDelta: 10,
            reachedEnd: false,
        });
    });

    it('a fully read download is logged as completed and releases the lease', async () => {
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        res.tracker.onBytes(100);
        res.tracker.onEnd('completed');
        await flush();
        expect(mocks.end).toHaveBeenCalledWith(expect.anything(), 'row-1', 'completed', {
            bytesSentDelta: 100,
            reachedEnd: false,
        });
        expect(lease.release).toHaveBeenCalledTimes(1);
    });

    it('refreshes the lease and logs bytes on the tick, not per chunk', async () => {
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        res.tracker.onBytes(10);
        res.tracker.onBytes(20);
        await flush();
        expect(mocks.update).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(5_000);
        expect(lease.refresh).toHaveBeenCalledWith(30);
        expect(mocks.update).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'row-1', {
            bytesSentDelta: 30,
        });
        res.tracker.onBytes(5);
        res.tracker.onEnd('aborted');
        await flush();
        // the unflushed rest goes out with the end, and the timer is gone
        expect(mocks.end).toHaveBeenCalledWith(expect.anything(), 'row-1', 'aborted', {
            bytesSentDelta: 5,
            reachedEnd: false,
        });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(lease.refresh).toHaveBeenCalledTimes(1);
    });

    it('discard releases the lease without writing a row', async () => {
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        res.tracker.discard();
        await flush();
        expect(lease.release).toHaveBeenCalledTimes(1);
        expect(mocks.start).not.toHaveBeenCalled();
        expect(mocks.end).not.toHaveBeenCalled();
    });

    it('database down: the download is still served, nothing throws', async () => {
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        mocks.start.mockRejectedValue(new Error('db down'));
        mocks.update.mockRejectedValue(new Error('db down'));
        mocks.end.mockRejectedValue(new Error('db down'));
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        res.tracker.onBytes(10);
        await vi.advanceTimersByTimeAsync(5_000);
        res.tracker.onEnd('completed');
        await flush();
        expect(lease.release).toHaveBeenCalledTimes(1);
        expect(res.tracker.rate()).toBe(0);
    });

    it('no database at all: still leases and serves', async () => {
        mocks.getDb.mockReturnValue(null);
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        res.tracker.onBytes(1);
        res.tracker.onEnd('completed');
        await flush();
        expect(mocks.start).not.toHaveBeenCalled();
        expect(lease.release).toHaveBeenCalledTimes(1);
    });

    it('a lease manager error does not block the download', async () => {
        mocks.acquire.mockRejectedValue(new Error('boom'));
        const res = await trackDownload(event(), target);
        expect(res.ok).toBe(true);
    });
});

describe('recordDownloadRefused', () => {
    it('writes a denied row', async () => {
        recordDownloadRefused(event(), target, 'denied');
        await flush();
        expect(mocks.refused).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ userId: USER, mediaItemId: ITEM }),
            'denied',
        );
    });

    it('swallows a database failure', async () => {
        mocks.refused.mockRejectedValue(new Error('db down'));
        expect(() => recordDownloadRefused(event(), target, 'denied')).not.toThrow();
        await flush();
    });

    it('skips an id that is not a uuid (an unresolved Jellyfin play token)', async () => {
        recordDownloadRefused(event(), { ...target, mediaItemId: 'not-a-uuid' }, 'denied');
        await flush();
        expect(mocks.refused).not.toHaveBeenCalled();
    });
});

describe('stall watchdog', () => {
    it('ends a stream that sent nothing for 10 minutes as aborted and frees the slot', async () => {
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        res.tracker.onBytes(10);
        await vi.advanceTimersByTimeAsync(5_000); // progress seen on this tick
        await vi.advanceTimersByTimeAsync(9 * 60_000);
        expect(lease.release).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(2 * 60_000);
        expect(lease.release).toHaveBeenCalledTimes(1);
        expect(mocks.end).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'row-1', 'aborted', {
            bytesSentDelta: 0,
            reachedEnd: false,
        });
        const refreshes = lease.refresh.mock.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        expect(lease.refresh.mock.calls.length).toBe(refreshes);
    });

    it('a stream that keeps sending is never cut', async () => {
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        for (let i = 0; i < 150; i++) {
            res.tracker.onBytes(1);
            await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(lease.release).not.toHaveBeenCalled();
        res.tracker.onEnd('aborted');
    });
});

describe('stall and revoked lease tear the body down', () => {
    it('a stall cancels the body through the observer hook', async () => {
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        const cancel = vi.fn();
        res.tracker.observer.setCancel!(cancel);
        res.tracker.onBytes(10);
        await vi.advanceTimersByTimeAsync(11 * 60_000);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('a lease that cannot be re-acquired ends the download as rate_limited and cancels the body', async () => {
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        const cancel = vi.fn();
        res.tracker.observer.setCancel!(cancel);
        res.tracker.onBytes(10);
        lease.revoked.mockReturnValue(true);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(mocks.end).toHaveBeenCalledWith(
            expect.anything(),
            'row-1',
            'rate_limited',
            expect.anything(),
        );
    });
});

describe('untrackable downloads', () => {
    it('a signed-in user with a non-UUID item id is refused with 503, not served untracked', async () => {
        const res = await trackDownload(event(), { ...target, mediaItemId: 'tt1234' });
        expect(res.ok).toBe(false);
        if (res.ok) return;
        expect(res.response.status).toBe(503);
        expect(mocks.acquire).not.toHaveBeenCalled();
    });

    it('no file or rendition id is refused with 503', async () => {
        const res = await trackDownload(event(), { ...target, fileId: null });
        expect(res.ok).toBe(false);
    });

    it('no user at all stays untracked', async () => {
        const res = await trackDownload(
            { locals: {}, request: new Request('http://localhost/x') } as unknown as RequestEvent,
            target,
        );
        expect(res.ok).toBe(true);
    });
});

describe('range accounting', () => {
    it('a response served as 200 (stale If-Range) logs no range start', async () => {
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        const res = await trackDownload(event(), { ...target, rangeStart: 50 });
        if (!res.ok) throw new Error('expected ok');
        res.tracker.served(200);
        res.tracker.onBytes(100);
        await flush();
        expect(mocks.start).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ rangeStart: null }),
        );
    });

    it('a served 206 keeps its range start and a tail range counts as reaching the end', async () => {
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        const res = await trackDownload(event(), { ...target, rangeStart: 50 });
        if (!res.ok) throw new Error('expected ok');
        res.tracker.served(206);
        res.tracker.onBytes(50);
        res.tracker.onEnd('completed');
        await flush();
        expect(mocks.start).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ rangeStart: 50 }),
        );
        expect(mocks.end).toHaveBeenCalledWith(expect.anything(), 'row-1', 'completed', {
            bytesSentDelta: 50,
            reachedEnd: true,
        });
    });
});

describe('tiny successful ranges', () => {
    const run = async (rangeStart: number | null, bytes: number, outcome: 'completed' | 'aborted') => {
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        const res = await trackDownload(event(), { ...target, bytesTotal: 50_000_000, rangeStart });
        if (!res.ok) throw new Error('expected ok');
        res.tracker.served(rangeStart == null ? 200 : 206);
        res.tracker.onBytes(bytes);
        res.tracker.onEnd(outcome);
        await flush();
    };

    it('a completed small range that does not start at 0 is merged into the previous row', async () => {
        await run(40_000_000, 4096, 'completed');
        expect(mocks.merge).toHaveBeenCalledExactlyOnceWith(expect.anything(), 'row-1');
    });

    it('is not merged when it starts at 0, has no range, is large, or did not complete', async () => {
        await run(0, 4096, 'completed');
        await run(null, 4096, 'completed');
        await run(40_000_000, 2 * 1024 * 1024, 'completed');
        await run(40_000_000, 4096, 'aborted');
        expect(mocks.merge).not.toHaveBeenCalled();
    });
});

describe('per-user row budget', () => {
    it('allows 120 new rows a minute across outcomes, then serves unlogged', async () => {
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        for (let i = 0; i < 130; i++) {
            const res = await trackDownload(event({ jfDevice: { deviceId: `d${i}` } }), target);
            if (!res.ok) throw new Error('expected ok'); // the download itself is always served
            res.tracker.onBytes(1);
            res.tracker.onEnd('completed');
        }
        await flush();
        expect(mocks.start).toHaveBeenCalledTimes(120);
        await vi.advanceTimersByTimeAsync(61_000);
        const res = await trackDownload(event({ jfDevice: { deviceId: 'late' } }), target);
        if (!res.ok) throw new Error('expected ok');
        res.tracker.onBytes(1);
        await flush();
        expect(mocks.start).toHaveBeenCalledTimes(121);
    });

    it('refusals count against the same budget', async () => {
        for (let i = 0; i < 20; i++) {
            recordDownloadRefused(event({ jfDevice: { deviceId: `a${i}` } }), target, 'denied');
            recordDownloadRefused(event({ jfDevice: { deviceId: `b${i}` } }), target, 'rate_limited');
        }
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        for (let i = 0; i < 90; i++) {
            const res = await trackDownload(event({ jfDevice: { deviceId: `d${i}` } }), target);
            if (!res.ok) throw new Error('expected ok');
            res.tracker.onBytes(1);
        }
        await flush();
        // 40 refusals + 80 starts fill the 120 budget
        expect(mocks.refused).toHaveBeenCalledTimes(40);
        expect(mocks.start).toHaveBeenCalledTimes(80);
    });
});

describe('refusal rows', () => {
    it('a HEAD writes no denied row', async () => {
        const e = {
            locals: { user: { userId: USER } },
            request: new Request('http://localhost/x', { method: 'HEAD' }),
        } as unknown as RequestEvent;
        recordDownloadRefused(e, target, 'denied');
        await flush();
        expect(mocks.refused).not.toHaveBeenCalled();
    });

    it('caps refusal rows per user and outcome at 20 a minute, whatever the file', async () => {
        for (let i = 0; i < 30; i++) {
            recordDownloadRefused(
                event({ jfDevice: { deviceId: `d${i}` } }),
                target,
                'denied',
            );
        }
        await flush();
        expect(mocks.refused).toHaveBeenCalledTimes(20);
        await vi.advanceTimersByTimeAsync(61_000);
        recordDownloadRefused(event({ jfDevice: { deviceId: 'late' } }), target, 'denied');
        await flush();
        expect(mocks.refused).toHaveBeenCalledTimes(21);
    });
});

describe('refusal coalescing', () => {
    it('at most one row per user, file, device and outcome per minute', async () => {
        recordDownloadRefused(event(), target, 'denied');
        recordDownloadRefused(event(), target, 'denied');
        recordDownloadRefused(event(), target, 'rate_limited');
        recordDownloadRefused(event({ jfDevice: { deviceId: 'other' } }), target, 'denied');
        await flush();
        expect(mocks.refused).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(61_000);
        recordDownloadRefused(event(), target, 'denied');
        await flush();
        expect(mocks.refused).toHaveBeenCalledTimes(4);
    });

    it('untrackedDownload holds nothing', () => {
        const t = untrackedDownload();
        t.onBytes(5);
        t.onEnd('completed');
        expect(t.rate()).toBe(0);
        expect(mocks.start).not.toHaveBeenCalled();
    });
});
