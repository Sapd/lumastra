// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { ensureTestUser } from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { connectValkey, getCoordinationClient } from '$lib/server/cache/valkey';

const h = vi.hoisted(() => ({ failInsert: false }));
vi.mock('$lib/server/database/queries/client-diagnostics.queries', async (importOriginal) => {
    const actual =
        await importOriginal<
            typeof import('$lib/server/database/queries/client-diagnostics.queries')
        >();
    return {
        ...actual,
        insertClientDiagnostics: (...a: Parameters<typeof actual.insertClientDiagnostics>) => {
            if (h.failInsert) {
                h.failInsert = false;
                return Promise.reject(new Error('insert failed (test)'));
            }
            return actual.insertClientDiagnostics(...a);
        },
    };
});
import {
    armSilentStart,
    disarmSilentStart,
    sweepSilentStarts,
    SILENT_START_DELAY_MS,
    SILENT_START_STREAK_WINDOW_S,
    __setSilentStartStreakWindowForTests,
} from './silent-start';

const USER = '00000000-0000-4000-8000-0000000051a7';
let sql: postgres.Sql;
const later = () => Date.now() + SILENT_START_DELAY_MS + 1_000;

function response(withInterlaced = true): unknown {
    const s: Record<string, unknown> = {
        Index: 1000,
        Type: 'Subtitle',
        Codec: 'srt',
        IsExternal: true,
        IsTextSubtitleStream: true,
        IsDefault: false,
        IsForced: false,
        IsHearingImpaired: false,
        IsOriginal: false,
        SupportsExternalStream: true,
        VideoRange: 'Unknown',
        VideoRangeType: 'Unknown',
    };
    if (withInterlaced) s.IsInterlaced = false;
    // A schema-complete MediaSourceInfo, so only the deliberate IsInterlaced omission violates.
    const bools = [
        'IsRemote',
        'ReadAtNativeFramerate',
        'IgnoreDts',
        'IgnoreIndex',
        'GenPtsInput',
        'SupportsTranscoding',
        'SupportsDirectStream',
        'SupportsDirectPlay',
        'IsInfiniteStream',
        'RequiresOpening',
        'RequiresClosing',
        'RequiresLooping',
        'SupportsProbing',
        'HasSegments',
    ];
    const source = {
        Container: 'mkv',
        Protocol: 'File',
        Type: 'Default',
        TranscodingSubProtocol: 'http',
        ...Object.fromEntries(bools.map((b) => [b, false])),
        MediaStreams: [s],
    };
    return { PlaySessionId: 'x', MediaSources: [source] };
}
const arm = (ps: string, itemId: string, resp = response(), clientVersion = '0.19.10') =>
    armSilentStart({
        playSessionId: ps,
        userId: USER,
        username: 'ssuser',
        deviceId: 'tv1',
        deviceName: 'Fire TV',
        clientName: 'Jellyfin Android TV',
        clientVersion,
        itemId,
        response: resp,
    });
const rows = () =>
    sql<
        { kind: string; app_version: string | null; payload: Record<string, unknown> }[]
    >`SELECT kind, app_version, payload FROM client_diagnostics WHERE user_id = ${USER} AND kind = 'compat_incident'`;

beforeAll(async () => {
    await connectValkey();
    sql = getTestDb();
    await ensureTestUser(sql, USER);
});
afterAll(closeTestDb);
beforeEach(async () => {
    const c = getCoordinationClient()!;
    const keys = (await c.customCommand(['KEYS', 'jfss:*'])) as string[] | null;
    if (keys?.length) await c.customCommand(['DEL', ...keys]);
    await sql`DELETE FROM client_diagnostics WHERE user_id = ${USER}`;
});
afterEach(() => __setSilentStartStreakWindowForTests(null));
const ttl = async (key: string) =>
    Number(await getCoordinationClient()!.customCommand(['TTL', key]));

describe('silent-start detector', () => {
    it('a disarmed arm is never counted', async () => {
        await arm('ps1', 'item-a');
        await disarmSilentStart({ playSessionId: 'ps1' });
        expect(await sweepSilentStarts(sql, later())).toBe(0);
    });
    it('Sessions/Playing disarms via (username, item) when no PlaySessionId is known', async () => {
        await arm('ps2', 'item-b');
        await disarmSilentStart({ username: 'ssuser', itemId: 'item-b' });
        expect(await sweepSilentStarts(sql, later())).toBe(0);
    });
    it('nothing is due before the delay', async () => {
        await arm('ps3', 'item-c');
        expect(await sweepSilentStarts(sql, Date.now())).toBe(0);
    });
    it('two consecutive misses on one device write ONE compat_incident', async () => {
        await arm('ps4', 'item-d');
        await sweepSilentStarts(sql, later());
        expect(await rows()).toHaveLength(0);
        await arm('ps5', 'item-e');
        await sweepSilentStarts(sql, later());
        const r = await rows();
        expect(r).toHaveLength(1);
        await arm('ps6', 'item-f');
        await sweepSilentStarts(sql, later());
        expect(await rows()).toHaveLength(1);
        expect(r).toHaveLength(1);
        expect(r[0].payload).toMatchObject({
            source: 'jellyfin_compat',
            reason: 'silent_start',
            clientName: 'Jellyfin Android TV',
            clientVersion: '0.19.10',
        });
        expect((r[0].payload.misses as unknown[]).length).toBeGreaterThanOrEqual(2);
    });
    it('a start in between resets the streak', async () => {
        await arm('ps7', 'item-g');
        await sweepSilentStarts(sql, later());
        await arm('ps8', 'item-h');
        await disarmSilentStart({ playSessionId: 'ps8' });
        await arm('ps9', 'item-i');
        await sweepSilentStarts(sql, later());
        expect(await rows()).toHaveLength(0);
    });
    it('a single miss whose response broke the SDK contract reports immediately, with the violation', async () => {
        await arm('ps10', 'item-j', response(false));
        await sweepSilentStarts(sql, later());
        const r = await rows();
        expect(r).toHaveLength(1);
        const misses = r[0].payload.misses as { violations: { property: string }[] }[];
        expect(misses[0].violations.map((v) => v.property)).toContain('IsInterlaced');
    });
    it('a late start (after the sweep claimed the arm) by playSessionId resets the streak', async () => {
        await arm('ps12', 'item-l');
        await sweepSilentStarts(sql, later());
        await disarmSilentStart({ playSessionId: 'ps12' });
        await arm('ps13', 'item-m');
        await sweepSilentStarts(sql, later());
        expect(await rows()).toHaveLength(0);
    });
    it('a late start by (username, itemId) only resets the streak', async () => {
        await arm('ps14', 'item-n');
        await sweepSilentStarts(sql, later());
        await disarmSilentStart({ username: 'ssuser', itemId: 'item-n' });
        await arm('ps15', 'item-o');
        await sweepSilentStarts(sql, later());
        expect(await rows()).toHaveLength(0);
    });
    it('strips a trailing ellipsis from the raw client version and slices to 32', async () => {
        await arm('ps11', 'item-k', response(false), `${'1'.repeat(40)}…`);
        await sweepSilentStarts(sql, later());
        const r = await rows();
        expect(r).toHaveLength(1);
        expect(r[0].payload.clientVersion).toBe('1'.repeat(32));
        expect(r[0].app_version).toBe('1'.repeat(32));
    });
    it('two concurrent sweepers claim each due entry exactly once', async () => {
        for (let i = 0; i < 20; i++) await arm(`race-${i}`, `item-r${i}`);
        const [a, b] = await Promise.all([
            sweepSilentStarts(sql, later()),
            sweepSilentStarts(sql, later()),
        ]);
        expect(a + b).toBe(20);
    });

    it('two misses further apart than the streak window are not a streak', async () => {
        // A 1 s window stands in for the 10 min one: the first miss's streak expires.
        __setSilentStartStreakWindowForTests(1);
        await arm('w1', 'item-w1');
        await sweepSilentStarts(sql, later());
        await new Promise((r) => setTimeout(r, 1_300));
        await arm('w2', 'item-w2');
        await sweepSilentStarts(sql, later());
        expect(await rows()).toHaveLength(0);
    });
    it('two misses within the window write one incident', async () => {
        await arm('w3', 'item-w3');
        await sweepSilentStarts(sql, later());
        await arm('w4', 'item-w4');
        await sweepSilentStarts(sql, later());
        expect(await rows()).toHaveLength(1);
    });
    it('the window is set when the streak opens and a later miss never extends it', async () => {
        await arm('w5', 'item-w5');
        await sweepSilentStarts(sql, later());
        const streakKey = `jfss:streak:${USER}:tv1`;
        const missesKey = `jfss:misses:${USER}:tv1`;
        expect(await ttl(streakKey)).toBeGreaterThan(SILENT_START_STREAK_WINDOW_S - 10);
        expect(await ttl(streakKey)).toBeLessThanOrEqual(SILENT_START_STREAK_WINDOW_S);
        // Pretend most of the window has passed.
        await getCoordinationClient()!.customCommand(['EXPIRE', streakKey, '30']);
        await getCoordinationClient()!.customCommand(['EXPIRE', missesKey, '30']);
        await arm('w6', 'item-w6');
        await sweepSilentStarts(sql, later());
        expect(await ttl(streakKey)).toBeLessThanOrEqual(30);
        expect(await ttl(missesKey)).toBeLessThanOrEqual(30);
    });
    it('a start clears EVERY pending arm of the device, not only the last PlaybackInfo', async () => {
        // Clients often fetch PlaybackInfo twice per play; jfss:ui then points at ps-b only.
        await arm('dev-a', 'item-dup');
        await arm('dev-b', 'item-dup');
        await disarmSilentStart({ playSessionId: 'dev-b' });
        expect(await sweepSilentStarts(sql, later())).toBe(0);
        expect(await rows()).toHaveLength(0);
    });
    it('an explicit (userId, deviceId) start clears the device arms too', async () => {
        await arm('dev-c', 'item-p');
        await arm('dev-d', 'item-q');
        await disarmSilentStart({ userId: USER, deviceId: 'tv1' });
        expect(await sweepSilentStarts(sql, later())).toBe(0);
    });
    it('a failed incident insert does not swallow the day: the next miss writes it', async () => {
        h.failInsert = true;
        await arm('f5-a', 'item-f5a', response(false));
        await sweepSilentStarts(sql, later());
        expect(h.failInsert).toBe(false); // the failing insert was attempted
        expect(await rows()).toHaveLength(0);
        await arm('f5-b', 'item-f5b', response(false));
        await sweepSilentStarts(sql, later());
        expect(await rows()).toHaveLength(1);
    });
    it('a miss on a pre-existing streak leaves both keys with a TTL', async () => {
        const c = getCoordinationClient()!;
        const streakKey = `jfss:streak:${USER}:tv1`;
        const missesKey = `jfss:misses:${USER}:tv1`;
        await c.customCommand(['SET', streakKey, '0', 'EX', '300']);
        await arm('t1', 'item-t1');
        await sweepSilentStarts(sql, later());
        expect(await ttl(streakKey)).toBeGreaterThan(0);
        expect(await ttl(missesKey)).toBeGreaterThan(0);
        // A TTL-less leftover (the old race's outcome) is repaired too.
        await c.customCommand(['PERSIST', streakKey]);
        await arm('t2', 'item-t2');
        await sweepSilentStarts(sql, later());
        expect(await ttl(streakKey)).toBeGreaterThan(0);
    });
    it('a handled miss leaves the device set', async () => {
        const c = getCoordinationClient()!;
        await arm('s1', 'item-s1');
        await arm('s2', 'item-s2');
        expect(await c.customCommand(['SISMEMBER', `jfss:dev:${USER}:tv1`, 's1'])).toBeTruthy();
        await sweepSilentStarts(sql, later());
        const members = (await c.customCommand(['SMEMBERS', `jfss:dev:${USER}:tv1`])) as
            string[] | null;
        expect(members ?? []).toHaveLength(0);
    });
    it('arming many sessions for one device keeps the device set bounded', async () => {
        for (let i = 0; i < 60; i++) await arm(`cap-${i}`, `item-cap-${i}`);
        const n = Number(
            await getCoordinationClient()!.customCommand(['SCARD', `jfss:dev:${USER}:tv1`]),
        );
        expect(n).toBeLessThanOrEqual(50);
        expect(n).toBeGreaterThan(0);
    });
});
