// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for AI Sync Query Module
 *
 * Tests series/episode sync, user progress tracking, task history,
 * embeddings, and provider metadata operations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { EMBEDDING_SOURCE } from '../../utils/embedding-source.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
    createTestExternalIds,
    insertTestExternalIds,
} from '../../../../../tests/integration/fixtures/index.js';

// Import query functions to test
import {
    upsertJellyfinSeason,
    upsertJellyfinEpisode,
    upsertJellyfinEpisodeWithTracking,
    episodeExists,
    upsertMediaEmbedding,
    embeddingExists,
    getSeriesInfoForProgress,
    getSeriesSyncStatus,
    findCastBackfillCandidates,
    findCastAggregationGaps,
    type JellyfinSeasonInsert,
    type JellyfinEpisodeInsert,
    type JellyfinEpisodeInsertExtended,
} from './ai-sync.queries.js';
import { upsertProviderMetadataUnlessLocked } from './media-upsert.js';

describe('AI Sync Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            ...TEST_TABLES.media,
            ...TEST_TABLES.jellyfinContent,
            'user_media_state',
        ]);
    });

    describe('upsertJellyfinSeason', () => {
        // Create series in media_items for season to reference
        // IDs stored without dashes to match normalizeJellyfinId() output
        beforeEach(async () => {
            const seriesId = crypto.randomUUID();
            await sql`INSERT INTO media_items (id, title, media_type, status) VALUES (${seriesId}::uuid, 'Test Series', 'tv', 'active')`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${seriesId}::uuid, 'jellyfin', 'jfseries001', 'tv', false)`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${seriesId}::uuid, 'tmdb', '880001', 'tv', true)`;
        });

        it('inserts a new season', async () => {
            const season: JellyfinSeasonInsert = {
                jellyfinId: 'jfseason001',
                seriesJellyfinId: 'jfseries001',
                seriesPrimaryId: '880001',
                seasonNumber: 1,
                name: 'Season 1',
                overview: 'First season overview',
                premiereDate: '2024-01-15',
                episodeCount: 10,
                imageTag: 'img-tag-001',
            };

            await upsertJellyfinSeason(sql, season);

            const [row] = await sql<{ jellyfin_id: string; season_number: number }[]>`
                SELECT ei.external_id as jellyfin_id, mi.season_number
                FROM media_items mi
                JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'jellyfin'
                WHERE ei.external_id = 'jfseason001' AND mi.media_type = 'season'
            `;

            expect(row.jellyfin_id).toBe('jfseason001');
            expect(row.season_number).toBe(1);
        });

        it('updates existing season on conflict', async () => {
            const season: JellyfinSeasonInsert = {
                jellyfinId: 'jfseason002',
                seriesJellyfinId: 'jfseries001',
                seriesPrimaryId: '880001',
                seasonNumber: 2,
                name: 'Season 2',
                overview: null,
                premiereDate: null,
                episodeCount: 8,
                imageTag: null,
            };

            await upsertJellyfinSeason(sql, season);

            // Update with new episode count
            const updatedSeason = {
                ...season,
                episodeCount: 12,
                name: 'Season 2 - Updated',
            };
            await upsertJellyfinSeason(sql, updatedSeason);

            const [row] = await sql<{ title: string; season_number: number }[]>`
                SELECT mi.title, mi.season_number
                FROM media_items mi
                JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'jellyfin'
                WHERE ei.external_id = 'jfseason002' AND mi.media_type = 'season'
            `;

            // episode_count is not stored in media_items; check title update
            expect(row.title).toBe('Season 2 - Updated');
            expect(row.season_number).toBe(2);
        });
    });

    describe('upsertJellyfinEpisode', () => {
        // Create series and season in media_items for episodes to reference
        // IDs stored without dashes to match normalizeJellyfinId() output
        beforeEach(async () => {
            const seriesId = crypto.randomUUID();
            await sql`INSERT INTO media_items (id, title, media_type, status) VALUES (${seriesId}::uuid, 'Test Series', 'tv', 'active')`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${seriesId}::uuid, 'jellyfin', 'jfseries001', 'tv', false)`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${seriesId}::uuid, 'tmdb', '880001', 'tv', true)`;
            // Create season 1 so upsertJellyfinEpisode can find it
            await upsertJellyfinSeason(sql, {
                jellyfinId: 'jfseason001',
                seriesJellyfinId: 'jfseries001',
                seriesPrimaryId: '880001',
                seasonNumber: 1,
                name: 'Season 1',
                overview: null,
                premiereDate: null,
                episodeCount: 5,
                imageTag: null,
            });
        });

        it('inserts a new episode', async () => {
            const episode: JellyfinEpisodeInsert = {
                jellyfinId: 'jfep001',
                seriesJellyfinId: 'jfseries001',
                seriesPrimaryId: '880001',
                seasonNumber: 1,
                episodeNumber: 1,
                title: 'Pilot',
                overview: 'The beginning',
                runtimeSeconds: 2700,
                premiereDate: '2024-01-15',
            };

            await upsertJellyfinEpisode(sql, episode);

            const [row] = await sql<
                {
                    jellyfin_id: string;
                    title: string;
                    season_number: number;
                }[]
            >`
                SELECT ei.external_id as jellyfin_id, mi.title, mi.season_number
                FROM media_items mi
                JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'jellyfin'
                WHERE ei.external_id = 'jfep001' AND mi.media_type = 'episode'
            `;

            expect(row.jellyfin_id).toBe('jfep001');
            expect(row.title).toBe('Pilot');
            expect(row.season_number).toBe(1);
        });

        it('updates existing episode on conflict', async () => {
            const episode: JellyfinEpisodeInsert = {
                jellyfinId: 'jfep002',
                seriesJellyfinId: 'jfseries001',
                seriesPrimaryId: null,
                seasonNumber: 1,
                episodeNumber: 2,
                title: 'Episode 2',
                overview: null,
                runtimeSeconds: 2400,
                premiereDate: null,
            };

            await upsertJellyfinEpisode(sql, episode);

            // Update with more info
            const updated = {
                ...episode,
                title: 'The Second',
                runtimeSeconds: 2700,
            };
            await upsertJellyfinEpisode(sql, updated);

            const [row] = await sql<{ title: string; runtime_seconds: number }[]>`
                SELECT mi.title, mi.runtime_seconds
                FROM media_items mi
                JOIN external_ids ei ON ei.media_id = mi.id AND ei.provider = 'jellyfin'
                WHERE ei.external_id = 'jfep002' AND mi.media_type = 'episode'
            `;

            expect(row.title).toBe('The Second');
            expect(row.runtime_seconds).toBe(2700);
        });
    });

    describe('episodeExists', () => {
        // Create series and season in media_items for episodes to reference
        // IDs stored without dashes to match normalizeJellyfinId() output
        beforeEach(async () => {
            const seriesId = crypto.randomUUID();
            await sql`INSERT INTO media_items (id, title, media_type, status) VALUES (${seriesId}::uuid, 'Test Series', 'tv', 'active')`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${seriesId}::uuid, 'jellyfin', 'jfseries001', 'tv', false)`;
            // Create season 1 so upsertJellyfinEpisode can find it
            await upsertJellyfinSeason(sql, {
                jellyfinId: 'jfseason001',
                seriesJellyfinId: 'jfseries001',
                seriesPrimaryId: null,
                seasonNumber: 1,
                name: 'Season 1',
                overview: null,
                premiereDate: null,
                episodeCount: 5,
                imageTag: null,
            });
        });

        it('returns true when episode exists', async () => {
            const episode: JellyfinEpisodeInsert = {
                jellyfinId: 'jfepexists001',
                seriesJellyfinId: 'jfseries001',
                seriesPrimaryId: null,
                seasonNumber: 1,
                episodeNumber: 1,
                title: 'Test',
                overview: null,
                runtimeSeconds: null,
                premiereDate: null,
            };
            await upsertJellyfinEpisode(sql, episode);

            const exists = await episodeExists(sql, 'jfepexists001');
            expect(exists).toBe(true);
        });

        it('returns false when episode does not exist', async () => {
            const exists = await episodeExists(sql, 'non-existent-episode');
            expect(exists).toBe(false);
        });
    });

    // ==========================================================================
    // Embedding Queries
    // ==========================================================================

    describe('upsertMediaEmbedding', () => {
        it('inserts new embedding', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const embedding = Array(1024)
                .fill(0)
                .map(() => Math.random() * 2 - 1);
            await upsertMediaEmbedding(sql, item.id, EMBEDDING_SOURCE.LIBRARY, embedding);

            const exists = await embeddingExists(sql, item.id, EMBEDDING_SOURCE.LIBRARY);
            expect(exists).toBe(true);
        });

        it('updates existing embedding on conflict', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const embedding1 = Array(1024).fill(0.5);
            const embedding2 = Array(1024).fill(-0.5);

            await upsertMediaEmbedding(sql, item.id, EMBEDDING_SOURCE.LIBRARY, embedding1);
            await upsertMediaEmbedding(sql, item.id, EMBEDDING_SOURCE.LIBRARY, embedding2);

            // Should still have only one embedding
            const [count] = await sql<{ count: string }[]>`
                SELECT COUNT(*) as count FROM media_embeddings
                WHERE media_id = ${item.id}::uuid AND source = ${EMBEDDING_SOURCE.LIBRARY}
            `;
            expect(Number(count.count)).toBe(1);
        });
    });

    describe('embeddingExists', () => {
        it('returns true when embedding exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const embedding = Array(1024).fill(0);
            await upsertMediaEmbedding(sql, item.id, EMBEDDING_SOURCE.LIBRARY, embedding);

            expect(await embeddingExists(sql, item.id, EMBEDDING_SOURCE.LIBRARY)).toBe(true);
        });

        it('returns false when embedding does not exist', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            expect(await embeddingExists(sql, item.id, EMBEDDING_SOURCE.LIBRARY)).toBe(false);
        });

        it('distinguishes between different sources', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const embedding = Array(1024).fill(0);
            await upsertMediaEmbedding(sql, item.id, EMBEDDING_SOURCE.LIBRARY, embedding);

            expect(await embeddingExists(sql, item.id, EMBEDDING_SOURCE.LIBRARY)).toBe(true);
            expect(await embeddingExists(sql, item.id, EMBEDDING_SOURCE.DISCOVERY)).toBe(false);
        });
    });

    // ==========================================================================
    // Provider Metadata Queries
    // ==========================================================================

    describe('upsertProviderMetadataUnlessLocked (imported from media-upsert.js)', () => {
        it('inserts provider metadata record', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await upsertProviderMetadataUnlessLocked(sql, item.id, 'tmdb', {
                vote_average: 7.5,
                popularity: 100,
            });

            const [row] = await sql<{ provider: string }[]>`
                SELECT provider FROM provider_metadata
                WHERE media_id = ${item.id}::uuid AND provider = 'tmdb'
            `;

            expect(row.provider).toBe('tmdb');
        });

        it('stores metadata as JSONB object (not string or array)', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await upsertProviderMetadataUnlessLocked(sql, item.id, 'mdblist', {
                mdblist_score: 85,
                keywords: ['action', 'thriller'],
            });

            const [row] = await sql<{ metadata_type: string; metadata: Record<string, unknown> }[]>`
                SELECT
                    jsonb_typeof(metadata) as metadata_type,
                    metadata
                FROM provider_metadata
                WHERE media_id = ${item.id}::uuid AND provider = 'mdblist'
            `;

            // Verify JSONB is stored as object, not string or array
            expect(row.metadata_type).toBe('object');
            expect(row.metadata.mdblist_score).toBe(85);
            expect(row.metadata.keywords).toEqual(['action', 'thriller']);
        });

        it('handles conflict (upsert) and preserves object type', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // First insert
            await upsertProviderMetadataUnlessLocked(sql, item.id, 'aggregated', {
                rating: 8,
            });

            // Second insert - should not fail due to ON CONFLICT
            await upsertProviderMetadataUnlessLocked(sql, item.id, 'aggregated', {
                genres: ['Action'],
            });

            // Verify metadata is still an object (not array)
            const [row] = await sql<{ count: string; metadata_type: string }[]>`
                SELECT
                    COUNT(*) as count,
                    jsonb_typeof(metadata) as metadata_type
                FROM provider_metadata
                WHERE media_id = ${item.id}::uuid AND provider = 'aggregated'
                GROUP BY metadata
            `;

            expect(Number(row.count)).toBe(1);
            expect(row.metadata_type).toBe('object');
        });

        it('auto-fixes corrupted array metadata on update', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            // Insert valid metadata first
            await upsertProviderMetadataUnlessLocked(sql, item.id, 'mdblist', {
                score: 80,
            });

            // Manually corrupt it to array (simulating old bug)
            await sql`
                UPDATE provider_metadata
                SET metadata = '["corrupted", "array"]'::jsonb
                WHERE media_id = ${item.id}::uuid AND provider = 'mdblist'
            `;

            // Verify corruption
            const [corrupted] = await sql<{ metadata_type: string }[]>`
                SELECT jsonb_typeof(metadata) as metadata_type
                FROM provider_metadata
                WHERE media_id = ${item.id}::uuid AND provider = 'mdblist'
            `;
            expect(corrupted.metadata_type).toBe('array');

            // Upsert again - should auto-fix
            await upsertProviderMetadataUnlessLocked(sql, item.id, 'mdblist', {
                score: 90,
                new_field: 'test',
            });

            // Verify it's fixed
            const [fixed] = await sql<
                { metadata_type: string; metadata: Record<string, unknown> }[]
            >`
                SELECT
                    jsonb_typeof(metadata) as metadata_type,
                    metadata
                FROM provider_metadata
                WHERE media_id = ${item.id}::uuid AND provider = 'mdblist'
            `;

            expect(fixed.metadata_type).toBe('object');
            expect(fixed.metadata.score).toBe(90);
            expect(fixed.metadata.new_field).toBe('test');
        });
    });

    // ==========================================================================
    // Series Info Queries
    // ==========================================================================

    describe('getSeriesInfoForProgress', () => {
        // Create series in media_items for info tests
        beforeEach(async () => {
            const seriesId = crypto.randomUUID();
            await sql`INSERT INTO media_items (id, title, media_type, status) VALUES (${seriesId}::uuid, 'Info Test Series', 'tv', 'active')`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${seriesId}::uuid, 'jellyfin', 'jfseriesinfo', 'tv', false)`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${seriesId}::uuid, 'tmdb', '999001', 'tv', true)`;
            // Create season so upsertJellyfinEpisode can insert episodes
            await upsertJellyfinSeason(sql, {
                jellyfinId: 'jfinfoseason001',
                seriesJellyfinId: 'jfseriesinfo',
                seriesPrimaryId: '999001',
                seasonNumber: 1,
                name: 'Season 1',
                overview: null,
                premiereDate: null,
                episodeCount: 5,
                imageTag: null,
            });
        });

        it('returns episode count and primary_id', async () => {
            // Insert episodes for a series
            const episodes: JellyfinEpisodeInsert[] = [
                {
                    jellyfinId: 'jfinfoep1',
                    seriesJellyfinId: 'jfseriesinfo',
                    seriesPrimaryId: '999001',
                    seasonNumber: 1,
                    episodeNumber: 1,
                    title: 'Ep 1',
                    overview: null,
                    runtimeSeconds: null,
                    premiereDate: null,
                },
                {
                    jellyfinId: 'jfinfoep2',
                    seriesJellyfinId: 'jfseriesinfo',
                    seriesPrimaryId: '999001',
                    seasonNumber: 1,
                    episodeNumber: 2,
                    title: 'Ep 2',
                    overview: null,
                    runtimeSeconds: null,
                    premiereDate: null,
                },
            ];

            for (const ep of episodes) {
                await upsertJellyfinEpisode(sql, ep);
            }

            const info = await getSeriesInfoForProgress(sql, 'jfseriesinfo');

            expect(info).not.toBeNull();
            expect(info?.total_episodes).toBe(2);
            expect(info?.primary_id).toBe('999001');
        });

        it('returns null for non-existent series', async () => {
            const info = await getSeriesInfoForProgress(sql, 'non-existent-series');
            expect(info).toBeNull();
        });
    });

    describe('getSeriesSyncStatus', () => {
        // Create series in media_items for sync status tests
        beforeEach(async () => {
            const seriesId = crypto.randomUUID();
            await sql`INSERT INTO media_items (id, title, media_type, status) VALUES (${seriesId}::uuid, 'Sync Status Series', 'tv', 'active')`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary) VALUES (${seriesId}::uuid, 'jellyfin', 'jfsyncstatusseries', 'tv', false)`;
        });

        it('returns sync status for a series', async () => {
            const seriesId = 'jfsyncstatusseries';

            // Insert season
            await upsertJellyfinSeason(sql, {
                jellyfinId: 'jfsyncseason1',
                seriesJellyfinId: seriesId,
                seriesPrimaryId: null,
                seasonNumber: 1,
                name: 'Season 1',
                overview: null,
                premiereDate: null,
                episodeCount: 3,
                imageTag: null,
            });

            // Insert episodes
            for (let i = 1; i <= 3; i++) {
                await upsertJellyfinEpisode(sql, {
                    jellyfinId: `jfsyncep${i}`,
                    seriesJellyfinId: seriesId,
                    seriesPrimaryId: null,
                    seasonNumber: 1,
                    episodeNumber: i,
                    title: `Episode ${i}`,
                    overview: null,
                    runtimeSeconds: null,
                    premiereDate: null,
                });
            }

            const status = await getSeriesSyncStatus(sql, 'jfsyncstatusseries');

            expect(status.episodeCount).toBe(3);
            expect(status.seasonCount).toBe(1);
            expect(status.lastSynced).not.toBeNull();
        });

        it('returns zero counts for non-existent series', async () => {
            const status = await getSeriesSyncStatus(sql, 'non-existent');

            expect(status.episodeCount).toBe(0);
            expect(status.seasonCount).toBe(0);
            expect(status.lastSynced).toBeNull();
        });
    });

    describe('upsertJellyfinEpisodeWithTracking — identity-binding guard', () => {
        // Seed a full series + season + episode with title_binding='identity' and a
        // known tmdb external_id so we can assert the guard preserves it.
        beforeEach(async () => {
            const seriesId = crypto.randomUUID();
            await sql`
                INSERT INTO media_items (id, title, media_type, status)
                VALUES (${seriesId}::uuid, 'Guard Test Series', 'tv', 'active')
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${seriesId}::uuid, 'jellyfin', 'guardtestseries', 'tv', false)
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${seriesId}::uuid, 'tmdb', '990001', 'tv', true)
            `;
            await upsertJellyfinSeason(sql, {
                jellyfinId: 'guardtestseason1',
                seriesJellyfinId: 'guardtestseries',
                seriesPrimaryId: '990001',
                seasonNumber: 1,
                name: 'Season 1',
                overview: null,
                premiereDate: null,
                episodeCount: 1,
                imageTag: null,
            });
        });

        it('preserves reconciled tmdb external_id for an identity-bound episode', async () => {
            // Insert the episode first (without identity binding) to establish the row.
            const baseEpisode: JellyfinEpisodeInsertExtended = {
                jellyfinId: 'guardtestep1',
                seriesJellyfinId: 'guardtestseries',
                seriesPrimaryId: '990001',
                seasonNumber: 1,
                episodeNumber: 1,
                title: 'Guard Test Episode',
                overview: null,
                runtimeSeconds: 2700,
                premiereDate: '2024-03-01',
                episodeTmdbId: 79000,
                imdbId: null,
            };
            await upsertJellyfinEpisodeWithTracking(sql, baseEpisode);

            // Mark the episode row as identity-bound (simulates reconciliation).
            await sql`
                UPDATE media_items mi
                SET title_binding = 'identity'
                FROM external_ids ei
                WHERE ei.media_id = mi.id
                  AND ei.provider = 'jellyfin'
                  AND ei.external_id = 'guardtestep1'
                  AND mi.media_type = 'episode'
            `;

            // Rescan reports a different tmdb id — must NOT overwrite the reconciled one.
            const rescannedEpisode: JellyfinEpisodeInsertExtended = {
                ...baseEpisode,
                episodeTmdbId: 78888,
            };
            await upsertJellyfinEpisodeWithTracking(sql, rescannedEpisode);

            const [externalIdRow] = await sql<{ external_id: string }[]>`
                SELECT ei.external_id
                FROM external_ids ei
                JOIN media_items mi ON mi.id = ei.media_id
                JOIN external_ids jf ON jf.media_id = mi.id
                WHERE jf.provider = 'jellyfin'
                  AND jf.external_id = 'guardtestep1'
                  AND ei.provider = 'tmdb'
                  AND mi.media_type = 'episode'
            `;

            expect(externalIdRow.external_id).toBe('79000');
        });

        it('still writes jellyfin external_id for an identity-bound episode', async () => {
            // Use a fresh jellyfin id to confirm the jellyfin write is unconditional.
            const episode: JellyfinEpisodeInsertExtended = {
                jellyfinId: 'guardtestep2',
                seriesJellyfinId: 'guardtestseries',
                seriesPrimaryId: '990001',
                seasonNumber: 1,
                episodeNumber: 2,
                title: 'Guard Test Episode 2',
                overview: null,
                runtimeSeconds: null,
                premiereDate: null,
                episodeTmdbId: 79001,
                imdbId: null,
            };
            await upsertJellyfinEpisodeWithTracking(sql, episode);

            // Mark identity-bound.
            await sql`
                UPDATE media_items mi
                SET title_binding = 'identity'
                FROM external_ids ei
                WHERE ei.media_id = mi.id
                  AND ei.provider = 'jellyfin'
                  AND ei.external_id = 'guardtestep2'
                  AND mi.media_type = 'episode'
            `;

            // Rescan with different tmdb id — jellyfin id must still be present.
            await upsertJellyfinEpisodeWithTracking(sql, {
                ...episode,
                episodeTmdbId: 78999,
            });

            const [jellyfinRow] = await sql<{ external_id: string }[]>`
                SELECT ei.external_id
                FROM external_ids ei
                JOIN media_items mi ON mi.id = ei.media_id
                WHERE ei.provider = 'jellyfin'
                  AND ei.external_id = 'guardtestep2'
                  AND mi.media_type = 'episode'
            `;

            expect(jellyfinRow.external_id).toBe('guardtestep2');
        });
    });

    // ==========================================================================
    // findCastBackfillCandidates — metadata-cast-backfill candidate query
    // ==========================================================================

    describe('findCastBackfillCandidates', () => {
        async function insertCandidateItem(opts: {
            title: string;
            tmdbId: number;
            hasFiles?: boolean;
            parentId?: string | null;
        }): Promise<string> {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: opts.title,
                has_files: opts.hasFiles ?? true,
                parent_id: opts.parentId ?? null,
            });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, { tmdbId: opts.tmdbId, mediaType: 'movie' }),
            );
            return item.id;
        }

        it('is a candidate when it has only flat actors (no structured cast, no marker)', async () => {
            const mediaId = await insertCandidateItem({ title: 'Jasper', tmdbId: 475557 });
            // Flat actors only, matching the pre-fix write shape — no `cast` key.
            await upsertProviderMetadataUnlessLocked(sql, mediaId, 'tmdb', {
                actors: ['Jules Fenwick', 'Robert De Niro'],
            });

            const candidates = await findCastBackfillCandidates(sql, 100);

            expect(candidates.map((c) => c.media_id)).toContain(mediaId);
        });

        it('is NOT a candidate once a provider row already has a non-empty structured cast', async () => {
            const mediaId = await insertCandidateItem({
                title: 'Has Structured Cast',
                tmdbId: 475558,
            });
            await upsertProviderMetadataUnlessLocked(sql, mediaId, 'tmdb', {
                actors: ['Jules Fenwick'],
                cast: [{ name: 'Jules Fenwick', character: 'Arthur Fleck', person_id: '1234' }],
            });

            const candidates = await findCastBackfillCandidates(sql, 100);

            expect(candidates.map((c) => c.media_id)).not.toContain(mediaId);
        });

        it('is NOT a candidate once the primary provider row carries a cast_synced_at marker', async () => {
            const mediaId = await insertCandidateItem({
                title: 'No Cast At Provider',
                tmdbId: 475559,
            });
            // A fetch ran and found nothing — the marker must stop the re-ask loop
            // even though `actors`/`cast` are both still empty.
            await upsertProviderMetadataUnlessLocked(sql, mediaId, 'tmdb', {
                cast_synced_at: new Date().toISOString(),
            });

            const candidates = await findCastBackfillCandidates(sql, 100);

            expect(candidates.map((c) => c.media_id)).not.toContain(mediaId);
        });

        it('excludes catalog-only rows without local files', async () => {
            const mediaId = await insertCandidateItem({
                title: 'Catalog Only',
                tmdbId: 475560,
                hasFiles: false,
            });
            await upsertProviderMetadataUnlessLocked(sql, mediaId, 'tmdb', {
                actors: ['Someone'],
            });

            const candidates = await findCastBackfillCandidates(sql, 100);

            expect(candidates.map((c) => c.media_id)).not.toContain(mediaId);
        });

        // C3 (2026-09-24 security review): a locked item must never enter
        // touchedIds/syncedMediaIds, since that would feed a later
        // batchAggregateMetadata rebuild of its 'aggregated' row too.
        it('excludes a metadata_locked item that would otherwise be a candidate', async () => {
            const mediaId = await insertCandidateItem({
                title: 'Locked Candidate',
                tmdbId: 475561,
            });
            await upsertProviderMetadataUnlessLocked(sql, mediaId, 'tmdb', {
                actors: ['Someone Locked'],
            });
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${mediaId}`;

            const candidates = await findCastBackfillCandidates(sql, 100);

            expect(candidates.map((c) => c.media_id)).not.toContain(mediaId);
        });

        it('control: an unlocked item with the same shape IS a candidate', async () => {
            const mediaId = await insertCandidateItem({
                title: 'Unlocked Candidate',
                tmdbId: 475562,
            });
            await upsertProviderMetadataUnlessLocked(sql, mediaId, 'tmdb', {
                actors: ['Someone Unlocked'],
            });
            // Not locked.

            const candidates = await findCastBackfillCandidates(sql, 100);

            expect(candidates.map((c) => c.media_id)).toContain(mediaId);
        });
    });
    // ==========================================================================
    // findCastAggregationGaps — source row has cast, aggregated row lacks it
    // ==========================================================================

    describe('findCastAggregationGaps', () => {
        const CAST = [{ name: 'Jules Fenwick', character: 'Arthur Fleck', person_id: '73421' }];

        async function movie(title: string, tmdbId: number): Promise<string> {
            const item = createTestMediaItem({ media_type: 'movie', title, has_files: true });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, { tmdbId, mediaType: 'movie' }),
            );
            return item.id;
        }

        it('finds an item whose tmdb row has cast but whose aggregated row does not', async () => {
            const gap = await movie('Jasper', 475557);
            await upsertProviderMetadataUnlessLocked(sql, gap, 'tmdb', {
                cast: CAST,
                actors: ['Jules Fenwick'],
            });
            await upsertProviderMetadataUnlessLocked(sql, gap, 'aggregated', {
                actors: ['Jules Fenwick'],
            });

            const healthy = await movie('John Wick', 245891);
            await upsertProviderMetadataUnlessLocked(sql, healthy, 'tmdb', { cast: CAST });
            await upsertProviderMetadataUnlessLocked(sql, healthy, 'aggregated', { cast: CAST });

            const noCast = await movie('Fuze', 1);
            await upsertProviderMetadataUnlessLocked(sql, noCast, 'tmdb', { actors: [] });

            const ids = await findCastAggregationGaps(sql, 100);
            expect(ids).toContain(gap);
            expect(ids).not.toContain(healthy);
            expect(ids).not.toContain(noCast);
        });

        // C3 (2026-09-24 security review): a locked item's gap must not surface -
        // its sole caller feeds the result into batchAggregateMetadata, which
        // already skips locked ids itself; filtering here is just the cheaper fix.
        it('excludes a metadata_locked item that would otherwise be a gap', async () => {
            const lockedGap = await movie('Locked Gap', 475563);
            await upsertProviderMetadataUnlessLocked(sql, lockedGap, 'tmdb', {
                cast: CAST,
                actors: ['Jules Fenwick'],
            });
            await upsertProviderMetadataUnlessLocked(sql, lockedGap, 'aggregated', {
                actors: ['Jules Fenwick'],
            });
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${lockedGap}`;

            const ids = await findCastAggregationGaps(sql, 100);
            expect(ids).not.toContain(lockedGap);
        });
    });

    // ==========================================================================
    // upsertMdblistMetadata — background mdblist-sync writer (C3, 2026-09-24
    // security review). No admin-force caller exists for this function (grep
    // confirms mdblist-sync.ts is the only caller) — background-only, so there
    // is no `force` parameter/bypass to test here.
    // ==========================================================================

    describe('upsertMdblistMetadata', () => {
        async function movieWithTmdbId(title: string, tmdbId: number): Promise<string> {
            const item = createTestMediaItem({ media_type: 'movie', title, has_files: true });
            await insertTestMediaItem(sql, item);
            await insertTestExternalIds(
                sql,
                createTestExternalIds(item.id, { tmdbId, mediaType: 'movie' }),
            );
            return item.id;
        }

        it('does NOT write the mdblist row for a metadata_locked item, but still resolves its media_id', async () => {
            const { upsertMdblistMetadata } = await import('./ai-sync.queries.js');
            const mediaId = await movieWithTmdbId('Locked Mdblist Target', 475570);
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${mediaId}`;

            const result = await upsertMdblistMetadata(sql, 475570, 'movie', { rating: 8.5 });

            // Resolved (not null) so mdblist-sync.ts doesn't mistake "matched but
            // locked" for "no media item carries this id" and tombstone coverage.
            expect(result.mediaId).toBe(mediaId);
            expect(result.wrote).toBe(false);
            const [pm] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${mediaId} AND provider = 'mdblist'`;
            expect(pm).toBeUndefined();
        });

        it('control: DOES write the mdblist row for an unlocked item', async () => {
            const { upsertMdblistMetadata } = await import('./ai-sync.queries.js');
            const mediaId = await movieWithTmdbId('Unlocked Mdblist Target', 475571);

            const result = await upsertMdblistMetadata(sql, 475571, 'movie', { rating: 8.5 });

            expect(result.mediaId).toBe(mediaId);
            expect(result.wrote).toBe(true);
            const [pm] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${mediaId} AND provider = 'mdblist'`;
            expect(pm.metadata.rating).toBe(8.5);
        });

        it('returns a null mediaId and wrote:false when no media item matches the given tmdb id', async () => {
            const { upsertMdblistMetadata } = await import('./ai-sync.queries.js');

            const result = await upsertMdblistMetadata(sql, 999999999, 'movie', {
                rating: 1,
            });

            expect(result.mediaId).toBeNull();
            expect(result.wrote).toBe(false);
        });
    });
});
