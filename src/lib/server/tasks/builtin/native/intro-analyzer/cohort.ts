// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { METHOD_RANK, METHOD_RANK_STEP, isResolvableMethod, pickBestCandidate } from './resolve.js';
import type { DetectedSegment, DetectionMethod } from './types.js';

/**
 * Example names are fictional; production shapes and measurements are retained.
 * A season is the strongest evidence a single episode can borrow: end credits
 * are cut once and reused, so twelve episodes agreeing on ~46 s of credits are
 * a far better witness for the thirteenth than that episode's own worst
 * detector. Drifting Clouds S03E12 is the motivating case — twelve siblings agreed
 * on 44-48 s, the broken one claimed 200 s, and nothing in the per-episode
 * pipeline could tell that it was wrong.
 *
 * This module is method-agnostic: it reconciles whatever candidates exist,
 * regardless of which detector produced them.
 */

export interface CohortEpisode {
    episodeId: string;
    /** File duration in seconds. Null when unknown — such an episode can be judged but not synthesized for. */
    durationSeconds: number | null;
    candidates: DetectedSegment[];
}

export interface CohortConfig {
    /** Lower band edge as a multiple of consensus (0.5 = half the consensus length). */
    bandLo: number;
    /** Upper band edge as a multiple of consensus (2.0 = twice the consensus length). */
    bandHi: number;
    /** Minimum number of contributing episodes before a consensus is trusted at all. */
    minSupport: number;
    /** Shortest segment worth storing; also the floor a consensus must clear. */
    minSegmentDuration: number;
}

export interface CohortOutcome {
    episodeId: string;
    /**
     * - `kept`: the episode's own winner stands (this includes "it had none").
     * - `replaced`: an in-band sibling candidate of the SAME episode won instead.
     * - `synthesized`: no candidate was usable, so the consensus length was projected onto the file tail.
     * - `blanked`: the winner was rejected and nothing could stand in for it.
     */
    action: 'kept' | 'replaced' | 'synthesized' | 'blanked';
    segment: DetectedSegment | null;
}

/**
 * Confidence stamped on a synthesized segment. Deliberately below every real
 * detector's: it is an inference about THIS episode from OTHER episodes, so it
 * must lose to any genuine in-band candidate that shows up on a later pass.
 */
const SYNTHESIZED_CONFIDENCE = 0.45;

/**
 * Weight a method contributes to the consensus median, derived from the
 * resolver's rank table rather than a second hand-maintained list: best method
 * counts (worstRank / step) + 1 times as much as the worst, linearly. Blackframe
 * still counts — a season of blackframe-only episodes should still reach a
 * consensus — it just cannot outvote a handful of chromaprint matches.
 */
const WORST_RESOLVABLE_RANK = Math.max(
    ...(Object.keys(METHOD_RANK) as DetectionMethod[])
        .filter(isResolvableMethod)
        .map((method) => METHOD_RANK[method]),
);

function methodWeight(method: DetectionMethod): number {
    return (WORST_RESOLVABLE_RANK + METHOD_RANK_STEP - METHOD_RANK[method]) / METHOD_RANK_STEP;
}

interface WeightedSample {
    value: number;
    weight: number;
}

/**
 * Weighted median: the value at which cumulative weight crosses half the total.
 * With uniform weights this is the ordinary median, including the average-the-
 * middle-two behaviour on an even count.
 */
function weightedMedian(samples: WeightedSample[]): number {
    const sorted = [...samples].sort((a, b) => a.value - b.value);
    const total = sorted.reduce((sum, sample) => sum + sample.weight, 0);
    const half = total / 2;

    let cumulative = 0;
    for (let i = 0; i < sorted.length; i++) {
        cumulative += sorted[i].weight;
        if (cumulative > half) return sorted[i].value;
        if (cumulative === half) {
            const next = sorted[i + 1];
            return next ? (sorted[i].value + next.value) / 2 : sorted[i].value;
        }
    }
    return sorted[sorted.length - 1].value;
}

function segmentLength(segment: DetectedSegment): number {
    return segment.endTime - segment.startTime;
}

/**
 * Reconcile every episode's Outro against the season's consensus credits length.
 *
 * The caller decides WHETHER to run this at all. Skip it when the season's
 * candidate pool is partial — e.g. chromaprint threw mid-season — because a
 * consensus computed over a biased subset is worse than no consensus: it would
 * "correct" the episodes that were analysed properly. Those episodes stay
 * eligible and get reconciled on the next clean pass. The caller is also
 * responsible for re-running the plausibility gate on the returned segments and
 * for materializing them; nothing here touches the database.
 *
 * Every input episode gets exactly one outcome, in input order.
 */
export function reconcileSeasonOutros(
    episodes: CohortEpisode[],
    config: CohortConfig,
): CohortOutcome[] {
    const winners = new Map<string, DetectedSegment | null>();
    for (const episode of episodes) {
        winners.set(episode.episodeId, pickBestCandidate(episode.candidates, 'Outro'));
    }

    const samples: WeightedSample[] = [];
    for (const winner of winners.values()) {
        if (!winner) continue;
        const length = segmentLength(winner);
        // A sub-minimum winner is itself suspect, so it informs nothing. It is
        // still JUDGED below — it will simply fall under the band and be
        // replaced or synthesized like any other outlier.
        if (length < config.minSegmentDuration) continue;
        samples.push({ value: length, weight: methodWeight(winner.method) });
    }

    const keepEverything = (): CohortOutcome[] =>
        episodes.map((episode) => ({
            episodeId: episode.episodeId,
            action: 'kept' as const,
            segment: winners.get(episode.episodeId) ?? null,
        }));

    // Too few witnesses is not a weak consensus, it is no consensus. Leaving the
    // season untouched is the only honest outcome; a two-episode "median" would
    // happily rewrite a correct answer to match a wrong one.
    if (samples.length < config.minSupport) return keepEverything();

    const consensus = weightedMedian(samples);
    if (consensus < config.minSegmentDuration) return keepEverything();

    const lowerBound = consensus * config.bandLo;
    const upperBound = consensus * config.bandHi;
    const inBand = (segment: DetectedSegment): boolean => {
        const length = segmentLength(segment);
        return length >= lowerBound && length <= upperBound;
    };

    return episodes.map((episode) => {
        const winner = winners.get(episode.episodeId) ?? null;
        // No candidate at all is an abstention that already reached the right
        // conclusion; the cohort does not manufacture segments for episodes
        // nothing was detected on.
        if (!winner) return { episodeId: episode.episodeId, action: 'kept', segment: null };
        if (inBand(winner))
            return { episodeId: episode.episodeId, action: 'kept', segment: winner };

        // The episode's own evidence first: a chapter mark that lost the rank
        // comparison to a chromaprint match is still this file's own boundary,
        // which beats anything projected from its siblings.
        const alternative = pickBestCandidate(
            episode.candidates.filter((candidate) => candidate !== winner && inBand(candidate)),
            'Outro',
        );
        if (alternative) {
            return { episodeId: episode.episodeId, action: 'replaced', segment: alternative };
        }

        const duration = episode.durationSeconds;
        if (duration !== null && duration - consensus > 0) {
            return {
                episodeId: episode.episodeId,
                action: 'synthesized',
                segment: {
                    type: 'Outro',
                    startTime: duration - consensus,
                    endTime: duration,
                    method: 'cohort',
                    confidence: SYNTHESIZED_CONFIDENCE,
                },
            };
        }

        return { episodeId: episode.episodeId, action: 'blanked', segment: null };
    });
}
