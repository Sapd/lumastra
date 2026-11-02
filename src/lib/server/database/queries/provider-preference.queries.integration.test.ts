// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Provider Preference Query Module
 *
 * Tests getMediaProviderPreference, getAvailableProviders, checkMediaExists,
 * checkMediaWithProvider, checkProviderEnabled, checkProviderHasMetadata,
 * setPreferredProvider, resetPreferredProvider, getEffectiveProvider.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    getMediaProviderPreference,
    getAvailableProviders,
    checkMediaExists,
    checkMediaWithProvider,
    checkProviderEnabled,
    checkProviderHasMetadata,
    setPreferredProvider,
    resetPreferredProvider,
    getEffectiveProvider,
} from './provider-preference.queries.js';

describe('Provider Preference Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'provider_capabilities']);
    });

    // ========================================================================
    // getMediaProviderPreference
    // ========================================================================

    describe('getMediaProviderPreference', () => {
        it('returns media info from v_media_metadata view', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const row = await getMediaProviderPreference(sql, item.id);

            expect(row).not.toBeNull();
            expect(row!.media_id).toBe(item.id);
            expect(row!.title).toBe(item.title);
            expect(row!.media_type).toBe('movie');
        });

        it('returns null for non-existent media', async () => {
            const row = await getMediaProviderPreference(
                sql,
                '00000000-0000-0000-0000-000000000000',
            );
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // getAvailableProviders
    // ========================================================================

    describe('getAvailableProviders', () => {
        it('returns enabled providers with metadata', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('tmdb', 1, true, '{}'::jsonb)
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'tmdb', '{}'::jsonb, NOW())
            `;

            const rows = await getAvailableProviders(sql, item.id);

            expect(rows.length).toBe(1);
            expect(rows[0].provider).toBe('tmdb');
        });

        it('excludes disabled providers', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('disabled', 1, false, '{}'::jsonb)
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'disabled', '{}'::jsonb, NOW())
            `;

            const rows = await getAvailableProviders(sql, item.id);
            expect(rows).toHaveLength(0);
        });
    });

    // ========================================================================
    // checkMediaExists
    // ========================================================================

    describe('checkMediaExists', () => {
        it('returns media id and title for active media', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const row = await checkMediaExists(sql, item.id);

            expect(row).not.toBeNull();
            expect(row!.id).toBe(item.id);
            expect(row!.title).toBe(item.title);
        });

        it('returns null for deleted media', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                status: 'deleted',
            });
            await insertTestMediaItem(sql, item);

            const row = await checkMediaExists(sql, item.id);
            expect(row).toBeNull();
        });

        it('returns null for non-existent media', async () => {
            const row = await checkMediaExists(sql, crypto.randomUUID());
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // checkMediaWithProvider
    // ========================================================================

    describe('checkMediaWithProvider', () => {
        it('returns media id and preferred_provider', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('tmdb', 1, true, '{}'::jsonb)
            `;
            await sql`
                UPDATE media_items SET preferred_provider = 'tmdb' WHERE id = ${item.id}::uuid
            `;

            const row = await checkMediaWithProvider(sql, item.id);
            expect(row).not.toBeNull();
            expect(row!.preferred_provider).toBe('tmdb');
        });

        it('returns null for non-existent media', async () => {
            const row = await checkMediaWithProvider(sql, '00000000-0000-0000-0000-000000000000');
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // checkProviderEnabled
    // ========================================================================

    describe('checkProviderEnabled', () => {
        it('returns provider name when enabled', async () => {
            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('enabled-prov', 1, true, '{}'::jsonb)
            `;

            const row = await checkProviderEnabled(sql, 'enabled-prov');
            expect(row).not.toBeNull();
            expect(row!.provider).toBe('enabled-prov');
        });

        it('returns null when provider is disabled', async () => {
            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('disabled-prov', 1, false, '{}'::jsonb)
            `;

            const row = await checkProviderEnabled(sql, 'disabled-prov');
            expect(row).toBeNull();
        });

        it('returns null for unknown provider', async () => {
            const row = await checkProviderEnabled(sql, 'no-such-provider');
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // checkProviderHasMetadata
    // ========================================================================

    describe('checkProviderHasMetadata', () => {
        it('returns provider when metadata exists', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'tmdb', '{}'::jsonb, NOW())
            `;

            const row = await checkProviderHasMetadata(sql, item.id, 'tmdb');
            expect(row).not.toBeNull();
            expect(row!.provider).toBe('tmdb');
        });

        it('returns null when no metadata', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const row = await checkProviderHasMetadata(sql, item.id, 'tmdb');
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // setPreferredProvider
    // ========================================================================

    describe('setPreferredProvider', () => {
        it('sets preferred_provider on media item', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('tmdb', 1, true, '{}'::jsonb)
            `;

            await setPreferredProvider(sql, item.id, 'tmdb');

            const [row] = await sql`
                SELECT preferred_provider FROM media_items WHERE id = ${item.id}::uuid
            `;
            expect(row!.preferred_provider).toBe('tmdb');
        });
    });

    // ========================================================================
    // resetPreferredProvider
    // ========================================================================

    describe('resetPreferredProvider', () => {
        it('clears preferred_provider to NULL', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('tmdb', 1, true, '{}'::jsonb)
            `;
            await setPreferredProvider(sql, item.id, 'tmdb');

            await resetPreferredProvider(sql, item.id);

            const [row] = await sql`
                SELECT preferred_provider FROM media_items WHERE id = ${item.id}::uuid
            `;
            expect(row!.preferred_provider).toBeNull();
        });
    });

    // ========================================================================
    // getEffectiveProvider
    // ========================================================================

    describe('getEffectiveProvider', () => {
        it('returns effective_provider from view', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const row = await getEffectiveProvider(sql, item.id);
            expect(row).not.toBeNull();
            // effective_provider may be null or some provider depending on view logic
            expect(Object.keys(row!)).toContain('effective_provider');
        });

        it('returns null for non-existent media', async () => {
            const row = await getEffectiveProvider(sql, '00000000-0000-0000-0000-000000000000');
            expect(row).toBeNull();
        });
    });
});
