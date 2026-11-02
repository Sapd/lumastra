// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-DB coverage for the season-poster enqueue filter.
 *
 * `syncSeriesWithChildren` re-enqueues every season that TMDB lists a poster for,
 * on every series sync. The filter must drop seasons whose poster is already local
 * (whatever its TMDB path: the task never replaces a local poster), and keep
 * seasons whose poster is missing, or hidden with a new TMDB image available. Only the enqueued ids reach `orchestrator.startRun`, so the
 * assertions are on that call.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';

const { mockStartRun } = vi.hoisted(() => ({ mockStartRun: vi.fn() }));

vi.mock('$lib/server/tasks/registry.js', () => ({
    getRegistry: () => ({ getTask: () => ({ id: 'provider-artwork-season-poster' }) }),
}));

vi.mock('$lib/server/tasks/orchestrator.js', () => ({
    orchestrator: { startRun: mockStartRun },
}));

import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import { enqueueSeasonArtworkMaterialization } from './season-artwork-enqueue.js';

const SOURCE = 'metadata-sync-single.syncSeriesWithChildren';
const posterUrl = (path: string): string => `https://image.tmdb.org/t/p/w342${path}`;

const uuid = (): string => crypto.randomUUID();

describe('enqueueSeasonArtworkMaterialization (real DB)', () => {
    let sql: postgres.Sql;
    let nextSeriesTmdbId = 90001;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        vi.clearAllMocks();
        mockStartRun.mockResolvedValue({ runId: 'run' });
        await truncateTables(sql, [
            'image_candidates',
            'media_item_stage_state',
            'external_ids',
            'media_files',
            'media_items',
        ]);
    });

    /** A tv series with a TMDB id, and one season with files under it. */
    async function insertSeason(seasonNumber: number): Promise<string> {
        const seriesId = uuid();
        const seasonId = uuid();
        const seriesTmdbId = String(nextSeriesTmdbId++);
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${seriesId}::uuid, ${'Series ' + seriesTmdbId}, 'tv', 'active', true)
        `;
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
            VALUES (${seasonId}::uuid, ${'Season ' + seasonNumber}, 'season', 'active', true,
                    ${seriesId}::uuid, ${seasonNumber})
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${seriesId}::uuid, 'tmdb', ${seriesTmdbId}, 'tv', true)
        `;
        return seasonId;
    }

    /** The season's own selected local poster, as materializeProviderArtwork writes it. */
    async function insertLocalPoster(
        seasonId: string,
        row: { provider: string; providerRef: string },
    ): Promise<void> {
        await sql`
            INSERT INTO image_candidates
                (media_item_id, artwork_type, source, provider, provider_ref, file_path, selected)
            VALUES (${seasonId}::uuid, 'poster', 'local', ${row.provider}, ${row.providerRef},
                    ${'/data/Show/Season ' + uuid() + '/poster.jpg'}, true)
        `;
    }

    function enqueuedIds(): string[] {
        return mockStartRun.mock.calls.map((c) => (c[1] as { mediaItemId: string }).mediaItemId);
    }

    it('does not enqueue a season whose poster is already local and current', async () => {
        const season = await insertSeason(1);
        await insertLocalPoster(season, {
            provider: 'tmdb',
            providerRef: posterUrl('/s1-current.jpg'),
        });

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [{ mediaItemId: season, posterUrl: posterUrl('/s1-current.jpg') }],
            SOURCE,
        );

        expect(count).toBe(0);
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('does not enqueue a season whose local poster came from a folder, not TMDB', async () => {
        const season = await insertSeason(2);
        await insertLocalPoster(season, {
            provider: 'local-folder',
            providerRef: '/data/Show/Season 2/poster.jpg',
        });

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [{ mediaItemId: season, posterUrl: posterUrl('/s2-tmdb.jpg') }],
            SOURCE,
        );

        expect(count).toBe(0);
        expect(mockStartRun).not.toHaveBeenCalled();
    });

    it('enqueues a new season that has no local poster', async () => {
        const season = await insertSeason(3);

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [{ mediaItemId: season, posterUrl: posterUrl('/s3.jpg') }],
            SOURCE,
        );

        expect(count).toBe(1);
        expect(enqueuedIds()).toEqual([season]);
    });

    it('enqueues a season whose local poster row is gone (file vanished and was cleaned up)', async () => {
        // The file-existence cleanup deletes the row, so the DB state is "no local
        // poster" and the season must be re-enqueued for a fresh fetch.
        const season = await insertSeason(4);

        await enqueueSeasonArtworkMaterialization(
            sql,
            [{ mediaItemId: season, posterUrl: posterUrl('/s4.jpg') }],
            SOURCE,
        );

        expect(enqueuedIds()).toEqual([season]);
    });

    it('does not re-enqueue a season whose TMDB poster path changed (local posters are never replaced)', async () => {
        const season = await insertSeason(5);
        await insertLocalPoster(season, {
            provider: 'tmdb',
            providerRef: posterUrl('/s5-old.jpg'),
        });

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [{ mediaItemId: season, posterUrl: posterUrl('/s5-new.jpg') }],
            SOURCE,
        );

        expect(count).toBe(0);
        expect(enqueuedIds()).toEqual([]);
    });

    it('does not re-enqueue a season whose hidden poster is the same TMDB image', async () => {
        const season = await insertSeason(9);
        await insertLocalPoster(season, { provider: 'tmdb', providerRef: posterUrl('/s9.jpg') });
        await sql`UPDATE image_candidates SET suppressed = true, selected = false WHERE media_item_id = ${season}::uuid`;

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [{ mediaItemId: season, posterUrl: posterUrl('/s9.jpg') }],
            SOURCE,
        );

        expect(count).toBe(0);
        expect(enqueuedIds()).toEqual([]);
    });

    it('enqueues a season whose hidden poster was replaced by a new TMDB image', async () => {
        const season = await insertSeason(10);
        await insertLocalPoster(season, {
            provider: 'tmdb',
            providerRef: posterUrl('/s10-old.jpg'),
        });
        await sql`UPDATE image_candidates SET suppressed = true, selected = false WHERE media_item_id = ${season}::uuid`;

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [{ mediaItemId: season, posterUrl: posterUrl('/s10-new.jpg') }],
            SOURCE,
        );

        expect(count).toBe(1);
        expect(enqueuedIds()).toEqual([season]);
    });

    it('filters a mixed batch down to only the missing season', async () => {
        const current = await insertSeason(6);
        await insertLocalPoster(current, {
            provider: 'tmdb',
            providerRef: posterUrl('/s6.jpg'),
        });
        const missing = await insertSeason(7);
        const changed = await insertSeason(8);
        await insertLocalPoster(changed, {
            provider: 'tmdb',
            providerRef: posterUrl('/s8-old.jpg'),
        });

        const count = await enqueueSeasonArtworkMaterialization(
            sql,
            [
                { mediaItemId: current, posterUrl: posterUrl('/s6.jpg') },
                { mediaItemId: missing, posterUrl: posterUrl('/s7.jpg') },
                { mediaItemId: changed, posterUrl: posterUrl('/s8-new.jpg') },
            ],
            SOURCE,
        );

        expect(count).toBe(1);
        expect(enqueuedIds()).toEqual([missing]);
    });
});
