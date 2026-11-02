// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Coverage-table terminal-disposition contract — OSS regression gate.
 *
 * The "task processes work but forgets to tombstone its stage_state row"
 * wedge bug class wedged several tasks across consecutive sessions before
 * OSS release. The shape is always the same: a coverage-table candidate
 * query keeps surfacing the same items every slice, the task runs forever
 * processing zero items, and the admin backlog counter stays inflated.
 *
 * Phase 2 of the Declarative Stage Contract moved each task's terminal-
 * disposition logic OUT of hand-rolled inline SQL in `execute()` INTO a
 * declared `terminalDisposition` on its `coversStages` entry. The framework
 * runner `runStageDisposition(sql, stage, ctx)` (in
 * `stage-disposition-runner.ts`) now executes it just before `stage-sweep`
 * scans the stage's candidates.
 *
 * This test is therefore a GENERATED CONSEQUENCE of those declarations — one
 * source of truth. Each block imports the real task, reads
 * `task.coversStages.find(s => s.id === '<id>')`, seeds should-DRAIN and
 * should-NOT-drain rows with the shared helpers, calls the REAL framework
 * runner against the REAL declaration, and asserts `getStageStatus`. There is
 * no duplicated inline disposition SQL: if a task author weakens a predicate,
 * the runner — and therefore this test — observes it directly.
 *
 * Block taxonomy:
 *   - PREDICATE stages: assert the drain target fires AND a load-bearing
 *     should-NOT-drain row stays `pending` (guards against over-disposal).
 *   - GLOBAL-GUARD stages: with the precondition met → no-op; unmet → whole
 *     stage drains to `skipped_transient`.
 *   - SELF-TERMINAL stages: the disposition is a NO-OP (rowsDisposed 0); the
 *     real per-item terminal-write guarantee is covered by unit tests.
 *
 * The runner only touches rows whose status is in
 * (pending, failed_transient, skipped_transient) — at least one
 * `failed_transient`-past-`next_eligible_at` case proves retriable rows drain.
 *
 * It ALSO covers the cross-cutting `purgeStageStateForDeletedItems` helper
 * (orthogonal orphan purge for soft-deleted items).
 *
 * Adding a new authoritative/enqueueable stage is self-driving: add a block
 * that imports the task and runs `runStageDisposition` against its real
 * declaration — no inline SQL to keep in sync.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach, afterAll, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createTestArtist,
    createTestAlbum,
} from '../../../../tests/integration/fixtures/music.fixtures.js';
import { createTestMediaItem } from '../../../../tests/integration/fixtures/media.fixtures.js';
import { purgeStageStateForDeletedItems } from '$lib/server/database/queries/database-cleanup.queries.js';
import {
    unlockMediaItem,
    bulkSetLockMediaItems,
} from '$lib/server/database/queries/media-items.queries.js';
import { INVARIANTS } from '../services/health-invariants/invariants.js';
import { runStageDisposition } from './stage-disposition-runner.js';

/**
 * The embedding stages' provider gate, made deterministic.
 *
 * `library-embeddings` / `discovery-embeddings` now carry the configured
 * embedding provider in BOTH their `eligibility.sql` and their author
 * predicate, so their dispositions read real config. Left ambient, these tests
 * would pass or fail depending on whether the developer's `.env` happens to
 * hold a VOYAGE/OPENAI key (`vitest.integration.config.ts` loads `dotenv`),
 * and CI — which has none — would see every "stays pending" case drain. Mock
 * the single predicate instead of the whole config module: it is the one seam
 * both stages consult, and spreading `...actual` keeps `EMBEDDINGS_DEP` real.
 */
const embeddingProvider = vi.hoisted(() => ({ configured: true }));
vi.mock('./builtin/native/embedding-dep.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('./builtin/native/embedding-dep.js')>();
    return { ...actual, hasUsableEmbeddingProvider: () => embeddingProvider.configured };
});

/**
 * The music-analysis engine gate, for exactly the reason spelled out above.
 *
 * `music-analysis` sits in the SELF-TERMINAL list, whose contract is
 * "disposition is a no-op". That holds only on an install that can actually
 * analyse: the stage declares two environment predicates ahead of its
 * self-terminal rule — `music-analysis-disabled` and
 * `music-analysis-engine-available` — and both drain to `skipped_permanent`.
 * CI has no Essentia sidecar, so `isEssentiaAvailable()` was false, the second
 * predicate fired, and the case asserted 0 while the framework correctly
 * disposed 1. The task was right; the test was reading an environment it never
 * pinned. Mocking the single seam keeps the no-op contract meaningful instead
 * of deleting the case.
 */
vi.mock('$lib/server/services/essentia-analysis.service.js', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/services/essentia-analysis.service.js')>();
    return { ...actual, isEssentiaAvailable: () => true, isAnalysisEngineUsable: () => true };
});
import type { StageGuardContext } from '$lib/types/pipeline.js';
import { config } from '$lib/server/config.js';

// Real task declarations — the single source of truth this test consumes.
import { mdblistSyncTask } from './builtin/native/mdblist-sync.js';
import { metadataUpdateTask } from './builtin/native/metadata-sync.js';
import { albumEnrichmentTask } from './builtin/native/album-enrichment.js';
import { artistEnrichmentTask } from './builtin/native/artist-enrichment.js';
import { libraryEmbeddingsTask } from './builtin/native/library-embeddings-task.js';
import { discoveryEmbeddingsTask } from './builtin/native/discovery-embeddings.js';
import { musicEmbeddingGenerationTask } from './builtin/native/music-embedding-generation.js';
import {
    lumastraIntroAnalyzerTask,
    ANALYZER_VISUAL_STAGE_ID,
} from './builtin/native/lumastra-intro-analyzer.js';
import { musicPopularityTask } from './builtin/native/music-popularity.js';
import { fribbAnimeSyncTask } from './builtin/native/fribb-anime-sync.js';
import { malAnimeIdEnrichmentTask } from './builtin/native/mal-anime-id-enrichment.js';
import {
    seriesSyncTask,
    imageSyncTask,
    chapterSyncTask,
} from './builtin/native/media-item-tasks.js';
import { tmdbMetadataSyncRealTask } from './builtin/native/tmdb-metadata-sync-task.js';
import { musicAnalysisTask } from './builtin/native/music-analysis.js';
import { trickplayParamsSyncTask } from './builtin/native/trickplay-params-sync.js';
import { PluginSecrets } from './secrets.js';
import { derivedUsername } from '../../../../tests/integration/fixtures/user.fixtures.js';

const TEST_TABLES = [
    'media_item_stage_state',
    'provider_metadata',
    'media_artwork',
    'media_embeddings',
    'plugin_user_credentials',
    'plugin_secrets',
    'trickplay_params',
    'media_streams',
    'media_file_items',
    'media_files',
    'external_ids',
    'media_items',
] as const;

// A no-op logger stub satisfying StageGuardContext's logger shape (the SDK
// `Logger`, which includes `child()` returning another `Logger`).
const noopLogger: StageGuardContext['logger'] = {
    info() {},
    warn() {},
    error() {},
    debug() {},
    child() {
        return noopLogger;
    },
};

/**
 * Minimal stage shape the runner reads — what `coversStages.find(...)` yields.
 * Mirrors the (un-exported) `DispositionStage` the runner accepts; the SDK
 * `CoversStagesDeclaration` is structurally compatible (same as how
 * `stage-sweep` hands its SDK stages to the runner).
 */
type DispositionStage = Parameters<typeof runStageDisposition>[1];

/** Anything that exposes a `coversStages` array of objects carrying an `id`. */
interface HasCoversStages {
    coversStages?: ReadonlyArray<{ id: string }>;
}

/**
 * Pull the real `coversStages` entry off a task by stage id. Throws loudly if
 * the declaration vanished (the contract is gone, not silently passing).
 */
function stageOf(task: HasCoversStages, stageId: string): DispositionStage {
    const stage = task.coversStages?.find((s) => s.id === stageId);
    if (!stage) {
        throw new Error(`No coversStages entry with id='${stageId}' — declaration removed?`);
    }
    return stage as unknown as DispositionStage;
}

async function insertItem(
    sql: postgres.Sql,
    fields: {
        id?: string;
        title: string;
        media_type: string;
        status?: string;
        processing_state?: Record<string, unknown>;
        custom_poster_url?: string | null;
        parent_id?: string | null;
        season_number?: number | null;
        has_files?: boolean;
        /** Override updated_at (e.g. to make a music embedding look stale). */
        updatedAt?: 'now' | 'future';
    },
): Promise<string> {
    const id = fields.id ?? crypto.randomUUID();
    const updatedAtFrag =
        fields.updatedAt === 'future' ? sql`now() + interval '1 hour'` : sql`now()`;
    await sql`
        INSERT INTO media_items (
            id, title, media_type, status, processing_state,
            custom_poster_url, parent_id, season_number, has_files,
            created_at, updated_at
        )
        VALUES (
            ${id}::uuid,
            ${fields.title},
            ${fields.media_type},
            ${fields.status ?? 'active'},
            ${sql.json((fields.processing_state ?? {}) as never)}::jsonb,
            ${fields.custom_poster_url ?? null},
            ${fields.parent_id ?? null}::uuid,
            ${fields.season_number ?? null},
            ${fields.has_files ?? false},
            now(), ${updatedAtFrag}
        )
    `;
    return id;
}

interface SeedOpts {
    status?: 'pending' | 'failed_transient' | 'skipped_transient' | 'obsolete';
    /**
     * `'past'` sets next_eligible_at = now() - 1min (retriable),
     * `'future'` sets it = now() + 10min (still in backoff window),
     * `null` (default) leaves it NULL.
     */
    nextEligible?: 'past' | 'future' | null;
}

async function seedPendingStageRow(
    sql: postgres.Sql,
    mediaItemId: string,
    stageId: string,
    processingVersion = 1,
    opts: SeedOpts = {},
): Promise<void> {
    const status = opts.status ?? 'pending';
    const nextEligibleFrag =
        opts.nextEligible === 'past'
            ? sql`now() - interval '1 minute'`
            : opts.nextEligible === 'future'
              ? sql`now() + interval '10 minutes'`
              : sql`NULL`;
    await sql`
        INSERT INTO media_item_stage_state (
            media_item_id, stage_id, processing_version, status, next_eligible_at, updated_at
        ) VALUES (
            ${mediaItemId}::uuid, ${stageId}, ${processingVersion}, ${status}, ${nextEligibleFrag}, now()
        )
        ON CONFLICT (media_item_id, stage_id) DO UPDATE
            SET status = EXCLUDED.status,
                next_eligible_at = EXCLUDED.next_eligible_at,
                updated_at = now()
    `;
}

async function getStageStatus(
    sql: postgres.Sql,
    mediaItemId: string,
    stageId: string,
): Promise<string | undefined> {
    const [row] = await sql<{ status: string }[]>`
        SELECT status FROM media_item_stage_state
        WHERE media_item_id = ${mediaItemId}::uuid AND stage_id = ${stageId}
    `;
    return row?.status;
}

async function getSkippedReason(
    sql: postgres.Sql,
    mediaItemId: string,
    stageId: string,
): Promise<string | null> {
    const [row] = await sql<{ skipped_reason: string | null }[]>`
        SELECT skipped_reason FROM media_item_stage_state
        WHERE media_item_id = ${mediaItemId}::uuid AND stage_id = ${stageId}
    `;
    return row?.skipped_reason ?? null;
}

async function getNextEligibleAt(
    sql: postgres.Sql,
    mediaItemId: string,
    stageId: string,
): Promise<Date | null> {
    const [row] = await sql<{ next_eligible_at: Date | null }[]>`
        SELECT next_eligible_at FROM media_item_stage_state
        WHERE media_item_id = ${mediaItemId}::uuid AND stage_id = ${stageId}
    `;
    return row?.next_eligible_at ?? null;
}

describe('coverage-table terminal-disposition contract (integration)', () => {
    let sql: postgres.Sql;
    let ctx: StageGuardContext;

    /** Run a stage's declared disposition against the real framework runner. */
    async function dispose(stage: DispositionStage): Promise<number> {
        return await runStageDisposition(sql, stage, ctx);
    }

    beforeAll(async () => {
        sql = getTestDb();
        ctx = { sql, logger: noopLogger };
    });

    afterAll(async () => {
        // beforeEach only truncates BEFORE a test: the last test's placeholder
        // LASTFM_API_KEY row (a non-enc:v2 blob) would otherwise outlive the
        // file and show up as a legacy envelope in the security self-check.
        await sql`DELETE FROM plugin_secrets WHERE plugin_id = 'music-popularity'`;
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES);
    });

    // ── Cross-cutting: orphan purge for soft-deleted items ───────────────

    describe('purgeStageStateForDeletedItems', () => {
        it('deletes stage rows whose media_item is non-active', async () => {
            const deletedId = await insertItem(sql, {
                title: 'Deleted item',
                media_type: 'movie',
                status: 'deleted',
            });
            const activeId = await insertItem(sql, {
                title: 'Active item',
                media_type: 'movie',
                status: 'active',
            });

            await seedPendingStageRow(sql, deletedId, 'trickplay-params-sync');
            await seedPendingStageRow(sql, activeId, 'trickplay-params-sync');

            const purged = await purgeStageStateForDeletedItems(sql);

            expect(purged).toBe(1);
            expect(await getStageStatus(sql, deletedId, 'trickplay-params-sync')).toBeUndefined();
            expect(await getStageStatus(sql, activeId, 'trickplay-params-sync')).toBe('pending');
        });

        it('returns 0 when no orphans exist', async () => {
            const activeId = await insertItem(sql, {
                title: 'Active only',
                media_type: 'movie',
                status: 'active',
            });
            await seedPendingStageRow(sql, activeId, 'metadata-update');

            expect(await purgeStageStateForDeletedItems(sql)).toBe(0);
        });

        it('purges across multiple stage_ids in one call', async () => {
            const deletedId = await insertItem(sql, {
                title: 'Multi-stage orphan',
                media_type: 'tv',
                status: 'deleted',
            });
            await seedPendingStageRow(sql, deletedId, 'metadata-update');
            await seedPendingStageRow(sql, deletedId, 'mdblist-sync');
            await seedPendingStageRow(sql, deletedId, 'trickplay-params-sync');

            expect(await purgeStageStateForDeletedItems(sql)).toBe(3);
        });
    });

    // ── PREDICATE stages — driven by the declared `terminalDisposition` ──

    describe('mdblist-sync → completed (fresh provider_metadata)', () => {
        const STAGE = 'mdblist-sync';
        const stage = stageOf(mdblistSyncTask, STAGE);

        /**
         * Pin the provider gate, or none of these cases test what they claim.
         *
         * The stage declares TWO disposition rules and order is invariant: the
         * `mdblist-sync-provider-configured` GLOBAL GUARD runs first and, with no
         * API key, drains the whole stage to `skipped_transient`. CI has no key,
         * so every case here was disposed by the guard before the
         * `fresh-mdblist-data` predicate they exist to cover was ever consulted —
         * the "stale"/"null score"/"no metadata" cases expected 0 and got 1, and
         * the fresh ones expected 1 and got 2.
         *
         * So these four were not merely red: the freshness predicate had NO
         * coverage at all while looking like it did. Same failure mode, and the
         * same fix, as the embedding provider gate at the top of this file.
         */
        beforeEach(() => {
            vi.spyOn(config, 'MDBLIST_API_KEY', 'get').mockReturnValue('test-key');
        });

        afterEach(() => {
            vi.restoreAllMocks();
        });

        async function seedMdblist(id: string, metadata: object, ageHours: number): Promise<void> {
            const ageFrag = sql`now() - (${ageHours}::int || ' hours')::interval`;
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${id}::uuid, 'mdblist', ${sql.json(metadata as never)}::jsonb, ${ageFrag}, ${ageFrag})
            `;
        }

        it('drains pending row when item has fresh mdblist score (<168h)', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'Fresh MDB',
            });
            const id = await insertItem(sql, {
                id: item.id,
                title: item.title,
                media_type: item.media_type,
            });
            await seedMdblist(id, { mdblist_score: 75 }, 1);
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('completed');
        });

        it('leaves pending when mdblist data is stale (>168h)', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'Stale MDB',
            });
            const id = await insertItem(sql, {
                id: item.id,
                title: item.title,
                media_type: item.media_type,
            });
            await seedMdblist(id, { mdblist_score: 75 }, 200);
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('leaves pending when provider_metadata exists but mdblist_score is null', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'Partial MDB',
            });
            const id = await insertItem(sql, {
                id: item.id,
                title: item.title,
                media_type: item.media_type,
            });
            await seedMdblist(id, { other_field: 'x' }, 1);
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('leaves pending when item has no mdblist provider_metadata', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'No MDB',
            });
            const id = await insertItem(sql, {
                id: item.id,
                title: item.title,
                media_type: item.media_type,
            });
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('drains a failed_transient row past next_eligible_at with fresh data', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'Retriable MDB',
            });
            const id = await insertItem(sql, {
                id: item.id,
                title: item.title,
                media_type: item.media_type,
            });
            await seedMdblist(id, { mdblist_score: 81 }, 1);
            await seedPendingStageRow(sql, id, STAGE, 1, {
                status: 'failed_transient',
                nextEligible: 'past',
            });

            expect(await dispose(stage)).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('completed');
        });

        // C3 fix-round-2 (2026-09-25 security review): a locked item with no
        // (or stale) mdblist data used to strand its row `pending` forever —
        // `upsertMdblistMetadata` refuses the write, so the row never left
        // pending on its own. `skipped_transient` self-heals once unlocked
        // (see the rule's doc comment in mdblist-sync.ts).
        it('metadata-locked → skipped_transient when item is locked (no mdblist data yet)', async () => {
            const item = createTestMediaItem({
                media_type: 'movie',
                title: 'Locked MDB',
            });
            const id = await insertItem(sql, {
                id: item.id,
                title: item.title,
                media_type: item.media_type,
            });
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${id}::uuid`;
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_transient');
            expect(await getSkippedReason(sql, id, STAGE)).toBe('metadata-locked');
            const nextEligible = await getNextEligibleAt(sql, id, STAGE);
            expect(nextEligible).not.toBeNull();
            expect(nextEligible!.getTime()).toBeGreaterThan(Date.now());
        });

        // Unlock has no invalidation event, so without a release the row
        // waited out the rule's 6 h retryAfterMs before mdblist looked again.
        async function lockedAndDisposed(title: string): Promise<string> {
            const item = createTestMediaItem({ media_type: 'movie', title });
            const id = await insertItem(sql, {
                id: item.id,
                title: item.title,
                media_type: item.media_type,
            });
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${id}::uuid`;
            await seedPendingStageRow(sql, id, STAGE);
            await dispose(stage);
            expect(await getSkippedReason(sql, id, STAGE)).toBe('metadata-locked');
            return id;
        }

        it('unlockMediaItem releases the metadata-locked row: pending and eligible now', async () => {
            const id = await lockedAndDisposed('Unlock MDB');

            expect(await unlockMediaItem(sql, id)).toBe(true);

            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
            expect(await getSkippedReason(sql, id, STAGE)).toBeNull();
            expect(await getNextEligibleAt(sql, id, STAGE)).toBeNull();
            // ...and the stage rule no longer parks it.
            await dispose(stage);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('a bulk unlock releases the metadata-locked rows too', async () => {
            const id = await lockedAndDisposed('Bulk Unlock MDB');

            expect(await bulkSetLockMediaItems(sql, [id], false, null)).toEqual([id]);

            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
            expect(await getNextEligibleAt(sql, id, STAGE)).toBeNull();
        });

        it('control: unlock leaves a row skipped for another reason alone, and a bulk LOCK releases nothing', async () => {
            const id = await lockedAndDisposed('Other Reason MDB');
            await sql`
                UPDATE media_item_stage_state
                SET skipped_reason = 'no-mdblist-api-key-configured'
                WHERE media_item_id = ${id}::uuid AND stage_id = ${STAGE}
            `;
            await unlockMediaItem(sql, id);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_transient');
            expect(await getSkippedReason(sql, id, STAGE)).toBe('no-mdblist-api-key-configured');

            const locked = await lockedAndDisposed('Relock MDB');
            await bulkSetLockMediaItems(sql, [locked], true, 'someone');
            expect(await getStageStatus(sql, locked, STAGE)).toBe('skipped_transient');
            expect(await getSkippedReason(sql, locked, STAGE)).toBe('metadata-locked');
        });
    });

    describe('metadata-update [array] → completed / skipped_permanent', () => {
        const STAGE = 'metadata-update';
        const stage = stageOf(metadataUpdateTask, STAGE);

        it('no-gap → completed when chain metadata has imdb_id + non-empty actors + non-empty directors', async () => {
            const id = await insertItem(sql, {
                title: 'Complete',
                media_type: 'movie',
            });
            // Value-presence semantics: imdb_id non-null, actors/directors
            // non-empty arrays. `keywords_synced_at` stands for "the keyword
            // lookup already ran"; the drain requires it (or actual keywords)
            // because an item disposed before that lookup would never get
            // keywords at all.
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${id}::uuid, 'tmdb',
                    '{"imdb_id": "tt1", "actors": ["Actor A"], "directors": ["Dir B"],
                      "keywords_synced_at": "2026-08-27T00:00:00.000Z"}'::jsonb,
                    now(), now())
            `;
            // also give it a tmdb external id so the second (no-id) pass is a no-op
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'tmdb', 'movie', '900', true)
            `;
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('completed');
        });

        it('leaves pending when keywords were never fetched (no marker, no keywords)', async () => {
            // The regression this closes: imdb/actors/directors complete, so the drain
            // used to fire and dispose the stage while the keyword lookup had never
            // run. Nothing re-selects a disposed row, so the title was permanently
            // absent from browse/keywords — and whether it happened at all came down
            // to whether the sweep reached the item before eager processing did.
            const id = await insertItem(sql, { title: 'Keywords unfetched', media_type: 'movie' });
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${id}::uuid, 'tmdb',
                    '{"imdb_id": "tt9", "actors": ["Actor A"], "directors": ["Dir B"]}'::jsonb,
                    now(), now())
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'tmdb', 'movie', '909', true)
            `;
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('drains a title TMDB has no keywords for, once the lookup has run', async () => {
            // The other half, and the reason keywords could not simply be added to the
            // drain before the marker existed: plenty of titles genuinely have no
            // keywords at TMDB. Without the marker such a row satisfies neither the
            // drain nor completion and stays a candidate forever — ~12,170 TMDB
            // calls/day on prod, flat. The marker says the answer was "none".
            const id = await insertItem(sql, { title: 'No keywords at TMDB', media_type: 'movie' });
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${id}::uuid, 'tmdb',
                    '{"imdb_id": "tt10", "actors": ["Actor A"], "directors": ["Dir B"],
                      "keywords": [], "tmdb_keyword_ids": [], "keyword_slugs": [],
                      "keywords_synced_at": "2026-08-27T00:00:00.000Z"}'::jsonb,
                    now(), now())
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'tmdb', 'movie', '910', true)
            `;
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('completed');
        });

        it('leaves pending when actors is empty [] (over-disposal guard, load-bearing)', async () => {
            // imdb_id + directors present but actors is an empty array → the
            // candidate query still surfaces this row (real work to do), so the
            // no-gap drain must NOT fire. Key-existence (the old bug) would have
            // wrongly completed it.
            const id = await insertItem(sql, {
                title: 'Empty actors',
                media_type: 'movie',
            });
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${id}::uuid, 'tmdb',
                    '{"imdb_id": "tt2", "actors": [], "directors": ["Dir B"]}'::jsonb,
                    now(), now())
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'tmdb', 'movie', '901', true)
            `;
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('leaves pending when imdb_id is missing AND a tmdb id exists (real work to do)', async () => {
            const id = await insertItem(sql, {
                title: 'Missing IMDB',
                media_type: 'movie',
            });
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${id}::uuid, 'tmdb',
                    '{"actors": ["Actor A"], "directors": ["Dir B"]}'::jsonb,
                    now(), now())
            `;
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'tmdb', 'movie', '902', true)
            `;
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('no-primary-external-id → skipped_permanent when no tmdb external id', async () => {
            const id = await insertItem(sql, {
                title: 'Scanner Unmatched',
                media_type: 'movie',
            });
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        it('drains item with non-matching external_id provider (jellyfin only)', async () => {
            const id = await insertItem(sql, {
                title: 'Jellyfin-only Show',
                media_type: 'tv',
            });
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'jellyfin', 'tv', 'jf-abc', true)
            `;
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        it('leaves pending for non-movie/tv items (episode out of scope)', async () => {
            const id = await insertItem(sql, {
                title: 'Ep',
                media_type: 'episode',
            });
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        // C3 fix-round-2 (2026-09-25 security review, Important 1): round 1
        // added `mi.metadata_locked = false` to syncMissingMetadata's own
        // candidate queries, which means completeItem() never runs for a
        // locked item — but nothing disposed its row out of `pending`, so it
        // was re-enqueued every sweep tick forever and tripped the
        // stuck-pending health signal. This rule is what disposes it.
        it('metadata-locked → skipped_transient when item is locked and has a real gap (does not strand the row)', async () => {
            const id = await insertItem(sql, {
                title: 'Locked With Gap',
                media_type: 'movie',
            });
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'tmdb', 'movie', '950', true)
            `;
            await sql`UPDATE media_items SET metadata_locked = true WHERE id = ${id}::uuid`;
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_transient');
            expect(await getSkippedReason(sql, id, STAGE)).toBe('metadata-locked');
            const nextEligible = await getNextEligibleAt(sql, id, STAGE);
            expect(nextEligible).not.toBeNull();
            expect(nextEligible!.getTime()).toBeGreaterThan(Date.now());
        });
    });

    describe('album-enrichment [array, order matters]', () => {
        const STAGE = 'album-enrichment';
        const stage = stageOf(albumEnrichmentTask, STAGE);
        const currentVersion = albumEnrichmentTask.processingVersion ?? 1;

        async function newAlbum(fields: {
            title: string;
            processing_state?: Record<string, unknown>;
        }): Promise<string> {
            const artistId = crypto.randomUUID();
            const album = createTestAlbum(artistId, { title: fields.title });
            return await insertItem(sql, {
                id: album.id,
                title: album.title,
                media_type: 'album',
                processing_state: fields.processing_state,
                // The stage's eligibility needs a linked file; fileless albums
                // are pinned in album-enrichment-no-files-stage.
                has_files: true,
            });
        }

        async function addPoster(id: string): Promise<void> {
            await sql`
                INSERT INTO media_artwork (media_item_id, artwork_type, source)
                VALUES (${id}::uuid, 'poster', 'local')
            `;
        }

        it('pass1 plugin-wrote-poster → completed (version>=1, not failed, has poster)', async () => {
            const id = await newAlbum({
                title: 'Plugin Poster Album',
                processing_state: {
                    'album-enrichment': { version: 1, status: 'success' },
                },
            });
            await addPoster(id);
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('completed');
        });

        it('pass2 album-already-has-poster → skipped_permanent (poster, no plugin marker)', async () => {
            const id = await newAlbum({ title: 'Has Poster Album' });
            await addPoster(id);
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        it('leaves pending when album has no poster and no marker (load-bearing)', async () => {
            const id = await newAlbum({ title: 'Fresh Album' });
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it.each([currentVersion, currentVersion + 1])(
            'pass3 no-match version %s → skipped_permanent',
            async (version) => {
                const id = await newAlbum({
                    title: 'Processed NoMatch Album',
                    processing_state: { 'album-enrichment': { status: 'no-match', version } },
                });
                await seedPendingStageRow(sql, id, STAGE, currentVersion);

                expect(await dispose(stage)).toBe(1);
                expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
                expect(await getSkippedReason(sql, id, STAGE)).toBe('already-processed-no-match');
            },
        );

        it.each([undefined, null, currentVersion - 1])(
            'leaves stale no-match version %s pending for re-enrichment',
            async (version) => {
                const marker =
                    version === undefined
                        ? { status: 'no-match' }
                        : { status: 'no-match', version };
                const id = await newAlbum({
                    title: 'Outdated NoMatch Album',
                    processing_state: { 'album-enrichment': marker },
                });
                await seedPendingStageRow(sql, id, STAGE, currentVersion);

                expect(await dispose(stage)).toBe(0);
                expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
                expect(await getSkippedReason(sql, id, STAGE)).toBeNull();
                expect(await getNextEligibleAt(sql, id, STAGE)).toBeNull();
            },
        );

        it('leaves pending when legacy marker is success and no poster (no-match pass off)', async () => {
            const id = await newAlbum({
                title: 'Legacy Success Album',
                processing_state: { 'album-enrichment': { status: 'success' } },
            });
            await seedPendingStageRow(sql, id, STAGE);

            // version is absent → pass1 excluded; no poster → pass2 excluded;
            // status != 'no-match' → pass3 excluded. Row stays pending.
            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });
    });

    describe('artist-enrichment [array]', () => {
        const STAGE = 'artist-enrichment';
        const stage = stageOf(artistEnrichmentTask, STAGE);

        it('pass1 va-or-custom-poster → skipped_permanent (VA regex title)', async () => {
            const artist = createTestArtist({ title: 'Various Artists' });
            const id = await insertItem(sql, {
                id: artist.id,
                title: artist.title,
                media_type: 'artist',
            });
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        it('pass1 va-or-custom-poster → skipped_permanent (custom_poster_url set)', async () => {
            const id = await insertItem(sql, {
                title: 'Beatles',
                media_type: 'artist',
                custom_poster_url: 'https://x.com/p.jpg',
            });
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        it('leaves pending when custom_poster_url is empty string and no legacy marker (load-bearing)', async () => {
            const id = await insertItem(sql, {
                title: 'Riverglass',
                media_type: 'artist',
                custom_poster_url: '',
            });
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('pass2 legacy-done-completed → completed (key present AND status IS NULL)', async () => {
            const artist = createTestArtist({ title: 'Legacy Success Artist' });
            const id = await insertItem(sql, {
                id: artist.id,
                title: artist.title,
                media_type: 'artist',
                processing_state: { 'artist-enrichment': { processedAt: 'x' } },
            });
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('completed');
        });

        it('pass3 legacy-done-skipped → skipped_permanent (key present AND status NOT NULL)', async () => {
            const artist = createTestArtist({ title: 'Legacy NoMatch Artist' });
            const id = await insertItem(sql, {
                id: artist.id,
                title: artist.title,
                media_type: 'artist',
                processing_state: {
                    'artist-enrichment': { status: 'no-match' },
                },
            });
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        it('leaves pending when artist has no legacy marker and no VA/custom-poster', async () => {
            const artist = createTestArtist({ title: 'Untouched Artist' });
            const id = await insertItem(sql, {
                id: artist.id,
                title: artist.title,
                media_type: 'artist',
            });
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('drains a failed_transient VA row past next_eligible_at', async () => {
            const artist = createTestArtist({ title: 'VA' });
            const id = await insertItem(sql, {
                id: artist.id,
                title: artist.title,
                media_type: 'artist',
            });
            await seedPendingStageRow(sql, id, STAGE, 1, {
                status: 'failed_transient',
                nextEligible: 'past',
            });

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });
    });

    describe('library-embeddings → skipped_permanent (eligibility dispose: no library file)', () => {
        const STAGE = 'library-embeddings';
        const stage = stageOf(libraryEmbeddingsTask, STAGE);

        beforeEach(() => {
            embeddingProvider.configured = true;
        });

        it('provider predicate: no embedding key → drains an otherwise-eligible row', async () => {
            // The stock-install bug: with no key the generator produced zero
            // embeddings, never fired onSuccess, and (being a global-identity
            // task) had no mediaItemId for wrapExecute to auto-complete — so
            // every row sat pending while the sweep re-enqueued global drains
            // forever and the progress bar could not reach 100%.
            embeddingProvider.configured = false;
            const id = await insertItem(sql, {
                title: 'Has-file movie, no provider',
                media_type: 'movie',
                has_files: true,
            });
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBeGreaterThanOrEqual(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
            // Its OWN reason, not the generic 'ineligible' the eligibility
            // negation writes for a file-less item — the Ingest Map has to be
            // able to tell "no API key" from "no library file".
            expect(await getSkippedReason(sql, id, STAGE)).toBe('no-embedding-provider');
        });

        it('provider predicate: the drain reason is one the eligibility heal reclaims', () => {
            // Re-enrolment when a key is finally added rides on the sweep's
            // event-independent heal, which re-runs eligibility.sql over rows
            // whose skipped_reason is in this set. No pipeline event exists for
            // a config change, so if the reason were missing here the rows
            // would be stranded permanently.
            const elig = (stage as { eligibility?: { recoverWhenAdditionalReasons?: string[] } })
                .eligibility;
            expect(elig?.recoverWhenAdditionalReasons).toContain('no-embedding-provider');
        });

        it('drains pending row when item has NO files', async () => {
            const id = await insertItem(sql, {
                title: 'No-file movie',
                media_type: 'movie',
                has_files: false,
            });
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        it('leaves pending when item has_files=true (load-bearing)', async () => {
            const id = await insertItem(sql, {
                title: 'Has-file movie',
                media_type: 'movie',
                has_files: true,
            });
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });
    });

    describe('discovery-embeddings → skipped_permanent (eligibility dispose: has library file)', () => {
        const STAGE = 'discovery-embeddings';
        const stage = stageOf(discoveryEmbeddingsTask, STAGE);

        beforeEach(() => {
            embeddingProvider.configured = true;
        });

        it('provider predicate: no embedding key → drains an otherwise-eligible row', async () => {
            embeddingProvider.configured = false;
            const id = await insertItem(sql, {
                title: 'No-file movie, no provider',
                media_type: 'movie',
                has_files: false,
            });
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBeGreaterThanOrEqual(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
            expect(await getSkippedReason(sql, id, STAGE)).toBe('no-embedding-provider');
        });

        it('drains pending row when item HAS files', async () => {
            const id = await insertItem(sql, {
                title: 'Has-file movie',
                media_type: 'movie',
                has_files: true,
            });
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        it('leaves pending when item has_files=false (load-bearing)', async () => {
            const id = await insertItem(sql, {
                title: 'No-file movie',
                media_type: 'movie',
                has_files: false,
            });
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });
    });

    describe('music-embedding-generation → skipped_transient (embedding up-to-date)', () => {
        const STAGE = 'music-embedding-generation';
        const stage = stageOf(musicEmbeddingGenerationTask, STAGE);

        async function seedMusicEmbedding(id: string, ageOffset: 'fresh' | 'stale'): Promise<void> {
            // fresh: embedding.updated_at >= mi.updated_at → up-to-date → excluded.
            // stale: embedding.updated_at < mi.updated_at → still work to do.
            const updatedFrag =
                ageOffset === 'fresh'
                    ? sql`now() + interval '1 hour'`
                    : sql`now() - interval '1 hour'`;
            await sql`
                INSERT INTO media_embeddings (media_id, source, created_at, updated_at)
                VALUES (${id}::uuid, 'music', now(), ${updatedFrag})
            `;
        }

        it('drains pending row to skipped_transient when music embedding is up-to-date', async () => {
            const id = await insertItem(sql, {
                title: 'Up-to-date track',
                media_type: 'track',
            });
            await seedMusicEmbedding(id, 'fresh');
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_transient');

            // ~6h retry window — next_eligible_at must be in the future.
            const next = await getNextEligibleAt(sql, id, STAGE);
            expect(next).not.toBeNull();
            expect((next as Date).getTime()).toBeGreaterThan(Date.now());
        });

        it('leaves pending when embedding is stale (work remains, load-bearing)', async () => {
            const id = await insertItem(sql, {
                title: 'Stale track',
                media_type: 'track',
            });
            // Must be structurally eligible (file + audio stream) so the eligibility
            // dispose pass does not fire and we only test the author disposition.
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, is_missing, created_at, updated_at)
                VALUES (${fileId}::uuid, '/music/stale.flac', false, now(), now())
            `;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${id}::uuid)`;
            await sql`
                INSERT INTO media_streams (id, file_id, stream_type, stream_index, created_at)
                VALUES (${crypto.randomUUID()}::uuid, ${fileId}::uuid, 'audio', 0, now())
            `;
            await seedMusicEmbedding(id, 'stale');
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('leaves pending when no music embedding exists at all', async () => {
            const id = await insertItem(sql, {
                title: 'No-embedding track',
                media_type: 'track',
            });
            // Must be structurally eligible (file + audio stream) so the eligibility
            // dispose pass does not fire and we only test the author disposition.
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, is_missing, created_at, updated_at)
                VALUES (${fileId}::uuid, '/music/no-emb.flac', false, now(), now())
            `;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${id}::uuid)`;
            await sql`
                INSERT INTO media_streams (id, file_id, stream_type, stream_index, created_at)
                VALUES (${crypto.randomUUID()}::uuid, ${fileId}::uuid, 'audio', 0, now())
            `;
            await seedPendingStageRow(sql, id, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        // Order-of-operations guard: author disposition (skipped_transient for
        // up-to-date embedding) must fire BEFORE the eligibility dispose
        // (skipped_permanent for no file/audio). A track with a fresh embedding
        // also has a file and audio stream (you need them to generate an
        // embedding), so the eligibility negation does NOT match it — the L4
        // next_eligible_at guard and the orthogonal conditions both ensure the
        // eligibility pass is a no-op. This test locks in that the final status
        // is skipped_transient (author wins), not skipped_permanent (eligibility).
        // Orthogonal case: an eligible track (file + audio) with a fresh embedding.
        // The author disposition fires `skipped_transient`; the eligibility negation
        // `NOT (has_file AND has_audio)` is FALSE, so the eligibility pass is a
        // genuine no-op and the row keeps the author's transient skip. This is the
        // real protection (orthogonality), not the pass order — see the
        // `runStageDisposition` doc for the rare post-embedding audio-detach edge
        // where that orthogonality breaks (a pre-existing, separately-tracked gap).
        it('orthogonal: eligible track with fresh embedding → author skipped_transient wins, eligibility no-ops', async () => {
            const id = await insertItem(sql, {
                title: 'Order-guard track',
                media_type: 'track',
            });

            // Seed a non-missing file linked to the track so the track IS
            // structurally eligible (file + audio stream). Without this, the
            // eligibility dispose would fire first (no file → skipped_permanent)
            // and we wouldn't be testing the order concern.
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, is_missing, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/music/order-guard.flac`}, false, now(), now())
            `;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${id}::uuid)`;
            const streamId = crypto.randomUUID();
            await sql`
                INSERT INTO media_streams (id, file_id, stream_type, stream_index, created_at)
                VALUES (${streamId}::uuid, ${fileId}::uuid, 'audio', 0, now())
            `;

            // Seed a fresh music embedding so the author disposition fires.
            await sql`
                INSERT INTO media_embeddings (media_id, source, created_at, updated_at)
                VALUES (${id}::uuid, 'music', now(), now() + interval '1 hour')
            `;

            await seedPendingStageRow(sql, id, STAGE);

            const rowsDisposed = await dispose(stage);

            // Author disposition (skipped_transient) fired and disposed 1 row.
            expect(rowsDisposed).toBe(1);
            // Status must be skipped_transient (author), NOT skipped_permanent
            // (eligibility). Eligibility dispose is a no-op because the track
            // IS structurally eligible.
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_transient');
            // 6h retry window must be set.
            const next = await getNextEligibleAt(sql, id, STAGE);
            expect(next).not.toBeNull();
            expect((next as Date).getTime()).toBeGreaterThan(Date.now());
        });
    });

    describe('lumastra-intro-analyzer:visual [array] → skipped_permanent', () => {
        // Imported rather than written as a literal. Migration 16.212.0 split
        // this task's single `lumastra-intro-analyzer` stage into `:visual` +
        // `:acoustic`, and the hardcoded old id left here made `stageOf` throw
        // while the describe body was still being evaluated — which vitest
        // reports as "0 test", so the whole file's contract silently stopped
        // running instead of failing loudly. Referencing the exported constant
        // means the next rename is a compile error, not a quiet hole.
        const STAGE = ANALYZER_VISUAL_STAGE_ID;
        const stage = stageOf(lumastraIntroAnalyzerTask, STAGE);

        async function newSeason(seasonNumber: number | null): Promise<string> {
            return await insertItem(sql, {
                title: `Season ${seasonNumber ?? '?'}`,
                media_type: 'season',
                season_number: seasonNumber,
            });
        }

        async function newEpisode(parentSeasonId: string, withFile = false): Promise<string> {
            const epId = await insertItem(sql, {
                title: 'Episode',
                media_type: 'episode',
                parent_id: parentSeasonId,
            });
            if (withFile) {
                const fileId = crypto.randomUUID();
                await sql`
                    -- d046376876: eligibility uses verified file duration, not item runtime.
                    INSERT INTO media_files (id, file_path, duration_seconds, created_at, updated_at)
                    VALUES (${fileId}::uuid, ${`/t/${epId}.mkv`}, 120, now(), now())
                `;
                await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${epId}::uuid)`;
            }
            return epId;
        }

        it('specials → skipped_permanent (episode whose season.season_number=0)', async () => {
            const seasonId = await newSeason(0);
            const epId = await newEpisode(seasonId, true);
            await seedPendingStageRow(sql, epId, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, epId, STAGE)).toBe('skipped_permanent');
        });

        it('no-analyzable-episodes → skipped_permanent (season with 0 file-bearing episodes)', async () => {
            const seasonId = await newSeason(1);
            const epId = await newEpisode(seasonId, false); // episode has NO file → 0 analyzable
            await seedPendingStageRow(sql, epId, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, epId, STAGE)).toBe('skipped_permanent');
        });

        it('leaves pending: single FILE-BEARING-episode season (over-disposal guard — fallback handles it)', async () => {
            // The previous raw `COUNT(*) < 2` wrongly tombstoned this; the
            // chapter/blackframe single-episode fallback analyzes it, so it must
            // stay pending, NOT be marked skipped_permanent.
            const seasonId = await newSeason(1);
            const epId = await newEpisode(seasonId, true); // 1 file-bearing episode
            // Must satisfy eligibility (video stream + runtime > 60s) so the eligibility
            // dispose pass does not fire and we test only the terminalDisposition predicate.
            await sql`UPDATE media_items SET runtime_seconds = 120 WHERE id = ${epId}::uuid`;
            const [fileRow] = await sql<{ file_id: string }[]>`
                SELECT file_id FROM media_file_items WHERE media_item_id = ${epId}::uuid LIMIT 1
            `;
            await sql`
                INSERT INTO media_streams (id, file_id, stream_type, stream_index, created_at)
                VALUES (${crypto.randomUUID()}::uuid, ${fileRow.file_id}::uuid, 'video', 0, now())
            `;
            await seedPendingStageRow(sql, epId, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, epId, STAGE)).toBe('pending');
        });

        it('leaves pending when season has >=2 file-bearing episodes (load-bearing)', async () => {
            const seasonId = await newSeason(1);
            const ep1 = await newEpisode(seasonId, true);
            const ep2 = await newEpisode(seasonId, true); // second file-bearing sibling → chromaprint cohort
            // Both episodes must satisfy eligibility (video stream + runtime > 60s) so the
            // eligibility dispose pass does not fire on ep1.
            for (const epId of [ep1, ep2]) {
                await sql`UPDATE media_items SET runtime_seconds = 120 WHERE id = ${epId}::uuid`;
                const [fileRow] = await sql<{ file_id: string }[]>`
                    SELECT file_id FROM media_file_items WHERE media_item_id = ${epId}::uuid LIMIT 1
                `;
                await sql`
                    INSERT INTO media_streams (id, file_id, stream_type, stream_index, created_at)
                    VALUES (${crypto.randomUUID()}::uuid, ${fileRow.file_id}::uuid, 'video', 0, now())
                `;
            }
            await seedPendingStageRow(sql, ep1, STAGE);

            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, ep1, STAGE)).toBe('pending');
        });
    });

    describe('music-popularity [array] (global-guard + predicate)', () => {
        const STAGE = 'music-popularity';
        const stage = stageOf(musicPopularityTask, STAGE);

        async function seedLastfmKey(): Promise<void> {
            // Guard only checks row presence — value never decrypted.
            await sql`
                INSERT INTO plugin_secrets (plugin_id, key, value_encrypted, encryption_version)
                VALUES ('music-popularity', 'LASTFM_API_KEY', '\\x00'::bytea, 1)
            `;
        }

        it('global-guard: no LASTFM_API_KEY row → drains whole stage to skipped_transient (+~6h)', async () => {
            const artist = createTestArtist({ title: 'Guarded Artist' });
            const id = await insertItem(sql, {
                id: artist.id,
                title: artist.title,
                media_type: 'artist',
            });
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBeGreaterThanOrEqual(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_transient');

            const next = await getNextEligibleAt(sql, id, STAGE);
            expect(next).not.toBeNull();
            expect((next as Date).getTime()).toBeGreaterThan(Date.now());
        });

        it('global-guard: with LASTFM_API_KEY row → artist row untouched by the guard', async () => {
            await seedLastfmKey();
            const artist = createTestArtist({ title: 'Configured Artist' });
            const id = await insertItem(sql, {
                id: artist.id,
                title: artist.title,
                media_type: 'artist',
            });
            await seedPendingStageRow(sql, id, STAGE);

            // Guard passes (no-op); the artists-only predicate doesn't fire for
            // an artist row. Net: artist stays pending.
            await dispose(stage);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('predicate artists-only: track/album → skipped_permanent (with key seeded)', async () => {
            await seedLastfmKey();
            const trackId = await insertItem(sql, {
                title: 'A Track',
                media_type: 'track',
            });
            const albumArtistId = crypto.randomUUID();
            const album = createTestAlbum(albumArtistId, { title: 'An Album' });
            const albumId = await insertItem(sql, {
                id: album.id,
                title: album.title,
                media_type: 'album',
            });
            await seedPendingStageRow(sql, trackId, STAGE);
            await seedPendingStageRow(sql, albumId, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(2);
            expect(await getStageStatus(sql, trackId, STAGE)).toBe('skipped_permanent');
            expect(await getStageStatus(sql, albumId, STAGE)).toBe('skipped_permanent');
        });

        it('predicate artists-only: artist row stays pending (with key seeded, load-bearing)', async () => {
            await seedLastfmKey();
            const artist = createTestArtist({ title: 'Kept Artist' });
            const id = await insertItem(sql, {
                id: artist.id,
                title: artist.title,
                media_type: 'artist',
            });
            await seedPendingStageRow(sql, id, STAGE);

            await dispose(stage);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });
    });

    describe('fribb-anime-sync [array] (predicate no-tmdb-id + self-terminal)', () => {
        const STAGE = 'fribb-anime-sync';
        const stage = stageOf(fribbAnimeSyncTask, STAGE);

        it('no-tmdb-id → skipped_permanent (series with no tmdb external id)', async () => {
            const id = await insertItem(sql, {
                title: 'No-TMDB anime',
                media_type: 'tv',
            });
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        it('leaves pending when series HAS a tmdb external id (self-terminal pass is a no-op)', async () => {
            const id = await insertItem(sql, {
                title: 'TMDB anime',
                media_type: 'tv',
            });
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'tmdb', 'tv', '1429', true)
            `;
            await seedPendingStageRow(sql, id, STAGE);

            // no-tmdb-id excluded (has id); self-terminal is a no-op → pending.
            expect(await dispose(stage)).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });
    });

    describe('mal-anime-id-enrichment [array] (global-guard + predicates)', () => {
        const STAGE = 'mal-anime-id-enrichment';
        const stage = stageOf(malAnimeIdEnrichmentTask, STAGE);

        async function seedBorrowerCred(): Promise<void> {
            // listMalBorrowerCredentials reads plugin_user_credentials
            // (plugin_id='mal-watch-sync', key='access_token') via PluginSecrets,
            // which DECRYPTS — so we must write via the same encryptor.
            // plugin_user_credentials.user_id is now UUID FK → users(id) after
            // migration 16.46.0 — ensure the user row exists first.
            const userId = crypto.randomUUID();
            await sql`
                INSERT INTO users (id, username)
                VALUES (${userId}::uuid, ${derivedUsername(userId)})
                ON CONFLICT (id) DO NOTHING
            `;
            await new PluginSecrets(sql).setUser('mal-watch-sync', userId, 'access_token', 'tok');
        }

        async function addMalSeriesId(id: string): Promise<void> {
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'mal', 'tv', '1', false)
            `;
        }

        async function addAnimeGenres(id: string): Promise<void> {
            await sql`
                INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at, updated_at)
                VALUES (${id}::uuid, 'mal', '{"anime_genres": ["Action"]}'::jsonb, now(), now())
            `;
        }

        it('global-guard: no MAL borrower cred → drains pending to skipped_transient (+~24h)', async () => {
            const id = await insertItem(sql, {
                title: 'Guarded series',
                media_type: 'tv',
            });
            // give it a MAL id + anime genres so ONLY the guard could fire
            await addMalSeriesId(id);
            await addAnimeGenres(id);
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBeGreaterThanOrEqual(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_transient');

            const next = await getNextEligibleAt(sql, id, STAGE);
            expect(next).not.toBeNull();
            expect((next as Date).getTime()).toBeGreaterThan(Date.now());
        });

        it('global-guard: with borrower cred → fully eligible series stays pending', async () => {
            await seedBorrowerCred();
            const id = await insertItem(sql, {
                title: 'Eligible series',
                media_type: 'tv',
            });
            await addMalSeriesId(id);
            await addAnimeGenres(id);
            await seedPendingStageRow(sql, id, STAGE);

            // guard passes; both predicates excluded (has mal id + anime genres);
            // self-terminal is a no-op → stays pending.
            await dispose(stage);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });

        it('predicate no-mal-series-id → skipped_permanent (cred present, no mal id)', async () => {
            await seedBorrowerCred();
            const id = await insertItem(sql, {
                title: 'No MAL id series',
                media_type: 'tv',
            });
            await addAnimeGenres(id); // anime genres present so only the mal-id predicate fires
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        // requiresUpstreamRun gate: not-in-anime-catalog must not fire until
        // mdblist-sync (which writes anime_genres) has terminally run for the item.
        async function seedMdblistTerminal(id: string): Promise<void> {
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, completed_at)
                VALUES (${id}::uuid, 'mdblist-sync', 1, 'completed', now())
            `;
        }

        it('predicate not-in-anime-catalog → skipped_permanent (cred + mal id, no anime genres, mdblist ran)', async () => {
            await seedBorrowerCred();
            const id = await insertItem(sql, {
                title: 'Not-anime series',
                media_type: 'tv',
            });
            await addMalSeriesId(id); // has mal id so only the anime-catalog predicate fires
            await seedMdblistTerminal(id); // H2: open the requiresUpstreamRun gate
            await seedPendingStageRow(sql, id, STAGE);

            const result = await dispose(stage);
            expect(result).toBe(1);
            expect(await getStageStatus(sql, id, STAGE)).toBe('skipped_permanent');
        });

        it('predicate not-in-anime-catalog does NOT fire before mdblist-sync runs (H2 requiresUpstreamRun)', async () => {
            await seedBorrowerCred();
            const id = await insertItem(sql, {
                title: 'Pre-mdblist anime series',
                media_type: 'tv',
            });
            await addMalSeriesId(id); // has mal id; no anime genres yet AND no mdblist-sync row
            await seedPendingStageRow(sql, id, STAGE);

            // The requiresUpstreamRun:'mdblist-sync' gate is CLOSED (no terminal
            // upstream row), so the not-in-anime-catalog skip must be suppressed —
            // a genuine anime cataloged before the first mdblist-sync run is NOT
            // wrongly tombstoned. It stays pending until mdblist-sync runs.
            const result = await dispose(stage);
            expect(result).toBe(0);
            expect(await getStageStatus(sql, id, STAGE)).toBe('pending');
        });
    });

    // ── SELF-TERMINAL stages — disposition is a NO-OP (rowsDisposed 0) ───
    //
    // These tasks guarantee a terminal stage_state write per item inside
    // execute(); the framework never bulk-drains them. The per-item guarantee
    // is covered by each task's own unit tests, not here.

    describe.each([
        ['series-sync', () => seriesSyncTask, 'series-sync', 'tv'],
        ['image-sync', () => imageSyncTask, 'image-sync', 'movie'],
        ['chapter-sync', () => chapterSyncTask, 'chapter-sync', 'movie'],
        ['tmdb-metadata-sync', () => tmdbMetadataSyncRealTask, 'tmdb-metadata-sync', 'movie'],
        ['music-analysis', () => musicAnalysisTask, 'music-analysis', 'track'],
        ['trickplay-params-sync', () => trickplayParamsSyncTask, 'trickplay-params-sync', 'movie'],
    ] as const)('self-terminal: %s', (label, getTask, stageId, mediaType) => {
        it('disposition is a no-op — pending row stays pending (rowsDisposed 0)', async () => {
            const stage = stageOf(getTask(), stageId);
            const id = await insertItem(sql, {
                title: `${label} item`,
                media_type: mediaType,
            });
            // Seed a non-missing file with both audio and video streams so that
            // any eligibility.sql the stage declares is satisfied, ensuring the
            // eligibility dispose pass is a no-op. Stages without eligibility.sql
            // are unaffected by the extra rows.
            const fileId = crypto.randomUUID();
            await sql`
                INSERT INTO media_files (id, file_path, is_missing, created_at, updated_at)
                VALUES (${fileId}::uuid, ${`/media/${label}.mkv`}, false, now(), now())
            `;
            await sql`INSERT INTO media_file_items (file_id, media_item_id) VALUES (${fileId}::uuid, ${id}::uuid)`;
            await sql`
                INSERT INTO media_streams (id, file_id, stream_type, stream_index, created_at)
                VALUES (${crypto.randomUUID()}::uuid, ${fileId}::uuid, 'audio', 0, now()),
                       (${crypto.randomUUID()}::uuid, ${fileId}::uuid, 'video', 1, now())
            `;
            await seedPendingStageRow(sql, id, stageId);

            const result = await dispose(stage);
            expect(result).toBe(0);
            expect(await getStageStatus(sql, id, stageId)).toBe('pending');
        });
    });

    // ── stage-wedge-guard health invariant — requiresUpstreamRun gate ────
    //
    // Regression for a false-positive class: the invariant's Check 1a asks
    // "would the real disposer have cleared this row by now?" but was
    // computing that from `disposition.excludes` alone, without the
    // `requiresUpstreamRun` gate `runPredicate` (above) AND-composes before
    // it will actually dispose a row. A row correctly waiting on a slow
    // feeder (e.g. mal-anime-id-enrichment's `not-in-anime-catalog` rule
    // waiting on mdblist-sync, tested above) was counted as "wedged" purely
    // because mdblist-sync hadn't caught up yet — flooding stage-wedge-guard
    // red on a perfectly healthy, still-draining backlog (prod: 561 false
    // positives from this exact stage/predicate pair).
    describe("invariant 'stage-wedge-guard' — requiresUpstreamRun gate", () => {
        const wedgeGuard = INVARIANTS.find((i) => i.id === 'stage-wedge-guard');
        if (!wedgeGuard) throw new Error("invariant 'stage-wedge-guard' not registered");
        const STAGE = 'mal-anime-id-enrichment';

        async function backdateStageRow(id: string, stageId: string): Promise<void> {
            // Push past WEDGE_DISPOSE_GRACE_MINUTES (60m) so Check 1a considers it.
            await sql`
                UPDATE media_item_stage_state
                   SET updated_at = now() - interval '2 hours'
                 WHERE media_item_id = ${id}::uuid AND stage_id = ${stageId}
            `;
        }

        it('does NOT count a row waiting on requiresUpstreamRun (mdblist-sync not yet run) as wedged', async () => {
            const id = await insertItem(sql, {
                title: 'Pre-mdblist anime series (wedge-guard regression)',
                media_type: 'tv',
            });
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'mal', 'tv', '1', false)
            `;
            // No anime_genres → 'not-in-anime-catalog' excludes is TRUE, but
            // mdblist-sync (which writes anime_genres) has never run for this
            // item — the requiresUpstreamRun gate should suppress the count.
            await seedPendingStageRow(sql, id, STAGE);
            await backdateStageRow(id, STAGE);

            expect(await wedgeGuard.query(sql)).toBe(0);
        });

        it('DOES count it once mdblist-sync has terminally run and the row is still stuck (genuine wedge)', async () => {
            const id = await insertItem(sql, {
                title: 'Post-mdblist anime series (wedge-guard regression)',
                media_type: 'tv',
            });
            await sql`
                INSERT INTO external_ids (media_id, provider, media_type, external_id, is_primary)
                VALUES (${id}::uuid, 'mal', 'tv', '1', false)
            `;
            await sql`
                INSERT INTO media_item_stage_state (media_item_id, stage_id, processing_version, status, completed_at)
                VALUES (${id}::uuid, 'mdblist-sync', 1, 'completed', now())
            `;
            await seedPendingStageRow(sql, id, STAGE);
            await backdateStageRow(id, STAGE);

            expect(await wedgeGuard.query(sql)).toBe(1);
        });
    });
});
