// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * JSONB Integrity Integration Tests
 *
 * Prevents regression of the JSONB double-encoding bug (see docs/trailer-url-bug-fix.md).
 *
 * This bug caused metadata to be stored as JSONB strings/arrays instead of objects,
 * breaking queries like `metadata->>'trailer_url'`.
 *
 * These tests ensure:
 * 1. All provider_metadata records are stored as JSONB objects
 * 2. Corrupted metadata (arrays/strings) gets auto-fixed on update
 * 3. sql.json() is used correctly (not JSON.stringify() with ::jsonb)
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';

describe('JSONB Integrity - Bug Prevention', () => {
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

    // ==========================================================================
    // Direct JSONB Insertion Tests
    // ==========================================================================

    describe('Direct JSONB Insertion', () => {
        it('sql.json() stores objects correctly', async () => {
            const [mediaItem] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('Test Movie', 'movie')
                RETURNING id
            `;

            const metadata = {
                overview: 'Test overview',
                actors: ['Actor 1', 'Actor 2'],
                trailer_url: 'https://youtube.com/test',
            };

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'test', ${sql.json(metadata)})
            `;

            const [result] = await sql<
                { metadata_type: string; metadata: Record<string, unknown> }[]
            >`
                SELECT
                    jsonb_typeof(metadata) as metadata_type,
                    metadata
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;

            expect(result.metadata_type).toBe('object');
            expect(result.metadata.overview).toBe('Test overview');
            expect(result.metadata.actors).toEqual(['Actor 1', 'Actor 2']);
            expect(result.metadata.trailer_url).toBe('https://youtube.com/test');
        });

        it('rejects manual JSON.stringify() pattern (would cause bug)', async () => {
            const [mediaItem] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('Bug Test', 'movie')
                RETURNING id
            `;

            const metadata = { test: 'value' };
            const manualJson = JSON.stringify(metadata);

            // This is the OLD BROKEN pattern - inserting as string will fail the type check
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'test', ${manualJson}::jsonb)
            `;

            const [result] = await sql<{ metadata_type: string }[]>`
                SELECT jsonb_typeof(metadata) as metadata_type
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;

            // With postgres.js, ${string}::jsonb creates a JSONB string value, not object
            // This test documents the WRONG pattern to avoid
            expect(result.metadata_type).toBe('string');
        });

        it('handles empty object metadata correctly', async () => {
            const [mediaItem] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('Empty Metadata Test', 'movie')
                RETURNING id
            `;

            // Metadata column has NOT NULL constraint, so we use empty object instead of null
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'test', ${sql.json({})})
            `;

            const [result] = await sql<{ metadata_type: string }[]>`
                SELECT jsonb_typeof(metadata) as metadata_type
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;

            expect(result.metadata_type).toBe('object');
        });

        it('handles empty object correctly', async () => {
            const [mediaItem] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('Empty Test', 'movie')
                RETURNING id
            `;

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'test', ${sql.json({})})
            `;

            const [result] = await sql<{ metadata_type: string }[]>`
                SELECT jsonb_typeof(metadata) as metadata_type
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;

            expect(result.metadata_type).toBe('object');
        });
    });

    // ==========================================================================
    // Auto-Fixing Corrupted Metadata
    // ==========================================================================

    describe('Auto-Fixing Corrupted Metadata', () => {
        it('replaces corrupted array with object on conflict', async () => {
            const [mediaItem] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('Auto-Fix Array Test', 'movie')
                RETURNING id
            `;

            // Simulate corrupted array metadata (from old bug)
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'jellyfin', '["corrupted", "array"]'::jsonb)
            `;

            // Verify it's corrupted
            const [corrupted] = await sql<{ metadata_type: string }[]>`
                SELECT jsonb_typeof(metadata) as metadata_type
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;
            expect(corrupted.metadata_type).toBe('array');

            // Upsert with CASE statement that auto-fixes
            const newMetadata = {
                overview: 'Fixed',
                trailer_url: 'https://youtube.com/fixed',
            };
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'jellyfin', ${sql.json(newMetadata)})
                ON CONFLICT (media_id, provider) DO UPDATE SET
                    metadata = CASE
                        WHEN jsonb_typeof(provider_metadata.metadata) = 'object'
                        THEN provider_metadata.metadata || EXCLUDED.metadata
                        ELSE EXCLUDED.metadata
                    END
            `;

            // Verify it's fixed
            const [fixed] = await sql<
                { metadata_type: string; metadata: Record<string, unknown> }[]
            >`
                SELECT
                    jsonb_typeof(metadata) as metadata_type,
                    metadata
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;

            expect(fixed.metadata_type).toBe('object');
            expect(fixed.metadata.overview).toBe('Fixed');
            expect(fixed.metadata.trailer_url).toBe('https://youtube.com/fixed');
        });

        it('replaces corrupted string with object on conflict', async () => {
            const [mediaItem] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('Auto-Fix String Test', 'movie')
                RETURNING id
            `;

            // Simulate corrupted string metadata
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'jellyfin', '"corrupted_string"'::jsonb)
            `;

            const [corrupted] = await sql<{ metadata_type: string }[]>`
                SELECT jsonb_typeof(metadata) as metadata_type
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;
            expect(corrupted.metadata_type).toBe('string');

            // Auto-fix
            const newMetadata = { runtime_minutes: 120 };
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'jellyfin', ${sql.json(newMetadata)})
                ON CONFLICT (media_id, provider) DO UPDATE SET
                    metadata = CASE
                        WHEN jsonb_typeof(provider_metadata.metadata) = 'object'
                        THEN provider_metadata.metadata || EXCLUDED.metadata
                        ELSE EXCLUDED.metadata
                    END
            `;

            const [fixed] = await sql<
                { metadata_type: string; metadata: Record<string, unknown> }[]
            >`
                SELECT
                    jsonb_typeof(metadata) as metadata_type,
                    metadata
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;

            expect(fixed.metadata_type).toBe('object');
            expect(fixed.metadata.runtime_minutes).toBe(120);
        });

        it('merges valid objects correctly without corruption', async () => {
            const [mediaItem] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('Merge Test', 'movie')
                RETURNING id
            `;

            // Insert valid object
            const metadata1 = { overview: 'Original', actors: ['Actor 1'] };
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'jellyfin', ${sql.json(metadata1)})
            `;

            // Merge with new fields
            const metadata2 = {
                runtime_minutes: 90,
                trailer_url: 'https://youtube.com/new',
            };
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'jellyfin', ${sql.json(metadata2)})
                ON CONFLICT (media_id, provider) DO UPDATE SET
                    metadata = CASE
                        WHEN jsonb_typeof(provider_metadata.metadata) = 'object'
                        THEN provider_metadata.metadata || EXCLUDED.metadata
                        ELSE EXCLUDED.metadata
                    END
            `;

            const [result] = await sql<
                { metadata_type: string; metadata: Record<string, unknown> }[]
            >`
                SELECT
                    jsonb_typeof(metadata) as metadata_type,
                    metadata
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;

            // All fields should exist (merge successful)
            expect(result.metadata_type).toBe('object');
            expect(result.metadata.overview).toBe('Original');
            expect(result.metadata.actors).toEqual(['Actor 1']);
            expect(result.metadata.runtime_minutes).toBe(90);
            expect(result.metadata.trailer_url).toBe('https://youtube.com/new');
        });
    });

    // ==========================================================================
    // Database-Wide Metadata Integrity Check
    // ==========================================================================

    describe('Database-Wide Integrity Check', () => {
        it('ensures all provider_metadata records are objects', async () => {
            // Insert various records
            const [item1] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('Movie 1', 'movie')
                RETURNING id
            `;
            const [item2] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('TV 1', 'tv')
                RETURNING id
            `;

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES
                    (${item1.id}, 'jellyfin', ${sql.json({ overview: 'Test 1' })}),
                    (${item1.id}, 'tmdb', ${sql.json({ rating: 7.5 })}),
                    (${item2.id}, 'jellyfin', ${sql.json({ episodes: 10 })}),
                    (${item2.id}, 'aggregated', ${sql.json({ status: 'Ended' })})
            `;

            // Check all are objects
            const results = await sql<{ metadata_type: string; provider: string }[]>`
                SELECT provider, jsonb_typeof(metadata) as metadata_type
                FROM provider_metadata
                WHERE metadata IS NOT NULL
            `;

            expect(results.length).toBe(4);
            results.forEach((row) => {
                expect(row.metadata_type).toBe('object');
            });
        });

        it('detects any corrupted metadata in database', async () => {
            // This test would fail if there's corrupted data
            const corrupted = await sql<{ count: string }[]>`
                SELECT COUNT(*) as count
                FROM provider_metadata
                WHERE jsonb_typeof(metadata) != 'object'
                  AND metadata IS NOT NULL
            `;

            expect(Number(corrupted[0].count)).toBe(0);
        });
    });

    // ==========================================================================
    // Trailer URL Specific Tests
    // ==========================================================================

    describe('Trailer URL Storage', () => {
        it('stores trailer_url correctly as object field', async () => {
            const [mediaItem] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('Trailer Test', 'movie')
                RETURNING id
            `;

            const trailerUrl = 'https://www.youtube.com/watch?v=eMV5Fz_HgBc';
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'jellyfin', ${sql.json({ trailer_url: trailerUrl })})
            `;

            const [result] = await sql<{ trailer_url: string | null; has_key: boolean }[]>`
                SELECT
                    metadata->>'trailer_url' as trailer_url,
                    (metadata ? 'trailer_url') as has_key
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;

            expect(result.has_key).toBe(true);
            expect(result.trailer_url).toBe(trailerUrl);
        });

        it('merges trailer_url without losing other fields', async () => {
            const [mediaItem] = await sql`
                INSERT INTO media_items (title, media_type)
                VALUES ('Trailer Merge Test', 'movie')
                RETURNING id
            `;

            // First insert without trailer
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'jellyfin', ${sql.json({ overview: 'Overview', actors: ['Actor 1'] })})
            `;

            // Update with trailer
            const trailerUrl = 'https://youtube.com/new-trailer';
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${mediaItem.id}, 'jellyfin', ${sql.json({ trailer_url: trailerUrl })})
                ON CONFLICT (media_id, provider) DO UPDATE SET
                    metadata = CASE
                        WHEN jsonb_typeof(provider_metadata.metadata) = 'object'
                        THEN provider_metadata.metadata || EXCLUDED.metadata
                        ELSE EXCLUDED.metadata
                    END
            `;

            const [result] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata
                FROM provider_metadata
                WHERE media_id = ${mediaItem.id}
            `;

            // All fields should be preserved
            expect(result.metadata.overview).toBe('Overview');
            expect(result.metadata.actors).toEqual(['Actor 1']);
            expect(result.metadata.trailer_url).toBe(trailerUrl);
        });
    });
});
