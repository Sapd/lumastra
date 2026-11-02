// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import postgres from 'postgres';
import {
    recordSyncActivity,
    getSyncActivity,
    pruneSyncActivity,
} from './watch-sync-activity.queries.js';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

const URL = getTestDatabaseUrl();
let sql: postgres.Sql;
const USER = '00000000-0000-0000-0000-0000000000aa';

beforeAll(async () => {
    sql = postgres(URL);
    await sql`INSERT INTO users (id, username, is_admin) VALUES (${USER}, 'activity-test', false) ON CONFLICT (id) DO NOTHING`;
});
afterAll(async () => {
    await sql`DELETE FROM watch_sync_activity WHERE user_id = ${USER}`;
    await sql`DELETE FROM users WHERE id = ${USER}`;
    await sql.end();
});
beforeEach(async () => {
    await sql`DELETE FROM watch_sync_activity WHERE user_id = ${USER}`;
});

describe('watch-sync-activity.queries', () => {
    it('records rows and fetches them newest-first, user+provider scoped', async () => {
        await recordSyncActivity(sql, [
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'success',
                title: 'A',
                eventKind: 'watched',
            },
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'skipped',
                title: 'B',
                error: 'no library match',
                externalRef: 'mal:99',
            },
            {
                userId: USER,
                provider: 'trakt',
                direction: 'push',
                outcome: 'failed',
                title: 'C',
                terminal: true,
                error: 'x',
            },
        ]);
        const mal = await getSyncActivity(sql, { userId: USER, provider: 'mal', limit: 10 });
        // B is a 'no library match' skip → hidden from the user feed; only A shows.
        expect(mal.map((r) => r.title)).toEqual(['A']);
        expect(mal.every((r) => r.direction === 'pull')).toBe(true);
        const trakt = await getSyncActivity(sql, { userId: USER, provider: 'trakt', limit: 10 });
        expect(trakt).toHaveLength(1);
        expect(trakt[0].terminal).toBe(true);
    });

    it("hides un-actionable 'not applicable' rows from the feed but keeps real activity", async () => {
        await recordSyncActivity(sql, [
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'success',
                title: 'seen-1',
                eventKind: 'watched',
            },
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'skipped',
                title: 'hidden-nolib',
                error: 'no library match',
                externalRef: 'mal:1',
            },
            {
                // non-anime push drain (Milo Farrow etc.) — un-actionable, hidden
                userId: USER,
                provider: 'mal',
                direction: 'push',
                outcome: 'failed',
                terminal: true,
                title: 'hidden-gaveup',
                error: 'no provider id (gave up)',
            },
            {
                // a genuine, actionable push failure stays visible
                userId: USER,
                provider: 'mal',
                direction: 'push',
                outcome: 'failed',
                terminal: true,
                title: 'seen-realfail',
                error: 'MAL API 500',
            },
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'success',
                title: 'seen-2',
                eventKind: 'progress',
            },
        ]);
        const rows = await getSyncActivity(sql, { userId: USER, provider: 'mal', limit: 10 });
        // newest-first; both 'not applicable' rows excluded, real failure kept
        expect(rows.map((r) => r.title)).toEqual(['seen-2', 'seen-realfail', 'seen-1']);
        expect(rows.some((r) => r.error === 'no library match')).toBe(false);
        expect(rows.some((r) => r.error === 'no provider id (gave up)')).toBe(false);
        // ...but both ARE still recorded in the table (diagnostic, just not surfaced).
        const [{ n }] = await sql<
            { n: string }[]
        >`SELECT count(*)::text n FROM watch_sync_activity WHERE user_id=${USER} AND error IN ('no library match','no provider id (gave up)')`;
        expect(Number(n)).toBe(2);
    });

    it('prunes to newest 50 per (user, provider, outcome-class)', async () => {
        const rows = [];
        for (let i = 0; i < 60; i++)
            rows.push({
                userId: USER,
                provider: 'mal',
                direction: 'pull' as const,
                outcome: 'success' as const,
                title: `s${i}`,
            });
        // Each unresolved item has its own provider id in production; give each
        // skipped row a DISTINCT external_ref so the recurring-dedup index does
        // not collapse them (COALESCE→'') and the prune still sees 60 rows.
        for (let i = 0; i < 60; i++)
            rows.push({
                userId: USER,
                provider: 'mal',
                direction: 'pull' as const,
                outcome: 'skipped' as const,
                title: `k${i}`,
                externalRef: `mal:${i}`,
            });
        await recordSyncActivity(sql, rows);
        await pruneSyncActivity(sql, 50);
        const [{ n: succ }] = await sql<
            { n: string }[]
        >`SELECT count(*)::text n FROM watch_sync_activity WHERE user_id=${USER} AND outcome='success'`;
        const [{ n: nonsucc }] = await sql<
            { n: string }[]
        >`SELECT count(*)::text n FROM watch_sync_activity WHERE user_id=${USER} AND outcome<>'success'`;
        expect(Number(succ)).toBe(50); // success class keeps its own newest 50
        expect(Number(nonsucc)).toBe(50); // skipped class keeps its own newest 50
    });

    it('dedups recurring (skipped) rows via upsert instead of duplicating', async () => {
        await recordSyncActivity(sql, [
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'skipped',
                externalRef: 'mal:777',
                title: 'X',
            },
        ]);
        await recordSyncActivity(sql, [
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'skipped',
                externalRef: 'mal:777',
                title: 'Y',
            },
        ]);
        const dup = await sql<{ title: string | null }[]>`
            SELECT title FROM watch_sync_activity
            WHERE user_id = ${USER}::uuid AND provider = 'mal' AND external_ref = 'mal:777'
        `;
        expect(dup).toHaveLength(1); // upsert refreshed the existing row
        expect(dup[0].title).toBe('Y'); // reason/title refreshed, not duplicated
    });

    it('does NOT dedup non-recurring (success) rows — both are appended', async () => {
        const MEDIA = '00000000-0000-0000-0000-0000000000bb';
        await recordSyncActivity(sql, [
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'success',
                mediaId: MEDIA,
                title: 'S1',
            },
        ]);
        await recordSyncActivity(sql, [
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'success',
                mediaId: MEDIA,
                title: 'S2',
            },
        ]);
        const both = await sql<{ n: string }[]>`
            SELECT count(*)::text n FROM watch_sync_activity
            WHERE user_id = ${USER}::uuid AND provider = 'mal'
              AND outcome = 'success' AND media_id = ${MEDIA}::uuid
        `;
        expect(Number(both[0].n)).toBe(2); // discrete events, both present
    });

    it('round-trips series_title for episode rows and leaves it null for movies', async () => {
        await recordSyncActivity(sql, [
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'success',
                title: 'Pilot',
                seriesTitle: 'Drifting Clouds',
                mediaType: 'episode',
                eventKind: 'watched',
            },
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'success',
                title: 'Some Movie',
                mediaType: 'movie',
                eventKind: 'watched',
            },
        ]);
        const rows = await getSyncActivity(sql, { userId: USER, provider: 'mal', limit: 10 });
        const episode = rows.find((r) => r.title === 'Pilot');
        const movie = rows.find((r) => r.title === 'Some Movie');
        expect(episode?.seriesTitle).toBe('Drifting Clouds');
        expect(movie?.seriesTitle).toBeNull();
    });

    it('round-trips season/episode numbers for episode rows and leaves them null for movies', async () => {
        await recordSyncActivity(sql, [
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'success',
                title: 'Pilot',
                seriesTitle: 'Drifting Clouds',
                seasonNumber: 1,
                episodeNumber: 4,
                mediaType: 'episode',
                eventKind: 'watched',
            },
            {
                userId: USER,
                provider: 'mal',
                direction: 'pull',
                outcome: 'success',
                title: 'Some Other Movie',
                mediaType: 'movie',
                eventKind: 'watched',
            },
        ]);
        const rows = await getSyncActivity(sql, { userId: USER, provider: 'mal', limit: 10 });
        const episode = rows.find((r) => r.title === 'Pilot');
        const movie = rows.find((r) => r.title === 'Some Other Movie');
        expect(episode?.seasonNumber).toBe(1);
        expect(episode?.episodeNumber).toBe(4);
        expect(movie?.seasonNumber).toBeNull();
        expect(movie?.episodeNumber).toBeNull();
    });

    it('unlink-style purge deletes only the given provider', async () => {
        await recordSyncActivity(sql, [
            { userId: USER, provider: 'mal', direction: 'pull', outcome: 'success', title: 'M' },
            { userId: USER, provider: 'trakt', direction: 'pull', outcome: 'success', title: 'T' },
        ]);
        await sql`DELETE FROM watch_sync_activity WHERE user_id=${USER}::uuid AND provider='mal'`;
        const mal = await getSyncActivity(sql, { userId: USER, provider: 'mal', limit: 10 });
        const trakt = await getSyncActivity(sql, { userId: USER, provider: 'trakt', limit: 10 });
        expect(mal).toHaveLength(0);
        expect(trakt).toHaveLength(1);
    });
});
