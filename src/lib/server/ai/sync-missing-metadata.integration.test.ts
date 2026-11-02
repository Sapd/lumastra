// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for C3 fix-round-2 (2026-09-25 security review),
 * Important 1: a `metadata_locked` item used to strand its `metadata-update`
 * stage row in `pending` forever.
 *
 * Round 1 added `mi.metadata_locked = false` to `syncMissingMetadata`'s own
 * candidate queries (`sync-missing-metadata.ts`), which correctly stops the
 * sync from ever WRITING to a locked item — but a locked item's row is then
 * never selected, so `completeItem()`/`onItemSuccess` never runs for it, and
 * nothing else disposed the row out of `pending`. It was re-enqueued every
 * sweep tick for a write that could never land, and tripped the
 * stuck-pending health signal.
 *
 * This test exercises the real fix end to end: the new `metadata-locked`
 * predicate rule on the `metadata-update` stage (`metadata-sync.ts`)
 * disposes the locked row via `runStageDisposition` (the same framework call
 * `stage-sweep` makes before every enqueue decision), and `syncMissingMetadata`
 * itself — run in stage-gated mode (`onItemSuccess` set) — never touches the
 * locked item and completes the unlocked one normally.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type { ProviderDetailResult } from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../tests/integration/helpers/cleanup.js';

// The provider detail lookup is the only network edge — stub it, run
// everything else (candidate SQL, stage disposition, coverage writes)
// against the real database. Pattern matches
// `embedding-operations.service.integration.test.ts`.
const pluginContext = vi.hoisted(() => ({
    invokeProviderDetail: vi.fn<() => Promise<ProviderDetailResult | null>>(),
}));
// Matches the exact relative specifier `sync-missing-metadata.ts` imports
// (same directory) — see `sync-missing-metadata.test.ts` for the same
// pattern; the '$lib/...' alias form is not guaranteed to intercept it.
vi.mock('../tasks/plugin-context.js', () => pluginContext);

import { syncMissingMetadata } from './sync-missing-metadata.js';
import { upsertCompletedRow } from '../database/queries/stage-state.queries.js';
import { runStageDisposition } from '../tasks/stage-disposition-runner.js';
import { metadataUpdateTask } from '../tasks/builtin/native/metadata-sync.js';
import type { StageGuardContext } from '$lib/types/pipeline.js';

const STAGE = 'metadata-update';

const noopLogger: StageGuardContext['logger'] = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
        return noopLogger;
    },
};

function makeDetail(): ProviderDetailResult {
    return {
        cast: [],
        directors: ['A Director'],
        producers: [],
        writers: [],
        keywordNames: [],
        keywordSlugs: [],
        rawKeywordIds: [],
        networks: [],
        imdbId: 'tt9999999',
    } as unknown as ProviderDetailResult;
}

async function insertMovie(
    sql: postgres.Sql,
    id: string,
    title: string,
    tmdbId: string,
    locked: boolean,
): Promise<void> {
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, metadata_locked)
        VALUES (${id}::uuid, ${title}, 'movie', 'active', true, ${locked})
    `;
    await sql`
        INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
        VALUES (${id}::uuid, 'tmdb', 'movie', ${tmdbId}, true)
    `;
}

async function seedPendingStageRow(sql: postgres.Sql, mediaItemId: string): Promise<void> {
    await sql`
        INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status)
        VALUES (${mediaItemId}::uuid, ${STAGE}, 1, 'pending')
    `;
}

async function getStageStatus(sql: postgres.Sql, mediaItemId: string): Promise<string | undefined> {
    const [row] = await sql<{ status: string }[]>`
        SELECT status FROM media_item_stage_state
        WHERE media_item_id = ${mediaItemId}::uuid AND stage_id = ${STAGE}
    `;
    return row?.status;
}

describe('syncMissingMetadata + metadata-locked stage disposition (C3 fix-round-2, integration)', () => {
    let sql: postgres.Sql;
    let ctx: StageGuardContext;

    const LOCKED_ID = '10000000-0000-4000-a000-000000000001';
    const UNLOCKED_ID = '10000000-0000-4000-a000-000000000002';

    beforeAll(async () => {
        sql = getTestDb();
        ctx = { sql, logger: noopLogger };
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.media);
        pluginContext.invokeProviderDetail.mockReset();
        pluginContext.invokeProviderDetail.mockResolvedValue(makeDetail());
    });

    it('disposes the locked row via the stage rule, and syncMissingMetadata completes only the unlocked one', async () => {
        await insertMovie(sql, LOCKED_ID, 'Locked Movie', '600001', true);
        await insertMovie(sql, UNLOCKED_ID, 'Unlocked Movie', '600002', false);
        await seedPendingStageRow(sql, LOCKED_ID);
        await seedPendingStageRow(sql, UNLOCKED_ID);

        // Step 1: the disposition pass stage-sweep runs before every enqueue
        // decision. It must dispose the locked row and leave the unlocked
        // one (which has a real metadata gap) pending.
        const stage = metadataUpdateTask.coversStages?.find((s) => s.id === STAGE);
        if (!stage) throw new Error(`No coversStages entry with id='${STAGE}'`);
        const disposed = await runStageDisposition(
            sql,
            stage as unknown as Parameters<typeof runStageDisposition>[1],
            ctx,
        );
        expect(disposed).toBe(1);
        expect(await getStageStatus(sql, LOCKED_ID)).toBe('skipped_transient');
        expect(await getStageStatus(sql, UNLOCKED_ID)).toBe('pending');

        // Step 2: run the actual sync in stage-gated mode (onItemSuccess set).
        const result = await syncMissingMetadata({
            sql,
            onItemSuccess: (mediaId) =>
                upsertCompletedRow(sql, {
                    mediaItemId: mediaId,
                    stageId: STAGE,
                    processingVersion: 1,
                }),
        });

        expect(result.success).toBe(true);

        // Only the unlocked item was ever a candidate — the locked one is
        // filtered out by `mi.metadata_locked = false` in both candidate
        // queries, so the provider was never asked about it and its stage
        // row is untouched by this call (still whatever the disposition set).
        expect(pluginContext.invokeProviderDetail).toHaveBeenCalledTimes(1);

        expect(await getStageStatus(sql, LOCKED_ID)).toBe('skipped_transient');
        expect(await getStageStatus(sql, UNLOCKED_ID)).toBe('completed');

        const [lockedPm] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata WHERE media_id = ${LOCKED_ID}::uuid
        `;
        expect(lockedPm).toBeUndefined();

        // sync-missing-metadata.ts writes the flat-field update (imdb_id,
        // directors, etc.) to the 'aggregated' provider row, not the primary
        // provider's own row (see its call to `upsertProviderMetadataUnlessLocked`
        // with provider: 'aggregated').
        const [unlockedPm] = await sql<{ metadata: Record<string, unknown> }[]>`
            SELECT metadata FROM provider_metadata
            WHERE media_id = ${UNLOCKED_ID}::uuid AND provider = 'aggregated'
        `;
        expect(unlockedPm.metadata.imdb_id).toBe('tt9999999');
    });
});
