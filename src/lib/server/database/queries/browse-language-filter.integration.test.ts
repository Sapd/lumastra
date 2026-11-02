// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the audio/subtitle language filter wired into the
 * /browse A-Z queries (getMediaAlphabetical, getAlphabeticalBucketCounts).
 *
 * Uses the migration 16.148.0 media_item_languages projection via
 * refreshItemLanguages, mirroring the fixture pattern in
 * media-item-languages.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { getMediaAlphabetical, getAlphabeticalBucketCounts } from './browse.queries.js';
import { refreshItemLanguages } from './media-item-languages.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';

let fileFixtureCounter = 0;

/** Insert a movie with one file and the given audio-track languages, then refresh its projection. */
async function seedMovie(sql: postgres.Sql, title: string, audioLangs: string[]): Promise<string> {
    const [item] = await sql<{ id: string }[]>`
        INSERT INTO media_items (media_type, title, sort_title, status, has_files)
        VALUES ('movie', ${title}, ${title.toLowerCase()}, 'active', true) RETURNING id`;
    const [file] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path)
        VALUES (${`/fixtures/az-lang-${fileFixtureCounter++}.mkv`}) RETURNING id`;
    await sql`INSERT INTO media_file_items (media_item_id, file_id) VALUES (${item.id}, ${file.id})`;

    let streamIndex = 0;
    for (const lang of audioLangs) {
        await sql`
            INSERT INTO media_streams (file_id, stream_type, stream_index, language, is_default, is_forced)
            VALUES (${file.id}, 'audio', ${streamIndex++}, ${lang}, false, false)`;
    }
    await refreshItemLanguages(sql, item.id);
    return item.id;
}

describe('A-Z browse language filter', () => {
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

    it('getMediaAlphabetical filters to items matching audioLangs', async () => {
        const jpId = await seedMovie(sql, 'Zephyr JP Fixture', ['jpn']);
        const enId = await seedMovie(sql, 'Zephyr EN Fixture', ['eng']);

        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            letter: 'Z',
            audioLangs: ['ja'],
        });

        const ids = result.items.map((item) => item.internal_id);
        expect(ids).toContain(jpId);
        expect(ids).not.toContain(enId);
        expect(result.totalCount).toBe(1);
    });

    it('getAlphabeticalBucketCounts respects the same filter, yielding a strictly smaller Z bucket', async () => {
        await seedMovie(sql, 'Zephyr JP Fixture', ['jpn']);
        await seedMovie(sql, 'Zephyr EN Fixture', ['eng']);

        const unfiltered = await getAlphabeticalBucketCounts(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
        });
        const filtered = await getAlphabeticalBucketCounts(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            audioLangs: ['ja'],
        });

        const unfilteredZ = unfiltered.find((bucket) => bucket.bucket === 'Z')?.count ?? 0;
        const filteredZ = filtered.find((bucket) => bucket.bucket === 'Z')?.count ?? 0;

        expect(unfilteredZ).toBe(2);
        expect(filteredZ).toBe(1);
        expect(filteredZ).toBeLessThan(unfilteredZ);
    });
});
