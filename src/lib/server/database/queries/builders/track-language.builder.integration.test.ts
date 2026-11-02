// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for the Track-Language Filter Builder
 *
 * Exercises buildTrackLanguageFilter() against a real media_item_languages
 * projection to verify OR-within-kind, AND-across-kind, and the
 * includeUnknown untagged-vs-'other' distinction.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../tests/integration/helpers/cleanup.js';
import { buildTrackLanguageFilter } from './track-language.builder.js';

describe('buildTrackLanguageFilter', () => {
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
        langs: { audio?: string[]; subtitle?: string[] } | null,
    ): Promise<string> {
        const [mi] = await sql<{ id: string }[]>`
            INSERT INTO media_items (media_type, title, status, has_files)
            VALUES ('movie', 'Filter Fixture', 'active', true) RETURNING id`;
        for (const l of langs?.audio ?? [])
            await sql`INSERT INTO media_item_languages (media_item_id, kind, language) VALUES (${mi.id}, 'audio', ${l})`;
        for (const l of langs?.subtitle ?? [])
            await sql`INSERT INTO media_item_languages (media_item_id, kind, language) VALUES (${mi.id}, 'subtitle', ${l})`;
        return mi.id;
    }

    async function matches(
        id: string,
        opts: Parameters<typeof buildTrackLanguageFilter>[1],
    ): Promise<boolean> {
        const frag = buildTrackLanguageFilter(sql, opts);
        const rows = await sql<{ id: string }[]>`
            SELECT mi.id FROM media_items mi WHERE mi.id = ${id} ${frag}`;
        return rows.length === 1;
    }

    it('matches on any selected audio language (OR within kind)', async () => {
        const id = await itemWith({ audio: ['ja'] });
        expect(await matches(id, { audioLangs: ['de', 'ja'] })).toBe(true);
        expect(await matches(id, { audioLangs: ['de', 'en'] })).toBe(false);
    });

    it('ANDs across kinds', async () => {
        const id = await itemWith({ audio: ['ja'], subtitle: ['de'] });
        expect(await matches(id, { audioLangs: ['ja'], subLangs: ['de'] })).toBe(true);
        expect(await matches(id, { audioLangs: ['ja'], subLangs: ['en'] })).toBe(false);
    });

    it('excludes untagged by default, includes with includeUnknown', async () => {
        const id = await itemWith(null); // no rows at all
        expect(await matches(id, { audioLangs: ['de'] })).toBe(false);
        expect(await matches(id, { audioLangs: ['de'], includeUnknown: true })).toBe(true);
    });

    it("'other'-tagged items are NOT untagged", async () => {
        const id = await itemWith({ audio: ['other'] });
        expect(await matches(id, { audioLangs: ['de'], includeUnknown: true })).toBe(false);
    });

    it('returns empty fragment (matches everything) when nothing selected', async () => {
        const id = await itemWith(null);
        expect(await matches(id, {})).toBe(true);
    });
});
