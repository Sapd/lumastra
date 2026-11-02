// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Group Provider Config Query Module
 *
 * Tests group provider chain resolution, field priorities, and
 * media item filtering by group configuration.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createTestMediaItem,
    insertTestMediaItem,
} from '../../../../../tests/integration/fixtures/index.js';

import {
    resolveProviderChainForGroup,
    resolveFieldPrioritiesForGroup,
    getGroupProviderConfig,
    getMediaIdsByGroup,
    getGroupItemsMissingProvider,
    filterItemsByGroupProvider,
} from './group-provider-config.queries.js';

describe('Group Provider Config Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'library_groups',
            'provider_metadata',
            'media_file_items',
            'media_files',
            'media_items',
        ]);
    });

    // ========================================================================
    // Pure utility functions
    // ========================================================================

    describe('resolveProviderChainForGroup', () => {
        it('returns fallback when groupChain is null', () => {
            const fallback = ['aggregated', 'tmdb'];
            const result = resolveProviderChainForGroup(null, fallback);
            expect(result).toEqual(fallback);
        });

        it('returns fallback when groupChain is empty', () => {
            const fallback = ['aggregated', 'tmdb'];
            const result = resolveProviderChainForGroup([], fallback);
            expect(result).toEqual(fallback);
        });

        it('auto-prepends aggregated when missing', () => {
            const result = resolveProviderChainForGroup(['tmdb', 'mdblist']);
            expect(result[0]).toBe('aggregated');
            expect(result).toEqual(['aggregated', 'tmdb', 'mdblist']);
        });

        it('does not duplicate aggregated when already first', () => {
            const chain = ['aggregated', 'tmdb'];
            const result = resolveProviderChainForGroup(chain);
            expect(result).toEqual(chain);
        });

        it('uses global chain as fallback when no fallback provided', () => {
            const result = resolveProviderChainForGroup(null);
            expect(Array.isArray(result)).toBe(true);
            expect(result.length).toBeGreaterThan(0);
        });
    });

    describe('resolveFieldPrioritiesForGroup', () => {
        it('returns group override when field is overridden', () => {
            const resolver = resolveFieldPrioritiesForGroup({
                poster_path: ['jellyfin', 'tmdb'],
            });
            expect(resolver('poster_path')).toEqual(['jellyfin', 'tmdb']);
        });

        it('falls through to global priority for non-overridden fields', () => {
            const resolver = resolveFieldPrioritiesForGroup({
                poster_path: ['jellyfin', 'tmdb'],
            });
            const result = resolver('overview');
            expect(result).toBeDefined();
            expect(Array.isArray(result)).toBe(true);
        });

        it('returns undefined for null overrides', () => {
            const resolver = resolveFieldPrioritiesForGroup(null);
            const result = resolver('overview');
            expect(result).toBeDefined();
            expect(Array.isArray(result)).toBe(true);
        });

        it('handles empty overrides object', () => {
            const resolver = resolveFieldPrioritiesForGroup({});
            const result = resolver('overview');
            expect(result).toBeDefined();
            expect(Array.isArray(result)).toBe(true);
        });
    });

    // ========================================================================
    // getGroupProviderConfig
    // ========================================================================

    describe('getGroupProviderConfig', () => {
        it('returns null for null libraryGroupId', async () => {
            const result = await getGroupProviderConfig(sql, null);
            expect(result).toBeNull();
        });

        it('returns config for a group with custom chain', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name, metadata_provider_chain)
                VALUES ('Test Group', ${['tmdb', 'mdblist']})
                RETURNING id
            `;

            const result = await getGroupProviderConfig(sql, groupRow.id);

            expect(result).not.toBeNull();
            expect(result!.chain).toEqual(['tmdb', 'mdblist']);
            expect(result!.fieldOverrides).toBeNull();
        });

        it('returns null for non-existent group', async () => {
            const result = await getGroupProviderConfig(
                sql,
                '00000000-0000-0000-0000-000000000000',
            );
            expect(result).toBeNull();
        });

        it('returns field overrides when set', async () => {
            const overrides = { poster_path: ['jellyfin', 'tmdb'] };
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name, field_priority_overrides)
                VALUES ('Test Group', ${sql.json(overrides)})
                RETURNING id
            `;

            const result = await getGroupProviderConfig(sql, groupRow.id);

            expect(result).not.toBeNull();
            expect(result!.fieldOverrides).toEqual(overrides);
        });
    });

    // ========================================================================
    // getMediaIdsByGroup
    // ========================================================================

    describe('getMediaIdsByGroup', () => {
        it('returns media item IDs for a group', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name)
                VALUES ('Test Group')
                RETURNING id
            `;

            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                UPDATE media_items
                SET library_group_id = ${groupRow.id}::uuid
                WHERE id = ${item.id}::uuid
            `;

            const result = await getMediaIdsByGroup(sql, groupRow.id);

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(item.id);
        });

        it('excludes deleted items', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name)
                VALUES ('Test Group')
                RETURNING id
            `;

            const item = createTestMediaItem({
                media_type: 'movie',
                status: 'deleted',
            });
            await insertTestMediaItem(sql, item);
            await sql`
                UPDATE media_items
                SET library_group_id = ${groupRow.id}::uuid
                WHERE id = ${item.id}::uuid
            `;

            const result = await getMediaIdsByGroup(sql, groupRow.id);
            expect(result).toHaveLength(0);
        });

        it('returns empty array for group with no items', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name)
                VALUES ('Empty Group')
                RETURNING id
            `;

            const result = await getMediaIdsByGroup(sql, groupRow.id);
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // getGroupItemsMissingProvider
    // ========================================================================

    describe('getGroupItemsMissingProvider', () => {
        it('returns items without provider metadata', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name)
                VALUES ('Test Group')
                RETURNING id
            `;

            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                UPDATE media_items
                SET library_group_id = ${groupRow.id}::uuid
                WHERE id = ${item.id}::uuid
            `;

            const result = await getGroupItemsMissingProvider(sql, groupRow.id, 'tmdb');

            expect(result).toHaveLength(1);
            expect(result[0]).toBe(item.id);
        });

        it('excludes items that have the provider metadata', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name)
                VALUES ('Test Group')
                RETURNING id
            `;

            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                UPDATE media_items
                SET library_group_id = ${groupRow.id}::uuid
                WHERE id = ${item.id}::uuid
            `;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
                VALUES (${item.id}::uuid, 'tmdb', '{}'::jsonb, NOW())
            `;

            const result = await getGroupItemsMissingProvider(sql, groupRow.id, 'tmdb');

            expect(result).toHaveLength(0);
        });
    });

    // ========================================================================
    // filterItemsByGroupProvider
    // ========================================================================

    describe('filterItemsByGroupProvider', () => {
        it('includes items with no group (global chain applies)', async () => {
            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);

            const result = await filterItemsByGroupProvider(sql, [item.id], 'tmdb');
            expect(result).toContain(item.id);
        });

        it('includes items whose group chain includes the provider', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name, metadata_provider_chain)
                VALUES ('Test Group', ${['aggregated', 'tmdb', 'mdblist']})
                RETURNING id
            `;

            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                UPDATE media_items
                SET library_group_id = ${groupRow.id}::uuid
                WHERE id = ${item.id}::uuid
            `;

            const result = await filterItemsByGroupProvider(sql, [item.id], 'tmdb');
            expect(result).toContain(item.id);
        });

        it('excludes items whose group chain does not include the provider', async () => {
            const [groupRow] = await sql<{ id: string }[]>`
                INSERT INTO library_groups (name, metadata_provider_chain)
                VALUES ('Test Group', ${['aggregated', 'mdblist']})
                RETURNING id
            `;

            const item = createTestMediaItem({ media_type: 'movie' });
            await insertTestMediaItem(sql, item);
            await sql`
                UPDATE media_items
                SET library_group_id = ${groupRow.id}::uuid
                WHERE id = ${item.id}::uuid
            `;

            const result = await filterItemsByGroupProvider(sql, [item.id], 'tmdb');
            expect(result).not.toContain(item.id);
        });

        it('returns empty array for empty input', async () => {
            const result = await filterItemsByGroupProvider(sql, [], 'tmdb');
            expect(result).toEqual([]);
        });
    });
});
