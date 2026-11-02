// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for Trickplay Params Query Module
 *
 * Tests getTrickplayParams, getTrickplayParamsByWidth, upsertTrickplayParams,
 * deleteTrickplayParams, getItemsWithoutTrickplayParams, getTrickplayBacklogCounts,
 * markTrickplayItemTried, findCoverageTableBacklog, toTrickplayInfo.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import { createAndInsertTestMovie } from '../../../../../tests/integration/fixtures/index.js';
import { countSweepBacklog } from './stage-sweep.queries.js';
import { invalidateFileProbeData } from './media-files.queries.js';
import { getTaskLaneData } from '../../tasks/lane-data.js';
import { buildAdminContextStub } from '../../tasks/plugin-context.js';
import { trickplayParamsSyncTask } from '../../tasks/builtin/native/trickplay-params-sync.js';
import { resetTrickplayDisplayCounts } from '../../services/trickplay-coverage.service.js';

import {
    getTrickplayParams,
    getTrickplayAvailability,
    getTrickplayParamsByWidth,
    upsertTrickplayParams,
    deleteTrickplayParams,
    getItemsWithoutTrickplayParams,
    getTrickplayBacklogCounts,
    markTrickplayItemTried,
    findCoverageTableBacklog,
    reconcileTrickplayCoverageRows,
    resetObsoleteTrickplayCoverage,
    toTrickplayInfo,
} from './trickplay-params.queries.js';

describe('Trickplay Params Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'trickplay_params',
            'media_item_stage_state',
            ...TEST_TABLES.mediaFiles,
            ...TEST_TABLES.media,
        ]);
    });

    async function createMovieWithFile(
        options: Parameters<typeof createAndInsertTestMovie>[1] = {},
    ): Promise<{ mediaId: string; fileId: string }> {
        const { id: mediaId } = await createAndInsertTestMovie(sql, {
            ...options,
            withFileItem: true,
        });

        const [fileRow] = await sql<{ file_id: string }[]>`
            SELECT file_id FROM media_file_items WHERE media_item_id = ${mediaId}::uuid LIMIT 1
        `;
        return { mediaId, fileId: fileRow!.file_id };
    }

    it('does not advertise another file widths on a completed item', async () => {
        const { mediaId, fileId } = await createMovieWithFile();
        const other = await createMovieWithFile();
        await sql`INSERT INTO media_file_items (media_item_id, file_id, is_default) VALUES (${mediaId}, ${other.fileId}, false)`;
        await upsertTrickplayParams(sql, mediaId, fileId, [
            {
                width: 320,
                height: 180,
                intervalMs: 1000,
                tileWidth: 10,
                tileHeight: 10,
                thumbnailCount: 100,
                bandwidth: 500,
                source: 'local',
            },
        ]);
        await sql`INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version) VALUES (${mediaId}, 'trickplay-generation', 'completed', 1)`;
        expect(
            await getTrickplayAvailability(sql, mediaId, 'trickplay-generation', 1, fileId),
        ).toEqual({ state: 'ready', widths: [320] });
        expect(
            await getTrickplayAvailability(sql, mediaId, 'trickplay-generation', 1, other.fileId),
        ).toEqual({ state: 'pending', widths: [], needsRepair: true });
    });

    // ========================================================================
    // getTrickplayParams
    // ========================================================================

    describe('getTrickplayParams', () => {
        it('returns params for media item ordered by width', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'jellyfin',
                },
                {
                    width: 640,
                    height: 360,
                    intervalMs: 2000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 50,
                    bandwidth: 1000,
                    source: 'jellyfin',
                },
            ]);

            const rows = await getTrickplayParams(sql, mediaId, fileId);

            expect(rows).toHaveLength(2);
            expect(rows[0].width).toBe(320);
            expect(rows[1].width).toBe(640);
        });

        it('filters by fileId when provided', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'jellyfin',
                },
            ]);

            const rows = await getTrickplayParams(sql, mediaId, fileId);
            expect(rows).toHaveLength(1);

            const rowsNoFilter = await getTrickplayParams(sql, mediaId, null);
            expect(rowsNoFilter).toHaveLength(1);
        });

        it('returns empty array when no params exist', async () => {
            const { mediaId } = await createMovieWithFile();
            const rows = await getTrickplayParams(sql, mediaId);
            expect(rows).toEqual([]);
        });
    });

    // ========================================================================
    // getTrickplayParamsByWidth
    // ========================================================================

    describe('getTrickplayParamsByWidth', () => {
        it('returns specific width param', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'jellyfin',
                },
            ]);

            const row = await getTrickplayParamsByWidth(sql, mediaId, 320, fileId);
            expect(row).not.toBeNull();
            expect(row!.height).toBe(180);
        });

        it('returns null for missing width', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            const row = await getTrickplayParamsByWidth(sql, mediaId, 999, fileId);
            expect(row).toBeNull();
        });
    });

    // ========================================================================
    // upsertTrickplayParams
    // ========================================================================

    describe('upsertTrickplayParams', () => {
        it('no-ops for empty params', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await expect(upsertTrickplayParams(sql, mediaId, fileId, [])).resolves.toBeUndefined();
        });

        it('updates on conflict', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'jellyfin',
                },
            ]);

            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 200,
                    intervalMs: 1500,
                    tileWidth: 12,
                    tileHeight: 12,
                    thumbnailCount: 120,
                    bandwidth: 600,
                    source: 'jellyfin',
                },
            ]);

            const row = await getTrickplayParamsByWidth(sql, mediaId, 320, fileId);
            expect(row!.height).toBe(200);
            expect(row!.bandwidth).toBe(600);
        });
    });

    // ========================================================================
    // deleteTrickplayParams
    // ========================================================================

    describe('deleteTrickplayParams', () => {
        it('deletes params for media item', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'jellyfin',
                },
            ]);

            await deleteTrickplayParams(sql, mediaId, fileId);

            const rows = await getTrickplayParams(sql, mediaId, fileId);
            expect(rows).toHaveLength(0);
        });

        it('deletes all params when fileId omitted', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'jellyfin',
                },
            ]);

            await deleteTrickplayParams(sql, mediaId);

            const rows = await getTrickplayParams(sql, mediaId);
            expect(rows).toHaveLength(0);
        });
    });

    // ========================================================================
    // getItemsWithoutTrickplayParams
    // ========================================================================

    describe('getItemsWithoutTrickplayParams', () => {
        it('returns items lacking trickplay params', async () => {
            const { mediaId, fileId: _fileId } = await createMovieWithFile();

            const rows = await getItemsWithoutTrickplayParams(sql, 10, 1);
            const ids = rows.map((r) => r.id);

            expect(ids).toContain(mediaId);
        });

        it('excludes items that already have params', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'jellyfin',
                },
            ]);

            const rows = await getItemsWithoutTrickplayParams(sql, 10, 1);
            const ids = rows.map((r) => r.id);

            expect(ids).not.toContain(mediaId);
        });

        it('respects processing_version marker', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await markTrickplayItemTried(sql, mediaId, fileId, 1, 'no-provider', 'no source', 200);

            const rows = await getItemsWithoutTrickplayParams(sql, 10, 1);
            expect(rows.map((r) => r.id)).not.toContain(mediaId);

            // Bump version re-admits item
            const rowsV2 = await getItemsWithoutTrickplayParams(sql, 10, 2);
            expect(rowsV2.map((r) => r.id)).toContain(mediaId);
        });
    });

    // ========================================================================
    // getTrickplayBacklogCounts
    // ========================================================================

    describe('getTrickplayBacklogCounts', () => {
        it('returns analyzed, remaining, ineligible, failed', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'jellyfin',
                },
            ]);

            const counts = await getTrickplayBacklogCounts(sql, 1);
            expect(counts.analyzed).toBeGreaterThanOrEqual(1);
            expect(counts.remaining).toBeGreaterThanOrEqual(0);
        });
    });

    // ========================================================================
    // markTrickplayItemTried
    // ========================================================================

    describe('markTrickplayItemTried', () => {
        it('marks item as no-provider', async () => {
            const { mediaId, fileId } = await createMovieWithFile();

            const ok = await markTrickplayItemTried(
                sql,
                mediaId,
                fileId,
                1,
                'no-provider',
                'No Jellyfin trickplay available',
                200,
            );

            expect(ok).toBe(true);

            const rows = await getItemsWithoutTrickplayParams(sql, 10, 1);
            expect(rows.map((r) => r.id)).not.toContain(mediaId);
        });

        it('truncates long reasons', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            const longReason = 'x'.repeat(500);

            await markTrickplayItemTried(sql, mediaId, fileId, 1, 'error', longReason, 50);

            const [row] = await sql`
                SELECT processing_state->${`trickplay-params:${fileId}`} as marker
                FROM media_items WHERE id = ${mediaId}::uuid
            `;
            expect((row!.marker as { reason: string }).reason.endsWith('…')).toBe(true);
        });

        it('returns false on DB failure for non-existent item', async () => {
            const ok = await markTrickplayItemTried(
                sql,
                '00000000-0000-0000-0000-000000000000',
                '00000000-0000-0000-0000-000000000000',
                1,
                'error',
                'fail',
                200,
            );
            expect(ok).toBe(false);
        });
    });

    // ========================================================================
    // findCoverageTableBacklog
    // ========================================================================

    describe('findCoverageTableBacklog', () => {
        it('returns items from media_item_stage_state', async () => {
            const { mediaId, fileId: _fileId } = await createMovieWithFile();
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, status, processing_version)
                VALUES (${mediaId}::uuid, 'trickplay-params-sync', 'pending', 1)
            `;

            const rows = await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, 1);

            expect(rows.map((r) => r.id)).toContain(mediaId);
        });
    });

    describe('current linked-file coverage', () => {
        const version = trickplayParamsSyncTask.processingVersion;

        async function addAlternateFile(mediaId: string): Promise<string> {
            const other = await createMovieWithFile();
            await sql`
                INSERT INTO media_file_items (media_item_id, file_id, is_default)
                VALUES (${mediaId}::uuid, ${other.fileId}::uuid, false)
            `;
            await sql`DELETE FROM media_file_items WHERE media_item_id = ${other.mediaId}::uuid`;
            return other.fileId;
        }

        async function insertObsolete(mediaId: string, status = 'obsolete'): Promise<void> {
            await sql`
                INSERT INTO media_item_stage_state
                    (media_item_id, stage_id, status, processing_version)
                VALUES (${mediaId}::uuid, 'trickplay-params-sync', ${status}, ${version})
            `;
        }

        // The admin lane reads a 30 s display cache per pool; each test needs a fresh count.
        beforeEach(() => resetTrickplayDisplayCounts(sql));

        async function overviewCount(): Promise<number> {
            const lanes = await getTaskLaneData(
                ['trickplay-params-sync'],
                new Map([['trickplay-params-sync', ['trickplay-params-sync']]]),
                sql,
            );
            return lanes?.get('trickplay-params-sync')?.backlogRemaining ?? -1;
        }

        it.each(['completed', 'skipped_permanent'] as const)(
            'resets decline evidence when linked coverage becomes %s',
            async (status) => {
                const { mediaId, fileId } = await createMovieWithFile();
                await insertObsolete(mediaId, 'pending');
                await sql`UPDATE media_item_stage_state
                    SET declines = 4, declines_since = now() - interval '2 days'
                    WHERE media_item_id = ${mediaId}::uuid AND stage_id = 'trickplay-params-sync'`;
                // Unprocessed files must keep their decline evidence.
                expect(await reconcileTrickplayCoverageRows(sql, version, 10, mediaId)).toBe(0);
                const [before] = await sql<
                    { declines: number }[]
                >`SELECT declines FROM media_item_stage_state
                    WHERE media_item_id = ${mediaId}::uuid AND stage_id = 'trickplay-params-sync'`;
                expect(before?.declines).toBe(4);
                if (status === 'completed') {
                    await upsertTrickplayParams(sql, mediaId, fileId, [
                        {
                            width: 320,
                            height: 180,
                            intervalMs: 1000,
                            tileWidth: 10,
                            tileHeight: 10,
                            thumbnailCount: 100,
                            bandwidth: 500,
                            source: 'local',
                        },
                    ]);
                } else {
                    await markTrickplayItemTried(
                        sql,
                        mediaId,
                        fileId,
                        version,
                        'no-provider',
                        'none',
                        100,
                    );
                }
                expect(await reconcileTrickplayCoverageRows(sql, version, 10, mediaId)).toBe(1);
                const [after] = await sql<
                    { status: string; declines: number; declines_since: Date | null }[]
                >`
                    SELECT status, declines, declines_since FROM media_item_stage_state
                    WHERE media_item_id = ${mediaId}::uuid AND stage_id = 'trickplay-params-sync'`;
                expect(after).toEqual({ status, declines: 0, declines_since: null });
            },
        );

        it('keeps Overview and registered Backlog at zero when every linked file is terminal', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            const alternateFileId = await addAlternateFile(mediaId);
            await insertObsolete(mediaId, 'pending');
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'local',
                },
            ]);
            await markTrickplayItemTried(
                sql,
                mediaId,
                alternateFileId,
                version,
                'no-provider',
                'none',
                100,
            );

            expect(await countSweepBacklog(sql, 'trickplay-params-sync')).toBe(1);
            expect(await overviewCount()).toBe(0);
            const stages = await trickplayParamsSyncTask.backlog!.stages(
                buildAdminContextStub('trickplay-params', { sql }) as Parameters<
                    typeof trickplayParamsSyncTask.execute
                >[0],
            );
            expect(stages.find((stage) => stage.id === 'remaining')).toBeUndefined();
            expect(stages.find((stage) => stage.id === 'ineligible')?.count).toBe(1);
            expect(
                await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version),
            ).toEqual([]);
            await trickplayParamsSyncTask.execute(
                buildAdminContextStub('trickplay-params', { sql }) as Parameters<
                    typeof trickplayParamsSyncTask.execute
                >[0],
            );
            expect(await countSweepBacklog(sql, 'trickplay-params-sync')).toBe(0);
        });

        it('keeps a runnable alternate visible despite sibling params or terminal markers', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            const alternateFileId = await addAlternateFile(mediaId);
            await insertObsolete(mediaId, 'pending');
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'local',
                },
            ]);

            expect(await overviewCount()).toBe(1);
            expect(
                (await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version)).map(
                    (item) => item.fileId,
                ),
            ).toEqual([alternateFileId]);

            await sql`
                UPDATE media_items SET processing_state = jsonb_set(
                    COALESCE(processing_state, '{}'::jsonb),
                    ARRAY[${`trickplay-params:${alternateFileId}`}],
                    ${sql.json({ version: 'malformed', status: 'no-provider' })}
                ) WHERE id = ${mediaId}::uuid
            `;
            expect(
                (await getItemsWithoutTrickplayParams(sql, 10, version)).map((item) => item.fileId),
            ).toContain(alternateFileId);
            expect((await getTrickplayBacklogCounts(sql, version)).remaining).toBe(1);
            expect(await reconcileTrickplayCoverageRows(sql, version, 10)).toBe(0);
            expect(await countSweepBacklog(sql, 'trickplay-params-sync')).toBe(1);
        });

        it('requires linked sibling evidence before reading through a terminal item row', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            const alternateFileId = await addAlternateFile(mediaId);
            await sql`
                INSERT INTO media_item_stage_state
                    (media_item_id, stage_id, status, processing_version)
                VALUES (${mediaId}::uuid, 'trickplay-params-sync', 'completed', ${version})
            `;

            expect(
                await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version),
            ).toEqual([]);

            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'local',
                },
            ]);
            expect(
                (await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version)).map(
                    (item) => item.fileId,
                ),
            ).toEqual([alternateFileId]);

            await sql`
                UPDATE media_item_stage_state
                   SET status = 'skipped_permanent', skipped_reason = 'no-provider'
                 WHERE media_item_id = ${mediaId}::uuid
                   AND stage_id = 'trickplay-params-sync'
            `;
            await deleteTrickplayParams(sql, mediaId, fileId);
            await markTrickplayItemTried(sql, mediaId, fileId, version, 'no-provider', 'none', 100);
            expect(
                (await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version)).map(
                    (item) => item.fileId,
                ),
            ).toEqual([alternateFileId]);
        });

        it('reopens automatic all-terminal rows for a new version or new linked file', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await insertObsolete(mediaId, 'pending');
            await markTrickplayItemTried(sql, mediaId, fileId, version, 'no-provider', 'none', 100);
            expect(await reconcileTrickplayCoverageRows(sql, version, 10)).toBe(1);
            const [stage] = await sql<{ status: string; skipped_reason: string }[]>`
                SELECT status, skipped_reason FROM media_item_stage_state
                 WHERE media_item_id = ${mediaId}::uuid
                   AND stage_id = 'trickplay-params-sync'
            `;
            expect(stage).toMatchObject({
                status: 'skipped_permanent',
                skipped_reason: 'all-linked-files-terminal',
            });
            expect(
                await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version),
            ).toEqual([]);

            expect(
                (await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version + 1)).map(
                    (item) => item.fileId,
                ),
            ).toEqual([fileId]);

            const alternateFileId = await addAlternateFile(mediaId);
            expect(
                (await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version)).map(
                    (item) => item.fileId,
                ),
            ).toEqual([alternateFileId]);
        });

        it('keeps future and manual terminal rows out of coverage fetch', async () => {
            const { mediaId } = await createMovieWithFile();
            await sql`
                INSERT INTO media_item_stage_state
                    (media_item_id, stage_id, status, processing_version, skipped_reason)
                VALUES (${mediaId}::uuid, 'trickplay-params-sync',
                    'skipped_permanent', ${version + 1}, 'all-linked-files-terminal')
            `;
            expect(
                await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version),
            ).toEqual([]);
            await sql`
                UPDATE media_item_stage_state
                   SET processing_version = ${version}, skipped_reason = 'manual'
                 WHERE media_item_id = ${mediaId}::uuid
                   AND stage_id = 'trickplay-params-sync'
            `;
            expect(
                await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version),
            ).toEqual([]);
        });

        it('treats oversized numeric marker versions as runnable', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await insertObsolete(mediaId, 'pending');
            await sql`
                UPDATE media_items SET processing_state = jsonb_set(
                    COALESCE(processing_state, '{}'::jsonb),
                    ARRAY[${`trickplay-params:${fileId}`}],
                    ${sql.json({ version: '9'.repeat(200_000), status: 'no-provider' })}
                ) WHERE id = ${mediaId}::uuid
            `;
            expect(
                (await getItemsWithoutTrickplayParams(sql, 10, version)).map((item) => item.fileId),
            ).toContain(fileId);
            expect(
                (await findCoverageTableBacklog(sql, 'trickplay-params-sync', 10, version)).map(
                    (item) => item.fileId,
                ),
            ).toContain(fileId);
            expect((await getTrickplayBacklogCounts(sql, version)).remaining).toBe(1);
        });

        it('invalidates shared changed-file evidence without erasing alternate-file success', async () => {
            const { mediaId, fileId: alternateFileId } = await createMovieWithFile();
            const { mediaId: otherMediaId, fileId: changedFileId } = await createMovieWithFile();
            await sql`
                INSERT INTO media_file_items (media_item_id, file_id, is_default)
                VALUES (${mediaId}::uuid, ${changedFileId}::uuid, false)
            `;
            const params = [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'local',
                },
            ];
            await upsertTrickplayParams(sql, mediaId, alternateFileId, params);
            await upsertTrickplayParams(sql, mediaId, changedFileId, params);
            await upsertTrickplayParams(sql, otherMediaId, changedFileId, params);
            await markTrickplayItemTried(
                sql,
                mediaId,
                alternateFileId,
                version,
                'error',
                'old error',
                100,
            );
            await markTrickplayItemTried(
                sql,
                mediaId,
                changedFileId,
                version,
                'no-provider',
                'old source',
                100,
            );
            await markTrickplayItemTried(
                sql,
                otherMediaId,
                changedFileId,
                version,
                'no-provider',
                'old source',
                100,
            );

            await invalidateFileProbeData(sql, changedFileId);

            expect(await getTrickplayParams(sql, mediaId, alternateFileId)).toHaveLength(1);
            expect(await getTrickplayParams(sql, mediaId, changedFileId)).toEqual([]);
            expect(await getTrickplayParams(sql, otherMediaId, changedFileId)).toEqual([]);
            expect(
                (await getItemsWithoutTrickplayParams(sql, 10, version))
                    .map((item) => `${item.id}|${item.fileId}`)
                    .sort(),
            ).toEqual([`${mediaId}|${changedFileId}`, `${otherMediaId}|${changedFileId}`].sort());
            const [state] = await sql<{ processing_state: Record<string, unknown> }[]>`
                SELECT processing_state FROM media_items WHERE id = ${mediaId}::uuid
            `;
            expect(state.processing_state[`trickplay-params:${alternateFileId}`]).toBeDefined();
            expect(state.processing_state[`trickplay-params:${changedFileId}`]).toBeUndefined();
        });

        it('does not certify obsolete source from old params or current-version markers', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            const alternateFileId = await addAlternateFile(mediaId);
            await insertObsolete(mediaId);
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'local',
                },
            ]);
            await markTrickplayItemTried(
                sql,
                mediaId,
                alternateFileId,
                version,
                'no-provider',
                'old source',
                100,
            );

            expect(await getTrickplayBacklogCounts(sql, version)).toMatchObject({
                analyzed: 0,
                remaining: 2,
                ineligible: 0,
            });
            expect(await overviewCount()).toBe(2);
            expect(await reconcileTrickplayCoverageRows(sql, version, 10)).toBe(0);
            expect(await countSweepBacklog(sql, 'trickplay-params-sync')).toBe(1);

            expect(await resetObsoleteTrickplayCoverage(sql, 10, version)).toBe(1);
            expect(await getTrickplayParams(sql, mediaId, fileId)).toEqual([]);
            expect(
                (await getItemsWithoutTrickplayParams(sql, 10, version))
                    .map((item) => item.fileId)
                    .sort(),
            ).toEqual([fileId, alternateFileId].sort());
            expect(await getTrickplayBacklogCounts(sql, version)).toMatchObject({
                analyzed: 0,
                remaining: 2,
                ineligible: 0,
            });
        });

        it('registered catchup rechecks obsolete source instead of accepting cached params', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await insertObsolete(mediaId);
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'stale',
                },
            ]);
            expect((await getTrickplayBacklogCounts(sql, version)).remaining).toBe(1);

            await trickplayParamsSyncTask.execute(
                buildAdminContextStub('trickplay-params', { sql }) as Parameters<
                    typeof trickplayParamsSyncTask.execute
                >[0],
            );

            expect(
                (await getTrickplayParams(sql, mediaId, fileId)).some(
                    (param) => param.source === 'stale',
                ),
            ).toBe(false);
            expect(await countSweepBacklog(sql, 'trickplay-params-sync')).toBe(0);
        });

        it('does not reset coverage written by a future processing version', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await sql`
                INSERT INTO media_item_stage_state
                    (media_item_id, stage_id, status, processing_version)
                VALUES (${mediaId}::uuid, 'trickplay-params-sync', 'obsolete', ${version + 1})
            `;
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'future',
                },
            ]);

            expect(await resetObsoleteTrickplayCoverage(sql, 10, version)).toBe(0);
            expect((await getTrickplayParams(sql, mediaId, fileId)).length).toBe(1);
        });

        it('reopens changed file work before obsolete coverage can be reconciled', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            const alternateFileId = await addAlternateFile(mediaId);
            await insertObsolete(mediaId);
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'local',
                },
            ]);
            await markTrickplayItemTried(
                sql,
                mediaId,
                fileId,
                version,
                'no-provider',
                'old source',
                100,
            );
            await markTrickplayItemTried(
                sql,
                mediaId,
                alternateFileId,
                version,
                'no-provider',
                'other source',
                100,
            );

            await invalidateFileProbeData(sql, fileId);

            expect(await getTrickplayParams(sql, mediaId, fileId)).toEqual([]);
            expect(
                (await getItemsWithoutTrickplayParams(sql, 10, version)).map((item) => item.fileId),
            ).toEqual([fileId]);
            expect(await getTrickplayBacklogCounts(sql, version)).toMatchObject({
                remaining: 2,
                ineligible: 0,
            });
            expect(await reconcileTrickplayCoverageRows(sql, version, 10)).toBe(0);
            expect(await countSweepBacklog(sql, 'trickplay-params-sync')).toBe(1);
        });
    });

    // ========================================================================
    // toTrickplayInfo
    // ========================================================================

    describe('toTrickplayInfo', () => {
        it('converts row to TrickplayInfo shape', async () => {
            const { mediaId, fileId } = await createMovieWithFile();
            await upsertTrickplayParams(sql, mediaId, fileId, [
                {
                    width: 320,
                    height: 180,
                    intervalMs: 1000,
                    tileWidth: 10,
                    tileHeight: 10,
                    thumbnailCount: 100,
                    bandwidth: 500,
                    source: 'jellyfin',
                },
            ]);

            const rows = await getTrickplayParams(sql, mediaId, fileId);
            const info = toTrickplayInfo(rows[0]);

            expect(info.width).toBe(320);
            expect(info.height).toBe(180);
            expect(info.interval).toBe(1000);
            expect(info.thumbnailCount).toBe(100);
        });
    });
});
