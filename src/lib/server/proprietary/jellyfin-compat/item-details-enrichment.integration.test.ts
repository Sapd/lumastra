// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * BaseItemDto fields from `getJellyfinItemExtras` against real rows (brief 09):
 * CriticRating, series Status / EndDate / DisplayOrder, track HasLyrics /
 * NormalizationGain, IndexNumberEnd of a multi-episode file, and list
 * Chapters / Trickplay.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    enrichItemsWithChaptersAndTrickplay,
    enrichItemsWithItemDetails,
} from './item-details-enrichment';
import type { JellyfinBaseItemDto, JellyfinItemType } from './types';

let sql: postgres.Sql;

beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, [
        'provider_metadata',
        'series_episode_ordering',
        'episode_chapters',
        'trickplay_params',
        'media_file_items',
        'media_files',
        'media_items',
    ]);
});

async function row(
    title: string,
    type: string,
    extra: { parentId?: string; episode?: number; custom?: Record<string, unknown> } = {},
): Promise<string> {
    const [r] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, parent_id, episode_number, season_number,
                                 custom_metadata, has_files)
        VALUES (${title}, ${type}, 'active', ${extra.parentId ?? null}, ${extra.episode ?? null},
                ${extra.episode !== undefined ? 1 : null}, ${sql.json((extra.custom ?? {}) as never)}, true)
        RETURNING id`;
    return r.id;
}

async function file(itemIds: string[]): Promise<string> {
    const [f] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path, created_at, updated_at)
        VALUES (${`/details/${itemIds.join('-')}.mkv`}, NOW(), NOW()) RETURNING id`;
    for (const id of itemIds) {
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${f.id}::uuid, ${id}::uuid)`;
    }
    return f.id;
}

function dto(id: string, type: JellyfinItemType, extra: Partial<JellyfinBaseItemDto> = {}) {
    return { Name: 'x', Id: id, ServerId: 's', Type: type, ...extra } as JellyfinBaseItemDto;
}

describe('enrichItemsWithItemDetails', () => {
    it('fills critic rating and the series facts', async () => {
        const movie = await row('Movie', 'movie');
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
                  VALUES (${movie}::uuid, 'tmdb', ${sql.json({ rt_rating: '87' })})`;
        const show = await row('Show', 'tv');
        await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
                  VALUES (${show}::uuid, 'tmdb', ${sql.json({ status: 'Ended', last_air_date: '2020-05-01' })})`;
        await sql`INSERT INTO series_episode_ordering (media_id, ordering_type) VALUES (${show}::uuid, 'dvd')`;
        const items = [dto(movie, 'Movie'), dto(show, 'Series')];
        await enrichItemsWithItemDetails(sql, items);
        expect(items[0].CriticRating).toBe(87);
        expect(items[1]).toMatchObject({
            Status: 'Ended',
            EndDate: '2020-05-01T00:00:00.0000000Z',
            DisplayOrder: 'dvd',
        });
    });

    it('fills track lyrics and loudness', async () => {
        const withLyrics = await row('Song', 'track', {
            custom: { lyrics: { plain: 'la la' }, essentia: { loudness_lufs: -9.5 } },
        });
        const fetchedNone = await row('Quiet', 'track', {
            custom: { lyrics: { plain: null, synced: null, fetchedAt: '2026-01-01' } },
        });
        const items = [dto(withLyrics, 'Audio'), dto(fetchedNone, 'Audio')];
        await enrichItemsWithItemDetails(sql, items);
        expect(items[0]).toMatchObject({ HasLyrics: true, NormalizationGain: -8.5 });
        expect(items[1].HasLyrics).toBe(false);
        expect(items[1]).not.toHaveProperty('NormalizationGain');
    });

    it('gives the first episode of a multi-episode file its IndexNumberEnd', async () => {
        const show = await row('Show', 'tv');
        const season = await row('Season 1', 'season', { parentId: show });
        const e1 = await row('Part 1', 'episode', { parentId: season, episode: 1 });
        const e2 = await row('Part 2', 'episode', { parentId: season, episode: 2 });
        const e3 = await row('Alone', 'episode', { parentId: season, episode: 3 });
        await file([e1, e2]);
        await file([e3]);
        const items = [
            dto(e1, 'Episode', { IndexNumber: 1 }),
            dto(e2, 'Episode', { IndexNumber: 2 }),
            dto(e3, 'Episode', { IndexNumber: 3 }),
        ];
        await enrichItemsWithItemDetails(sql, items);
        expect(items[0].IndexNumberEnd).toBe(2);
        expect(items[1]).not.toHaveProperty('IndexNumberEnd');
        expect(items[2]).not.toHaveProperty('IndexNumberEnd');
    });
});

describe('enrichItemsWithChaptersAndTrickplay', () => {
    it('loads both for every listed video in one go', async () => {
        const movie = await row('Movie', 'movie');
        const fileId = await file([movie]);
        await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks)
                  VALUES (${fileId}::uuid, 0, 'Opening', 0), (${fileId}::uuid, 1, NULL, 600000000)`;
        await sql`INSERT INTO trickplay_params (media_item_id, file_id, width, height, tile_width, tile_height,
                                                thumbnail_count, interval_ms, bandwidth, source)
                  VALUES (${movie}::uuid, ${fileId}::uuid, 320, 180, 10, 10, 42, 10000, 1000, 'test')`;
        const items = [dto(movie, 'Movie')];
        await enrichItemsWithChaptersAndTrickplay(sql, items, { chapters: true, trickplay: true });
        expect(items[0].Chapters?.map((c) => c.StartPositionTicks)).toEqual([0, 600000000]);
        expect(items[0].Chapters?.[0].ImageTag).toBeDefined();
        expect(items[0].Trickplay?.[fileId]?.['320x180']).toMatchObject({ ThumbnailCount: 42 });
    });
});
