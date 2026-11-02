// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    checkPlausibility,
    isStructuralRejection,
    type PlausibilityConfig,
    type PlausibilityRejection,
} from './plausibility.js';
import type { DetectedSegment, DetectedSegmentType, DetectionMethod } from './types.js';

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Gap between adjacent ranks. Ranks are spaced rather than consecutive so a new
 * detector can be slotted between two existing ones without renumbering the
 * table (and without invalidating anything persisted — rank is code, never data).
 * cohort.ts derives its per-method consensus weight from this spacing.
 */
export const METHOD_RANK_STEP = 10;

/**
 * Precedence between detectors. Lower wins.
 *
 * The ordering is an evidence ordering, not a quality guess: a human answer
 * beats an authored chapter title, which beats the season's own agreement,
 * which beats a cross-episode audio match, which beats an untitled chapter
 * boundary, which beats a luma heuristic. Blackframe is last because it cannot
 * distinguish a credit roll from a dark scene at all (see blackframe.ts).
 *
 * ## Why `cohort` outranks `chromaprint`
 *
 * The cohort layer only ever speaks when an episode's own winner disagrees with
 * its siblings, so its verdict has to be able to overrule the method that
 * produced that winner — otherwise re-resolution re-picks the outlier the
 * cohort just rejected and the whole layer is a no-op for everything above it.
 * Ranking it below `chromaprint` made it effective against blackframe alone,
 * which is precisely the "method-agnostic" property it exists to provide.
 *
 * It stays BELOW `chapter-title` on purpose: an authored "Credits" chapter is
 * direct evidence about this episode, and a genuinely long finale credit roll
 * must not be overridden by twelve ordinary siblings.
 *
 * `anime-synth` only ever produces `Preview`, derived from an already-resolved
 * Outro end. It sits below `chapter-title` because a real authored "Next
 * episode" chapter is direct evidence and the synthesis is an inference from
 * one; its position relative to `chromaprint` is academic, as chromaprint
 * produces no Previews.
 *
 * `stale-manual` is deliberately unrankable — see NON_RESOLVING_METHODS.
 */
export const METHOD_RANK: Record<DetectionMethod, number> = {
    manual: 0,
    'chapter-title': 10,
    cohort: 15,
    chromaprint: 20,
    'anime-synth': 25,
    'chapter-mark': 40,
    blackframe: 50,
    'stale-manual': Number.POSITIVE_INFINITY,
};

/**
 * Methods that are stored as evidence but must never be materialized.
 *
 * `stale-manual` is a manual override whose file changed underneath it: the
 * human answer is real but its timings refer to a different encode. It stays in
 * the candidates table so an operator can re-confirm it in admin, and it is
 * filtered here EXPLICITLY rather than by leaning on its infinite rank — a
 * sentinel that only works because nothing sorts after it is one refactor away
 * from silently resolving.
 */
export const NON_RESOLVING_METHODS: ReadonlySet<DetectionMethod> = new Set<DetectionMethod>([
    'stale-manual',
]);

export function isResolvableMethod(method: DetectionMethod): boolean {
    return !NON_RESOLVING_METHODS.has(method);
}

/**
 * Applied when a detector did not state one. Mirrors the column default on
 * `media_segment_candidates.confidence`, so a row that round-tripped through
 * the database and one that never left memory rank identically.
 */
const DEFAULT_CONFIDENCE = 0.5;

/**
 * Which end of the file a type is anchored to. Used only as a tie-break: two
 * candidates that agree on method and confidence are separated by which is
 * closer to the boundary the type is about.
 *
 * `Preview` is tail-anchored (it is the post-credits tail); `Recap` and
 * `Commercial` are treated as head-anchored, which for `Commercial` is
 * arbitrary but harmless — there is exactly one producer for it.
 */
const TAIL_ANCHORED: ReadonlySet<DetectedSegmentType> = new Set<DetectedSegmentType>([
    'Outro',
    'Preview',
]);

/**
 * Must stay assignable to `PlausibilityContext` — the resolver hands it straight
 * to the gate. Declared here rather than re-exported so the resolver's own
 * inputs are readable at a glance.
 */
export interface ResolveContext {
    durationSeconds: number;
    isMovie: boolean;
}

/**
 * Total ordering over candidates of the SAME type, best first.
 *
 * Exported because the cohort layer picks each episode's best Outro with the
 * identical ordering; a second comparator would be a second precedence table
 * that drifts from this one.
 *
 * Note that ranks are unique per method, so the rank comparison already fully
 * separates different methods — confidence and proximity only ever decide
 * between candidates the same detector emitted more than once.
 */
export function compareCandidates(a: DetectedSegment, b: DetectedSegment): number {
    const rankA = METHOD_RANK[a.method];
    const rankB = METHOD_RANK[b.method];
    // Compared rather than subtracted: Infinity - Infinity is NaN, which would
    // make the sort silently non-deterministic.
    if (rankA !== rankB) return rankA < rankB ? -1 : 1;

    const confA = a.confidence ?? DEFAULT_CONFIDENCE;
    const confB = b.confidence ?? DEFAULT_CONFIDENCE;
    if (confA !== confB) return confB - confA;

    if (TAIL_ANCHORED.has(a.type)) {
        // Nearest EOF wins, and on an equal end the later start does — which is
        // the shorter, more conservative credits estimate. Skipping too little
        // costs the viewer a button press; skipping too much costs them the
        // scene this whole redesign exists because they lost.
        if (a.endTime !== b.endTime) return b.endTime - a.endTime;
        return b.startTime - a.startTime;
    }
    if (a.startTime !== b.startTime) return a.startTime - b.startTime;
    return a.endTime - b.endTime;
}

/**
 * The single best candidate of `type`, or null when there is none. Non-resolving
 * methods are excluded here so every caller gets that filter for free.
 */
export function pickBestCandidate(
    candidates: DetectedSegment[],
    type: DetectedSegmentType,
): DetectedSegment | null {
    let best: DetectedSegment | null = null;
    for (const candidate of candidates) {
        if (candidate.type !== type) continue;
        if (!isResolvableMethod(candidate.method)) continue;
        if (best === null || compareCandidates(candidate, best) < 0) best = candidate;
    }
    return best;
}

/**
 * Materialization decision: at most one segment per type, chosen from the
 * evidence pool.
 *
 * `chapterMarks` is deliberately NOT an input. Snapping a boundary onto an
 * authored chapter mark happens at candidate-WRITE time, in the pass that
 * already probed the file, and its outcome is persisted on the candidate
 * (`snappedToChapter`). The resolver also runs after the season chromaprint
 * pass, during cohort re-resolution, and during repair — none of those have
 * chapters in scope, and `episode_chapters` cannot substitute because the
 * scanner drops untitled marks (which is precisely the mark that carries the
 * right answer for the motivating Drifting Clouds episode). Keeping chapters out
 * keeps this function pure, cheap, and re-entrant.
 */
export function resolveSegments(
    candidates: DetectedSegment[],
    ctx: ResolveContext,
    plausibilityConfig: PlausibilityConfig,
    // Every discard, veto or fallback. Without it a dropped winner is
    // indistinguishable from a detector that never fired — the same blind spot
    // `filterPlausible` grew an onReject hook to close.
    onDiscard?: (
        segment: DetectedSegment,
        verdict: PlausibilityRejection,
        outcome: 'veto' | 'fallback',
    ) => void,
): DetectedSegment[] {
    const byType = new Map<DetectedSegmentType, DetectedSegment[]>();
    for (const candidate of candidates) {
        if (!isResolvableMethod(candidate.method)) continue;
        const bucket = byType.get(candidate.type);
        if (bucket) bucket.push(candidate);
        else byType.set(candidate.type, [candidate]);
    }

    const winners = new Map<DetectedSegmentType, DetectedSegment>();
    for (const [type, bucket] of byType) {
        // Re-gated even though candidates are gated at write time: config
        // thresholds move, cohort synthesis happens after the write gate, and
        // repair re-resolves rows written under an older config. Winning a rank
        // comparison must never launder an implausible answer.
        //
        // What a failure MEANS depends on the rule (see STRUCTURAL_RULES):
        //
        //   STRUCTURAL — the segment cannot describe a real region of a real
        //     file. That impeaches the item, not the witness: every other
        //     candidate shares the same runtime, so they are equally suspect
        //     and the whole type drops. In practice they all fail anyway.
        //
        //   POLICY — "credits are not usually this long". Operator-tunable,
        //     known wrong on real content (which is why `manual` is exempt),
        //     and a statement about ONE candidate. Dropping the type here threw
        //     away a correct lower-ranked answer that was sitting right there:
        //     an over-long chromaprint Outro would suppress a good chapter mark
        //     and the episode shipped with no marker at all.
        //
        // Falling back cannot resurrect the window-edge-truncation bug: an
        // abstaining detector emits NO candidate, so a truncated answer is
        // never in this pool to fall back to. Every runner-up here already
        // cleared the same gate at write time.
        const ranked = [...bucket].sort(compareCandidates);
        for (const candidate of ranked) {
            const verdict = checkPlausibility(candidate, ctx, plausibilityConfig);
            if (verdict.ok) {
                winners.set(type, candidate);
                break;
            }
            if (isStructuralRejection(verdict)) {
                onDiscard?.(candidate, verdict, 'veto');
                break;
            }
            onDiscard?.(candidate, verdict, 'fallback');
        }
    }

    resolveIntroOutroOverlap(winners);

    // Ordered the way the read path serves them (`start_time ASC`), so a
    // resolver result and a database round-trip are directly comparable.
    return [...winners.values()].sort((a, b) => a.startTime - b.startTime);
}

/**
 * An Intro and an Outro cannot both be right if they overlap. Drop the
 * lower-ranked one; on equal rank keep the Outro, because a mis-sized Intro is
 * the more common error and losing the Outro costs the skip-credits button.
 */
function resolveIntroOutroOverlap(winners: Map<DetectedSegmentType, DetectedSegment>): void {
    const intro = winners.get('Intro');
    const outro = winners.get('Outro');
    if (!intro || !outro) return;
    if (intro.endTime <= outro.startTime || outro.endTime <= intro.startTime) return;

    if (METHOD_RANK[intro.method] < METHOD_RANK[outro.method]) winners.delete('Outro');
    else winners.delete('Intro');
}
