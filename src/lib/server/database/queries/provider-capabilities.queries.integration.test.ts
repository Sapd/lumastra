// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Provider Capabilities Query Module
 *
 * Tests getAllProviderCapabilities, getFieldAuthorities, setProviderEnabled,
 * setProviderPriority, upsertProviderCapability and getProviderCapability.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';

import {
    getAllProviderCapabilities,
    getFieldAuthorities,
    setProviderEnabled,
    setProviderPriority,
    upsertProviderCapability,
    getProviderCapability,
} from './provider-capabilities.queries.js';

describe('Provider Capabilities Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['provider_field_authorities', 'provider_capabilities']);
    });

    // ========================================================================
    // getAllProviderCapabilities
    // ========================================================================

    describe('getAllProviderCapabilities', () => {
        it('returns all providers ordered by priority', async () => {
            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES
                    ('tmdb', 1, true, '{"metadata": true}'::jsonb),
                    ('trakt', 5, true, '{"ratings": true}'::jsonb)
            `;

            const rows = await getAllProviderCapabilities(sql);

            expect(rows.length).toBe(2);
            expect(rows[0].provider).toBe('tmdb');
            expect(rows[1].provider).toBe('trakt');
        });

        it('returns empty array when no providers exist', async () => {
            const rows = await getAllProviderCapabilities(sql);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // getFieldAuthorities
    // ========================================================================

    describe('getFieldAuthorities', () => {
        it('returns field authorities ordered by field and priority', async () => {
            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('tmdb', 1, true, '{}'::jsonb), ('jellyfin', 10, true, '{}'::jsonb)
            `;
            await sql`
                INSERT INTO provider_field_authorities (field_name, provider, priority)
                VALUES
                    ('overview', 'tmdb', 1),
                    ('overview', 'jellyfin', 10),
                    ('poster', 'tmdb', 2)
            `;

            const rows = await getFieldAuthorities(sql);

            expect(rows.length).toBe(3);
            expect(rows[0].field_name).toBe('overview');
            expect(rows[0].provider).toBe('tmdb');
        });
    });

    // ========================================================================
    // setProviderEnabled
    // ========================================================================

    describe('setProviderEnabled', () => {
        it('toggles enabled state', async () => {
            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('test-prov', 1, true, '{}'::jsonb)
            `;

            await setProviderEnabled(sql, 'test-prov', false);

            const row = await getProviderCapability(sql, 'test-prov');
            expect(row!.enabled).toBe(false);
        });
    });

    // ========================================================================
    // setProviderPriority
    // ========================================================================

    describe('setProviderPriority', () => {
        it('updates provider priority', async () => {
            await sql`
                INSERT INTO provider_capabilities (provider, priority, enabled, capabilities)
                VALUES ('test-prio', 100, true, '{}'::jsonb)
            `;

            await setProviderPriority(sql, 'test-prio', 5);

            const row = await getProviderCapability(sql, 'test-prio');
            expect(row!.priority).toBe(5);
        });
    });

    // ========================================================================
    // upsertProviderCapability
    // ========================================================================

    describe('upsertProviderCapability', () => {
        it('inserts a new provider row', async () => {
            await upsertProviderCapability(sql, 'new-cap', 3, true, {
                metadata: true,
            });

            const row = await getProviderCapability(sql, 'new-cap');
            expect(row).not.toBeUndefined();
            expect(row!.priority).toBe(3);
            expect(row!.capabilities).toEqual({ metadata: true });
        });

        it('does not overwrite existing rows', async () => {
            await upsertProviderCapability(sql, 'existing-cap', 1, true, {
                metadata: true,
            });

            // Toggle via direct SQL
            await setProviderEnabled(sql, 'existing-cap', false);

            // Re-upsert should preserve the disabled state
            await upsertProviderCapability(sql, 'existing-cap', 1, true, {
                metadata: true,
            });

            const row = await getProviderCapability(sql, 'existing-cap');
            expect(row!.enabled).toBe(false);
        });

        it('stores category when provided', async () => {
            await upsertProviderCapability(sql, 'cat-cap', 1, true, {}, 'metadata');

            const row = await getProviderCapability(sql, 'cat-cap');
            expect(row!.category).toBe('metadata');
        });
    });

    // ========================================================================
    // getProviderCapability
    // ========================================================================

    describe('getProviderCapability', () => {
        it('returns a single provider row', async () => {
            await upsertProviderCapability(sql, 'single-cap', 2, true, {
                images: true,
            });

            const row = await getProviderCapability(sql, 'single-cap');

            expect(row).not.toBeUndefined();
            expect(row!.provider).toBe('single-cap');
        });

        it('returns undefined for missing provider', async () => {
            const row = await getProviderCapability(sql, 'no-such-provider');
            expect(row).toBeUndefined();
        });
    });
});
