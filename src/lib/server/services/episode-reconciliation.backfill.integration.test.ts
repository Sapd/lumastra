// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for proposal filtering (including the re-evaluation caller)
 * and `backfillReconcileSeries`'s Phase-3 still_path
 * backfill (C3, 2026-09-24 security review) - the `INSERT INTO
 * provider_metadata ... still_path` write for already identity-bound
 * episodes previously had NO `metadata_locked` guard at all, unlike the
 * sibling reconciliation writes in this file. Both the candidate query (`AND
 * NOT ep.metadata_locked`) and the write itself (routed through
 * `upsertProviderMetadataUnlessLocked`) were fixed; this file proves the
 * end-to-end behaviour against a real database.
 *
 * Run locally:
 *   npm run test:integration src/lib/server/services/episode-reconciliation.backfill.integration.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import postgres from 'postgres';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';
import { truncateAllTestTables } from '../../../../tests/integration/helpers/cleanup.js';

// Mock ONLY the TMDB client so loadTmdbCatalog returns a fixed catalog (no
// network) - same pattern as episode-reconciliation.apply.integration.test.ts.
const mockCatalogHolder = {
    episodes: [] as {
        id: number;
        name: string;
        overview: string;
        seasonNumber: number;
        episodeNumber: number;
        stillPath: string | null;
    }[],
};

vi.mock('$lib/server/providers/implementations/tmdb/index.js', async (importActual) => {
    const actual =
        await importActual<typeof import('$lib/server/providers/implementations/tmdb/index.js')>();
    const mockClient = {
        isAvailable: () => true,
        getTVShowSeasons: async () => [
            {
                seasonNumber: 1,
                episodeCount: mockCatalogHolder.episodes.length,
            },
        ],
        getSeasonEpisodes: async () => mockCatalogHolder.episodes,
        getSeasonEpisodesInLanguage: async () => [],
    };
    return {
        ...actual,
        tmdbApi: mockClient,
        createTMDBApi: () => mockClient,
    };
});

const URL = getTestDatabaseUrl();

describe('backfillReconcileSeries proposals and still_path locks (integration)', () => {
    let sql: postgres.Sql;
    beforeAll(async () => {
        sql = postgres(URL, { max: 2 });
        await truncateAllTestTables(sql);
    });
    afterAll(async () => {
        await sql.end();
    });

    it.each([
        ['chapters', 'Unrelated Zebra Adventure', 0],
        ['filename', 'Unrelated Zebra Adventure', 0],
        ['chapters', 'The Confident Matc', 1],
    ])('keeps only real proposals in quarantine (%s: %s)', async (source, signal, expected) => {
        const { backfillReconcileSeries, previewReconciliation, reevaluateQuarantineBacklog } =
            await import('./episode-reconciliation.service.js');
        mockCatalogHolder.episodes = [
            {
                id: 90201,
                name: 'The Confident Match',
                overview: 'O1',
                seasonNumber: 1,
                episodeNumber: 1,
                stillPath: null,
            },
        ];
        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('BackfillProposalTest', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
            VALUES (${seriesId}, 'tmdb', '990202', 'tv')`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;
        const [{ id: epId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
            VALUES ('Old title', 'episode', ${seasonId}, 1, 1, 'active') RETURNING id`;
        const [{ id: fileId }] = await sql<{ id: string }[]>`
            INSERT INTO media_files (file_path)
            VALUES (${`/test/${seriesId}/Show - S01E01 - ${signal}.mkv`}) RETURNING id`;
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
            VALUES (${epId}, ${fileId}, true)`;
        if (source === 'chapters') {
            await sql`INSERT INTO episode_chapters (file_id, chapter_index, chapter_name, start_ticks, source)
                VALUES (${fileId}, 0, ${signal}, 0, 'file')`;
        }
        try {
            const preview = await previewReconciliation(sql, seriesId, { threshold: 0.5 });
            expect(preview.proposals).toHaveLength(1);
            expect(preview.proposals[0].source).toBe(source);
            if (!expected) {
                expect(preview.proposals[0]).toMatchObject({
                    reason: 'below-threshold',
                    confidence: 0,
                    proposedTitle: null,
                    matchedTmdbEpisodeId: null,
                });
            } else {
                expect(preview.proposals[0].proposedTitle).toBe('The Confident Match');
                expect(preview.proposals[0].confidence).toBeLessThan(1);
            }
            // Re-running must not create noise.
            for (let run = 0; run < 2; run++) {
                const result = await backfillReconcileSeries(sql, seriesId, { minConfidence: 1 });
                expect(result.quarantined).toBe(expected);
            }
            const rows =
                await sql`SELECT * FROM sync_quarantine WHERE expected_series_id = ${seriesId}`;
            expect(rows).toHaveLength(expected);
            if (!expected) {
                // Re-evaluation closes historical no-proposal noise while retaining
                // the warning row and its original evidence.
                await sql`INSERT INTO sync_quarantine (provider, external_id, media_type, expected_series_id, reason, source, payload)
                    VALUES ('lumastra-reconcile', ${epId}, 'episode', ${seriesId}, 'reconcile-backfill:below-threshold', 'historic-fixture', '{"confidence":0}')`;
                const [before] =
                    await sql`SELECT * FROM sync_quarantine WHERE external_id = ${epId}`;
                const reeval = await reevaluateQuarantineBacklog(sql, { cap: 10 });
                expect(reeval.failedSeries).toBe(0);
                expect(reeval.seriesRevisited).toBe(1);
                const after =
                    await sql`SELECT * FROM sync_quarantine WHERE expected_series_id = ${seriesId}`;
                expect(after).toEqual([
                    {
                        ...before,
                        resolution: 'dismissed',
                        resolved_at: expect.any(Date),
                        resolved_by: 'reconciliation-backfill:reeval:superseded',
                    },
                ]);
            }
            const [watermark] =
                await sql`SELECT reconcile_backfill_at FROM media_items WHERE id = ${seriesId}`;
            expect(watermark.reconcile_backfill_at).toBeInstanceOf(Date);
        } finally {
            await sql`DELETE FROM sync_quarantine WHERE expected_series_id = ${seriesId}`;
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${epId})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
            await sql`DELETE FROM media_files WHERE id = ${fileId}`;
        }
    });

    it.each(['numbered tails', 'different heads', 'different durations', 'true duplicate'])(
        'uses live file evidence for duplicate quarantine: %s',
        async (shape) => {
            const { backfillReconcileSeries, previewReconciliation } =
                await import('./episode-reconciliation.service.js');
            const title = 'The Lantern Beneath the Lake';
            mockCatalogHolder.episodes = [
                {
                    id: 90202,
                    name: title,
                    overview: 'Fictional story',
                    seasonNumber: 1,
                    episodeNumber: 1,
                    stillPath: null,
                },
            ];
            const [{ id: seriesId }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, status)
                VALUES ('Lantern Patrol', 'tv', 'active') RETURNING id`;
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${seriesId}, 'tmdb', '990203', 'tv')`;
            const [{ id: seasonId }] = await sql<{ id: string }[]>`
                INSERT INTO media_items (title, media_type, parent_id, season_number, status)
                VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;
            const files: string[] = [];
            const episodes: string[] = [];
            try {
                for (let i = 1; i <= 2; i++) {
                    const [{ id: epId }] = await sql<{ id: string }[]>`
                        INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status)
                        VALUES (${`Episode ${i}`}, 'episode', ${seasonId}, 1, ${i}, 'active') RETURNING id`;
                    episodes.push(epId);
                    const number = shape === 'numbered tails' ? i : 1;
                    const hash =
                        shape === 'different heads' && i === 2 ? 'b'.repeat(64) : 'a'.repeat(64);
                    const duration = shape === 'different durations' && i === 2 ? 440 : 1785;
                    const [{ id: fileId }] = await sql<{ id: string }[]>`
                        INSERT INTO media_files (file_path, file_hash_head, duration_seconds, file_size_bytes)
                        VALUES (${`/fictional/${seriesId}/${i}/Lantern Patrol - S01E0${number} - ${title}.mkv`},
                            ${hash}, ${duration}, 12345678) RETURNING id`;
                    files.push(fileId);
                    await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default)
                        VALUES (${epId}, ${fileId}, true)`;
                }
                const preview = await previewReconciliation(sql, seriesId, { threshold: 0.5 });
                const duplicate = shape === 'true duplicate';
                expect(preview.proposals).toHaveLength(2);
                expect(
                    preview.proposals.every(
                        (p) => p.reason === (duplicate ? 'duplicate-match' : 'below-threshold'),
                    ),
                ).toBe(true);
                for (let run = 0; run < 2; run++) {
                    const result = await backfillReconcileSeries(sql, seriesId, {
                        minConfidence: 0.9,
                    });
                    expect(result.quarantined).toBe(duplicate ? 2 : 0);
                    expect(result.appliedExternalIds).toBe(0);
                    expect(result.updatedTitles).toBe(0);
                }
                const warnings = await sql`SELECT reason, payload FROM sync_quarantine
                    WHERE expected_series_id = ${seriesId}`;
                expect(warnings).toHaveLength(duplicate ? 2 : 0);
                for (const warning of warnings) {
                    expect(warning.reason).toBe('reconcile-backfill:duplicate-match');
                    expect(warning.payload).toMatchObject({
                        proposedTitle: title,
                        matchedTmdbEpisodeId: '90202',
                    });
                }
                const links = await sql`SELECT media_item_id, file_id FROM media_file_items
                    WHERE media_item_id = ANY(${episodes}::uuid[])`;
                expect(links).toHaveLength(2);
                const ids = await sql`SELECT external_id FROM external_ids
                    WHERE media_id = ANY(${episodes}::uuid[])`;
                expect(ids).toHaveLength(0);
            } finally {
                await sql`DELETE FROM sync_quarantine WHERE expected_series_id = ${seriesId}`;
                await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
                await sql`DELETE FROM media_files WHERE id = ANY(${files}::uuid[])`;
            }
        },
    );

    it('does NOT backfill still_path for a locked episode; DOES for an unlocked one already bound to the same catalog', async () => {
        const { backfillReconcileSeries } = await import('./episode-reconciliation.service.js');

        mockCatalogHolder.episodes = [
            {
                id: 90101,
                name: 'Locked Target',
                overview: 'O1',
                seasonNumber: 1,
                episodeNumber: 1,
                stillPath: '/still-90101.jpg',
            },
            {
                id: 90102,
                name: 'Unlocked Target',
                overview: 'O2',
                seasonNumber: 1,
                episodeNumber: 2,
                stillPath: '/still-90102.jpg',
            },
        ];

        const [{ id: seriesId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, status)
            VALUES ('BackfillStillLockTest', 'tv', 'active') RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${seriesId}, 'tmdb', '990201', 'tv', true)`;
        const [{ id: seasonId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, status)
            VALUES ('S1', 'season', ${seriesId}, 1, 'active') RETURNING id`;

        // Both episodes are already identity-bound to a catalog tmdb id (as if an
        // earlier run matched them before still-storage existed) and have NO
        // media_files, so Phase 1/2 (chapter-based reconciliation) has nothing to
        // do for them - only Phase 3 (the still-backfill loop) touches these rows.
        const [{ id: lockedEpId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, metadata_locked)
            VALUES ('Locked Target', 'episode', ${seasonId}, 1, 1, 'active', true) RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${lockedEpId}, 'tmdb', '90101', 'episode', true)`;

        const [{ id: unlockedEpId }] = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, status, metadata_locked)
            VALUES ('Unlocked Target', 'episode', ${seasonId}, 1, 2, 'active', false) RETURNING id`;
        await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
                  VALUES (${unlockedEpId}, 'tmdb', '90102', 'episode', true)`;

        try {
            await backfillReconcileSeries(sql, seriesId, { minConfidence: 0.9 });

            const [lockedPm] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${lockedEpId} AND provider = 'tmdb'`;
            const [unlockedPm] = await sql<{ metadata: Record<string, unknown> }[]>`
                SELECT metadata FROM provider_metadata WHERE media_id = ${unlockedEpId} AND provider = 'tmdb'`;

            expect(lockedPm).toBeUndefined();
            expect(unlockedPm.metadata.still_path).toBe('/still-90102.jpg');
        } finally {
            await sql`DELETE FROM provider_metadata WHERE media_id IN (${lockedEpId}, ${unlockedEpId})`;
            await sql`DELETE FROM external_ids WHERE media_id IN (${seriesId}, ${seasonId}, ${lockedEpId}, ${unlockedEpId})`;
            await sql`DELETE FROM media_items WHERE id = ${seriesId}`;
        }
    });
});
