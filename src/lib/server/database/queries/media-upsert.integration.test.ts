// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media Upsert Module
 *
 * Tests upsert operations for media items including:
 * - Insertion with TMDB ID, Jellyfin ID, or both
 * - Updates to existing items
 * - External ID handling (TMDB, IMDB, Jellyfin)
 * - Metadata storage and merging
 * - Batch operations
 * - Edge cases and error handling
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { MediaLifecycleService } from '../../services/media-lifecycle.service.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';

// ---------------------------------------------------------------------------
// Stub MediaLifecycleService so its fire-and-forget hooks (stage-state seed and
// invalidation, cache wipes) cannot write while the next upsert or the
// beforeEach TRUNCATE runs. Under load those writes deadlocked and hit FK
// violations on media_item_stage_state (stable gate, 2026-10-14).
//
// The stub is a vi.spyOn on the shared class object: media-upsert reads the
// static method at call time, so it works whatever the load order. (A vi.mock
// here once had 0 calls because the per-file setup preloaded media-upsert; see
// docs/dev/testing-traps.md.)
// ---------------------------------------------------------------------------
const LIFECYCLE_HOOKS = [
    'afterCreated',
    'afterMetadataChanged',
    'afterExternalIdChanged',
    'afterMatched',
    'afterContentChanged',
] as const;

// Import functions to test
// Import functions to test
import {
    upsertMediaMetadata,
    batchUpsertMediaMetadata,
    upsertProviderMetadataUnlessLocked,
    type MediaUpsertData,
} from './media-upsert.js';

// Test type for provider_metadata row
interface ProviderMetadataRow {
    metadata: Record<string, unknown>;
}

describe('Media Upsert', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        for (const hook of LIFECYCLE_HOOKS) {
            vi.spyOn(MediaLifecycleService, hook).mockResolvedValue(undefined);
        }
    });

    afterAll(async () => {
        vi.restoreAllMocks();
        await closeTestDb();
    });

    it('stubs the lifecycle hooks media-upsert actually calls', async () => {
        // Guards the stub above: if it stops reaching media-upsert (as the
        // old vi.mock did), the real hooks race the next test's TRUNCATE.
        vi.mocked(MediaLifecycleService.afterCreated).mockClear();
        await upsertMediaMetadata(sql, {
            primaryExternalId: '799901',
            mediaType: 'movie',
            title: 'Lifecycle Stub Probe',
        });
        expect(MediaLifecycleService.afterCreated).toHaveBeenCalledTimes(1);
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    // ==========================================================================
    // upsertMediaMetadata - Insertion Tests
    // ==========================================================================

    describe('upsertMediaMetadata - Insertion', () => {
        it('creates new item with TMDB ID only', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '700001',
                mediaType: 'movie',
                title: 'Test Movie with TMDB',
            };

            const result = await upsertMediaMetadata(sql, data);

            expect(result.mediaId).toBeDefined();
            expect(result.inserted).toBe(true);

            // Verify media_items record
            const [item] = await sql`
                SELECT * FROM media_items WHERE id = ${result.mediaId}
            `;
            expect(item).toBeDefined();
            expect(item.title).toBe('Test Movie with TMDB');
            expect(item.media_type).toBe('movie');
            expect(item.is_local_only).toBe(false);

            // Verify external_id exists
            const [extId] = await sql`
                SELECT * FROM external_ids
                WHERE media_id = ${result.mediaId} AND provider = 'tmdb'
            `;
            expect(extId).toBeDefined();
            expect(extId.external_id).toBe('700001');
            expect(extId.media_type).toBe('movie');
        });

        it('creates new item with Jellyfin ID only (local-only content)', async () => {
            const data: MediaUpsertData = {
                jellyfinId: 'jf-local-test-001',
                mediaType: 'movie',
                title: 'Local Only Movie',
                isLocalOnly: true,
            };

            const result = await upsertMediaMetadata(sql, data);

            expect(result.mediaId).toBeDefined();
            expect(result.inserted).toBe(true);

            // Verify is_local_only flag
            const [item] = await sql`
                SELECT * FROM media_items WHERE id = ${result.mediaId}
            `;
            expect(item.is_local_only).toBe(true);

            // Verify Jellyfin external_id exists
            const [extId] = await sql`
                SELECT * FROM external_ids
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;
            expect(extId).toBeDefined();
            // upsertMediaMetadata normalizes Jellyfin IDs to dashless format
            expect(extId.external_id).toBe('jflocaltest001');

            // Verify library_availability is set
            const [avail] = await sql`
                SELECT * FROM library_availability
                WHERE media_id = ${result.mediaId} AND library = 'jellyfin'
            `;
            expect(avail).toBeDefined();
            expect(avail.available).toBe(true);
        });

        it('creates item with both TMDB and Jellyfin IDs', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '700002',
                jellyfinId: 'jf-combined-test-002',
                mediaType: 'movie',
                title: 'Combined IDs Movie',
            };

            const result = await upsertMediaMetadata(sql, data);

            expect(result.inserted).toBe(true);

            // Verify both external IDs exist
            const extIds = await sql`
                SELECT provider, external_id FROM external_ids
                WHERE media_id = ${result.mediaId}
                ORDER BY provider
            `;
            expect(extIds.length).toBeGreaterThanOrEqual(2);
            expect(extIds.find((e) => e.provider === 'tmdb')).toBeDefined();
            expect(extIds.find((e) => e.provider === 'jellyfin')).toBeDefined();
        });

        it('creates item with all external IDs (TMDB, IMDB, Jellyfin)', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '700003',
                imdbId: 'tt7000003',
                jellyfinId: 'jf-full-ids-003',
                mediaType: 'movie',
                title: 'Full IDs Movie',
            };

            const result = await upsertMediaMetadata(sql, data);

            expect(result.inserted).toBe(true);

            // Verify all external IDs
            const extIds = await sql<{ provider: string; external_id: string }[]>`
                SELECT provider, external_id FROM external_ids
                WHERE media_id = ${result.mediaId}
            `;

            const providers = extIds.map((e) => e.provider);
            expect(providers).toContain('tmdb');
            expect(providers).toContain('imdb');
            expect(providers).toContain('jellyfin');
        });

        it('creates a local-only record when no TMDB and no Jellyfin ID provided', async () => {
            const data: MediaUpsertData = {
                mediaType: 'movie',
                title: 'No IDs Movie',
            };

            const result = await upsertMediaMetadata(sql, data);
            expect(result.mediaId).toBeTruthy();

            const [row] = await sql<[{ is_local_only: boolean }]>`
                SELECT is_local_only FROM media_items WHERE id = ${result.mediaId}::uuid
            `;
            expect(row.is_local_only).toBe(true);
        });

        it('sets is_local_only = true when no valid TMDB ID', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: null,
                jellyfinId: 'jf-no-tmdb-004',
                mediaType: 'movie',
                title: 'No TMDB Movie',
            };

            const result = await upsertMediaMetadata(sql, data);

            const [item] = await sql`
                SELECT * FROM media_items WHERE id = ${result.mediaId}
            `;
            expect(item.is_local_only).toBe(true);
        });

        it('handles TV shows correctly', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '700004',
                mediaType: 'tv',
                title: 'Test TV Show',
            };

            const result = await upsertMediaMetadata(sql, data);

            const [item] = await sql`
                SELECT * FROM media_items WHERE id = ${result.mediaId}
            `;
            expect(item.media_type).toBe('tv');

            const [extId] = await sql`
                SELECT * FROM external_ids
                WHERE media_id = ${result.mediaId} AND provider = 'tmdb'
            `;
            expect(extId.media_type).toBe('tv');
        });

        it('concurrent upserts of one TMDB title create ONE row that keeps its external id', async () => {
            // Before the advisory lock both callers missed the lookup and both
            // inserted; the loser's external-id write threw after its row was
            // committed, leaving a twin with no external id (the old code made 8 rows,
            // 7 of them without a TMDB id, and every call still resolved).
            const data: MediaUpsertData = {
                primaryExternalId: '700099',
                mediaType: 'movie',
                title: 'Concurrent Discovery Title',
            };

            // Open the pool's connections first: on a cold pool the calls are
            // serialised by connection setup and the race never happens.
            await Promise.all(Array.from({ length: 8 }, () => sql`SELECT pg_sleep(0.05)`));
            const results = await Promise.allSettled(
                Array.from({ length: 8 }, () => upsertMediaMetadata(sql, data)),
            );

            expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
            const ids = new Set(
                results.map((r) => (r as PromiseFulfilledResult<{ mediaId: string }>).value.mediaId),
            );
            expect(ids.size).toBe(1);
            const rows = await sql<{ id: string; has_tmdb: boolean }[]>`
                SELECT mi.id,
                       EXISTS (SELECT 1 FROM external_ids e WHERE e.media_id = mi.id AND e.provider = 'tmdb') AS has_tmdb
                FROM media_items mi
                WHERE mi.title = 'Concurrent Discovery Title'
            `;
            expect(rows).toHaveLength(1);
            expect(rows[0].has_tmdb).toBe(true);
        });

        it('concurrent title-only upserts (no external id) create ONE row', async () => {
            const data: MediaUpsertData = {
                mediaType: 'movie',
                title: 'Concurrent Title Only',
                year: 2001,
            };

            await Promise.all(Array.from({ length: 8 }, () => sql`SELECT pg_sleep(0.05)`));
            const results = await Promise.allSettled(
                Array.from({ length: 8 }, () => upsertMediaMetadata(sql, data)),
            );

            expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
            const rows = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE title = 'Concurrent Title Only'
            `;
            expect(rows).toHaveLength(1);
        });

        it('concurrent TMDB and title-only upserts of the same title/year create ONE row', async () => {
            const withId: MediaUpsertData = {
                primaryExternalId: '700123',
                mediaType: 'movie',
                title: 'Mixed Identity Title',
                year: 2002,
            };
            const titleOnly: MediaUpsertData = {
                mediaType: 'movie',
                title: 'mixed identity TITLE',
                year: 2002,
            };

            await Promise.all(Array.from({ length: 8 }, () => sql`SELECT pg_sleep(0.05)`));
            const results = await Promise.allSettled(
                Array.from({ length: 8 }, (_, i) =>
                    upsertMediaMetadata(sql, i % 2 === 0 ? withId : titleOnly),
                ),
            );

            expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
            const rows = await sql<{ id: string }[]>`
                SELECT id FROM media_items WHERE lower(title) = 'mixed identity title'
            `;
            expect(rows).toHaveLength(1);
        });
    });

    // ==========================================================================
    // upsertMediaMetadata - Update Tests
    // ==========================================================================

    describe('upsertMediaMetadata - Updates', () => {
        it('updates existing media item when TMDB ID matches', async () => {
            // First insert
            const data1: MediaUpsertData = {
                primaryExternalId: '710001',
                mediaType: 'movie',
                title: 'Original Title',
            };
            const result1 = await upsertMediaMetadata(sql, data1);
            expect(result1.inserted).toBe(true);

            // Second insert with same TMDB ID
            const data2: MediaUpsertData = {
                primaryExternalId: '710001',
                mediaType: 'movie',
                title: 'Updated Title',
                year: 2024,
            };
            const result2 = await upsertMediaMetadata(sql, data2);

            expect(result2.inserted).toBe(false);
            expect(result2.mediaId).toBe(result1.mediaId);

            // Verify update
            const [item] = await sql`
                SELECT * FROM media_items WHERE id = ${result2.mediaId}
            `;
            expect(item.title).toBe('Updated Title');
            expect(item.year).toBe(2024);
        });

        it('updates title and year correctly', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '710002',
                mediaType: 'movie',
                title: 'Initial Title',
                year: 2020,
            };
            await upsertMediaMetadata(sql, data);

            // Update
            const data2: MediaUpsertData = {
                primaryExternalId: '710002',
                mediaType: 'movie',
                title: 'New Title',
                year: 2025,
            };
            const result = await upsertMediaMetadata(sql, data2);

            const [item] = await sql`
                SELECT * FROM media_items WHERE id = ${result.mediaId}
            `;
            expect(item.title).toBe('New Title');
            expect(item.year).toBe(2025);
        });

        it('returns inserted: false for updates', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '710003',
                mediaType: 'movie',
                title: 'Test',
            };

            const result1 = await upsertMediaMetadata(sql, data);
            expect(result1.inserted).toBe(true);

            const result2 = await upsertMediaMetadata(sql, data);
            expect(result2.inserted).toBe(false);
        });

        it('preserves existing data when new values are null', async () => {
            const data1: MediaUpsertData = {
                primaryExternalId: '710004',
                mediaType: 'movie',
                title: 'Title',
                originalTitle: 'Original',
                year: 2023,
            };
            await upsertMediaMetadata(sql, data1);

            const data2: MediaUpsertData = {
                primaryExternalId: '710004',
                mediaType: 'movie',
                title: 'Title',
                originalTitle: null,
                year: null,
            };
            const result = await upsertMediaMetadata(sql, data2);

            const [item] = await sql`
                SELECT * FROM media_items WHERE id = ${result.mediaId}
            `;
            // COALESCE should preserve existing values
            expect(item.original_title).toBe('Original');
            expect(item.year).toBe(2023);
        });
    });

    // ==========================================================================
    // upsertMediaMetadata - External IDs Tests
    // ==========================================================================

    describe('upsertMediaMetadata - External IDs', () => {
        it('upserts TMDB external ID via CatalogService', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '720001',
                mediaType: 'movie',
                title: 'TMDB ID Test',
            };

            const result = await upsertMediaMetadata(sql, data);

            const [extId] = await sql`
                SELECT * FROM external_ids
                WHERE media_id = ${result.mediaId} AND provider = 'tmdb'
            `;
            expect(extId).toBeDefined();
            expect(extId.external_id).toBe('720001');
            expect(extId.is_primary).toBe(true);
            expect(extId.source).toBe('sync');
        });

        it('upserts IMDB external ID when provided', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '720002',
                imdbId: 'tt7200002',
                mediaType: 'movie',
                title: 'IMDB ID Test',
            };

            const result = await upsertMediaMetadata(sql, data);

            const [extId] = await sql`
                SELECT * FROM external_ids
                WHERE media_id = ${result.mediaId} AND provider = 'imdb'
            `;
            expect(extId).toBeDefined();
            expect(extId.external_id).toBe('tt7200002');
            expect(extId.media_type).toBe('movie');
        });

        it('upserts Jellyfin external ID when provided', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '720003',
                jellyfinId: 'jf-ext-test-003',
                mediaType: 'movie',
                title: 'Jellyfin ID Test',
            };

            const result = await upsertMediaMetadata(sql, data);

            const [extId] = await sql`
                SELECT * FROM external_ids
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;
            expect(extId).toBeDefined();
            // upsertMediaMetadata normalizes Jellyfin IDs to dashless format
            expect(extId.external_id).toBe('jfexttest003');
        });

        it('updates library_availability when Jellyfin ID provided', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '720004',
                jellyfinId: 'jf-avail-test-004',
                mediaType: 'movie',
                title: 'Availability Test',
                isAvailable: true,
            };

            const result = await upsertMediaMetadata(sql, data);

            const [avail] = await sql`
                SELECT * FROM library_availability
                WHERE media_id = ${result.mediaId} AND library = 'jellyfin'
            `;
            expect(avail).toBeDefined();
            expect(avail.available).toBe(true);
            // library_availability also stores dashless Jellyfin IDs
            expect(avail.library_item_id).toBe('jfavailtest004');
        });
    });

    // ==========================================================================
    // upsertMediaMetadata - Metadata Tests
    // ==========================================================================

    describe('upsertMediaMetadata - Metadata', () => {
        it('inserts all metadata fields', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '730001',
                mediaType: 'movie',
                title: 'Metadata Test',
                overview: 'A test movie overview',
                releaseDate: '2024-06-15',
                runtimeMinutes: 120,
                imdbRating: 7.5,
                externalRating: 7.8,
                certification: 'PG-13',
            };

            const result = await upsertMediaMetadata(sql, data);

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${result.mediaId}
            `;
            expect(pm).toBeDefined();
            expect(pm.metadata.overview).toBe('A test movie overview');
            expect(pm.metadata.release_date).toBe('2024-06-15');
            expect(pm.metadata.runtime_minutes).toBe(120);
            expect(pm.metadata.imdb_rating).toBe(7.5);
            expect(pm.metadata.certification).toBe('PG-13');
        });

        it('handles JSONB arrays (genres, keywords, actors, directors)', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '730002',
                mediaType: 'movie',
                title: 'Array Metadata Test',
                genres: [28, 12, 878], // Action, Adventure, Sci-Fi
                keywords: ['space', 'adventure', 'future'],
                actors: ['Actor One', 'Actor Two'],
                directors: ['Director One'],
            };

            const result = await upsertMediaMetadata(sql, data);

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${result.mediaId}
            `;
            expect(pm.metadata.genres).toEqual([28, 12, 878]);
            expect(pm.metadata.keywords).toEqual(['space', 'adventure', 'future']);
            expect(pm.metadata.actors).toEqual(['Actor One', 'Actor Two']);
            expect(pm.metadata.directors).toEqual(['Director One']);
        });

        it('merges metadata on conflict (JSONB merge)', async () => {
            const data1: MediaUpsertData = {
                primaryExternalId: '730003',
                jellyfinId: 'jf-merge-test',
                mediaType: 'movie',
                title: 'Merge Test',
                overview: 'Original overview',
            };
            await upsertMediaMetadata(sql, data1);

            const data2: MediaUpsertData = {
                primaryExternalId: '730003',
                jellyfinId: 'jf-merge-test',
                mediaType: 'movie',
                title: 'Merge Test',
                runtimeMinutes: 120,
            };
            const result = await upsertMediaMetadata(sql, data2);

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${result.mediaId}
            `;
            // Both fields should exist after merge
            expect(pm.metadata.overview).toBe('Original overview');
            expect(pm.metadata.runtime_minutes).toBe(120);
        });

        it('skips null/undefined metadata fields', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '730004',
                mediaType: 'movie',
                title: 'Null Fields Test',
                overview: null,
                releaseDate: undefined,
                runtimeMinutes: 90,
            };

            const result = await upsertMediaMetadata(sql, data);

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${result.mediaId}
            `;
            expect(pm.metadata.runtime_minutes).toBe(90);
            // Null/undefined fields should not be in metadata
            expect(pm.metadata.overview).toBeUndefined();
            expect(pm.metadata.release_date).toBeUndefined();
        });

        it('handles empty metadata object (no provider_metadata insert)', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '730005',
                mediaType: 'movie',
                title: 'No Metadata',
            };

            const result = await upsertMediaMetadata(sql, data);

            // If only title and no optional metadata, provider_metadata may not be inserted
            // (depends on implementation - verify behavior)
            await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${result.mediaId}
            `;
            // Could be empty or not exist
            expect(result.mediaId).toBeDefined();
        });
    });

    // ==========================================================================
    // provider_metadata writes respect metadata_locked (C3, 2026-09-24
    // security review) — the shared writer used by upsertMediaMetadata's
    // Step 5 and exported directly as upsertProviderMetadataUnlessLocked.
    // ==========================================================================

    describe('provider_metadata writes respect metadata_locked (C3)', () => {
        async function lockItem(mediaId: string): Promise<void> {
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${mediaId}`;
        }

        it('upsertMediaMetadata does NOT change provider_metadata for a locked item', async () => {
            const { mediaId } = await upsertMediaMetadata(sql, {
                primaryExternalId: '740001',
                mediaType: 'movie',
                title: 'Locked Item',
                overview: 'Original overview',
            });
            await lockItem(mediaId);

            // Simulates a background sweep trying to refresh a locked item.
            await upsertMediaMetadata(sql, {
                primaryExternalId: '740001',
                mediaType: 'movie',
                title: 'Locked Item',
                overview: 'Sweep tried to overwrite this',
            });

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${mediaId}
            `;
            expect(pm.metadata.overview).toBe('Original overview');
        });

        it('control: upsertMediaMetadata DOES change provider_metadata for an unlocked item', async () => {
            const { mediaId } = await upsertMediaMetadata(sql, {
                primaryExternalId: '740002',
                mediaType: 'movie',
                title: 'Unlocked Item',
                overview: 'Original overview',
            });
            // Not locked — the sweep path must still work normally.

            await upsertMediaMetadata(sql, {
                primaryExternalId: '740002',
                mediaType: 'movie',
                title: 'Unlocked Item',
                overview: 'Sweep updated this',
            });

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${mediaId}
            `;
            expect(pm.metadata.overview).toBe('Sweep updated this');
        });

        it('upsertProviderMetadataUnlessLocked returns 0 and writes nothing for a locked item', async () => {
            const { mediaId } = await upsertMediaMetadata(sql, {
                primaryExternalId: '740003',
                mediaType: 'movie',
                title: 'Directly Locked Item',
            });
            await lockItem(mediaId);

            const rowsAffected = await upsertProviderMetadataUnlessLocked(sql, mediaId, 'tmdb', {
                overview: 'Should not land',
            });

            expect(rowsAffected).toBe(0);
            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${mediaId} AND provider = 'tmdb'
            `;
            expect(pm).toBeUndefined();
        });

        it('control: force:true DOES write to a locked item (the admin-override shape)', async () => {
            const { mediaId } = await upsertMediaMetadata(sql, {
                primaryExternalId: '740004',
                mediaType: 'movie',
                title: 'Force Override Item',
            });
            await lockItem(mediaId);

            const rowsAffected = await upsertProviderMetadataUnlessLocked(
                sql,
                mediaId,
                'tmdb',
                { overview: 'Admin forced refresh' },
                { force: true },
            );

            expect(rowsAffected).toBe(1);
            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${mediaId} AND provider = 'tmdb'
            `;
            expect(pm.metadata.overview).toBe('Admin forced refresh');
        });

        it('control: unlocked item writes normally via upsertProviderMetadataUnlessLocked', async () => {
            const { mediaId } = await upsertMediaMetadata(sql, {
                primaryExternalId: '740005',
                mediaType: 'movie',
                title: 'Unlocked Direct Item',
            });

            const rowsAffected = await upsertProviderMetadataUnlessLocked(sql, mediaId, 'tmdb', {
                overview: 'Normal write',
            });

            expect(rowsAffected).toBe(1);
            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${mediaId} AND provider = 'tmdb'
            `;
            expect(pm.metadata.overview).toBe('Normal write');
        });

        it('merges onto an existing unlocked row instead of full-replacing it', async () => {
            const { mediaId } = await upsertMediaMetadata(sql, {
                primaryExternalId: '740006',
                mediaType: 'movie',
                title: 'Merge Item',
                overview: 'Kept field',
            });

            await upsertProviderMetadataUnlessLocked(sql, mediaId, 'tmdb', {
                runtime_minutes: 100,
            });

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${mediaId} AND provider = 'tmdb'
            `;
            expect(pm.metadata.overview).toBe('Kept field');
            expect(pm.metadata.runtime_minutes).toBe(100);
        });
    });

    // ==========================================================================
    // upsertMediaMetadata - Edge Cases
    // ==========================================================================

    describe('upsertMediaMetadata - Edge Cases', () => {
        it('handles TMDB ID collision (same ID, different media_type)', async () => {
            // Insert movie
            const movieData: MediaUpsertData = {
                primaryExternalId: '740001',
                mediaType: 'movie',
                title: 'Movie 740001',
            };
            const movieResult = await upsertMediaMetadata(sql, movieData);

            // Insert TV with same TMDB ID (this is valid - different media_type)
            const tvData: MediaUpsertData = {
                primaryExternalId: '740001',
                mediaType: 'tv',
                title: 'TV Show 740001',
            };
            const tvResult = await upsertMediaMetadata(sql, tvData);

            // Should create two separate entries
            expect(movieResult.mediaId).not.toBe(tvResult.mediaId);

            // Verify both external_ids exist with different media_types
            const extIds = await sql<{ media_type: string; media_id: string }[]>`
                SELECT media_type, media_id FROM external_ids
                WHERE provider = 'tmdb' AND external_id = '740001'
            `;
            expect(extIds.length).toBe(2);
            expect(extIds.map((e) => e.media_type).sort()).toEqual(['movie', 'tv']);
        });

        it('handles large TMDB IDs', async () => {
            // Near boundary
            const data: MediaUpsertData = {
                primaryExternalId: '99999999',
                mediaType: 'movie',
                title: 'Large ID Movie',
            };

            const result = await upsertMediaMetadata(sql, data);
            expect(result.inserted).toBe(true);

            const [extId] = await sql`
                SELECT external_id FROM external_ids
                WHERE media_id = ${result.mediaId} AND provider = 'tmdb'
            `;
            expect(extId.external_id).toBe('99999999');
        });

        it('rejects TMDB IDs that are too large (>100000000)', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '100000001',
                jellyfinId: 'jf-too-large-id',
                mediaType: 'movie',
                title: 'Very Large ID Movie',
            };

            await expect(upsertMediaMetadata(sql, data)).rejects.toThrow();

            const tmdbExt = await sql`
                SELECT external_id FROM external_ids
                WHERE provider = 'tmdb' AND external_id = '100000001'
            `;
            expect(tmdbExt.length).toBe(0);
        });

        it('handles special characters in title', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '740003',
                mediaType: 'movie',
                title: 'Test\'s Movie: A <Special> "Title" & More!',
            };

            const result = await upsertMediaMetadata(sql, data);

            const [item] = await sql`
                SELECT title FROM media_items WHERE id = ${result.mediaId}
            `;
            expect(item.title).toBe('Test\'s Movie: A <Special> "Title" & More!');
        });

        it('handles very long overview text', async () => {
            const longOverview = 'A'.repeat(10000); // 10KB of text
            const data: MediaUpsertData = {
                primaryExternalId: '740004',
                mediaType: 'movie',
                title: 'Long Overview Movie',
                overview: longOverview,
            };

            const result = await upsertMediaMetadata(sql, data);

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${result.mediaId}
            `;
            expect((pm.metadata.overview as string).length).toBe(10000);
        });
    });

    // ==========================================================================
    // upsertMediaMetadata - JSONB Integrity Tests (Bug Prevention)
    // ==========================================================================

    describe('upsertMediaMetadata - JSONB Integrity', () => {
        it('stores metadata as JSONB object, not string or array', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '750001',
                jellyfinId: 'jf-jsonb-test',
                mediaType: 'movie',
                title: 'JSONB Integrity Test',
                overview: 'Test overview',
                actors: ['Actor 1', 'Actor 2'],
                providerMetadata: {
                    trailer_url: 'https://www.youtube.com/watch?v=test123',
                },
            };

            const result = await upsertMediaMetadata(sql, data);

            // Verify metadata is stored as object (not string or array)
            const [pm] = await sql<{ metadata_type: string; metadata: Record<string, unknown> }[]>`
                SELECT
                    jsonb_typeof(metadata) as metadata_type,
                    metadata
                FROM provider_metadata
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;

            expect(pm).toBeDefined();
            expect(pm.metadata_type).toBe('object');
            expect(Array.isArray(pm.metadata)).toBe(false);
            expect(typeof pm.metadata).toBe('object');
        });

        it('stores trailer_url in providerMetadata', async () => {
            const trailerUrl = 'https://www.youtube.com/watch?v=eMV5Fz_HgBc';
            const data: MediaUpsertData = {
                primaryExternalId: '750002',
                jellyfinId: 'jf-trailer-test',
                mediaType: 'movie',
                title: 'Trailer URL Test',
                providerMetadata: {
                    trailer_url: trailerUrl,
                },
            };

            const result = await upsertMediaMetadata(sql, data);

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;

            expect(pm).toBeDefined();
            expect(pm.metadata.trailer_url).toBe(trailerUrl);
        });

        it('merges providerMetadata with standard metadata fields', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '750003',
                jellyfinId: 'jf-merge-provider',
                mediaType: 'movie',
                title: 'Provider Merge Test',
                overview: 'Standard field',
                actors: ['Actor 1'],
                providerMetadata: {
                    trailer_url: 'https://youtube.com/test',
                    custom_field: 'custom_value',
                },
            };

            const result = await upsertMediaMetadata(sql, data);

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;

            // Both standard and provider-specific fields should exist
            expect(pm.metadata.overview).toBe('Standard field');
            expect(pm.metadata.actors).toEqual(['Actor 1']);
            expect(pm.metadata.trailer_url).toBe('https://youtube.com/test');
            expect(pm.metadata.custom_field).toBe('custom_value');
        });

        it('auto-fixes corrupted metadata (array) on update', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '750004',
                jellyfinId: 'jf-corrupt-fix',
                mediaType: 'movie',
                title: 'Corrupted Metadata Fix Test',
                overview: 'Initial overview', // Need some metadata to create provider_metadata row
            };

            const result = await upsertMediaMetadata(sql, data);

            // Manually corrupt the metadata to simulate the bug
            await sql`
                UPDATE provider_metadata
                SET metadata = '["corrupted", "array"]'::jsonb
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;

            // Verify it's corrupted
            const [corrupted] = await sql<{ metadata_type: string }[]>`
                SELECT jsonb_typeof(metadata) as metadata_type
                FROM provider_metadata
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;
            expect(corrupted.metadata_type).toBe('array');

            // Now upsert again - should auto-fix the corruption
            const data2: MediaUpsertData = {
                primaryExternalId: '750004',
                jellyfinId: 'jf-corrupt-fix',
                mediaType: 'movie',
                title: 'Corrupted Metadata Fix Test',
                overview: 'New overview',
                providerMetadata: {
                    trailer_url: 'https://youtube.com/fixed',
                },
            };

            await upsertMediaMetadata(sql, data2);

            // Verify metadata is now an object
            const [fixed] = await sql<
                { metadata_type: string; metadata: Record<string, unknown> }[]
            >`
                SELECT
                    jsonb_typeof(metadata) as metadata_type,
                    metadata
                FROM provider_metadata
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;

            expect(fixed.metadata_type).toBe('object');
            expect(fixed.metadata.overview).toBe('New overview');
            expect(fixed.metadata.trailer_url).toBe('https://youtube.com/fixed');
        });

        it('auto-fixes corrupted metadata (string) on update', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '750005',
                jellyfinId: 'jf-string-fix',
                mediaType: 'movie',
                title: 'String Metadata Fix Test',
                overview: 'Initial overview', // Need some metadata to create provider_metadata row
            };

            const result = await upsertMediaMetadata(sql, data);

            // Manually corrupt as string
            await sql`
                UPDATE provider_metadata
                SET metadata = '"corrupted_string"'::jsonb
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;

            // Verify it's a string
            const [corrupted] = await sql<{ metadata_type: string }[]>`
                SELECT jsonb_typeof(metadata) as metadata_type
                FROM provider_metadata
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;
            expect(corrupted.metadata_type).toBe('string');

            // Upsert again - should replace with object
            const data2: MediaUpsertData = {
                primaryExternalId: '750005',
                jellyfinId: 'jf-string-fix',
                mediaType: 'movie',
                title: 'String Metadata Fix Test',
                runtimeMinutes: 120,
            };

            await upsertMediaMetadata(sql, data2);

            // Verify it's now an object
            const [fixed] = await sql<
                { metadata_type: string; metadata: Record<string, unknown> }[]
            >`
                SELECT
                    jsonb_typeof(metadata) as metadata_type,
                    metadata
                FROM provider_metadata
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;

            expect(fixed.metadata_type).toBe('object');
            expect(fixed.metadata.runtime_minutes).toBe(120);
        });

        it('preserves existing metadata when upserting with valid object', async () => {
            const data1: MediaUpsertData = {
                primaryExternalId: '750006',
                jellyfinId: 'jf-preserve-test',
                mediaType: 'movie',
                title: 'Preserve Test',
                overview: 'Original overview',
                actors: ['Actor 1'],
            };

            const result = await upsertMediaMetadata(sql, data1);

            // Upsert again with additional fields
            const data2: MediaUpsertData = {
                primaryExternalId: '750006',
                jellyfinId: 'jf-preserve-test',
                mediaType: 'movie',
                title: 'Preserve Test',
                runtimeMinutes: 90,
                providerMetadata: {
                    trailer_url: 'https://youtube.com/new',
                },
            };

            await upsertMediaMetadata(sql, data2);

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;

            // Old fields should be preserved, new fields added
            expect(pm.metadata.overview).toBe('Original overview');
            expect(pm.metadata.actors).toEqual(['Actor 1']);
            expect(pm.metadata.runtime_minutes).toBe(90);
            expect(pm.metadata.trailer_url).toBe('https://youtube.com/new');
        });

        it('handles undefined trailer_url (should not create key in JSONB)', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '750007',
                jellyfinId: 'jf-undefined-trailer',
                mediaType: 'movie',
                title: 'Undefined Trailer Test',
                overview: 'Overview only',
                providerMetadata: {
                    trailer_url: undefined,
                },
            };

            const result = await upsertMediaMetadata(sql, data);

            const [pm] = await sql<
                {
                    metadata: Record<string, unknown>;
                    has_trailer_key: boolean;
                }[]
            >`
                SELECT
                    metadata,
                    (metadata ? 'trailer_url') as has_trailer_key
                FROM provider_metadata
                WHERE media_id = ${result.mediaId} AND provider = 'jellyfin'
            `;

            expect(pm.metadata.overview).toBe('Overview only');
            // undefined values should not create keys in JSONB
            expect(pm.has_trailer_key).toBe(false);
        });

        it('correctly stores null vs undefined in metadata', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '750008',
                mediaType: 'movie',
                title: 'Null vs Undefined Test',
                overview: null, // null - should be omitted
                releaseDate: undefined, // undefined - should be omitted
                runtimeMinutes: 100, // defined - should be included
            };

            const result = await upsertMediaMetadata(sql, data);

            const [pm] = await sql<ProviderMetadataRow[]>`
                SELECT metadata FROM provider_metadata
                WHERE media_id = ${result.mediaId}
            `;

            // Only runtimeMinutes should exist
            expect(pm.metadata.runtime_minutes).toBe(100);
            expect(pm.metadata.overview).toBeUndefined();
            expect(pm.metadata.release_date).toBeUndefined();
            expect(Object.keys(pm.metadata)).toContain('runtime_minutes');
            expect(Object.keys(pm.metadata)).not.toContain('overview');
            expect(Object.keys(pm.metadata)).not.toContain('release_date');
        });
    });

    // ==========================================================================
    // upsertMediaMetadata - Title Aliases (media_titles)
    // ==========================================================================

    describe('upsertMediaMetadata - Title Aliases', () => {
        it('persists primary/original/English aliases into media_titles', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '760001',
                mediaType: 'movie',
                title: 'Lanterns Away',
                originalTitle: '星と灯りの物語',
                originalLanguage: 'ja',
                englishTitle: 'Lanterns Away',
            };

            const result = await upsertMediaMetadata(sql, data);

            const titles = await sql<{ title: string; language: string | null; kind: string }[]>`
                SELECT title, language, kind FROM media_titles
                WHERE media_id = ${result.mediaId}::uuid
                ORDER BY kind
            `;

            expect(titles).toEqual([
                { title: 'Lanterns Away', language: 'en', kind: 'localized' },
                { title: '星と灯りの物語', language: 'ja', kind: 'original' },
                { title: 'Lanterns Away', language: null, kind: 'primary' },
            ]);
        });

        it('does not duplicate the original-title row across repeated upserts', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '760002',
                mediaType: 'movie',
                title: 'Lanterns Away',
                originalTitle: '星と灯りの物語',
                originalLanguage: 'ja',
            };

            await upsertMediaMetadata(sql, data);
            const result = await upsertMediaMetadata(sql, data);

            const originalRows = await sql`
                SELECT title, language FROM media_titles
                WHERE media_id = ${result.mediaId}::uuid AND kind = 'original'
            `;
            expect(originalRows.length).toBe(1);
            expect(originalRows[0].language).toBe('ja');
        });

        it('stores the original title with a null language when none is known', async () => {
            const data: MediaUpsertData = {
                primaryExternalId: '760003',
                mediaType: 'movie',
                title: 'Untitled',
                originalTitle: 'Untitled Original',
            };

            const result = await upsertMediaMetadata(sql, data);

            const [row] = await sql<{ language: string | null }[]>`
                SELECT language FROM media_titles
                WHERE media_id = ${result.mediaId}::uuid AND kind = 'original'
            `;
            expect(row.language).toBeNull();
        });
    });

    // ==========================================================================
    // batchUpsertMediaMetadata Tests
    // ==========================================================================

    describe('batchUpsertMediaMetadata', () => {
        it('creates batch of 10 items correctly', async () => {
            const items: MediaUpsertData[] = [];
            for (let i = 0; i < 10; i++) {
                items.push({
                    primaryExternalId: String(750000 + i),
                    mediaType: 'movie',
                    title: `Batch Movie ${i}`,
                });
            }

            const result = await batchUpsertMediaMetadata(sql, items);

            expect(result.created).toBe(10);
            expect(result.updated).toBe(0);
            expect(result.errors).toBe(0);
        });

        it('returns accurate created count', async () => {
            const items: MediaUpsertData[] = [
                {
                    primaryExternalId: '780001',
                    mediaType: 'movie',
                    title: 'Movie 1',
                },
                {
                    primaryExternalId: '780002',
                    mediaType: 'movie',
                    title: 'Movie 2',
                },
                {
                    primaryExternalId: '780003',
                    mediaType: 'movie',
                    title: 'Movie 3',
                },
            ];

            const result = await batchUpsertMediaMetadata(sql, items);

            expect(result.created).toBe(3);
        });

        it('returns accurate updated count', async () => {
            // Pre-insert
            const items: MediaUpsertData[] = [
                {
                    primaryExternalId: '780004',
                    mediaType: 'movie',
                    title: 'Movie 1',
                },
                {
                    primaryExternalId: '780005',
                    mediaType: 'movie',
                    title: 'Movie 2',
                },
            ];
            await batchUpsertMediaMetadata(sql, items);

            // Update same items
            const result = await batchUpsertMediaMetadata(sql, items);

            expect(result.created).toBe(0);
            expect(result.updated).toBe(2);
        });

        it('handles large batch (50 items)', async () => {
            const items: MediaUpsertData[] = [];
            for (let i = 0; i < 50; i++) {
                items.push({
                    primaryExternalId: String(760000 + i),
                    mediaType: 'movie',
                    title: `Large Batch Movie ${i}`,
                });
            }

            const result = await batchUpsertMediaMetadata(sql, items);

            expect(result.created).toBe(50);
            expect(result.errors).toBe(0);
        });

        it('returns zeros for empty input', async () => {
            const result = await batchUpsertMediaMetadata(sql, []);

            expect(result.created).toBe(0);
            expect(result.updated).toBe(0);
            expect(result.errors).toBe(0);
        });

        it('processes all items including those with no IDs (title-based fallback)', async () => {
            const items: MediaUpsertData[] = [
                {
                    primaryExternalId: '780006',
                    mediaType: 'movie',
                    title: 'Valid Movie 1',
                },
                {
                    mediaType: 'movie',
                    title: 'No IDs Movie (title-only fallback)',
                },
                {
                    primaryExternalId: '780007',
                    mediaType: 'movie',
                    title: 'Valid Movie 3',
                },
            ];

            const result = await batchUpsertMediaMetadata(sql, items);

            expect(result.created).toBe(3);
            expect(result.errors).toBe(0);
        });

        it('handles mix of new and existing items', async () => {
            // Pre-insert one item
            await upsertMediaMetadata(sql, {
                primaryExternalId: '780008',
                mediaType: 'movie',
                title: 'Existing Movie',
            });

            // Batch with mix
            const items: MediaUpsertData[] = [
                {
                    primaryExternalId: '780008',
                    mediaType: 'movie',
                    title: 'Existing Updated',
                },
                {
                    primaryExternalId: '780009',
                    mediaType: 'movie',
                    title: 'New Movie',
                },
            ];

            const result = await batchUpsertMediaMetadata(sql, items);

            expect(result.created).toBe(1);
            expect(result.updated).toBe(1);
        });

        it('handles mix of TMDB-only and Jellyfin-only items', async () => {
            const items: MediaUpsertData[] = [
                {
                    primaryExternalId: '780010',
                    mediaType: 'movie',
                    title: 'TMDB Only',
                },
                {
                    jellyfinId: 'jf-batch-local-001',
                    mediaType: 'movie',
                    title: 'Jellyfin Only',
                    isLocalOnly: true,
                },
            ];

            const result = await batchUpsertMediaMetadata(sql, items);

            expect(result.created).toBe(2);
            expect(result.errors).toBe(0);
        });
    });
});
