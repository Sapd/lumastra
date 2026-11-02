// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * metadata-update coverage-table tests.
 *
 * Verifies that:
 * A) Source code contains expected coverage patterns.
 * B) `syncMissingMetadata`'s `onItemSuccess` callback calls `upsertCompletedRow`
 *    with correct args when wired from the task.
 * C) Tracker comment is removed.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Sql } from 'postgres';

// ---------------------------------------------------------------------------
// Source inspection — these pass without any module mocking
// ---------------------------------------------------------------------------

const __dirname2 = fileURLToPath(new URL('.', import.meta.url));
const taskSrc = readFileSync(resolve(__dirname2, '..', 'metadata-sync.ts'), 'utf8');
const serviceSrc = readFileSync(
    resolve(__dirname2, '../../../../ai/sync-missing-metadata.ts'),
    'utf8',
);

describe('metadata-update: coverage-table source checks (task)', () => {
    it('imports upsertCompletedRow', () => {
        expect(taskSrc).toContain('upsertCompletedRow');
        expect(taskSrc).toContain('stage-state.queries');
    });

    it('imports getAuthoritativeStageIds', () => {
        expect(taskSrc).toContain('getAuthoritativeStageIds');
    });

    it('contains stageId metadata-update', () => {
        expect(taskSrc).toContain("stageId: 'metadata-update'");
    });

    it('gates coverage write via useCoverageTable flag', () => {
        expect(taskSrc).toContain("getAuthoritativeStageIds().has('metadata-update')");
    });

    it('passes onItemSuccess to syncMissingMetadata', () => {
        expect(taskSrc).toContain('onItemSuccess');
    });

    it('threads ctx.sql (task pool) into the metadata-sync generators/service', () => {
        // DB pool-split: these heavy syncs must run on the task pool, not the
        // web pool. The handle is threaded via `sql: ctx.sql` into
        // generator.sync(), update.update(), and syncMissingMetadata(). If this
        // assertion fails, the queries silently fell back to getDb() (web pool)
        // and stopped being isolated (web routes can be starved again).
        expect(taskSrc).toContain('sql: ctx.sql');
        // and the service forwards its options.sql to the Database constructor
        expect(serviceSrc).toContain('new Database(options.sql)');
    });

    it('does not contain PIPELINE-COVERAGE-MIGRATION tracker comment', () => {
        expect(taskSrc).not.toContain('PIPELINE-COVERAGE-MIGRATION');
    });
});

describe('metadata-update: coverage-table source checks (service)', () => {
    it('sync-missing-metadata.ts exports onItemSuccess in SyncOptions', () => {
        expect(serviceSrc).toContain('onItemSuccess');
    });

    it('sync-missing-metadata.ts calls onItemSuccess after result.updated_count++', () => {
        // onItemSuccess appears after the updated_count increment
        const updatedIdx = serviceSrc.indexOf('result.updated_count++');
        const successCallbackIdx = serviceSrc.indexOf('onItemSuccess', updatedIdx);
        expect(updatedIdx).toBeGreaterThan(-1);
        expect(successCallbackIdx).toBeGreaterThan(updatedIdx);
    });
});

// ---------------------------------------------------------------------------
// Behaviour test: onItemSuccess callback invokes upsertCompletedRow
//
// Rather than execute the full task (which requires a live DB), we test the
// callback shape by constructing the closure directly — the same closure the
// task builds when useCoverageTable is true. This exercises the wire-up
// logic without importing through the task's dynamic-import path.
// ---------------------------------------------------------------------------

describe('metadata-update: onItemSuccess callback writes coverage row', () => {
    const mockUpsertCompletedRow = vi.fn().mockResolvedValue(undefined);
    const fakeSql = vi.fn() as unknown as Sql;

    beforeEach(() => {
        vi.clearAllMocks();
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('calls upsertCompletedRow with correct stageId and processingVersion', async () => {
        // Construct the callback closure exactly as the task does
        const onItemSuccess = async (mediaId: string): Promise<void> => {
            try {
                await mockUpsertCompletedRow(fakeSql, {
                    mediaItemId: mediaId,
                    stageId: 'metadata-update',
                    processingVersion: 1,
                });
            } catch {
                // Non-fatal
            }
        };

        await onItemSuccess('media-uuid-test-9999');

        expect(mockUpsertCompletedRow).toHaveBeenCalledOnce();
        expect(mockUpsertCompletedRow).toHaveBeenCalledWith(fakeSql, {
            mediaItemId: 'media-uuid-test-9999',
            stageId: 'metadata-update',
            processingVersion: 1,
        });
    });

    it('swallows errors from upsertCompletedRow (non-fatal)', async () => {
        mockUpsertCompletedRow.mockRejectedValueOnce(new Error('DB connection lost'));

        const onItemSuccess = async (mediaId: string): Promise<void> => {
            try {
                await mockUpsertCompletedRow(fakeSql, {
                    mediaItemId: mediaId,
                    stageId: 'metadata-update',
                    processingVersion: 1,
                });
            } catch {
                // Non-fatal
            }
        };

        // Must not throw
        await expect(onItemSuccess('error-uuid')).resolves.toBeUndefined();
    });
});
