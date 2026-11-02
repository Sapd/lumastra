// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { constants } from 'node:fs';
import { isAbsolute } from 'node:path';
import { safeAccess, safeReaddir, safeStat } from '$lib/server/utils/safe-fs.js';
import { FILESYSTEM_LIBRARY_PROVIDERS } from '$lib/server/database/queries/library-paths.queries.js';
import {
    deriveRetentionUnit,
    evaluateRetentionUnits,
    findRetentionRootGroups,
    getAudiobookshelfSyncEvidence,
    getLibraryGroupScanEvidence,
    initializeRetentionClock,
    MEDIA_RETENTION_DAYS,
    RETENTION_KINDS,
    RETENTION_PATH_MEDIA_TYPES,
    RETENTION_SCAN_MAX_AGE_DAYS,
    RETENTION_UNIT_MAX_ROWS,
    type AudiobookshelfSyncEvidence,
    type LibraryPathScanEvidence,
    type RetentionGroupKeys,
    type RetentionKind,
    type RetentionUnitCandidate,
    type RetentionUnitMember,
} from '$lib/server/database/queries/media-retention.queries.js';
import { lockLibraryScanFence } from '$lib/server/database/queries/file-scanner-runs.queries.js';
import { withTx } from '$lib/server/database/with-tx.js';

/**
 * Budget for the filesystem probes of ONE group, so a slow mount fails only
 * its own group instead of starving every group validated after it.
 */
const GROUP_PROBE_BUDGET_MS = 5_000;
/** A run stops taking new units after this long and reports `hasMore`. */
export const RETENTION_RUN_SOFT_DEADLINE_MS = 10 * 60_000;
const PROBE_TIMEOUT_MS = 2_000;

interface RunTiming {
    state: string | null;
    started_at: Date | null;
    completed_at: Date | null;
    configured_at: Date;
}

/** Shared freshness checks: a completed run, at most 7 days old, started after the config change. */
function runTimingFailure(run: RunTiming, now: Date): string | null {
    if (run.state !== 'completed' || !run.completed_at || !run.started_at)
        return 'incomplete-or-missing-scan';
    const completedAt = new Date(run.completed_at).getTime();
    const age = now.getTime() - completedAt;
    const startedAt = new Date(run.started_at).getTime();
    const configuredAt = new Date(run.configured_at).getTime();
    if (
        !Number.isFinite(age) ||
        !Number.isFinite(startedAt) ||
        !Number.isFinite(configuredAt) ||
        age < 0 ||
        age > RETENTION_SCAN_MAX_AGE_DAYS * 86400000 ||
        startedAt > completedAt
    )
        return 'stale-or-invalid-scan';
    if (startedAt < configuredAt) return 'scan-predates-root-configuration';
    return null;
}

function isCount(n: unknown): n is number {
    return typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;
}

/**
 * Why a filesystem path's latest per-path scan cannot prove absence, or null
 * when it can: enabled filesystem root, fresh successful run with nonzero
 * outcomes and no scan errors.
 */
export function scanEvidenceFailure(
    root: Pick<
        LibraryPathScanEvidence,
        | 'enabled'
        | 'provider'
        | 'path'
        | 'state'
        | 'started_at'
        | 'completed_at'
        | 'configured_at'
        | 'result'
    >,
    now = new Date(),
): string | null {
    if (!root.enabled) return 'disabled-root';
    if (
        !(FILESYSTEM_LIBRARY_PROVIDERS as readonly string[]).includes(root.provider) ||
        !isAbsolute(root.path)
    )
        return 'unsupported-root';
    const timing = runTimingFailure(root, now);
    if (timing) return timing;
    if (!root.result || typeof root.result !== 'object' || Array.isArray(root.result))
        return 'unknown-scan-result';
    const result = root.result as Record<string, unknown>;
    const outcomes = ['added', 'updated', 'skipped', 'unmatched'].map((k) => result[k]);
    if (!isCount(result.scanErrors)) return 'scan-errors-or-unknown';
    if (!outcomes.every(isCount)) return 'empty-or-unknown-scan';
    const total = outcomes.reduce((a, b) => a + b, 0);
    if (total === 0) return 'empty-or-unknown-scan';
    if (result.scanErrors !== 0) return 'scan-errors-or-unknown';
    return null;
}

const ABS_SYNC_COUNTS = ['added', 'updated', 'dismissed', 'unmatched', 'skipped'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Why one path's slice of a sync's `libraries` map cannot prove absence, or
 * null: the library was listed completely, recorded no errors (a tripped
 * dismissal cap counts as one) and counted at least one book.
 */
function audiobookshelfLibraryFailure(entry: unknown): string | null {
    if (!isRecord(entry)) return 'abs-library-not-in-sync';
    if (entry.listed !== true) return 'abs-library-not-listed';
    if (!isCount(entry.errors) || entry.errors > 0) return 'sync-errors-or-unknown';
    const counts = ABS_SYNC_COUNTS.map((k) => entry[k]);
    if (!counts.every(isCount) || counts.reduce((a, b) => a + b, 0) === 0)
        return 'empty-or-unknown-sync';
    return null;
}

/**
 * Why an Audiobookshelf path cannot prove a book's absence, or null: enabled
 * ABS audiobook path whose latest sync succeeded, is at most 7 days old and
 * started after the path's change, and whose own library slice is clean
 * (listed, no errors, at least one book). A run recorded before syncs carried
 * a per-library `libraries` map is judged run-wide instead: no errors at all
 * and at least one book overall. A path missing from a run that has the map
 * fails closed.
 */
export function audiobookshelfEvidenceFailure(
    row: AudiobookshelfSyncEvidence,
    now = new Date(),
): string | null {
    if (!row.enabled) return 'disabled-root';
    if (row.provider !== 'audiobookshelf' || row.media_type !== 'audiobook') return 'kind-mismatch';
    const timing = runTimingFailure(row, now);
    if (timing) return timing.replace('scan', 'sync');
    if (!isRecord(row.result)) return 'unknown-sync-result';
    const result = row.result;
    if (result.libraries !== undefined) {
        const libraries = isRecord(result.libraries) ? result.libraries : {};
        return audiobookshelfLibraryFailure(
            Object.hasOwn(libraries, row.id) ? libraries[row.id] : undefined,
        );
    }
    if (!Array.isArray(result.errors) || result.errors.length > 0) return 'sync-errors-or-unknown';
    const counts = ABS_SYNC_COUNTS.map((k) => result[k]);
    if (!counts.every(isCount) || counts.reduce((a, b) => a + b, 0) === 0)
        return 'empty-or-unknown-sync';
    return null;
}

export interface RetentionGroupRef {
    kind: RetentionKind;
    groupKey: string;
}

export interface RetentionHealth {
    healthy: RetentionGroupKeys;
    /** One entry per unhealthy group, `<kind> group <key>: <reason>[, …]`. */
    reasons: string[];
    unhealthy: RetentionGroupRef[];
}

/** Probe outcome per path: readable directory with at least one visible entry. */
async function probeRoot(path: string, budget: () => number): Promise<string | null> {
    try {
        await safeAccess(path, constants.R_OK | constants.X_OK, budget());
        const stat = await safeStat(path, budget());
        const entries = await safeReaddir(path, budget());
        if (
            !stat.isDirectory() ||
            !entries.some((e) => !e.name.startsWith('.') && (e.isFile() || e.isDirectory()))
        )
            return 'empty-or-unusable-root';
        return null;
    } catch (error) {
        if (error instanceof Error && error.message === 'validation-budget-exhausted')
            return 'validation-budget-exhausted';
        return 'inaccessible-root';
    }
}

/**
 * Per-group health. A group proves absence only when every one of its paths
 * is an enabled filesystem root of the unit's kind, currently readable and
 * nonempty, with fresh successful scan evidence; an audiobook path only with a
 * fresh clean ABS sync. Failures are isolated to their own group.
 */
export async function validateRetentionGroups(
    sql: postgres.Sql,
    groups: RetentionGroupRef[],
    signal?: AbortSignal,
): Promise<RetentionHealth> {
    signal?.throwIfAborted();
    const health: RetentionHealth = { healthy: {}, reasons: [], unhealthy: [] };
    const fsKeys = [
        ...new Set(groups.filter((g) => g.kind !== 'audiobook').map((g) => g.groupKey)),
    ];
    const absKeys = [
        ...new Set(groups.filter((g) => g.kind === 'audiobook').map((g) => g.groupKey)),
    ];
    const fsEvidence = await getLibraryGroupScanEvidence(sql, fsKeys);
    const absEvidence = await getAudiobookshelfSyncEvidence(sql, absKeys);
    const now = new Date();
    const probes = new Map<string, string | null>();
    for (const group of groups) {
        signal?.throwIfAborted();
        const deadline = Date.now() + GROUP_PROBE_BUDGET_MS;
        const budget = (): number => {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error('validation-budget-exhausted');
            return Math.min(PROBE_TIMEOUT_MS, remaining);
        };
        const failures: string[] = [];
        if (group.kind === 'audiobook') {
            const row = absEvidence.find((r) => r.id === group.groupKey);
            const failure = row ? audiobookshelfEvidenceFailure(row, now) : 'missing-library-path';
            if (failure) failures.push(failure);
        } else {
            const paths = fsEvidence.filter((r) => r.group_key === group.groupKey);
            if (paths.length === 0) failures.push('no-library-paths');
            for (const path of paths) {
                let failure = scanEvidenceFailure(path, now);
                if (!failure && !RETENTION_PATH_MEDIA_TYPES[group.kind].includes(path.media_type))
                    failure = 'kind-mismatch';
                if (!failure) {
                    if (!probes.has(path.id))
                        probes.set(path.id, await probeRoot(path.path, budget));
                    failure = probes.get(path.id) ?? null;
                }
                if (failure) failures.push(`path ${path.id} ${failure}`);
            }
        }
        if (failures.length > 0) {
            health.unhealthy.push(group);
            health.reasons.push(`${group.kind} group ${group.groupKey}: ${failures.join(', ')}`);
        } else {
            (health.healthy[group.kind] ??= []).push(group.groupKey);
        }
    }
    signal?.throwIfAborted();
    return health;
}

/** Reasons the unit's group cannot prove absence right now; empty when healthy. */
export async function validateRetentionGroup(
    sql: postgres.Sql,
    target: Pick<RetentionUnitCandidate, 'kind' | 'group_key'>,
    signal?: AbortSignal,
): Promise<string[]> {
    const health = await validateRetentionGroups(
        sql,
        [{ kind: target.kind, groupKey: target.group_key }],
        signal,
    );
    return health.reasons;
}

/**
 * Tables whose writers have no FK to media_items; a SHARE lock serializes them
 * with a delete, so a reference cannot appear between the recheck and commit.
 * NOWAIT: an active writer wins and the caller skips (55P03).
 */
export const NO_FK_REFERENCE_TABLES_LOCK = (
    tx: postgres.Sql,
): postgres.PendingQuery<postgres.Row[]> =>
    tx`LOCK TABLE user_media_events_archive, interactions, interaction_reactions, user_media_flags,
        watch_sync_activity, watch_state_pending_resolution, series_episode_ordering,
        assistant_messages, client_diagnostics, active_transcode_jobs, hls_playback_tokens,
        episode_reconciliation_moves
        IN SHARE MODE NOWAIT`;

export type LockedRetentionUnit = { members: RetentionUnitMember[] } | { skipReason: string };

/**
 * Per-run memo of groups that failed health validation, keyed by
 * {@link healthMemoKey}, holding the recorded skip reason. A failed group is
 * not probed again in the same run; healthy groups are still re-validated in
 * every unit transaction.
 */
export type RetentionHealthMemo = Map<string, string>;

export function healthMemoKey(target: Pick<RetentionUnitCandidate, 'kind' | 'group_key'>): string {
    return `${target.kind}:${target.group_key}`;
}

/**
 * Take every lock a retention write needs, in a fixed order, inside the
 * caller's transaction: library config (re-validating group health), no-FK
 * reference tables, per-member advisory locks in sorted id order, then member
 * row locks. Membership is derived again after locking; any change skips.
 * NOWAIT / lock_timeout errors propagate so the caller skips just this unit.
 */
export async function lockRetentionUnit(
    tx: postgres.Sql,
    target: RetentionUnitCandidate,
    signal?: AbortSignal,
    healthMemo?: RetentionHealthMemo,
): Promise<LockedRetentionUnit> {
    const known = healthMemo?.get(healthMemoKey(target));
    if (known) return { skipReason: known };
    await tx`LOCK TABLE library_paths IN SHARE MODE NOWAIT`;
    if (target.kind !== 'audiobook') await lockLibraryScanFence(tx, target.group_key);
    const reasons = await validateRetentionGroup(tx, target, signal);
    if (reasons.length > 0) {
        const skipReason = `library-health-changed: ${reasons.join('; ')}`;
        healthMemo?.set(healthMemoKey(target), skipReason);
        return { skipReason };
    }
    // Reference write locks are held only AFTER the bounded filesystem probes.
    await NO_FK_REFERENCE_TABLES_LOCK(tx);
    const members = await deriveRetentionUnit(tx, target.id);
    if (members.length === 0) return { skipReason: 'unit-gone' };
    if (members.length > RETENTION_UNIT_MAX_ROWS) return { skipReason: 'unit-too-large' };
    if (members.some((m) => m.truncated)) return { skipReason: 'unit-too-deep' };
    const sorted = members.map((m) => m.id).sort();
    // Same key attachFileToItem takes, advisory before row lock, members in sorted order.
    await tx`SELECT pg_advisory_xact_lock(hashtext(k)) FROM unnest(${sorted}::text[]) AS t(k)`;
    // Admin-only retention operation; eligibility is re-derived below.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await tx`SELECT id FROM media_items WHERE id = ANY(${sorted}::uuid[]) ORDER BY id FOR UPDATE`;
    signal?.throwIfAborted();
    const current = await deriveRetentionUnit(tx, target.id);
    const currentIds = current.map((m) => m.id).sort();
    if (currentIds.length !== sorted.length || currentIds.some((id, i) => id !== sorted[i]))
        return { skipReason: 'membership-changed' };
    return { members: current };
}

async function initializeUnitClock(
    sql: postgres.Sql,
    target: RetentionUnitCandidate,
    signal: AbortSignal,
    healthMemo: RetentionHealthMemo,
): Promise<{ initialized: boolean; reason?: string }> {
    return withTx(sql, async (tx) => {
        await tx`SET LOCAL lock_timeout = '2s'`;
        await tx`SET LOCAL statement_timeout = '30s'`;
        const locked = await lockRetentionUnit(tx, target, signal, healthMemo);
        if ('skipReason' in locked) return { initialized: false, reason: locked.skipReason };
        const recheck = await evaluateRetentionUnits(tx, { [target.kind]: [target.group_key] }, 1, {
            rootId: target.id,
            mode: 'unknown',
            signal,
        });
        if (recheck.candidates.length !== 1)
            return { initialized: false, reason: 'eligibility-changed' };
        signal.throwIfAborted();
        const initialized = await initializeRetentionClock(tx, target.id);
        signal.throwIfAborted();
        return initialized
            ? { initialized: true }
            : { initialized: false, reason: 'eligibility-changed' };
    });
}

export interface RetentionKindCounts {
    /** Roots past (or of unknown) loss age, before health and unit evaluation. */
    roots: number;
    /** Roots without library provenance (never eligible). */
    missingProvenance: number;
    /** Roots in groups that failed health validation this run. */
    unhealthyGroup: number;
    /** Within-cap units kept because a member is referenced, curated, file-backed or too recently lost. */
    protected: number;
    /** Leaf roots that still have children, or roots owning unexpected member types. */
    shapeBlocked: number;
    /** Shape-valid units above the row cap; member eligibility and references are unassessed. */
    oversized: number;
    candidates: number;
    eligible: number;
    unknownAge: number;
    deleted: number;
    /** Rows removed with deleted units (root + members). */
    deletedRows: number;
    initialized: number;
    skipped: number;
}

export interface MediaRetentionResult {
    dryRun: boolean;
    retentionDays: number;
    candidates: number;
    hasMore: boolean;
    truncated: boolean;
    eligible: number;
    unknownAge: number;
    deleted: number;
    deletedRows: number;
    initialized: number;
    skipped: number;
    reasons: string[];
    /** Deleted unit roots. */
    deletedIds: string[];
    byKind: Record<RetentionKind, RetentionKindCounts>;
}

function emptyCounts(): RetentionKindCounts {
    return {
        roots: 0,
        missingProvenance: 0,
        unhealthyGroup: 0,
        protected: 0,
        shapeBlocked: 0,
        oversized: 0,
        candidates: 0,
        eligible: 0,
        unknownAge: 0,
        deleted: 0,
        deletedRows: 0,
        initialized: 0,
        skipped: 0,
    };
}

/** Postgres error codes that skip only the affected unit: lock wait, deadlock, statement timeout. */
const SKIPPABLE_ERRORS: Record<string, string> = {
    '55P03': 'concurrent-reference-or-library-write',
    '40P01': 'deadlock',
    '57014': 'statement-timeout',
};

export function skippableReason(error: unknown): string | null {
    if (typeof error !== 'object' || error === null || !('code' in error)) return null;
    const code = error.code;
    return typeof code === 'string' ? (SKIPPABLE_ERRORS[code] ?? null) : null;
}

/**
 * One retention pass: discover roots, validate their groups, evaluate units,
 * then (unless previewing) start unknown clocks and delete expired units one
 * guarded transaction at a time. A preview performs reads only.
 */
export async function runMediaRetention(
    sql: postgres.Sql,
    input: { dryRun: boolean; batchLimit: number },
    signal: AbortSignal,
    opts: { softDeadlineMs?: number; now?: () => number } = {},
): Promise<MediaRetentionResult> {
    signal.throwIfAborted();
    const now = opts.now ?? Date.now;
    const deadline = now() + (opts.softDeadlineMs ?? RETENTION_RUN_SOFT_DEADLINE_MS);
    const byKind = Object.fromEntries(RETENTION_KINDS.map((k) => [k, emptyCounts()])) as Record<
        RetentionKind,
        RetentionKindCounts
    >;
    const result: MediaRetentionResult = {
        dryRun: input.dryRun,
        retentionDays: MEDIA_RETENTION_DAYS,
        candidates: 0,
        hasMore: false,
        truncated: false,
        eligible: 0,
        unknownAge: 0,
        deleted: 0,
        deletedRows: 0,
        initialized: 0,
        skipped: 0,
        reasons: [],
        deletedIds: [],
        byKind,
    };
    if (result.retentionDays === 0) {
        result.reasons.push('Retention disabled (UNAVAILABLE_MEDIA_RETENTION_DAYS=0)');
        return result;
    }
    const addReason = (reason: string): void => {
        if (!result.reasons.includes(reason)) result.reasons.push(reason);
    };

    const discovery = await withTx(sql, async (tx) => {
        await tx`SET LOCAL lock_timeout = '2s'`;
        await tx`SET LOCAL statement_timeout = '60s'`;
        const groups = await findRetentionRootGroups(tx);
        signal.throwIfAborted();
        const refs = groups
            .filter((g) => g.group_key !== null)
            .map((g) => ({ kind: g.kind, groupKey: g.group_key as string }));
        const health = await validateRetentionGroups(tx, refs, signal);
        const evaluation = await evaluateRetentionUnits(tx, health.healthy, input.batchLimit + 1, {
            signal,
        });
        return { groups, health, evaluation };
    });
    signal.throwIfAborted();

    for (const group of discovery.groups) {
        const counts = byKind[group.kind];
        counts.roots += group.roots;
        if (group.group_key === null) counts.missingProvenance += group.roots;
        else if (
            discovery.health.unhealthy.some(
                (u) => u.kind === group.kind && u.groupKey === group.group_key,
            )
        )
            counts.unhealthyGroup += group.roots;
    }
    for (const kind of RETENTION_KINDS)
        if (byKind[kind].missingProvenance > 0)
            addReason(
                `${kind}: ${byKind[kind].missingProvenance} root(s) without library provenance`,
            );
    for (const reason of discovery.health.reasons) addReason(reason);
    for (const summary of discovery.evaluation.summary) {
        const counts = byKind[summary.kind];
        counts.protected += summary.protected;
        counts.shapeBlocked += summary.shape_blocked;
        counts.oversized += summary.oversized;
        if (summary.oversized > 0)
            addReason(
                `${summary.kind}: ${summary.oversized} unit(s) above ${RETENTION_UNIT_MAX_ROWS} rows; member eligibility unassessed`,
            );
    }

    const discovered = discovery.evaluation.candidates;
    result.hasMore = result.truncated = discovered.length > input.batchLimit;
    const candidates = discovered.slice(0, input.batchLimit);
    result.candidates = candidates.length;
    const healthMemo: RetentionHealthMemo = new Map();
    for (const item of candidates) {
        signal.throwIfAborted();
        if (now() >= deadline) {
            // Leave the rest to the next run rather than overrun the task timeout.
            result.hasMore = true;
            addReason('time-budget-exhausted');
            break;
        }
        const counts = byKind[item.kind];
        counts.candidates++;
        if (item.files_lost_at === null) {
            result.unknownAge++;
            counts.unknownAge++;
        } else {
            result.eligible++;
            counts.eligible++;
        }
        if (input.dryRun) continue;
        const skip = (reason: string): void => {
            result.skipped++;
            counts.skipped++;
            addReason(reason);
        };
        const knownFailure = healthMemo.get(healthMemoKey(item));
        if (knownFailure) {
            skip(knownFailure);
            continue;
        }
        try {
            if (item.files_lost_at === null) {
                const outcome = await initializeUnitClock(sql, item, signal, healthMemo);
                if (outcome.initialized) {
                    result.initialized++;
                    counts.initialized++;
                } else skip(outcome.reason ?? 'eligibility-changed');
            } else {
                const { MediaDeletionService } = await import('./media-deletion.service.js');
                const outcome = await MediaDeletionService.retentionDeleteUnit(sql, item, {
                    signal,
                    healthMemo,
                });
                if (outcome.deleted) {
                    result.deleted++;
                    counts.deleted++;
                    result.deletedRows += outcome.deletedCount;
                    counts.deletedRows += outcome.deletedCount;
                    result.deletedIds.push(item.id);
                } else skip(outcome.skipReason ?? 'eligibility-changed');
            }
        } catch (error) {
            // An active writer, config edit or slow statement wins; retry on the next run.
            if (signal.aborted) throw error;
            const reason = skippableReason(error);
            if (!reason) throw error;
            skip(reason);
        }
    }
    return result;
}
