// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Real-media regression suite for the Outro detectors.
 *
 * ## Why fixtures from real files
 *
 * These detectors are luma and chapter heuristics; their only meaningful oracle
 * is "does the marker land where the credits actually start". Hand-written
 * fixtures tend to contain exactly ONE qualifying dark region, which cannot
 * exercise the failure modes that actually bite on real media:
 *
 *   - an earlier, unrelated fade-to-black outranking the true credits run
 *   - a returned segment shorter than the detector's own configured minimum
 *   - a non-English chapter label reading as "semantically named"
 *
 * Each fixture is the detector's EXACT ffmpeg input captured from a real file
 * by `scripts/analyzer/capture-outro-fixture.sh`, plus the operator-verified
 * credits start. Add a new one by running that script on a box with the media
 * and dropping the JSON in `__fixtures__/`.
 *
 * ## Tolerance
 *
 * `TOLERANCE_SEC` is deliberately loose. The sampler runs at 5fps over a 4s
 * bucket grid, so the detector cannot resolve a boundary more precisely than a
 * few seconds, and a human reading a timestamp off a player is itself only
 * second-accurate. These assertions exist to catch "minutes wrong" and "abstained
 * entirely", which is the failure class that reaches users — not to pin frames.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const { mockDetectBlackFrames } = vi.hoisted(() => ({ mockDetectBlackFrames: vi.fn() }));
vi.mock('$lib/server/utils/ffmpeg-analysis.js', () => ({
    detectBlackFrames: mockDetectBlackFrames,
}));

import { analyzeBlackFrames, DEFAULT_BLACKFRAME_CONFIG } from './blackframe.js';
import type { BlackFrameConfig } from './blackframe.js';
import { findLastMarkOutro, DEFAULT_CHAPTER_CONFIG } from './chapter.js';
import { resolveSegments, METHOD_RANK } from './resolve.js';
import { filterPlausible } from './plausibility.js';
import type { ChapterInput, DetectedSegment } from './types.js';

const TOLERANCE_SEC = 12;

interface OutroFixture {
    file: string;
    durationSec: number;
    searchStartSec: number;
    expectedOutroStartSec: number | null;
    /** Verified to have NO credits sequence — any detection is a false positive. */
    expectNoOutro?: boolean;
    capture: { minCreditsDuration: number; maxSearchDistance: number };
    chapters: {
        chapters: Array<{ start_time: string; end_time: string; tags?: { title?: string } }>;
    };
    frames: Array<{ t: number; pct: number }>;
}

const fixtureDir = resolve(fileURLToPath(new URL('.', import.meta.url)), '__fixtures__');
const fixtures: Array<{ name: string; data: OutroFixture }> = readdirSync(fixtureDir)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => ({
        name: f.replace(/\.json$/, ''),
        data: JSON.parse(readFileSync(resolve(fixtureDir, f), 'utf8')) as OutroFixture,
    }));

function configFor(fx: OutroFixture): BlackFrameConfig {
    return {
        ...DEFAULT_BLACKFRAME_CONFIG,
        minCreditsDuration: fx.capture.minCreditsDuration,
        maxSearchDistance: fx.capture.maxSearchDistance,
    };
}

function chapterInputs(fx: OutroFixture): ChapterInput[] {
    return (fx.chapters.chapters ?? []).map((c, index) => ({
        index,
        title: c.tags?.title ?? null,
        startTimeMs: parseFloat(c.start_time) * 1000,
        endTimeMs: parseFloat(c.end_time) * 1000,
    }));
}

const mmss = (s: number): string =>
    `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Mirrors buildPlausibilityConfig() for episode defaults. */
const PLAUSIBILITY = {
    minSegmentDuration: 15,
    maxIntroDuration: 120,
    introWindowMaxSec: 600,
    maxPlausibleCreditsDuration: 150,
    maxPlausibleMovieCreditsDuration: 900,
    outroMinStartFraction: 0.8,
};

/**
 * Everything the VISUAL detector group contributes for one file, run through
 * the same plausibility gate the analyzer applies before storing candidates.
 */
async function visualCandidates(fx: OutroFixture): Promise<DetectedSegment[]> {
    mockDetectBlackFrames.mockResolvedValue(
        fx.frames.map((f) => ({ time: f.t, blackPercentage: f.pct })),
    );
    const out: DetectedSegment[] = [];
    const bf = await analyzeBlackFrames(fx.file, fx.durationSec, configFor(fx));
    if (bf.kind === 'segment') out.push(bf.segment);
    const ch = findLastMarkOutro(chapterInputs(fx), fx.durationSec * 1000, {
        ...DEFAULT_CHAPTER_CONFIG,
        maxCreditsDuration: fx.capture.maxSearchDistance,
    });
    if (ch) out.push(ch);
    return filterPlausible(out, { durationSeconds: fx.durationSec, isMovie: false }, PLAUSIBILITY);
}

describe('Outro detection against real media fixtures', () => {
    beforeEach(() => {
        mockDetectBlackFrames.mockReset();
    });

    it('has at least one fixture (an empty suite would pass vacuously)', () => {
        expect(fixtures.length).toBeGreaterThan(0);
    });

    // ── Negative fixtures ────────────────────────────────────────────────────
    //
    // A false positive is worse than an abstention: it puts a skip-credits
    // button in the middle of the episode. Files verified to have no credits
    // sequence assert the detectors stay silent.
    for (const { name, data } of fixtures.filter((f) => f.data.expectNoOutro)) {
        it(`${name}: has no credits, so nothing may be detected`, async () => {
            const resolved = resolveSegments(
                await visualCandidates(data),
                { durationSeconds: data.durationSec, isMovie: false },
                PLAUSIBILITY,
            );
            const outro = resolved.find((s) => s.type === 'Outro');
            expect(
                outro,
                outro
                    ? `false positive: '${outro.method}' claimed credits at ` +
                          `${mmss(outro.startTime)} on a file that has none`
                    : '',
            ).toBeUndefined();
        });
    }

    for (const { name, data } of fixtures) {
        // A fixture without a verified timestamp is an observation, not an
        // assertion — capture it, but never let it silently "pass".
        const maybe = data.expectedOutroStartSec === null ? it.skip : it;

        // Blackframe is ALLOWED to abstain — it is the lowest-ranked detector and
        // a luma heuristic cannot tell a credit roll from a dark scene, so
        // "no answer" is a designed outcome (the player falls back to its fixed
        // end-of-file prompt). What it must never do is answer WRONGLY, because a
        // confident bad boundary outranks nothing and misplaces the skip button.
        maybe(`${name}: blackframe is either right or silent, never wrong`, async () => {
            mockDetectBlackFrames.mockResolvedValue(
                data.frames.map((f) => ({ time: f.t, blackPercentage: f.pct })),
            );

            const outcome = await analyzeBlackFrames(data.file, data.durationSec, configFor(data));
            if (outcome.kind !== 'segment') return;

            const got = outcome.segment.startTime;
            const expected = data.expectedOutroStartSec!;
            expect(
                Math.abs(got - expected),
                `detected ${mmss(got)} (${got.toFixed(1)}s), expected ${mmss(expected)} (${expected}s)`,
            ).toBeLessThanOrEqual(TOLERANCE_SEC);
        });

        maybe(`${name}: chapter marks land on the real credits start`, () => {
            const chapters = chapterInputs(data);
            if (chapters.length === 0) return;
            const expected = data.expectedOutroStartSec!;

            const outro = findLastMarkOutro(chapters, data.durationSec * 1000, {
                ...DEFAULT_CHAPTER_CONFIG,
                maxCreditsDuration: data.capture.maxSearchDistance,
            });

            if (!outro) {
                throw new Error(
                    `no chapter Outro, but credits start at ${mmss(expected)} and the file is ` +
                        `chaptered — a trailing near-EOF marker must not veto the real boundary`,
                );
            }
            expect(
                Math.abs(outro.startTime - expected),
                `chapter mark gave ${mmss(outro.startTime)}, expected ${mmss(expected)}`,
            ).toBeLessThanOrEqual(TOLERANCE_SEC);
        });

        maybe(`${name}: at least one detector finds the credits`, async () => {
            const expected = data.expectedOutroStartSec!;
            mockDetectBlackFrames.mockResolvedValue(
                data.frames.map((f) => ({ time: f.t, blackPercentage: f.pct })),
            );
            const bf = await analyzeBlackFrames(data.file, data.durationSec, configFor(data));
            const ch = findLastMarkOutro(chapterInputs(data), data.durationSec * 1000, {
                ...DEFAULT_CHAPTER_CONFIG,
                maxCreditsDuration: data.capture.maxSearchDistance,
            });
            const hits = [
                bf.kind === 'segment' ? bf.segment.startTime : null,
                ch ? ch.startTime : null,
            ].filter((v): v is number => v !== null && Math.abs(v - expected) <= TOLERANCE_SEC);
            expect(
                hits.length,
                `no detector landed within ${TOLERANCE_SEC}s of ${mmss(expected)} — the episode ` +
                    `ships with no Outro marker at all`,
            ).toBeGreaterThan(0);
        });

        // The detectors agreeing is not the same as the PLAYER being right. The
        // resolver picks one winner per type by METHOD_RANK, so this is the
        // assertion that actually corresponds to what a viewer sees.
        maybe(`${name}: the resolved Outro — what the player shows — is correct`, async () => {
            const expected = data.expectedOutroStartSec!;
            const resolved = resolveSegments(
                await visualCandidates(data),
                { durationSeconds: data.durationSec, isMovie: false },
                PLAUSIBILITY,
            );
            const outro = resolved.find((s) => s.type === 'Outro');
            if (!outro) {
                throw new Error(
                    `resolver produced no Outro, so the player falls back to its fixed ` +
                        `end-of-file prompt — credits start at ${mmss(expected)}`,
                );
            }
            expect(
                Math.abs(outro.startTime - expected),
                `resolved ${mmss(outro.startTime)} via '${outro.method}', expected ${mmss(expected)}`,
            ).toBeLessThanOrEqual(TOLERANCE_SEC);
        });

        maybe(`${name}: never reports a segment below its own minimum length`, async () => {
            mockDetectBlackFrames.mockResolvedValue(
                data.frames.map((f) => ({ time: f.t, blackPercentage: f.pct })),
            );
            const cfg = configFor(data);
            const outcome = await analyzeBlackFrames(data.file, data.durationSec, cfg);
            if (outcome.kind !== 'segment') return;

            // The length that matters is the one actually RETURNED, not the raw
            // backward-walk run the detector measured internally.
            const length = outcome.segment.endTime - outcome.segment.startTime;
            expect(
                length,
                `returned a ${length.toFixed(1)}s Outro against a ${cfg.minCreditsDuration}s minimum`,
            ).toBeGreaterThanOrEqual(cfg.minCreditsDuration);
        });
    }

    // ── Rank precedence ──────────────────────────────────────────────────────
    //
    // The fixtures above verify the VISUAL detectors. In production the acoustic
    // group also contributes Outro candidates, and it OUTRANKS the chapter mark
    // those fixtures rely on:
    //
    //     manual 0 < chapter-title 10 < cohort 15 < chromaprint 20
    //             < chapter-mark 40 < blackframe 50
    //
    // So a verified chapter-mark answer is NOT necessarily what the player
    // shows. That is deliberate — a season-wide acoustic consensus is better
    // evidence than an untitled mark — but it means these fixtures cannot claim
    // to validate the materialized result once fingerprinting has run. Pin the
    // ordering so the claim stays honest and a silent re-rank is caught.
    it('acoustic evidence outranks the chapter mark these fixtures verify', () => {
        expect(METHOD_RANK.cohort).toBeLessThan(METHOD_RANK['chapter-mark']);
        expect(METHOD_RANK.chromaprint).toBeLessThan(METHOD_RANK['chapter-mark']);
        expect(METHOD_RANK['chapter-mark']).toBeLessThan(METHOD_RANK.blackframe);
        expect(METHOD_RANK.manual).toBeLessThan(METHOD_RANK['chapter-title']);
    });

    // knight-s01e01's chapter mark is correct at 39:47 (2388s). Both cases below
    // use that real geometry.
    const KNIGHT_DURATION = 2515.488;
    const knightChapterMark: DetectedSegment = {
        type: 'Outro',
        startTime: 2388,
        endTime: KNIGHT_DURATION,
        method: 'chapter-mark',
        confidence: 0.6,
    };

    it('a plausible acoustic candidate displaces the verified chapter mark', () => {
        // Rank alone decides. Whether the acoustic answer is BETTER here is a
        // tuning question; that it wins is the contract, and it is why these
        // fixtures cannot claim to validate the materialized result on a library
        // where fingerprinting has run.
        const acoustic: DetectedSegment = {
            type: 'Outro',
            startTime: 2450,
            endTime: KNIGHT_DURATION,
            method: 'chromaprint',
            confidence: 0.5,
        };
        const resolved = resolveSegments(
            [knightChapterMark, acoustic],
            { durationSeconds: KNIGHT_DURATION, isMovie: false },
            PLAUSIBILITY,
        );
        const outro = resolved.find((s) => s.type === 'Outro');
        expect(outro?.method).toBe('chromaprint');
        expect(outro?.startTime).toBe(2450);
    });

    it('an IMPLAUSIBLE acoustic candidate no longer suppresses the chapter mark', () => {
        // This USED to drop the whole type: the rank winner was re-gated and
        // any failure abstained rather than deferring to the next candidate, so
        // a chromaprint answer overshooting maxPlausibleCreditsDuration took a
        // perfectly good chapter mark down with it and the episode shipped
        // unmarked.
        //
        // `outro-too-long` is a POLICY rule — operator-tunable and a claim about
        // that candidate, not the file — so the resolver now falls back. The
        // verified 39:47 mark survives.
        const overshoot: DetectedSegment = {
            type: 'Outro',
            startTime: 2298, // 217s of credits, past the 150s plausible bound
            endTime: KNIGHT_DURATION,
            method: 'chromaprint',
            confidence: 0.5,
        };
        const resolved = resolveSegments(
            [knightChapterMark, overshoot],
            { durationSeconds: KNIGHT_DURATION, isMovie: false },
            PLAUSIBILITY,
        );
        const outro = resolved.find((s) => s.type === 'Outro');
        expect(outro?.method).toBe('chapter-mark');
        expect(outro?.startTime).toBe(2388);
    });
});
