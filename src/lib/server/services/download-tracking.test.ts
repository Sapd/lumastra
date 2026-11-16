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
