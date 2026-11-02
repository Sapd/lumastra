// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the resolution/HDR/codec quality filter wired into
 * the /browse A-Z queries (getMediaAlphabetical, getAlphabeticalBucketCounts).
 *
 * Uses the migration 16.150.0 media_item_quality projection via
 * refreshItemQuality, mirroring the fixture pattern in
 * browse-language-filter.integration.test.ts /
 * media-item-quality.integration.test.ts.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { getMediaAlphabetical, getAlphabeticalBucketCounts } from './browse.queries.js';
import { refreshItemQuality } from './media-item-quality.queries.js';
import { unrestrictedAccess } from './builders/media-access-boundary.js';

let fileFixtureCounter = 0;

/** Insert a movie with one file and a single video stream at the given height/codec, then refresh its quality projection. */
async function seedMovie(
    sql: postgres.Sql,
    title: string,
    opts: { height: number; codec: string },
): Promise<string> {
    const [item] = await sql<{ id: string }[]>`
        INSERT INTO media_items (media_type, title, sort_title, status, has_files)
        VALUES ('movie', ${title}, ${title.toLowerCase()}, 'active', true) RETURNING id`;
    const [file] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path)
        VALUES (${`/fixtures/az-quality-${fileFixtureCounter++}.mkv`}) RETURNING id`;
    await sql`INSERT INTO media_file_items (media_item_id, file_id) VALUES (${item.id}, ${file.id})`;
    await sql`
        INSERT INTO media_streams (file_id, stream_type, stream_index, height, codec)
        VALUES (${file.id}, 'video', 0, ${opts.height}, ${opts.codec})`;
    await refreshItemQuality(sql, item.id);
    return item.id;
}

describe('A-Z browse quality filter', () => {
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

    it('getMediaAlphabetical filters to items matching resolutions', async () => {
        const uhdId = await seedMovie(sql, 'Zephyr 4K Fixture', { height: 2160, codec: 'hevc' });
        const hdId = await seedMovie(sql, 'Zephyr 1080p Fixture', { height: 1080, codec: 'h264' });

        const result = await getMediaAlphabetical(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            letter: 'Z',
            resolutions: ['4K'],
        });

        const ids = result.items.map((item) => item.internal_id);
        expect(ids).toContain(uhdId);
        expect(ids).not.toContain(hdId);
        expect(result.totalCount).toBe(1);
    });

    it('getAlphabeticalBucketCounts respects the same filter, yielding a strictly smaller Z bucket', async () => {
        await seedMovie(sql, 'Zephyr 4K Fixture', { height: 2160, codec: 'hevc' });
        await seedMovie(sql, 'Zephyr 1080p Fixture', { height: 1080, codec: 'h264' });

        const unfiltered = await getAlphabeticalBucketCounts(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
        });
        const filtered = await getAlphabeticalBucketCounts(sql, {
            access: unrestrictedAccess(),
            mediaType: 'movie',
            resolutions: ['4K'],
        });

        const unfilteredZ = unfiltered.find((bucket) => bucket.bucket === 'Z')?.count ?? 0;
        const filteredZ = filtered.find((bucket) => bucket.bucket === 'Z')?.count ?? 0;

        expect(unfilteredZ).toBe(2);
        expect(filteredZ).toBe(1);
        expect(filteredZ).toBeLessThan(unfilteredZ);
    });
});
