// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    findNearestBeat,
    findNearestDownbeat,
    getCircleOfFifthsNeighbors,
    calculateCrossfadeDuration,
    calculatePlaybackRate,
    bpmGap,
    isBpmCompatible,
    areKeysCompatible,
    getDjCrossfadeBeats,
    computePhaseAlignedStart,
    determineCrossfadeStyle,
    getEffectiveIntroEndMs,
    computeBlendGains,
    BLEND_INCOMING_DELAY,
    resolveIncomingStartSec,
    clampBassSwapBeats,
    computeBeatIntervalCv,
    isOrganicTrack,
    ORGANIC_BEAT_CV_MIN,
    scaleCrossfadeBeatsForTrackLength,
    SHORT_TRACK_SEC,
    EXTENDED_TRACK_SEC,
    BASSSWAP_MIN_BEATS,
    BASSSWAP_LEAD_BUFFER_MS,
    computeBarPhase,
    BPM_NATIVE_RATE_MAX_GAP,
    BPM_WSOLA_MAX_GAP,
} from './beat-math';
import type { TrackAudioFeatures } from './beat-math';

describe('beat-math', () => {
    describe('findNearestBeat', () => {
        it('returns the timestamp unchanged for an empty grid', () => {
            expect(findNearestBeat([], 1234)).toBe(1234);
        });

        it('returns the only element for a single-element grid', () => {
            expect(findNearestBeat([500], 1000)).toBe(500);
        });

        it('returns an exact match when the time is on a beat', () => {
            expect(findNearestBeat([0, 500, 1000, 1500], 1000)).toBe(1000);
        });

        it('returns the closer beat when between two beats', () => {
            // 400ms is closer to 500 than to 0
            expect(findNearestBeat([0, 500, 1000], 400)).toBe(500);
        });

        it('returns the earlier beat when equidistant', () => {
            // 250ms is equidistant between 0 and 500; first found wins
            expect(findNearestBeat([0, 500, 1000], 250)).toBe(0);
        });

        it('returns the first beat when time is before the grid', () => {
            expect(findNearestBeat([500, 1000, 1500], 100)).toBe(500);
        });

        it('returns the last reachable beat when time is past the grid', () => {
            // The early-exit optimisation means it stops once diff increases;
            // for a sorted grid the nearest is the last element
            expect(findNearestBeat([0, 500, 1000], 2000)).toBe(1000);
        });
    });

    describe('findNearestDownbeat', () => {
        it('delegates to findNearestBeat', () => {
            expect(findNearestDownbeat([0, 2000, 4000], 2100)).toBe(2000);
        });

        it('returns timestamp unchanged for an empty downbeat list', () => {
            expect(findNearestDownbeat([], 500)).toBe(500);
        });
    });

    describe('getCircleOfFifthsNeighbors', () => {
        it('returns neighbors for C major (±1 step + relative minor)', () => {
            const neighbors = getCircleOfFifthsNeighbors('C');
            expect(neighbors).toContain('C');
            expect(neighbors).toContain('G'); // +1 step
            expect(neighbors).toContain('F'); // -1 step
            expect(neighbors).toContain('Am'); // relative minor
        });

        it('returns neighbors for Am (±1 step + relative major)', () => {
            const neighbors = getCircleOfFifthsNeighbors('Am');
            expect(neighbors).toContain('Am');
            expect(neighbors).toContain('Em'); // +1 step
            expect(neighbors).toContain('Dm'); // -1 step
            expect(neighbors).toContain('C'); // relative major
        });

        it('wraps around the circle correctly for F major', () => {
            const neighbors = getCircleOfFifthsNeighbors('F');
            expect(neighbors).toContain('C'); // +1 step (wraps)
            expect(neighbors).toContain('Bb'); // -1 step
        });

        it('returns only the key itself for an unknown key', () => {
            expect(getCircleOfFifthsNeighbors('X')).toEqual(['X']);
        });

        it('returns only the key itself for an empty string', () => {
            expect(getCircleOfFifthsNeighbors('')).toEqual(['']);
        });

        it('returns deduplicated results (no duplicates)', () => {
            const neighbors = getCircleOfFifthsNeighbors('C');
            const unique = [...new Set(neighbors)];
            expect(neighbors).toEqual(unique);
        });

        it('handles minor keys with # suffix (F#m)', () => {
            const neighbors = getCircleOfFifthsNeighbors('F#m');
            expect(neighbors).toContain('F#m');
            // F#m is at index 3 in CIRCLE_OF_FIFTHS_MINOR
            expect(neighbors).toContain('C#m'); // +1
            expect(neighbors).toContain('Bm'); // -1
        });
    });

    describe('calculateCrossfadeDuration', () => {
        it('calculates 8 beats at 120 BPM = 4000ms', () => {
            expect(calculateCrossfadeDuration(120, 8)).toBe(4000);
        });

        it('calculates 4 beats at 120 BPM = 2000ms', () => {
            expect(calculateCrossfadeDuration(120, 4)).toBe(2000);
        });

        it('calculates 8 beats at 60 BPM = 8000ms', () => {
            expect(calculateCrossfadeDuration(60, 8)).toBe(8000);
        });

        it('uses 8 beats as default', () => {
            expect(calculateCrossfadeDuration(120)).toBe(calculateCrossfadeDuration(120, 8));
        });

        it('paces an unknown (zero) BPM at an assumed 120 BPM', () => {
            expect(calculateCrossfadeDuration(0)).toBe(4000); // default 8 beats
            expect(calculateCrossfadeDuration(0, 4)).toBe(2000); // "no audio data" style
        });

        it('treats a negative BPM as unknown', () => {
            expect(calculateCrossfadeDuration(-10, 8)).toBe(4000);
        });

        it('rounds to nearest millisecond', () => {
            // 60000 / 130 * 8 = 3692.307... → rounds to 3692
            expect(calculateCrossfadeDuration(130, 8)).toBe(3692);
        });
    });

    describe('calculatePlaybackRate', () => {
        it('returns 1.0 for identical BPMs', () => {
            expect(calculatePlaybackRate(120, 120)).toBe(1.0);
        });

        it('returns correct ratio when target is higher', () => {
            expect(calculatePlaybackRate(100, 110)).toBeCloseTo(1.1);
        });

        it('returns correct ratio when target is lower', () => {
            expect(calculatePlaybackRate(120, 100)).toBeCloseTo(100 / 120);
        });

        it('returns 1 when source BPM is zero', () => {
            expect(calculatePlaybackRate(0, 120)).toBe(1);
        });

        it('returns 1 when target BPM is zero', () => {
            expect(calculatePlaybackRate(120, 0)).toBe(1);
        });

        it('returns 1 when both BPMs are zero', () => {
            expect(calculatePlaybackRate(0, 0)).toBe(1);
        });

        it('rate-matches a half-time reading at ~1x, never 2x', () => {
            expect(calculatePlaybackRate(75, 150)).toBe(1);
            expect(calculatePlaybackRate(300, 150)).toBe(1);
            expect(calculatePlaybackRate(72, 140)).toBeCloseTo(140 / 144);
        });
    });

    describe('bpmGap', () => {
        it('is the plain relative gap for nearby tempos', () => {
            expect(bpmGap(120, 108)).toBeCloseTo(120 / 108 - 1);
            expect(bpmGap(129, 152)).toBeCloseTo(1 - 129 / 152);
        });

        it('folds half/double-time before measuring', () => {
            expect(bpmGap(150, 75)).toBe(0);
            expect(bpmGap(75, 150)).toBe(0);
            expect(bpmGap(140, 72)).toBeCloseTo(Math.abs(1 - 140 / 144));
        });

        it('does not fold a genuinely different tempo', () => {
            // 140 vs 100: ×2 would be 200, further away — stays a 40% gap
            expect(bpmGap(140, 100)).toBeCloseTo(0.4);
        });

        it('does not treat a non-octave pair as half/double time', () => {
            // 130 ÷ 2 = 65 is nearer 80 than 130 is, but still 23% off — no fold
            expect(bpmGap(80, 130)).toBeCloseTo(1 - 80 / 130);
            expect(calculatePlaybackRate(130, 80)).toBeCloseTo(80 / 130);
        });

        it('returns null when either BPM is unknown or not finite', () => {
            expect(bpmGap(0, 120)).toBeNull();
            expect(bpmGap(120, 0)).toBeNull();
            expect(bpmGap(Infinity, 120)).toBeNull();
            expect(bpmGap(120, Number.NaN)).toBeNull();
        });
    });

    describe('isBpmCompatible', () => {
        it('returns true for identical BPMs', () => {
            expect(isBpmCompatible(120, 120)).toBe(true);
        });

        it('returns true within the default 8% tolerance', () => {
            // 120 * 1.08 = 129.6 → should be compatible
            expect(isBpmCompatible(120, 129)).toBe(true);
        });

        it('returns false just outside the default 8% tolerance', () => {
            // 120 * 1.09 = 130.8 → outside 8%
            expect(isBpmCompatible(120, 131)).toBe(false);
        });

        it('returns true within a custom tolerance', () => {
            expect(isBpmCompatible(100, 115, 0.15)).toBe(true);
        });

        it('returns false with a strict tolerance', () => {
            expect(isBpmCompatible(100, 105, 0.01)).toBe(false);
        });

        it('returns false when either BPM is zero', () => {
            expect(isBpmCompatible(0, 120)).toBe(false);
            expect(isBpmCompatible(120, 0)).toBe(false);
            expect(isBpmCompatible(0, 0)).toBe(false);
        });

        it('returns false for negative BPMs', () => {
            expect(isBpmCompatible(-120, 120)).toBe(false);
        });
    });

    describe('getDjCrossfadeBeats', () => {
        describe('with at least one BPM available', () => {
            it('returns 48 beats when both BPMs provided, no mood', () => {
                expect(getDjCrossfadeBeats(128, 130)).toBe(48);
            });

            it('returns 64 beats with chill mood', () => {
                expect(getDjCrossfadeBeats(128, 130, 'chill')).toBe(64);
            });

            it('returns 64 beats with ambient mood', () => {
                expect(getDjCrossfadeBeats(128, 130, 'ambient')).toBe(64);
            });

            it('returns 32 beats with energetic mood', () => {
                expect(getDjCrossfadeBeats(128, 130, 'energetic')).toBe(32);
            });

            it('returns 32 beats with party mood', () => {
                expect(getDjCrossfadeBeats(128, 130, 'party')).toBe(32);
            });

            it('returns 48 beats for incompatible BPMs (no gap check)', () => {
                expect(getDjCrossfadeBeats(120, 200)).toBe(48);
            });

            it('returns 32 beats for incompatible BPMs with energetic mood', () => {
                expect(getDjCrossfadeBeats(120, 200, 'energetic')).toBe(32);
            });

            it('returns 48 beats when only one BPM is provided', () => {
                expect(getDjCrossfadeBeats(128, undefined)).toBe(48);
            });

            it('returns 64 beats when only one BPM provided with chill mood', () => {
                expect(getDjCrossfadeBeats(undefined, 128, 'chill')).toBe(64);
            });
        });

        describe('no BPM data', () => {
            it('returns 4 beats when no BPM provided (short fade)', () => {
                expect(getDjCrossfadeBeats(undefined, undefined)).toBe(4);
            });

            it('returns 4 beats for chill mood without BPM', () => {
                expect(getDjCrossfadeBeats(undefined, undefined, 'chill')).toBe(4);
            });

            it('returns 4 beats for energetic mood without BPM', () => {
                expect(getDjCrossfadeBeats(undefined, undefined, 'energetic')).toBe(4);
            });
        });

        describe('DJ-style durations at typical BPMs', () => {
            it('at 140 BPM: 48 beats = ~20.6s', () => {
                const beats = getDjCrossfadeBeats(140, 142);
                const ms = calculateCrossfadeDuration(140, beats);
                expect(ms).toBeGreaterThan(20000);
                expect(ms).toBeLessThan(21000);
            });

            it('chill at 100 BPM: 64 beats = 38400ms', () => {
                const beats = getDjCrossfadeBeats(100, 102, 'chill');
                expect(calculateCrossfadeDuration(100, beats)).toBe(38400);
            });
        });
    });

    describe('areKeysCompatible', () => {
        it('returns true for the same key', () => {
            expect(areKeysCompatible('C', 'C')).toBe(true);
        });

        it('returns true for neighboring keys on the circle', () => {
            expect(areKeysCompatible('C', 'G')).toBe(true);
            expect(areKeysCompatible('C', 'F')).toBe(true);
        });

        it('returns true for relative minor/major', () => {
            expect(areKeysCompatible('C', 'Am')).toBe(true);
        });

        it('returns false for distant keys', () => {
            // Gb is 6 steps from C — not a neighbor
            expect(areKeysCompatible('C', 'Db')).toBe(false);
        });

        it('returns true when the first key is empty', () => {
            expect(areKeysCompatible('', 'C')).toBe(true);
        });

        it('returns true when the second key is empty', () => {
            expect(areKeysCompatible('C', '')).toBe(true);
        });

        it('returns true when both keys are empty', () => {
            expect(areKeysCompatible('', '')).toBe(true);
        });

        it('returns true for unknown keys (compatibility is assumed)', () => {
            expect(areKeysCompatible('X', 'C')).toBe(false); // 'X' neighbors = ['X'], 'C' not in it
            // Two unknown keys — second is not in neighbors of first
            expect(areKeysCompatible('X', 'Y')).toBe(false);
        });
    });

    describe('computePhaseAlignedStart', () => {
        it('measures the phase offset in real bars for a half-time incoming analysis', () => {
            // Outgoing 150 BPM: 1.6s bars, half-way through a bar at 0.8s.
            const outDownbeats = [0, 1.6, 3.2, 4.8, 6.4];
            // Incoming analysed at 75 BPM: its "bars" are two real bars (3.2s).
            const inDownbeats = [0, 3.2, 6.4, 9.6, 12.8];
            const result = computePhaseAlignedStart(0.8, outDownbeats, inDownbeats, 6.4, 75);
            // Half a REAL bar past the downbeat (6.4 + 0.8), not half of 3.2s.
            expect(result).toBeCloseTo(7.2);
        });

        // 120 BPM, 4/4 time → downbeat every 2.0s
        const outDownbeats = [0, 2, 4, 6, 8, 10, 12, 14, 16];
        const inDownbeats = [0, 2, 4, 6, 8, 10, 12, 14];

        it('aligns to downbeat when outgoing is on a downbeat', () => {
            // Outgoing at 6.0s = exactly on a downbeat, phase ≈ 0
            // Nearest incoming downbeat to 5.0 → 4.0 (distance 1, found first in sorted array)
            const result = computePhaseAlignedStart(6.0, outDownbeats, inDownbeats, 5.0, 120);
            expect(result).toBe(4.0); // nearest incoming downbeat
        });

        it('aligns to downbeat when outgoing is very close to downbeat', () => {
            // 6.05s is within 5% of the bar → snaps to downbeat
            const result = computePhaseAlignedStart(6.05, outDownbeats, inDownbeats, 5.0, 120);
            expect(result).toBe(4.0);
        });

        it('offsets by bar phase when outgoing is mid-bar', () => {
            // Outgoing at 7.0s = exactly mid-bar (between downbeats 6.0 and 8.0)
            // barPhase = (7 - 6) / (8 - 6) = 0.5
            // Nearest incoming downbeat to 5.0 → 4.0 or 6.0
            // inBarDuration = 2.0
            // Result = nearestDownbeat + 0.5 * 2.0 = 6.0 + 1.0 = 7.0 (or 4.0 + 1.0 = 5.0)
            const result = computePhaseAlignedStart(7.0, outDownbeats, inDownbeats, 5.0, 120);
            // Nearest incoming downbeat to 5.0 is 4.0 or 6.0 (4.0 is closer)
            // 4.0 + 0.5 * 2.0 = 5.0
            expect(result).toBeCloseTo(5.0, 1);
        });

        it('returns desired start when incoming has no downbeats', () => {
            const result = computePhaseAlignedStart(6.0, outDownbeats, [], 5.0, 120);
            expect(result).toBe(5.0);
        });

        it('snaps to incoming downbeat when outgoing has too few downbeats', () => {
            // Only 1 outgoing downbeat → no bar duration calculable
            const result = computePhaseAlignedStart(6.0, [4.0], inDownbeats, 5.0, 120);
            // Nearest incoming downbeat to 5.0 → 4.0 or 6.0
            expect(result).toBe(4.0); // 4.0 is closer to 5.0 than 6.0
        });

        it('handles quarter-bar phase offset correctly', () => {
            // Outgoing at 6.5s → barPhase = (6.5 - 6) / (8 - 6) = 0.25
            // Nearest incoming downbeat to 5.0 → 4.0
            // Result = 4.0 + 0.25 * 2.0 = 4.5
            const result = computePhaseAlignedStart(6.5, outDownbeats, inDownbeats, 5.0, 120);
            expect(result).toBeCloseTo(4.5, 1);
        });

        it('works with different BPMs between tracks', () => {
            // Incoming at 130 BPM → downbeats every ~1.846s
            const inFast = [0, 1.846, 3.692, 5.538, 7.384, 9.231];
            // Outgoing at 7.0s, mid-bar → phase = 0.5
            const result = computePhaseAlignedStart(7.0, outDownbeats, inFast, 5.0, 130);
            // Nearest incoming downbeat to 5.0 → 5.538
            // inBarDuration = 7.384 - 5.538 = 1.846
            // Result = 5.538 + 0.5 * 1.846 = 6.461
            expect(result).toBeCloseTo(6.461, 1);
        });

        it('wraps phase correctly when outgoing is past last downbeat (outro)', () => {
            // Outgoing at 18.5s, last downbeats are 14 and 16
            // Raw phase = (18.5 - 14) / 2 = 2.25, wrapped = 0.25
            // Nearest incoming downbeat to 5.0 → 4.0
            // Result = 4.0 + 0.25 * 2.0 = 4.5
            const result = computePhaseAlignedStart(18.5, outDownbeats, inDownbeats, 5.0, 120);
            expect(result).toBeCloseTo(4.5, 2);
        });

        it('snaps to downbeat when past last downbeat with phase wrapping to ~0', () => {
            // Outgoing at 18.0s = exactly 1 bar past last downbeat (16)
            // Raw phase = (18 - 14) / 2 = 2.0, wrapped = 0.0 → < 0.05
            // Should snap to incoming downbeat
            const result = computePhaseAlignedStart(18.0, outDownbeats, inDownbeats, 5.0, 120);
            expect(result).toBe(4.0);
        });

        it('snaps to downbeat when near end of bar (phase > 0.95)', () => {
            // Outgoing at 7.95s → barPhase = (7.95 - 6) / (8 - 6) = 0.975 → > 0.95
            const result = computePhaseAlignedStart(7.95, outDownbeats, inDownbeats, 5.0, 120);
            // Should snap to downbeat, not offset
            expect(result).toBe(4.0); // nearest incoming downbeat to 5.0
        });
    });

    describe('getEffectiveIntroEndMs', () => {
        it('returns dj_introEndMs when present (prefers DJ intro over normal intro)', () => {
            expect(
                getEffectiveIntroEndMs({
                    dj_introEndMs: 64000,
                    introEndMs: 8000,
                }),
            ).toBe(64000);
        });

        it('falls back to introEndMs when dj_introEndMs is absent', () => {
            expect(getEffectiveIntroEndMs({ introEndMs: 8000 })).toBe(8000);
        });

        it('returns 0 when both are absent', () => {
            expect(getEffectiveIntroEndMs({})).toBe(0);
        });

        it('returns 0 when audioFeatures is undefined', () => {
            expect(getEffectiveIntroEndMs(undefined)).toBe(0);
        });

        it('uses introEndMs when dj_introEndMs is undefined', () => {
            expect(
                getEffectiveIntroEndMs({
                    dj_introEndMs: undefined,
                    introEndMs: 5000,
                }),
            ).toBe(5000);
        });
    });

    describe('determineCrossfadeStyle', () => {
        // BPM gap tests
        it('echoes out (unsynced, 8 beats) across a large BPM gap (>15%) instead of hard-cutting', () => {
            const out: TrackAudioFeatures = { bpm: 120 };
            const inc: TrackAudioFeatures = { bpm: 90 }; // 25% gap
            const result = determineCrossfadeStyle(out, inc);
            expect(result.fadeMode).toBe('echo');
            expect(result.beats).toBe(8);
            expect(result.plainTransition).toBe(true);
            expect(result.endAligned).toBe(true);
            expect(result.reason).toContain('%');
        });

        it('129 → 152 BPM hardstyle pair (15.1%) fades instead of cutting 6s early', () => {
            const out: TrackAudioFeatures = { bpm: 129, energy: 0.9 };
            const inc: TrackAudioFeatures = { bpm: 152, energy: 0.9 };
            const result = determineCrossfadeStyle(out, inc);
            expect(result.fadeMode).not.toBe('cut');
            expect(result.fadeMode).toBe('echo');
        });

        it('treats a half-time BPM reading as the same tempo', () => {
            const out: TrackAudioFeatures = { bpm: 150, energy: 0.8 };
            const inc: TrackAudioFeatures = { bpm: 74, energy: 0.8 }; // folds to 148
            expect(determineCrossfadeStyle(out, inc).fadeMode).toBe('bassswap');
            // and double-time the other way round
            expect(determineCrossfadeStyle(inc, out).fadeMode).toBe('bassswap');
        });

        it('paces an octave-matched pair at the real tempo, not the half-time reading', () => {
            const fast: TrackAudioFeatures = { bpm: 150, energy: 0.8 };
            const halfTime: TrackAudioFeatures = { bpm: 75, energy: 0.8 };
            // Fades are paced off the OUTGOING bpm: 48 beats at 75 BPM would be
            // 38s, so a half-time outgoing reading gets half the beats (19s).
            expect(determineCrossfadeStyle(halfTime, fast).beats).toBe(24);
            // Outgoing already at the faster reading: unchanged.
            expect(determineCrossfadeStyle(fast, halfTime).beats).toBe(48);
        });

        it('returns filter for medium BPM gap (8-15%)', () => {
            const out: TrackAudioFeatures = { bpm: 120 };
            const inc: TrackAudioFeatures = { bpm: 108 }; // 10% gap
            const result = determineCrossfadeStyle(out, inc);
            expect(result.fadeMode).toBe('filter');
            expect(result.beats).toBe(32);
            expect(result.reason).toContain('%');
        });

        it('returns blend for compatible BPMs', () => {
            const out: TrackAudioFeatures = { bpm: 120 };
            const inc: TrackAudioFeatures = { bpm: 124 }; // ~3.3% gap
            const result = determineCrossfadeStyle(out, inc);
            expect(result.fadeMode).toBe('blend');
            expect(result.beats).toBe(48);
        });

        // Key tests
        it('returns filter for incompatible keys with compatible BPM', () => {
            const out: TrackAudioFeatures = { bpm: 120, key: 'C' };
            const inc: TrackAudioFeatures = { bpm: 122, key: 'Db' }; // C→Db incompatible
            const result = determineCrossfadeStyle(out, inc);
            expect(result.fadeMode).toBe('filter');
            expect(result.beats).toBe(32);
            expect(result.reason).toContain('C');
            expect(result.reason).toContain('Db');
        });

        it('returns blend for compatible keys', () => {
            const out: TrackAudioFeatures = { bpm: 120, key: 'C' };
            const inc: TrackAudioFeatures = { bpm: 122, key: 'G' }; // C→G compatible
            const result = determineCrossfadeStyle(out, inc);
            expect(result.fadeMode).toBe('blend');
        });

        it('correctly detects Ebm and Bbm as minor keys', () => {
            // Ebm neighbors: Bbm, Abm, Gb (relative major)
            const out1: TrackAudioFeatures = { bpm: 120, key: 'Ebm' };
            const inc1: TrackAudioFeatures = { bpm: 122, key: 'Bbm' };
            const result1 = determineCrossfadeStyle(out1, inc1);
            expect(result1.fadeMode).toBe('blend'); // Ebm→Bbm are neighbors

            // Ebm and C are incompatible
            const out2: TrackAudioFeatures = { bpm: 120, key: 'Ebm' };
            const inc2: TrackAudioFeatures = { bpm: 122, key: 'C' };
            const result2 = determineCrossfadeStyle(out2, inc2);
            expect(result2.fadeMode).toBe('filter');
        });

        // Energy tests
        it('returns bassswap for high-energy tracks with synced BPMs', () => {
            const out: TrackAudioFeatures = {
                bpm: 128,
                energy: 0.85,
                moodTags: ['energetic'],
            };
            const inc: TrackAudioFeatures = { bpm: 130, energy: 0.8 };
            const result = determineCrossfadeStyle(out, inc);
            // BPM gap ~1.6% + both energetic → bassswap takes priority over cut
            expect(result.fadeMode).toBe('bassswap');
            expect(result.beats).toBe(48);
        });

        it('returns filter for energy drop (high → low)', () => {
            const out: TrackAudioFeatures = { bpm: 120, energy: 0.75 };
            const inc: TrackAudioFeatures = { bpm: 122, energy: 0.3 };
            const result = determineCrossfadeStyle(out, inc);
            expect(result.fadeMode).toBe('filter');
            expect(result.beats).toBe(32);
            expect(result.reason).toBe('energy drop');
        });

        // Mood tests
        it('returns echo for chill mood tag on outgoing', () => {
            const out: TrackAudioFeatures = {
                bpm: 90,
                energy: 0.3,
                moodTags: ['chill'],
            };
            const inc: TrackAudioFeatures = { bpm: 92, energy: 0.35 };
            const result = determineCrossfadeStyle(out, inc);
            expect(result.fadeMode).toBe('echo');
            expect(result.beats).toBe(48);
        });

        it('returns echo for ambient mood tag on incoming', () => {
            const out: TrackAudioFeatures = { bpm: 85, energy: 0.2 };
            const inc: TrackAudioFeatures = {
                bpm: 87,
                energy: 0.25,
                moodTags: ['ambient'],
            };
            const result = determineCrossfadeStyle(out, inc);
            expect(result.fadeMode).toBe('echo');
            expect(result.beats).toBe(48);
        });

        it('returns echo for chill channel mood regardless of track features', () => {
            const out: TrackAudioFeatures = { bpm: 128, energy: 0.8 };
            const inc: TrackAudioFeatures = { bpm: 130, energy: 0.75 };
            const result = determineCrossfadeStyle(out, inc, 'chill');
            expect(result.fadeMode).toBe('echo');
            expect(result.beats).toBe(48);
        });

        it('returns bassswap for energetic channel with synced BPMs', () => {
            const out: TrackAudioFeatures = { bpm: 128, energy: 0.85 };
            const inc: TrackAudioFeatures = { bpm: 130, energy: 0.8 };
            const result = determineCrossfadeStyle(out, inc, 'energetic');
            // BPM gap ~1.6% + both energetic → bassswap takes priority
            expect(result.fadeMode).toBe('bassswap');
            expect(result.beats).toBe(48);
        });

        // Priority tests
        it('BPM gap takes priority over mood', () => {
            const out: TrackAudioFeatures = {
                bpm: 120,
                energy: 0.2,
                moodTags: ['chill'],
            };
            const inc: TrackAudioFeatures = { bpm: 90, energy: 0.25 }; // 25% gap
            const result = determineCrossfadeStyle(out, inc, 'chill');
            expect(result.fadeMode).toBe('echo'); // large BPM gap wins
            expect(result.beats).toBe(8); // the short gap echo, not chill's 48
            expect(result.reason).toContain('BPM gap');
        });

        it('channel mood overrides track mood', () => {
            const out: TrackAudioFeatures = {
                bpm: 120,
                energy: 0.85,
                moodTags: ['chill'], // track says chill
            };
            const inc: TrackAudioFeatures = {
                bpm: 122,
                energy: 0.8,
                moodTags: ['chill'],
            };
            // Channel says energetic — bassswap fires for synced energetic BPMs
            const result = determineCrossfadeStyle(out, inc, 'energetic');
            expect(result.fadeMode).toBe('bassswap');
        });

        it('chill channel overrides key clash (echo not filter)', () => {
            const out: TrackAudioFeatures = {
                bpm: 124,
                energy: 0.4,
                key: 'Em',
            };
            const inc: TrackAudioFeatures = {
                bpm: 128,
                energy: 0.41,
                key: 'D',
            };
            // Without chill: Em→D is a key clash → filter
            const withoutChill = determineCrossfadeStyle(out, inc);
            expect(withoutChill.fadeMode).toBe('filter');
            expect(withoutChill.reason).toContain('key clash');

            // With chill channel: echo overrides key clash
            const withChill = determineCrossfadeStyle(out, inc, 'chill');
            expect(withChill.fadeMode).toBe('echo');
            expect(withChill.beats).toBe(48);
        });

        it('chill channel overrides track energetic tags (echo not cut)', () => {
            const out: TrackAudioFeatures = {
                bpm: 128,
                energy: 0.9,
                moodTags: ['energetic'],
            };
            const inc: TrackAudioFeatures = {
                bpm: 130,
                energy: 0.85,
                moodTags: ['energetic'],
            };
            // Channel says chill — should produce echo despite high energy + energetic tags
            const result = determineCrossfadeStyle(out, inc, 'chill');
            expect(result.fadeMode).toBe('echo');
            expect(result.beats).toBe(48);
        });

        // Edge cases
        it('returns short blend when no audio features (both undefined)', () => {
            const result = determineCrossfadeStyle(undefined, undefined);
            expect(result.fadeMode).toBe('blend');
            expect(result.beats).toBe(4);
            expect(result.reason).toBe('no audio data');
        });

        it('returns blend when features are empty objects', () => {
            const result = determineCrossfadeStyle({}, {});
            expect(result.fadeMode).toBe('blend');
            expect(result.beats).toBe(48);
        });

        it('returns short blend when only one track has features', () => {
            const result = determineCrossfadeStyle({ bpm: 120 }, undefined);
            expect(result.fadeMode).toBe('blend');
            expect(result.beats).toBe(4);
            expect(result.reason).toBe('no audio data');
        });

        it('skips BPM check when BPM is 0', () => {
            const out: TrackAudioFeatures = { bpm: 0, key: 'C' };
            const inc: TrackAudioFeatures = { bpm: 0, key: 'G' };
            const result = determineCrossfadeStyle(out, inc);
            // No BPM check fires; compatible keys → blend
            expect(result.fadeMode).toBe('blend');
        });

        it('skips energy check when energy is undefined', () => {
            const out: TrackAudioFeatures = { bpm: 120 }; // energy undefined
            const inc: TrackAudioFeatures = { bpm: 122 };
            const result = determineCrossfadeStyle(out, inc);
            // No energy-based decisions — should land on blend
            expect(result.fadeMode).toBe('blend');
        });

        // Bassswap tests
        it('selects bassswap when BPM gap ≤8%, both energetic, no chill', () => {
            const result = determineCrossfadeStyle(
                { bpm: 120, energy: 0.8 },
                { bpm: 124, energy: 0.7 },
            );
            expect(result.fadeMode).toBe('bassswap');
            expect(result.beats).toBe(48);
        });

        it('does not select bassswap when outgoing energy ≤0.5', () => {
            const result = determineCrossfadeStyle(
                { bpm: 120, energy: 0.4 },
                { bpm: 124, energy: 0.8 },
            );
            expect(result.fadeMode).not.toBe('bassswap');
        });

        it('does not select bassswap on chill channel', () => {
            const result = determineCrossfadeStyle(
                { bpm: 120, energy: 0.8 },
                { bpm: 124, energy: 0.8 },
                'chill',
            );
            expect(result.fadeMode).toBe('echo');
        });

        it('selects filter for BPM gap 10% regardless of energy', () => {
            const result = determineCrossfadeStyle(
                { bpm: 120, energy: 0.9 },
                { bpm: 132, energy: 0.9 },
            );
            // gap = |1 - 120/132| ≈ 9.1% → filter branch fires before bassswap check
            expect(result.fadeMode).toBe('filter');
        });
    });

    describe('computeBlendGains', () => {
        it('exposes the documented incoming delay constant', () => {
            expect(BLEND_INCOMING_DELAY).toBe(0.12);
        });

        it('at t=0: outgoing full, incoming silent', () => {
            const { gainOut, gainIn } = computeBlendGains(0, 1, 1);
            expect(gainOut).toBeCloseTo(1, 10);
            expect(gainIn).toBeCloseTo(0, 10);
        });

        it('at t=1: outgoing silent, incoming full', () => {
            const { gainOut, gainIn } = computeBlendGains(1, 1, 1);
            expect(gainOut).toBeCloseTo(0, 10);
            expect(gainIn).toBeCloseTo(1, 10);
        });

        it('keeps incoming silent until the delay has elapsed', () => {
            // At exactly the delay, tIn = 0 → sin(0) = 0
            expect(computeBlendGains(BLEND_INCOMING_DELAY, 1, 1).gainIn).toBeCloseTo(0, 10);
            // Just before the delay, still clamped to 0
            expect(computeBlendGains(0.05, 1, 1).gainIn).toBe(0);
        });

        it('scales gains by the per-deck volumes', () => {
            const { gainOut } = computeBlendGains(0, 0.5, 0.5);
            expect(gainOut).toBeCloseTo(0.5, 10);
            const { gainIn } = computeBlendGains(1, 0.5, 0.3);
            expect(gainIn).toBeCloseTo(0.3, 10);
        });

        it('clamps both gains to at most 1 even with >1 volumes', () => {
            const { gainOut } = computeBlendGains(0, 2, 1);
            expect(gainOut).toBe(1);
            const { gainIn } = computeBlendGains(1, 1, 2);
            expect(gainIn).toBe(1);
        });

        it('matches the inlined formula at the midpoint', () => {
            const t = 0.5;
            const expectedOut = Math.min(1, Math.cos(t * Math.PI * 0.5) * 0.8);
            const tIn = Math.max(0, (t - 0.12) / 0.88);
            const expectedIn = Math.min(1, Math.sin(tIn * Math.PI * 0.5) * 0.8);
            const { gainOut, gainIn } = computeBlendGains(t, 0.8, 0.8);
            expect(gainOut).toBeCloseTo(expectedOut, 10);
            expect(gainIn).toBeCloseTo(expectedIn, 10);
        });
    });

    describe('resolveIncomingStartSec', () => {
        it('returns 0 with no beat data and no intro end', () => {
            expect(resolveIncomingStartSec({}, 200)).toBe(0);
        });

        it('step 4: falls back to the raw intro end when positive', () => {
            // 10s intro end, 200s duration → maxStart = 199, returns 10
            expect(resolveIncomingStartSec({ incomingIntroEndMs: 10_000 }, 200)).toBe(10);
        });

        it('step 4: clamps the raw intro end to duration - 1', () => {
            // intro end 199s but duration only 100s → desired clamped to 99
            expect(resolveIncomingStartSec({ incomingIntroEndMs: 199_000 }, 100)).toBe(99);
        });

        it('step 3: snaps to the nearest beat in the incoming beat grid', () => {
            // desired 10.2s → nearest beat is 10
            const start = resolveIncomingStartSec(
                { incomingIntroEndMs: 10_200, incomingBeatGrid: [0, 5, 10, 15] },
                200,
            );
            expect(start).toBe(10);
        });

        it('step 2: snaps to the nearest incoming downbeat (preferred over beat grid)', () => {
            const start = resolveIncomingStartSec(
                {
                    incomingIntroEndMs: 10_400,
                    incomingDownbeats: [0, 4, 8, 12],
                    incomingBeatGrid: [0, 1, 2, 3, 10, 11],
                },
                200,
            );
            // 10.4s nearest downbeat is 12 (|10.4-12|=1.6) vs 8 (|10.4-8|=2.4) → 12
            expect(start).toBe(12);
        });

        it('step 1: full phase alignment when outgoing phase + incoming downbeats present', () => {
            // Mirror computePhaseAlignedStart with the same inputs.
            const opts = {
                incomingIntroEndMs: 8_000,
                outgoingDownbeats: [0, 2, 4, 6],
                outgoingCurrentTimeSec: 5,
                incomingDownbeats: [0, 4, 8, 12, 16],
                incomingBpm: 120,
            };
            const expected = Math.min(
                199,
                computePhaseAlignedStart(
                    opts.outgoingCurrentTimeSec,
                    opts.outgoingDownbeats,
                    opts.incomingDownbeats,
                    opts.incomingIntroEndMs / 1000,
                    opts.incomingBpm,
                ),
            );
            expect(resolveIncomingStartSec(opts, 200)).toBeCloseTo(expected, 10);
        });

        it('does not use phase alignment with fewer than 2 outgoing downbeats', () => {
            // Only one outgoing downbeat → falls to downbeat snap (step 2)
            const start = resolveIncomingStartSec(
                {
                    incomingIntroEndMs: 8_200,
                    outgoingDownbeats: [0],
                    outgoingCurrentTimeSec: 5,
                    incomingDownbeats: [0, 4, 8, 12],
                },
                200,
            );
            // nearest downbeat to 8.2 is 8
            expect(start).toBe(8);
        });

        it('clamps the seek to duration - 1 even with phase data', () => {
            // Incoming downbeats extend far past the end; result must not exceed 99.
            const start = resolveIncomingStartSec(
                {
                    incomingIntroEndMs: 95_000,
                    incomingDownbeats: [0, 50, 100, 150],
                },
                100,
            );
            expect(start).toBeLessThanOrEqual(99);
        });

        it('treats NaN/0 duration as unknown and clamps to the desired start', () => {
            // duration 0 → maxStart = desiredStart = 10, beat grid snap to 10
            const start = resolveIncomingStartSec(
                { incomingIntroEndMs: 10_000, incomingBeatGrid: [0, 5, 10] },
                0,
            );
            expect(start).toBe(10);
        });
    });

    describe('clampBassSwapBeats', () => {
        it('exposes the documented constants', () => {
            expect(BASSSWAP_MIN_BEATS).toBe(16);
            expect(BASSSWAP_LEAD_BUFFER_MS).toBe(3000);
        });

        it('returns the requested beats unchanged when bpm <= 0', () => {
            expect(clampBassSwapBeats(48, 60_000, 0)).toBe(48);
            expect(clampBassSwapBeats(48, 60_000, -120)).toBe(48);
        });

        it('caps beats to what fits in the remaining time minus the lead buffer', () => {
            // 120 BPM → 500ms/beat. remaining 30s, minus 3s buffer = 27s → 54 beats fit.
            // Desired 48 < 54 → returns 48.
            expect(clampBassSwapBeats(48, 30_000, 120)).toBe(48);
            // remaining 13s - 3s = 10s → 20 beats fit; desired 48 → clamp to 20.
            expect(clampBassSwapBeats(48, 13_000, 120)).toBe(20);
        });

        it('floors the max-beats-for-time computation', () => {
            // remaining 12.4s - 3s = 9.4s → 9.4/0.5 = 18.8 → floor 18.
            expect(clampBassSwapBeats(48, 12_400, 120)).toBe(18);
        });

        it('returns 0 (sentinel) when very little time remains (< min beats)', () => {
            // remaining 4s - 3s = 1s → 2 beats fit, below min → sentinel 0.
            expect(clampBassSwapBeats(48, 4_000, 120)).toBe(0);
        });

        it('returns 0 (sentinel) when available time is negative', () => {
            // remaining 1s - 3s = -2s → maxBeatsForTime negative, below min → sentinel 0.
            expect(clampBassSwapBeats(48, 1_000, 120)).toBe(0);
        });

        it('returns 0 (sentinel) exactly at the min-beats boundary (maxBeatsForTime = BASSSWAP_MIN_BEATS - 1)', () => {
            // 120 BPM → 500ms/beat. Need exactly 15 beats to fit: 15 * 500 + 3000 = 10500ms remaining.
            // maxBeatsForTime = floor((10500 - 3000) / 500) = floor(15) = 15 < 16 → 0.
            expect(clampBassSwapBeats(48, 10_500, 120)).toBe(0);
        });

        it('returns clamped value when exactly BASSSWAP_MIN_BEATS fit', () => {
            // 16 * 500ms + 3000ms lead = 11000ms needed.
            // maxBeatsForTime = floor((11000 - 3000) / 500) = 16 ≥ 16 → clamp(48, 16) = 16.
            expect(clampBassSwapBeats(48, 11_000, 120)).toBe(16);
        });
    });

    describe('computeBarPhase', () => {
        it('returns null with fewer than two downbeats', () => {
            expect(computeBarPhase(1, [])).toBeNull();
            expect(computeBarPhase(1, [0])).toBeNull();
        });

        it('returns null for NaN currentSec', () => {
            expect(computeBarPhase(NaN, [0, 2, 4])).toBeNull();
        });

        it('returns null for Infinity currentSec', () => {
            expect(computeBarPhase(Infinity, [0, 2, 4])).toBeNull();
            expect(computeBarPhase(-Infinity, [0, 2, 4])).toBeNull();
        });

        it('returns 0 exactly on a downbeat', () => {
            expect(computeBarPhase(4, [0, 2, 4, 6])).toBe(0);
        });

        it('returns the mid-bar fraction', () => {
            // bar [2,4], current 3 → phase 0.5
            expect(computeBarPhase(3, [0, 2, 4, 6])).toBeCloseTo(0.5, 10);
        });

        it('wraps phase into [0,1) past the last downbeat (outro case)', () => {
            // current 9, last bar uses [4,6] (dur 2). raw = (9-4)/2 = 2.5 → wrapped 0.5
            expect(computeBarPhase(9, [0, 2, 4, 6])).toBeCloseTo(0.5, 10);
        });

        it('returns null for a non-positive bar duration', () => {
            // duplicate downbeats → bar duration 0
            expect(computeBarPhase(5, [4, 4, 4])).toBeNull();
        });

        it('matches the store inlined computation at an arbitrary point', () => {
            const downbeats = [0, 1.5, 3, 4.5, 6];
            const currentSec = 3.6;
            // bracket: prev 3, next 4.5, dur 1.5 → raw (3.6-3)/1.5 = 0.4 → 0.4
            expect(computeBarPhase(currentSec, downbeats)).toBeCloseTo(0.4, 10);
        });
    });

    describe('BPM gap constants', () => {
        it('match the crossfade-engine thresholds', () => {
            expect(BPM_NATIVE_RATE_MAX_GAP).toBe(0.15);
            expect(BPM_WSOLA_MAX_GAP).toBe(0.25);
        });
    });

    describe('scaleCrossfadeBeatsForTrackLength', () => {
        it('keeps full style length when both tracks are extended-mix length', () => {
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', 420, 400)).toBe(48);
            expect(scaleCrossfadeBeatsForTrackLength(64, 'echo', EXTENDED_TRACK_SEC, 600)).toBe(64);
        });

        it('halves the fade for radio-length tracks', () => {
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', 210, 420)).toBe(24);
            expect(scaleCrossfadeBeatsForTrackLength(64, 'echo', 200, 180)).toBe(32);
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', SHORT_TRACK_SEC, 500)).toBe(24);
        });

        it('scales linearly between the short and extended thresholds', () => {
            // midpoint (300s) → factor 0.75 → 48 × 0.75 = 36
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', 300, 400)).toBe(36);
        });

        it('rounds to whole bars (multiples of 4 beats)', () => {
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', 330, 400) % 4).toBe(0);
        });

        it('uses the shorter of the two tracks', () => {
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', 600, 200)).toBe(24);
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', 200, 600)).toBe(24);
        });

        it('floors non-bassswap fades at 8 beats', () => {
            expect(scaleCrossfadeBeatsForTrackLength(16, 'blend', 180, 180)).toBe(8);
        });

        it('floors bass-swap at BASSSWAP_MIN_BEATS', () => {
            expect(scaleCrossfadeBeatsForTrackLength(24, 'bassswap', 180, 180)).toBe(
                BASSSWAP_MIN_BEATS,
            );
        });

        it('never scales cut mode', () => {
            expect(scaleCrossfadeBeatsForTrackLength(2, 'cut', 120, 120)).toBe(2);
        });

        it('never lengthens a style already below the floor (shrink-only)', () => {
            // the 4-beat "no audio data" fallback must not be raised to 8
            expect(scaleCrossfadeBeatsForTrackLength(4, 'blend', 180, 180)).toBe(4);
            expect(scaleCrossfadeBeatsForTrackLength(12, 'bassswap', 180, 180)).toBe(12);
        });

        it('passes through when durations are unknown or invalid', () => {
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend')).toBe(48);
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', 0, undefined)).toBe(48);
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', Number.NaN, -5)).toBe(48);
        });

        it('scales from the known duration when only one is available', () => {
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', 200, undefined)).toBe(24);
            expect(scaleCrossfadeBeatsForTrackLength(48, 'blend', undefined, 420)).toBe(48);
        });
    });

    describe('organic-material detection', () => {
        /** grid with deterministic human-like drift: interval 0.5s ± jitter */
        function grid(count: number, jitter: number): number[] {
            const beats: number[] = [0];
            for (let i = 1; i < count; i++) {
                beats.push(beats[i - 1] + 0.5 + jitter * Math.sin(i * 1.7));
            }
            return beats;
        }

        it('computeBeatIntervalCv: near zero for a quantized grid, high for drift', () => {
            const regular = computeBeatIntervalCv(grid(200, 0.001));
            const drifting = computeBeatIntervalCv(grid(200, 0.05));
            expect(regular).not.toBeNull();
            expect(regular!).toBeLessThan(0.01);
            expect(drifting!).toBeGreaterThan(ORGANIC_BEAT_CV_MIN);
        });

        it('computeBeatIntervalCv: null on insufficient data', () => {
            expect(computeBeatIntervalCv(undefined)).toBeNull();
            expect(computeBeatIntervalCv(grid(10, 0.05))).toBeNull();
        });

        it('isOrganicTrack: drifting grid = organic, quantized = not', () => {
            expect(isOrganicTrack({ beatGrid: grid(200, 0.05), danceability: 1.1 })).toBe(true);
            expect(isOrganicTrack({ beatGrid: grid(200, 0.001), danceability: 1.1 })).toBe(false);
            expect(isOrganicTrack(undefined)).toBe(false);
            expect(isOrganicTrack({ bpm: 120 })).toBe(false); // no grid → conservative
        });

        it('isOrganicTrack: high danceability vetoes', () => {
            expect(isOrganicTrack({ beatGrid: grid(200, 0.05), danceability: 1.8 })).toBe(false);
        });

        it('isOrganicTrack: loose tier only for sidecar-era analyses', () => {
            // mid CV + sub-2.0 danceability: organic only when vocal-bound
            // fields mark the analysis as sidecar-era
            const midCv = grid(200, 0.022); // CV ≈ 0.031
            expect(isOrganicTrack({ beatGrid: midCv, danceability: 1.8 })).toBe(false);
            expect(
                isOrganicTrack({
                    beatGrid: midCv,
                    danceability: 1.8,
                    lastVocalEndMs: 180_000,
                }),
            ).toBe(true);
            // sidecar-era EDM (danceability ≥ 2.0) still excluded
            expect(
                isOrganicTrack({
                    beatGrid: midCv,
                    danceability: 2.3,
                    lastVocalEndMs: 180_000,
                }),
            ).toBe(false);
        });

        it('organic pair gets a plain blend even across a large BPM gap', () => {
            const rock = (bpm: number): TrackAudioFeatures => ({
                bpm,
                energy: 0.8,
                danceability: 1.0,
                beatGrid: grid(200, 0.05),
            });
            // 25% gap would normally be a hard cut
            const style = determineCrossfadeStyle(rock(100), rock(125));
            expect(style.fadeMode).toBe('blend');
            expect(style.beats).toBe(16);
            expect(style.plainTransition).toBe(true);
            expect(style.reason).toBe('organic tracks');
        });

        it('mixed organic + electronic pair keeps DJ treatment', () => {
            const rock: TrackAudioFeatures = {
                bpm: 100,
                danceability: 1.0,
                beatGrid: grid(200, 0.05),
            };
            const edm: TrackAudioFeatures = {
                bpm: 125,
                danceability: 1.9,
                beatGrid: grid(200, 0.001),
            };
            const style = determineCrossfadeStyle(rock, edm);
            expect(style.fadeMode).toBe('echo'); // 25% gap → echo out
            expect(style.reason).toContain('BPM gap');
        });
    });
});
