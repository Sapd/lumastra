// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Integration Tests for Media Items Query Module
 *
 * Focused on `findOrCreateSeries` cross-provider primary identity guard
 * (W2.1 — see motivation in the doc-comment of `findOrCreateSeries`).
 *
 * Scenarios covered:
 *   - Cross-provider primary conflict (Office AU TMDB vs Glimmers UK jellyseerr)
 *   - Same-provider matching primary returns the existing row
 *   - No external_id provided + matching title returns existing row
 *   - Personal stub (no external_ids) + incoming TMDB returns the stub
 *   - Concurrent calls with the same title+TMDB resolve to the same UUID
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    findOrCreateSeries,
    findEpisodeByPosition,
    findSeasonByNumber,
    findAdoptableDiscoveryRowByTitle,
    backfillLocalMediaContent,
    applyLocalNfoDisplayMetadata,
    findLocalContentGapMovieByFile,
    insertExtraMediaItem,
    clearProviderCdnCustomImageUrl,
    clearArtworkBlurhash,
    countPersonalMediaItems,
    listPersonalMediaItems,
    seasonHasCanonicalEpisodes,
} from './media-items.queries.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';
import { findMovieFilesWithContentGapByPrefix } from './media-files.queries.js';
import {
    keepPersonalMediaItem,
    restoreKeptPersonalMediaItem,
    isPersonalMediaKept,
} from './unmatched-files.queries.js';
import {
    createTestRating,
    insertTestRating,
} from '../../../../../tests/integration/fixtures/index.js';
import { CatalogService } from '../../services/catalog.service.js';

async function insertSeries(
    sql: postgres.Sql,
    opts: {
        title: string;
        year?: number | null;
        externalIds?: Array<{
            provider: string;
            externalId: string;
            mediaType: string;
            isPrimary?: boolean;
        }>;
    },
): Promise<string> {
    const [row] = await sql<[{ id: string }]>`
        INSERT INTO media_items (title, media_type, year)
        VALUES (${opts.title}, 'tv', ${opts.year ?? null}::int)
        RETURNING id
    `;
    for (const ei of opts.externalIds ?? []) {
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (
                ${row.id}::uuid,
                ${ei.provider},
                ${ei.externalId},
                ${ei.mediaType},
                ${ei.isPrimary ?? false}
            )
        `;
    }
    return row.id;
}

describe('findOrCreateSeries — cross-provider primary identity guard', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    it('excludes a row whose primary external_id is from a DIFFERENT provider (Office AU vs Glimmers UK case)', async () => {
        // Existing row: same English title, but its primary id is jellyseerr=2996
        // (the UK series). We're trying to bind tmdb=256480 (the AU series, 2024).
        // The matcher must NOT reuse the existing row.
        const existingUkId = await insertSeries(sql, {
            title: 'The Outpost',
            year: 2019,
            externalIds: [
                {
                    provider: 'jellyseerr',
                    externalId: '2996',
                    mediaType: 'tv',
                    isPrimary: true,
                },
            ],
        });

        const resolvedId = await findOrCreateSeries(sql, {
            title: 'The Outpost',
            year: 2024,
            externalId: {
                provider: 'tmdb',
                id: '256480',
                mediaType: 'tv',
            },
        });

        expect(resolvedId).not.toBe(existingUkId);

        // The new row should have no external_ids yet (caller attaches them).
        const externalsForNew = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count FROM external_ids WHERE media_id = ${resolvedId}::uuid
        `;
        expect(parseInt(externalsForNew[0].count, 10)).toBe(0);
    });

    it('reuses a row whose primary external_id matches the incoming (provider, id, media_type)', async () => {
        const existingId = await insertSeries(sql, {
            title: 'The Outpost',
            year: 2024,
            externalIds: [
                {
                    provider: 'tmdb',
                    externalId: '256480',
                    mediaType: 'tv',
                    isPrimary: true,
                },
            ],
        });

        // First call hits the resolveExternalIdToUuid fast-path (step 1) which
        // is the canonical reuse path. We verify the same UUID comes back.
        const resolvedId = await findOrCreateSeries(sql, {
            title: 'The Outpost',
            year: 2024,
            externalId: {
                provider: 'tmdb',
                id: '256480',
                mediaType: 'tv',
            },
        });

        expect(resolvedId).toBe(existingId);
    });

    it('falls back to title match when no externalId is provided (legacy path unchanged)', async () => {
        const existingId = await insertSeries(sql, {
            title: 'Some Personal Show',
            year: 2020,
            externalIds: [],
        });

        const resolvedId = await findOrCreateSeries(sql, {
            title: 'Some Personal Show',
            year: 2020,
        });

        expect(resolvedId).toBe(existingId);
    });

    it('matches a personal stub (no external_ids) when an incoming TMDB id is supplied', async () => {
        const stubId = await insertSeries(sql, {
            title: 'The Outpost',
            year: 2024,
            externalIds: [],
        });

        const resolvedId = await findOrCreateSeries(sql, {
            title: 'The Outpost',
            year: 2024,
            externalId: {
                provider: 'tmdb',
                id: '256480',
                mediaType: 'tv',
            },
        });

        // Stub had no external_ids and no primary id, so the new guard does NOT
        // exclude it. The matcher returns the stub for the caller to enrich.
        expect(resolvedId).toBe(stubId);
    });

    it('excludes a row whose ONLY external_id is non-primary but cross-provider conflicting (broadened guard)', async () => {
        // Backfill scenario: row has a non-primary tmdb=2316 from a previous
        // half-finished migration, with no primary external_id at all. An
        // incoming jellyfin=abc-def for a *different* show used to match this
        // row by title because the original guard only excluded `is_primary
        // = TRUE` conflicts. The broadened guard must drop this row.
        const existingId = await insertSeries(sql, {
            title: 'The Outpost',
            year: 2005,
            externalIds: [
                {
                    provider: 'tmdb',
                    externalId: '2316',
                    mediaType: 'tv',
                    isPrimary: false,
                },
            ],
        });

        const resolvedId = await findOrCreateSeries(sql, {
            title: 'The Outpost',
            year: 2005,
            externalId: {
                provider: 'jellyfin',
                id: 'abc-def-1234-5678-9abcdef01234',
                mediaType: 'tv',
            },
        });

        expect(resolvedId).not.toBe(existingId);
    });

    it('normalizes a dashed Jellyfin id to match an existing dashless primary external_id', async () => {
        // Stored form is dashless lowercase (catalog.service.ts normalizes on
        // write). Step 1 (resolveExternalIdToUuid) must see the normalized id
        // so the dashed input still hits the existing row.
        const existingId = await insertSeries(sql, {
            title: 'X',
            year: 2010,
            externalIds: [
                {
                    provider: 'jellyfin',
                    externalId: 'a1b2c3d4abcdef',
                    mediaType: 'tv',
                    isPrimary: true,
                },
            ],
        });

        const resolvedId = await findOrCreateSeries(sql, {
            title: 'X',
            year: 2010,
            externalId: {
                provider: 'jellyfin',
                id: 'a1b2-c3d4-abcdef',
                mediaType: 'tv',
            },
        });

        expect(resolvedId).toBe(existingId);
    });

    it('does not match a year-bearing row when caller has externalId but no year (year-NULL bypass closure)', async () => {
        // Row has year=2005 (concrete). Caller has external_id but no year.
        // Old predicate `mi.year = NULL OR mi.year IS NULL OR NULL IS NULL`
        // would match because the third disjunct collapses to TRUE. New
        // predicate (when externalId is present) is `mi.year = NULL OR mi.year
        // IS NULL`, which evaluates to UNKNOWN OR FALSE — no match.
        const existingId = await insertSeries(sql, {
            title: 'Show',
            year: 2005,
            externalIds: [],
        });

        const resolvedId = await findOrCreateSeries(sql, {
            title: 'Show',
            // year deliberately undefined so yearVal === null
            externalId: {
                provider: 'tmdb',
                id: '9999',
                mediaType: 'tv',
            },
        });

        expect(resolvedId).not.toBe(existingId);
    });

    it('serializes concurrent find-or-create with same title+TMDB to a single UUID (advisory lock)', async () => {
        const params = {
            title: 'Brand New Concurrent Show',
            year: 2025,
            externalId: {
                provider: 'tmdb',
                id: '999000',
                mediaType: 'tv',
            },
        } as const;

        const [a, b] = await Promise.all([
            findOrCreateSeries(sql, params),
            findOrCreateSeries(sql, params),
        ]);

        expect(a).toBe(b);

        const rows = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count
            FROM media_items
            WHERE media_type = 'tv'
              AND title = ${params.title}
        `;
        expect(parseInt(rows[0].count, 10)).toBe(1);
    });

    it('keeps two untagged non-Latin series apart and still reuses each one', async () => {
        // Both titles normalize to "" under the Latin-only title fold, which made
        // every non-Latin series title-match the first one created.
        const attackOnTitan = await findOrCreateSeries(sql, { title: '進撃の巨人' });
        const demonSlayer = await findOrCreateSeries(sql, { title: '鬼滅の刃' });
        expect(demonSlayer).not.toBe(attackOnTitan);
        expect(await findOrCreateSeries(sql, { title: '進撃の巨人' })).toBe(attackOnTitan);
        expect(await findOrCreateSeries(sql, { title: '鬼滅の刃' })).toBe(demonSlayer);
    });

    it('keeps "Show (2001)" and "Show (2026)" apart once each has its folder year', async () => {
        const original = await findOrCreateSeries(sql, { title: 'Folder Year Show', year: 2001 });
        const revival = await findOrCreateSeries(sql, { title: 'Folder Year Show', year: 2026 });
        expect(revival).not.toBe(original);
        expect(await findOrCreateSeries(sql, { title: 'Folder Year Show', year: 2001 })).toBe(
            original,
        );
    });
});

// ============================================================================
// findOrCreateSeries — library_group_id backfill on adoption
//
// Discovery-stub series rows (TMDB trending/mdblist sync, etc.) never carry a
// library_group_id since they aren't tied to a library scan. When the file
// scanner later adopts such a row via external-id match (step 1) or title
// match (step 2), it must backfill library_group_id from the scan's current
// library group rather than leaving it NULL forever.
// ============================================================================

describe('findOrCreateSeries — library_group_id backfill on adoption', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function insertLibraryGroup(name: string): Promise<string> {
        const id = crypto.randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${id}::uuid, ${name})`;
        return id;
    }

    it('backfills library_group_id on a discovery stub matched by external ID (step 1)', async () => {
        const stubId = await insertSeries(sql, {
            title: 'The Outpost',
            year: 2024,
            externalIds: [
                { provider: 'tmdb', externalId: '256480', mediaType: 'tv', isPrimary: true },
            ],
        });

        const groupId = await insertLibraryGroup('Backfill Group Step1');

        const resolvedId = await findOrCreateSeries(sql, {
            title: 'The Outpost',
            year: 2024,
            libraryGroupId: groupId,
            externalId: { provider: 'tmdb', id: '256480', mediaType: 'tv' },
        });

        expect(resolvedId).toBe(stubId);
        const [row] = await sql<{ library_group_id: string | null }[]>`
            SELECT library_group_id FROM media_items WHERE id = ${resolvedId}::uuid
        `;
        expect(row.library_group_id).toBe(groupId);
    });

    it('backfills library_group_id on a discovery stub matched by title (step 2)', async () => {
        const stubId = await insertSeries(sql, {
            title: 'Some Personal Show',
            year: 2020,
            externalIds: [],
        });

        const groupId = await insertLibraryGroup('Backfill Group Step2');

        const resolvedId = await findOrCreateSeries(sql, {
            title: 'Some Personal Show',
            year: 2020,
            libraryGroupId: groupId,
        });

        expect(resolvedId).toBe(stubId);
        const [row] = await sql<{ library_group_id: string | null }[]>`
            SELECT library_group_id FROM media_items WHERE id = ${resolvedId}::uuid
        `;
        expect(row.library_group_id).toBe(groupId);
    });

    it('does not overwrite an existing library_group_id (idempotent)', async () => {
        const originalGroupId = await insertLibraryGroup('Original Group');
        const stubId = await insertSeries(sql, {
            title: 'Already Grouped Show',
            year: 2021,
            externalIds: [],
        });
        await sql`
            UPDATE media_items SET library_group_id = ${originalGroupId}::uuid
            WHERE id = ${stubId}::uuid
        `;

        const otherGroupId = await insertLibraryGroup('Other Group');

        const resolvedId = await findOrCreateSeries(sql, {
            title: 'Already Grouped Show',
            year: 2021,
            libraryGroupId: otherGroupId,
        });

        expect(resolvedId).toBe(stubId);
        const [row] = await sql<{ library_group_id: string | null }[]>`
            SELECT library_group_id FROM media_items WHERE id = ${resolvedId}::uuid
        `;
        expect(row.library_group_id).toBe(originalGroupId);
    });

    it('leaves library_group_id NULL when the caller has none to backfill', async () => {
        const stubId = await insertSeries(sql, {
            title: 'No Group Show',
            year: 2022,
            externalIds: [],
        });

        const resolvedId = await findOrCreateSeries(sql, {
            title: 'No Group Show',
            year: 2022,
        });

        expect(resolvedId).toBe(stubId);
        const [row] = await sql<{ library_group_id: string | null }[]>`
            SELECT library_group_id FROM media_items WHERE id = ${resolvedId}::uuid
        `;
        expect(row.library_group_id).toBeNull();
    });
});

// ============================================================================
// findSeasonByNumber + findEpisodeByPosition (W2.2 Jellyfin attach-only path)
// ============================================================================

describe('findSeasonByNumber / findEpisodeByPosition — Jellyfin attach lookup', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function buildSeriesWith(
        seriesId: string,
        seasonsAndEpisodes: Array<{
            seasonNumber: number;
            episodes: Array<{ episodeNumber: number }>;
        }>,
    ): Promise<{
        seriesId: string;
        seasonIds: Map<number, string>;
        episodeIds: Map<string, string>;
    }> {
        await sql`
            INSERT INTO media_items (id, title, media_type)
            VALUES (${seriesId}::uuid, ${'Series'}, 'tv')
        `;
        const seasonIds = new Map<number, string>();
        const episodeIds = new Map<string, string>();
        for (const s of seasonsAndEpisodes) {
            const [seasonRow] = await sql<[{ id: string }]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number)
                VALUES (${`Season ${s.seasonNumber}`}, 'season', ${seriesId}::uuid, ${s.seasonNumber})
                RETURNING id
            `;
            seasonIds.set(s.seasonNumber, seasonRow.id);
            for (const e of s.episodes) {
                const [epRow] = await sql<[{ id: string }]>`
                    INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
                    VALUES (${`E${e.episodeNumber}`}, 'episode', ${seasonRow.id}::uuid, ${s.seasonNumber}, ${e.episodeNumber})
                    RETURNING id
                `;
                episodeIds.set(`${s.seasonNumber}:${e.episodeNumber}`, epRow.id);
            }
        }
        return { seriesId, seasonIds, episodeIds };
    }

    it('finds an existing season under a series by season number', async () => {
        const seriesId = '00000000-0000-0000-0000-000000000a01';
        const { seasonIds } = await buildSeriesWith(seriesId, [
            { seasonNumber: 1, episodes: [] },
            { seasonNumber: 2, episodes: [] },
        ]);

        const s1 = await findSeasonByNumber(sql, seriesId, 1);
        const s2 = await findSeasonByNumber(sql, seriesId, 2);
        expect(s1).toBe(seasonIds.get(1));
        expect(s2).toBe(seasonIds.get(2));
    });

    it('returns null when the season does not exist (e.g. S0 specials missing)', async () => {
        const seriesId = '00000000-0000-0000-0000-000000000a02';
        await buildSeriesWith(seriesId, [{ seasonNumber: 1, episodes: [] }]);

        const s0 = await findSeasonByNumber(sql, seriesId, 0);
        expect(s0).toBeNull();
    });

    it('does not match seasons under a different series', async () => {
        const seriesIdA = '00000000-0000-0000-0000-000000000a03';
        const seriesIdB = '00000000-0000-0000-0000-000000000a04';
        await buildSeriesWith(seriesIdA, [{ seasonNumber: 1, episodes: [] }]);
        await buildSeriesWith(seriesIdB, [{ seasonNumber: 1, episodes: [] }]);

        const s1OfA = await findSeasonByNumber(sql, seriesIdA, 1);
        const s1OfB = await findSeasonByNumber(sql, seriesIdB, 1);
        expect(s1OfA).not.toBeNull();
        expect(s1OfB).not.toBeNull();
        expect(s1OfA).not.toBe(s1OfB);
    });

    it('finds an existing episode by (series, season, episode)', async () => {
        const seriesId = '00000000-0000-0000-0000-000000000b01';
        const { episodeIds } = await buildSeriesWith(seriesId, [
            {
                seasonNumber: 1,
                episodes: [{ episodeNumber: 1 }, { episodeNumber: 2 }],
            },
            { seasonNumber: 2, episodes: [{ episodeNumber: 1 }] },
        ]);

        const s1e1 = await findEpisodeByPosition(sql, seriesId, 1, 1);
        const s1e2 = await findEpisodeByPosition(sql, seriesId, 1, 2);
        const s2e1 = await findEpisodeByPosition(sql, seriesId, 2, 1);
        expect(s1e1).toBe(episodeIds.get('1:1'));
        expect(s1e2).toBe(episodeIds.get('1:2'));
        expect(s2e1).toBe(episodeIds.get('2:1'));
    });

    it('returns null when episode position has no row (the contamination shape — foreign episode)', async () => {
        const seriesId = '00000000-0000-0000-0000-000000000b02';
        await buildSeriesWith(seriesId, [{ seasonNumber: 1, episodes: [{ episodeNumber: 1 }] }]);

        // S1E2 doesn't exist → null. This is exactly the case the Jellyfin
        // attach-only sync uses to decide between attach and quarantine.
        const s1e2 = await findEpisodeByPosition(sql, seriesId, 1, 2);
        expect(s1e2).toBeNull();
    });

    it('does not match an episode under a different series with the same (S, E) coordinates', async () => {
        const seriesIdA = '00000000-0000-0000-0000-000000000b03';
        const seriesIdB = '00000000-0000-0000-0000-000000000b04';
        const a = await buildSeriesWith(seriesIdA, [
            { seasonNumber: 1, episodes: [{ episodeNumber: 1 }] },
        ]);
        const b = await buildSeriesWith(seriesIdB, [
            { seasonNumber: 1, episodes: [{ episodeNumber: 1 }] },
        ]);

        const epOfA = await findEpisodeByPosition(sql, seriesIdA, 1, 1);
        const epOfB = await findEpisodeByPosition(sql, seriesIdB, 1, 1);
        expect(epOfA).toBe(a.episodeIds.get('1:1'));
        expect(epOfB).toBe(b.episodeIds.get('1:1'));
        expect(epOfA).not.toBe(epOfB);
    });
});

describe('findAdoptableDiscoveryRowByTitle — scanner duplicate prevention', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function insertMovie(opts: {
        title: string;
        year: number | null;
        hasFiles: boolean;
        tmdbId?: string;
        jellyfinId?: string;
        status?: string;
        dismissed?: boolean;
    }): Promise<string> {
        const [row] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, year, has_files, status, is_dismissed)
            VALUES (
                ${opts.title}, 'movie', ${opts.year}::int, ${opts.hasFiles},
                ${opts.status ?? 'active'}, ${opts.dismissed ?? false}
            )
            RETURNING id
        `;
        if (opts.tmdbId) {
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${row.id}::uuid, 'tmdb', ${opts.tmdbId}, 'movie', true)
            `;
        }
        if (opts.jellyfinId) {
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${row.id}::uuid, 'jellyfin', ${opts.jellyfinId}, 'movie', false)
            `;
        }
        return row.id;
    }

    it('adopts the file-less discovery row on exact title + year match', async () => {
        const discoveryId = await insertMovie({
            title: 'Obersalzberg - der Film',
            year: 2010,
            hasFiles: false,
            tmdbId: '121034',
        });

        const found = await findAdoptableDiscoveryRowByTitle(sql, {
            // punctuation differs — normalization must still match
            title: 'Obersalzberg der Film',
            year: 2010,
            mediaType: 'movie',
        });

        expect(found).toBe(discoveryId);
    });

    it('does NOT adopt when the candidate row already has files', async () => {
        await insertMovie({
            title: 'Already Here',
            year: 2010,
            hasFiles: true,
            tmdbId: '999',
        });

        const found = await findAdoptableDiscoveryRowByTitle(sql, {
            title: 'Already Here',
            year: 2010,
            mediaType: 'movie',
        });

        expect(found).toBeNull();
    });

    it('does NOT adopt a file-less row that has no external id (not a discovery row)', async () => {
        await insertMovie({ title: 'No Ids', year: 2010, hasFiles: false });

        const found = await findAdoptableDiscoveryRowByTitle(sql, {
            title: 'No Ids',
            year: 2010,
            mediaType: 'movie',
        });

        expect(found).toBeNull();
    });

    it('does NOT adopt on a different year (avoids remake collisions)', async () => {
        await insertMovie({ title: 'Dawn', year: 1984, hasFiles: false, tmdbId: '841' });

        const found = await findAdoptableDiscoveryRowByTitle(sql, {
            title: 'Dawn',
            year: 2021,
            mediaType: 'movie',
        });

        expect(found).toBeNull();
    });

    it('returns null when more than one candidate matches (ambiguous → caller creates fresh)', async () => {
        await insertMovie({ title: 'Twin', year: 2010, hasFiles: false, tmdbId: '111' });
        await insertMovie({ title: 'Twin', year: 2010, hasFiles: false, tmdbId: '222' });

        const found = await findAdoptableDiscoveryRowByTitle(sql, {
            title: 'Twin',
            year: 2010,
            mediaType: 'movie',
        });

        expect(found).toBeNull();
    });

    // The provider-less local-movie path (a movie not in TMDB) passes 'jellyfin'
    // so a Jellyfin metadata-only import gets adopted instead of leaving a
    // file-less duplicate. The default (discovery-only) list must NOT.
    it('does NOT adopt a jellyfin-only row under the default provider list', async () => {
        await insertMovie({ title: 'Fan Edit', year: 2008, hasFiles: false, jellyfinId: 'jf-1' });

        const found = await findAdoptableDiscoveryRowByTitle(sql, {
            title: 'Fan Edit',
            year: 2008,
            mediaType: 'movie',
        });

        expect(found).toBeNull();
    });

    it('adopts a jellyfin-only file-less row when jellyfin is in the provider list', async () => {
        const id = await insertMovie({
            title: 'Fan Edit',
            year: 2008,
            hasFiles: false,
            jellyfinId: 'jf-1',
        });

        const found = await findAdoptableDiscoveryRowByTitle(sql, {
            title: 'Fan Edit',
            year: 2008,
            mediaType: 'movie',
            providers: ['tmdb', 'imdb', 'tvdb', 'jellyfin'],
        });

        expect(found).toBe(id);
    });
});

describe('backfillLocalMediaContent — NFO re-scan heal', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function insertMovie(opts: {
        title: string;
        overview?: string | null;
        year?: number | null;
        metadataLocked?: boolean;
    }): Promise<string> {
        const [row] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, overview, year, metadata_locked, status)
            VALUES (
                ${opts.title}, 'movie', ${opts.overview ?? null}, ${opts.year ?? null}::int,
                ${opts.metadataLocked ?? false}, 'active'
            )
            RETURNING id
        `;
        return row.id;
    }

    async function read(id: string): Promise<{ overview: string | null; year: number | null }> {
        const [r] = await sql<{ overview: string | null; year: number | null }[]>`
            SELECT overview, year FROM media_items WHERE id = ${id}
        `;
        return r;
    }

    async function readAggregated(
        id: string,
    ): Promise<{ overview: string | null; release_date: string | null } | null> {
        const [r] = await sql<{ overview: string | null; release_date: string | null }[]>`
            SELECT metadata->>'overview' AS overview, metadata->>'release_date' AS release_date
            FROM provider_metadata WHERE media_id = ${id} AND provider = 'aggregated'
        `;
        return r ?? null;
    }

    it('fills overview and year when both are NULL', async () => {
        const id = await insertMovie({ title: 'Local', overview: null, year: null });
        const changed = await backfillLocalMediaContent(sql, id, {
            overview: 'A description.',
            year: 2008,
        });
        expect(changed).toBe(true);
        expect(await read(id)).toEqual({ overview: 'A description.', year: 2008 });
    });

    it('also surfaces overview/year on the display path (provider_metadata aggregated)', async () => {
        const id = await insertMovie({ title: 'Local', overview: null, year: null });
        await backfillLocalMediaContent(sql, id, { overview: 'A description.', year: 2008 });
        expect(await readAggregated(id)).toEqual({
            overview: 'A description.',
            release_date: '2008-01-01',
        });
    });

    it('fills a whitespace-only overview', async () => {
        const id = await insertMovie({ title: 'Local', overview: '   ' });
        const changed = await backfillLocalMediaContent(sql, id, { overview: 'Real plot.' });
        expect(changed).toBe(true);
        expect((await read(id)).overview).toBe('Real plot.');
    });

    it('never clobbers an existing overview or year', async () => {
        const id = await insertMovie({
            title: 'Matched',
            overview: 'From metadata sync.',
            year: 1999,
        });
        const changed = await backfillLocalMediaContent(sql, id, {
            overview: 'NFO plot.',
            year: 2000,
        });
        expect(changed).toBe(false);
        expect(await read(id)).toEqual({ overview: 'From metadata sync.', year: 1999 });
    });

    it('skips a metadata_locked item', async () => {
        const id = await insertMovie({ title: 'Locked', overview: null, metadataLocked: true });
        const changed = await backfillLocalMediaContent(sql, id, { overview: 'NFO plot.' });
        expect(changed).toBe(false);
        expect((await read(id)).overview).toBeNull();
    });

    it('fills only the year when overview is already present', async () => {
        const id = await insertMovie({ title: 'Half', overview: 'Has plot.', year: null });
        const changed = await backfillLocalMediaContent(sql, id, {
            overview: 'NFO plot.',
            year: 2008,
        });
        expect(changed).toBe(true);
        expect(await read(id)).toEqual({ overview: 'Has plot.', year: 2008 });
    });
});

describe('applyLocalNfoDisplayMetadata — provider_metadata display surface', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function insertMovie(opts: { metadataLocked?: boolean } = {}): Promise<string> {
        const [r] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, has_files, status, metadata_locked)
            VALUES ('Film', 'movie', true, 'active', ${opts.metadataLocked ?? false}) RETURNING id
        `;
        return r.id;
    }

    async function aggregated(id: string): Promise<Record<string, string> | null> {
        const [r] = await sql<{ overview: string | null; release_date: string | null }[]>`
            SELECT metadata->>'overview' AS overview, metadata->>'release_date' AS release_date
            FROM provider_metadata WHERE media_id = ${id} AND provider = 'aggregated'
        `;
        return r ? { overview: r.overview ?? '', release_date: r.release_date ?? '' } : null;
    }

    it('creates an aggregated row with overview and release_date', async () => {
        const id = await insertMovie();
        await applyLocalNfoDisplayMetadata(sql, id, { overview: 'Plot.', year: 2008 });
        expect(await aggregated(id)).toEqual({ overview: 'Plot.', release_date: '2008-01-01' });
    });

    it('does not clobber an existing aggregated overview (matched movie wins)', async () => {
        const id = await insertMovie();
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${id}, 'aggregated', ${sql.json({ overview: 'Real TMDB overview.' })})
        `;
        await applyLocalNfoDisplayMetadata(sql, id, { overview: 'NFO plot.', year: 2008 });
        const agg = await aggregated(id);
        expect(agg?.overview).toBe('Real TMDB overview.');
        // release_date was absent, so it still gets filled.
        expect(agg?.release_date).toBe('2008-01-01');
    });

    it('preserves other metadata keys on the existing row', async () => {
        const id = await insertMovie();
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${id}, 'aggregated', ${sql.json({ poster_path: '/p.jpg' })})
        `;
        await applyLocalNfoDisplayMetadata(sql, id, { overview: 'Plot.' });
        const [row] = await sql<{ poster_path: string; overview: string }[]>`
            SELECT metadata->>'poster_path' AS poster_path, metadata->>'overview' AS overview
            FROM provider_metadata WHERE media_id = ${id} AND provider = 'aggregated'
        `;
        expect(row.poster_path).toBe('/p.jpg');
        expect(row.overview).toBe('Plot.');
    });

    it('writes nothing for a metadata_locked item (self-guarding, no TOCTOU)', async () => {
        const id = await insertMovie({ metadataLocked: true });
        await applyLocalNfoDisplayMetadata(sql, id, { overview: 'Plot.', year: 2008 });
        expect(await aggregated(id)).toBeNull();
    });

    it('does not create an empty aggregated row for year 0 with no overview', async () => {
        const id = await insertMovie();
        await applyLocalNfoDisplayMetadata(sql, id, { year: 0 });
        expect(await aggregated(id)).toBeNull();
    });

    it('does not create a row for a blank overview with no year', async () => {
        const id = await insertMovie();
        await applyLocalNfoDisplayMetadata(sql, id, { overview: '   ' });
        expect(await aggregated(id)).toBeNull();
    });
});

describe('findLocalContentGapMovieByFile — unchanged-file heal gate', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    // The gap is display-centric: an item lacks a description in the modal when
    // its 'aggregated' provider_metadata row has no non-blank overview. Set
    // aggregatedOverview to represent a display-complete item.
    async function insertMovieWithFile(opts: {
        metadataLocked?: boolean;
        mediaType?: string;
        tmdbId?: string;
        aggregatedOverview?: string;
        filePath?: string;
        dismissed?: boolean;
        status?: string;
    }): Promise<{ movieId: string; fileId: string }> {
        const [mi] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, metadata_locked, has_files, status, is_dismissed)
            VALUES ('Film', ${opts.mediaType ?? 'movie'}, ${opts.metadataLocked ?? false}, true,
                    ${opts.status ?? 'active'}, ${opts.dismissed ?? false})
            RETURNING id
        `;
        const [mf] = await sql<[{ id: string }]>`
            INSERT INTO media_files (file_path) VALUES (${opts.filePath ?? `/data/movies/Film/${mi.id}.mkv`})
            RETURNING id
        `;
        await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${mf.id}::uuid, ${mi.id}::uuid)`;
        if (opts.tmdbId) {
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${mi.id}::uuid, 'tmdb', ${opts.tmdbId}, 'movie', true)
            `;
        }
        if (opts.aggregatedOverview !== undefined) {
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mi.id}::uuid, 'aggregated', ${sql.json({ overview: opts.aggregatedOverview })})
            `;
        }
        return { movieId: mi.id, fileId: mf.id };
    }

    it('returns the movie id when there is no aggregated overview', async () => {
        const { movieId, fileId } = await insertMovieWithFile({});
        expect(await findLocalContentGapMovieByFile(sql, fileId)).toBe(movieId);
    });

    it('returns the movie id when the aggregated overview is blank', async () => {
        const { movieId, fileId } = await insertMovieWithFile({ aggregatedOverview: '   ' });
        expect(await findLocalContentGapMovieByFile(sql, fileId)).toBe(movieId);
    });

    it('returns null when the display overview is present (no NFO read needed)', async () => {
        const { fileId } = await insertMovieWithFile({ aggregatedOverview: 'Shown in modal.' });
        expect(await findLocalContentGapMovieByFile(sql, fileId)).toBeNull();
    });

    it('returns null for a metadata_locked item', async () => {
        const { fileId } = await insertMovieWithFile({ metadataLocked: true });
        expect(await findLocalContentGapMovieByFile(sql, fileId)).toBeNull();
    });

    it('ignores non-movie items', async () => {
        const { fileId } = await insertMovieWithFile({ mediaType: 'episode' });
        expect(await findLocalContentGapMovieByFile(sql, fileId)).toBeNull();
    });

    it('ignores a movie that has a tmdb id (overview comes from metadata-sync)', async () => {
        const { fileId } = await insertMovieWithFile({ tmdbId: '550' });
        expect(await findLocalContentGapMovieByFile(sql, fileId)).toBeNull();
    });

    it('ignores a dismissed item (never re-promote a removed movie)', async () => {
        const { fileId } = await insertMovieWithFile({ dismissed: true });
        expect(await findLocalContentGapMovieByFile(sql, fileId)).toBeNull();
    });

    it('ignores an inactive item', async () => {
        const { fileId } = await insertMovieWithFile({ status: 'deleted' });
        expect(await findLocalContentGapMovieByFile(sql, fileId)).toBeNull();
    });

    describe('findMovieFilesWithContentGapByPrefix', () => {
        it('returns provider-less display-gap movie files under the prefix, excluding matched/complete ones', async () => {
            await insertMovieWithFile({ filePath: '/data/movies/Gap/gap.mkv' });
            // Display-complete (has aggregated overview) → excluded.
            await insertMovieWithFile({
                aggregatedOverview: 'Shown.',
                filePath: '/data/movies/Complete/complete.mkv',
            });
            // Gap but tmdb-matched → excluded.
            await insertMovieWithFile({
                tmdbId: '550',
                filePath: '/data/movies/Matched/matched.mkv',
            });
            // Gap but under a different library path → excluded by prefix.
            await insertMovieWithFile({ filePath: '/data/series/Other/other.mkv' });
            // Gap but dismissed → excluded (never re-promote a removed movie).
            await insertMovieWithFile({
                dismissed: true,
                filePath: '/data/movies/Dismissed/d.mkv',
            });

            const files = await findMovieFilesWithContentGapByPrefix(sql, '/data/movies');
            expect(files).toEqual(['/data/movies/Gap/gap.mkv']);
        });
    });
});

describe('insertExtraMediaItem — file-less extra reuse', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function insertMovie(title: string): Promise<string> {
        const [row] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, has_files, status)
            VALUES (${title}, 'movie', true, 'active')
            RETURNING id
        `;
        return row.id;
    }

    async function insertExtra(opts: {
        title: string;
        parentId: string;
        extraType: string;
        hasFiles: boolean;
    }): Promise<string> {
        const [row] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, extra_type, parent_id, has_files, status)
            VALUES (${opts.title}, 'extra', ${opts.extraType}, ${opts.parentId}::uuid, ${opts.hasFiles}, 'active')
            RETURNING id
        `;
        return row.id;
    }

    async function extraCount(parentId: string): Promise<number> {
        const [{ count }] = await sql<{ count: string }[]>`
            SELECT count(*)::text AS count FROM media_items
            WHERE media_type = 'extra' AND parent_id = ${parentId}
        `;
        return Number(count);
    }

    it('reuses an existing file-less extra instead of minting a duplicate', async () => {
        const parentId = await insertMovie('Parent Movie');
        const phantom = await insertExtra({
            title: 'Trailer HD',
            parentId,
            extraType: 'trailer',
            hasFiles: false,
        });

        const reused = await insertExtraMediaItem(sql, {
            parentId,
            title: 'Trailer HD',
            extraType: 'trailer',
        });

        expect(reused).toBe(phantom);
        expect(await extraCount(parentId)).toBe(1);
    });

    it('does not reuse an extra that already has files', async () => {
        const parentId = await insertMovie('Parent Movie');
        const linked = await insertExtra({
            title: 'Trailer HD',
            parentId,
            extraType: 'trailer',
            hasFiles: true,
        });

        const created = await insertExtraMediaItem(sql, {
            parentId,
            title: 'Trailer HD',
            extraType: 'trailer',
        });

        expect(created).not.toBe(linked);
        expect(await extraCount(parentId)).toBe(2);
    });

    it('does not reuse across a different parent or extra_type', async () => {
        const parentA = await insertMovie('Movie A');
        const parentB = await insertMovie('Movie B');
        // Same title but wrong type (under A) and wrong parent (under B).
        await insertExtra({
            title: 'Trailer HD',
            parentId: parentA,
            extraType: 'behind_the_scenes',
            hasFiles: false,
        });
        await insertExtra({
            title: 'Trailer HD',
            parentId: parentB,
            extraType: 'trailer',
            hasFiles: false,
        });

        const created = await insertExtraMediaItem(sql, {
            parentId: parentA,
            title: 'Trailer HD',
            extraType: 'trailer',
        });

        const rows = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE media_type = 'extra' AND parent_id = ${parentA} AND extra_type = 'trailer'
        `;
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(created);
    });
});

describe('clearProviderCdnCustomImageUrl', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media]);
    });

    it('clears a TMDB CDN URL', async () => {
        const item = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, item);
        await sql`
            UPDATE media_items
            SET custom_poster_url = 'https://image.tmdb.org/t/p/w342/abc.jpg'
            WHERE id = ${item.id}::uuid
        `;

        await clearProviderCdnCustomImageUrl(sql, item.id, 'custom_poster_url');

        const [row] =
            await sql`SELECT custom_poster_url FROM media_items WHERE id = ${item.id}::uuid`;
        expect(row.custom_poster_url).toBeNull();
    });

    it('preserves an admin override', async () => {
        const item = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, item);
        await sql`
            UPDATE media_items
            SET custom_poster_url = 'https://my-cdn.example.com/my-poster.jpg'
            WHERE id = ${item.id}::uuid
        `;

        await clearProviderCdnCustomImageUrl(sql, item.id, 'custom_poster_url');

        const [row] =
            await sql`SELECT custom_poster_url FROM media_items WHERE id = ${item.id}::uuid`;
        expect(row.custom_poster_url).toBe('https://my-cdn.example.com/my-poster.jpg');
    });

    it('preserves our own proxy URL', async () => {
        const item = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, item);
        await sql`
            UPDATE media_items
            SET custom_poster_url = ${`/api/image/custom/${item.id}/poster`}
            WHERE id = ${item.id}::uuid
        `;

        await clearProviderCdnCustomImageUrl(sql, item.id, 'custom_poster_url');

        const [row] =
            await sql`SELECT custom_poster_url FROM media_items WHERE id = ${item.id}::uuid`;
        expect(row.custom_poster_url).toBe(`/api/image/custom/${item.id}/poster`);
    });

    it('is a no-op when the column is already NULL', async () => {
        const item = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, item);

        await expect(
            clearProviderCdnCustomImageUrl(sql, item.id, 'custom_backdrop_url'),
        ).resolves.toBeUndefined();
    });
});

describe('clearArtworkBlurhash', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media]);
    });

    it('clears poster_blurhash for a poster', async () => {
        const item = createTestMediaItem({ media_type: 'season' });
        await insertTestMediaItem(sql, item);
        await sql`UPDATE media_items SET poster_blurhash = 'LKO2' WHERE id = ${item.id}::uuid`;

        await clearArtworkBlurhash(sql, item.id, 'poster');

        const [row] =
            await sql`SELECT poster_blurhash FROM media_items WHERE id = ${item.id}::uuid`;
        expect(row.poster_blurhash).toBeNull();
    });

    it('clears backdrop_blurhash for a backdrop and leaves poster_blurhash alone', async () => {
        const item = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, item);
        await sql`
            UPDATE media_items SET poster_blurhash = 'AAAA', backdrop_blurhash = 'BBBB'
            WHERE id = ${item.id}::uuid
        `;

        await clearArtworkBlurhash(sql, item.id, 'backdrop');

        const [row] = await sql`
            SELECT poster_blurhash, backdrop_blurhash FROM media_items WHERE id = ${item.id}::uuid
        `;
        expect(row.backdrop_blurhash).toBeNull();
        expect(row.poster_blurhash).toBe('AAAA');
    });

    it('no-ops for types with no blurhash column', async () => {
        const item = createTestMediaItem({ media_type: 'tv' });
        await insertTestMediaItem(sql, item);
        await sql`UPDATE media_items SET poster_blurhash = 'AAAA' WHERE id = ${item.id}::uuid`;

        for (const type of ['logo', 'thumb', 'banner'] as const) {
            await expect(clearArtworkBlurhash(sql, item.id, type)).resolves.toBeUndefined();
        }

        const [row] =
            await sql`SELECT poster_blurhash FROM media_items WHERE id = ${item.id}::uuid`;
        expect(row.poster_blurhash).toBe('AAAA');
    });
});

describe('countPersonalMediaItems — unmatched, file-backed, top-level items', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function item(
        title: string,
        mediaType: string,
        parentId: string | null = null,
        dismissed = false,
    ): Promise<string> {
        const [row] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, parent_id, is_dismissed)
            VALUES (${title}, ${mediaType}, ${parentId}::uuid, ${dismissed})
            RETURNING id
        `;
        return row.id;
    }

    async function attachFile(mediaId: string, path: string): Promise<void> {
        const [file] = await sql<[{ id: string }]>`
            INSERT INTO media_files (file_path) VALUES (${path}) RETURNING id
        `;
        await sql`
            INSERT INTO media_file_items (file_id, media_item_id)
            VALUES (${file.id}::uuid, ${mediaId}::uuid)
        `;
    }

    it('counts unmatched file-backed movies and series, and nothing else', async () => {
        // Counted: an unmatched movie with its own file.
        const movie = await item('Home Video', 'movie');
        await attachFile(movie, '/test/personal/home-video.mkv');

        // Counted: an unmatched series whose only file hangs off an episode.
        const series = await item('Family Trip', 'tv');
        const season = await item('Season 1', 'season', series);
        const episode = await item('Day 1', 'episode', season);
        await attachFile(episode, '/test/personal/trip/day1.mkv');

        // Not counted: matched (has an external id).
        const matched = await item('Matched Film', 'movie');
        await attachFile(matched, '/test/matched.mkv');
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${matched}::uuid, 'tmdb', '550', 'movie', true)
        `;

        // Not counted: dismissed, file-less, and a child row with its own file.
        const dismissed = await item('Dismissed', 'movie', null, true);
        await attachFile(dismissed, '/test/dismissed.mkv');
        await item('No Files', 'movie');
        const orphanChild = await item('Extra', 'episode', season);
        await attachFile(orphanChild, '/test/personal/trip/extra.mkv');

        expect(await countPersonalMediaItems(sql)).toBe(2);
        expect(await countPersonalMediaItems(sql, { mediaType: 'movie' })).toBe(1);
        expect(await countPersonalMediaItems(sql, { search: 'trip' })).toBe(1);
    });

    it('keeps classification reversible while preserving file links and user ratings', async () => {
        const id = await item('Home Video', 'movie');
        await attachFile(id, '/test/personal/home-video.mkv');
        const userId = '98989898-9898-4898-8898-989898989898';
        await insertTestRating(sql, createTestRating(userId, id, 8));
        const before = await sql<[{ has_files: boolean; is_dismissed: boolean }]>`
            SELECT has_files, is_dismissed FROM media_items WHERE id = ${id}::uuid
        `;

        expect(await keepPersonalMediaItem(sql, id, 'test-admin')).toBe('kept');
        expect(await countPersonalMediaItems(sql)).toBe(0);
        expect(await countPersonalMediaItems(sql, { disposition: 'kept' })).toBe(1);
        expect(
            (await listPersonalMediaItems(sql, { limit: 10, offset: 0 })).map((x) => x.id),
        ).toEqual([]);
        expect(
            (await listPersonalMediaItems(sql, { limit: 10, offset: 0, disposition: 'kept' })).map(
                (x) => x.id,
            ),
        ).toEqual([id]);

        const afterKeep = await sql<
            [{ has_files: boolean; is_dismissed: boolean; file_path: string; rating: number }]
        >`
            SELECT mi.has_files, mi.is_dismissed, mf.file_path, ur.rating
            FROM media_items mi
            JOIN media_file_items mfi ON mfi.media_item_id = mi.id
            JOIN media_files mf ON mf.id = mfi.file_id
            JOIN user_ratings ur ON ur.media_id = mi.id
            WHERE mi.id = ${id}::uuid AND ur.user_id = ${userId}::uuid
        `;
        expect(afterKeep[0]).toMatchObject({
            ...before[0],
            file_path: '/test/personal/home-video.mkv',
            rating: 8,
        });

        expect(await restoreKeptPersonalMediaItem(sql, id)).toBe(true);
        expect(await restoreKeptPersonalMediaItem(sql, id)).toBe(false);
        expect(await countPersonalMediaItems(sql)).toBe(1);
        expect(await countPersonalMediaItems(sql, { disposition: 'kept' })).toBe(0);
        const afterRestore = await sql<[{ has_files: boolean; is_dismissed: boolean }]>`
            SELECT has_files, is_dismissed FROM media_items WHERE id = ${id}::uuid
        `;
        expect(afterRestore[0]).toEqual(before[0]);
        expect(
            await sql`SELECT 1 FROM media_file_items WHERE media_item_id = ${id}::uuid`,
        ).toHaveLength(1);
        expect(
            await sql`SELECT 1 FROM user_ratings WHERE media_id = ${id}::uuid AND user_id = ${userId}::uuid`,
        ).toHaveLength(1);
    });

    it('blocks scanner identity writes to kept items and clears Keep on an explicit manual match', async () => {
        const id = await item('Private Cut', 'movie');
        await attachFile(id, '/test/personal/private-cut.mkv');
        expect(await keepPersonalMediaItem(sql, id, 'test-admin')).toBe('kept');
        const catalog = new CatalogService(sql, { skipLifecycleHooks: true });

        expect(
            await catalog.upsertExternalId(
                id,
                { provider: 'tmdb', id: '987654', mediaType: 'movie', source: 'sync' },
                true,
            ),
        ).toBe(false);
        expect(await isPersonalMediaKept(sql, id)).toBe(true);
        expect(await sql`SELECT 1 FROM external_ids WHERE media_id = ${id}::uuid`).toHaveLength(0);

        expect(
            await catalog.upsertExternalId(
                id,
                { provider: 'tmdb', id: '987654', mediaType: 'movie', source: 'manual' },
                true,
            ),
        ).toBe(true);
        expect(await isPersonalMediaKept(sql, id)).toBe(false);
        expect(
            await sql`SELECT 1 FROM external_ids WHERE media_id = ${id}::uuid AND external_id = '987654'`,
        ).toHaveLength(1);
    });
});

describe('seasonHasCanonicalEpisodes — the auto-number guard', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function seasonWithEpisode(provider: string | null): Promise<string> {
        const [series] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type) VALUES ('ACCA', 'tv') RETURNING id
        `;
        const [season] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number)
            VALUES ('Season 1', 'season', ${series.id}::uuid, 1) RETURNING id
        `;
        const [ep] = await sql<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
            VALUES ('Jean the Cigarette-Peddler', 'episode', ${season.id}::uuid, 1, 1) RETURNING id
        `;
        if (provider) {
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${ep.id}::uuid, ${provider}, '1249781', 'episode', true)
            `;
        }
        return season.id;
    }

    /**
     * Production, 2026-07-13: ACCA's episodes 1-12 carried TMDB ids and no
     * Jellyfin id, so this returned false and the scanner auto-numbered 12
     * unparsed files to invented "Episode 13".."Episode 23" rows, leaving the
     * real episodes file-less. Jellyfin is optional; TMDB is the usual source.
     */
    it('treats a TMDB-only episode as canonical', async () => {
        expect(await seasonHasCanonicalEpisodes(sql, await seasonWithEpisode('tmdb'))).toBe(true);
    });

    it('still treats a Jellyfin episode as canonical', async () => {
        expect(await seasonHasCanonicalEpisodes(sql, await seasonWithEpisode('jellyfin'))).toBe(
            true,
        );
    });

    it('does not treat a scanner-created episode with no provider id as canonical', async () => {
        // Otherwise the first auto-numbered file would block every later one.
        expect(await seasonHasCanonicalEpisodes(sql, await seasonWithEpisode(null))).toBe(false);
    });
});
