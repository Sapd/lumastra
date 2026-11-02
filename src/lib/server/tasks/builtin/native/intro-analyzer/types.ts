// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Detected segment types — keep in sync with `MediaSegmentTypeSchema` in
 * playback-types.ts (the enum the DB column is constrained to). Inlining the
 * union here avoids a cross-package import at the analyzer layer.
 */
export type DetectedSegmentType = 'Intro' | 'Outro' | 'Preview' | 'Recap' | 'Commercial';

/**
 * Which detector produced a candidate. This is the subsystem's evidence
 * vocabulary: it is persisted on `media_segment_candidates.method` and drives
 * `resolveSegments()`'s precedence ranking.
 *
 * Deliberately NOT a database CHECK constraint — adding a detector should be a
 * one-line change here, not a six-place schema migration.
 *
 * Ordering note: the ranking lives in `METHOD_RANK` (resolve.ts), not in the
 * declaration order of this union.
 */
export type DetectionMethod =
    | 'manual'
    | 'chapter-title'
    | 'chromaprint'
    | 'cohort'
    | 'chapter-mark'
    | 'blackframe'
    | 'anime-synth'
    /**
     * A `manual` candidate whose file changed underneath it. Never resolves —
     * a re-encode shifts timings, so a stale human answer is as wrong as a bad
     * detector. Surfaced in admin so an operator can re-confirm it.
     */
    | 'stale-manual';

export interface DetectedSegment {
    type: DetectedSegmentType;
    startTime: number;
    endTime: number;
    method: DetectionMethod;
    /**
     * 0..1. How much the producing detector trusts this boundary. Used only to
     * break ties WITHIN a method rank — it never promotes a candidate past a
     * higher-ranked method.
     */
    confidence?: number;
    /** True when the boundary was snapped onto an authored chapter mark. */
    snappedToChapter?: boolean;
}

/**
 * Why a detector declined to answer. A detector that cannot bound its own
 * answer MUST abstain rather than emit the edge of its search window as if it
 * were a detection — that is the failure mode this whole model exists to
 * prevent.
 */
export type AbstainReason =
    /** The matched region ran to the edge of the search window: unbounded, so the boundary is unknown. */
    | 'window-edge-truncated'
    /** Nothing was detected at all. */
    | 'no-detection'
    /** Input was unusable (no file, no duration, probe failed). */
    | 'unusable-input'
    /** The item is one episode inside a multi-episode file; tail-anchored detection is invalid. */
    | 'multi-episode-file';

export type DetectorOutcome =
    { kind: 'segment'; segment: DetectedSegment } | { kind: 'abstain'; reason: AbstainReason };

export interface ChapterInput {
    index: number;
    title: string | null;
    startTimeMs: number;
    endTimeMs: number;
}

export interface EpisodeWithFile {
    episodeId: string;
    title: string | null;
    seasonNumber: number | null;
    episodeNumber: number | null;
    filePath: string | null;
    durationSeconds: number | null;
    /** Persistence fence populated by the production season snapshot query. */
    fileId?: string;
    fileGeneration?: string;
    mediaGeneration?: string;
    globalGeneration?: string | null;
    inputIdentity?: string;
    physicalIdentity?: string;
    runId?: string;
    startOffsetMs?: number | null;
    endOffsetMs?: number | null;
}

export interface TimeRange {
    start: number;
    end: number;
}
