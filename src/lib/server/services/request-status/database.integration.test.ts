// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Differential access-boundary tests for the request-status database helpers.
 *
 * `checkLocalAvailability` and `checkSeasonAvailability` are the probe surface
 * of the request-status endpoint: they answer "does this title / season exist
 * locally?" for an arbitrary external id. Both therefore carry a library +
 * age boundary, and both used to hand-inline the library predicate correlated
 * to a CONTAINER row — the `tv` row for `checkLocalAvailability(…, 'tv', …)`,
 * the `season` row for `checkSeasonAvailability`.
 *
 * No container row owns `media_file_items`: verified on production 2026-09-15,
 * 0 of 6,570 `tv` and 0 of 4,806 `season` rows do, against 80,777 leaf rows
 * that do. The inlined predicate's `NOT EXISTS (own files)` arm was therefore
 * always TRUE and the library axis was a no-op — a user denied a library group
 * could still confirm that a restricted series/season is present.
 *
 * Fixtures place files through `placeInLibraryGroup`, which puts them on the
 * descendant leaf where the container-aware predicate actually looks. Attaching
 * a `media_files` row to the container row itself is a state production cannot
 * produce and makes the test false-green.
 *
 * `getDb()` resolves to the same database as `getTestDb()` — the integration
 * vitest config injects TEST_DATABASE_URL into DATABASE_URL before any module
 * snapshots it.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { placeInLibraryGroup } from '../../../../../tests/integration/fixtures/index.js';
import { getPrimaryExternalIdProvider } from '../../utils/provider-config.js';
import { checkLocalAvailability, checkSeasonAvailability } from './database.js';

let sql: postgres.Sql;
let groupA: string;
let groupB: string;

/**
 * Unique primary-provider external id. Numeric because `external_ids` carries a
 * `valid_tmdb_id` CHECK and tmdb is the default primary provider.
 */
let primarySeq = 970_000;
const nextPrimaryId = (): string => String(primarySeq++);

/** Boundary denying exactly `ids`; age unrestricted. */
function denying(...ids: string[]) {
    return { deniedGroupIds: ids, ageRating: null };
}
const UNRESTRICTED = { deniedGroupIds: null, ageRating: null };

/**
 * Seed `tv` -> `season` with the primary external id on the series, and place
 * the season's descendant file in `libraryGroupId` (or leave it file-less).
 */
async function seedSeries(opts: {
    title: string;
    primaryId: string;
    seasonNumber: number;
    libraryGroupId: string | null;
}): Promise<{ seriesId: string; seasonId: string }> {
    const seriesId = randomUUID();
    const seasonId = randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files)
        VALUES (${seriesId}::uuid, ${opts.title}, 'tv', 'active', true)
    `;
    await sql`
        INSERT INTO media_items (id, parent_id, title, media_type, status, season_number, has_files)
        VALUES (
            ${seasonId}::uuid, ${seriesId}::uuid, ${`${opts.title} S${opts.seasonNumber}`},
            'season', 'active', ${opts.seasonNumber}, true
        )
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
        VALUES (
            ${seriesId}::uuid, ${getPrimaryExternalIdProvider()}, ${opts.primaryId}, 'tv', true
        )
    `;
    if (opts.libraryGroupId) {
        await placeInLibraryGroup(sql, {
            mediaItemId: seasonId,
            mediaType: 'season',
            libraryGroupId: opts.libraryGroupId,
        });
    }
    return { seriesId, seasonId };
}

beforeAll(() => {
    sql = getTestDb();
});

afterAll(async () => {
    await closeTestDb();
});

beforeEach(async () => {
    await truncateTables(sql, TEST_TABLES.media);
    groupA = randomUUID();
    groupB = randomUUID();
    await sql`
        INSERT INTO library_groups (id, name)
        VALUES (${groupA}::uuid, 'RS Group A'), (${groupB}::uuid, 'RS Group B')
    `;
});

describe('checkSeasonAvailability honours the library axis', () => {
    it('hides a season whose only descendant file is in a denied group', async () => {
        const primaryId = nextPrimaryId();
        await seedSeries({
            title: 'Cinder Atlas',
            primaryId,
            seasonNumber: 2,
            libraryGroupId: groupA,
        });

        // POSITIVE CONTROL — the fixture is reachable.
        expect(await checkSeasonAvailability(primaryId, 2, UNRESTRICTED)).not.toBeNull();
        // An unrelated denied group changes nothing.
        expect(await checkSeasonAvailability(primaryId, 2, denying(groupB))).not.toBeNull();

        expect(await checkSeasonAvailability(primaryId, 2, denying(groupA))).toBeNull();
    });

    it('keeps a file-less season visible — the fail-open branch for catalog-only rows', async () => {
        const primaryId = nextPrimaryId();
        await seedSeries({
            title: 'Paper Lantern',
            primaryId,
            seasonNumber: 1,
            libraryGroupId: null,
        });

        expect(await checkSeasonAvailability(primaryId, 1, denying(groupA))).not.toBeNull();
    });
});

describe('checkLocalAvailability honours the library axis for a tv row', () => {
    it('hides a series whose only descendant file is in a denied group', async () => {
        const primaryId = nextPrimaryId();
        await seedSeries({
            title: 'Gravel Compass',
            primaryId,
            seasonNumber: 1,
            libraryGroupId: groupA,
        });
        const externalIds = { [getPrimaryExternalIdProvider()]: primaryId };

        // POSITIVE CONTROL.
        expect(await checkLocalAvailability(externalIds, 'tv', UNRESTRICTED)).not.toBeNull();
        expect(await checkLocalAvailability(externalIds, 'tv', denying(groupB))).not.toBeNull();

        expect(await checkLocalAvailability(externalIds, 'tv', denying(groupA))).toBeNull();
    });

    it('still hides a MOVIE whose own file is in a denied group (leaf rule unchanged)', async () => {
        const primaryId = nextPrimaryId();
        const movieId = randomUUID();
        await sql`
            INSERT INTO media_items (id, title, media_type, status, has_files)
            VALUES (${movieId}::uuid, 'Quartz Meridian', 'movie', 'active', true)
        `;
        await sql`
            INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
            VALUES (${movieId}::uuid, ${getPrimaryExternalIdProvider()}, ${primaryId}, 'movie', true)
        `;
        await placeInLibraryGroup(sql, {
            mediaItemId: movieId,
            mediaType: 'movie',
            libraryGroupId: groupA,
        });
        const externalIds = { [getPrimaryExternalIdProvider()]: primaryId };

        expect(await checkLocalAvailability(externalIds, 'movie', UNRESTRICTED)).not.toBeNull();
        expect(await checkLocalAvailability(externalIds, 'movie', denying(groupA))).toBeNull();
    });
});

describe('season completion requires every catalog episode', () => {
    it('does not confuse one playable episode with a completed season', async () => {
        const primaryId = nextPrimaryId();
        const { seasonId } = await seedSeries({
            title: 'Partial season',
            primaryId,
            seasonNumber: 1,
            libraryGroupId: null,
        });
        await sql`INSERT INTO media_items (parent_id, title, media_type, status, has_files, episode_number)
            VALUES (${seasonId}::uuid, 'First', 'episode', 'active', true, 1),
                   (${seasonId}::uuid, 'Second', 'episode', 'active', false, 2)`;
        expect((await checkSeasonAvailability(primaryId, 1, UNRESTRICTED))?.isAvailable).toBe(
            false,
        );
        await sql`UPDATE media_items SET has_files = true WHERE parent_id = ${seasonId}::uuid`;
        expect((await checkSeasonAvailability(primaryId, 1, UNRESTRICTED))?.isAvailable).toBe(true);
    });
});
