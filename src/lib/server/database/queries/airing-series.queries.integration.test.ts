// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * findAiringSeriesDueForRefresh: which library series airing-series-refresh
 * re-syncs, and in which order.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { findAiringSeriesDueForRefresh } from './airing-series.queries.js';

const PREFIX = 'Airing Refresh Test';
const DAY_MS = 24 * 60 * 60 * 1000;

describe('findAiringSeriesDueForRefresh', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await sql`DELETE FROM upcoming_releases WHERE series_title LIKE ${PREFIX + '%'}`;
        await sql`DELETE FROM task_history WHERE id LIKE 'airing-refresh-test-%'`;
        await sql`DELETE FROM media_items WHERE title LIKE ${PREFIX + '%'}`;
    });

    async function insertSeries(opts: {
        title: string;
        tmdbId: string;
        tvdbId?: string;
        status?: string | null;
        syncedDaysAgo?: number | null;
        hasFiles?: boolean;
        locked?: boolean;
    }): Promise<string> {
        const id = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, media_type, title, status, has_files, metadata_locked)
            VALUES (${id}::uuid, 'tv', ${`${PREFIX} ${opts.title}`}, 'active',
                    ${opts.hasFiles ?? true}, ${opts.locked ?? false})
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${id}::uuid, 'tmdb', ${opts.tmdbId}, 'tv')
        `;
        if (opts.tvdbId) {
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${id}::uuid, 'tvdb', ${opts.tvdbId}, 'tv')
            `;
        }
        if (opts.syncedDaysAgo !== null) {
            const at = new Date(Date.now() - (opts.syncedDaysAgo ?? 10) * DAY_MS);
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, updated_at)
                VALUES (${id}::uuid, 'tmdb',
                        ${sql.json(opts.status ? { status: opts.status } : {})}, ${at})
            `;
        }
        return id;
    }

    const staleBefore = (): Date => new Date(Date.now() - DAY_MS);
    // Large limit: other suites' leftover rows in the shared DB must not push
    // these out of the window.
    const titles = async (limit = 10_000): Promise<string[]> =>
        (await findAiringSeriesDueForRefresh(sql, { staleBefore: staleBefore(), limit }))
            .map((r) => r.title)
            .filter((t) => t.startsWith(PREFIX))
            .map((t) => t.slice(PREFIX.length + 1));

    it('picks stale airing series by TMDB status, oldest first', async () => {
        await insertSeries({
            title: 'Returning',
            tmdbId: '810001',
            status: 'Returning Series',
            syncedDaysAgo: 3,
        });
        await insertSeries({
            title: 'Production',
            tmdbId: '810002',
            status: 'In Production',
            syncedDaysAgo: 9,
        });
        await insertSeries({
            title: 'Ended',
            tmdbId: '810003',
            status: 'Ended',
            syncedDaysAgo: 30,
        });
        await insertSeries({
            title: 'Fresh',
            tmdbId: '810004',
            status: 'Returning Series',
            syncedDaysAgo: 0.1,
        });

        expect(await titles()).toEqual(['Production', 'Returning']);
    });

    it('also picks an ended-looking series with a Sonarr episode in the window, matched by TVDB id', async () => {
        await insertSeries({
            title: 'Revived',
            tmdbId: '810011',
            tvdbId: '910011',
            status: 'Ended',
            syncedDaysAgo: 5,
        });
        await sql`
            INSERT INTO upcoming_releases
                (source, source_item_id, media_type, tvdb_id, series_title, title, season_number, episode_number, air_date)
            VALUES ('sonarr', 881011, 'episode', 910011, ${PREFIX + ' Revived'}, 'New', 2, 1, current_date + 10)
        `;

        expect(await titles()).toEqual(['Revived']);
    });

    it('skips series without files, locked series and respects the limit', async () => {
        await insertSeries({
            title: 'No Files',
            tmdbId: '810021',
            status: 'Returning Series',
            hasFiles: false,
        });
        await insertSeries({
            title: 'Locked',
            tmdbId: '810022',
            status: 'Returning Series',
            locked: true,
        });
        await insertSeries({
            title: 'A',
            tmdbId: '810023',
            status: 'Returning Series',
            syncedDaysAgo: 8,
        });
        await insertSeries({
            title: 'B',
            tmdbId: '810024',
            status: 'Returning Series',
            syncedDaysAgo: 4,
        });

        expect(await titles()).toEqual(['A', 'B']);
        const limited = await findAiringSeriesDueForRefresh(sql, {
            staleBefore: staleBefore(),
            limit: 1,
        });
        expect(limited).toHaveLength(1);
    });

    let arrItemId = 882000;
    async function sonarrRow(opts: {
        tmdbId?: number;
        tvdbId?: number;
        inDays: number;
        mediaType?: 'episode' | 'movie';
    }): Promise<void> {
        arrItemId++;
        await sql`
            INSERT INTO upcoming_releases
                (source, source_item_id, media_type, tmdb_id, tvdb_id, series_title, title,
                 season_number, episode_number, air_date)
            VALUES ('sonarr', ${arrItemId}, ${opts.mediaType ?? 'episode'}, ${opts.tmdbId ?? null},
                    ${opts.tvdbId ?? null}, ${PREFIX + ' arr'}, 'Row', 1, 1,
                    current_date + ${opts.inDays}::int)
        `;
    }

    it('matches a Sonarr episode by TMDB id, inside the -7..+30 day window only', async () => {
        await insertSeries({ title: 'Edge Low', tmdbId: '820001', status: 'Ended' });
        await insertSeries({ title: 'Edge High', tmdbId: '820002', status: 'Ended' });
        await insertSeries({ title: 'Too Old', tmdbId: '820003', status: 'Ended' });
        await insertSeries({ title: 'Too Far', tmdbId: '820004', status: 'Ended' });
        await insertSeries({ title: 'Movie Row', tmdbId: '820005', status: 'Ended' });
        await sonarrRow({ tmdbId: 820001, inDays: -7 });
        await sonarrRow({ tmdbId: 820002, inDays: 30 });
        await sonarrRow({ tmdbId: 820003, inDays: -8 });
        await sonarrRow({ tmdbId: 820004, inDays: 31 });
        await sonarrRow({ tmdbId: 820005, inDays: 3, mediaType: 'movie' });

        expect((await titles()).sort()).toEqual(['Edge High', 'Edge Low']);
    });

    it('puts a never-synced airing series first and ignores a stale one without a status', async () => {
        await insertSeries({ title: 'Never Synced', tmdbId: '830001', syncedDaysAgo: null });
        await sonarrRow({ tmdbId: 830001, inDays: 2 });
        await insertSeries({
            title: 'Old Returning',
            tmdbId: '830002',
            status: 'Returning Series',
            syncedDaysAgo: 40,
        });
        await insertSeries({
            title: 'No Status',
            tmdbId: '830003',
            status: null,
            syncedDaysAgo: 40,
        });

        expect(await titles()).toEqual(['Never Synced', 'Old Returning']);
    });

    it('skips inactive items and movies', async () => {
        const inactive = await insertSeries({
            title: 'Inactive',
            tmdbId: '840001',
            status: 'Returning Series',
        });
        await sql`UPDATE media_items SET status = 'deleted' WHERE id = ${inactive}::uuid`;
        const movie = await insertSeries({
            title: 'Movie',
            tmdbId: '840002',
            status: 'Returning Series',
        });
        await sql`UPDATE media_items SET media_type = 'movie' WHERE id = ${movie}::uuid`;

        expect(await titles()).toEqual([]);
    });

    it('skips a series with a series-sync queued, or tried since the stale cutoff', async () => {
        const queued = await insertSeries({
            title: 'Queued',
            tmdbId: '850001',
            status: 'Returning Series',
        });
        const failing = await insertSeries({
            title: 'Failing',
            tmdbId: '850002',
            status: 'Returning Series',
        });
        const triedLongAgo = await insertSeries({
            title: 'Tried Long Ago',
            tmdbId: '850003',
            status: 'Returning Series',
        });
        const history = [
            { id: 'airing-refresh-test-1', mediaItemId: queued, state: 'pending', hoursAgo: 30 },
            { id: 'airing-refresh-test-2', mediaItemId: failing, state: 'failed', hoursAgo: 2 },
            {
                id: 'airing-refresh-test-3',
                mediaItemId: triedLongAgo,
                state: 'failed',
                hoursAgo: 30,
            },
        ];
        for (const h of history) {
            await sql`
                INSERT INTO task_history
                    (id, task_id, label, state, input, trigger, actor, started_at, processing_version)
                VALUES (${h.id}, 'series-sync', 'series-sync', ${h.state},
                        ${sql.json({ mediaItemId: h.mediaItemId })}, ${sql.json({ kind: 'in-process' })},
                        ${sql.json({ type: 'system' })}, now() - ${`${h.hoursAgo} hours`}::interval, '1')
            `;
        }

        expect(await titles()).toEqual(['Tried Long Ago']);
    });
});
