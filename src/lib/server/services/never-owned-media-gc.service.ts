// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { setTimeout as pause } from 'node:timers/promises';
import { withTx } from '$lib/server/database/with-tx.js';
import { Logger } from '$lib/server/utils/logger.js';
import { deriveRetentionUnit } from '$lib/server/database/queries/media-retention.queries.js';
import {
    emptyNeverOwnedEvaluation,
    evaluateNeverOwnedUnits,
    mergeNeverOwnedEvaluation,
    NEVER_OWNED_GC_ROOT_BATCH,
    NEVER_OWNED_GC_UNIT_MAX_ROWS,
    NEVER_OWNED_NO_FK_LOCK_TABLES,
    type KeepCategory,
    type NeverOwnedGcEvaluation,
    type NeverOwnedGcKind,
    type NeverOwnedUnitCandidate,
} from '$lib/server/database/queries/never-owned-media-gc.queries.js';
import { NO_FK_REFERENCE_TABLES_LOCK, skippableReason } from './media-retention.service.js';
import { afterHardDelete, deleteMediaDependentsTx } from './media-deletion.service.js';

const logger = Logger.for('NeverOwnedMediaGc');

/** Budgets are cooperative: an in-flight transaction may finish after the deadline. */
export const NEVER_OWNED_GC_DEFAULT_TIME_BUDGET_MS = 15 * 60_000;
export const NEVER_OWNED_GC_MAX_TIME_BUDGET_MS = 60 * 60_000;
const BATCH_PAUSE_MS = 250;
export const NEVER_OWNED_GC_SAMPLE_IDS = 20;
/** Schema minimum of NEVER_OWNED_MEDIA_GC_MIN_AGE_DAYS; the getter clamps to it as well. */
export const NEVER_OWNED_GC_MIN_AGE_FLOOR_DAYS = 7;

export interface NeverOwnedGcRowCounts {
    movieUnits: number;
    seriesUnits: number;
    seasons: number;
    episodes: number;
    extras: number;
    /** Every media_items row, roots included. */
    totalRows: number;
}

export interface NeverOwnedGcResult {
    /** One readable line for the run list and log. */
    summary: string;
    dryRun: boolean;
    /** NEVER_OWNED_MEDIA_GC_ENABLED at run time. */
    enabled: boolean;
    /** A deleting run was requested but the setting is off, so it only previewed. */
    forcedDryRun: boolean;
    minAgeDays: number;
    batchLimit: number;
    timeBudgetMs: number;
    batches: number;
    stoppedOnBudget: boolean;
    /** Never-owned movies/series old enough to evaluate. */
    neverOwnedRoots: Record<NeverOwnedGcKind, number>;
    /** Never-owned movies/series younger than `minAgeDays` (kept, not evaluated). */
    tooYoung: Record<NeverOwnedGcKind, number>;
    /** Eligible units in the initial catalog evaluation (not summed again on re-evaluation). */
    eligible: NeverOwnedGcRowCounts;
    kept: {
        movie: number;
        series: number;
        /** Units per rule key (`user_ratings.media_id`, `dismissed`, ...); a unit counts under each rule that holds it. */
        byRule: Record<string, number>;
        byCategory: Partial<Record<KeepCategory, number>>;
        /** Units whose title the TMDB discovery sweep still refreshes (it would re-create them). */
        recentlySeenByDiscovery: number;
    };
    /** Units selected across all batches; `batchLimit` applies to each batch. */
    selected: number;
    deleted: NeverOwnedGcRowCounts;
    skipped: number;
    skipReasons: Record<string, number>;
    hasMore: boolean;
    /** Eligible roots (preview) or deleted roots (deleting run), at most 20. */
    sampleIds: string[];
    /** False when a catalog evaluation stopped on its statement timeout or run budget. */
    evaluationComplete: boolean;
}

function emptyRows(): NeverOwnedGcRowCounts {
    return { movieUnits: 0, seriesUnits: 0, seasons: 0, episodes: 0, extras: 0, totalRows: 0 };
}

function addUnit(rows: NeverOwnedGcRowCounts, unit: NeverOwnedUnitCandidate): void {
    if (unit.kind === 'movie') rows.movieUnits++;
    else rows.seriesUnits++;
    rows.seasons += unit.seasons;
    rows.episodes += unit.episodes;
    rows.extras += unit.extras;
    rows.totalRows += unit.members;
}

const fmt = (n: number): string => n.toLocaleString('en-US');

function describeRows(rows: NeverOwnedGcRowCounts): string {
    return (
        `${fmt(rows.movieUnits)} movies and ${fmt(rows.seriesUnits)} series ` +
        `(${fmt(rows.seasons)} seasons, ${fmt(rows.episodes)} episodes, ${fmt(rows.extras)} extras; ` +
        `${fmt(rows.totalRows)} rows)`
    );
}

export function summarizeNeverOwnedGc(result: Omit<NeverOwnedGcResult, 'summary'>): string {
    const keptUnits = result.kept.movie + result.kept.series;
    const categories = Object.entries(result.kept.byCategory)
        .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
        .map(([category, n]) => `${category} ${fmt(n ?? 0)}`)
        .join(', ');
    const kept = `kept ${fmt(keptUnits)} referenced or protected units${categories ? ` (${categories})` : ''}`;
    const young = `${fmt(result.tooYoung.movie + result.tooYoung.series)} younger than ${result.minAgeDays} days`;
    const discovery = `${fmt(result.kept.recentlySeenByDiscovery)} still listed by discovery`;
    const mode = result.forcedDryRun
        ? 'Preview only (cleanup is off in Settings)'
        : result.dryRun
          ? 'Preview'
          : 'Cleanup';
    const head = result.dryRun
        ? `${mode}: would delete ${describeRows(result.eligible)}`
        : `${mode}: deleted ${describeRows(result.deleted)} of ${fmt(
              result.eligible.movieUnits + result.eligible.seriesUnits,
          )} eligible units`;
    const partial = result.evaluationComplete
        ? ''
        : '; evaluation stopped early, counts may cover only part of the catalog';
    const tail = `${partial}${result.skipped > 0 ? `; ${fmt(result.skipped)} skipped` : ''}`;
    const more = result.hasMore ? '; more remain for the next run' : '';
    const batches = result.dryRun
        ? ''
        : `; ${fmt(result.batches)} batches; ${result.stoppedOnBudget ? 'stopped on time budget' : 'time budget not reached'}`;
    return `${head}; ${kept}; ${discovery}; ${young}${tail}${batches}${more}.`;
}

export type NeverOwnedDeleteOutcome =
    | { deleted: true; deletedIds: string[]; unit: NeverOwnedUnitCandidate }
    | { deleted: false; skipReason: string };

/** Raised inside the unit transaction to roll back a partial delete; reported as a skip. */
class UnitChangedError extends Error {
    constructor(rootId: string, deleted: number, expected: number) {
        super(`never-owned unit ${rootId}: deleted ${deleted} of ${expected} rows`);
        this.name = 'UnitChangedError';
    }
}

/**
 * Delete one never-owned unit in its own transaction. Lock order: no-FK
 * reference tables (SHARE, NOWAIT: the retention set plus every protect-class
 * table of NO_FK_MEDIA_REFERENCES), per-member advisory locks in sorted id
 * order (the key attachFileToItem takes), member row locks, then the unit's
 * library_availability / series_episode_ordering / image_candidates rows. The
 * member row locks block every FK insert (a new rating, playlist entry, file
 * link takes KEY SHARE on the row); the referencing-row locks block the
 * non-key updates that turn such a row protective (available = true, a manual
 * ordering, an admin image); the SHARE table locks block the no-FK writers.
 * With all of them held the full eligibility is evaluated again for this root,
 * so a reference added after the run's selection keeps the unit. Children go
 * first, deepest level first, so no parent_id is ever nulled. A lock wait,
 * deadlock or statement timeout skips the unit (reason in `skipReason`).
 *
 * The transaction sets `lumastra.sync_never_owned_gc`, so the library sync
 * triggers (16.403.0) record no tombstones for rows that never were in the set.
 */
export async function deleteNeverOwnedUnit(
    sql: postgres.Sql,
    target: Pick<NeverOwnedUnitCandidate, 'id' | 'kind'>,
    opts: { minAgeDays: number; signal?: AbortSignal },
): Promise<NeverOwnedDeleteOutcome> {
    const skip = (skipReason: string): NeverOwnedDeleteOutcome => ({ deleted: false, skipReason });
    let outcome: NeverOwnedDeleteOutcome;
    try {
        outcome = await withTx(sql, async (tx): Promise<NeverOwnedDeleteOutcome> => {
            opts.signal?.throwIfAborted();
            await tx`SET LOCAL lock_timeout = '2s'`;
            await tx`SET LOCAL statement_timeout = '30s'`;
            await tx`SET LOCAL lumastra.sync_never_owned_gc = 'on'`;
            await NO_FK_REFERENCE_TABLES_LOCK(tx);
            await tx`LOCK TABLE ${tx(NEVER_OWNED_NO_FK_LOCK_TABLES as string[])} IN SHARE MODE NOWAIT`;
            const members = await deriveRetentionUnit(tx, target.id);
            if (members.length === 0) return skip('unit-gone');
            if (members.length > NEVER_OWNED_GC_UNIT_MAX_ROWS) return skip('unit-too-large');
            if (members.some((m) => m.truncated)) return skip('unit-too-deep');
            const sorted = members.map((m) => m.id).sort();
            await tx`SELECT pg_advisory_xact_lock(hashtext(k)) FROM unnest(${sorted}::text[]) AS t(k)`;
            // Admin-only GC; eligibility is re-derived below under the locks.
            // eslint-disable-next-line callback-safety/no-unscoped-media-items
            await tx`SELECT id FROM media_items WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`;
            await tx`SELECT 1 FROM library_availability WHERE media_id = ANY(${sorted}::uuid[]) FOR UPDATE`;
            await tx`SELECT 1 FROM series_episode_ordering WHERE media_id = ANY(${sorted}::uuid[]) FOR UPDATE`;
            await tx`SELECT 1 FROM image_candidates WHERE media_item_id = ANY(${sorted}::uuid[]) FOR UPDATE`;
            opts.signal?.throwIfAborted();
            const current = await deriveRetentionUnit(tx, target.id);
            const currentIds = current.map((m) => m.id).sort();
            if (currentIds.length !== sorted.length || currentIds.some((id, i) => id !== sorted[i]))
                return skip('membership-changed');
            const recheck = await evaluateNeverOwnedUnits(tx, {
                limit: 1,
                minAgeDays: opts.minAgeDays,
                rootId: target.id,
                signal: opts.signal,
            });
            const unit = recheck.candidates[0];
            if (!unit || unit.id !== target.id || unit.members !== current.length)
                return skip('eligibility-changed');
            opts.signal?.throwIfAborted();

            await deleteMediaDependentsTx(tx, sorted);
            const depths = [...new Set(current.map((m) => m.depth))].sort((a, b) => b - a);
            const deletedIds: string[] = [];
            for (const depth of depths) {
                const level = current.filter((m) => m.depth === depth).map((m) => m.id);
                // eslint-disable-next-line callback-safety/no-unscoped-media-items
                const rows = await tx<{ id: string }[]>`
                    DELETE FROM media_items WHERE id = ANY(${level}::uuid[]) RETURNING id::text AS id
                `;
                deletedIds.push(...rows.map((r) => r.id));
            }
            // Locked rows cannot vanish; a mismatch means the unit changed under us.
            if (deletedIds.length !== current.length)
                throw new UnitChangedError(target.id, deletedIds.length, current.length);
            opts.signal?.throwIfAborted();
            return { deleted: true, deletedIds, unit };
        });
    } catch (error) {
        if (error instanceof UnitChangedError) {
            logger.warn('Never-owned unit changed during delete; rolled back', error);
            return skip('unit-changed');
        }
        // An active writer, a deadlock or a slow statement wins; retried next run.
        const reason = opts.signal?.aborted ? null : skippableReason(error);
        if (!reason) throw error;
        return skip(reason);
    }
    if (outcome.deleted) await afterHardDelete(sql, [], outcome.deletedIds, target.id);
    return outcome;
}

function isStatementTimeout(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === '57014';
}

/**
 * Evaluate the whole catalog in keyset batches of `batchSize` roots, each its
 * own read transaction with its own statement timeout, and add the batches up.
 * A batch that times out ends the evaluation with what was counted so far
 * (`complete: false`) instead of failing the run.
 */
export async function evaluateNeverOwnedCatalog(
    sql: postgres.Sql,
    opts: {
        limit: number;
        minAgeDays: number;
        batchSize?: number;
        statementTimeoutMs?: number;
        signal?: AbortSignal;
        deadline?: number;
        now?: () => number;
    },
): Promise<{ evaluation: NeverOwnedGcEvaluation; complete: boolean; stoppedOnBudget: boolean }> {
    const total = emptyNeverOwnedEvaluation();
    let after: string | null = null;
    do {
        opts.signal?.throwIfAborted();
        if (opts.deadline !== undefined && (opts.now ?? Date.now)() >= opts.deadline)
            return { evaluation: total, complete: false, stoppedOnBudget: true };
        let batch: NeverOwnedGcEvaluation;
        try {
            batch = await withTx(sql, async (tx) => {
                await tx`SET LOCAL lock_timeout = '2s'`;
                await tx`SELECT set_config('statement_timeout', ${String(opts.statementTimeoutMs ?? 60_000)}, true)`;
                return evaluateNeverOwnedUnits(tx, {
                    limit: Math.max(0, opts.limit - total.candidates.length),
                    minAgeDays: opts.minAgeDays,
                    afterRootId: after,
                    batchSize: opts.batchSize ?? NEVER_OWNED_GC_ROOT_BATCH,
                    signal: opts.signal,
                });
            });
        } catch (error) {
            if (opts.signal?.aborted || !isStatementTimeout(error)) throw error;
            logger.warn('Never-owned evaluation batch hit its statement timeout', { after });
            return { evaluation: total, complete: false, stoppedOnBudget: false };
        }
        mergeNeverOwnedEvaluation(total, batch, opts.limit);
        after = batch.nextAfterRootId;
    } while (after);
    return { evaluation: total, complete: true, stoppedOnBudget: false };
}

export interface NeverOwnedGcInput {
    dryRun: boolean;
    batchLimit: number;
    timeBudgetMs?: number;
}

export interface NeverOwnedGcSettings {
    /** NEVER_OWNED_MEDIA_GC_ENABLED; false turns every run into a preview. */
    enabled: boolean;
    minAgeDays: number;
}

/**
 * Drain successive batches, re-evaluating the catalog between them. Every
 * delete retains its own guarded transaction. Skipped roots are attempted only
 * once per run so they cannot starve later candidates. A preview evaluates once.
 */
export async function runNeverOwnedMediaGc(
    sql: postgres.Sql,
    input: NeverOwnedGcInput,
    settings: NeverOwnedGcSettings,
    signal: AbortSignal,
    opts: {
        now?: () => number;
        evaluationBatchSize?: number;
        evaluationStatementTimeoutMs?: number;
    } = {},
): Promise<NeverOwnedGcResult> {
    signal.throwIfAborted();
    const now = opts.now ?? Date.now;
    const timeBudgetMs = Math.min(
        input.timeBudgetMs ?? NEVER_OWNED_GC_DEFAULT_TIME_BUDGET_MS,
        NEVER_OWNED_GC_MAX_TIME_BUDGET_MS,
    );
    const deadline = now() + timeBudgetMs;
    const minAgeDays = Math.max(NEVER_OWNED_GC_MIN_AGE_FLOOR_DAYS, Math.floor(settings.minAgeDays));
    const dryRun = input.dryRun || !settings.enabled;

    const skippedIds = new Set<string>();
    const evaluate = (): ReturnType<typeof evaluateNeverOwnedCatalog> =>
        evaluateNeverOwnedCatalog(sql, {
            limit: input.batchLimit + 1 + skippedIds.size,
            minAgeDays,
            batchSize: opts.evaluationBatchSize,
            statementTimeoutMs: opts.evaluationStatementTimeoutMs,
            signal,
            deadline: dryRun ? undefined : deadline,
            now,
        });
    let { evaluation, complete, stoppedOnBudget } = await evaluate();
    signal.throwIfAborted();

    const { summary } = evaluation;
    const eligible = emptyRows();
    eligible.movieUnits = summary.movie.eligible;
    eligible.seriesUnits = summary.series.eligible;
    for (const kind of ['movie', 'series'] as const) {
        eligible.seasons += summary[kind].eligibleSeasons;
        eligible.episodes += summary[kind].eligibleEpisodes;
        eligible.extras += summary[kind].eligibleExtras;
        eligible.totalRows += summary[kind].eligibleRows;
    }
    let selected = evaluation.candidates.slice(0, input.batchLimit);
    const base: Omit<NeverOwnedGcResult, 'summary'> = {
        dryRun,
        enabled: settings.enabled,
        forcedDryRun: !input.dryRun && !settings.enabled,
        minAgeDays,
        batchLimit: input.batchLimit,
        timeBudgetMs,
        batches: 0,
        stoppedOnBudget,
        neverOwnedRoots: { movie: summary.movie.roots, series: summary.series.roots },
        tooYoung: { movie: summary.movie.tooYoung, series: summary.series.tooYoung },
        eligible,
        kept: {
            movie: summary.movie.kept,
            series: summary.series.kept,
            byRule: evaluation.keptByRule,
            byCategory: evaluation.keptByCategory,
            recentlySeenByDiscovery: evaluation.keptByRule['recently-seen-by-discovery'] ?? 0,
        },
        selected: dryRun ? selected.length : 0,
        deleted: emptyRows(),
        skipped: 0,
        skipReasons: {},
        hasMore: evaluation.candidates.length > input.batchLimit || !complete,
        sampleIds: [],
        evaluationComplete: complete,
    };
    if (!complete && !stoppedOnBudget) base.skipReasons['evaluation-statement-timeout'] = 1;
    const skip = (reason: string): void => {
        base.skipped++;
        base.skipReasons[reason] = (base.skipReasons[reason] ?? 0) + 1;
    };

    if (dryRun) {
        base.sampleIds = selected.slice(0, NEVER_OWNED_GC_SAMPLE_IDS).map((c) => c.id);
    } else {
        while (selected.length > 0) {
            signal.throwIfAborted();
            if (base.stoppedOnBudget || now() >= deadline) {
                base.stoppedOnBudget = true;
                base.hasMore = true;
                break;
            }
            base.batches++;
            base.selected += selected.length;
            for (const item of selected) {
                signal.throwIfAborted();
                if (now() >= deadline) {
                    // Leave the rest to the next run rather than overrun the task timeout.
                    base.hasMore = true;
                    base.stoppedOnBudget = true;
                    break;
                }
                try {
                    const outcome = await deleteNeverOwnedUnit(sql, item, { minAgeDays, signal });
                    if (outcome.deleted) {
                        addUnit(base.deleted, outcome.unit);
                        if (base.sampleIds.length < NEVER_OWNED_GC_SAMPLE_IDS)
                            base.sampleIds.push(item.id);
                    } else {
                        skippedIds.add(item.id);
                        skip(outcome.skipReason);
                    }
                } catch (error) {
                    // An active writer or slow statement wins; the unit is retried next run.
                    if (signal.aborted) throw error;
                    const reason = skippableReason(error);
                    if (!reason) throw error;
                    skippedIds.add(item.id);
                    skip(reason);
                }
            }
            signal.throwIfAborted();
            if (base.stoppedOnBudget || !complete) break;
            if (now() >= deadline) {
                base.stoppedOnBudget = true;
                base.hasMore = true;
                break;
            }
            await pause(Math.min(BATCH_PAUSE_MS, deadline - now()), undefined, { signal });
            signal.throwIfAborted();
            ({ evaluation, complete, stoppedOnBudget } = await evaluate());
            base.stoppedOnBudget = stoppedOnBudget;
            base.evaluationComplete &&= complete;
            if (!complete && !stoppedOnBudget)
                base.skipReasons['evaluation-statement-timeout'] =
                    (base.skipReasons['evaluation-statement-timeout'] ?? 0) + 1;
            selected = evaluation.candidates
                .filter((c) => !skippedIds.has(c.id))
                .slice(0, input.batchLimit);
            base.hasMore = skippedIds.size > 0 || selected.length > 0 || !complete;
        }
    }
    return { summary: summarizeNeverOwnedGc(base), ...base };
}
