// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Download lease manager, process-local backend (no Valkey), fake clock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({
    DOWNLOAD_THROTTLE_KBPS: 0,
    DOWNLOAD_USER_BANDWIDTH_KBPS: 0,
    DOWNLOAD_TOTAL_BANDWIDTH_KBPS: 0,
    DOWNLOAD_MAX_PARALLEL_PER_USER: 3,
}));

vi.mock('$lib/server/config.js', () => ({ config: cfg }));
vi.mock('$lib/server/cache/valkey.js', () => ({ getCoordinationClient: () => null }));

import {
    acquireDownloadLease,
    listActiveDownloads,
    resetDownloadLeasesForTests,
    type DownloadLease,
} from './download-leases';

const KB = 1024;

async function must(userId: string, fileId: string, deviceKey = 'dev'): Promise<DownloadLease> {
    const r = await acquireDownloadLease({ userId, fileId, deviceKey });
    if (!r.ok) throw new Error('expected ok');
    return r.lease;
}

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-16T10:00:00Z'));
    resetDownloadLeasesForTests();
    cfg.DOWNLOAD_THROTTLE_KBPS = 0;
    cfg.DOWNLOAD_USER_BANDWIDTH_KBPS = 0;
    cfg.DOWNLOAD_TOTAL_BANDWIDTH_KBPS = 0;
    cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 3;
});
afterEach(() => vi.useRealTimers());

describe('parallel limit', () => {
    it('rejects the 4th distinct file with retryAfterSec >= 1', async () => {
        await must('u', 'f1');
        await must('u', 'f2');
        await must('u', 'f3');
        const r = await acquireDownloadLease({ userId: 'u', fileId: 'f4', deviceKey: 'dev' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
    });

    it('same file + same device twice uses one slot', async () => {
        const a = await must('u', 'f1');
        const b = await must('u', 'f1');
        await must('u', 'f2');
        await must('u', 'f3');
        expect(a).not.toBe(b);
        expect((await listActiveDownloads()).filter((d) => d.userId === 'u')).toHaveLength(3);
    });

    it('same file from another device takes a second slot', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        await must('u', 'f1', 'a');
        const r = await acquireDownloadLease({ userId: 'u', fileId: 'f1', deviceKey: 'b' });
        expect(r.ok).toBe(false);
    });

    it('limit 0 is unlimited', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 0;
        for (let i = 0; i < 20; i++) await must('u', `f${i}`);
    });

    it('limits are per user', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        await must('a', 'f');
        await must('b', 'f');
    });

    it('an expired lease frees its slot', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        await must('u', 'f1');
        expect(
            (await acquireDownloadLease({ userId: 'u', fileId: 'f2', deviceKey: 'dev' })).ok,
        ).toBe(false);
        vi.advanceTimersByTime(31_000);
        expect(
            (await acquireDownloadLease({ userId: 'u', fileId: 'f2', deviceKey: 'dev' })).ok,
        ).toBe(true);
    });

    it('refresh keeps a lease alive past the TTL', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        const l = await must('u', 'f1');
        for (let i = 0; i < 4; i++) {
            vi.advanceTimersByTime(10_000);
            await l.refresh(0);
        }
        expect(
            (await acquireDownloadLease({ userId: 'u', fileId: 'f2', deviceKey: 'dev' })).ok,
        ).toBe(false);
    });

    it('releasing a refCount-2 field keeps the slot until the second release', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        const a = await must('u', 'f1');
        const b = await must('u', 'f1');
        const other = () => acquireDownloadLease({ userId: 'u', fileId: 'f2', deviceKey: 'dev' });
        await a.release();
        expect((await other()).ok).toBe(false);
        await b.release();
        expect((await other()).ok).toBe(true);
    });

    it('release is idempotent', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        const a = await must('u', 'f1');
        const b = await must('u', 'f1');
        await a.release();
        await a.release();
        expect((await acquireDownloadLease({ userId: 'u', fileId: 'f2', deviceKey: 'd' })).ok).toBe(
            false,
        );
        await b.release();
    });
});

describe('rate', () => {
    it('is 0 when every cap is 0', async () => {
        const l = await must('u', 'f1');
        expect(l.rateBytesPerSec()).toBe(0);
    });

    it('per-download cap applies', async () => {
        cfg.DOWNLOAD_THROTTLE_KBPS = 800;
        const l = await must('u', 'f1');
        expect(l.rateBytesPerSec()).toBe(800 * KB);
    });

    it('user cap is split over the user leases and recomputed on refresh', async () => {
        cfg.DOWNLOAD_USER_BANDWIDTH_KBPS = 3000;
        const a = await must('u', 'f1');
        const b = await must('u', 'f2');
        const c = await must('u', 'f3');
        expect(await a.refresh(0)).toBe(1000 * KB);
        await c.release();
        expect(await a.refresh(0)).toBe(1500 * KB);
        expect(await b.refresh(0)).toBe(1500 * KB);
        expect(a.rateBytesPerSec()).toBe(1500 * KB);
    });

    it('total cap is shared per user, then split over that user leases', async () => {
        cfg.DOWNLOAD_TOTAL_BANDWIDTH_KBPS = 4000;
        const a = await must('A', 'f1');
        const b1 = await must('B', 'f1');
        const b2 = await must('B', 'f2');
        expect(await a.refresh(0)).toBe(2000 * KB);
        expect(await b1.refresh(0)).toBe(1000 * KB);
        expect(await b2.refresh(0)).toBe(1000 * KB);
    });

    it('lone user with a user cap below the total gets the user cap', async () => {
        cfg.DOWNLOAD_USER_BANDWIDTH_KBPS = 1500;
        cfg.DOWNLOAD_TOTAL_BANDWIDTH_KBPS = 4000;
        const l = await must('u', 'f1');
        expect(l.rateBytesPerSec()).toBe(1500 * KB);
    });

    it('total cap alone, one user one lease', async () => {
        cfg.DOWNLOAD_TOTAL_BANDWIDTH_KBPS = 4000;
        const l = await must('u', 'f1');
        expect(l.rateBytesPerSec()).toBe(4000 * KB);
    });

    it('a user with no live lease stops counting toward U', async () => {
        cfg.DOWNLOAD_TOTAL_BANDWIDTH_KBPS = 4000;
        const a = await must('A', 'f1');
        const b = await must('B', 'f1');
        expect(await a.refresh(0)).toBe(2000 * KB);
        await b.release();
        expect(await a.refresh(0)).toBe(4000 * KB);
    });
});

describe('listActiveDownloads', () => {
    it('reports bytesSent, startedAt and the speed of the last refresh interval', async () => {
        const startedAt = Date.now();
        const l = await must('u', 'f1', 'dev1');
        vi.advanceTimersByTime(5_000);
        await l.refresh(50_000);
        const [d] = await listActiveDownloads();
        expect(d).toEqual({
            userId: 'u',
            fileId: 'f1',
            deviceKey: 'dev1',
            bytesSent: 50_000,
            startedAt,
            bytesPerSec: 10_000,
        });
        vi.advanceTimersByTime(5_000);
        await l.refresh(60_000);
        expect((await listActiveDownloads())[0]).toMatchObject({
            bytesSent: 60_000,
            bytesPerSec: 2_000,
        });
    });

    it('omits expired and released leases', async () => {
        const a = await must('u', 'f1');
        await must('u', 'f2');
        await a.release();
        expect(await listActiveDownloads()).toHaveLength(1);
        vi.advanceTimersByTime(31_000);
        expect(await listActiveDownloads()).toHaveLength(0);
    });

    it('a device key containing the separator survives the round trip', async () => {
        await must('u', 'f1', 'a|b');
        expect((await listActiveDownloads())[0]).toMatchObject({ fileId: 'f1', deviceKey: 'a|b' });
    });
});
