// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for the Quality Filter Builder
 *
 * Exercises buildQualityFilter() against a real media_item_quality
 * projection to verify per-dimension matching, AND-across-dimensions, and
 * the includeUnknown untagged (no-row) behavior.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../tests/integration/helpers/cleanup.js';
import { buildQualityFilter } from './quality.builder.js';

describe('buildQualityFilter', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
    });

    async function itemWith(
        quality: { resolution_tier?: string; hdr_tier?: string; codec?: string } | null,
    ): Promise<string> {
        const [mi] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('movie', 'Quality Fixture', 'active', true) RETURNING id`;
        if (quality) {
            await sql`
                INSERT INTO media_item_quality (media_item_id, resolution_tier, hdr_tier, codec)
                VALUES (${mi.id}, ${quality.resolution_tier ?? null}, ${quality.hdr_tier ?? null}, ${quality.codec ?? null})
            `;
        }
        return mi.id;
    }

    async function matches(
        id: string,
        opts: Parameters<typeof buildQualityFilter>[1],
    ): Promise<boolean> {
        const frag = buildQualityFilter(sql, opts);
        const rows = await sql<{ id: string }[]>`
            SELECT mi.id FROM media_items mi WHERE mi.id = ${id} ${frag}`;
        return rows.length === 1;
    }

    it('matches on resolution tier', async () => {
        const id = await itemWith({ resolution_tier: '4K' });
        expect(await matches(id, { resolutions: ['4K'] })).toBe(true);
        expect(await matches(id, { resolutions: ['1080p'] })).toBe(false);
    });

    it('ANDs across dimensions', async () => {
        const id = await itemWith({ resolution_tier: '4K', hdr_tier: 'hdr' });
        expect(await matches(id, { resolutions: ['4K'], hdr: ['hdr'] })).toBe(true);
        expect(await matches(id, { resolutions: ['4K'], hdr: ['sdr'] })).toBe(false);
    });

    it('excludes unprobed items by default, includes with includeUnknown', async () => {
        const id = await itemWith(null); // no quality row
        expect(await matches(id, { resolutions: ['4K'] })).toBe(false);
        expect(await matches(id, { resolutions: ['4K'], includeUnknown: true })).toBe(true);
    });

    it('returns empty fragment (matches everything) when nothing selected', async () => {
        const id = await itemWith(null);
        expect(await matches(id, {})).toBe(true);
    });
});
