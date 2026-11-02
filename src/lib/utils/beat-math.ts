// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Beat alignment math utilities for DJ-style crossfade.
 */

/** Musical keys for Circle of Fifths compatibility. */
const CIRCLE_OF_FIFTHS_MAJOR = [
    'C',
    'G',
    'D',
    'A',
    'E',
    'B',
    'Gb',
    'Db',
    'Ab',
    'Eb',
    'Bb',
    'F',
] as const;
const CIRCLE_OF_FIFTHS_MINOR = [
    'Am',
    'Em',
    'Bm',
    'F#m',
    'C#m',
    'G#m',
    'Ebm',
    'Bbm',
    'Fm',
    'Cm',
    'Gm',
    'Dm',
] as const;

/**
 * Find the nearest beat timestamp from a beat grid.
 * @param beatGrid - Array of beat timestamps in seconds
 * @param timeSec - Target time in seconds
 * @returns Nearest beat timestamp in seconds
 */
export function findNearestBeat(beatGrid: number[], timeSec: number): number {
    if (beatGrid.length === 0) return timeSec;
    let closest = beatGrid[0];
    let minDiff = Math.abs(timeSec - closest);
    for (let i = 1; i < beatGrid.length; i++) {
        const diff = Math.abs(timeSec - beatGrid[i]);
        if (diff < minDiff) {
            minDiff = diff;
            closest = beatGrid[i];
        } else {
            break; // beat grid is sorted, so we can stop
        }
    }
    return closest;
}

/** Find the nearest downbeat (bar start) timestamp. */
export function findNearestDownbeat(downbeats: number[], timeSec: number): number {
    return findNearestBeat(downbeats, timeSec);
}

/**
 * Find the first downbeat at or after timeSec, within maxLookaheadSec.
 * Used to snap the crossfade trigger to the next bar boundary.
 *
 * @param downbeats - Downbeat timestamps in seconds (sorted ascending)
 * @param timeSec - Target time in seconds (earliest acceptable trigger)
 * @param maxLookaheadSec - Max seconds to look ahead (default: 4s ≈ 2 bars at 120 BPM)
 * @returns The next downbeat in seconds, or timeSec if none found within window
 */
export function findNextDownbeat(
    downbeats: number[],
    timeSec: number,
    maxLookaheadSec: number = 4,
): number {
    for (const beat of downbeats) {
        if (beat >= timeSec && beat - timeSec <= maxLookaheadSec) {
            return beat;
        }
    }
    return timeSec; // no snap — use original time
}

/**
 * Enharmonic equivalents: map alternate spellings to the canonical names
 * used in the Circle of Fifths arrays above.
 */
const ENHARMONIC_MAP: Record<string, string> = {
    // Major
    'F#': 'Gb',
    'C#': 'Db',
    'G#': 'Ab',
    'D#': 'Eb',
    'A#': 'Bb',
    Cb: 'B',
    Fb: 'E',
    // Minor
    Abm: 'G#m',
    Dbm: 'C#m',
    'D#m': 'Ebm',
    'A#m': 'Bbm',
    Gbm: 'F#m',
    Cbm: 'Bm',
    Fbm: 'Em',
};

/**
 * Get compatible keys for mixing based on Circle of Fifths.
 * Returns keys that are neighbors on the circle (±1 step) plus relative major/minor.
 */
export function getCircleOfFifthsNeighbors(key: string): string[] {
    const normalizedKey = ENHARMONIC_MAP[key.trim()] ?? key.trim();
    const isMinor = normalizedKey.length > 1 && normalizedKey[normalizedKey.length - 1] === 'm';

    // Determine which circle to search
    const circle = isMinor ? CIRCLE_OF_FIFTHS_MINOR : CIRCLE_OF_FIFTHS_MAJOR;
    const parallelCircle = isMinor ? CIRCLE_OF_FIFTHS_MAJOR : CIRCLE_OF_FIFTHS_MINOR;

    const index = (circle as readonly string[]).indexOf(normalizedKey);
    if (index === -1) return [normalizedKey]; // unknown key, return self

    const neighbors: string[] = [
        normalizedKey,
        circle[(index - 1 + circle.length) % circle.length],
        circle[(index + 1) % circle.length],
        parallelCircle[index], // relative major/minor at same position
    ];

    return [...new Set(neighbors)];
}

/**
 * Compute the incoming track's start position that phase-aligns its beats
 * with the outgoing track's current beat position.
 *
 * DJ mixing requires both tracks' downbeats to coincide. This function:
 * 1. Determines where the outgoing track is within its current bar
 * 2. Finds the incoming track's nearest downbeat to the desired start
 * 3. Offsets by the outgoing bar phase so both downbeats align
 *
 * @param outCurrentSec - Outgoing track's current playback position (seconds)
 * @param outDownbeats - Outgoing track's downbeat timestamps (seconds, sorted)
 * @param inDownbeats - Incoming track's downbeat timestamps (seconds, sorted)
 * @param inDesiredStartSec - Desired start in the incoming track (e.g. introEndMs / 1000)
 * @param fallbackBpm - BPM to estimate bar duration when beat data is sparse
 * @returns Phase-aligned start time in the incoming track (seconds)
 */
export function computePhaseAlignedStart(
    outCurrentSec: number,
    outDownbeats: number[],
    inDownbeats: number[],
    inDesiredStartSec: number,
    fallbackBpm: number = 120,
): number {
    if (inDownbeats.length === 0) return inDesiredStartSec;

    // Find the nearest incoming downbeat to the desired start
    const inTargetDownbeat = findNearestBeat(inDownbeats, inDesiredStartSec);

    if (outDownbeats.length < 2) {
        // No outgoing downbeat data — just snap to incoming downbeat (best we can do)
        return inTargetDownbeat;
    }

    // Find outgoing bar phase: how far through the current bar (0 = on downbeat, 0.5 = mid-bar)
    let prevOut = outDownbeats[0];
    let nextOut = outDownbeats[1];
    for (let i = 1; i < outDownbeats.length; i++) {
        if (outDownbeats[i] >= outCurrentSec) {
            nextOut = outDownbeats[i];
            prevOut = outDownbeats[i - 1] ?? outDownbeats[0];
            break;
        }
        // If we pass all downbeats, use the last two
        if (i === outDownbeats.length - 1) {
            prevOut = outDownbeats[i - 1];
            nextOut = outDownbeats[i];
        }
    }

    const outBarDuration = nextOut - prevOut;
    if (outBarDuration <= 0) return inTargetDownbeat;

    // Use modulo to wrap phase into [0, 1). When the outgoing track is past
    // the last analyzed downbeat (common during outros where crossfade triggers),
    // the raw phase can exceed 1.0 — wrapping ensures correct sub-bar alignment.
    const rawPhase = Math.max(0, outCurrentSec - prevOut) / outBarDuration;
    const barPhase = rawPhase - Math.floor(rawPhase);

    // If we're very close to a downbeat (within 5% of bar), just use the downbeat
    if (barPhase < 0.05 || barPhase > 0.95) {
        return inTargetDownbeat;
    }

    // Estimate incoming bar duration at the target downbeat.
    // Use epsilon comparison — findNearestBeat may return a float not
    // exactly equal to any element in inDownbeats (floating-point mismatch).
    const inIdx = inDownbeats.findIndex((b) => Math.abs(b - inTargetDownbeat) < 0.001);
    let inBarDuration: number;
    if (inIdx >= 0 && inIdx < inDownbeats.length - 1) {
        inBarDuration = inDownbeats[inIdx + 1] - inTargetDownbeat;
    } else if (fallbackBpm > 0) {
        inBarDuration = (4 * 60) / fallbackBpm; // 4 beats at fallback BPM
    } else {
        return inTargetDownbeat; // can't compute bar duration
    }

    // A half/double-time analysis of one side makes its "bars" two real bars
    // (or half of one). The phase offset must be measured in REAL bars, so
    // rescale the incoming bar by the same octave match the rate-matching uses
    // — otherwise a 75-vs-150 pair lands a whole beat or more off.
    const inBarBpm = 240 / inBarDuration;
    const effectiveInBarDuration = 240 / matchBpmOctave(inBarBpm, 240 / outBarDuration);

    // Offset incoming start by the same bar phase.
    // Clamp to [0, lastDownbeat] so we never seek past the end of the incoming track.
    const alignedStart = inTargetDownbeat + barPhase * effectiveInBarDuration;
    const lastDownbeat = inDownbeats[inDownbeats.length - 1];
    return Math.max(0, Math.min(alignedStart, lastDownbeat));
}

/**
 * Get the effective intro end point for the incoming track.
 * Prefers dj_introEndMs (skips percussive DJ intro) over introEndMs.
 */
export function getEffectiveIntroEndMs(audioFeatures?: {
    dj_introEndMs?: number;
    introEndMs?: number;
}): number {
    return audioFeatures?.dj_introEndMs ?? audioFeatures?.introEndMs ?? 0;
}

/** Tempo assumed for fade pacing when neither track has a BPM. */
export const ASSUMED_FADE_BPM = 120;

/** Calculate crossfade duration in ms for a given number of beats at a BPM. */
export function calculateCrossfadeDuration(bpm: number, beats: number = 8): number {
    // Unknown BPM: the beats at an assumed 120 BPM (500ms each) — the one rule
    // the planner, the trigger, the UI marker and both backends' engines share,
    // so a manual 32-beat override on an unanalysed track is 16s everywhere
    // (it used to be 2s in the plan but 16s in the Web Audio engine).
    const msPerBeat = 60_000 / (bpm > 0 ? bpm : ASSUMED_FADE_BPM);
    return Math.round(msPerBeat * beats);
}

/**
 * Calculate DJ-appropriate crossfade beat count based on BPM sync capability.
 *
 * When BPMs are available (at least one track), use long DJ-style blends
 * paced to the known tempo. When neither has BPM, fall back to time-based.
 *
 * Beat counts (in 4/4 time, durations at 120 BPM):
 * - Synced + chill mood: 64 beats (16 bars, ~32s)
 * - Synced + normal:     48 beats (12 bars, ~24s)
 * - Synced + energetic:  32 beats (8 bars,  ~16s)
 * - One BPM only:        same as synced (paced to known tempo)
 * - Not synced > 25%:    same counts but tempo-stretch won't apply
 * - No BPM at all:       2s time-based fallback (see calculateCrossfadeDuration)
 */
export function getDjCrossfadeBeats(
    outgoingBpm: number | undefined,
    incomingBpm: number | undefined,
    mood?: string,
): number {
    const hasAnyBpm = (outgoingBpm ?? 0) > 0 || (incomingBpm ?? 0) > 0;

    // If at least one track has BPM we can pace the fade musically
    if (hasAnyBpm) {
        if (mood) {
            const chill = ['chill', 'ambient', 'focus', 'melancholic'];
            const energetic = ['energetic', 'party', 'aggressive', 'workout'];
            if (chill.includes(mood)) return 64;
            if (energetic.includes(mood)) return 32;
        }
        return 48;
    }

    // No BPM at all — calculateCrossfadeDuration returns 2s fallback.
    // Beat count is ignored when bpm=0.
    return 4;
}

/** Calculate playback rate ratio to match source BPM to target BPM. */
export function calculatePlaybackRate(sourceBpm: number, targetBpm: number): number {
    if (!(sourceBpm > 0) || !(targetBpm > 0)) return 1;
    return targetBpm / matchBpmOctave(sourceBpm, targetBpm);
}

/**
 * Move `bpm` by whole octaves (×2 / ÷2) to the value closest to `targetBpm`.
 * Non-finite or non-positive input is returned unchanged.
 */
export function foldBpmToward(bpm: number, targetBpm: number): number {
    if (!(bpm > 0) || !(targetBpm > 0) || !Number.isFinite(bpm) || !Number.isFinite(targetBpm)) {
        return bpm;
    }
    let folded = bpm;
    for (let i = 0; i < 8 && folded * 1.5 < targetBpm; i++) folded *= 2;
    for (let i = 0; i < 8 && folded > targetBpm * 1.5; i++) folded /= 2;
    return folded;
}

/**
 * `bpm` read as half/double time when that makes it beat-matchable with
 * `targetBpm`, else `bpm` unchanged.
 *
 * A 75 BPM half-time reading and a 150 BPM track share one beat grid — every
 * other beat lines up — so they mix as if the tempos matched. Without the fold
 * that pair reads as a 50% gap and a rate match would try to double the
 * playback speed. The fold is only taken when it lands within native
 * rate-match range: 80 vs 130 is not an octave relation, just a big gap.
 */
export function matchBpmOctave(bpm: number, targetBpm: number): number {
    const folded = foldBpmToward(bpm, targetBpm);
    if (folded === bpm) return bpm;
    return Math.abs(1 - targetBpm / folded) <= BPM_NATIVE_RATE_MAX_GAP ? folded : bpm;
}

/**
 * Relative tempo gap between two tracks after octave matching, as a fraction
 * (0.1 = 10%). Same orientation as the crossfade engine's rate gap
 * (`|1 - out/in|`). Returns `null` when either BPM is unknown.
 */
export function bpmGap(outBpm: number, inBpm: number): number | null {
    if (!(outBpm > 0) || !(inBpm > 0) || !Number.isFinite(outBpm) || !Number.isFinite(inBpm)) {
        return null;
    }
    return Math.abs(1 - outBpm / matchBpmOctave(inBpm, outBpm));
}

/** Check if two BPMs are within a given tolerance (default ±8%). */
export function isBpmCompatible(bpm1: number, bpm2: number, tolerance: number = 0.08): boolean {
    if (bpm1 <= 0 || bpm2 <= 0) return false;
    const ratio = bpm1 / bpm2;
    return Math.abs(1 - ratio) <= tolerance;
}

/** Check if two keys are compatible for mixing. */
export function areKeysCompatible(key1: string, key2: string): boolean {
    if (!key1 || !key2) return true; // unknown keys are always "compatible"
    const neighbors = getCircleOfFifthsNeighbors(key1);
    const normalizedKey2 = ENHARMONIC_MAP[key2.trim()] ?? key2.trim();
    return neighbors.includes(normalizedKey2);
}

export interface CrossfadeStyle {
    /** Which fade mode to use */
    fadeMode: 'blend' | 'cut' | 'filter' | 'echo' | 'bassswap';
    /** Suggested beat count for this mode */
    beats: number;
    /** Human-readable reason for the choice (for debug display) */
    reason: string;
    /**
     * Unsynced transition at natural tempo: the caller must skip BPM
     * rate-matching, beat alignment, and the incoming intro seek. Set for
     * organic (rock/acoustic/live) pairs, and for the echo-out across a BPM
     * gap too large to beat-match.
     */
    plainTransition?: boolean;
    /**
     * Fire late enough that the fade ends ~1s before the outgoing track does,
     * ignoring the outro boundary. For short transitions (the BPM-gap echo)
     * that would otherwise start at `outroStartMs` — 8-16s from the end —
     * finish in a few seconds and skip the rest of the outro.
     */
    endAligned?: boolean;
}

export interface TrackAudioFeatures {
    bpm?: number;
    key?: string;
    energy?: number;
    danceability?: number;
    moodTags?: string[];
    loudnessLufs?: number;
    /** Beat timestamps (seconds) — used for the organic-material heuristic. */
    beatGrid?: number[];
    /** Vocal-phrase bounds — presence marks a sidecar-era analysis, which
     *  unlocks the looser organic tier (librosa danceability separates
     *  genres cleanly; the legacy binary's values overlap). */
    firstVocalStartMs?: number;
    lastVocalEndMs?: number;
}

const CHILL_MOODS = ['chill', 'ambient', 'focus', 'melancholic'];
const ENERGETIC_MOODS = ['energetic', 'party', 'aggressive', 'workout'];

// ── Organic-material detection (rock/acoustic/live) ────────────────────────
/** Beat-interval CV at or above this = human timing (drummer drift, fills).
 *  Prod ground truth: rock/metal median 0.044 / p75 0.114; quantized EDM
 *  median 0.027 / p75 0.039. Safe on BOTH analysis engines. */
export const ORGANIC_BEAT_CV_MIN = 0.04;
/** Danceability (Essentia 0..3) at or above this vetoes the organic verdict —
 *  strongly pulse-regular material wants the DJ treatment even if the grid
 *  detection wobbled. */
export const ORGANIC_DANCEABILITY_VETO = 1.5;
/** Looser sidecar-era tier (see isOrganicTrack): CV floor and danceability
 *  ceiling. Prod ground truth on sidecar analyses: rock/pop danceability
 *  0.62-1.90 vs EDM 2.12-2.52 (clean gap at ~2.0); rock CV ≥ 0.028 for the
 *  tracks the strict tier missed. */
export const ORGANIC_SIDECAR_BEAT_CV_MIN = 0.025;
export const ORGANIC_SIDECAR_DANCEABILITY_MAX = 2.0;
/** Minimum beats / intervals for a trustworthy CV estimate. */
const ORGANIC_MIN_BEATS = 30;
const ORGANIC_MIN_INTERVALS = 20;

/**
 * Coefficient of variation (stddev/mean) of inter-beat intervals.
 * Intervals outside 0.2-1.5s (40-300 BPM) are discarded as tracker glitches.
 * Returns null when there isn't enough beat data for a stable estimate.
 */
export function computeBeatIntervalCv(beatGrid: number[] | undefined): number | null {
    if (!beatGrid || beatGrid.length < ORGANIC_MIN_BEATS) return null;
    const intervals: number[] = [];
    for (let i = 1; i < beatGrid.length; i++) {
        const iv = beatGrid[i] - beatGrid[i - 1];
        if (iv > 0.2 && iv < 1.5) intervals.push(iv);
    }
    if (intervals.length < ORGANIC_MIN_INTERVALS) return null;
    const mean = intervals.reduce((a, b) => a + b, 0) / intervals.length;
    if (mean <= 0) return null;
    const variance = intervals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / intervals.length;
    return Math.sqrt(variance) / mean;
}

/**
 * Whether a track is organic material (rock/acoustic/live) that should get a
 * plain Apple-style crossfade instead of DJ treatment (rate-matching, cuts,
 * filter sweeps).
 *
 * Primary signal: beat-grid irregularity (human drummers drift; machines
 * don't) — see {@link ORGANIC_BEAT_CV_MIN}. High danceability vetoes.
 * Deliberately conservative: an unclear verdict returns false and the pair
 * keeps today's DJ-style behavior. Mood tags are NOT consulted — the sidecar's
 * heuristic tags mark bright/fast material (including distorted metal) as
 * 'electronic'/'party', which would wrongly exclude most rock.
 *
 * Two tiers:
 * - Strict (any engine): CV ≥ {@link ORGANIC_BEAT_CV_MIN}, danceability below
 *   {@link ORGANIC_DANCEABILITY_VETO}.
 * - Loose (sidecar-era analyses only, marked by vocal-bound fields): CV ≥
 *   {@link ORGANIC_SIDECAR_BEAT_CV_MIN} with danceability below
 *   {@link ORGANIC_SIDECAR_DANCEABILITY_MAX} — the librosa danceability proxy
 *   separates organic (≤1.9) from EDM (≥2.1) cleanly, but legacy binary
 *   values overlap in that range, so the loose tier must not apply to them.
 */
export function isOrganicTrack(features: TrackAudioFeatures | undefined): boolean {
    if (!features) return false;
    const cv = computeBeatIntervalCv(features.beatGrid);
    if (cv === null) return false;

    const strict =
        cv >= ORGANIC_BEAT_CV_MIN &&
        (features.danceability === undefined || features.danceability < ORGANIC_DANCEABILITY_VETO);
    if (strict) return true;

    const sidecarEra =
        features.lastVocalEndMs !== undefined || features.firstVocalStartMs !== undefined;
    return (
        sidecarEra &&
        cv >= ORGANIC_SIDECAR_BEAT_CV_MIN &&
        features.danceability !== undefined &&
        features.danceability < ORGANIC_SIDECAR_DANCEABILITY_MAX
    );
}

/**
 * Determine the best crossfade style based on audio features of both tracks.
 *
 * Decision logic (priority order):
 * 1. Large BPM gap (>15%) → cut (2 beats)
 * 2. Medium BPM gap (8-15%) → filter (32 beats)
 * 3. Synced BPM + both energetic (no chill channel) → bassswap (48 beats)
 * 4. Chill channel mood → echo (48 beats)
 * 5. Incompatible keys AND both have key data → filter (32 beats)
 * 6. High-energy + energetic mood/channel → blend (16 beats)
 * 7. Chill/ambient mood tag on EITHER track → echo (48 beats)
 * 8. Energy drop: outgoing > 0.6, incoming < 0.4 → filter (32 beats)
 * 9. Default → blend (48 beats)
 *
 * Channel mood overrides track moodTags when present.
 */
export function determineCrossfadeStyle(
    outgoing: TrackAudioFeatures | undefined,
    incoming: TrackAudioFeatures | undefined,
    channelMood?: string,
): CrossfadeStyle {
    const style = selectCrossfadeStyle(outgoing, incoming, channelMood);
    // Fades are paced off the OUTGOING BPM (beats → ms). When that reading is
    // the half-time one of an octave-matched pair (75 vs 150), the same beat
    // count would last twice as long as intended — scale it to the real tempo.
    const outBpm = outgoing?.bpm ?? 0;
    const inBpm = incoming?.bpm ?? 0;
    if (!style.plainTransition && bpmGap(outBpm, inBpm) !== null) {
        const pace = matchBpmOctave(inBpm, outBpm) / inBpm;
        if (pace < 1) {
            return { ...style, beats: Math.max(8, Math.round((style.beats * pace) / 4) * 4) };
        }
    }
    return style;
}

function selectCrossfadeStyle(
    outgoing: TrackAudioFeatures | undefined,
    incoming: TrackAudioFeatures | undefined,
    channelMood?: string,
): CrossfadeStyle {
    if (!outgoing || !incoming) {
        // No audio features — use a short fade (4 beats at fallback BPM = ~2s)
        // instead of the long 48-beat / 16s fade that feels like dead air.
        return { fadeMode: 'blend', beats: 4, reason: 'no audio data' };
    }

    // Organic pairs (rock/acoustic/live on BOTH sides): plain Apple-style
    // equal-power blend at natural tempo. Checked before every DJ heuristic —
    // rate-matching pitch-shifts guitars audibly, filter sweeps and hard cuts
    // are synth idioms, and beat alignment means nothing without a stable
    // grid. ~16 beats ≈ 8s at 120 BPM. This intentionally outranks channel
    // mood: no DJ effect sounds right on organic material.
    if (isOrganicTrack(outgoing) && isOrganicTrack(incoming)) {
        return {
            fadeMode: 'blend',
            beats: 16,
            reason: 'organic tracks',
            plainTransition: true,
        };
    }

    const outBpm = outgoing.bpm ?? 0;
    const inBpm = incoming.bpm ?? 0;

    // BPM gap checks (skip when either BPM is unknown). Half/double-time
    // readings are folded first — they share a beat grid.
    const gap = bpmGap(outBpm, inBpm);
    if (gap !== null) {
        if (gap > BPM_NATIVE_RATE_MAX_GAP) {
            // Too far apart to beat-match without an audible pitch shift or
            // time-stretch glitches. Echo out instead — the DJ move for a tempo
            // change: the outgoing tail repeats and dies away while the
            // incoming track comes in at its own tempo, so the beats never have
            // to line up. Short (8 beats ≈ 3s at 150 BPM) and unsynced. This was
            // a 2-beat hard cut fired ~6s before the end, which dropped the
            // outro and sounded like playback had stopped.
            const pct = Math.round(gap * 100);
            return {
                fadeMode: 'echo',
                beats: 8,
                reason: `BPM gap ${pct}% (echo out)`,
                plainTransition: true,
                endAligned: true,
            };
        }

        if (gap > 0.08) {
            const pct = Math.round(gap * 100);
            return { fadeMode: 'filter', beats: 32, reason: `BPM gap ${pct}%` };
        }

        // gap <= 0.08 falls through to here — bass-swap for synced energetic tracks
        const isChillForBassSwap = channelMood !== undefined && CHILL_MOODS.includes(channelMood);
        const isEnergeticBoth = (outgoing.energy ?? 0) > 0.5 && (incoming.energy ?? 0) > 0.5;
        if (isEnergeticBoth && !isChillForBassSwap) {
            // Bass-swap uses 48 beats by default (~24s at 120 BPM) for a long,
            // musical transition with hold period. The trigger logic adapts
            // this down if there isn't enough remaining track time.
            return {
                fadeMode: 'bassswap',
                beats: 48,
                reason: 'bass-swap for synced energetic tracks',
            };
        }
    }

    // Channel mood is the user's explicit intent — it overrides harmonic
    // analysis (key clash) and track-level mood tags. Chill mood's spacey
    // echo effect masks key clashes well, so this ordering is intentional.
    const isChillChannel = channelMood !== undefined && CHILL_MOODS.includes(channelMood);
    const isEnergeticChannel = channelMood !== undefined && ENERGETIC_MOODS.includes(channelMood);

    if (isChillChannel) {
        return { fadeMode: 'echo', beats: 48, reason: 'chill mood' };
    }

    // Key clash check (only when both tracks have key data)
    const outKey = outgoing.key;
    const inKey = incoming.key;
    if (outKey && inKey && !areKeysCompatible(outKey, inKey)) {
        return {
            fadeMode: 'filter',
            beats: 32,
            reason: `key clash ${outKey}→${inKey}`,
        };
    }

    // High-energy short blend (with energetic mood signal).
    // Uses a fast 16-beat blend instead of an instant cut — still snappy
    // but avoids the jarring discontinuity of a hard switch, especially
    // when triggered by outroStartMs before the track has wound down.
    const outEnergy = outgoing.energy;
    const inEnergy = incoming.energy;
    const outMoodTags = outgoing.moodTags ?? [];
    const inMoodTags = incoming.moodTags ?? [];
    if (outEnergy !== undefined && inEnergy !== undefined) {
        const hasEnergeticTag =
            outMoodTags.some((t) => ENERGETIC_MOODS.includes(t)) ||
            inMoodTags.some((t) => ENERGETIC_MOODS.includes(t));

        if (outEnergy > 0.7 && inEnergy > 0.7 && (hasEnergeticTag || isEnergeticChannel)) {
            return {
                fadeMode: 'blend',
                beats: 16,
                reason: 'high energy tracks',
            };
        }
    }
    const hasChillTag =
        outMoodTags.some((t) => CHILL_MOODS.includes(t)) ||
        inMoodTags.some((t) => CHILL_MOODS.includes(t));
    if (hasChillTag) {
        return { fadeMode: 'echo', beats: 48, reason: 'chill mood' };
    }

    // Energy drop
    if (outEnergy !== undefined && inEnergy !== undefined) {
        if (outEnergy > 0.6 && inEnergy < 0.4) {
            return { fadeMode: 'filter', beats: 32, reason: 'energy drop' };
        }
    }

    return { fadeMode: 'blend', beats: 48, reason: 'compatible tracks' };
}

/**
 * Delay (as a fraction of the fade) before the incoming track begins ramping up
 * in a blend crossfade. The incoming gain stays at 0 for the first 12% of the
 * fade, then ramps over the remaining 88%. This lets the outgoing track breathe
 * before the new track enters, avoiding a muddy double-loud midpoint.
 *
 * Shared by CrossfadeEngine.tickBlendFade and SafariAudioBackend's blend tick.
 */
export const BLEND_INCOMING_DELAY = 0.12;

/**
 * Equal-power blend gains for a given fade progress `t` (0..1).
 *
 * - Outgoing: `cos(t·π/2) · fromVolume`, clamped to ≤ 1.
 * - Incoming: ramps in only after {@link BLEND_INCOMING_DELAY} of the fade has
 *   elapsed — `sin(tIn·π/2) · toVolume` where
 *   `tIn = max(0, (t − BLEND_INCOMING_DELAY) / (1 − BLEND_INCOMING_DELAY))`,
 *   clamped to ≤ 1.
 *
 * Mirrors the identical formula inlined in CrossfadeEngine.tickBlendFade
 * (~494-496) and SafariAudioBackend's blend tick (~588-590).
 *
 * @param t - Fade progress in [0, 1].
 * @param fromVolume - Outgoing deck's target volume (0..1).
 * @param toVolume - Incoming deck's target volume (0..1).
 * @returns `{ gainOut, gainIn }` — both clamped to ≤ 1 (not lower-clamped here;
 *   callers that need the browser `[0, 1]` constraint apply their own `max(0, …)`).
 */
export function computeBlendGains(
    t: number,
    fromVolume: number,
    toVolume: number,
): { gainOut: number; gainIn: number } {
    const gainOut = Math.min(1, Math.cos(t * Math.PI * 0.5) * fromVolume);
    const tIn = Math.max(0, (t - BLEND_INCOMING_DELAY) / (1 - BLEND_INCOMING_DELAY));
    const gainIn = Math.min(1, Math.sin(tIn * Math.PI * 0.5) * toVolume);
    return { gainOut, gainIn };
}

/** Beat-alignment seek inputs shared by CrossfadeEngine and SafariAudioBackend. */
export interface IncomingStartOptions {
    /** Intro end point of incoming track in ms (drives the desired raw start). */
    incomingIntroEndMs?: number;
    /** Downbeat timestamps of the outgoing track (seconds, sorted ascending). */
    outgoingDownbeats?: number[];
    /** Current playback position of the outgoing track (seconds). */
    outgoingCurrentTimeSec?: number;
    /** Downbeat timestamps of the incoming track (seconds, sorted ascending). */
    incomingDownbeats?: number[];
    /** Beat grid of the incoming track (seconds, sorted ascending). */
    incomingBeatGrid?: number[];
    /** BPM of the incoming track (used to estimate bar duration when sparse). */
    incomingBpm?: number;
}

/**
 * Resolve the incoming track's start position (seconds) for a beat-aligned
 * crossfade seek. This is the pure, fully unit-testable extraction of the
 * 4-step priority chain currently inlined in
 * CrossfadeEngine.startCrossfade (~181-226) and duplicated in
 * SafariAudioBackend.triggerCrossfade (~310-353).
 *
 * Priority:
 * 1. Full phase alignment — when the outgoing track has ≥2 downbeats and a known
 *    current position AND the incoming track has downbeats:
 *    {@link computePhaseAlignedStart}.
 * 2. Downbeat snap — incoming downbeats present and a positive desired start:
 *    {@link findNearestBeat} on the incoming downbeats.
 * 3. Beat-grid snap — incoming beat grid present and a positive desired start:
 *    {@link findNearestBeat} on the incoming beat grid.
 * 4. Raw intro end — the desired start itself, when positive.
 *
 * All results are clamped to `[0, maxStartSec]` where `maxStartSec` leaves a 1s
 * buffer before the track end (or falls back to the desired start when the
 * duration is unknown). When none of the steps apply (no usable beat data and a
 * non-positive desired start), returns 0 (no seek).
 *
 * No non-null assertions: every array access is length-guarded.
 *
 * @param options - Beat data and intro-end input for the incoming track.
 * @param durationSec - Incoming track duration in seconds (0 if unknown/NaN).
 * @returns The clamped start time in the incoming track (seconds).
 */
export function resolveIncomingStartSec(
    options: IncomingStartOptions,
    durationSec: number,
): number {
    const introEndSec = (options.incomingIntroEndMs ?? 0) / 1000;

    // Desired raw start: intro end, but never within 1s of a known track end.
    const desiredStartSec = durationSec > 1 ? Math.min(introEndSec, durationSec - 1) : introEndSec;

    // Safety clamp ceiling: never seek past track end (1s buffer). When the
    // duration is unknown, clamp to the desired start so we don't allow an
    // arbitrary seek position.
    const maxStartSec = durationSec > 1 ? durationSec - 1 : desiredStartSec;

    const outgoingDownbeats = options.outgoingDownbeats;
    const incomingDownbeats = options.incomingDownbeats;
    const incomingBeatGrid = options.incomingBeatGrid;

    const outCurrentSec = options.outgoingCurrentTimeSec;
    const hasOutgoingPhaseData =
        outgoingDownbeats !== undefined &&
        outgoingDownbeats.length >= 2 &&
        outCurrentSec !== undefined;
    const hasIncomingDownbeats = incomingDownbeats !== undefined && incomingDownbeats.length > 0;

    if (hasOutgoingPhaseData && hasIncomingDownbeats) {
        return Math.min(
            maxStartSec,
            computePhaseAlignedStart(
                outCurrentSec,
                outgoingDownbeats,
                incomingDownbeats,
                desiredStartSec,
                options.incomingBpm,
            ),
        );
    }

    if (hasIncomingDownbeats && desiredStartSec > 0) {
        return Math.min(maxStartSec, findNearestBeat(incomingDownbeats, desiredStartSec));
    }

    if (incomingBeatGrid !== undefined && incomingBeatGrid.length > 0 && desiredStartSec > 0) {
        return Math.min(maxStartSec, findNearestBeat(incomingBeatGrid, desiredStartSec));
    }

    if (desiredStartSec > 0) {
        return Math.min(maxStartSec, desiredStartSec);
    }

    return 0;
}

/** Minimum bass-swap length in beats — fewer beats than this isn't a meaningful swap. */
export const BASSSWAP_MIN_BEATS = 16;

/**
 * Lead buffer (ms) reserved before the track end when computing how many beats
 * a bass-swap can occupy. Ensures the swap completes before the audio runs out.
 */
export const BASSSWAP_LEAD_BUFFER_MS = 3000;

/**
 * Clamp a bass-swap beat count to fit the remaining track time.
 *
 * Bass-swap wants the longest possible musical transition, but it must fit
 * within the audio that's left. Computes the maximum whole beats that fit in
 * `remainingMs − {@link BASSSWAP_LEAD_BUFFER_MS}` at the given BPM, then clamps
 * the desired `beats` to `[{@link BASSSWAP_MIN_BEATS}, that maximum]`.
 *
 * Mirrors the logic in the music-player store's checkCrossfadeTrigger
 * (~417-423) and triggerCrossfade (~1322-1327).
 *
 * CONTRACT: returns `0` as a sentinel when `maxBeatsForTime < BASSSWAP_MIN_BEATS`
 * (not enough remaining audio for a minimum bass-swap). When the caller receives 0
 * it MUST NOT force a bass-swap — fall back to the normal/default crossfade style
 * for that transition instead. When the return value is > 0, use it as the clamped
 * beat count.
 *
 * @param beats - Desired (style default) beat count.
 * @param remainingMs - Milliseconds of audio remaining (duration − current).
 * @param bpm - Tempo used to convert beats to time (must be > 0).
 * @returns The clamped beat count, or 0 if there is not enough audio remaining.
 */
export function clampBassSwapBeats(beats: number, remainingMs: number, bpm: number): number {
    if (bpm <= 0) return beats;
    const availableMs = remainingMs - BASSSWAP_LEAD_BUFFER_MS;
    const maxBeatsForTime = Math.floor(availableMs / (60_000 / bpm));
    if (maxBeatsForTime < BASSSWAP_MIN_BEATS) return 0;
    return Math.min(beats, maxBeatsForTime);
}

/**
 * Track length at or below which smart fades run at half their style length.
 * Radio edits (~3-4 min) don't have the long outros/intros that make a
 * 48-beat DJ blend musical — a long fade just eats the song.
 */
export const SHORT_TRACK_SEC = 240;
/**
 * Track length at or above which smart fades keep their full style length.
 * Extended/club mixes (6+ min) are structured for long DJ transitions.
 */
export const EXTENDED_TRACK_SEC = 360;
/** Floor for a scaled-down smart fade (non-bassswap modes). */
const MIN_SCALED_FADE_BEATS = 8;

/**
 * Scale a smart-selected crossfade beat count to the tracks being mixed.
 *
 * The style defaults (48/64 beats ≈ 24-32s at 120 BPM) assume extended-mix
 * material. For radio-length tracks that much overlap swallows the outro and
 * intro entirely, so the fade shrinks with the shorter of the two tracks:
 *
 * - both tracks ≥ {@link EXTENDED_TRACK_SEC}: full style length (×1.0)
 * - shorter track ≤ {@link SHORT_TRACK_SEC}: half length (×0.5)
 * - in between: linear ramp between ×0.5 and ×1.0
 *
 * The result is rounded to a multiple of 4 beats (whole bars in 4/4) and
 * floored at {@link MIN_SCALED_FADE_BEATS} ({@link BASSSWAP_MIN_BEATS} for
 * bass-swap, which needs its hold period). Cut mode and unknown durations
 * pass through unchanged. Manual beat overrides should NOT be scaled —
 * callers apply this only to style-derived beat counts.
 *
 * @param beats - Style-selected beat count (e.g. from determineCrossfadeStyle).
 * @param fadeMode - The style's fade mode (cut is never scaled).
 * @param outgoingDurationSec - Outgoing track duration in seconds (0/undefined = unknown).
 * @param incomingDurationSec - Incoming track duration in seconds (0/undefined = unknown).
 * @returns The scaled beat count.
 */
export function scaleCrossfadeBeatsForTrackLength(
    beats: number,
    fadeMode: CrossfadeStyle['fadeMode'],
    outgoingDurationSec?: number,
    incomingDurationSec?: number | null,
): number {
    if (fadeMode === 'cut') return beats;
    const durations = [outgoingDurationSec, incomingDurationSec].filter(
        (d): d is number => typeof d === 'number' && Number.isFinite(d) && d > 0,
    );
    if (durations.length === 0) return beats;

    const refSec = Math.min(...durations);
    if (refSec >= EXTENDED_TRACK_SEC) return beats;

    const factor =
        refSec <= SHORT_TRACK_SEC
            ? 0.5
            : 0.5 + 0.5 * ((refSec - SHORT_TRACK_SEC) / (EXTENDED_TRACK_SEC - SHORT_TRACK_SEC));
    const scaled = Math.round((beats * factor) / 4) * 4;
    const minBeats = fadeMode === 'bassswap' ? BASSSWAP_MIN_BEATS : MIN_SCALED_FADE_BEATS;
    // Shrink-only: the floor must never RAISE a style that was already shorter
    // than it (e.g. the 4-beat "no audio data" fallback).
    return Math.min(beats, Math.max(minBeats, scaled));
}

/**
 * Compute the outgoing track's bar phase at `currentSec` — how far through the
 * current bar the playhead is, as a fraction in [0, 1) (0 = on a downbeat).
 *
 * Walks the sorted `downbeats` to find the bar bracketing `currentSec`, then
 * returns the wrapped fractional position within that bar. Wrapping handles the
 * common outro case where the playhead is past the last analyzed downbeat
 * (raw phase > 1). Returns `null` when phase can't be computed: fewer than two
 * downbeats, or a non-positive bar duration.
 *
 * Mirrors the bar-phase computation inlined in the store's triggerCrossfade
 * (~1354-1375), which duplicates {@link computePhaseAlignedStart}'s internals.
 *
 * @param currentSec - Outgoing track's current playback position (seconds).
 * @param downbeats - Outgoing track's downbeat timestamps (seconds, sorted).
 * @returns Bar phase in [0, 1), or `null` if it can't be computed.
 */
export function computeBarPhase(currentSec: number, downbeats: number[]): number | null {
    if (!Number.isFinite(currentSec)) return null;
    if (downbeats.length < 2) return null;

    let prevOut = downbeats[0];
    let nextOut = downbeats[1];
    for (let i = 1; i < downbeats.length; i++) {
        if (downbeats[i] >= currentSec) {
            nextOut = downbeats[i];
            prevOut = downbeats[i - 1] ?? downbeats[0];
            break;
        }
        // If we pass all downbeats, use the last two.
        if (i === downbeats.length - 1) {
            prevOut = downbeats[i - 1];
            nextOut = downbeats[i];
        }
    }

    const barDuration = nextOut - prevOut;
    if (barDuration <= 0) return null;

    const rawPhase = Math.max(0, currentSec - prevOut) / barDuration;
    const wrapped = rawPhase - Math.floor(rawPhase);
    if (!Number.isFinite(wrapped)) return null;
    return wrapped;
}

/**
 * Max BPM-rate gap for native `playbackRate` matching. At or below this gap the
 * pitch shift (~2.4 semitones at the limit) is masked by the crossfade.
 *
 * Re-imported by crossfade-engine.ts instead of hardcoding `0.15`.
 */
export const BPM_NATIVE_RATE_MAX_GAP = 0.15;

/**
 * Max BPM-rate gap for WSOLA (pitch-preserving) time-stretch. Above this gap,
 * BPM matching is skipped entirely.
 *
 * Re-imported by crossfade-engine.ts instead of hardcoding `0.25`.
 */
export const BPM_WSOLA_MAX_GAP = 0.25;
