// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Download leases against a real Valkey: the actual Lua, shared between "replicas".

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';

const cfg = vi.hoisted(() => ({
    DOWNLOAD_THROTTLE_KBPS: 0,
    DOWNLOAD_USER_BANDWIDTH_KBPS: 0,
    DOWNLOAD_TOTAL_BANDWIDTH_KBPS: 0,
    DOWNLOAD_MAX_PARALLEL_PER_USER: 3,
}));
vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return { ...actual, config: cfg };
});

import {
    connectValkey,
    disconnectValkey,
    getCoordinationClient,
} from '$lib/server/cache/valkey.js';
import { acquireDownloadLease, listActiveDownloads, type DownloadLease } from './download-leases';

const RUN = Boolean(process.env.CACHE_URL);
const KB = 1024;

type Cmd = { customCommand: (c: string[]) => Promise<unknown> };

/** Valkey's clock cannot be faked: age a lease by rewriting its stored expiry. */
async function expireField(userId: string, slot: string): Promise<void> {
    const c = getCoordinationClient() as unknown as Cmd;
    const fields = ((await c.customCommand(['HKEYS', `dl:lease:${userId}`])) as string[]).map(String);
    for (const f of fields) {
        if (!f.startsWith(`${slot}#`)) continue;
        const v = String(await c.customCommand(['HGET', `dl:lease:${userId}`, f]));
        const rest = v.split('|').slice(1).join('|');
        await c.customCommand(['HSET', `dl:lease:${userId}`, f, `1|${rest}`]);
    }
    await c.customCommand(['ZADD', 'dl:users', '1', userId]); // its dl:users score ages too
}

describe.runIf(RUN)('download leases, real Valkey', () => {
    let users: string[] = [];
    const user = () => {
        const id = `it-dl-${randomUUID()}`;
        users.push(id);
        return id;
    };
    const must = async (
        userId: string,
        fileId: string,
        deviceKey = 'dev',
    ): Promise<DownloadLease> => {
        const r = await acquireDownloadLease({ userId, fileId, deviceKey });
        if (!r.ok) throw new Error('expected ok');
        return r.lease;
    };

    beforeAll(async () => {
        await connectValkey();
    }, 30_000);
    afterAll(async () => {
        await disconnectValkey();
    });
    beforeEach(() => {
        users = [];
        cfg.DOWNLOAD_THROTTLE_KBPS = 0;
        cfg.DOWNLOAD_USER_BANDWIDTH_KBPS = 0;
        cfg.DOWNLOAD_TOTAL_BANDWIDTH_KBPS = 0;
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 3;
    });
    afterEach(async () => {
        vi.useRealTimers();
        const c = getCoordinationClient() as unknown as Cmd;
        for (const u of users) {
            await c.customCommand(['DEL', `dl:lease:${u}`]);
            await c.customCommand(['ZREM', 'dl:users', u]);
        }
    });

    it('rejects over the limit, same file+device shares a slot, other device takes one', async () => {
        const u = user();
        await must(u, 'f1');
        await must(u, 'f1');
        await must(u, 'f1', 'other');
        await must(u, 'f2');
        const r = await acquireDownloadLease({ userId: u, fileId: 'f3', deviceKey: 'dev' });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.retryAfterSec).toBeGreaterThanOrEqual(1);
    });

    it('limit 0 is unlimited', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 0;
        const u = user();
        for (let i = 0; i < 10; i++) await must(u, `f${i}`);
    });

    it('two parallel acquires at limit-1 let exactly one through', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 3;
        const u = user();
        await must(u, 'f1');
        await must(u, 'f2');
        const results = await Promise.all([
            acquireDownloadLease({ userId: u, fileId: 'fa', deviceKey: 'd' }),
            acquireDownloadLease({ userId: u, fileId: 'fb', deviceKey: 'd' }),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
    });

    it('an expired lease frees its slot; refresh keeps one alive', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 2;
        const u = user();
        await must(u, 'dead');
        const alive = await must(u, 'alive');
        await expireField(u, 'dead|dev');
        await alive.refresh(0);
        expect((await acquireDownloadLease({ userId: u, fileId: 'n1', deviceKey: 'd' })).ok).toBe(
            true,
        );
        expect((await acquireDownloadLease({ userId: u, fileId: 'n2', deviceKey: 'd' })).ok).toBe(
            false,
        );
    });

    it('release of a refCount-2 field keeps the slot until the second release', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        const u = user();
        const a = await must(u, 'f1');
        const b = await must(u, 'f1');
        const other = () => acquireDownloadLease({ userId: u, fileId: 'f2', deviceKey: 'dev' });
        await a.release();
        expect((await other()).ok).toBe(false);
        await b.release();
        expect((await other()).ok).toBe(true);
    });

    it('splits the user cap and the total cap (per user, then per lease)', async () => {
        cfg.DOWNLOAD_TOTAL_BANDWIDTH_KBPS = 4000;
        const a = await must(user(), 'f1');
        const bUser = user();
        const b1 = await must(bUser, 'f1');
        const b2 = await must(bUser, 'f2');
        expect(await a.refresh(0)).toBe(2000 * KB);
        expect(await b1.refresh(0)).toBe(1000 * KB);
        cfg.DOWNLOAD_USER_BANDWIDTH_KBPS = 1500;
        expect(await a.refresh(0)).toBe(1500 * KB);
        await b2.release();
        expect(await b1.refresh(0)).toBe(1500 * KB);
    });

    it('a user whose last lease is released stops counting toward U', async () => {
        cfg.DOWNLOAD_TOTAL_BANDWIDTH_KBPS = 4000;
        const a = await must(user(), 'f1');
        const b = await must(user(), 'f1');
        expect(await a.refresh(0)).toBe(2000 * KB);
        await b.release();
        expect(await a.refresh(0)).toBe(4000 * KB);
    });

    it('lists active downloads with bytes, start and speed; omits released ones', async () => {
        const u = user();
        const l = await must(u, 'f1', 'a|b');
        const gone = await must(u, 'f2');
        await gone.release();
        await new Promise((r) => setTimeout(r, 120));
        await l.refresh(5000);
        const mine = (await listActiveDownloads()).filter((d) => d.userId === u);
        expect(mine).toHaveLength(1);
        expect(mine[0]).toMatchObject({ fileId: 'f1', deviceKey: 'a|b', bytesSent: 5000 });
        expect(mine[0].bytesPerSec).toBeGreaterThan(0);
        expect(mine[0].startedAt).toBeGreaterThan(0);
    });

    it('a rejected acquire keeps the user in U and in the active list', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        cfg.DOWNLOAD_TOTAL_BANDWIDTH_KBPS = 4000;
        const aUser = user();
        await must(aUser, 'f1');
        const rejected = await acquireDownloadLease({
            userId: aUser,
            fileId: 'f2',
            deviceKey: 'd',
        });
        expect(rejected.ok).toBe(false);
        const b = await must(user(), 'f1');
        expect(await b.refresh(0)).toBe(2000 * KB); // U = 2
        const mine = (await listActiveDownloads()).filter((d) => d.userId === aUser);
        expect(mine).toHaveLength(1);
    });

    it('a user whose lease expired without release stops counting toward U', async () => {
        cfg.DOWNLOAD_TOTAL_BANDWIDTH_KBPS = 4000;
        const a = await must(user(), 'f1');
        const bUser = user();
        await must(bUser, 'f1'); // B never refreshes
        expect(await a.refresh(0)).toBe(2000 * KB);
        await expireField(bUser, 'f1|dev');
        expect(await a.refresh(0)).toBe(4000 * KB);
    });

    it('every key has a TTL', async () => {
        const u = user();
        await must(u, 'f1');
        const c = getCoordinationClient() as unknown as Cmd;
        expect(Number(await c.customCommand(['PTTL', `dl:lease:${u}`]))).toBeGreaterThan(0);
        expect(Number(await c.customCommand(['PTTL', 'dl:users']))).toBeGreaterThan(0);
    });

    it('splits one slot share over its connections and caps a slot at 4 connections', async () => {
        cfg.DOWNLOAD_USER_BANDWIDTH_KBPS = 3000;
        const u = user();
        const a = await must(u, 'f1');
        await must(u, 'f1');
        await must(u, 'f1');
        expect(await a.refresh(0)).toBe(1000 * KB);
        await must(u, 'f1');
        const r = await acquireDownloadLease({ userId: u, fileId: 'f1', deviceKey: 'dev' });
        expect(r.ok).toBe(false);
    });

    it('a refresh after expiry does not recreate the field: it re-acquires through the limit', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        const u = user();
        const l = await must(u, 'f1');
        await expireField(u, 'f1|dev');
        await must(u, 'f2'); // takes the freed slot
        await l.refresh(10);
        expect(l.revoked()).toBe(true);
        await l.release();
        const mine = (await listActiveDownloads()).filter((d) => d.userId === u);
        expect(mine.map((d) => d.fileId)).toEqual(['f2']);
    });

    it('uses the Valkey clock: a skewed local clock does not expire a live lease', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        const u = user();
        await must(u, 'f1');
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(Date.now() + 120_000); // this replica's clock runs 2 min ahead
        expect((await acquireDownloadLease({ userId: u, fileId: 'f2', deviceKey: 'd' })).ok).toBe(
            false,
        );
    });

    it('an expired-and-replaced slot is not deleted or shared by the old stream', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 2;
        const u = user();
        const old = await must(u, 'f1');
        await expireField(u, 'f1|dev');
        const fresh = await must(u, 'f1'); // same slot, new owner
        await old.refresh(10); // re-acquires its own connection
        await old.release(); // must only drop the old stream's own connection
        const mine = (await listActiveDownloads()).filter((d) => d.userId === u);
        expect(mine.map((d) => d.fileId)).toEqual(['f1']);
        expect(await fresh.refresh(0)).toBeGreaterThanOrEqual(0);
        await fresh.release();
        expect((await listActiveDownloads()).filter((d) => d.userId === u)).toHaveLength(0);
    });

    it('a stale stream refreshing a replaced slot cannot extend the new owner, release only drops itself', async () => {
        cfg.DOWNLOAD_MAX_PARALLEL_PER_USER = 1;
        const u = user();
        const old = await must(u, 'f1');
        await expireField(u, 'f1|dev');
        const fresh = await must(u, 'f1');
        await old.release();
        // the new owner's slot is intact: another file is still refused
        expect((await acquireDownloadLease({ userId: u, fileId: 'f2', deviceKey: 'dev' })).ok).toBe(
            false,
        );
        await fresh.release();
    });

    it('sums per-connection speeds for one slot', async () => {
        const u = user();
        const a = await must(u, 'f1');
        const b = await must(u, 'f1');
        await new Promise((r) => setTimeout(r, 30));
        await a.refresh(100 * KB);
        await b.refresh(100 * KB);
        const [d] = (await listActiveDownloads()).filter((x) => x.userId === u);
        expect(d!.bytesSent).toBe(200 * KB);
        expect(d!.bytesPerSec).toBeGreaterThan(0);
    });
});
