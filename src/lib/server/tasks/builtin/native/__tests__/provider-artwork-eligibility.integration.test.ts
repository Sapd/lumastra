// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Runs each provider-artwork stage's REAL eligibility.sql fragment against a
 * real Postgres, in the same `... FROM media_items mi WHERE <fragment>` shape
 * stage-sweep's dispose/heal passes use.
 *
 * Guards, end to end rather than by asserting a literal:
 *   - a media_items row with media_type='tv' IS selected by the series lanes
 *     (the 'series' spelling belongs to appliesTo, never to SQL),
 *   - the thumb lane keys on still_path,
 *   - an item whose ONLY artwork path lives on a losing chain provider is NOT
 *     selected (it would enrol and never complete),
 *   - Lane B's four season constraints.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
// SEVEN levels up from src/lib/server/tasks/builtin/native/__tests__/ to the
// repo root — matches the in-tree siblings, e.g.
// __tests__/artist-compilation.integration.test.ts:20.
import {
    getTestDb,
    closeTestDb,
} from '../../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../../tests/integration/helpers/cleanup.js';

vi.mock('../../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));

import {
    providerArtworkPosterTask,
    providerArtworkBackdropTask,
    providerArtworkLogoTask,
    providerArtworkThumbTask,
    providerArtworkSeasonPosterTask,
} from '../provider-artwork-backfill.js';

const uuid = (): string => crypto.randomUUID();

async function insertItem(
    sql: postgres.Sql,
    row: {
        id: string;
        media_type: string;
        has_files?: boolean;
        parent_id?: string | null;
        season_number?: number | null;
    },
): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number)
        VALUES (
            ${row.id}::uuid, ${'T-' + row.id.slice(0, 8)}, ${row.media_type}, 'active',
            ${row.has_files ?? true}, ${row.parent_id ?? null}::uuid, ${row.season_number ?? null}
        )
    `;
}

describe('provider-artwork eligibility fragments (real SQL)', () => {
    let sql: postgres.Sql;

    /** Ids selected by a stage's real eligibility fragment. */
    const selectEligible = async (task: {
        coversStages?: ReadonlyArray<{ eligibility?: { sql?: unknown } }>;
    }): Promise<string[]> => {
        const build = task.coversStages?.[0].eligibility?.sql as (
            s: postgres.Sql,
        ) => postgres.PendingQuery<postgres.Row[]>;
        const fragment = build(sql);
        const rows = await sql<{ id: string }[]>`
            SELECT mi.id::text AS id FROM media_items mi WHERE ${fragment}
        `;
        return rows.map((r) => r.id).sort();
    };

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'media_item_stage_state',
            'provider_metadata',
            'external_ids',
            'media_file_items',
            'media_files',
            'media_items',
        ]);
    });

    it('enrols a media_type=tv row in the logo lane (the series/tv seam)', async () => {
        const seriesId = uuid();
        await insertItem(sql, { id: seriesId, media_type: 'tv' });
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${seriesId}::uuid, 'aggregated', ${sql.json({ logo_path: '/l.png' })})
        `;

        expect(await selectEligible(providerArtworkLogoTask)).toEqual([seriesId]);
    });

    it('does NOT enrol an episode in the logo lane', async () => {
        const id = uuid();
        await insertItem(sql, { id, media_type: 'episode' });
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${id}::uuid, 'aggregated', ${sql.json({ logo_path: '/l.png' })})
        `;

        expect(await selectEligible(providerArtworkLogoTask)).toEqual([]);
    });

    it('enrols an episode carrying still_path in the thumb lane', async () => {
        const withStill = uuid();
        const withThumbPath = uuid();
        await insertItem(sql, { id: withStill, media_type: 'episode' });
        await insertItem(sql, { id: withThumbPath, media_type: 'episode' });
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${withStill}::uuid, 'aggregated', ${sql.json({ still_path: '/s.jpg' })}),
                   (${withThumbPath}::uuid, 'aggregated', ${sql.json({ thumb_path: '/t.jpg' })})
        `;

        expect(await selectEligible(providerArtworkThumbTask)).toEqual([withStill]);
    });

    it('does NOT enrol an item whose only poster path is on a LOSING chain provider', async () => {
        const id = uuid();
        await insertItem(sql, { id, media_type: 'movie' });
        // 'aggregated' wins the chain and has no poster; the lower-priority row does.
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${id}::uuid, 'aggregated', ${sql.json({ title: 'x' })}),
                   (${id}::uuid, 'tmdb', ${sql.json({ poster_path: '/p.jpg' })})
        `;

        expect(await selectEligible(providerArtworkPosterTask)).toEqual([]);
    });

    it('does NOT enrol a has_files=false catalog ghost', async () => {
        const id = uuid();
        await insertItem(sql, { id, media_type: 'movie', has_files: false });
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${id}::uuid, 'aggregated', ${sql.json({ backdrop_path: '/b.jpg' })})
        `;

        expect(await selectEligible(providerArtworkBackdropTask)).toEqual([]);
    });

    it('does NOT enrol an item with only an INHERITED ancestor path', async () => {
        const seriesId = uuid();
        const episodeId = uuid();
        await insertItem(sql, { id: seriesId, media_type: 'tv' });
        await insertItem(sql, { id: episodeId, media_type: 'episode', parent_id: seriesId });
        await sql`
            INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${seriesId}::uuid, 'aggregated', ${sql.json({ still_path: '/parent.jpg' })})
        `;

        expect(await selectEligible(providerArtworkThumbTask)).toEqual([]);
    });

    describe('season lane', () => {
        // `external_ids` has UNIQUE(provider, external_id, media_type) — a
        // fixed literal collides across the multiple makeSeason() calls in
        // the "rejects ..." test below, so each series gets its own tmdb id.
        let nextTmdbId = 63_247;

        const makeSeason = async (opts: {
            parentMediaType: string;
            extIdMediaType: string;
            seasonNumber: number | null;
            hasFiles?: boolean;
        }): Promise<string> => {
            const seriesId = uuid();
            const seasonId = uuid();
            const tmdbId = String(nextTmdbId++);
            await insertItem(sql, { id: seriesId, media_type: opts.parentMediaType });
            await insertItem(sql, {
                id: seasonId,
                media_type: 'season',
                parent_id: seriesId,
                season_number: opts.seasonNumber,
                has_files: opts.hasFiles ?? true,
            });
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${seriesId}::uuid, 'tmdb', ${tmdbId}, ${opts.extIdMediaType}, true)
            `;
            return seasonId;
        };

        it('enrols a well-formed season', async () => {
            const seasonId = await makeSeason({
                parentMediaType: 'tv',
                extIdMediaType: 'tv',
                seasonNumber: 1,
            });

            expect(await selectEligible(providerArtworkSeasonPosterTask)).toEqual([seasonId]);
        });

        it('rejects NULL season_number, non-tv parent, wrong ext-id media_type, and no files', async () => {
            await makeSeason({
                parentMediaType: 'tv',
                extIdMediaType: 'tv',
                seasonNumber: null,
            });
            await makeSeason({
                parentMediaType: 'home_video',
                extIdMediaType: 'tv',
                seasonNumber: 1,
            });
            await makeSeason({
                parentMediaType: 'tv',
                extIdMediaType: 'movie',
                seasonNumber: 1,
            });
            await makeSeason({
                parentMediaType: 'tv',
                extIdMediaType: 'tv',
                seasonNumber: 2,
                hasFiles: false,
            });

            expect(await selectEligible(providerArtworkSeasonPosterTask)).toEqual([]);
        });
    });
});
