// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { TaskRegistry } from '$lib/server/tasks/registry.js';
import type {
    MediaItemSnapshot,
    MediaType,
    StageStatus,
    CoversStagesDeclaration,
    StageInvalidationKind,
    PipelineEventName,
} from '$lib/types/pipeline.js';
import {
    insertPendingRow,
    deleteRowsForItem as deleteRowsForItemQuery,
} from '$lib/server/database/queries/stage-state.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import { stageProcessingVersion } from '$lib/server/tasks/stage-processing-version.js';
import { publishStageStateChange } from '$lib/server/cache/pipeline-pubsub.js';
import { withTx } from '$lib/server/database/with-tx.js';
import { isSeries } from '$lib/server/utils/media-types.js';
import {
    classesOverDepthThreshold,
    type QueueDepthCounts,
} from '$lib/server/tasks/queue-depth-throttle.js';
import { ELIGIBILITY_SKIP_REASON } from '$lib/server/tasks/stage-disposition-runner.js';

/**
 * Sentinel UUID no real media item can have, used to detect a "global-identity"
 * task (one whose `identityFor` ignores `mediaItemId` and collapses every enqueue
 * to a single global run): `identityFor({mediaItemId: SENTINEL})` equals
 * `identityFor({mediaItemId: <any real id>})` iff the task is global. Shared by
 * `eagerEnqueueForStages` here and the stage-sweep so both detect it identically.
 */
export const GLOBAL_IDENTITY_SENTINEL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The events each legacy `StageInvalidationKind` expands to — used by the
 * (outbox-off only) `invalidateByKind` path to match stages that now declare
 * interest via the typed `PipelineEventName` taxonomy. Mirrors the inverse of the
 * deleted pipeline-event-shim's `kindForEvent`.
 */
const EVENTS_FOR_KIND: Record<StageInvalidationKind, ReadonlyArray<PipelineEventName>> = {
    'file-content': [
        'file.attached',
        'file.detached',
        'file.contentChanged',
        'file.defaultChanged',
    ],
    identity: ['identity.assigned', 'identity.changed', 'identity.cleared'],
    metadata: ['metadata.changed'],
};

const log = Logger.for('StageStateService');

/**
 * Whether a freshly-seeded `pending` row for this stage is safe to EAGER-ENQUEUE
 * at seed time (vs leaving it for the sweep).
 *
 * A stage that declares `eligibility.sql` (native, probe-derived eligibility) is
 * almost never eligible at seed — the data its SQL reads (file linkage, probe
 * streams) does not exist yet — so eager-enqueuing it would fire a no-op run that
 * the sweep's dispose pass would immediately tombstone (the eager-enqueue analogue
 * of the WI-5 no-op herd). Those stages are driven exclusively by the sweep, which
 * disposes-ineligible-then-enqueues in one tick. Stages whose eligibility is fully
 * decided at seed (no `eligibility.sql` — i.e. media-type-only, or an immutable
 * `appliesTo` that already passed to create the row) are genuinely eligible now and
 * safe to eager-enqueue.
 */
function isEagerEnqueueableAtSeed(stage: CoversStagesDeclaration): boolean {
    return stage.eligibility?.sql === undefined;
}

export interface ClassifiedStage {
    stage: CoversStagesDeclaration;
    taskId: string;
    // Seed writes `skipped_permanent` ONLY for an immutable/external `eligibility.appliesTo` that returns
    // false (with reason 'ineligible') — never for a probe-derived `eligibility.sql` reason (those seed
    // `pending` and the sweep dispose pass demotes the ineligible ones, which is what makes the cold-start
    // data-loss class structurally impossible). `skipped_transient` is retained for type-shape stability.
    initialStatus: Extract<StageStatus, 'pending' | 'skipped_permanent' | 'skipped_transient'>;
    skippedReason?: string;
}

export type StartRunFn = (
    taskId: string,
    input: Record<string, unknown>,
    opts: {
        trigger: { kind: string; sourceRoute: string };
        idempotencyKey: string;
    },
) => Promise<unknown>;

/**
 * Snapshot of per-resource-class BullMQ queue depths. Injected for tests; in
 * production it lazy-binds to `orchestrator.getQueueDepths`. Used by the eager
 * enqueue path to back off on the same thresholds `stage-sweep` honors.
 */
export type GetQueueDepthsFn = () => Promise<Record<string, QueueDepthCounts>>;

/**
 * Sink for side effects that must run AFTER the caller's transaction commits,
 * never inside it. The pipeline event dispatcher passes one of these so that
 * Valkey pub/sub (`publishStageStateChange`) and BullMQ enqueue
 * (`eagerEnqueueForStages`) happen outside the `FOR UPDATE` outbox-row
 * transaction — holding that lock across network I/O serialized the whole
 * outbox behind one slow enqueue (SQL-C5 / F39).
 *
 * Correctness contract: effects are only ever flushed after a successful
 * commit. If the transaction rolls back (handler failure), the collected
 * effects are discarded and never run — so a failing row can't leak a
 * pub/sub event or an enqueue for a stage flip that was rolled back. On the
 * next retry the DB writes re-run and re-collect their effects, preserving
 * the original atomic "flip + consume → then notify" semantics.
 */
export interface DeferredSideEffects {
    push(effect: () => Promise<void>): void;
}

export class StageStateService {
    private readonly startRunFn: StartRunFn | null;
    private readonly getQueueDepthsFn: GetQueueDepthsFn | null;

    constructor(
        private readonly sql: postgres.Sql,
        private readonly registry: TaskRegistry,
        startRunFn?: StartRunFn,
        getQueueDepthsFn?: GetQueueDepthsFn,
    ) {
        this.startRunFn = startRunFn ?? null;
        this.getQueueDepthsFn = getQueueDepthsFn ?? null;
    }

    /**
     * Run a side effect now, or hand it to a deferred sink to run after the
     * caller's transaction commits. When deferring, failures surface when the
     * sink is flushed (post-commit, best-effort) rather than here.
     */
    private async runOrDefer(
        effects: DeferredSideEffects | undefined,
        effect: () => Promise<void>,
    ): Promise<void> {
        if (effects) {
            effects.push(effect);
            return;
        }
        await effect();
    }

    async loadItemSnapshot(mediaItemId: string, sql = this.sql): Promise<MediaItemSnapshot | null> {
        const rows = await sql<
            {
                id: string;
                media_type: string;
                has_audio: boolean;
                has_video: boolean;
                has_file: boolean;
                runtime_seconds: number | null;
                tmdb_id: number | null;
                imdb_id: string | null;
                mbid: string | null;
                created_at: Date;
            }[]
        >`
            SELECT
                mi.id,
                mi.media_type,
                COALESCE((
                    SELECT bool_or(ms.stream_type = 'audio')
                      FROM media_file_items mfi
                      JOIN media_streams ms ON ms.file_id = mfi.file_id
                     WHERE mfi.media_item_id = mi.id
                ), false) AS has_audio,
                COALESCE((
                    SELECT bool_or(ms.stream_type = 'video')
                      FROM media_file_items mfi
                      JOIN media_streams ms ON ms.file_id = mfi.file_id
                     WHERE mfi.media_item_id = mi.id
                ), false) AS has_video,
                -- True iff the item has at least one media_file_items link,
                -- regardless of whether the underlying file has been probed
                -- yet. Stages that strictly need a local file use this to
                -- short-circuit their eligibility predicate.
                EXISTS (
                    SELECT 1 FROM media_file_items mfi
                     WHERE mfi.media_item_id = mi.id
                ) AS has_file,
                mi.runtime_seconds,
                (SELECT external_id::int FROM external_ids
                  WHERE media_id = mi.id AND provider = 'tmdb' LIMIT 1) AS tmdb_id,
                (SELECT external_id FROM external_ids
                  WHERE media_id = mi.id AND provider = 'imdb' LIMIT 1) AS imdb_id,
                (SELECT external_id FROM external_ids
                  WHERE media_id = mi.id AND provider = 'musicbrainz_recording' LIMIT 1) AS mbid,
                mi.created_at
              FROM media_items mi
             WHERE mi.id = ${mediaItemId}::uuid
             LIMIT 1
        `;
        const r = rows[0];
        if (!r) {
            log.debug('loadItemSnapshot: not found', { mediaItemId });
            return null;
        }
        // The DB constraint on media_items.media_type uses the legacy lowercase
        // value 'tv' for series rows (alongside 'movie', 'episode', etc.). The
        // SDK-facing canonical name is 'series' — every builtin task declares
        // `appliesTo: ['series', ...]`. Translate at the snapshot boundary so
        // the inner machinery (eligibility predicate, applicableStages,
        // invalidateByKind) operates exclusively on canonical names.
        const canonicalMediaType = (isSeries(r.media_type) ? 'series' : r.media_type) as MediaType;
        return {
            id: r.id,
            media_type: canonicalMediaType,
            has_audio: r.has_audio,
            has_video: r.has_video,
            has_file: r.has_file,
            runtime_seconds: r.runtime_seconds,
            provider_tmdb_id: r.tmdb_id,
            provider_imdb_id: r.imdb_id,
            provider_musicbrainz_id: r.mbid,
            added_at: r.created_at,
        };
    }

    /** Stages whose appliesTo covers the item's media_type. Predicate NOT applied. */
    applicableStages(snap: MediaItemSnapshot): Array<CoversStagesDeclaration & { taskId: string }> {
        const out: Array<CoversStagesDeclaration & { taskId: string }> = [];
        for (const task of this.registry.getAllTasks()) {
            if (!task.coversStages) continue;
            for (const stage of task.coversStages) {
                if (stage.appliesTo.includes(snap.media_type)) {
                    out.push({ ...stage, taskId: task.id });
                }
            }
        }
        return out;
    }

    /**
     * Classify each applicable stage for a newly-created item.
     *
     * Under the unified eligibility contract, seed NEVER writes `skipped_permanent` for a PROBE-DERIVED
     * (`eligibility.sql`) reason — those rows are seeded `pending` and the FIRST sweep dispose pass demotes
     * the ineligible ones to `skipped_permanent/'ineligible'` against live SQL (re-evaluated every tick, so
     * "permanent" is always recoverable). That is what makes the cold-start data-loss class structurally
     * impossible.
     *
     * The immutable/external `eligibility.appliesTo` predicate is the ONE seed-time gate. When it returns
     * false the row is seeded `skipped_permanent/'ineligible'` (NOT omitted): the row MUST exist so the
     * recovery paths can reach it — `invalidateByEvent` flips it back to `pending` when an interested event
     * fires (the only recovery for a NON-enqueueable stage like integrity-scanner, e.g. on `file.attached`),
     * and the sweep's external heal re-evaluates `appliesTo` for enqueueable stages. (Omitting the row would
     * strand it: `findItemsMissingCoverage` only re-seeds items with ZERO stage rows, so an item that
     * already has rows for other stages would never get this one back.) `appliesTo` must gate only on
     * fields that are eventually satisfied + carry a matching `invalidatedBy` event, per its contract.
     */
    classifyStagesForCreate(snap: MediaItemSnapshot): ClassifiedStage[] {
        const out: ClassifiedStage[] = [];
        for (const stage of this.applicableStages(snap)) {
            const appliesTo = stage.eligibility?.appliesTo;
            if (appliesTo) {
                let eligible: boolean;
                try {
                    eligible = appliesTo(snap);
                } catch (err) {
                    // A throwing predicate must not lose the item: seed it pending (the sweep dispose pass
                    // re-checks eligibility.sql, or the external heal re-checks appliesTo).
                    log.warn('eligibility.appliesTo threw at seed; seeding pending anyway', {
                        mediaItemId: snap.id,
                        stageId: stage.id,
                        error: err instanceof Error ? err.message : String(err),
                    });
                    eligible = true;
                }
                if (!eligible) {
                    out.push({
                        stage,
                        taskId: stage.taskId,
                        initialStatus: 'skipped_permanent' as const,
                        skippedReason: ELIGIBILITY_SKIP_REASON,
                    });
                    continue;
                }
            }
            out.push({ stage, taskId: stage.taskId, initialStatus: 'pending' as const });
        }
        return out;
    }

    /**
     * Seed initial coverage rows for a newly-created (or reclaimed) item.
     *
     * @param sqlHandle Optional SQL handle override. Callers already inside a
     *   transaction (the pipeline event dispatcher's per-row tx, which handles
     *   `item.created`/`item.reclaimed`) pass `tx` here so the coverage INSERTs
     *   commit atomically with the outbox consume. When omitted, this opens its
     *   own transaction (the app-side `afterCreated` hook path).
     */
    async seedRowsForCreate(
        mediaItemId: string,
        sqlHandle?: postgres.Sql,
        effects?: DeferredSideEffects,
    ): Promise<void> {
        const snap = await this.loadItemSnapshot(mediaItemId);
        if (!snap) {
            log.warn('seedRowsForCreate: media item not found', {
                mediaItemId,
            });
            return;
        }
        const classified = this.classifyStagesForCreate(snap);
        const processingVersions = new Map<string, number>();
        const insertedStages: ClassifiedStage[] = [];

        const insertAll = async (tx: postgres.Sql): Promise<void> => {
            for (const c of classified) {
                const taskDef = this.registry.getTask(c.taskId);
                const processingVersion = taskDef ? stageProcessingVersion(taskDef, c.stage) : 1;
                processingVersions.set(c.stage.id, processingVersion);
                const inserted = await insertPendingRow(tx, {
                    mediaItemId,
                    stageId: c.stage.id,
                    processingVersion,
                    initialStatus: c.initialStatus,
                    skippedReason: c.skippedReason,
                });
                if (inserted) insertedStages.push(c);
            }
        };

        if (sqlHandle) {
            // Already inside the caller's transaction — insert directly so the
            // seed commits atomically with the outbox consume. Opening a nested
            // `begin()` here would create a savepoint that the dispatcher does
            // not want (a seed failure must roll back the whole row tx).
            await insertAll(sqlHandle);
        } else {
            await withTx(this.sql, async (txRaw) => {
                // postgres.js types TransactionSql and Sql as distinct generics despite
                // being structurally compatible at runtime; cast via unknown to satisfy them.
                await insertAll(txRaw);
            });
        }
        const timestamp = new Date().toISOString();
        // ON CONFLICT makes the INSERT idempotent; its enqueue must be too.
        // A delayed item.created / afterCreated must not restart completed work.
        for (const c of insertedStages) {
            await this.runOrDefer(effects, () =>
                publishStageStateChange({
                    kind: 'seed',
                    mediaItemId,
                    stageId: c.stage.id,
                    newStatus: c.initialStatus,
                    processingVersion: processingVersions.get(c.stage.id) ?? 1,
                    timestamp,
                }),
            );
        }
        const pendingStageIds = insertedStages
            .filter((c) => c.initialStatus === 'pending' && isEagerEnqueueableAtSeed(c.stage))
            .map((c) => c.stage.id);
        await this.runOrDefer(effects, () =>
            this.eagerEnqueueForStages(mediaItemId, pendingStageIds),
        );
    }

    /**
     * Seed coverage rows for many items in a single transaction.
     *
     * The stage-sweep self-heal loop discovers items that should have
     * coverage rows but don't, then needs to seed each one. Calling
     * `seedRowsForCreate` per item opens a fresh transaction per item
     * (~15–75 ms each, one task-pool connection held per item) — under a
     * bulk import that pins a connection for the whole self-heal tick. This
     * batches the INSERTs for the whole tick into one transaction so the
     * connection is held once, not N times.
     *
     * Side effects (pub/sub seed events + eager-enqueue) run AFTER the
     * transaction commits, per item, matching `seedRowsForCreate`'s
     * post-commit ordering. A snapshot that can't be loaded (item deleted
     * between the find query and now) is skipped, not fatal — the next tick
     * re-discovers anything still missing.
     *
     * @returns the number of items that were successfully seeded.
     */
    async seedRowsForBatch(mediaItemIds: string[]): Promise<number> {
        if (mediaItemIds.length === 0) return 0;

        // Load + classify outside the transaction so the connection is only
        // held for the INSERTs. Each entry carries everything the post-commit
        // side effects need.
        const seeds: Array<{
            mediaItemId: string;
            classified: ClassifiedStage[];
            processingVersions: Map<string, number>;
        }> = [];

        for (const mediaItemId of mediaItemIds) {
            const snap = await this.loadItemSnapshot(mediaItemId);
            if (!snap) {
                log.debug('seedRowsForBatch: media item not found, skipping', {
                    mediaItemId,
                });
                continue;
            }
            const classified = this.classifyStagesForCreate(snap);
            const processingVersions = new Map<string, number>();
            for (const c of classified) {
                const taskDef = this.registry.getTask(c.taskId);
                processingVersions.set(
                    c.stage.id,
                    taskDef ? stageProcessingVersion(taskDef, c.stage) : 1,
                );
            }
            seeds.push({ mediaItemId, classified, processingVersions });
        }

        if (seeds.length === 0) return 0;

        const insertSeed = async (
            tx: postgres.Sql,
            seed: (typeof seeds)[number],
        ): Promise<(typeof seeds)[number]> => {
            const insertedStages: ClassifiedStage[] = [];
            for (const c of seed.classified) {
                const inserted = await insertPendingRow(tx, {
                    mediaItemId: seed.mediaItemId,
                    stageId: c.stage.id,
                    processingVersion: seed.processingVersions.get(c.stage.id) ?? 1,
                    initialStatus: c.initialStatus,
                    skippedReason: c.skippedReason,
                });
                if (inserted) insertedStages.push(c);
            }
            return { ...seed, classified: insertedStages };
        };

        // Single transaction for every item's INSERTs (the fast path). On
        // failure, fall back to per-item transactions so one deterministically-
        // failing "poison" item can't wedge the whole self-heal lane forever:
        // the batch would otherwise roll back and the next tick re-selects the
        // same items by created_at ASC, retrying the poison every tick (D4).
        let committed: typeof seeds = [];
        try {
            const insertedSeeds: typeof seeds = [];
            await withTx(this.sql, async (txRaw) => {
                const tx = txRaw as unknown as postgres.Sql;
                for (const seed of seeds) insertedSeeds.push(await insertSeed(tx, seed));
            });
            committed = insertedSeeds;
        } catch (batchErr) {
            log.warn(
                'seedRowsForBatch: batch tx failed; retrying per-item to isolate the poison row',
                {
                    count: seeds.length,
                    error: batchErr instanceof Error ? batchErr.message : String(batchErr),
                },
            );
            for (const seed of seeds) {
                try {
                    const insertedSeed = await withTx(this.sql, (txRaw) => insertSeed(txRaw, seed));
                    committed.push(insertedSeed);
                } catch (itemErr) {
                    log.error(
                        'seedRowsForBatch: skipping poison item (seed failed in isolation)',
                        itemErr instanceof Error ? itemErr : new Error(String(itemErr)),
                        { mediaItemId: seed.mediaItemId },
                    );
                }
            }
        }

        // Post-commit side effects, per item (matches seedRowsForCreate) — only
        // for items whose rows actually committed.
        const timestamp = new Date().toISOString();
        for (const seed of committed) {
            for (const c of seed.classified) {
                await publishStageStateChange({
                    kind: 'seed',
                    mediaItemId: seed.mediaItemId,
                    stageId: c.stage.id,
                    newStatus: c.initialStatus,
                    processingVersion: seed.processingVersions.get(c.stage.id) ?? 1,
                    timestamp,
                });
            }
            const pendingStageIds = seed.classified
                .filter((c) => c.initialStatus === 'pending' && isEagerEnqueueableAtSeed(c.stage))
                .map((c) => c.stage.id);
            await this.eagerEnqueueForStages(seed.mediaItemId, pendingStageIds);
        }

        return committed.length;
    }

    /**
     * Seed the row for ONE stage across a batch of items that are missing it.
     *
     * 🔴 The counterpart to {@link seedRowsForBatch}, which seeds EVERY
     * applicable stage and is therefore only reachable for an item that has no
     * rows at all. This one repairs the per-stage gap: seeding writes rows for
     * whatever `applicableStages` sees in the registry at that moment, so a
     * stage whose coverage was declared after an item was seeded never gets a
     * row and nothing ever notices — the item is not "pending", it is absent.
     *
     * Eligibility is classified exactly as at create time, so an item the
     * stage does not apply to lands `skipped_permanent` rather than being
     * enqueued and bounced. Items whose media_type the stage does not cover
     * are skipped outright.
     *
     * Deliberately NOT wrapped in one transaction across the batch: this runs
     * as a background backfill over a large catalogue, and a single poison row
     * must cost its own item rather than the whole batch's progress. Returns
     * the number of rows actually seeded.
     */
    async seedStageRowForBatch(
        stageId: string,
        mediaItemIds: string[],
        opts: { eagerEnqueue?: boolean } = {},
    ): Promise<number> {
        if (mediaItemIds.length === 0) return 0;
        // Eager enqueue exists for the INGEST path, where a freshly created item
        // would otherwise sit until the next sweep tick. A caller that is ITSELF
        // the sweep must opt out: its own enqueue pass runs moments later in the
        // same tick over exactly these now-`pending` rows, so eager-enqueuing
        // here dispatches the same (stage, item) pair twice — same idempotency
        // key, two runs.
        const eagerEnqueue = opts.eagerEnqueue ?? true;
        const timestamp = new Date().toISOString();
        let seeded = 0;

        for (const mediaItemId of mediaItemIds) {
            const snap = await this.loadItemSnapshot(mediaItemId);
            if (!snap) continue;

            // Re-derive applicability per item: appliesTo is a media_type gate,
            // and the caller's SQL filter is a coarse pre-filter, not the
            // authority.
            const stage = this.applicableStages(snap).find((c) => c.id === stageId);
            if (!stage) continue;

            const classified = this.classifyStagesForCreate(snap).find(
                (c) => c.stage.id === stageId,
            );
            if (!classified) continue;

            const ownerTask = this.registry.getTask(stage.taskId);
            const processingVersion = ownerTask ? stageProcessingVersion(ownerTask, stage) : 1;
            try {
                // insertPendingRow is ON CONFLICT DO NOTHING and reports
                // whether it actually inserted — a row a racing writer created
                // first must not be counted, nor announced as a fresh seed.
                const inserted = await insertPendingRow(this.sql, {
                    mediaItemId,
                    stageId,
                    processingVersion,
                    initialStatus: classified.initialStatus,
                    ...(classified.skippedReason !== undefined
                        ? { skippedReason: classified.skippedReason }
                        : {}),
                });
                if (!inserted) continue;
            } catch (err) {
                log.warn('seedStageRowForBatch: seed failed for item', {
                    mediaItemId,
                    stageId,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }
            seeded++;

            await publishStageStateChange({
                kind: 'seed',
                mediaItemId,
                stageId,
                newStatus: classified.initialStatus,
                processingVersion,
                timestamp,
            });
            if (
                eagerEnqueue &&
                classified.initialStatus === 'pending' &&
                isEagerEnqueueableAtSeed(stage)
            ) {
                await this.eagerEnqueueForStages(mediaItemId, [stageId]);
            }
        }
        return seeded;
    }

    /**
     * Delete every coverage row for an item. Used by the dismissal/deletion
     * paths (the item is leaving the pipeline, so its stage_state rows must go,
     * not flip back to `pending`).
     *
     * @param sqlHandle Optional SQL handle override. The pipeline event
     *   dispatcher passes its per-row `tx` so the DELETE commits atomically with
     *   the outbox consume (matching `invalidateByEvent`/`seedRowsForCreate`).
     * @param effects Optional deferred sink. When the dispatcher provides one,
     *   the Valkey pub/sub notification runs AFTER the outbox tx commits instead
     *   of inside the `FOR UPDATE` lock (SQL-C5 / F39).
     */
    async deleteRowsForItem(
        mediaItemId: string,
        sqlHandle?: postgres.Sql,
        effects?: DeferredSideEffects,
    ): Promise<void> {
        const sql = sqlHandle ?? this.sql;
        await deleteRowsForItemQuery(sql, mediaItemId);
        // Publish a single summary event — consumer keys on kind='delete'.
        // stageId='*' signals all stages for this item were removed.
        await this.runOrDefer(effects, () =>
            publishStageStateChange({
                kind: 'delete',
                mediaItemId,
                stageId: '*',
                newStatus: 'pending',
                processingVersion: 0,
                timestamp: new Date().toISOString(),
            }),
        );
    }

    async invalidateByKind(mediaItemId: string, kind: StageInvalidationKind): Promise<void> {
        const snap = await this.loadItemSnapshot(mediaItemId);
        if (!snap) return;

        // Legacy direct path (only reached when FEATURE_PIPELINE_EVENT_OUTBOX is
        // OFF — the DB triggers don't emit events, so the lifecycle service drives
        // invalidation by `kind`). Stages now declare interest via the typed
        // `PipelineEventName` taxonomy (arch #4 removed the legacy-kind shim), so
        // expand the kind to its equivalent event set and match any stage
        // interested in one of them — behaviour-identical to the old kind match.
        const events = EVENTS_FOR_KIND[kind];
        const stageIds = this.applicableStages(snap)
            .filter((s) => s.invalidatedBy?.some((e) => events.includes(e)))
            .map((s) => s.id);

        if (stageIds.length === 0) return;

        const affected = await this.sql<{ stage_id: string; processing_version: number }[]>`
            UPDATE media_item_stage_state
               SET status = 'pending',
                   attempt = 0,
                   declines = 0,
                   declines_since = NULL,
                   last_error = NULL,
                   next_eligible_at = NULL,
                   updated_at = now()
             WHERE media_item_id = ${mediaItemId}::uuid
               AND stage_id = ANY(${stageIds})
               AND status IN ('completed', 'failed_transient', 'skipped_transient', 'skipped_permanent', 'obsolete')
         RETURNING stage_id, processing_version
        `;
        const timestamp = new Date().toISOString();

        for (const row of affected) {
            await publishStageStateChange({
                kind: 'invalidate',
                mediaItemId,
                stageId: row.stage_id,
                newStatus: 'pending',
                processingVersion: row.processing_version,
                timestamp,
            });
        }
        await this.eagerEnqueueForStages(
            mediaItemId,
            affected.map((r) => r.stage_id),
        );
    }

    /**
     * Re-evaluate every stage that declared interest in `event` for this item. Stages whose
     * `eligibility.appliesTo` now returns true (or stages with only `eligibility.sql`, or no eligibility
     * block at all) get their non-pending coverage rows flipped back to `pending` and eager-enqueued.
     * Stages whose `appliesTo` now returns false are LEFT AS-IS — the event path no longer disposes them;
     * the next sweep dispose pass (against live SQL) demotes still-ineligible rows to
     * `skipped_permanent/'ineligible'` before the enqueue pass, so nothing is enqueued as a no-op.
     *
     * This is the entry point used by Phase B's pipeline event dispatcher. The shim in `invalidateByKind`
     * calls into it during the migration window so both call paths converge.
     */
    async invalidateByEvent(
        mediaItemId: string,
        event: PipelineEventName,
        /**
         * Optional SQL handle override. Callers inside a larger transaction
         * (the pipeline event dispatcher's per-row tx) pass `tx` here so the
         * stage_state UPDATE commits atomically with the outbox consume.
         * Without this, a handler failure that rolled back the outbox tx
         * would leave the stage already flipped to `pending` on the pool
         * connection — and every retry would re-fire the publishStageStateChange
         * pubsub event, producing up to MAX_ATTEMPTS duplicate events per
         * failing handler.
         */
        sqlHandle?: postgres.Sql,
        /**
         * Optional sink for post-commit side effects (Valkey pub/sub + BullMQ
         * enqueue). The dispatcher passes one so this network I/O runs AFTER
         * its `FOR UPDATE` outbox-row transaction commits instead of while the
         * row lock is held (SQL-C5 / F39). When omitted, side effects run
         * inline (legacy direct callers).
         */
        effects?: DeferredSideEffects,
        /** Outbox event identity, used to compare its DB timestamp without losing precision. */
        eventOutboxId?: string,
        /** Limit an ancestor fan-up to the stages owning that ancestor's work. */
        onlyStages?: readonly string[],
    ): Promise<void> {
        const sql = sqlHandle ?? this.sql;
        const snap = await this.loadItemSnapshot(mediaItemId, sql);
        if (!snap) return;

        // Every stage now declares interest via the typed `PipelineEventName`
        // taxonomy (the legacy `StageInvalidationKind` shim was removed in arch #4),
        // so a plain membership test is the matcher.
        const interested = this.applicableStages(snap).filter(
            (s) =>
                (!onlyStages || onlyStages.includes(s.id)) &&
                (s.invalidatedBy?.includes(event) ?? false),
        );

        // Re-evaluate predicate now — split interested stages into two buckets
        // via ONE evaluation per stage. Calling the predicate twice (once for
        // each filter) would let an impure predicate disagree across buckets
        // and place the same stage in both. The single-eval also lets us trap
        // plugin-author exceptions per-stage instead of letting one bad
        // predicate abort the whole dispatcher tx (which would deadlock the
        // event outbox into retries forever).
        // Re-evaluate the immutable `eligibility.appliesTo` predicate (where declared) to decide which
        // interested stages to flip forward. A stage with only `eligibility.sql` (native) — or none — is
        // treated as eligible here (the fast path); the sweep dispose pass re-checks its SQL eligibility
        // against live data and re-disposes if still ineligible, so the event flip is harmless and
        // self-correcting. Stages whose `appliesTo` now returns false are simply LEFT AS-IS for the next
        // sweep's dispose pass — the event path NO LONGER writes an eligibility `skipped_permanent` (that
        // removal is what closes the dropped-event strand class: even a lost event cannot tombstone a row,
        // because the event path never tombstones).
        const eligibleStageIds: string[] = [];
        for (const stage of interested) {
            const appliesTo = stage.eligibility?.appliesTo;
            if (!appliesTo) {
                eligibleStageIds.push(stage.id);
                continue;
            }
            let ok: boolean;
            try {
                ok = appliesTo(snap);
            } catch (err) {
                log.warn('eligibility.appliesTo threw during invalidateByEvent; skipping stage', {
                    mediaItemId,
                    stageId: stage.id,
                    event,
                    error: err instanceof Error ? err.message : String(err),
                });
                continue;
            }
            if (ok) eligibleStageIds.push(stage.id);
        }

        const timestamp = new Date().toISOString();

        // WI-10 (C1): a content/identity change that lands while a stage is
        // mid-run can't flip the row (it's `running`), so the worker would
        // commit a `completed` built from now-stale input. Stamp
        // `invalidated_at` on running rows for every interested stage; the
        // terminal writer (upsertCompletedRow) demotes such a completion to
        // `obsolete` (sweepable), forcing a re-run against the fresh input.
        // Don't mark a stage that explicitly PRESERVES this event's completed
        // work (preserveCompletedOn) — marking it would demote a mid-run result
        // to obsolete and re-run it, contradicting the field's intent (e.g.
        // adding an alternate-version file should not invalidate a running
        // analysis).
        const markerStageIds = interested
            .filter((s) => !(s.preserveCompletedOn?.includes(event) ?? false))
            .map((s) => s.id);
        // An event describes when input CHANGED, not when dispatch happened.
        // A run started after that change already read the new input. Compare
        // in Postgres: JS Date truncates microseconds. Direct invalidations
        // without an outbox id retain their existing behavior.
        const newerThanRun =
            eventOutboxId === undefined
                ? sql``
                : sql`AND (started_at IS NULL OR started_at < (
                  SELECT created_at FROM event_outbox WHERE id = ${eventOutboxId}::bigint
              ))`;
        if (markerStageIds.length > 0) {
            await sql`
                UPDATE media_item_stage_state
                   SET invalidated_at = now(), updated_at = now()
                 WHERE media_item_id = ${mediaItemId}::uuid
                   AND stage_id = ANY(${markerStageIds})
                   AND status = 'running'
                   ${newerThanRun}
            `;
        }

        if (eligibleStageIds.length > 0) {
            // WI-9: `failed_permanent` resets for ANY event the stage declared
            // in `invalidatedBy` — new bytes (C2), a re-identify, or a metadata
            // change all invalidate the evidence that justified 'permanent'.
            // The blast radius is already bounded by `eligibleStageIds` (only
            // stages subscribed to THIS event flip), so no extra event-kind
            // gate is needed. This previously admitted only content events,
            // which made a dead-lettered stage immune to the operator's own
            // "Fix match" re-identify: the item completed series-sync/
            // metadata-update with the new id but bounced straight back into
            // the needs-re-identification list because its old
            // `failed_permanent` row could never re-run (prod, 2026-07-15;
            // the event-system design always documented the
            // unconditional reset). A stage may opt specific events out of
            // re-running already-`completed` work via `preserveCompletedOn`
            // (C4 — e.g. adding an alternate-version file shouldn't
            // mass-re-analyse the library).
            const resetStatuses = [
                'failed_transient',
                'skipped_transient',
                'skipped_permanent',
                'obsolete',
                'failed_permanent',
            ];
            const flipAllStatuses = [...resetStatuses, 'completed'];

            const flipAllIds: string[] = [];
            const preserveCompletedIds: string[] = [];
            for (const id of eligibleStageIds) {
                const decl = interested.find((s) => s.id === id);
                const preserves = decl?.preserveCompletedOn?.includes(event) ?? false;
                (preserves ? preserveCompletedIds : flipAllIds).push(id);
            }

            // Clear skipped_reason + invalidated_at on flip-back-to-pending so
            // the admin tooltip doesn't show a stale reason and a prior
            // running-row invalidation doesn't bleed into the new run.
            const affected: { stage_id: string; processing_version: number }[] = [];
            for (const group of [
                { ids: flipAllIds, statuses: flipAllStatuses },
                { ids: preserveCompletedIds, statuses: resetStatuses },
            ]) {
                if (group.ids.length === 0) continue;
                const rows = await sql<{ stage_id: string; processing_version: number }[]>`
                    UPDATE media_item_stage_state
                       SET status = 'pending',
                           attempt = 0,
                           declines = 0,
                           declines_since = NULL,
                           last_error = NULL,
                           skipped_reason = NULL,
                           next_eligible_at = NULL,
                           invalidated_at = NULL,
                           updated_at = now()
                     WHERE media_item_id = ${mediaItemId}::uuid
                       AND stage_id = ANY(${group.ids})
                       AND status = ANY(${group.statuses})
                       ${
                           eventOutboxId === undefined
                               ? sql``
                               : sql`AND (
                           status <> 'completed' OR started_at IS NULL OR started_at < (
                               SELECT created_at FROM event_outbox WHERE id = ${eventOutboxId}::bigint
                           )
                       )`
                       }
                 RETURNING stage_id, processing_version
                `;
                affected.push(...rows);
            }
            for (const row of affected) {
                // Per-effect try: a Valkey publish failure (inline mid-loop, or
                // post-commit when deferred) must not stop later effects. Without
                // this, the UPDATE has already committed but SSE consumers would
                // miss the tail of transitions, leaving the admin UI partial.
                await this.runOrDefer(effects, async () => {
                    try {
                        await publishStageStateChange({
                            kind: 'invalidate',
                            mediaItemId,
                            stageId: row.stage_id,
                            newStatus: 'pending',
                            processingVersion: row.processing_version,
                            timestamp,
                        });
                    } catch (err) {
                        log.warn(
                            'publishStageStateChange failed (eligible branch); SSE consumers may miss this transition',
                            {
                                mediaItemId,
                                stageId: row.stage_id,
                                error: err instanceof Error ? err.message : String(err),
                            },
                        );
                    }
                });
            }
            // Eager-enqueue only the flipped stages whose eligibility was fully
            // decided already (no `eligibility.sql`). A native eligibility.sql stage
            // flipped to pending by a PRE-probe event (e.g. file.attached before the
            // stream lands) is not yet eligible — eager-enqueuing it would fire a
            // no-op the sweep dispose would tombstone. Its flip-to-pending stands (the
            // recovery completes), but the actual enqueue defers to the next sweep,
            // which disposes-ineligible-then-enqueues in one tick (no herd).
            const eagerStageIds = affected
                .map((r) => r.stage_id)
                .filter((id) => {
                    const decl = interested.find((s) => s.id === id);
                    return decl ? isEagerEnqueueableAtSeed(decl) : true;
                });
            await this.runOrDefer(effects, () =>
                this.eagerEnqueueForStages(mediaItemId, eagerStageIds),
            );
        }

        // NOTE: the former `ineligibleStageIds` branch (which wrote
        // `skipped_permanent/'predicate-false-on-invalidation'` here) has been REMOVED. Ineligibility is
        // now EXCLUSIVELY the sweep dispose pass's job, evaluated against live SQL every tick. Two wins:
        // (1) the M5 pre-claim race — where a racing `markCompleted` could resurrect a wrongly-disposed
        //     row into a false `completed` with `invalidated_at = NULL` — is gone, because the event path
        //     no longer disposes at all.
        // (2) a dropped invalidation event can no longer strand a row, because the event path never
        //     tombstones; the event-independent heal rail recovers any genuinely-mis-skipped row.
        // Ineligible stages interested in this event are simply left as-is; the next sweep dispose pass
        // (which runs before the enqueue pass) demotes them to `skipped_permanent/'ineligible'` if still
        // ineligible, so they are never enqueued as no-ops.
    }

    async eagerEnqueueForStages(mediaItemId: string, stageIds: string[]): Promise<void> {
        let startRun = this.startRunFn;
        let getQueueDepths = this.getQueueDepthsFn;
        if (!startRun || !getQueueDepths) {
            try {
                const { orchestrator } = await import('$lib/server/tasks/orchestrator.js');
                startRun ??= orchestrator.startRun.bind(orchestrator) as StartRunFn;
                getQueueDepths ??= orchestrator.getQueueDepths.bind(
                    orchestrator,
                ) as GetQueueDepthsFn;
            } catch (err) {
                log.warn(
                    'Eager enqueue: could not load orchestrator; sweeper will retry',
                    { mediaItemId },
                    err as Error,
                );
            }
        }
        // A missing depth fn alone must NOT abort enqueue — we degrade to
        // no-throttle below. Only a missing startRun aborts: with no way to
        // enqueue, the sweep is the backstop.
        if (!startRun) return;
        // Snapshot queue depths once so every per-stage skip decision uses a
        // consistent view, and so the eager path backs off on the SAME
        // thresholds stage-sweep honors — without this, a burst of invalidations
        // (each eager-enqueueing ~15 stages) floods a class queue straight past
        // the sweep's voluntary throttle. Best-effort: a missing fn or a failed
        // snapshot (e.g. orchestrator not initialized in this process) means
        // "no depth info, don't throttle" — identical to stage-sweep's degradation.
        let overThresholdClasses = new Set<string>();
        if (getQueueDepths) {
            try {
                overThresholdClasses = classesOverDepthThreshold(await getQueueDepths());
            } catch (err) {
                log.debug('eager-enqueue: queue-depth snapshot unavailable; not throttling', {
                    mediaItemId,
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        }
        let skippedOverThreshold = 0;
        for (const stageId of stageIds) {
            const task = this.registry.findTaskByStage(stageId);
            if (!task) {
                // No task owns this stage — the coverage row will sit pending
                // forever until the stage id is reclaimed by a (re-)registered
                // task or removed. Log loudly so the orphan is visible in ops.
                log.warn('eager-enqueue: no task owns stage; coverage row may orphan', {
                    stageId,
                    mediaItemId,
                });
                continue;
            }
            const decl = task.coversStages?.find((s) => s.id === stageId);
            if (!decl?.enqueueable) continue;
            // Back off when the stage's resource class is over its queue-depth
            // threshold. The coverage row is already pending, so the next sweep
            // tick enqueues it once the class queue drains — nothing is lost.
            // `task.resourceClass` is the physical class post legacy-shim, the
            // same key stage-sweep compares against (see queue-depth-throttle).
            const taskClass = task.resourceClass ?? 'io';
            if (overThresholdClasses.has(taskClass)) {
                skippedOverThreshold++;
                continue;
            }
            // Detect global-identity tasks (identityFor returns a constant
            // regardless of input). For those, eager-enqueue must use the
            // SAME idempotency key shape stage-sweep uses
            // (`coverage:<stageId>:global`) so per-item ingest events from
            // afterCreated and tick-based sweeps dedupe against each other.
            // Without this, every fresh item INSERTS a pending task_history
            // row with a unique per-item key while BullMQ's jobId-based
            // dedup at the queue layer refuses the underlying job — leaving
            // hundreds of orphan pending rows that the reconciler then has
            // to keep mopping up.
            let isGlobalIdentity = false;
            try {
                const idA = task.identityFor({ mediaItemId });
                const idB = task.identityFor({
                    mediaItemId: GLOBAL_IDENTITY_SENTINEL_UUID,
                });
                isGlobalIdentity = idA === idB;
            } catch {
                // identityFor threw — treat as per-item; the task's
                // inputSchema will reject the call if our assumption is
                // wrong and surface a normal failure.
            }
            // NOTE: unlike stage-sweep's global path, this is deliberately NOT
            // subject to the non-progress backoff (global-enqueue-backoff.ts).
            // Every call here is driven by a real lifecycle event — an item that
            // just arrived — so the run has genuine new work to do even while an
            // unrelated part of the backlog is wedged. Throttling would delay
            // that item by up to the task's `schedule.every` (12h for
            // mdblist-sync) to save a run that was going to process it anyway,
            // and computing the progress signal would cost a COUNT per ingested
            // item. During the 2026-07 mdblist incident this path accounted for
            // 104 of ~1,050 daily runs; the 60s sweep was the other ~90% and is
            // where the ceiling belongs.
            const idempotencyKey = isGlobalIdentity
                ? `coverage:${stageId}:global`
                : `coverage:${stageId}:${mediaItemId}`;
            const input = isGlobalIdentity ? {} : { mediaItemId };
            try {
                await startRun(task.id, input, {
                    trigger: {
                        kind: 'in-process',
                        sourceRoute: 'media-lifecycle.eager-enqueue',
                    },
                    idempotencyKey,
                });
            } catch (err) {
                log.warn(
                    'Eager enqueue failed; sweeper will retry',
                    { mediaItemId, stageId },
                    err as Error,
                );
            }
        }
        if (skippedOverThreshold > 0) {
            log.debug('eager-enqueue: skipped over-threshold stages; sweep will enqueue them', {
                mediaItemId,
                skippedOverThreshold,
            });
        }
    }
}
