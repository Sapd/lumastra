// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { closeTestDb, getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    findOrCreateMusicAlbum,
    findOrCreateMusicArtist,
    findOrCreatePersonalEpisode,
    findOrCreatePersonalSeason,
    findOrCreatePersonalSeries,
    findOrCreateSeries,
    insertExtraMediaItem,
    insertScannedMediaItem,
    renamePersonalSeries,
    updateAndLockMediaItem,
} from './media-items.queries.js';
import { updateOriginalTitleByTmdbId } from './ai-sync.queries.js';
import { updateMediaItemMetadata } from './embedding-operations.queries.js';
import { refreshSortTitles } from './sort-title.queries.js';
import { CatalogService } from '../../services/catalog.service.js';
import { MediaLifecycleService } from '../../services/media-lifecycle.service.js';

let sql: postgres.Sql;
const DE_GROUP = randomUUID();
const EN_GROUP = randomUUID();

async function sortTitleOf(id: string): Promise<string | null> {
    const [row] = await sql<{ sort_title: string | null }[]>`
        SELECT sort_title FROM media_items WHERE id = ${id}
    `;
    return row.sort_title;
}

async function cleanupLibraries(): Promise<void> {
    await truncateTables(sql, TEST_TABLES.media);
    await sql`DELETE FROM library_paths WHERE path LIKE '/sorttest/%'`;
    await sql`DELETE FROM library_groups WHERE name LIKE 'sorttest-%'`;
}

beforeAll(async () => {
    sql = getTestDb();
    await cleanupLibraries();
    await sql`INSERT INTO library_groups (id, name) VALUES (${DE_GROUP}, 'sorttest-a'), (${EN_GROUP}, 'sorttest-b')`;
    await sql`
        INSERT INTO library_paths (path, media_type, language, library_group_id) VALUES
            ('/sorttest/de', 'movie', 'de', ${DE_GROUP}),
            ('/sorttest/en', 'movie', 'en', ${EN_GROUP})
    `;
});

beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
});

afterAll(async () => {
    await cleanupLibraries();
    await closeTestDb();
});

describe('media_items write paths set sort_title', () => {
    it('insertScannedMediaItem: article stripped with the default language', async () => {
        const id = await insertScannedMediaItem(sql, {
            title: 'The Doll',
            mediaType: 'movie',
            libraryGroupId: EN_GROUP,
        });
        expect(await sortTitleOf(id)).toBe('doll');
    });

    it('insertScannedMediaItem: uses the library language through library_group_id', async () => {
        const id = await insertScannedMediaItem(sql, {
            title: 'Der Zug',
            mediaType: 'movie',
            libraryGroupId: DE_GROUP,
        });
        expect(await sortTitleOf(id)).toBe('zug');
        const noGroup = await insertScannedMediaItem(sql, { title: 'Der Zug', mediaType: 'movie' });
        expect(await sortTitleOf(noGroup)).toBe('der zug');
    });

    it('insertScannedMediaItem: an episode takes the language of its series group', async () => {
        const seriesId = await insertScannedMediaItem(sql, {
            title: 'Die Serie',
            mediaType: 'tv',
            libraryGroupId: DE_GROUP,
        });
        const seasonId = await findOrCreatePersonalSeason(sql, { seriesId, seasonNumber: 1 });
        const { id } = await findOrCreatePersonalEpisode(sql, {
            seasonId,
            seasonNumber: 1,
            episodeNumber: 1,
            title: 'Das Ende',
        });
        expect(await sortTitleOf(seriesId)).toBe('serie');
        expect(await sortTitleOf(seasonId)).toBe('season 1');
        expect(await sortTitleOf(id)).toBe('ende');
    });

    it('insertExtraMediaItem', async () => {
        const movieId = await insertScannedMediaItem(sql, { title: 'Movie', mediaType: 'movie' });
        const id = await insertExtraMediaItem(sql, {
            title: 'A Making Of',
            extraType: 'featurette',
            parentId: movieId,
        });
        expect(await sortTitleOf(id)).toBe('making of');
    });

    it('findOrCreatePersonalSeries', async () => {
        const id = await findOrCreatePersonalSeries(sql, { title: 'The Show' });
        expect(await sortTitleOf(id)).toBe('show');
    });

    it('findOrCreateSeries', async () => {
        const id = await findOrCreateSeries(sql, {
            title: 'A Quiet Show',
            libraryGroupId: EN_GROUP,
        });
        expect(await sortTitleOf(id)).toBe('quiet show');
    });

    it('renamePersonalSeries recomputes the key', async () => {
        const id = await findOrCreatePersonalSeries(sql, { title: 'Old Name' });
        expect(await sortTitleOf(id)).toBe('old name');
        const renamed = await renamePersonalSeries(sql, { seriesId: id, title: 'The New Name' });
        expect(renamed).toBe(id);
        expect(await sortTitleOf(id)).toBe('new name');
    });

    it('findOrCreateMusicArtist and findOrCreateMusicAlbum', async () => {
        const artistId = await findOrCreateMusicArtist(sql, {
            name: 'The Band',
            libraryGroupId: EN_GROUP,
        });
        const albumId = await findOrCreateMusicAlbum(sql, {
            title: 'An Album',
            artistId,
            libraryGroupId: EN_GROUP,
        });
        expect(await sortTitleOf(artistId)).toBe('band');
        expect(await sortTitleOf(albumId)).toBe('album');
    });

    it('music track inserted under an album', async () => {
        const artistId = await findOrCreateMusicArtist(sql, { name: 'Die Band' });
        const albumId = await findOrCreateMusicAlbum(sql, { title: 'Das Album', artistId });
        const trackId = await insertScannedMediaItem(sql, {
            title: 'The Track',
            mediaType: 'track',
            parentId: albumId,
        });
        expect(await sortTitleOf(trackId)).toBe('track');
    });

    it('updateAndLockMediaItem recomputes the key when the title changes', async () => {
        const id = await insertScannedMediaItem(sql, { title: 'Zebra', mediaType: 'movie' });
        expect(await sortTitleOf(id)).toBe('zebra');
        await updateAndLockMediaItem(sql, id, 'tester', { title: 'The Apple' });
        expect(await sortTitleOf(id)).toBe('apple');
    });

    it('updateOriginalTitleByTmdbId recomputes the key from the English title', async () => {
        const id = randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type) VALUES (${id}, 'Kyoryu', 'movie')`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary, source)
            VALUES (${id}, 'tmdb', '987001', 'movie', TRUE, 'api')`;
        const written = await updateOriginalTitleByTmdbId(
            sql,
            '987001',
            'movie',
            'Kyoryu',
            'The Dinosaur',
        );
        expect(written).toBe(1);
        expect(await sortTitleOf(id)).toBe('dinosaur');
    });

    it('updateMediaItemMetadata', async () => {
        const id = randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type) VALUES (${id}, 'x', 'movie')`;
        await updateMediaItemMetadata(sql, {
            mediaId: id,
            title: 'A Title',
            originalTitle: null,
            year: null,
            isLocalOnly: false,
        });
        expect(await sortTitleOf(id)).toBe('title');
    });

    it('CatalogService.createLocalOnlyItem', async () => {
        // A detached stage-seeding query can outlive this test and deadlock
        // the next media TRUNCATE. The option must prevent starting it at all.
        const afterCreated = vi.spyOn(MediaLifecycleService, 'afterCreated').mockResolvedValue();
        try {
            const catalog = new CatalogService(sql, { skipLifecycleHooks: true });
            const localId = await catalog.createLocalOnlyItem(
                randomUUID(),
                'The Local Film',
                'movie',
            );
            expect(await sortTitleOf(localId)).toBe('local film');
            expect(afterCreated).not.toHaveBeenCalled();
        } finally {
            afterCreated.mockRestore();
        }
    });

    it('refreshSortTitles heals a NULL key and is a no-op the second time', async () => {
        const id = randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type) VALUES (${id}, 'The Doll', 'movie')`;
        expect(await sortTitleOf(id)).toBeNull();
        expect(await refreshSortTitles(sql, [id])).toBe(1);
        expect(await sortTitleOf(id)).toBe('doll');
        expect(await refreshSortTitles(sql, [id])).toBe(0);
        expect(await refreshSortTitles(sql, [])).toBe(0);
    });

    it('refreshSortTitles logs no sync change for the key, and leaves capture on in a caller transaction', async () => {
        const series = randomUUID();
        await sql`INSERT INTO media_items (id, title, media_type) VALUES (${series}, 'The Doll', 'tv')`;
        const count = async () =>
            Number((await sql<{ n: string }[]>`SELECT COUNT(*)::text AS n FROM sync_changes`)[0].n);
        const before = await count();
        expect(await refreshSortTitles(sql, [series])).toBe(1);
        expect(await count()).toBe(before);

        await sql.begin(async (tx) => {
            await tx`UPDATE media_items SET sort_title = NULL WHERE id = ${series}`;
            await refreshSortTitles(tx as unknown as postgres.Sql, [series]);
            const [{ setting }] = await tx<{ setting: string | null }[]>`
                SELECT current_setting('lumastra.sync_capture', true) AS setting
            `;
            expect(setting === null || setting === '').toBe(true);
        });
    });
});
