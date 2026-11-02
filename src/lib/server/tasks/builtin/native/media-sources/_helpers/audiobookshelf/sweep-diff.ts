// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audiobookshelf reconcile-sweep differ.
 *
 * A pure function: upstream id-set + local id-set in, an action plan out. No
 * database, no HTTP, no clock. Everything the sweep decides — including both
 * deletion rails — is decided here so it can be tested exhaustively without a
 * server or a schema.
 *
 * ABS exposes no `changed-since` cursor and no `updatedAt` sort, so this is a
 * full reconcile every cycle rather than an incremental cursor walk. The two
 * revision keys are:
 *
 * - `updatedAt` — ABS bumps the *item* row on nested media edits
 *   (`changed('updatedAt', true)`), so it catches metadata and chapter changes.
 * - `mtimeMs` — the *file* mtime, so a replaced audio file is detected even when
 *   the metadata is untouched.
 *
 * The dangerous direction is deletion: a book that is merely unreachable must
 * never be mistaken for a book that is gone. Two rails guard it, both
 * implemented here:
 *
 * 1. {@link AudiobookSweepInput.snapshotComplete} — false when the upstream
 *    listing could not be proven complete (a page errored, pagination did not
 *    advance, fewer items arrived than `total` promised). The dismissal pass is
 *    skipped entirely; additions and updates still apply, because a partial
 *    listing can only under-report, never invent.
 * 2. A threshold cap on how much of a library one cycle may dismiss.
 */

/** The three ABS fields the differ keys on, for one upstream item. */
export interface RemoteAudiobookState {
    /** ABS `libraryItemId`. */
    id: string;
    /** Epoch ms. */
    updatedAt: number;
    /** Epoch ms. */
    mtimeMs: number;
    /** ABS lost the files on disk. Maps to `has_files = false`, never a delete. */
    isMissing: boolean;
}

/** The local counterpart, as read back from `media_items` + `external_ids`. */
export interface LocalAudiobookState {
    mediaId: string;
    absItemId: string;
    /** `media_items.status`. Anything but `'active'` is left strictly alone. */
    status: string;
    hasFiles: boolean;
    isDismissed: boolean;
    /** Last seen ABS `updatedAt`; null when never recorded or unreadable. */
    absUpdatedAt: number | null;
    /** Last seen ABS `mtimeMs`; null when never recorded or unreadable. */
    absMtimeMs: number | null;
}

/**
 * A book that exists on both sides and needs at least one write.
 *
 * `needsRefetch` and the flag targets are independent: a book can go missing
 * without its metadata changing (flags only), change its metadata while staying
 * present (refetch only), or both at once.
 */
export interface AudiobookChangeAction {
    local: LocalAudiobookState;
    remote: RemoteAudiobookState;
    /**
     * A revision key moved (or was never recorded) — the caller must fetch the
     * expanded item, rewrite the row and **re-import chapters**.
     */
    needsRefetch: boolean;
    /** Target `has_files`. `false` exactly when ABS reports `isMissing`. */
    hasFiles: boolean;
    /** The row was dismissed and the id came back upstream — clear it. */
    clearsDismissal: boolean;
}

/** Why the dismissal pass did not run. */
export type DismissalSkip =
    | {
          reason: 'snapshot-incomplete';
          message: string;
          /** Rows that *would* have been dismissed had the snapshot been trusted. */
          candidates: number;
      }
    | {
          reason: 'threshold-exceeded';
          message: string;
          candidates: number;
          /** Denominator: active local rows for this library. */
          total: number;
          /** Largest dismissal count this cycle was allowed to perform. */
          allowed: number;
          ratio: number;
          thresholdRatio: number;
      };

export interface AudiobookSweepPlan {
    /** Upstream ids with no local row — fetch expanded, then insert. */
    additions: RemoteAudiobookState[];
    /** Present on both sides, at least one write needed. */
    changes: AudiobookChangeAction[];
    /** Present on both sides, already in sync. */
    unchanged: LocalAudiobookState[];
    /**
     * Local rows to dismiss (`is_dismissed = true` AND `has_files = false`).
     * Empty whenever {@link AudiobookSweepPlan.dismissalSkip} is set.
     */
    dismissals: LocalAudiobookState[];
    /** Non-null when a rail suppressed the dismissal pass this cycle. */
    dismissalSkip: DismissalSkip | null;
    /**
     * Local rows absent upstream that are **not yet** in the dismissed state —
     * i.e. this cycle's dismissal candidates, counted regardless of whether the
     * pass ran, so telemetry does not silently report "0 removed" when a rail
     * fired.
     */
    absentUpstream: LocalAudiobookState[];
    /**
     * Local rows absent upstream that already carry the dismissal's target
     * state (`is_dismissed = true` AND `has_files = false`).
     *
     * They are deliberately NOT candidates. Dismissal is permanent until the id
     * returns upstream (the sweep never writes `status = 'deleted'`, and
     * {@link LocalAudiobookState} rows are read back including dismissed ones),
     * so counting them every cycle would (a) ratchet the threshold rail shut
     * forever once accumulated absences exceed the cap, (b) rewrite long-gone
     * rows and re-report them as "removed" on every run, and (c) push them
     * through cache invalidation every 15 minutes. Reported as skipped.
     */
    alreadyDismissed: LocalAudiobookState[];
    /**
     * Local rows the sweep refuses to touch because an operator moved them out
     * of `status = 'active'` (soft delete / merge). They still consume their ABS
     * id, so the id is NOT treated as absent locally and no duplicate is created.
     */
    skippedInactive: LocalAudiobookState[];
    /** Upstream entries dropped because another entry already claimed the id. */
    duplicateRemoteIds: number;
}

export interface AudiobookSweepThresholds {
    /**
     * Largest share of a library's active local rows one cycle may dismiss.
     * Defaults to {@link DEFAULT_MAX_DISMISSAL_RATIO} (10%).
     */
    maxDismissalRatio?: number;
    /**
     * Dismissals always permitted regardless of the ratio. Defaults to
     * {@link DEFAULT_MIN_DISMISSAL_ALLOWANCE}.
     *
     * Without a floor the rail is a permanent false alarm on small libraries:
     * 10% of nine books is 0.9, so a nine-book library could never lose a book
     * and would log a threshold error every cycle forever. The floor is safe
     * because dismissal is reversible and metadata-only — the id reappearing
     * upstream clears both flags — whereas an alert nobody can clear trains
     * operators to ignore the rail that matters.
     *
     * The floor does **not** apply when `maxDismissalRatio` is exactly `0`.
     * Zero is the one value an operator can only have typed deliberately, and
     * it means "never dismiss" — letting a floor override it would make the
     * setting's documented minimum a lie and leak an unbounded drip (three per
     * cycle, 288 a day at the 15-minute cadence).
     */
    minDismissalAllowance?: number;
}

export interface AudiobookSweepInput {
    /** Every item the upstream listing returned for this library. */
    remote: RemoteAudiobookState[];
    /** Every local row carrying this library's id. */
    local: LocalAudiobookState[];
    /**
     * False when the upstream listing could not be proven complete. Gates the
     * dismissal pass and nothing else.
     */
    snapshotComplete: boolean;
    thresholds?: AudiobookSweepThresholds;
}

export const DEFAULT_MAX_DISMISSAL_RATIO = 0.1;
export const DEFAULT_MIN_DISMISSAL_ALLOWANCE = 3;

/**
 * Clamp an operator-supplied ratio into `[0, 1]`.
 *
 * A non-finite or negative value falls back to the default rather than
 * disabling the rail — a typo in settings must not be able to unlock unlimited
 * dismissals. `0` is honoured, and means "never dismiss on ratio alone".
 */
export function normalizeDismissalRatio(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return DEFAULT_MAX_DISMISSAL_RATIO;
    }
    return Math.min(1, value);
}

function normalizeAllowance(value: number | undefined): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return DEFAULT_MIN_DISMISSAL_ALLOWANCE;
    }
    return Math.floor(value);
}

/**
 * Has a revision key moved since the row was written?
 *
 * A null local key means the row predates revision tracking (or the value in
 * `custom_metadata` was unreadable). That resolves to `true` — refetching costs
 * one request, whereas treating "unknown" as "unchanged" would freeze the row
 * forever.
 */
function revisionChanged(local: LocalAudiobookState, remote: RemoteAudiobookState): boolean {
    if (local.absUpdatedAt === null || local.absMtimeMs === null) return true;
    return local.absUpdatedAt !== remote.updatedAt || local.absMtimeMs !== remote.mtimeMs;
}

/**
 * Diff one ABS library against its local rows and produce the action plan.
 *
 * Deterministic and order-preserving: `additions` follow upstream order,
 * everything else follows the order the local rows were supplied in, so the
 * caller's logs and the executor's writes are stable across runs.
 */
export function planAudiobookSweep(input: AudiobookSweepInput): AudiobookSweepPlan {
    const maxDismissalRatio = normalizeDismissalRatio(input.thresholds?.maxDismissalRatio);
    const minDismissalAllowance = normalizeAllowance(input.thresholds?.minDismissalAllowance);

    const remoteById = new Map<string, RemoteAudiobookState>();
    let duplicateRemoteIds = 0;
    for (const item of input.remote) {
        if (remoteById.has(item.id)) {
            // First occurrence wins. A repeat is either a paging artefact or an
            // ABS bug; either way the two entries describe the same book, and
            // picking one arbitrarily would make the revision diff flap.
            duplicateRemoteIds++;
            continue;
        }
        remoteById.set(item.id, item);
    }

    const additions: RemoteAudiobookState[] = [];
    const changes: AudiobookChangeAction[] = [];
    const unchanged: LocalAudiobookState[] = [];
    const absentUpstream: LocalAudiobookState[] = [];
    const alreadyDismissed: LocalAudiobookState[] = [];
    const skippedInactive: LocalAudiobookState[] = [];

    const localById = new Map<string, LocalAudiobookState>();
    for (const row of input.local) {
        localById.set(row.absItemId, row);
    }

    for (const row of input.local) {
        // A row that lost the map race is a duplicate `external_id`, which the
        // unique index makes impossible; skip it rather than write twice.
        if (localById.get(row.absItemId) !== row) continue;

        if (row.status !== 'active') {
            skippedInactive.push(row);
            continue;
        }

        const remote = remoteById.get(row.absItemId);
        if (!remote) {
            // Already in the target state — nothing left to write, and counting
            // it would ratchet the threshold rail shut permanently.
            if (row.isDismissed && !row.hasFiles) alreadyDismissed.push(row);
            else absentUpstream.push(row);
            continue;
        }

        const needsRefetch = revisionChanged(row, remote);
        const hasFiles = !remote.isMissing;
        const clearsDismissal = row.isDismissed;

        if (!needsRefetch && hasFiles === row.hasFiles && !clearsDismissal) {
            unchanged.push(row);
            continue;
        }

        changes.push({ local: row, remote, needsRefetch, hasFiles, clearsDismissal });
    }

    for (const item of remoteById.values()) {
        if (!localById.has(item.id)) additions.push(item);
    }

    const { dismissals, dismissalSkip } = decideDismissals({
        absentUpstream,
        // Denominator is the library's *active* local population — the rows the
        // sweep could actually dismiss. Inactive rows are never candidates, so
        // counting them would inflate the allowance. Already-dismissed rows DO
        // count: they are still rows this connector owns, and the ratio the rail
        // guards is "how much of the library vanished in THIS cycle", not "how
        // much has ever been gone".
        activeLocalCount: input.local.length - skippedInactive.length,
        snapshotComplete: input.snapshotComplete,
        maxDismissalRatio,
        minDismissalAllowance,
    });

    return {
        additions,
        changes,
        unchanged,
        dismissals,
        dismissalSkip,
        absentUpstream,
        alreadyDismissed,
        skippedInactive,
        duplicateRemoteIds,
    };
}

interface DismissalDecisionInput {
    absentUpstream: LocalAudiobookState[];
    activeLocalCount: number;
    snapshotComplete: boolean;
    maxDismissalRatio: number;
    minDismissalAllowance: number;
}

function decideDismissals(input: DismissalDecisionInput): {
    dismissals: LocalAudiobookState[];
    dismissalSkip: DismissalSkip | null;
} {
    const candidates = input.absentUpstream.length;
    if (candidates === 0) {
        return { dismissals: [], dismissalSkip: null };
    }

    // Rail 1. Checked before the threshold so the operator-facing reason names
    // the actual cause: an incomplete listing that happens to be under 10% is
    // still an incomplete listing, and reporting "threshold ok" would be a lie.
    if (!input.snapshotComplete) {
        return {
            dismissals: [],
            dismissalSkip: {
                reason: 'snapshot-incomplete',
                message: `Upstream listing was incomplete; skipping dismissal of ${candidates} item(s) absent from it`,
                candidates,
            },
        };
    }

    // Rail 2. The whole pass aborts rather than dismissing the first N — a
    // partial dismissal would silently normalise the damage, and the next cycle
    // (facing a smaller remainder) could then slip under the cap and finish it.
    //
    // A ratio of exactly 0 disables dismissal outright: it is the rail's
    // documented opt-out, so the small-library floor must not override it (see
    // AudiobookSweepThresholds.minDismissalAllowance).
    const allowed =
        input.maxDismissalRatio === 0
            ? 0
            : Math.max(
                  input.minDismissalAllowance,
                  Math.floor(input.activeLocalCount * input.maxDismissalRatio),
              );
    if (candidates > allowed) {
        const ratio = input.activeLocalCount > 0 ? candidates / input.activeLocalCount : 1;
        return {
            dismissals: [],
            dismissalSkip: {
                reason: 'threshold-exceeded',
                message:
                    `Refusing to dismiss ${candidates} of ${input.activeLocalCount} local item(s) ` +
                    `(${(ratio * 100).toFixed(1)}%) — above the ${(input.maxDismissalRatio * 100).toFixed(1)}% cap ` +
                    `(max ${allowed} this cycle). Nothing was dismissed.`,
                candidates,
                total: input.activeLocalCount,
                allowed,
                ratio,
                thresholdRatio: input.maxDismissalRatio,
            },
        };
    }

    return { dismissals: input.absentUpstream, dismissalSkip: null };
}
