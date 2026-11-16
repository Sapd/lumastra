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
    minSpeedKbps: { v: 0 },
}));

vi.mock('$lib/server/database/index.js', () => ({ getDb: mocks.getDb }));
vi.mock('$lib/server/config.js', () => ({
    config: {
        DOWNLOAD_THROTTLE_KBPS: 0,
        get DOWNLOAD_MIN_SPEED_KBPS() {
            return mocks.minSpeedKbps.v;
        },
    },
}));
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

/** Rows actually inserted: starts the budget let through. */
async function insertedRows(): Promise<number> {
    let n = 0;
    for (const r of mocks.start.mock.results) if ((await r.value) !== null) n++;
    return n;
}

async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
    mocks.minSpeedKbps.v = 0; // the minimum-speed rule has its own describe
    vi.useFakeTimers();
    resetRefusalCoalescingForTests();
    vi.clearAllMocks();
    mocks.getDb.mockReturnValue({});
    // like the real query: ask before a new row, null when refused
    mocks.start.mockImplementation(
        async (_s: unknown, _i: unknown, opts?: { allowInsert?: () => boolean }) =>
            opts?.allowInsert && !opts.allowInsert() ? null : 'row-1',
    );
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

describe('minimum download speed', () => {
    const MIN = 60_000;
    async function start(rate = 0) {
        const lease = fakeLease(rate);
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        const cancel = vi.fn();
        res.tracker.observer.setCancel!(cancel);
        return { res, lease, cancel };
    }

    it('a trickle of 1 byte per minute is ended as aborted once a whole window has run', async () => {
        mocks.minSpeedKbps.v = 1;
        const { res, lease, cancel } = await start();
        for (let i = 0; i < 9; i++) {
            res.tracker.onBytes(1);
            await vi.advanceTimersByTimeAsync(MIN);
        }
        expect(cancel).not.toHaveBeenCalled(); // not a full window yet
        for (let i = 0; i < 3; i++) {
            res.tracker.onBytes(1);
            await vi.advanceTimersByTimeAsync(MIN);
        }
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(lease.release).toHaveBeenCalledTimes(1);
        expect(mocks.end).toHaveBeenCalledWith(
            expect.anything(),
            'row-1',
            'aborted',
            expect.anything(),
        );
    });

    it('a steady 2 KB/s download is kept', async () => {
        mocks.minSpeedKbps.v = 1;
        const { res, lease, cancel } = await start();
        for (let i = 0; i < 12 * 12; i++) {
            res.tracker.onBytes(2 * 1024 * 5); // 5 s at 2 KB/s
            await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(cancel).not.toHaveBeenCalled();
        expect(lease.release).not.toHaveBeenCalled();
        res.tracker.onEnd('aborted');
    });

    it('a download the server itself holds at 0.5 KB/s is kept (the server is the limiter)', async () => {
        mocks.minSpeedKbps.v = 1;
        const { res, cancel } = await start(512);
        for (let i = 0; i < 15; i++) {
            res.tracker.onBytes(1);
            await vi.advanceTimersByTimeAsync(MIN);
        }
        expect(cancel).not.toHaveBeenCalled();
        res.tracker.onEnd('aborted');
    });

    it('1 s of preparation, then a steady 1 KiB/s with the cap equal to the minimum: kept', async () => {
        mocks.minSpeedKbps.v = 1;
        const { res, lease, cancel } = await start(1024); // allowed rate = minimum
        await vi.advanceTimersByTimeAsync(1_000); // preparation before the first byte
        for (let i = 0; i < 12 * 12; i++) {
            res.tracker.onBytes(1024 * 5);
            await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(cancel).not.toHaveBeenCalled();
        expect(lease.release).not.toHaveBeenCalled();
        res.tracker.onEnd('aborted');
    });

    it('the window starts at the first byte, not at creation', async () => {
        mocks.minSpeedKbps.v = 1;
        const { res, cancel } = await start();
        await vi.advanceTimersByTimeAsync(9 * MIN); // long preparation, nothing streamed yet
        for (let i = 0; i < 9; i++) {
            res.tracker.onBytes(1);
            await vi.advanceTimersByTimeAsync(MIN);
        }
        // 18 min since creation, 9 since the first byte: still inside the first window
        expect(cancel).not.toHaveBeenCalled();
        for (let i = 0; i < 3; i++) {
            res.tracker.onBytes(1);
            await vi.advanceTimersByTimeAsync(MIN);
        }
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('a speed within 80 % of the minimum is tolerated, below it is not', async () => {
        mocks.minSpeedKbps.v = 10; // 10 KiB/s, 80 % = 8 KiB/s
        const ok = await start();
        for (let i = 0; i < 12 * 12; i++) {
            ok.res.tracker.onBytes(Math.floor(9 * 1024 * 5)); // 9 KiB/s
            await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(ok.cancel).not.toHaveBeenCalled();
        ok.res.tracker.onEnd('aborted');
        const slow = await start();
        for (let i = 0; i < 12 * 12; i++) {
            slow.res.tracker.onBytes(Math.floor(7 * 1024 * 5)); // 7 KiB/s
            await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(slow.cancel).toHaveBeenCalledTimes(1);
    });

    it('setting 0 turns the rule off', async () => {
        mocks.minSpeedKbps.v = 0;
        const { res, cancel } = await start();
        for (let i = 0; i < 20; i++) {
            res.tracker.onBytes(1);
            await vi.advanceTimersByTimeAsync(MIN);
        }
        expect(cancel).not.toHaveBeenCalled();
        res.tracker.onEnd('aborted');
    });

    it('a download that speeds up in time is kept (only the last window counts)', async () => {
        mocks.minSpeedKbps.v = 1;
        const { res, cancel } = await start();
        // 11 slow minutes would trip it at minute 10, so speed up before the first judgement
        for (let i = 0; i < 9; i++) {
            res.tracker.onBytes(1);
            await vi.advanceTimersByTimeAsync(MIN);
        }
        for (let i = 0; i < 20 * 12; i++) {
            res.tracker.onBytes(10 * 1024 * 5);
            await vi.advanceTimersByTimeAsync(5_000);
        }
        expect(cancel).not.toHaveBeenCalled();
        res.tracker.onEnd('aborted');
    });
});

describe('a cancel hook registered after the tracker ended fires immediately', () => {
    it('after onEnd', async () => {
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        expect(res.tracker.isFinished()).toBe(false);
        res.tracker.onEnd('aborted');
        expect(res.tracker.isFinished()).toBe(true);
        const cancel = vi.fn();
        res.tracker.observer.setCancel!(cancel);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('after the stall watchdog or a revoked lease ended it during preparation', async () => {
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        lease.revoked.mockReturnValue(true);
        await vi.advanceTimersByTimeAsync(5_000);
        expect(res.tracker.isFinished()).toBe(true);
        const cancel = vi.fn();
        res.tracker.observer.setCancel!(cancel);
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it('a hook registered while running is not called until the end', async () => {
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        const res = await trackDownload(event(), target);
        if (!res.ok) throw new Error('expected ok');
        const cancel = vi.fn();
        res.tracker.observer.setCancel!(cancel);
        expect(cancel).not.toHaveBeenCalled();
        res.tracker.discard();
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

    it('an archive target (ZIP of a season/series) is tracked: a fresh lease key per request, no file id', async () => {
        const lease = fakeLease();
        mocks.acquire.mockResolvedValue({ ok: true, lease });
        const res = await trackDownload(event(), {
            mediaItemId: ITEM,
            archive: true,
            surface: 'web',
            bytesTotal: 5000,
        });
        expect(res.ok).toBe(true);
        const leaseKey = (mocks.acquire.mock.calls[0]![0] as { fileId: string }).fileId;
        expect(leaseKey).toMatch(/^[0-9a-f-]{36}$/);
        expect(leaseKey).not.toBe(ITEM);
        if (!res.ok) return;
        res.tracker.onBytes(10);
        await flush();
        expect(mocks.start).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
                mediaItemId: ITEM,
                fileId: null,
                renditionId: null,
                archive: true,
                surface: 'web',
                bytesTotal: 5000,
            }),
            expect.anything(),
        );
    });

    it('two archives of the same title from one device are two lease keys (each counts against the limit)', async () => {
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        const t = { mediaItemId: ITEM, archive: true, surface: 'web' as const };
        await trackDownload(event(), t);
        await trackDownload(event(), t);
        const [a, b] = mocks.acquire.mock.calls.map((c) => (c[0] as { fileId: string }).fileId);
        expect(a).not.toBe(b);
    });

    it('an archive whose size is set after the lease is logged with that size', async () => {
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        const res = await trackDownload(event(), {
            mediaItemId: ITEM,
            archive: true,
            surface: 'web',
        });
        if (!res.ok) throw new Error('expected ok');
        res.tracker.setBytesTotal(777);
        res.tracker.onBytes(1);
        await flush();
        expect(mocks.start).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ bytesTotal: 777, archive: true }),
            expect.anything(),
        );
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
            expect.anything(),
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
            expect.anything(),
        );
        expect(mocks.end).toHaveBeenCalledWith(expect.anything(), 'row-1', 'completed', {
            bytesSentDelta: 50,
            reachedEnd: true,
        });
    });
});

describe('tiny successful ranges', () => {
    const run = async (
        rangeStart: number | null,
        bytes: number,
        outcome: 'completed' | 'aborted',
    ) => {
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
        expect(await insertedRows()).toBe(120);
        await vi.advanceTimersByTimeAsync(61_000);
        const res = await trackDownload(event({ jfDevice: { deviceId: 'late' } }), target);
        if (!res.ok) throw new Error('expected ok');
        res.tracker.onBytes(1);
        await flush();
        expect(await insertedRows()).toBe(121);
    });

    it('refusals count against the same budget', async () => {
        for (let i = 0; i < 20; i++) {
            recordDownloadRefused(event({ jfDevice: { deviceId: `a${i}` } }), target, 'denied');
            recordDownloadRefused(
                event({ jfDevice: { deviceId: `b${i}` } }),
                target,
                'rate_limited',
            );
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
        expect(await insertedRows()).toBe(80);
    });
});

describe('row budget is charged for inserts only', () => {
    it('joins and re-opens do not consume the budget', async () => {
        // a start that joins an existing row never asks to insert
        mocks.start.mockImplementation(async () => 'row-joined');
        mocks.acquire.mockResolvedValue({ ok: true, lease: fakeLease() });
        for (let i = 0; i < 200; i++) {
            const res = await trackDownload(event({ jfDevice: { deviceId: 'same' } }), target);
            if (!res.ok) throw new Error('expected ok');
            res.tracker.onBytes(1);
        }
        await flush();
        expect(mocks.start).toHaveBeenCalledTimes(200); // never refused, whatever the count
        // and a real insert afterwards still has its full budget
        mocks.start.mockImplementation(
            async (_s: unknown, _i: unknown, opts?: { allowInsert?: () => boolean }) =>
                opts?.allowInsert && !opts.allowInsert() ? null : 'row-new',
        );
        let inserted = 0;
        for (let i = 0; i < 125; i++) {
            const res = await trackDownload(event({ jfDevice: { deviceId: `n${i}` } }), target);
            if (!res.ok) throw new Error('expected ok');
            res.tracker.onBytes(1);
            res.tracker.onEnd('completed');
        }
        await flush();
        for (const call of mocks.start.mock.results.slice(200)) {
            if ((await call.value) === 'row-new') inserted++;
        }
        expect(inserted).toBe(120);
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
            recordDownloadRefused(event({ jfDevice: { deviceId: `d${i}` } }), target, 'denied');
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
