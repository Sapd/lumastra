// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Media Translations Query Module
 *
 * Tests upsert + batch-lookup of per-language display translations
 * (media_item_translations), including the metadata_locked exclusion.
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
    upsertMediaTranslations,
    getTranslationMapForItems,
    hasTranslation,
} from './media-translations.queries.js';

async function seedMovie(sql: postgres.Sql, overrides: { title: string }): Promise<string> {
    const item = createTestMediaItem({ media_type: 'movie', title: overrides.title });
    return insertTestMediaItem(sql, item);
}

describe('Media Translations Queries', () => {
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

    it('upserts and fetches translations, excluding locked items', async () => {
        const id = await seedMovie(sql, { title: 'The Harbor Redemption' });

        await upsertMediaTranslations(sql, id, [
            { language: 'de', title: 'Die Verschollenen', overview: 'Zwei Männer…', tagline: null },
            { language: 'ja', title: null, overview: '', tagline: null }, // blank overview → stored as NULL
        ]);

        const map = await getTranslationMapForItems(sql, [id], 'de');
        expect(map.get(id)?.title).toBe('Die Verschollenen');
        expect(map.get(id)?.overview).toBe('Zwei Männer…');

        // the 'ja' row has no non-null field once blanked, so it should never
        // have been persisted at all.
        const jaMap = await getTranslationMapForItems(sql, [id], 'ja');
        expect(jaMap.size).toBe(0);

        // idempotent re-upsert updates, no dup
        await upsertMediaTranslations(sql, id, [
            { language: 'de', title: 'Die Verschollenen (Neu)' },
        ]);
        expect((await getTranslationMapForItems(sql, [id], 'de')).get(id)?.title).toBe(
            'Die Verschollenen (Neu)',
        );

        const rows = await sql`SELECT * FROM media_item_translations WHERE media_id = ${id}::uuid`;
        expect(rows.length).toBe(1);

        // locked item excluded
        await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${id}`;
        expect((await getTranslationMapForItems(sql, [id], 'de')).size).toBe(0);
    });

    it('hasTranslation reports presence/absence per language', async () => {
        const id = await seedMovie(sql, { title: 'Awakening' });

        expect(await hasTranslation(sql, id, 'de')).toBe(false);

        await upsertMediaTranslations(sql, id, [{ language: 'de', title: 'Die Ankunft' }]);

        expect(await hasTranslation(sql, id, 'de')).toBe(true);
        expect(await hasTranslation(sql, id, 'fr')).toBe(false);
    });

    it('getTranslationMapForItems returns an empty map for no ids or no language', async () => {
        expect((await getTranslationMapForItems(sql, [], 'de')).size).toBe(0);

        const id = await seedMovie(sql, { title: 'Empty Args Movie' });
        await upsertMediaTranslations(sql, id, [{ language: 'de', title: 'Leer' }]);
        expect((await getTranslationMapForItems(sql, [id], '')).size).toBe(0);
    });

    it('upsertMediaTranslations is a no-op for blank/duplicate/all-empty inputs', async () => {
        const id = await seedMovie(sql, { title: 'No-op Movie' });

        const count = await upsertMediaTranslations(sql, id, [
            { language: '', title: 'Should be skipped (blank language)' },
            { language: 'de', title: '', overview: '', tagline: '' }, // all-blank → skipped
            { language: 'fr', title: 'Premier' },
            { language: 'fr', title: 'Devrait être ignoré (duplicate language in batch)' },
        ]);

        expect(count).toBe(1);
        const map = await getTranslationMapForItems(sql, [id], 'fr');
        expect(map.get(id)?.title).toBe('Premier');
        expect((await getTranslationMapForItems(sql, [id], 'de')).size).toBe(0);
    });
});
