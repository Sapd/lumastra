// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration coverage for the provider-artwork backfill read side.
 *
 * The load-bearing assertions are the seam guards:
 *  - the winning-row pick agrees with buildOverrideAwareMetadataLateralJoin
 *    (an off-chain / losing-chain path must NOT be returned),
 *  - `thumb` reads `still_path`,
 *  - Lane B's season target requires the composite external_ids key
 *    (provider='tmdb' AND media_type='tv') on a parent whose media_type is 'tv'.
 *
 * ENVIRONMENT ASSUMPTION: these cases exercise the RUNTIME metadata provider
 * chain (`getMetadataProviderChain()`), whose default is
 * `['aggregated', 'tmdb', 'mdblist']` — 'aggregated' is always prepended
 * (`provider-config.ts:145-149`) and `METADATA_PROVIDERS` defaults to
 * `'tmdb,mdblist'` (`config.ts:3255`). The `beforeAll` below asserts that so a
 * local `.env` with an exotic `METADATA_PROVIDERS` fails loudly instead of
 * producing a confusing assertion diff.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import { getMetadataProviderChain } from '../../utils/provider-config.js';
import {
    getWinningProviderArtworkPath,
    getSeasonBackfillTarget,
    filterSeasonsWithBackfillTarget,
    countProviderArtworkBacklog,
} from './provider-artwork.queries.js';

async function insertItem(
    sql: postgres.Sql,
    row: {
        id: string;
        media_type: string;
        has_files?: boolean;
        parent_id?: string | null;
        season_number?: number | null;
        preferred_provider?: string | null;
    },
): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id, season_number, preferred_provider)
        VALUES (
            ${row.id}::uuid, ${'T-' + row.id.slice(0, 8)}, ${row.media_type}, 'active',
            ${row.has_files ?? true},
            ${row.parent_id ?? null}::uuid,
            ${row.season_number ?? null},
            ${row.preferred_provider ?? null}
        )
    `;
}

async function insertProviderMetadata(
    sql: postgres.Sql,
    mediaId: string,
    provider: string,
    metadata: postgres.JSONValue,
): Promise<void> {
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata)
        VALUES (${mediaId}::uuid, ${provider}, ${sql.json(metadata)})
        ON CONFLICT (media_id, provider) DO UPDATE SET metadata = EXCLUDED.metadata
    `;
}

const uuid = (): string => crypto.randomUUID();

describe('provider-artwork.queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
        // `media_items.preferred_provider` is guarded by the
        // `validate_media_items_preferred_provider` trigger, which RAISEs
        // unless a matching enabled `provider_capabilities` row exists.
        // Precedent: latest-embeddings.queries.integration.test.ts:162-165.
        await sql`
            INSERT INTO provider_capabilities (provider, enabled, priority)
            VALUES ('tmdb', true, 1)
            ON CONFLICT (provider) DO UPDATE SET enabled = true
        `;
        const chain = getMetadataProviderChain();
        expect(
            chain.slice(0, 2),
            `these tests assume the default provider chain; got ${JSON.stringify(chain)} — unset METADATA_PROVIDERS in your .env`,
        ).toEqual(['aggregated', 'tmdb']);
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

    describe('getWinningProviderArtworkPath', () => {
        it('returns the aggregated row path (aggregated ranks first in the chain)', async () => {
            const id = uuid();
            await insertItem(sql, { id, media_type: 'movie' });
            await insertProviderMetadata(sql, id, 'aggregated', { poster_path: '/agg.jpg' });
            await insertProviderMetadata(sql, id, 'tmdb', { poster_path: '/tmdb.jpg' });

            const result = await getWinningProviderArtworkPath(sql, id, 'poster');

            expect(result).toEqual({ provider: 'aggregated', path: '/agg.jpg' });
        });

        it('honours media_items.preferred_provider over chain order', async () => {
            const id = uuid();
            await insertItem(sql, { id, media_type: 'movie', preferred_provider: 'tmdb' });
            await insertProviderMetadata(sql, id, 'aggregated', { poster_path: '/agg.jpg' });
            await insertProviderMetadata(sql, id, 'tmdb', { poster_path: '/tmdb.jpg' });

            const result = await getWinningProviderArtworkPath(sql, id, 'poster');

            expect(result).toEqual({ provider: 'tmdb', path: '/tmdb.jpg' });
        });

        it('returns null when only a LOSING chain row carries the path (agrees with the LATERAL)', async () => {
            const id = uuid();
            await insertItem(sql, { id, media_type: 'movie' });
            // Winning row (aggregated) has NO poster; a lower-priority row does.
            await insertProviderMetadata(sql, id, 'aggregated', { title: 'x' });
            await insertProviderMetadata(sql, id, 'tmdb', { poster_path: '/tmdb.jpg' });

            const result = await getWinningProviderArtworkPath(sql, id, 'poster');

            expect(result).toBeNull();
        });

        it('reads the artwork block fallback', async () => {
            const id = uuid();
            await insertItem(sql, { id, media_type: 'movie' });
            await insertProviderMetadata(sql, id, 'aggregated', {
                artwork: { backdrop: 'https://cdn.example/b.jpg' },
            });

            const result = await getWinningProviderArtworkPath(sql, id, 'backdrop');

            expect(result).toEqual({
                provider: 'aggregated',
                path: 'https://cdn.example/b.jpg',
            });
        });

        it('reads still_path for the thumb type (NOT thumb_path)', async () => {
            const id = uuid();
            await insertItem(sql, { id, media_type: 'episode' });
            await insertProviderMetadata(sql, id, 'aggregated', {
                still_path: '/still.jpg',
                thumb_path: '/WRONG.jpg',
            });

            const result = await getWinningProviderArtworkPath(sql, id, 'thumb');

            expect(result).toEqual({ provider: 'aggregated', path: '/still.jpg' });
        });

        it('never returns an INHERITED ancestor path (own row only)', async () => {
            const seriesId = uuid();
            const episodeId = uuid();
            await insertItem(sql, { id: seriesId, media_type: 'tv' });
            await insertItem(sql, { id: episodeId, media_type: 'episode', parent_id: seriesId });
            await insertProviderMetadata(sql, seriesId, 'aggregated', {
                still_path: '/parent.jpg',
            });

            const result = await getWinningProviderArtworkPath(sql, episodeId, 'thumb');

            expect(result).toBeNull();
        });
    });

    describe('getSeasonBackfillTarget', () => {
        // `external_ids` is UNIQUE on (provider, external_id, media_type), so a test
        // that calls setup twice must vary the tmdb id — hence the counter rather
        // than a hardcoded literal.
        let nextSeriesTmdbId = 63247;

        const setup = async (opts: {
            parentMediaType: string;
            extIdMediaType: string;
            seasonNumber: number | null;
            seasonHasFiles?: boolean;
            seriesTmdbId?: string;
        }): Promise<string> => {
            const seriesId = uuid();
            const seasonId = uuid();
            const seriesTmdbId = opts.seriesTmdbId ?? String(nextSeriesTmdbId++);
            await insertItem(sql, { id: seriesId, media_type: opts.parentMediaType });
            await insertItem(sql, {
                id: seasonId,
                media_type: 'season',
                parent_id: seriesId,
                season_number: opts.seasonNumber,
                has_files: opts.seasonHasFiles ?? true,
            });
            await sql`
                INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                VALUES (${seriesId}::uuid, 'tmdb', ${seriesTmdbId}, ${opts.extIdMediaType}, true)
            `;
            return seasonId;
        };

        it('resolves the series TMDB id and season number', async () => {
            const seasonId = await setup({
                parentMediaType: 'tv',
                extIdMediaType: 'tv',
                seasonNumber: 1,
                seriesTmdbId: '63247',
            });

            const result = await getSeasonBackfillTarget(sql, seasonId);

            expect(result?.seriesTmdbId).toBe('63247');
            expect(result?.seasonNumber).toBe(1);
        });

        it('accepts season 0 (specials)', async () => {
            const seasonId = await setup({
                parentMediaType: 'tv',
                extIdMediaType: 'tv',
                seasonNumber: 0,
            });

            expect((await getSeasonBackfillTarget(sql, seasonId))?.seasonNumber).toBe(0);
        });

        it('rejects a NULL season_number', async () => {
            const seasonId = await setup({
                parentMediaType: 'tv',
                extIdMediaType: 'tv',
                seasonNumber: null,
            });

            expect(await getSeasonBackfillTarget(sql, seasonId)).toBeNull();
        });

        it('rejects a season under a non-tv parent', async () => {
            const seasonId = await setup({
                parentMediaType: 'home_video',
                extIdMediaType: 'tv',
                seasonNumber: 1,
            });

            expect(await getSeasonBackfillTarget(sql, seasonId)).toBeNull();
        });

        it('rejects a tmdb external id whose media_type is not tv (composite key)', async () => {
            const seasonId = await setup({
                parentMediaType: 'tv',
                extIdMediaType: 'movie',
                seasonNumber: 1,
            });

            expect(await getSeasonBackfillTarget(sql, seasonId)).toBeNull();
        });

        it('rejects a season with has_files = false', async () => {
            const seasonId = await setup({
                parentMediaType: 'tv',
                extIdMediaType: 'tv',
                seasonNumber: 1,
                seasonHasFiles: false,
            });

            expect(await getSeasonBackfillTarget(sql, seasonId)).toBeNull();
        });

        // `filterSeasonsWithBackfillTarget` guards the DIRECT enqueue path, which
        // never evaluates the stage's `eligibility.sql`. If it were LOOSER than
        // `getSeasonBackfillTarget` the executor would throw on what it admitted —
        // the prod 2026-07-30 circuit-breaker incident. Assert the two agree.
        describe('filterSeasonsWithBackfillTarget agrees with getSeasonBackfillTarget', () => {
            const cases: Array<{
                name: string;
                opts: Parameters<typeof setup>[0];
            }> = [
                {
                    name: 'eligible season',
                    opts: { parentMediaType: 'tv', extIdMediaType: 'tv', seasonNumber: 1 },
                },
                {
                    name: 'specials (season 0)',
                    opts: { parentMediaType: 'tv', extIdMediaType: 'tv', seasonNumber: 0 },
                },
                {
                    name: 'NULL season_number',
                    opts: { parentMediaType: 'tv', extIdMediaType: 'tv', seasonNumber: null },
                },
                {
                    name: 'non-tv parent',
                    opts: { parentMediaType: 'home_video', extIdMediaType: 'tv', seasonNumber: 1 },
                },
                {
                    name: 'wrong external-id media_type',
                    opts: { parentMediaType: 'tv', extIdMediaType: 'movie', seasonNumber: 1 },
                },
                {
                    name: 'has_files = false',
                    opts: {
                        parentMediaType: 'tv',
                        extIdMediaType: 'tv',
                        seasonNumber: 1,
                        seasonHasFiles: false,
                    },
                },
            ];

            for (const { name, opts } of cases) {
                it(name, async () => {
                    const seasonId = await setup(opts);
                    const executorAccepts = (await getSeasonBackfillTarget(sql, seasonId)) !== null;
                    const filterAccepts = (
                        await filterSeasonsWithBackfillTarget(sql, [seasonId])
                    ).includes(seasonId);

                    expect(filterAccepts).toBe(executorAccepts);
                });
            }
        });

        it('filterSeasonsWithBackfillTarget keeps only the eligible ids from a mixed batch', async () => {
            const eligible = await setup({
                parentMediaType: 'tv',
                extIdMediaType: 'tv',
                seasonNumber: 1,
            });
            const fileless = await setup({
                parentMediaType: 'tv',
                extIdMediaType: 'tv',
                seasonNumber: 0,
                seasonHasFiles: false,
            });

            const kept = await filterSeasonsWithBackfillTarget(sql, [eligible, fileless]);

            expect(kept).toEqual([eligible]);
        });

        it('filterSeasonsWithBackfillTarget short-circuits on an empty batch', async () => {
            expect(await filterSeasonsWithBackfillTarget(sql, [])).toEqual([]);
        });
    });

    describe('countProviderArtworkBacklog', () => {
        it('counts sweepable rows per stage and how many items own a file', async () => {
            const withFile = uuid();
            const withoutFile = uuid();
            await insertItem(sql, { id: withFile, media_type: 'movie' });
            await insertItem(sql, { id: withoutFile, media_type: 'season' });

            // media_files has NO `file_name` column — the columns are
            // (id, file_path, edition, part_number, …). See base-schema-sql.ts.
            const fileId = uuid();
            await sql`
                INSERT INTO media_files (id, file_path)
                VALUES (${fileId}::uuid, '/data/movies/A/a.mkv')
            `;
            await sql`
                INSERT INTO media_file_items (file_id, media_item_id)
                VALUES (${fileId}::uuid, ${withFile}::uuid)
            `;

            for (const [item, stage, status] of [
                [withFile, 'provider-artwork-poster', 'pending'],
                [withoutFile, 'provider-artwork-season-poster', 'pending'],
                [withFile, 'provider-artwork-logo', 'completed'],
            ] as const) {
                await sql`
                    INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status)
                    VALUES (${item}::uuid, ${stage}, 1, ${status})
                `;
            }

            const rows = await countProviderArtworkBacklog(sql, [
                'provider-artwork-poster',
                'provider-artwork-season-poster',
                'provider-artwork-logo',
            ]);
            const byStage = new Map(rows.map((r) => [r.stageId, r]));

            expect(byStage.get('provider-artwork-poster')).toEqual({
                stageId: 'provider-artwork-poster',
                pending: 1,
                withOwnFile: 1,
            });
            expect(byStage.get('provider-artwork-season-poster')).toEqual({
                stageId: 'provider-artwork-season-poster',
                pending: 1,
                withOwnFile: 0,
            });
            // `completed` is not sweepable, so the logo stage contributes nothing.
            expect(byStage.get('provider-artwork-logo')).toBeUndefined();
        });
    });
});
