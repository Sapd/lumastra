// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Folderless-layout regression: a season and its series resolve to the SAME
 * directory, so the season's artwork takes a qualified filename — and the next
 * library scan must not hand the series' `poster.jpg` to the season.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../tests/integration/fixtures/index.js';
import {
    upsertLocalArtwork,
    getOwnLocalArtwork,
} from '../database/queries/media-artwork.queries.js';
import { upsertMediaFile, attachFileToItem } from '../database/queries/media-files.queries.js';
import { processArtwork } from '../tasks/builtin/native/media-sources/_helpers/file-scanner/ancillary-processors.js';
import { providerSourceTag } from '../utils/media-extras.js';

const SERIES_POSTER = '/data/series/Show/poster.jpg';
const SEASON_POSTER = '/data/series/Show/season01-poster.jpg';
const EPISODE_FILE = '/data/series/Show/S01E01.mkv';

describe('folderless layout — materialize then scan', () => {
    let sql: postgres.Sql;
    let seriesId: string;
    let seasonId: string;

    const scanContext = () =>
        ({
            sql,
            logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
        }) as never;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            'media_artwork',
            'media_artwork_suppressions',
        ]);

        const series = createTestMediaItem({ media_type: 'tv', has_files: true });
        const season = createTestMediaItem({
            media_type: 'season',
            parent_id: series.id,
            has_files: true,
        });
        const episode = createTestMediaItem({
            media_type: 'episode',
            parent_id: season.id,
            has_files: true,
        });
        await insertTestMediaItem(sql, series);
        await insertTestMediaItem(sql, season);
        await insertTestMediaItem(sql, episode);
        await sql`UPDATE media_items SET season_number = 1 WHERE id = ${season.id}::uuid`;

        // Folderless: the episode file sits DIRECTLY in the series folder.
        const { id: fileId } = await upsertMediaFile(sql, { filePath: EPISODE_FILE });
        await attachFileToItem(sql, fileId, episode.id);

        seriesId = series.id;
        seasonId = season.id;

        // What materializeProviderArtwork writes: the series takes poster.jpg, the
        // season takes the qualified name from the collision resolver. Both carry
        // provider provenance.
        await upsertLocalArtwork(sql, {
            mediaItemId: seriesId,
            artworkType: 'poster',
            filePath: SERIES_POSTER,
            sourceTag: providerSourceTag('tmdb', 'poster'),
        });
        await upsertLocalArtwork(sql, {
            mediaItemId: seasonId,
            artworkType: 'poster',
            filePath: SEASON_POSTER,
            sourceTag: providerSourceTag('tmdb', 'poster'),
        });
    });

    it('materializes the season to a qualified filename, series untouched', async () => {
        expect((await getOwnLocalArtwork(sql, seriesId, 'poster'))?.file_path).toBe(SERIES_POSTER);
        expect((await getOwnLocalArtwork(sql, seasonId, 'poster'))?.file_path).toBe(SEASON_POSTER);
    });

    it('a later scan does NOT hand the series poster to the season', async () => {
        // The scanner resolves /data/series/Show to the episode, then redirects to
        // the season — the exact re-attribution the claim guard exists to stop.
        const outcome = await processArtwork(
            sql,
            { filePath: SERIES_POSTER, artworkType: 'poster' },
            scanContext(),
        );

        expect(outcome).toBe('skipped');
        expect((await getOwnLocalArtwork(sql, seasonId, 'poster'))?.file_path).toBe(SEASON_POSTER);
        expect((await getOwnLocalArtwork(sql, seriesId, 'poster'))?.file_path).toBe(SERIES_POSTER);
    });

    it('a later scan does NOT erase the provider provenance', async () => {
        await processArtwork(
            sql,
            { filePath: SERIES_POSTER, artworkType: 'poster' },
            scanContext(),
        );

        expect((await getOwnLocalArtwork(sql, seriesId, 'poster'))?.remote_url).toBe(
            'provider:tmdb:poster',
        );
        expect((await getOwnLocalArtwork(sql, seasonId, 'poster'))?.remote_url).toBe(
            'provider:tmdb:poster',
        );
    });

    it('still re-registers a genuinely new sidecar for the resolved item', async () => {
        // A user drops their own backdrop in the same folder. Nothing claims it, so
        // the scanner must still attach it — the guard must not over-block.
        const outcome = await processArtwork(
            sql,
            { filePath: '/data/series/Show/fanart.jpg', artworkType: 'backdrop' },
            scanContext(),
        );

        expect(outcome).toBe('added');
        // findParentMediaItemByFolder resolves /data/series/Show to the episode
        // (its file sits directly there), then findSeasonParentIfEpisode
        // redirects to the season — so the new sidecar lands on the SEASON row.
        expect((await getOwnLocalArtwork(sql, seasonId, 'backdrop'))?.file_path).toBe(
            '/data/series/Show/fanart.jpg',
        );
    });
});
