// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import type postgres from 'postgres';
import { clearMusicArtworkProvenance } from './music-enrichment-provenance.queries.js';
vi.mock('./music-enrichment-provenance.queries.js', () => ({
    clearMusicArtworkProvenance: vi.fn().mockResolvedValue(undefined),
}));
import { getArtworkWithInheritance, upsertLocalArtwork } from './media-artwork.queries.js';

// Helper to build a tagged-template mock that returns the given rows
function makeSql(...returnValues: unknown[][]) {
    let callIndex = 0;
    const fn = vi.fn().mockImplementation(() => {
        const val = returnValues[callIndex] ?? [];
        callIndex++;
        return Promise.resolve(val);
    });
    return fn as unknown as postgres.Sql;
}

describe('getArtworkWithInheritance', () => {
    it('returns empty array when media item does not exist', async () => {
        const sql = makeSql([]); // CTE returns nothing
        const result = await getArtworkWithInheritance(sql, 'non-existent-id');
        expect(result).toEqual([]);
    });

    it('returns self-owned artwork with source: self', async () => {
        const episodeId = 'episode-uuid';
        const sql = makeSql(
            // CTE: only the episode itself (no parents)
            [
                {
                    id: episodeId,
                    title: 'S01E01',
                    media_type: 'episode',
                    depth: 0,
                },
            ],
            // Artwork query: episode has a backdrop
            [
                {
                    id: 'art-1',
                    media_item_id: episodeId,
                    artwork_type: 'backdrop',
                    source: 'local',
                    file_path: '/images/backdrop.jpg',
                    remote_url: null,
                    language: null,
                    sort_order: 0,
                    created_at: new Date(),
                },
            ],
        );

        const result = await getArtworkWithInheritance(sql, episodeId);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({
            artworkType: 'backdrop',
            source: 'self',
            sourceId: episodeId,
            sourceName: 'S01E01',
            url: `/api/image/catalog/${episodeId}/backdrop`,
        });
    });

    it('returns inherited artwork from series when episode has no self-owned art', async () => {
        const episodeId = 'episode-uuid';
        const seriesId = 'series-uuid';
        const sql = makeSql(
            // CTE: episode (depth 0) → series (depth 1, no season in between)
            [
                {
                    id: episodeId,
                    title: 'S01E01',
                    media_type: 'episode',
                    depth: 0,
                },
                {
                    id: seriesId,
                    title: 'The Orbit Crew',
                    media_type: 'tv',
                    depth: 1,
                },
            ],
            // Artwork query: only series has a backdrop
            [
                {
                    id: 'art-series',
                    media_item_id: seriesId,
                    artwork_type: 'backdrop',
                    source: 'local',
                    file_path: '/images/series-backdrop.jpg',
                    remote_url: null,
                    language: null,
                    sort_order: 0,
                    created_at: new Date(),
                },
            ],
        );

        const result = await getArtworkWithInheritance(sql, episodeId);
        const backdrop = result.find((r) => r.artworkType === 'backdrop');
        expect(backdrop).toBeDefined();
        expect(backdrop).toMatchObject({
            source: 'series',
            sourceId: seriesId,
            sourceName: 'The Orbit Crew',
            // Inherited preview URL carries fallback=none so a missing inherited
            // image 404s (→ upload controls) instead of showing the popcorn.
            url: `/api/image/catalog/${seriesId}/backdrop?fallback=none`,
        });
    });

    it('season ancestor wins over series when both have the same slot', async () => {
        const episodeId = 'episode-uuid';
        const seasonId = 'season-uuid';
        const seriesId = 'series-uuid';
        const sql = makeSql(
            // CTE: episode → season → series
            [
                {
                    id: episodeId,
                    title: 'S02E03',
                    media_type: 'episode',
                    depth: 0,
                },
                {
                    id: seasonId,
                    title: 'Season 2',
                    media_type: 'season',
                    depth: 1,
                },
                { id: seriesId, title: 'Fenwick', media_type: 'tv', depth: 2 },
            ],
            // Artwork query: both season AND series have a backdrop
            [
                {
                    id: 'art-season',
                    media_item_id: seasonId,
                    artwork_type: 'backdrop',
                    source: 'local',
                    file_path: '/images/season-backdrop.jpg',
                    remote_url: null,
                    language: null,
                    sort_order: 0,
                    created_at: new Date(),
                },
                {
                    id: 'art-series',
                    media_item_id: seriesId,
                    artwork_type: 'backdrop',
                    source: 'local',
                    file_path: '/images/series-backdrop.jpg',
                    remote_url: null,
                    language: null,
                    sort_order: 0,
                    created_at: new Date(),
                },
            ],
        );

        const result = await getArtworkWithInheritance(sql, episodeId);
        const backdrop = result.find((r) => r.artworkType === 'backdrop');
        expect(backdrop).toBeDefined();
        // Season wins over series (nearest ancestor)
        expect(backdrop?.source).toBe('season');
        expect(backdrop?.sourceId).toBe(seasonId);
        expect(backdrop?.sourceName).toBe('Season 2');
    });

    it('omits slots where no artwork exists at any level', async () => {
        const episodeId = 'episode-uuid';
        const sql = makeSql(
            [
                {
                    id: episodeId,
                    title: 'S01E01',
                    media_type: 'episode',
                    depth: 0,
                },
            ],
            [], // no artwork anywhere
        );

        const result = await getArtworkWithInheritance(sql, episodeId);
        expect(result).toHaveLength(0);
    });

    it('season with no art walks up to series', async () => {
        const seasonId = 'season-uuid';
        const seriesId = 'series-uuid';
        const sql = makeSql(
            [
                {
                    id: seasonId,
                    title: 'Season 1',
                    media_type: 'season',
                    depth: 0,
                },
                {
                    id: seriesId,
                    title: 'Drifting Clouds',
                    media_type: 'tv',
                    depth: 1,
                },
            ],
            [
                {
                    id: 'art-series-poster',
                    media_item_id: seriesId,
                    artwork_type: 'poster',
                    source: 'local',
                    file_path: '/images/poster.jpg',
                    remote_url: null,
                    language: null,
                    sort_order: 0,
                    created_at: new Date(),
                },
            ],
        );

        const result = await getArtworkWithInheritance(sql, seasonId);
        const poster = result.find((r) => r.artworkType === 'poster');
        expect(poster).toBeDefined();
        expect(poster?.source).toBe('series');
        expect(poster?.sourceName).toBe('Drifting Clouds');
    });
});

describe('upsertLocalArtwork — nested transaction safety', () => {
    it('opens a savepoint (not sql.begin) when handed a TransactionSql — no "sql.begin is not a function"', async () => {
        // album-enrichment wraps its artwork + marker writes in withTx and passes
        // the inner functions a TransactionSql: callable as a tagged template, has
        // .savepoint, but NO .begin. The pre-fix raw `sql.begin(...)` threw
        // "sql.begin is not a function" here, failing every album every slice.
        // There is no pre-existing manual selection to preserve. Other queries
        // return a registered row so the nested transaction path completes.
        const tx = vi.fn(async (parts: TemplateStringsArray | string) => {
            const query = typeof parts === 'string' ? parts : parts.join('');
            return /SELECT id,\s*selected,\s*selection_order FROM image_candidates/.test(query)
                ? []
                : [{ id: 'art-1' }];
        }) as unknown as postgres.Sql;
        const savepoint = vi.fn(async (cb: (t: postgres.Sql) => Promise<unknown>) => cb(tx));
        (tx as unknown as { savepoint: unknown }).savepoint = savepoint;
        // deliberately NO .begin on the handle

        await expect(
            upsertLocalArtwork(tx, {
                mediaItemId: 'album-1',
                artworkType: 'poster',
                filePath: '/x/poster.jpg',
            }),
        ).resolves.toBe(true);
        expect(savepoint).toHaveBeenCalledTimes(1);
    });
});

it('clears stale source credit when an admin replaces bytes under the same poster proxy', async () => {
    const tx = vi
        .fn()
        .mockResolvedValue([{ suppressed: false, inserted: false }]) as unknown as postgres.Sql;
    const savepoint = vi.fn(async (cb: (t: postgres.Sql) => Promise<unknown>) => cb(tx));
    (tx as unknown as { savepoint: unknown }).savepoint = savepoint;
    await upsertLocalArtwork(tx, {
        mediaItemId: 'album',
        artworkType: 'poster',
        filePath: '/x/poster.jpg',
        sourceTag: 'admin:file',
    });
    expect(clearMusicArtworkProvenance).toHaveBeenCalledWith(tx, 'album', 'poster');
});
