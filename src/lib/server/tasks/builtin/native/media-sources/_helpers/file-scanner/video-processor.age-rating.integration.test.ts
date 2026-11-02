// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A Jellyfin OfficialRating (Jellyfin's own country) only fills: it must not
 * overwrite a national rating that TMDB already supplied for the configured country.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../../../tests/integration/helpers/cleanup.js';
import { resolveOrCreateMediaItem } from './video-processor.js';

let sql: postgres.Sql;
const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() };

beforeAll(() => {
    sql = getTestDb();
});
afterAll(async () => {
    await closeTestDb();
});
beforeEach(async () => {
    await truncateTables(sql, ['external_ids', 'media_items']);
});

async function awaitingMovie(
    ageRating: number | null,
    source: string | null,
): Promise<string> {
    const [row] = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, status, year, age_rating, age_rating_source,
                                 custom_metadata)
        VALUES ('Fixture', 'movie', 'active', 2020, ${ageRating}, ${source},
                '{"awaiting_provider_match": true}'::jsonb)
        RETURNING id`;
    return row!.id;
}

async function adopt(id: string, certification: string): Promise<void> {
    await resolveOrCreateMediaItem(
        sql,
        {
            externalId: 'jf-1',
            provider: 'jellyfin',
            title: 'Fixture',
            year: 2020,
            mediaType: 'movie',
            confidence: 0.7,
            certification,
        },
        undefined,
        { logger } as never,
        undefined,
        undefined,
        undefined,
        id,
    );
}

async function rating(id: string) {
    const [r] = await sql<{ age_rating: number | null; age_rating_source: string | null }[]>`
        SELECT age_rating, age_rating_source FROM media_items WHERE id = ${id}`;
    return r!;
}

describe('Jellyfin adopt path vs national rating', () => {
    it('does not overwrite a rating that already came from a national certification', async () => {
        const id = await awaitingMovie(16, 'national'); // TMDB FSK 16
        await adopt(id, 'PG'); // Jellyfin says PG (8)
        expect(await rating(id)).toEqual({ age_rating: 16, age_rating_source: 'national' });
    });

    it('still replaces an MDBList rating and fills an unrated title', async () => {
        const mdb = await awaitingMovie(18, 'mdblist');
        await adopt(mdb, 'PG');
        expect(await rating(mdb)).toEqual({ age_rating: 8, age_rating_source: 'national' });
    });
});
