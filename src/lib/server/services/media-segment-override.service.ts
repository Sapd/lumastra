// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Manual media-segment overrides — plan §4 Phase 6.
 *
 * An override is not a new subsystem: it is a candidate with `method = 'manual'`,
 * which `METHOD_RANK` places above every detector. That single fact is what makes
 * the feature durable. A `PROCESSING_VERSION` bump, a `reset`, a re-scan and the
 * analyzer's `wipeAll` all delete detector evidence with
 * `exceptMethods: ['manual']` and then re-resolve, so the human answer is
 * re-materialized instead of being overwritten. Nothing here has to defend it.
 *
 * The one event that DOES invalidate an override is the file changing underneath
 * it: `invalidateFileProbeData` (media-files.queries.ts) demotes `manual` to
 * `stale-manual`, a method the resolver refuses to materialize. Re-confirming an
 * override through this service supersedes that tombstone for the type it covers.
 */

import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    getEpisodeInfo,
    getMediaTypeById,
    upsertSegments,
} from '$lib/server/database/queries/media-segments.queries.js';
import { getProbeDataForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { getTaskSettings } from '$lib/server/database/queries/task-settings.queries.js';
import {
    getCandidatesForMedia,
    replaceCandidatesForMethod,
    toCandidates,
    type MediaSegmentCandidate,
    type MediaSegmentCandidateInput,
} from '$lib/server/database/queries/media-segment-candidates.queries.js';
import {
    resolveSegments,
    type ResolveContext,
} from '$lib/server/tasks/builtin/native/intro-analyzer/resolve.js';
import { acquireMediaSegmentResolutionLock } from '$lib/server/tasks/builtin/native/intro-analyzer/resolution-lock.js';
import {
    checkPlausibility,
    DURATION_EPSILON_SEC,
    type PlausibilityConfig,
} from '$lib/server/tasks/builtin/native/intro-analyzer/plausibility.js';
import type {
    DetectedSegment,
    DetectedSegmentType,
} from '$lib/server/tasks/builtin/native/intro-analyzer/types.js';
import { isEpisode, isMovie } from '$lib/server/utils/media-types.js';

/**
 * The override materializes under the ANALYZER's source string, not a source of
 * its own. `media_segments` is `UNIQUE NULLS NOT DISTINCT (media_id, type, source, file_id)` and the player
 * takes the first row by `start_time ASC`, so a second source would produce two
 * Outro rows and a coin flip (plan §2 G4). The override wins by out-ranking the
 * detectors in the resolver, never by writing a competing row.
 */
const INTRO_ANALYZER_PLUGIN_ID = 'lumastra-intro-analyzer';

/**
 * A human said so. Confidence only ever breaks ties WITHIN a method rank and
 * `manual` has exactly one producer, so this is documentation more than logic —
 * but a stored 0.5 would read as "the operator was unsure".
 */
const MANUAL_CONFIDENCE = 1;

/** Read-path filter that can hide a manual Intro — see `isSuppressedAtRead`. */
const SUPPRESS_FIRST_EPISODE_INTRO_KEY = 'suppressFirstEpisodeIntro';

// ---------------------------------------------------------------------------
// Plausibility config
// ---------------------------------------------------------------------------

/**
 * Mirrors the plausibility slice of `SETTINGS_DEFAULTS` in
 * lumastra-intro-analyzer.ts.
 *
 * Duplicated rather than imported because the analyzer's `readTaskSettings` /
 * `buildPlausibilityConfig` are module-private to a 2.8k-line task file. The
 * duplication is deliberate and narrow: this path MUST judge an override by the
 * same numbers the analyzer will judge it by on the next scheduled run, or the
 * two disagree about whether the override is servable and the operator sees it
 * appear and then vanish. Extracting the analyzer's settings reader into a
 * shared module is the proper fix and would delete this block.
 */
const PLAUSIBILITY_DEFAULTS: PlausibilityConfig = {
    minSegmentDuration: 15,
    maxIntroDuration: 120,
    introWindowMaxSec: 600,
    maxPlausibleCreditsDuration: 150,
    maxPlausibleMovieCreditsDuration: 900,
    outroMinStartFraction: 0.8,
};

function pickFiniteNumber(raw: unknown, fallback: number, min: number, max: number): number {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < min || raw > max) return fallback;
    return raw;
}

/**
 * Project operator settings onto the gate's inputs. Ranges match the analyzer's
 * own coercion so a value it rejects is rejected here too.
 *
 * Exported for tests: the coercion is the part that can silently drift from the
 * analyzer, so it is the part worth pinning.
 */
export function readPlausibilityConfig(raw: Record<string, unknown>): PlausibilityConfig {
    return {
        minSegmentDuration: pickFiniteNumber(
            raw.minSegmentDuration,
            PLAUSIBILITY_DEFAULTS.minSegmentDuration,
            1,
            600,
        ),
        maxIntroDuration: pickFiniteNumber(
            raw.maxIntroDuration,
            PLAUSIBILITY_DEFAULTS.maxIntroDuration,
            1,
            3600,
        ),
        introWindowMaxSec: pickFiniteNumber(
            raw.introWindowMaxSec,
            PLAUSIBILITY_DEFAULTS.introWindowMaxSec,
            1,
            3600,
        ),
        maxPlausibleCreditsDuration: pickFiniteNumber(
            raw.maxPlausibleCreditsDuration,
            PLAUSIBILITY_DEFAULTS.maxPlausibleCreditsDuration,
            1,
            3600,
        ),
        maxPlausibleMovieCreditsDuration: pickFiniteNumber(
            raw.maxPlausibleMovieCreditsDuration,
            PLAUSIBILITY_DEFAULTS.maxPlausibleMovieCreditsDuration,
            1,
            7200,
        ),
        outroMinStartFraction: pickFiniteNumber(
            raw.outroMinStartFraction,
            PLAUSIBILITY_DEFAULTS.outroMinStartFraction,
            0,
            1,
        ),
    };
}

// ---------------------------------------------------------------------------
// Request / result shapes
// ---------------------------------------------------------------------------

export interface ManualSegmentOverrideInput {
    mediaId: string;
    type: DetectedSegmentType;
    startTime: number;
    endTime: number;
    /** Operator username, recorded on the candidate's `notes` for provenance. */
    setBy?: string;
}

/** Stable, greppable reason ids. The route maps these onto problem codes. */
export type ManualOverrideRejectionReason =
    | 'media-not-found'
    | 'unsupported-media-type'
    | 'unknown-duration'
    | 'non-finite-bounds'
    | 'negative-start'
    | 'non-positive-duration'
    | 'end-past-duration';

export interface ManualOverrideRejection {
    ok: false;
    reason: ManualOverrideRejectionReason;
    detail: string;
}

export interface ManualOverrideApplied {
    ok: true;
    /** The runtime the times were validated against. */
    durationSeconds: number;
    /** True when the override is the row the read path now serves for its type. */
    materialized: boolean;
    /**
     * Set when the override was stored as evidence but did NOT become the served
     * row. The candidate is kept either way — withholding is a statement about
     * this resolution, not a reason to discard what the operator said.
     */
    withheldRule?: string;
    withheldDetail?: string;
    /**
     * True when `suppressFirstEpisodeIntro` will hide this override from the
     * player even though it materialized. Not an error — the operator has to be
     * told, because from the UI the two look identical.
     */
    suppressedAtRead?: boolean;
    /** How many segments the item has after re-resolution, across all types. */
    segmentsResolved: number;
}

export type ManualOverrideResult = ManualOverrideApplied | ManualOverrideRejection;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Reject nonsense outright — never clamp.
 *
 * Clamping would turn a typo into a plausible-looking segment with no record
 * that the operator meant something else, which is the same "a guess stored as
 * a fact" failure the evidence model exists to end.
 *
 * These are the structural bounds — the segment must describe a real region of
 * a real file. The type-specific POLICY caps (credits length, intro window) do
 * NOT apply to a manual override: they are heuristics aimed at detectors, and
 * overruling them is the whole point of the feature (see plausibility.ts). An
 * override can still be withheld by the Intro/Outro overlap arbitration, which
 * `withheldRule` reports.
 */
export function validateOverrideTimes(
    startTime: number,
    endTime: number,
    durationSeconds: number,
): ManualOverrideRejection | null {
    if (!Number.isFinite(startTime) || !Number.isFinite(endTime)) {
        return {
            ok: false,
            reason: 'non-finite-bounds',
            detail: `start=${String(startTime)} end=${String(endTime)}`,
        };
    }
    if (startTime < 0) {
        return {
            ok: false,
            reason: 'negative-start',
            detail: `start ${startTime}s is before the file begins`,
        };
    }
    if (endTime <= startTime) {
        return {
            ok: false,
            reason: 'non-positive-duration',
            detail: `end ${endTime}s must be greater than start ${startTime}s`,
        };
    }
    // The same float32/container slack the gate allows, so a boundary read off
    // the end of the file is accepted here exactly as a detector's would be.
    if (endTime > durationSeconds + DURATION_EPSILON_SEC) {
        return {
            ok: false,
            reason: 'end-past-duration',
            detail: `end ${endTime}s exceeds file duration ${durationSeconds}s`,
        };
    }
    return null;
}

// ---------------------------------------------------------------------------
// Candidate merging
// ---------------------------------------------------------------------------

function toInput(candidate: MediaSegmentCandidate): MediaSegmentCandidateInput {
    return {
        type: candidate.type,
        startTime: candidate.startTime,
        endTime: candidate.endTime,
        confidence: candidate.confidence,
        detectorVersion: candidate.detectorVersion,
        configHash: candidate.configHash ?? null,
        snappedToChapter: candidate.snappedToChapter,
        notes: candidate.notes ?? null,
    };
}

export interface MergedManualCandidates {
    /** The full `manual` set to write — one row per overridden type. */
    manual: MediaSegmentCandidateInput[];
    /**
     * The `stale-manual` set to write, or null when it does not need rewriting.
     * Non-null only when this override supersedes a tombstone of the same type.
     */
    staleManual: MediaSegmentCandidateInput[] | null;
}

/**
 * Fold one override into the item's existing hand-written candidates.
 *
 * `replaceCandidatesForMethod` is all-or-nothing per method by design (its
 * delete runs even on an empty set), so writing one type means restating every
 * other type's manual candidate in the same call — otherwise setting an Outro
 * would silently discard the operator's Intro. Restating rewrites those rows,
 * which resets their `created_at`; the content is preserved and no consumer
 * reads that column, so this is cheaper than a second write path.
 *
 * A `stale-manual` row of the SAME type is dropped: re-confirming an override
 * after a re-encode is exactly the answer the tombstone was waiting for. Other
 * types' tombstones are left alone — they are still unanswered.
 */
export function mergeManualCandidates(
    existing: readonly MediaSegmentCandidate[],
    override: MediaSegmentCandidateInput,
): MergedManualCandidates {
    const manual = existing
        .filter((c) => c.method === 'manual' && c.type !== override.type)
        .map(toInput);
    manual.push(override);

    const supersedesTombstone = existing.some(
        (c) => c.method === 'stale-manual' && c.type === override.type,
    );
    const staleManual = supersedesTombstone
        ? existing
              .filter((c) => c.method === 'stale-manual' && c.type !== override.type)
              .map(toInput)
        : null;

    return { manual, staleManual };
}

/**
 * Why the override is not the served row for its type.
 *
 * Two causes exist and they are not interchangeable: the gate rejected it (a
 * statement about the times themselves), or it lost the Intro/Outro overlap
 * arbitration inside the resolver (a statement about the item's other segment).
 * Returning the rule id lets the operator fix the right thing.
 */
export function explainWithheldOverride(
    override: DetectedSegment,
    ctx: ResolveContext,
    config: PlausibilityConfig,
): { rule: string; detail: string } {
    const verdict = checkPlausibility(override, ctx, config);
    if (!verdict.ok) return { rule: verdict.rule, detail: verdict.detail };
    return {
        rule: 'intro-outro-overlap',
        detail: `the ${override.type} overlaps the other resolved segment and lost the overlap arbitration`,
    };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * First probed file's duration, in the same part order the analyzer uses.
 *
 * Returns null when the item has no probed file — which is precisely the state
 * `invalidateFileProbeData` leaves behind, so an override attempted between a
 * re-encode and the re-probe is refused rather than validated against a runtime
 * that no longer exists.
 */
/**
 * Would `suppressFirstEpisodeIntro` hide this override from the player?
 *
 * `media-segments.service.ts` drops every `Intro` from episode 1 at READ time
 * when that flag is on (its rationale is a cold-open false positive on the
 * series premiere). It cannot tell a detector's Intro from a human's, so a
 * manual Intro on episode 1 is stored, resolved, materialized — and then
 * silently filtered out, which reads as the feature being broken. This is the
 * residual the plan flags for Phase 6 (§7); the honest fix is to say so at the
 * moment the operator sets it rather than to change read-path behaviour from
 * here.
 */
async function isSuppressedAtRead(
    sql: postgres.Sql,
    input: ManualSegmentOverrideInput,
    settings: Record<string, unknown>,
): Promise<boolean> {
    if (input.type !== 'Intro') return false;
    const raw = settings[SUPPRESS_FIRST_EPISODE_INTRO_KEY];
    // Same tolerant read as the read path: plugin_settings is operator-writable
    // and stores this as either a JSON boolean or the string 'true'.
    if (raw !== true && raw !== 'true') return false;
    const info = await getEpisodeInfo(sql, input.mediaId);
    return info !== null && isEpisode(info.media_type) && info.episode_number === 1;
}

async function getFileDurationSeconds(sql: postgres.Sql, mediaId: string): Promise<number | null> {
    const rows = await getProbeDataForMediaItem(sql, mediaId);
    const duration = rows[0]?.duration_seconds ?? null;
    if (duration === null || !Number.isFinite(duration) || duration <= 0) return null;
    return duration;
}

/**
 * Write the override and re-resolve the item, in ONE transaction.
 *
 * The transaction is not cosmetic: a targeted `media-<id>` analyzer run can
 * execute concurrently with the global drain on the same episode
 * (`exclusiveWith` collapses only same-identity runs), so reading the evidence
 * pool, ranking it and writing the answer has to be atomic or two passes
 * interleave and materialize a winner neither of them resolved.
 */
export async function applyManualSegmentOverride(
    sql: postgres.Sql,
    input: ManualSegmentOverrideInput,
): Promise<ManualOverrideResult> {
    const mediaType = await getMediaTypeById(sql, input.mediaId);
    if (!mediaType) {
        return {
            ok: false,
            reason: 'media-not-found',
            detail: `media item ${input.mediaId} does not exist`,
        };
    }
    if (!isEpisode(mediaType) && !isMovie(mediaType)) {
        return {
            ok: false,
            reason: 'unsupported-media-type',
            detail: `manual segments can only be set on an episode or movie, not ${mediaType}`,
        };
    }

    const durationSeconds = await getFileDurationSeconds(sql, input.mediaId);
    if (durationSeconds === null) {
        return {
            ok: false,
            reason: 'unknown-duration',
            detail: `media item ${input.mediaId} has no probed file duration to validate against`,
        };
    }

    const rejection = validateOverrideTimes(input.startTime, input.endTime, durationSeconds);
    if (rejection) return rejection;

    const settings = await getTaskSettings(sql, INTRO_ANALYZER_PLUGIN_ID);
    const plausibility = readPlausibilityConfig(settings);
    const suppressedAtRead = await isSuppressedAtRead(sql, input, settings);
    const ctx: ResolveContext = { durationSeconds, isMovie: isMovie(mediaType) };

    const override: MediaSegmentCandidateInput = {
        type: input.type,
        startTime: input.startTime,
        endTime: input.endTime,
        confidence: MANUAL_CONFIDENCE,
        snappedToChapter: false,
        notes: input.setBy ? `manual override by ${input.setBy}` : 'manual override',
    };

    return withTx(sql, async (tx) => {
        await acquireMediaSegmentResolutionLock(tx, input.mediaId);

        const existing = toCandidates(await getCandidatesForMedia(tx, input.mediaId));
        const merged = mergeManualCandidates(existing, override);

        await replaceCandidatesForMethod(tx, input.mediaId, 'manual', merged.manual);
        if (merged.staleManual !== null) {
            await replaceCandidatesForMethod(tx, input.mediaId, 'stale-manual', merged.staleManual);
        }

        // Re-read rather than patching `existing` in memory: the write above is
        // the authority on what the pool now contains, and a concurrent pass
        // committing before this transaction's snapshot would otherwise be
        // invisible here.
        const pool: DetectedSegment[] = toCandidates(
            await getCandidatesForMedia(tx, input.mediaId),
        ).map((candidate) => ({
            type: candidate.type,
            startTime: candidate.startTime,
            endTime: candidate.endTime,
            method: candidate.method,
            confidence: candidate.confidence,
            snappedToChapter: candidate.snappedToChapter,
        }));

        const resolved = resolveSegments(pool, ctx, plausibility);
        await upsertSegments(
            tx,
            input.mediaId,
            resolved.map((segment) => ({
                type: segment.type,
                startTime: segment.startTime,
                endTime: segment.endTime,
            })),
            INTRO_ANALYZER_PLUGIN_ID,
        );

        const winner = resolved.find((segment) => segment.type === input.type);
        if (winner?.method === 'manual') {
            return {
                ok: true,
                durationSeconds,
                materialized: true,
                ...(suppressedAtRead ? { suppressedAtRead } : undefined),
                segmentsResolved: resolved.length,
            };
        }

        const withheld = explainWithheldOverride(
            { ...override, method: 'manual' },
            ctx,
            plausibility,
        );
        return {
            ok: true,
            durationSeconds,
            materialized: false,
            withheldRule: withheld.rule,
            withheldDetail: withheld.detail,
            segmentsResolved: resolved.length,
        };
    });
}
