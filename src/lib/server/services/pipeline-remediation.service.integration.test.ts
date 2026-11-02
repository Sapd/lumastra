// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for `PipelineRemediationService` (Slice 2).
 *
 * `resetFailed` runs against real Postgres and asserts it touches ONLY
 * `failed_permanent` rows (item- and stage-scoped). `reevaluate` is exercised
 * with a stubbed StageStateService so we assert it computes the
 * eligible/skipped split and forwards exactly the eligible stage ids to the
 * existing `eagerEnqueueForStages` primitive (no real orchestrator enqueue).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { z } from 'zod';
import type postgres from 'postgres';
import { defineTask } from '@sapd/lumastra-plugin-sdk';
import { TaskRegistry } from '$lib/server/tasks/registry.js';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import {
    insertPendingRow,
    markFailedPermanent,
    findRowsByItem,
} from '$lib/server/database/queries/stage-state.queries.js';
import { PipelineRemediationService } from '$lib/server/services/pipeline-remediation.service.js';
import type { MediaItemSnapshot } from '$lib/types/pipeline.js';

function makeRegistry(): TaskRegistry {
    const reg = new TaskRegistry();
    reg.registerTask(
        defineTask({
            id: 'probe-task',
            name: 'Probe',
            version: '1.0.0',
            processingVersion: 1,
            minAppVersion: '1.0.0',
            capabilities: {},
            resourceClass: 'ingest',
            inputSchema: z.object({ mediaItemId: z.string().optional() }),
            identityFor: (i) => i.mediaItemId ?? 'global',
            coversStages: [
                // eligible + enqueueable
                {
                    id: 'eligible',
                    appliesTo: ['movie'],
                    enqueueable: true,
                    terminalDisposition: {
                        kind: 'self-terminal',
                        ruleId: 'eligible-terminal',
                    },
                },
                // appliesTo false → ineligible (reevaluate counts it as skipped)
                {
                    id: 'ineligible',
                    appliesTo: ['movie'],
                    enqueueable: true,
                    eligibility: { appliesTo: () => false },
                    terminalDisposition: {
                        kind: 'self-terminal',
                        ruleId: 'ineligible-terminal',
                    },
                },
                // eligible but NOT enqueueable → counted as skipped
                { id: 'descriptive', appliesTo: ['movie'], enqueueable: false },
            ],
            async execute() {
                return { success: true };
            },
        }),
    );
    return reg;
}

async function insertTestMediaItem(sql: postgres.Sql): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, media_type, title)
        VALUES (${id}::uuid, 'movie', ${'Test ' + id.slice(0, 6)})
    `;
    return id;
}

/** A re-identify row is a BROKEN match: the item was matched once. */
async function markMatched(sql: postgres.Sql, mediaItemId: string): Promise<void> {
    await sql`
        INSERT INTO external_ids (media_id, provider, external_id, media_type, is_primary)
        VALUES (${mediaItemId}::uuid, 'tmdb',
                ${String(90_000_000 + Math.floor(Math.random() * 9_000_000))}, 'movie', true)
    `;
}

const SNAP: MediaItemSnapshot = {
    id: 'x',
    media_type: 'movie',
    has_audio: true,
    has_video: true,
    has_file: true,
    runtime_seconds: 100,
    provider_tmdb_id: 1,
    provider_imdb_id: null,
    provider_musicbrainz_id: null,
    added_at: new Date(),
};

describe('PipelineRemediationService', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await sql`TRUNCATE media_item_stage_state CASCADE`;
        await sql`DELETE FROM media_items WHERE title LIKE 'Test %'`;
    });

    describe('resetFailed', () => {
        it('resets only failed_permanent rows for the item', async () => {
            const itemId = await insertTestMediaItem(sql);
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 'a',
                processingVersion: 1,
            });
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 'b',
                processingVersion: 1,
            });
            await markFailedPermanent(sql, {
                mediaItemId: itemId,
                stageId: 'a',
                error: { message: 'x' },
            });

            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
            });
            const { reset } = await svc.resetFailed(itemId);
            expect(reset).toBe(1);

            const rows = await findRowsByItem(sql, itemId);
            expect(rows.find((r) => r.stage_id === 'a')?.status).toBe('pending');
            // 'b' was pending and untouched.
            expect(rows.find((r) => r.stage_id === 'b')?.status).toBe('pending');
        });

        it('scopes reset to a single stage when stageId given', async () => {
            const itemId = await insertTestMediaItem(sql);
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 'a',
                processingVersion: 1,
            });
            await insertPendingRow(sql, {
                mediaItemId: itemId,
                stageId: 'b',
                processingVersion: 1,
            });
            await markFailedPermanent(sql, {
                mediaItemId: itemId,
                stageId: 'a',
                error: { message: 'x' },
            });
            await markFailedPermanent(sql, {
                mediaItemId: itemId,
                stageId: 'b',
                error: { message: 'y' },
            });

            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
            });
            const { reset } = await svc.resetFailed(itemId, 'a');
            expect(reset).toBe(1);

            const rows = await findRowsByItem(sql, itemId);
            expect(rows.find((r) => r.stage_id === 'a')?.status).toBe('pending');
            expect(rows.find((r) => r.stage_id === 'b')?.status).toBe('failed_permanent');
        });
    });

    describe('resetFailedForStage', () => {
        // The sonic backfill keeps its give-up counter in media_audio_embedding_state, not in
        // media_item_stage_state, so "Retry all failed items" on its task page reset nothing
        // and every track it had given up on stayed written off.
        it('makes given-up sonic embeddings eligible again for sonic-embedding-backfill', async () => {
            const givenUp = await insertTestMediaItem(sql);
            const done = await insertTestMediaItem(sql);
            await sql`
                INSERT INTO media_audio_embedding_state (media_id, model_id, status, processing_version, attempts)
                VALUES (${givenUp}::uuid, 'msclap-2023', 'failed', 1, 3),
                       (${done}::uuid, 'msclap-2023', 'done', 1, 0)
            `;

            const svc = new PipelineRemediationService(sql, { registry: makeRegistry() });
            const reset = await svc.resetFailedForStage('sonic-embedding-backfill');
            expect(reset).toBe(1);

            const rows = await sql<{ media_id: string; status: string; attempts: number }[]>`
                SELECT media_id::text, status, attempts FROM media_audio_embedding_state
                WHERE media_id IN (${givenUp}::uuid, ${done}::uuid)
            `;
            expect(rows.find((r) => r.media_id === givenUp)).toMatchObject({
                status: 'failed',
                attempts: 0,
            });
            expect(rows.find((r) => r.media_id === done)).toMatchObject({
                status: 'done',
                attempts: 0,
            });
        });

        it('leaves sonic embedding state alone for other stages', async () => {
            const givenUp = await insertTestMediaItem(sql);
            await sql`
                INSERT INTO media_audio_embedding_state (media_id, model_id, status, processing_version, attempts)
                VALUES (${givenUp}::uuid, 'msclap-2023', 'failed', 1, 3)
            `;

            const svc = new PipelineRemediationService(sql, { registry: makeRegistry() });
            expect(await svc.resetFailedForStage('a')).toBe(0);

            const [row] = await sql<{ attempts: number }[]>`
                SELECT attempts FROM media_audio_embedding_state WHERE media_id = ${givenUp}::uuid
            `;
            expect(row?.attempts).toBe(3);
        });
    });

    describe('acceptReidentifyForStage', () => {
        it('accepts only non-retryable (permanent) dead-letters, leaving transient ones', async () => {
            const permanentItem = await insertTestMediaItem(sql);
            const transientItem = await insertTestMediaItem(sql);
            await insertPendingRow(sql, {
                mediaItemId: permanentItem,
                stageId: 'a',
                processingVersion: 1,
            });
            await insertPendingRow(sql, {
                mediaItemId: transientItem,
                stageId: 'a',
                processingVersion: 1,
            });
            // Permanent: a classified-permanent failure (e.g. TMDB 404) → retryable:false.
            await markFailedPermanent(sql, {
                mediaItemId: permanentItem,
                stageId: 'a',
                error: { message: 'TMDB 404', retryable: false },
            });
            // Transient: retry-exhausted (retryable:true) → a different bucket, must NOT be accepted.
            await markFailedPermanent(sql, {
                mediaItemId: transientItem,
                stageId: 'a',
                error: { message: 'ECONNRESET', retryable: true },
            });

            await markMatched(sql, permanentItem);
            await markMatched(sql, transientItem);

            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
            });
            const accepted = await svc.acceptReidentifyForStage('a');
            expect(accepted).toBe(1);

            const permRows = await findRowsByItem(sql, permanentItem);
            expect(permRows.find((r) => r.stage_id === 'a')?.status).toBe('skipped_permanent');
            const transRows = await findRowsByItem(sql, transientItem);
            expect(transRows.find((r) => r.stage_id === 'a')?.status).toBe('failed_permanent');
        });
    });

    describe('acceptReidentifyForStage — matches the re-identify queue exactly', () => {
        it('leaves dismissed and never-matched items the queue does not count', async () => {
            const counted = await insertTestMediaItem(sql);
            const dismissed = await insertTestMediaItem(sql);
            const neverMatched = await insertTestMediaItem(sql);
            for (const id of [counted, dismissed, neverMatched]) {
                await insertPendingRow(sql, {
                    mediaItemId: id,
                    stageId: 'a',
                    processingVersion: 1,
                });
                await markFailedPermanent(sql, {
                    mediaItemId: id,
                    stageId: 'a',
                    error: { message: 'TMDB 404', retryable: false },
                });
            }
            await markMatched(sql, counted);
            await markMatched(sql, dismissed);
            await sql`UPDATE media_items SET is_dismissed = true WHERE id = ${dismissed}::uuid`;

            const svc = new PipelineRemediationService(sql, { registry: makeRegistry() });
            expect(await svc.acceptReidentifyForStage('a')).toBe(1);

            const status = async (id: string) =>
                (await findRowsByItem(sql, id)).find((r) => r.stage_id === 'a')?.status;
            expect(await status(counted)).toBe('skipped_permanent');
            expect(await status(dismissed)).toBe('failed_permanent');
            expect(await status(neverMatched)).toBe('failed_permanent');
        });
    });

    describe('acceptReidentifyItem', () => {
        it('accepts only the targeted non-retryable item, leaving others', async () => {
            const target = await insertTestMediaItem(sql);
            const other = await insertTestMediaItem(sql);
            await markMatched(sql, target);
            await markMatched(sql, other);
            await insertPendingRow(sql, {
                mediaItemId: target,
                stageId: 'a',
                processingVersion: 1,
            });
            await insertPendingRow(sql, {
                mediaItemId: other,
                stageId: 'a',
                processingVersion: 1,
            });
            await markFailedPermanent(sql, {
                mediaItemId: target,
                stageId: 'a',
                error: { message: 'TMDB 404', retryable: false },
            });
            await markFailedPermanent(sql, {
                mediaItemId: other,
                stageId: 'a',
                error: { message: 'TMDB 404', retryable: false },
            });

            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
            });
            const accepted = await svc.acceptReidentifyItem(target, 'a');
            expect(accepted).toBe(1);

            const targetRows = await findRowsByItem(sql, target);
            expect(targetRows.find((r) => r.stage_id === 'a')?.status).toBe('skipped_permanent');
            const otherRows = await findRowsByItem(sql, other);
            // The non-targeted item is untouched.
            expect(otherRows.find((r) => r.stage_id === 'a')?.status).toBe('failed_permanent');
        });

        it('does not accept a retryable (transient) dead-letter', async () => {
            const item = await insertTestMediaItem(sql);
            await insertPendingRow(sql, {
                mediaItemId: item,
                stageId: 'a',
                processingVersion: 1,
            });
            await markFailedPermanent(sql, {
                mediaItemId: item,
                stageId: 'a',
                error: { message: 'ECONNRESET', retryable: true },
            });
            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
            });
            expect(await svc.acceptReidentifyItem(item, 'a')).toBe(0);
        });

        it('records an operator-supplied reason instead of the default', async () => {
            const item = await insertTestMediaItem(sql);
            await markMatched(sql, item);
            await insertPendingRow(sql, {
                mediaItemId: item,
                stageId: 'a',
                processingVersion: 1,
            });
            await markFailedPermanent(sql, {
                mediaItemId: item,
                stageId: 'a',
                error: { message: 'TMDB 404', retryable: false },
            });
            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
            });
            expect(await svc.acceptReidentifyItem(item, 'a', 'wrong region, confirmed gone')).toBe(
                1,
            );
            const rows = await findRowsByItem(sql, item);
            // The stored form is `<machine code>: <operator note>`, not the bare
            // note — operatorReason() prefixes deliberately, and the column is
            // read by machines as well as people: PipelineTimeline.svelte splits
            // on the code to render the note alone (see its "never renders the
            // raw operator- reason code" test). Asserting the bare note here made
            // this case red from the commit that introduced it.
            expect(rows.find((r) => r.stage_id === 'a')?.skipped_reason).toBe(
                'operator-accepted-not-on-provider: wrong region, confirmed gone',
            );
        });
    });

    describe('giveUpItem / unignoreItem', () => {
        it('gives up a stuck stage, preserving last_error, then un-ignores it back to pending', async () => {
            const item = await insertTestMediaItem(sql);
            await insertPendingRow(sql, {
                mediaItemId: item,
                stageId: 'a',
                processingVersion: 1,
            });
            await markFailedPermanent(sql, {
                mediaItemId: item,
                stageId: 'a',
                error: { message: 'probe timeout', code: 'probe_failed', retryable: true },
            });

            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
            });

            const gaveUp = await svc.giveUpItem(item, 'a');
            expect(gaveUp).toEqual({ skipped: 1 });
            let rows = await findRowsByItem(sql, item);
            let row = rows.find((r) => r.stage_id === 'a');
            expect(row?.status).toBe('skipped_permanent');
            expect(row?.skipped_reason).toBe('operator-gave-up');
            // last_error survives the skip so the operator can see it after un-ignoring.
            expect(row?.last_error).toEqual({
                message: 'probe timeout',
                code: 'probe_failed',
                retryable: true,
            });

            const restored = await svc.unignoreItem(item, 'a');
            expect(restored).toEqual({ restored: 1 });
            rows = await findRowsByItem(sql, item);
            row = rows.find((r) => r.stage_id === 'a');
            expect(row?.status).toBe('pending');
            expect(row?.skipped_reason).toBeNull();

            // A repeat un-ignore is a no-op — the row is no longer skipped_permanent.
            expect(await svc.unignoreItem(item, 'a')).toEqual({ restored: 0 });
        });

        it('records an operator-supplied give-up reason instead of the default', async () => {
            const item = await insertTestMediaItem(sql);
            await insertPendingRow(sql, {
                mediaItemId: item,
                stageId: 'a',
                processingVersion: 1,
            });
            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
            });
            expect(
                await svc.giveUpItem(item, 'a', 'known-bad file, skipping intentionally'),
            ).toEqual({ skipped: 1 });
            const rows = await findRowsByItem(sql, item);
            // Same contract as above, and the no-note case two tests up already
            // asserts the bare `operator-gave-up` — so the noted form can only be
            // `operator-gave-up: <note>`.
            expect(rows.find((r) => r.stage_id === 'a')?.skipped_reason).toBe(
                'operator-gave-up: known-bad file, skipping intentionally',
            );
        });
    });

    describe('reevaluate', () => {
        it('enqueues eligible+enqueueable stages and counts the rest as skipped', async () => {
            const eager = vi.fn(async () => undefined);
            const stageStateStub = {
                loadItemSnapshot: async () => SNAP,
                applicableStages: () => [
                    {
                        id: 'eligible',
                        appliesTo: ['movie'] as const,
                        enqueueable: true,
                        taskId: 'probe-task',
                    },
                    {
                        id: 'ineligible',
                        appliesTo: ['movie'] as const,
                        enqueueable: true,
                        eligibility: { appliesTo: () => false },
                        taskId: 'probe-task',
                    },
                    {
                        id: 'descriptive',
                        appliesTo: ['movie'] as const,
                        enqueueable: false,
                        taskId: 'probe-task',
                    },
                ],
                eagerEnqueueForStages: eager,
            };

            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
                stageStateService: stageStateStub,
            });

            const result = await svc.reevaluate('00000000-0000-4000-a000-000000000001');
            // 'eligible' enqueued; 'ineligible' (predicate false) + 'descriptive'
            // (not enqueueable) skipped.
            expect(result).toEqual({ enqueued: 1, skipped: 2 });
            expect(eager).toHaveBeenCalledWith('00000000-0000-4000-a000-000000000001', [
                'eligible',
            ]);
        });

        it('narrows to a single stage when stageId given', async () => {
            const eager = vi.fn(async () => undefined);
            const stageStateStub = {
                loadItemSnapshot: async () => SNAP,
                applicableStages: () => [
                    {
                        id: 'eligible',
                        appliesTo: ['movie'] as const,
                        enqueueable: true,
                        taskId: 'probe-task',
                    },
                    {
                        id: 'descriptive',
                        appliesTo: ['movie'] as const,
                        enqueueable: false,
                        taskId: 'probe-task',
                    },
                ],
                eagerEnqueueForStages: eager,
            };
            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
                stageStateService: stageStateStub,
            });

            const result = await svc.reevaluate('00000000-0000-4000-a000-000000000001', 'eligible');
            expect(result).toEqual({ enqueued: 1, skipped: 0 });
            expect(eager).toHaveBeenCalledWith('00000000-0000-4000-a000-000000000001', [
                'eligible',
            ]);
        });

        it('returns zeros when the item snapshot is missing', async () => {
            const eager = vi.fn(async () => undefined);
            const svc = new PipelineRemediationService(sql, {
                registry: makeRegistry(),
                stageStateService: {
                    loadItemSnapshot: async () => null,
                    applicableStages: () => [],
                    eagerEnqueueForStages: eager,
                },
            });
            const result = await svc.reevaluate('00000000-0000-4000-a000-000000000099');
            expect(result).toEqual({ enqueued: 0, skipped: 0 });
            expect(eager).not.toHaveBeenCalled();
        });
    });
});
