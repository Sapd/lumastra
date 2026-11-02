// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stage statuses for media_item_stage_state.status.
 */
export const STAGE_STATUSES = [
    'pending',
    'running',
    'completed',
    'failed_transient',
    'failed_permanent',
    'skipped_permanent',
    'skipped_transient',
    'obsolete',
] as const;

export type StageStatus = (typeof STAGE_STATUSES)[number];

/**
 * Every issue type that can appear in `media_files.health_issues`.
 *
 * Canonical HERE rather than next to the DB query that writes it, because the
 * list crosses the server/client boundary three times: the query module's
 * `FileHealthIssue`, the ingest-map component types, and the validated client's
 * Zod enum. It used to be hand-copied into each; adding
 * `container_unreadable` in 2026-08 broke the copies, and the validated client
 * would have rejected whole responses carrying the new value. Add new types
 * once, here.
 *
 * Semantics of each are documented on `FileHealthIssue` in
 * `$lib/server/database/queries/media-files.queries.ts`.
 */
export const FILE_HEALTH_ISSUE_TYPES = [
    'truncated_video',
    'no_keyframes',
    'duration_mismatch',
    'tag_parse_timeout',
    'tag_parse_corrupt',
    'filename_not_utf8',
    'container_unreadable',
    'video_ends_early',
    'video_decode_gaps',
    'unsafe_filename',
    'playlist_container_rejected',
    'episode_number_unparsed',
    'series_identity_conflict',
    'series_folder_contention',
    'movie_identity_conflict',
    // A multi-episode file whose every episode has a file of its own: kept as
    // a stub row so the full scan can skip it while nothing changed.
    'range_superseded',
] as const;

export type FileHealthIssueType = (typeof FILE_HEALTH_ISSUE_TYPES)[number];

/**
 * Decode-quality issues discovered on a file that IS already linked to a
 * media item (trickplay generation, media-probe) — excluded from
 * {@link UNLINKED_FILE_HEALTH_ISSUE_TYPES} below. Kept as a type AND a
 * runtime Set (below) so both the compile-time narrowing on
 * `UnlinkedFileHealthIssueType` and the runtime `.filter()` stay expressed
 * from the same five names.
 *
 * `container_unreadable` is NOT here: besides the linked-file writers, the
 * scanner records it on the stub row of a NEW file whose probe found invalid
 * data (`probeNewFileForScan`), so the file backs off, stays on the Ingest
 * Map and survives orphan cleanup like every other unlinked scan failure.
 */
type LinkedOnlyIssueType =
    | 'truncated_video'
    | 'no_keyframes'
    | 'duration_mismatch'
    | 'video_ends_early'
    | 'video_decode_gaps';

/** @see LinkedOnlyIssueType */
const LINKED_ONLY_ISSUE_TYPES = new Set<FileHealthIssueType>([
    'truncated_video',
    'no_keyframes',
    'duration_mismatch',
    'video_ends_early',
    'video_decode_gaps',
]);

/**
 * Health-issue types that mean "the scanner recorded this INSTEAD OF linking
 * the file to a media item" — a stub `media_files` row exists (so the admin
 * can see and retry it) but `media_file_items` has no row for it.
 */
export type UnlinkedFileHealthIssueType = Exclude<FileHealthIssueType, LinkedOnlyIssueType>;

/**
 * Value form of {@link UnlinkedFileHealthIssueType}, derived from
 * {@link FILE_HEALTH_ISSUE_TYPES} by exclusion rather than listed
 * separately, so a type added to the canonical list is automatically
 * covered here too. Two SQL consumers need exactly this subset and must not
 * drift from it or from each other: the Ingest Map's unresolved-scan-issue
 * list (`listScanIssues`, media-files.queries.ts) and orphan cleanup's
 * do-not-delete guard (`cleanupOrphanedMediaFiles`,
 * database-cleanup.queries.ts) — deleting one of these rows would erase the
 * diagnostic state and reset the scanner's backoff (fix round 1, F2). The
 * Ingest Map UI (`IngestMap.svelte`) also uses it to pick which issue on a
 * row is the "primary" one to show, instead of its own hand-copied list.
 */
export const UNLINKED_FILE_HEALTH_ISSUE_TYPES = FILE_HEALTH_ISSUE_TYPES.filter(
    (t): t is UnlinkedFileHealthIssueType => !LINKED_ONLY_ISSUE_TYPES.has(t),
);

/** Coverage definition — see spec. */
export function isCoveredStatus(s: StageStatus): boolean {
    return s === 'completed' || s === 'skipped_permanent';
}

export type MediaType = 'movie' | 'series' | 'season' | 'episode' | 'album' | 'artist' | 'track';

/**
 * Read-only snapshot of a media item passed to stage eligibility predicates.
 * Keep this surface narrow — adding fields here is an SDK contract change.
 */
export interface MediaItemSnapshot {
    readonly id: string;
    readonly media_type: MediaType;
    readonly has_audio: boolean;
    readonly has_video: boolean;
    /**
     * True iff the item has at least one row in `media_file_items`. Used by
     * stages that strictly need a local file (media-probe, trickplay,
     * intro-analyzer, etc.) to short-circuit their eligibility predicate
     * rather than seeding the stage_state row as `pending` and waiting for
     * a file that may never arrive. When a file is later attached, the
     * `file.attached` event re-runs the predicate and flips eligible
     * rows back to `pending`.
     */
    readonly has_file: boolean;
    readonly runtime_seconds: number | null;
    readonly provider_tmdb_id: number | null;
    readonly provider_imdb_id: string | null;
    readonly provider_musicbrainz_id: string | null;
    readonly added_at: Date;
}

/**
 * **Legacy, HOST-INTERNAL only** invalidation kind. Removed from the public SDK
 * `invalidatedBy` contract (arch #4 — external plugins declare interest via
 * `PipelineEventName`). Retained here ONLY as the argument type of the host's
 * `StageStateService.invalidateByKind`, the outbox-OFF fallback path that maps a
 * kind to its `PipelineEventName` set (`EVENTS_FOR_KIND` in stage-state.service.ts).
 */
export type StageInvalidationKind = 'file-content' | 'metadata' | 'identity';

/**
 * Typed event taxonomy emitted from the database via triggers into
 * `event_outbox` (Phase A) and consumed by the pipeline event dispatcher.
 * Stages declare their interest in events through `invalidatedBy`; the
 * dispatcher routes each event to every applicable stage and re-runs its
 * eligibility predicate.
 *
 * Adding an event:
 *   1. Add the literal here.
 *   2. Add a typed payload to `EventPayload`.
 *   3. Wire the DB trigger emit-site.
 *   4. Optionally register a side-effect handler in the dispatcher.
 */
export const PIPELINE_EVENT_NAMES = [
    'item.created',
    'item.reclaimed',
    'item.dismissed',
    'item.deleted',
    'file.attached',
    'file.detached',
    'file.contentChanged',
    'file.defaultChanged',
    'file.windowChanged',
    'file.probed',
    'identity.assigned',
    'identity.changed',
    'identity.cleared',
    'metadata.changed',
    'media.becamePlayable',
] as const;

export type PipelineEventName = (typeof PIPELINE_EVENT_NAMES)[number];

/**
 * Per-event payload. Keep keys minimal and shape stable — these are
 * persisted to `event_outbox.payload` as JSONB and consumed by handlers
 * that may have been compiled at a different point in time during a
 * rolling deploy.
 */
export type PipelineEventPayload =
    | { event: 'item.created'; mediaId: string; source: string }
    | { event: 'item.reclaimed'; mediaId: string }
    | { event: 'item.dismissed'; mediaId: string }
    | { event: 'item.deleted'; mediaId: string }
    | {
          event: 'file.attached';
          mediaId: string;
          fileId: string;
          isDefault: boolean;
          firstFileForItem: boolean;
      }
    | {
          event: 'file.detached';
          mediaId: string;
          fileId: string;
          wasDefault: boolean;
          lastFileForItem: boolean;
      }
    | {
          event: 'file.contentChanged';
          mediaId: string;
          fileId: string;
          filePath: string;
      }
    | {
          event: 'file.defaultChanged';
          mediaId: string;
          oldFileId: string | null;
          newFileId: string;
      }
    | {
          // Emitted app-side (manual-file-links.service.ts) when an admin moves
          // an episode's window inside a shared file without a link being added,
          // removed or made default — the row trigger fires on none of those.
          // Stages that read the window (intro/credits detection) re-run.
          event: 'file.windowChanged';
          mediaId: string;
          fileId: string;
      }
    | {
          // Emitted by media-probe AFTER it writes media_streams + probed_at for
          // a file (the one signal that flips probe-derived eligibility:
          // has_video/has_audio). Lets probe-gated stages re-evaluate per item
          // without a heal. hasVideo/hasAudio are derived from the just-written
          // streams.
          event: 'file.probed';
          mediaId: string;
          fileId: string;
          hasVideo: boolean;
          hasAudio: boolean;
      }
    | {
          event: 'identity.assigned';
          mediaId: string;
          provider: string;
          externalId: string;
          manual: boolean;
          firstIdentityForItem: boolean;
      }
    | {
          event: 'identity.changed';
          mediaId: string;
          provider: string;
          oldExternalId: string;
          newExternalId: string;
      }
    | {
          event: 'identity.cleared';
          mediaId: string;
          provider: string;
          externalId: string;
          lastIdentityForItem: boolean;
      }
    | {
          event: 'metadata.changed';
          mediaId: string;
          changedFields: ReadonlyArray<string>;
      }
    | {
          // Emitted by a DB trigger when media_items.has_files flips false → true
          // (the moment an item — or its parent series via has_files propagation —
          // becomes playable). Notification-only: no stage declares interest, so
          // the dispatcher routes it straight to side-effect handlers (webhook
          // staging). mediaType is the raw media_items.media_type (UPPERCASE).
          event: 'media.becamePlayable';
          mediaId: string;
          mediaType: string;
      };

export interface StageRetryPolicy {
    maxAttempts?: number;
    backoff?: 'exponential' | 'fixed';
    initialDelayMs?: number;
    maxDelayMs?: number;
    skipTransientAfterMs?: number;
}

/**
 * Stage-disposition types are RE-EXPORTED directly from the SDK rather than
 * re-declared here. They used to be a hand-maintained host "mirror" that
 * DIVERGED from the SDK (the host `StageGuardContext.logger` was a narrow
 * `{info,warn,error,debug}` shape MISSING `.child`, and the host
 * `StageDispositionFragment` was a weak `{ strings?; parameters? }` structural
 * surface that no real `sql\`…\`` fragment is assignable to). Re-exporting makes
 * the host and SDK versions one and the same type — they can never drift again.
 *
 * Safe to import from the SDK: it is a types-only package (`export type`s only,
 * no runtime entry pulled in) and it does NOT import anything from the host, so
 * no import cycle is created. The host already imports `defineTask` and other
 * symbols from `@sapd/lumastra-plugin-sdk`.
 *
 * `CoversStagesDeclaration` below stays host-local because the host narrows
 * `appliesTo` to the host `MediaType` union and composes these re-exported
 * disposition types. It references `StageTerminalDisposition` directly, so the
 * names are imported (for local use) AND re-exported (for downstream importers).
 */
// Only StageTerminalDisposition is referenced locally (by CoversStagesDeclaration
// below); the rest are re-exported directly via the `export type … from` block.
import type { StageTerminalDisposition, StageEligibility } from '@sapd/lumastra-plugin-sdk';

export type {
    StageDispositionFragment,
    StageDispositionFragmentBuilder,
    StageEligibility,
    StageGuardContext,
    StageTerminalDisposition,
} from '@sapd/lumastra-plugin-sdk';

export interface CoversStagesDeclaration {
    id: string;
    /**
     * Eligibility version for THIS stage; omit to inherit the task's
     * `processingVersion`. Mirrors the SDK declaration — see the long note
     * there for why a task-level number cannot describe a multi-stage task.
     */
    processingVersion?: number;
    appliesTo: ReadonlyArray<MediaType>;
    /**
     * The SINGLE eligibility declaration — "should this stage ever run on this item?" — collapsing the
     * former `eligibilityPredicate` / `sqlEligibilityMirror` / `reEnrollReasons` seam. Native stages set
     * `eligibility.sql` (bulk SQL over `mi`); external/immutable stages set `eligibility.appliesTo`
     * (per-row TS). The framework derives seed-pending, sweep-dispose, and the event-independent heal from
     * this one block. See {@link StageEligibility}.
     */
    eligibility?: StageEligibility;
    /**
     * Events that invalidate this stage's coverage row, declared with the typed
     * `PipelineEventName` taxonomy ('file.attached' / 'file.contentChanged' /
     * 'identity.assigned' / 'metadata.changed' / etc.). The legacy
     * `StageInvalidationKind` strings were removed in arch #4.
     */
    invalidatedBy?: ReadonlyArray<PipelineEventName>;
    retryPolicy?: StageRetryPolicy;
    /**
     * Phase 2 opt-in flag. When `true`, the `stage-sweep` task will enqueue
     * per-item runs of the owning task for rows that are eligible (pending /
     * failed_transient / skipped_transient / obsolete past `next_eligible_at`).
     *
     * Default `false` for safety — a stage declaration is purely descriptive
     * unless the task explicitly opts into being driven by the sweeper. This
     * lets a task declare coverage (so admin UI can show its state) without
     * automatically being kicked by the sweeper, which is important for tasks
     * whose `inputSchema` doesn't tolerate `mediaItemId` or whose `identityFor`
     * collapses every enqueue to a single global run.
     */
    enqueueable?: boolean;
    /**
     * Host-side mirror of the SDK `terminalDisposition` field. REQUIRED when
     * `enqueueable === true` (warn-only during the phased rollout). Single
     * disposition or an ordered array for multi-pass tasks.
     */
    terminalDisposition?: StageTerminalDisposition | ReadonlyArray<StageTerminalDisposition>;
    /**
     * Per-tick row cap for this stage's eligibility-heal pass (the bounded flip of
     * `skipped_permanent/'ineligible'` rows back to `pending` once `eligibility` is TRUE again). Defaults
     * to the shared `SELF_HEAL_LIMIT`. Raise for a large one-time backlog recovery (the flip only marks
     * rows `pending`; downstream enqueue stays bounded by `MAX_ENQUEUES_PER_TICK` + per-class budget).
     */
    healLimit?: number;
    /**
     * Events for which an already-`completed` row should NOT be flipped back to
     * `pending` by `invalidateByEvent`. Use when a given event is a weak signal
     * that shouldn't re-run already-done work — e.g. declare `['file.attached']`
     * on a per-item analysis stage so ADDING an alternate-version file (a 4K
     * next to a 1080p) doesn't mass-re-analyse the whole library. The flip still
     * happens for every event NOT listed here.
     */
    preserveCompletedOn?: ReadonlyArray<PipelineEventName>;
}

export interface StageErrorDetail {
    remediation?: 'identity' | 'operational';
    message: string;
    code?: string;
    retryable?: boolean;
    plugin_id?: string;
    /**
     * The classifier's actual verdict, not the boolean it collapses to.
     *
     * `retryable` cannot distinguish `permanent` from `fatal`, and says nothing
     * about how the decision was reached. Grouping dead letters by verdict is
     * what turns "1,400 failures" into "1,400 failures, all fatal, all one rule".
     */
    kind?: 'transient' | 'permanent' | 'fatal';
    /**
     * Upstream HTTP status, when the thrown error carried one.
     *
     * Routinely discarded before reaching any stored row: a 404, a 429 and a 500
     * all arrived as `retryable: false` and became indistinguishable the moment
     * they were written. No amount of querying recovers a fact nobody stored,
     * which is why a 429 burst during first scan once turned every headline
     * health metric red with nothing on the row to say why.
     */
    status?: number;
    /**
     * WHICH rule produced `kind` — the field that makes a misclassification
     * diagnosable rather than merely visible.
     *
     * `'default'` is the one to look for: it means no rule matched and the
     * fallback decided. That is precisely how a 429 fell through
     * `classifyError`'s chain and was written off as permanent.
     */
    decidedBy?:
        'task-error-kind' | 'retryable-flag' | 'classifier' | 'classifier-threw' | 'default';
}

export interface StageStateRow {
    media_item_id: string;
    stage_id: string;
    processing_version: number;
    status: StageStatus;
    attempt: number;
    last_run_id: string | null;
    last_error: StageErrorDetail | null;
    skipped_reason: string | null;
    started_at: Date | null;
    completed_at: Date | null;
    next_eligible_at: Date | null;
    updated_at: Date;
}
