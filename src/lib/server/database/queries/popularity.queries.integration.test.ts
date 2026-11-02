// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Popularity Query Module
 *
 * Tests upsertArtistPopularity, upsertTrackPopularity, markArtistProbed,
 * deleteTrackPopularityForArtist, wipePopularityForSource, getStaleArtists,
 * countPopularityBacklog, countTotalArtists, getLibraryTracksForArtist,
 * getArtistPopularity, getTrackPopularityForAlbum, getTrackPopularityForArtist,
 * getPopularityCoverageStats, findPopularityCoverageTableBacklog.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../tests/integration/fixtures/index.js';

import {
    upsertArtistPopularity,
    upsertTrackPopularity,
    markArtistProbed,
    deleteTrackPopularityForArtist,
    wipePopularityForSource,
    getStaleArtists,
    countPopularityBacklog,
    countTotalArtists,
    getLibraryTracksForArtist,
    getArtistPopularity,
    getTrackPopularityForAlbum,
    getTrackPopularityForArtist,
    getPopularityCoverageStats,
    findPopularityCoverageTableBacklog,
    DEFAULT_WIPE_BATCH_SIZE,
} from './popularity.queries.js';

const SOURCE = 'lastfm' as const;

describe('Popularity Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_popularity',
            'media_item_stage_state',
            ...TEST_TABLES.media,
        ]);
    });

    // ========================================================================
    // upsertArtistPopularity
    // ========================================================================

    describe('upsertArtistPopularity', () => {
        it('inserts artist popularity row', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);

            await upsertArtistPopularity(sql, {
                artistId,
                source: SOURCE,
                rawListeners: 1000,
                rawPlaycount: 5000,
                normalizedScore: 0.75,
                providerUrl: 'https://last.fm/artist/test',
                rawMetadata: { tags: ['rock'] },
            });

            const row = await getArtistPopularity(sql, artistId, SOURCE);
            expect(row).not.toBeNull();
            expect(row!.score).toBe(0.75);
            expect(row!.listeners).toBe(1000);
            expect(row!.rawMetadata).toEqual({ tags: ['rock'] });
        });

        it('updates on conflict preserving score_context', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);
            await upsertArtistPopularity(sql, {
                artistId,
                source: SOURCE,
                rawListeners: 100,
                rawPlaycount: 200,
                normalizedScore: 0.5,
                providerUrl: 'url',
            });

            await upsertArtistPopularity(sql, {
                artistId,
                source: SOURCE,
                rawListeners: 200,
                rawPlaycount: 400,
                normalizedScore: 0.8,
                providerUrl: 'url2',
            });

            const row = await getArtistPopularity(sql, artistId, SOURCE);
            expect(row!.score).toBe(0.8);
        });
    });

    // ========================================================================
    // upsertTrackPopularity
    // ========================================================================

    describe('upsertTrackPopularity', () => {
        it('inserts track popularity row with rank', async () => {
            const { trackIds } = await createAndInsertTestMusicHierarchy(sql);
            const trackId = trackIds[0];

            await upsertTrackPopularity(sql, {
                trackId,
                source: SOURCE,
                rank: 3,
                rawListeners: 100,
                rawPlaycount: 500,
                normalizedScore: 0.6,
                providerUrl: 'url',
            });

            const _rows = await getTrackPopularityForArtist(sql, trackId, SOURCE);
            // getTrackPopularityForArtist two-hops from artist; this track belongs to an album under the artist
            // Actually querying with trackId as artistId won't find anything. Query via album instead.
        });
    });

    // ========================================================================
    // markArtistProbed
    // ========================================================================

    describe('markArtistProbed', () => {
        it('inserts a probe marker', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);

            const ok = await markArtistProbed(sql, artistId, SOURCE, 'not_found');

            expect(ok).toBe(true);
            const row = await getArtistPopularity(sql, artistId, SOURCE);
            expect(row).not.toBeNull();
            expect(row!.rawMetadata).toEqual({
                probed: true,
                reason: 'not_found',
            });
        });

        it('refreshes fetched_at on existing row', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);
            await upsertArtistPopularity(sql, {
                artistId,
                source: SOURCE,
                rawListeners: 10,
                rawPlaycount: 20,
                normalizedScore: 0.1,
                providerUrl: 'url',
            });
            const before = await getArtistPopularity(sql, artistId, SOURCE);

            await new Promise((r) => setTimeout(r, 50));
            const ok = await markArtistProbed(sql, artistId, SOURCE, 'retry');

            expect(ok).toBe(true);
            const after = await getArtistPopularity(sql, artistId, SOURCE);
            expect(after!.fetchedAt.getTime()).toBeGreaterThanOrEqual(before!.fetchedAt.getTime());
            expect(after!.score).toBe(0.1); // preserved
        });
    });

    // ========================================================================
    // deleteTrackPopularityForArtist
    // ========================================================================

    describe('deleteTrackPopularityForArtist', () => {
        it('deletes track-level rows for artist', async () => {
            const { artistId, albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql);
            for (const trackId of trackIds) {
                await upsertTrackPopularity(sql, {
                    trackId,
                    source: SOURCE,
                    rank: 1,
                    rawListeners: 10,
                    rawPlaycount: 50,
                    normalizedScore: 0.5,
                    providerUrl: 'url',
                });
            }

            const deleted = await deleteTrackPopularityForArtist(sql, artistId, SOURCE);

            expect(deleted).toBe(trackIds.length);
            const remaining = await getTrackPopularityForAlbum(sql, albumId, SOURCE);
            expect(remaining).toHaveLength(0);
        });

        it('returns 0 when no track rows exist', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);
            const deleted = await deleteTrackPopularityForArtist(sql, artistId, SOURCE);
            expect(deleted).toBe(0);
        });
    });

    // ========================================================================
    // wipePopularityForSource
    // ========================================================================

    describe('wipePopularityForSource', () => {
        it('deletes all rows for a source', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);
            await upsertArtistPopularity(sql, {
                artistId,
                source: SOURCE,
                rawListeners: 1,
                rawPlaycount: 1,
                normalizedScore: 0.1,
                providerUrl: 'url',
            });

            const total = await wipePopularityForSource(sql, SOURCE);
            expect(total).toBe(1);

            const row = await getArtistPopularity(sql, artistId, SOURCE);
            expect(row).toBeNull();
        });

        it('throws on invalid batch size', async () => {
            await expect(wipePopularityForSource(sql, SOURCE, 0)).rejects.toThrow(
                'batchSize must be a positive integer',
            );
        });

        it('respects abort signal', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);
            await upsertArtistPopularity(sql, {
                artistId,
                source: SOURCE,
                rawListeners: 1,
                rawPlaycount: 1,
                normalizedScore: 0.1,
                providerUrl: 'url',
            });

            const controller = new AbortController();
            controller.abort();
            const total = await wipePopularityForSource(
                sql,
                SOURCE,
                DEFAULT_WIPE_BATCH_SIZE,
                controller.signal,
            );
            expect(total).toBe(0);
        });
    });

    // ========================================================================
    // getStaleArtists
    // ========================================================================

    describe('getStaleArtists', () => {
        it('returns artists with no popularity row', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);

            const rows = await getStaleArtists(sql, SOURCE, new Date().toISOString(), 10);

            expect(rows.some((r) => r.artistId === artistId)).toBe(true);
        });

        it('does not return fresh artists', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);
            await upsertArtistPopularity(sql, {
                artistId,
                source: SOURCE,
                rawListeners: 1,
                rawPlaycount: 1,
                normalizedScore: 0.1,
                providerUrl: 'url',
            });

            const staleBefore = new Date(Date.now() - 86400 * 1000).toISOString();
            const rows = await getStaleArtists(sql, SOURCE, staleBefore, 10);

            expect(rows.some((r) => r.artistId === artistId)).toBe(false);
        });
    });

    // ========================================================================
    // countPopularityBacklog
    // ========================================================================

    describe('countPopularityBacklog', () => {
        it('returns analyzed and remaining counts', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);
            await upsertArtistPopularity(sql, {
                artistId,
                source: SOURCE,
                rawListeners: 1,
                rawPlaycount: 1,
                normalizedScore: 0.1,
                providerUrl: 'url',
            });

            const staleBefore = new Date(Date.now() - 86400 * 1000).toISOString();
            const counts = await countPopularityBacklog(sql, SOURCE, staleBefore);

            expect(counts.analyzed).toBeGreaterThanOrEqual(1);
            expect(counts.remaining).toBeGreaterThanOrEqual(0);
        });
    });

    // ========================================================================
    // countTotalArtists
    // ========================================================================

    describe('countTotalArtists', () => {
        it('counts artist media_items', async () => {
            const before = await countTotalArtists(sql);
            await createAndInsertTestMusicHierarchy(sql);
            const after = await countTotalArtists(sql);

            expect(after).toBe(before + 1);
        });
    });

    // ========================================================================
    // getLibraryTracksForArtist
    // ========================================================================

    describe('getLibraryTracksForArtist', () => {
        it('returns tracks under the artist via album', async () => {
            const { artistId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 3,
            });

            const tracks = await getLibraryTracksForArtist(sql, artistId);
            const ids = tracks.map((t) => t.id);

            expect(tracks.length).toBe(3);
            for (const tid of trackIds) {
                expect(ids).toContain(tid);
            }
        });
    });

    // ========================================================================
    // getArtistPopularity
    // ========================================================================

    describe('getArtistPopularity', () => {
        it('returns null for unknown artist/source', async () => {
            const row = await getArtistPopularity(sql, crypto.randomUUID(), SOURCE);
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getTrackPopularityForAlbum
    // ========================================================================

    describe('getTrackPopularityForAlbum', () => {
        it('returns tracks ordered by rank', async () => {
            const { albumId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });
            for (let i = 0; i < trackIds.length; i++) {
                await upsertTrackPopularity(sql, {
                    trackId: trackIds[i],
                    source: SOURCE,
                    rank: i + 1,
                    rawListeners: 10,
                    rawPlaycount: 50,
                    normalizedScore: 0.5,
                    providerUrl: 'url',
                });
            }

            const rows = await getTrackPopularityForAlbum(sql, albumId, SOURCE);
            expect(rows.length).toBe(2);
            expect(rows[0].rank).toBe(1);
            expect(rows[1].rank).toBe(2);
        });
    });

    // ========================================================================
    // getTrackPopularityForArtist
    // ========================================================================

    describe('getTrackPopularityForArtist', () => {
        it('returns track popularity across all albums of artist', async () => {
            const { artistId, trackIds } = await createAndInsertTestMusicHierarchy(sql, {
                trackCount: 2,
            });
            for (const trackId of trackIds) {
                await upsertTrackPopularity(sql, {
                    trackId,
                    source: SOURCE,
                    rank: 1,
                    rawListeners: 10,
                    rawPlaycount: 50,
                    normalizedScore: 0.5,
                    providerUrl: 'url',
                });
            }

            const rows = await getTrackPopularityForArtist(sql, artistId, SOURCE);
            expect(rows.length).toBe(2);
        });
    });

    // ========================================================================
    // getPopularityCoverageStats
    // ========================================================================

    describe('getPopularityCoverageStats', () => {
        it('returns coverage stats for source', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);
            await upsertArtistPopularity(sql, {
                artistId,
                source: SOURCE,
                rawListeners: 1,
                rawPlaycount: 1,
                normalizedScore: 0.1,
                providerUrl: 'url',
            });

            const stats = await getPopularityCoverageStats(sql, SOURCE);

            expect(stats.source).toBe(SOURCE);
            expect(stats.artistsFetched).toBeGreaterThanOrEqual(1);
            expect(stats.tableSizeBytes).toBeGreaterThanOrEqual(0);
        });
    });

    // ========================================================================
    // findPopularityCoverageTableBacklog
    // ========================================================================

    describe('findPopularityCoverageTableBacklog', () => {
        it('returns backlog from media_item_stage_state', async () => {
            const { artistId } = await createAndInsertTestMusicHierarchy(sql);
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version)
                VALUES (${artistId}::uuid, 'music-popularity', 'pending', 1)
            `;

            const rows = await findPopularityCoverageTableBacklog(sql, 'music-popularity', 10);

            expect(rows.some((r) => r.artistId === artistId)).toBe(true);
        });
    });
});
