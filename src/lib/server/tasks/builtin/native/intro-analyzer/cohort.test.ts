// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * cohort.test.ts — season reconciliation.
 *
 * The centrepiece fixture is the real Drifting Clouds season 3 shape: twelve
 * episodes whose credits measure 44-56 s, and S03E12 (file duration 2832.672 s)
 * whose blackframe walk ran to the edge of its search window and reported 200 s
 * of credits starting at 2632.672. The mkv's untitled chapter mark puts the true
 * boundary at 2789.412. The cohort layer must never leave that 200 s answer
 * standing, whether or not the chapter mark is in the pool.
 */

import { describe, it, expect } from 'vitest';
import {
    reconcileSeasonOutros,
    type CohortConfig,
    type CohortEpisode,
    type CohortOutcome,
} from './cohort.js';
import type { DetectedSegment } from './types.js';

const CONFIG: CohortConfig = {
    bandLo: 0.5,
    bandHi: 2.0,
    minSupport: 3,
    minSegmentDuration: 15,
};

const BB_S03E12_DURATION = 2832.672;
const BB_S03E12_TRUE_CREDITS_START = 2789.412;
const BB_S03E12_BLACKFRAME_START = 2632.672;

function outro(
    startTime: number,
    endTime: number,
    method: DetectedSegment['method'],
    confidence?: number,
): DetectedSegment {
    return { type: 'Outro', startTime, endTime, method, confidence };
}

/** Durations and credits lengths for the twelve well-behaved siblings. */
const SIBLINGS: ReadonlyArray<{ id: string; duration: number; credits: number }> = [
    { id: 'S03E01', duration: 2884.4, credits: 44 },
    { id: 'S03E02', duration: 2751.3, credits: 48 },
    { id: 'S03E03', duration: 2769.1, credits: 45 },
    { id: 'S03E04', duration: 2812.9, credits: 47 },
    { id: 'S03E05', duration: 2790.5, credits: 44 },
    { id: 'S03E06', duration: 2745.8, credits: 46 },
    { id: 'S03E07', duration: 2831.2, credits: 48 },
    { id: 'S03E08', duration: 2760.4, credits: 44 },
    { id: 'S03E09', duration: 2803.6, credits: 56 },
    { id: 'S03E10', duration: 2778.9, credits: 45 },
    { id: 'S03E11', duration: 2820.3, credits: 47 },
    { id: 'S03E13', duration: 2941.7, credits: 46 },
];

function breakingBadSeason(brokenEpisodeCandidates: DetectedSegment[]): CohortEpisode[] {
    const season: CohortEpisode[] = SIBLINGS.map((sibling) => ({
        episodeId: sibling.id,
        durationSeconds: sibling.duration,
        candidates: [
            outro(sibling.duration - sibling.credits, sibling.duration, 'chromaprint', 0.8),
        ],
    }));
    season.splice(11, 0, {
        episodeId: 'S03E12',
        durationSeconds: BB_S03E12_DURATION,
        candidates: brokenEpisodeCandidates,
    });
    return season;
}

const BB_BLACKFRAME = outro(BB_S03E12_BLACKFRAME_START, BB_S03E12_DURATION, 'blackframe', 0.35);
const BB_CHAPTER_MARK = outro(
    BB_S03E12_TRUE_CREDITS_START,
    BB_S03E12_DURATION,
    'chapter-mark',
    0.6,
);

function outcomeFor(outcomes: CohortOutcome[], episodeId: string): CohortOutcome {
    const found = outcomes.find((entry) => entry.episodeId === episodeId);
    if (!found) throw new Error(`no outcome for ${episodeId}`);
    return found;
}

describe('reconcileSeasonOutros — Drifting Clouds season 3', () => {
    it('synthesizes the consensus length over the 200 s blackframe truncation', () => {
        const outcomes = reconcileSeasonOutros(breakingBadSeason([BB_BLACKFRAME]), CONFIG);
        const broken = outcomeFor(outcomes, 'S03E12');

        expect(broken.action).toBe('synthesized');
        expect(broken.segment).not.toBeNull();
        expect(broken.segment?.method).toBe('cohort');
        expect(broken.segment?.endTime).toBeCloseTo(BB_S03E12_DURATION, 3);
        // The season's consensus lands within a few seconds of the authored
        // chapter mark it never got to see — the whole point of the layer.
        expect(
            Math.abs((broken.segment?.startTime ?? 0) - BB_S03E12_TRUE_CREDITS_START),
        ).toBeLessThan(5);
        // Low confidence: any real in-band candidate on a later pass must win.
        expect(broken.segment?.confidence ?? 1).toBeLessThan(0.5);
    });

    it('has nothing to reconcile once the chapter mark outranks the truncation', () => {
        const outcomes = reconcileSeasonOutros(
            breakingBadSeason([BB_BLACKFRAME, BB_CHAPTER_MARK]),
            CONFIG,
        );
        const broken = outcomeFor(outcomes, 'S03E12');

        // Precedence already picked the chapter mark, and 43.26 s is in band, so
        // the cohort layer leaves it alone — kept, but kept on the RIGHT answer.
        expect(broken.action).toBe('kept');
        expect(broken.segment?.method).toBe('chapter-mark');
        expect(broken.segment?.startTime).toBeCloseTo(BB_S03E12_TRUE_CREDITS_START, 3);
    });

    it('replaces an out-of-band winner with the episode’s own in-band candidate', () => {
        // A bad chromaprint match outranks the chapter mark, so precedence alone
        // cannot save this episode — only the season can tell that 200 s is wrong.
        const badChromaprint = outro(
            BB_S03E12_BLACKFRAME_START,
            BB_S03E12_DURATION,
            'chromaprint',
            0.7,
        );
        const outcomes = reconcileSeasonOutros(
            breakingBadSeason([badChromaprint, BB_CHAPTER_MARK]),
            CONFIG,
        );
        const broken = outcomeFor(outcomes, 'S03E12');

        expect(broken.action).toBe('replaced');
        expect(broken.segment?.method).toBe('chapter-mark');
        expect(broken.segment?.startTime).toBeCloseTo(BB_S03E12_TRUE_CREDITS_START, 3);
    });

    it('never resolves S03E12 to the 200 s answer, whatever the pool contains', () => {
        const pools = [
            [BB_BLACKFRAME],
            [BB_BLACKFRAME, BB_CHAPTER_MARK],
            [outro(BB_S03E12_BLACKFRAME_START, BB_S03E12_DURATION, 'chromaprint', 0.7)],
        ];
        for (const pool of pools) {
            const broken = outcomeFor(
                reconcileSeasonOutros(breakingBadSeason(pool), CONFIG),
                'S03E12',
            );
            const segment = broken.segment;
            expect(segment).not.toBeNull();
            expect(segment?.startTime ?? 0).not.toBeCloseTo(BB_S03E12_BLACKFRAME_START, 3);
            expect((segment?.endTime ?? 0) - (segment?.startTime ?? 0)).toBeLessThan(92);
        }
    });

    it('leaves every well-behaved sibling untouched', () => {
        const outcomes = reconcileSeasonOutros(breakingBadSeason([BB_BLACKFRAME]), CONFIG);
        for (const sibling of SIBLINGS) {
            const outcome = outcomeFor(outcomes, sibling.id);
            expect(outcome.action).toBe('kept');
            expect(outcome.segment?.startTime).toBeCloseTo(sibling.duration - sibling.credits, 3);
        }
    });

    it('returns exactly one outcome per input episode, in input order', () => {
        const season = breakingBadSeason([BB_BLACKFRAME]);
        const outcomes = reconcileSeasonOutros(season, CONFIG);
        expect(outcomes.map((entry) => entry.episodeId)).toEqual(
            season.map((episode) => episode.episodeId),
        );
    });
});

describe('reconcileSeasonOutros — consensus support', () => {
    it('keeps everything when too few episodes contribute', () => {
        // Two witnesses are not a season. The caller is expected to skip this
        // layer outright for a partial pool; when it does run, an unsupported
        // consensus must not rewrite anything — including the bad row.
        const episodes: CohortEpisode[] = [
            {
                episodeId: 'a',
                durationSeconds: 1400,
                candidates: [outro(1355, 1400, 'chromaprint')],
            },
            {
                episodeId: 'b',
                durationSeconds: BB_S03E12_DURATION,
                candidates: [BB_BLACKFRAME],
            },
        ];

        const outcomes = reconcileSeasonOutros(episodes, CONFIG);
        expect(outcomes.every((entry) => entry.action === 'kept')).toBe(true);
        expect(outcomeFor(outcomes, 'b').segment?.startTime).toBe(BB_S03E12_BLACKFRAME_START);
    });

    it('treats an episode with no candidates as kept-empty rather than synthesizing for it', () => {
        const season = breakingBadSeason([]);
        const outcome = outcomeFor(reconcileSeasonOutros(season, CONFIG), 'S03E12');
        expect(outcome.action).toBe('kept');
        expect(outcome.segment).toBeNull();
    });
});

describe('reconcileSeasonOutros — weighting', () => {
    it('lets one high-ranked method outvote two blackframes', () => {
        const episodes: CohortEpisode[] = [
            { episodeId: 'a', durationSeconds: 1400, candidates: [outro(1360, 1400, 'manual')] },
            {
                episodeId: 'b',
                durationSeconds: 1400,
                candidates: [outro(1300, 1400, 'blackframe')],
            },
            {
                episodeId: 'c',
                durationSeconds: 1400,
                candidates: [outro(1295, 1400, 'blackframe')],
            },
        ];

        const outcomes = reconcileSeasonOutros(episodes, CONFIG);
        // An unweighted median would be 100 s and both blackframe episodes would
        // stand; the manual answer carries enough weight to make 40 s consensus.
        expect(outcomeFor(outcomes, 'a').action).toBe('kept');
        expect(outcomeFor(outcomes, 'b').action).toBe('synthesized');
        expect(outcomeFor(outcomes, 'b').segment?.startTime).toBeCloseTo(1360, 6);
    });

    it('averages the two middle samples when weight splits exactly in half', () => {
        // Only a and b contribute: c's 5 s winner is below minSegmentDuration and
        // informs nothing — but it is still judged, which is how the resulting
        // 45 s consensus becomes observable.
        const episodes: CohortEpisode[] = [
            {
                episodeId: 'a',
                durationSeconds: 1400,
                candidates: [outro(1360, 1400, 'chromaprint')],
            },
            {
                episodeId: 'b',
                durationSeconds: 1400,
                candidates: [outro(1350, 1400, 'chromaprint')],
            },
            {
                episodeId: 'c',
                durationSeconds: 1400,
                candidates: [outro(1395, 1400, 'chapter-mark')],
            },
        ];

        const outcomes = reconcileSeasonOutros(episodes, { ...CONFIG, minSupport: 2 });
        expect(outcomeFor(outcomes, 'c').action).toBe('synthesized');
        expect(outcomeFor(outcomes, 'c').segment?.startTime).toBeCloseTo(1355, 6);
    });
});

describe('reconcileSeasonOutros — blanking', () => {
    it('blanks an out-of-band episode whose duration is unknown', () => {
        const season = breakingBadSeason([BB_BLACKFRAME]);
        const broken = season[11];
        broken.durationSeconds = null;

        const outcome = outcomeFor(reconcileSeasonOutros(season, CONFIG), 'S03E12');
        expect(outcome.action).toBe('blanked');
        expect(outcome.segment).toBeNull();
    });
});
