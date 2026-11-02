// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test for `recordPlayEnd`'s `bumpPlayCount` parameter
 * (music-tracking.queries.ts).
 *
 * The offline-batch play-end flush never calls `recordPlayStart` (there is no
 * batched play-start endpoint), so without this flag the DO UPDATE branch
 * left play_count frozen for every replay of a track already present in
 * user_music_state — invisible to every play_count-ranked surface (the
 * rotation lane's ORDER BY, alchemy's log10(play_count+1) popularity term).
 * The INSERT branch is unaffected: a never-before-played track still gets
 * play_count = 1 there regardless of the flag.
 *
 * No real DB is used — the fake `sql` tag captures the template's
 * interpolated values, which is enough to prove the increment is wired to
 * the flag without needing a live Postgres instance.
 */

import { describe, test, expect } from 'vitest';
import { recordPlayEnd } from './music-tracking.queries.js';
import type { UserId } from '$lib/shared/user-id.js';

type SqlCall = { strings: string[]; values: unknown[] };

function makeFakeSql(): { sql: (...args: unknown[]) => Promise<unknown[]>; calls: SqlCall[] } {
    const calls: SqlCall[] = [];
    const sql = (...args: unknown[]) => {
        const strings = args[0] as string[];
        const values = args.slice(1);
        calls.push({ strings: [...strings], values });
        return Promise.resolve([]);
    };
    return { sql, calls };
}

const USER = 'u1' as UserId;
const TRACK = 't1';

describe('recordPlayEnd — bumpPlayCount', () => {
    test('defaults to leaving play_count untouched on conflict', async () => {
        const { sql, calls } = makeFakeSql();
        await recordPlayEnd(sql as never, USER, TRACK, 1000, false, false);

        const idx = calls[0].strings.findIndex((s) =>
            s.includes('play_count = user_music_state.play_count +'),
        );
        expect(idx).toBeGreaterThanOrEqual(0);
        expect(calls[0].values[idx]).toBe(0);
    });

    test('bumpPlayCount=true increments play_count on conflict', async () => {
        const { sql, calls } = makeFakeSql();
        await recordPlayEnd(sql as never, USER, TRACK, 1000, false, false, true);

        const idx = calls[0].strings.findIndex((s) =>
            s.includes('play_count = user_music_state.play_count +'),
        );
        expect(calls[0].values[idx]).toBe(1);
    });

    test('the INSERT branch always seeds play_count = 1, regardless of the flag', async () => {
        const { sql, calls } = makeFakeSql();
        await recordPlayEnd(sql as never, USER, TRACK, 1000, false, false, true);

        // play_count is a literal `1` baked into the template text right
        // after the trackId placeholder in the INSERT column list, never
        // interpolated — the flag must not touch it.
        const trackIdIdx = calls[0].values.indexOf(TRACK);
        expect(calls[0].strings[trackIdIdx + 1]).toContain(', 1,');
    });
});
