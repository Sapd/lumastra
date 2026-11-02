// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Episode Orderings Query Module
 *
 * Tests series ordering preferences, episode orderings, and ID resolution.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    getSeriesOrdering,
    upsertSeriesOrdering,
    deleteSeriesOrdering,
    getEpisodeOrderings,
    findEpisodeByAbsoluteNumber,
    getAbsoluteNumber,
    hasOrderingsCache,
    deleteEpisodeOrderings,
    batchInsertEpisodeOrderings,
    resolveMediaIdFromTmdbId,
    resolveTmdbIdFromMediaId,
    linkEpisodeMediaIds,
    unlinkEpisodeMediaIds,
} from './episode-orderings.queries.js';

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('Episode Orderings Queries', () => {
    let sql: postgres.Sql;
    let seriesId: string;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await truncateTables(sql, [
            'episode_orderings',
            'series_episode_ordering',
            ...TEST_TABLES.media,
        ]);
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'episode_orderings',
            'series_episode_ordering',
            ...TEST_TABLES.media,
        ]);

        seriesId = crypto.randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status)
            VALUES (${seriesId}::uuid, ${'Test Series'}, 'tv', 'active')
        `;
    });

    // ========================================================================
    // Series Ordering
    // ========================================================================

    describe('getSeriesOrdering', () => {
        it('returns null when no ordering exists', async () => {
            const row = await getSeriesOrdering(sql, seriesId);
            expect(row).toBeNull();
        });

        it('returns the ordering row when it exists', async () => {
            await upsertSeriesOrdering(sql, {
                mediaId: seriesId,
                orderingType: 'dvd',
                orderingSource: 'manual',
                orderingProvider: 'tmdb',
                orderingGroupId: 'group1',
            });

            const row = await getSeriesOrdering(sql, seriesId);
            expect(row).not.toBeNull();
            expect(row!.media_id).toBe(seriesId);
            expect(row!.ordering_type).toBe('dvd');
            expect(row!.ordering_source).toBe('manual');
            expect(row!.ordering_provider).toBe('tmdb');
            expect(row!.ordering_group_id).toBe('group1');
        });
    });

    describe('upsertSeriesOrdering', () => {
        it('inserts a new ordering preference', async () => {
            const row = await upsertSeriesOrdering(sql, {
                mediaId: seriesId,
                orderingType: 'absolute',
                orderingSource: 'auto',
                orderingProvider: null,
                orderingGroupId: null,
            });

            expect(row.media_id).toBe(seriesId);
            expect(row.ordering_type).toBe('absolute');
        });

        it('updates on conflict', async () => {
            await upsertSeriesOrdering(sql, {
                mediaId: seriesId,
                orderingType: 'dvd',
                orderingSource: 'manual',
                orderingProvider: null,
                orderingGroupId: null,
            });

            const row = await upsertSeriesOrdering(sql, {
                mediaId: seriesId,
                orderingType: 'regional',
                orderingSource: 'auto',
                orderingProvider: null,
                orderingGroupId: null,
            });

            expect(row.ordering_type).toBe('regional');
            expect(row.ordering_source).toBe('auto');
        });
    });

    describe('deleteSeriesOrdering', () => {
        it('removes the ordering preference', async () => {
            await upsertSeriesOrdering(sql, {
                mediaId: seriesId,
                orderingType: 'dvd',
                orderingSource: 'manual',
                orderingProvider: null,
                orderingGroupId: null,
            });

            await deleteSeriesOrdering(sql, seriesId);
            const row = await getSeriesOrdering(sql, seriesId);
            expect(row).toBeNull();
        });

        it('does not throw when no ordering exists', async () => {
            await expect(deleteSeriesOrdering(sql, seriesId)).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // Episode Orderings
    // ========================================================================

    describe('getEpisodeOrderings', () => {
        it('returns empty array when no orderings exist', async () => {
            const rows = await getEpisodeOrderings(sql, {
                mediaId: seriesId,
                orderingType: 'dvd',
            });
            expect(rows).toEqual([]);
        });

        it('returns orderings for a series and type', async () => {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', 'ep1', 'dvd', 'g1', 1, 1, 1, 2, 1),
                    (${seriesId}::uuid, 'tmdb', 'ep2', 'dvd', 'g1', 1, 2, 1, 1, 2)
            `;

            const rows = await getEpisodeOrderings(sql, {
                mediaId: seriesId,
                orderingType: 'dvd',
            });
            expect(rows.length).toBe(2);
        });

        it('filters by provider and groupId', async () => {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', 'ep1', 'dvd', 'g1', 1, 1, 1, 1, 1),
                    (${seriesId}::uuid, 'tvdb', 'ep1', 'dvd', 'g2', 1, 1, 1, 1, 1)
            `;

            const rows = await getEpisodeOrderings(sql, {
                mediaId: seriesId,
                orderingType: 'dvd',
                orderingProvider: 'tmdb',
                orderingGroupId: 'g1',
            });
            expect(rows.length).toBe(1);
        });
    });

    describe('findEpisodeByAbsoluteNumber', () => {
        it('returns the episode with the matching absolute number', async () => {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', 'ep42', 'absolute', 'g1', 2, 18, 1, 42, 42)
            `;

            const row = await findEpisodeByAbsoluteNumber(sql, {
                mediaId: seriesId,
                absoluteNumber: 42,
            });
            expect(row).not.toBeNull();
            expect(row!.provider_episode_id).toBe('ep42');
        });

        it('returns null when no match', async () => {
            const row = await findEpisodeByAbsoluteNumber(sql, {
                mediaId: seriesId,
                absoluteNumber: 999,
            });
            expect(row).toBeNull();
        });
    });

    describe('getAbsoluteNumber', () => {
        it('returns the absolute number for a season/episode', async () => {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', 'ep1', 'absolute', 'g1', 1, 5, 1, 5, 105)
            `;

            const abs = await getAbsoluteNumber(sql, {
                mediaId: seriesId,
                seasonNumber: 1,
                episodeNumber: 5,
            });
            expect(abs).toBe(105);
        });

        it('returns null when no mapping exists', async () => {
            const abs = await getAbsoluteNumber(sql, {
                mediaId: seriesId,
                seasonNumber: 9,
                episodeNumber: 9,
            });
            expect(abs).toBeNull();
        });
    });

    describe('hasOrderingsCache', () => {
        it('returns false when no orderings exist', async () => {
            expect(await hasOrderingsCache(sql, seriesId)).toBe(false);
        });

        it('returns true when orderings exist', async () => {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', 'ep1', 'dvd', 'g1', 1, 1, 1, 1, 1)
            `;

            expect(await hasOrderingsCache(sql, seriesId)).toBe(true);
        });

        it('returns false when ordering type does not match', async () => {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', 'ep1', 'dvd', 'g1', 1, 1, 1, 1, 1)
            `;

            expect(await hasOrderingsCache(sql, seriesId, 'absolute')).toBe(false);
        });
    });

    describe('deleteEpisodeOrderings', () => {
        it('deletes orderings for a series', async () => {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', 'ep1', 'dvd', 'g1', 1, 1, 1, 1, 1)
            `;

            await deleteEpisodeOrderings(sql, { mediaId: seriesId });
            expect(await hasOrderingsCache(sql, seriesId)).toBe(false);
        });

        it('filters by orderingType, provider, and groupId', async () => {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', 'ep1', 'dvd', 'g1', 1, 1, 1, 1, 1),
                    (${seriesId}::uuid, 'tvdb', 'ep1', 'dvd', 'g2', 1, 1, 1, 1, 1)
            `;

            await deleteEpisodeOrderings(sql, {
                mediaId: seriesId,
                orderingType: 'dvd',
                provider: 'tmdb',
                groupId: 'g1',
            });

            const remaining = await getEpisodeOrderings(sql, {
                mediaId: seriesId,
                orderingType: 'dvd',
            });
            expect(remaining.length).toBe(1);
            expect(remaining[0].provider_episode_id).toBe('ep1');
        });
    });

    describe('batchInsertEpisodeOrderings', () => {
        it('inserts orderings in bulk', async () => {
            await batchInsertEpisodeOrderings(sql, [
                {
                    series_media_id: seriesId,
                    provider: 'tmdb',
                    provider_episode_id: 'ep1',
                    ordering_type: 'dvd',
                    ordering_group_id: 'g1',
                    original_season_number: 1,
                    original_episode_number: 1,
                    order_season_number: 1,
                    order_episode_number: 2,
                    absolute_number: null,
                },
                {
                    series_media_id: seriesId,
                    provider: 'tmdb',
                    provider_episode_id: 'ep2',
                    ordering_type: 'dvd',
                    ordering_group_id: 'g1',
                    original_season_number: 1,
                    original_episode_number: 2,
                    order_season_number: 1,
                    order_episode_number: 1,
                    absolute_number: null,
                },
            ]);

            const rows = await getEpisodeOrderings(sql, {
                mediaId: seriesId,
                orderingType: 'dvd',
            });
            expect(rows.length).toBe(2);
        });

        it('returns early for empty array', async () => {
            await expect(batchInsertEpisodeOrderings(sql, [])).resolves.toBeUndefined();
        });
    });

    // ========================================================================
    // ID Resolution
    // ========================================================================

    describe('resolveMediaIdFromTmdbId', () => {
        it('resolves TMDB external id to media_id for TV', async () => {
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${seriesId}::uuid, 'tmdb', ${'12345'}, 'tv')
            `;

            const mediaId = await resolveMediaIdFromTmdbId(sql, 12345);
            expect(mediaId).toBe(seriesId);
        });

        it('returns null when no match', async () => {
            const mediaId = await resolveMediaIdFromTmdbId(sql, 99999);
            expect(mediaId).toBeNull();
        });
    });

    describe('resolveTmdbIdFromMediaId', () => {
        it('returns the TMDB external id as a number', async () => {
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${seriesId}::uuid, 'tmdb', ${'98765'}, 'tv')
            `;

            const tmdbId = await resolveTmdbIdFromMediaId(sql, seriesId);
            expect(tmdbId).toBe(98765);
        });

        it('returns null when no TMDB id exists', async () => {
            const tmdbId = await resolveTmdbIdFromMediaId(sql, seriesId);
            expect(tmdbId).toBeNull();
        });
    });

    // ========================================================================
    // Episode Media ID Linking
    // ========================================================================

    describe('linkEpisodeMediaIds', () => {
        it('links via provider episode ID match', async () => {
            const epId = crypto.randomUUID();
            const seasonId2 = crypto.randomUUID();

            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${seasonId2}::uuid, ${'Season 1'}, 'season', ${seriesId}::uuid, 1, null, 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${epId}::uuid, ${'Episode 1'}, 'episode', ${seasonId2}::uuid, 1, 1, 'active')
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${epId}::uuid, 'tmdb', ${'11111'}, 'episode')
            `;
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', '11111', 'dvd', 'g1', 1, 1, 1, 1, 1)
            `;

            const result = await linkEpisodeMediaIds(sql, seriesId, 'dvd', 'tmdb', 'g1');
            expect(result.linked).toBe(1);
            expect(result.unlinked).toBe(0);
        });

        it('links via original season/episode number match', async () => {
            const epId = crypto.randomUUID();
            const seasonId2 = crypto.randomUUID();

            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${seasonId2}::uuid, ${'Season 1'}, 'season', ${seriesId}::uuid, 1, null, 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${epId}::uuid, ${'Episode 5'}, 'episode', ${seasonId2}::uuid, 1, 5, 'active')
            `;
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', 'remote-ep-5', 'dvd', 'g1', 1, 5, 1, 2, 5)
            `;

            const result = await linkEpisodeMediaIds(sql, seriesId, 'dvd', 'tmdb', 'g1');
            expect(result.linked).toBe(1);
        });

        it('returns zero linked when nothing matches', async () => {
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number)
                VALUES
                    (${seriesId}::uuid, 'tmdb', 'orphan', 'dvd', 'g1', 9, 9, 9, 9, 9)
            `;

            const result = await linkEpisodeMediaIds(sql, seriesId, 'dvd', 'tmdb', 'g1');
            expect(result.linked).toBe(0);
            expect(result.unlinked).toBe(1);
        });
    });

    describe('unlinkEpisodeMediaIds', () => {
        it('clears episode_media_id links', async () => {
            const epId = crypto.randomUUID();
            const seasonId2 = crypto.randomUUID();

            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${seasonId2}::uuid, ${'Season 1'}, 'season', ${seriesId}::uuid, 1, null, 'active')
            `;
            await sql`
                INSERT INTO media_items (id, title, media_type, parent_id, season_number, episode_number, status)
                VALUES (${epId}::uuid, ${'Episode 1'}, 'episode', ${seasonId2}::uuid, 1, 1, 'active')
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${epId}::uuid, 'tmdb', ${'22222'}, 'episode')
            `;
            await sql`
                INSERT INTO episode_orderings
                    (series_media_id, provider, provider_episode_id, ordering_type, ordering_group_id,
                     original_season_number, original_episode_number, order_season_number, order_episode_number, absolute_number, episode_media_id)
                VALUES
                    (${seriesId}::uuid, 'tmdb', '22222', 'dvd', 'g1', 1, 1, 1, 1, 1, ${epId}::uuid)
            `;

            await unlinkEpisodeMediaIds(sql, seriesId, 'dvd', 'tmdb', 'g1');

            const [row] = await sql<{ episode_media_id: string | null }[]>`
                SELECT episode_media_id FROM episode_orderings
                WHERE series_media_id = ${seriesId}::uuid
            `;
            expect(row.episode_media_id).toBeNull();
        });
    });
});
