// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cross-episode audio-fingerprint matcher.
 *
 * Episodes of a TV season share near-identical audio during the intro (and
 * frequently during end credits). Given the Chromaprint fingerprints of every
 * episode in a season, this module decides, per episode, whether it shares a
 * sufficiently long contiguous stretch of similar audio with another episode in
 * the cohort, and where that stretch sits in time.
 *
 * Approach (a dot-plot / diagonal-matching formulation), in three layers:
 *
 *   1. Diagonal proposal. A fingerprint is a temporal sequence of 32-bit points,
 *      each summarizing ~0.1238s of audio. Two episodes' shared content sits at
 *      an unknown but CONSTANT relative offset `d = posB - posA` — the "diagonal"
 *      of a dot-plot. Each point is split into four 8-bit BANDS and indexed by
 *      (bandIndex, bandValue); points within a small Hamming distance almost
 *      always agree on at least one band, so genuine matches vote for the correct
 *      diagonal even under bit-noise. The top-voted diagonals (plus a
 *      ±`invertedIndexShift` neighbourhood for timing drift) are scanned in full.
 *
 *   2. Density-aware run extraction. A diagonal scan does NOT simply bridge every
 *      gap up to maxTimeSkip — that lets a recurring background score (audio that
 *      partially matches while dialogue differs) chain sparse coincidental matches
 *      into a long, low-density false "run". Instead each diagonal is hard-split
 *      at gaps wider than maxTimeSkip, and within each split a local-alignment
 *      score (+1 per matching point, −penalty per mismatch) extracts the densest
 *      contiguous CORE. Genuine shared audio is dense and survives; sparse
 *      score-bridged stretches collapse.
 *
 *   3. Cohort-consensus selection. The intro / end-credits are SEASON-level
 *      structures that recur at a roughly consistent length across the cohort.
 *      Rather than keep each episode's single longest run (which an anomalous
 *      pairing — a shared recap, say — can inflate far past what the cohort
 *      agrees on), the per-episode run is chosen from the consensus length band
 *      (median over per-episode-deduplicated candidates). An episode whose only
 *      candidate is a length outlier gets no segment rather than a spurious one.
 */

import { FFmpegError } from '$lib/server/utils/ffmpeg-spawn.js';
import { chromaprintFingerprint } from '$lib/server/utils/ffmpeg-analysis.js';
import { AnalysisBudgetReachedError } from './budget.js';

export interface FingerprintCheckpoint {
    shouldYield?: () => boolean;
    load(
        episode: EpisodeWithFile,
        pass: 'intro' | 'credits',
        startSec: number,
        endSec: number,
    ): Promise<Uint32Array | null>;
    save(
        episode: EpisodeWithFile,
        pass: 'intro' | 'credits',
        startSec: number,
        endSec: number,
        points: Uint32Array,
    ): Promise<void>;
    onProgress?: (episodeId: string) => void;
}
import type { DetectedSegment, DetectedSegmentType, EpisodeWithFile } from './types.js';

// ── Tunables exposed to operators ──────────────────────────────────────────────

export interface ChromaprintConfig {
    /** Max differing bits for two fingerprint points to count as "the same audio". */
    maxPointDifferences: number;
    /** Max gap, in seconds, allowed inside a matched stretch before it is broken. */
    maxTimeSkip: number;
    /** Discard matches shorter than this many seconds. */
    minIntroDuration: number;
    /**
     * Discard matches longer than this many seconds; also the size of the tail
     * window used for the credits pass.
     */
    maxIntroDuration: number;
    /** Fingerprint only the first this-fraction of each episode for intro detection. */
    introWindowFraction: number;
    /** Hard cap, in seconds, on the intro head window. */
    introWindowMaxSec: number;
    /**
     * Diagonal-neighbourhood slack when proposing candidate alignments — each
     * high-vote diagonal is scanned together with its ±this neighbours, widening
     * the candidate set so minor timing drift between episodes is still caught.
     */
    invertedIndexShift: number;
}

export const DEFAULT_CHROMAPRINT_CONFIG: ChromaprintConfig = {
    maxPointDifferences: 6,
    maxTimeSkip: 3.5,
    minIntroDuration: 15,
    maxIntroDuration: 120,
    introWindowFraction: 0.25,
    introWindowMaxSec: 600,
    invertedIndexShift: 2,
};

// ── Constants of the fingerprint format / algorithm ─────────────────────────────

/** Seconds of audio summarized by a single fingerprint point. */
const SECONDS_PER_POINT = 0.1238;

/** Number of bands a 32-bit point is split into for diagonal voting. */
const BAND_COUNT = 4;
/** Bit width of each band (32 / BAND_COUNT). */
const BAND_BITS = 8;
const BAND_MASK = (1 << BAND_BITS) - 1;

/**
 * How many top-voted diagonals to scan in full per pair. Genuine shared content
 * produces a dominant diagonal, so a handful of candidates suffices; the extra
 * slots cover seasons that share more than one stretch (e.g. intro + recap).
 */
const MAX_CANDIDATE_DIAGONALS = 10;

/**
 * Skip band buckets larger than this fraction of the indexed sequence. A near
 * constant (e.g. silence) collapses many points into one bucket; voting from it
 * is pure noise and quadratic, so it is dropped.
 */
const MAX_BUCKET_FRACTION = 0.2;

/** Yield to the event loop after this many pairwise comparisons. */
const YIELD_EVERY_PAIRS = 16;

/**
 * Per-episode comparison cap. Each episode is compared against at most this many
 * successors, bounding the pairwise phase at O(N · this) instead of O(N²). The
 * cohort-wide intro / end-credits are shared by ~every episode, so a sliding
 * window of neighbours still establishes them and the consensus length; normal
 * seasons (≤ ~25 episodes) are effectively unchanged. This keeps a mis-grouped
 * "season" of hundreds of episodes from spending minutes in the matcher.
 */
const MAX_PEER_LOOKAHEAD = 12;

/**
 * Mismatch penalty for the local-alignment (Kadane) run extraction. A run stays
 * positive only while its match fraction exceeds penalty / (1 + penalty), so this
 * sets the effective density floor: 1.5 → ~0.6. Genuine intro / credits audio
 * matches at ~0.85+, well clear of the floor; a recurring-score false match sits
 * below it and is rejected.
 */
const MISMATCH_PENALTY = 1.5;

/** Minimum number of candidate runs in the cohort before a consensus length is trusted. */
const CONSENSUS_MIN_SUPPORT = 3;
/** Per-episode runs are accepted within [LO, HI] × the consensus length. */
const CONSENSUS_BAND_LO = 0.5;
const CONSENSUS_BAND_HI = 2.0;

// ── Internal shapes ─────────────────────────────────────────────────────────────

type Pass = 'intro' | 'credits';

interface FingerprintedEpisode {
    episodeId: string;
    /**
     * Which physical file this fingerprint came from. Two episodes can name the
     * SAME file — a genuine combined file holding both, or a scanner mis-link —
     * and comparing a fingerprint against itself is vacuous: every point matches,
     * so the "shared run" is the whole window. See `collectCandidates`.
     */
    fileKey: string;
    /** Absolute time, in seconds, of point 0 within the source episode. */
    windowStartSec: number;
    points: Uint32Array;
    /** Band index reused across every pairing this episode participates in. */
    bandIndex: BandIndex;
}

/** Per-band inverted index: bands[b] maps a band value → positions holding it. */
type BandIndex = Array<Map<number, number[]>>;

/** A matched run in the local (window-relative) point coordinates of one episode. */
interface LocalRun {
    startPoint: number;
    endPoint: number;
}

/** Deduplicated candidate runs accumulated per episode across all its pairings. */
interface EpisodeCandidates {
    runs: LocalRun[];
    keys: Set<string>;
}

// ── Bit helpers ──────────────────────────────────────────────────────────────

/** Population count of a 32-bit integer (SWAR). */
function popcount32(value: number): number {
    let v = value | 0;
    v = v - ((v >>> 1) & 0x55555555);
    v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
    v = (v + (v >>> 4)) & 0x0f0f0f0f;
    return (Math.imul(v, 0x01010101) >>> 24) & 0x3f;
}

function hammingDistance(a: number, b: number): number {
    return popcount32((a ^ b) >>> 0);
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

// ── Fingerprint extraction ─────────────────────────────────────────────────────

/**
 * Compute the [startSec, endSec] window to fingerprint for one episode, or null
 * when the episode is excluded from this pass.
 */
function windowFor(
    episode: EpisodeWithFile,
    pass: Pass,
    config: ChromaprintConfig,
): { startSec: number; endSec: number } | null {
    const duration = episode.durationSeconds;
    if (pass === 'intro') {
        // Head window: first introWindowFraction of the episode, hard-capped.
        // Unknown duration falls back to the cap as the window size.
        const windowLen =
            duration != null
                ? Math.min(duration * config.introWindowFraction, config.introWindowMaxSec)
                : config.introWindowMaxSec;
        if (windowLen <= 0) return null;
        return { startSec: 0, endSec: windowLen };
    }
    // Credits: the last maxIntroDuration seconds. Episodes with unknown duration
    // or duration ≤ the tail window are excluded — their tail would collapse onto
    // the intro and pollute the cohort.
    if (duration == null || duration <= config.maxIntroDuration) return null;
    return { startSec: Math.max(0, duration - config.maxIntroDuration), endSec: duration };
}

/** Build the per-band inverted index for a fingerprint. */
function buildBandIndex(points: Uint32Array): BandIndex {
    const index: BandIndex = Array.from({ length: BAND_COUNT }, () => new Map<number, number[]>());
    for (let pos = 0; pos < points.length; pos++) {
        const value = points[pos];
        for (let band = 0; band < BAND_COUNT; band++) {
            const key = (value >>> (band * BAND_BITS)) & BAND_MASK;
            const bucket = index[band].get(key);
            if (bucket) bucket.push(pos);
            else index[band].set(key, [pos]);
        }
    }
    return index;
}

/**
 * Extract fingerprints for every episode in the pass, at most `concurrency` in
 * flight. Episodes excluded by the window rule, that fail extraction, or that
 * yield an empty fingerprint are silently dropped (never fail the season).
 */
async function extractFingerprints(
    episodes: EpisodeWithFile[],
    tmpDir: string,
    config: ChromaprintConfig,
    pass: Pass,
    concurrency: number,
    ffmpegThreads: number | undefined,
    signal: AbortSignal | undefined,
    checkpoint?: FingerprintCheckpoint,
): Promise<FingerprintedEpisode[]> {
    const candidates: Array<{ episode: EpisodeWithFile; startSec: number; endSec: number }> = [];
    for (const episode of episodes) {
        if (!episode.filePath) continue;
        const window = windowFor(episode, pass, config);
        if (window) candidates.push({ episode, ...window });
    }

    const results: FingerprintedEpisode[] = [];
    const limit = Math.max(1, Math.floor(concurrency) || 1);
    let next = 0;
    let timeoutError: FFmpegError | undefined;

    async function worker(): Promise<void> {
        while (true) {
            if (signal?.aborted || timeoutError || checkpoint?.shouldYield?.()) return;
            const i = next++;
            if (i >= candidates.length) return;
            const { episode, startSec, endSec } = candidates[i];
            let points: Uint32Array;
            // A broken cache read must not turn a readable media file into a
            // decoder failure (or spend a poison-file strike).
            let saved: Uint32Array | null | undefined;
            try {
                saved = await checkpoint?.load(episode, pass, startSec, endSec);
            } catch {
                saved = null;
            }
            try {
                points =
                    saved ??
                    (await chromaprintFingerprint(episode.filePath!, startSec, endSec, tmpDir, {
                        threads: ffmpegThreads,
                        abortSignal: signal,
                    }));
            } catch (err) {
                if (err instanceof FFmpegError && err.timedOut) {
                    // Stop admitting files, wait for the other workers below,
                    // then let the task defer this incomplete cohort. Treating
                    // a timeout as a missing fingerprint used to mark it done
                    // and start the credits pass on the same slow file at once.
                    timeoutError = err;
                    return;
                }
                // Other extraction failures still skip only this episode.
                continue;
            }
            signal?.throwIfAborted();
            if (saved == null) await checkpoint?.save(episode, pass, startSec, endSec, points);
            checkpoint?.onProgress?.(episode.episodeId);
            if (!points || points.length === 0) continue;
            results.push({
                episodeId: episode.episodeId,
                fileKey: episode.fileId ?? episode.filePath!,
                windowStartSec: startSec,
                points,
                bandIndex: buildBandIndex(points),
            });
        }
    }

    // Join every admitted extraction/save even if one checkpoint fails.
    const settled = await Promise.allSettled(
        Array.from({ length: Math.min(limit, candidates.length) }, () => worker()),
    );
    for (const result of settled) if (result.status === 'rejected') throw result.reason;
    if (timeoutError) throw timeoutError;
    signal?.throwIfAborted();
    if (
        checkpoint?.shouldYield?.() &&
        results.length < candidates.length &&
        next < candidates.length
    )
        throw new AnalysisBudgetReachedError();
    return results;
}

// ── Pairwise matching ──────────────────────────────────────────────────────────

/**
 * Propose candidate diagonals for the ordered pair (a, b) by band voting, then
 * expand each by ±shift. `d = posB - posA`.
 */
function proposeDiagonals(
    a: FingerprintedEpisode,
    b: FingerprintedEpisode,
    shift: number,
): number[] {
    const votes = new Map<number, number>();
    const maxBucket = Math.max(8, Math.floor(b.points.length * MAX_BUCKET_FRACTION));

    for (let posA = 0; posA < a.points.length; posA++) {
        const value = a.points[posA];
        for (let band = 0; band < BAND_COUNT; band++) {
            const key = (value >>> (band * BAND_BITS)) & BAND_MASK;
            const bucket = b.bandIndex[band].get(key);
            if (!bucket || bucket.length > maxBucket) continue;
            for (const posB of bucket) {
                const d = posB - posA;
                votes.set(d, (votes.get(d) ?? 0) + 1);
            }
        }
    }
    if (votes.size === 0) return [];

    const ranked = [...votes.entries()]
        .sort((x, y) => y[1] - x[1])
        .slice(0, MAX_CANDIDATE_DIAGONALS)
        .map(([d]) => d);

    // Expand each surviving diagonal by ±shift; dedupe.
    const expanded = new Set<number>();
    const slack = Math.max(0, Math.floor(shift));
    for (const d of ranked) {
        for (let delta = -slack; delta <= slack; delta++) expanded.add(d + delta);
    }
    return [...expanded];
}

/**
 * Extract dense matched runs along one diagonal. The diagonal is hard-split at
 * gaps wider than `maxGapPoints` (the maxTimeSkip rule); within each split a
 * local-alignment score (+1 match, −MISMATCH_PENALTY mismatch) yields the densest
 * contiguous core, trimmed to its matching endpoints. Cores outside
 * [minPoints, maxPoints] are dropped. Returns runs in episode A's coordinates.
 */
function denseRunsOnDiagonal(
    a: Uint32Array,
    b: Uint32Array,
    diagonal: number,
    maxPointDifferences: number,
    maxGapPoints: number,
    minPoints: number,
    maxPoints: number,
): LocalRun[] {
    const startA = Math.max(0, -diagonal);
    const endA = Math.min(a.length, b.length - diagonal);
    if (endA - startA < minPoints) return [];

    const runs: LocalRun[] = [];
    let score = 0;
    let best = 0;
    let curStart = -1;
    let bestStart = -1;
    let bestEnd = -1;
    let lastMatch = -1;

    const bank = (): void => {
        if (bestStart >= 0) {
            const length = bestEnd - bestStart;
            if (length >= minPoints && length <= maxPoints) {
                runs.push({ startPoint: bestStart, endPoint: bestEnd });
            }
        }
        score = 0;
        best = 0;
        curStart = -1;
        bestStart = -1;
        bestEnd = -1;
    };

    for (let posA = startA; posA < endA; posA++) {
        const match = hammingDistance(a[posA], b[posA + diagonal]) <= maxPointDifferences;
        if (match) {
            // A gap wider than maxTimeSkip hard-ends the current alignment.
            if (lastMatch >= 0 && posA - lastMatch > maxGapPoints) bank();
            lastMatch = posA;
            if (score <= 0) {
                score = 1;
                curStart = posA;
            } else {
                score += 1;
            }
            if (score > best) {
                best = score;
                bestStart = curStart;
                bestEnd = posA;
            }
        } else if (lastMatch >= 0) {
            // Penalize mismatches inside an active alignment; reset when it goes
            // non-positive so sparse stretches cannot accumulate into a run.
            score -= MISMATCH_PENALTY;
            if (score < 0) {
                score = 0;
                curStart = -1;
            }
        }
    }
    bank();
    return runs;
}

/** Record a run for an episode, deduplicating near-identical candidates. */
function addCandidate(
    cands: Map<string, EpisodeCandidates>,
    episodeId: string,
    run: LocalRun,
): void {
    let entry = cands.get(episodeId);
    if (!entry) {
        entry = { runs: [], keys: new Set() };
        cands.set(episodeId, entry);
    }
    // Quantize to ~4-point buckets so the many duplicate copies of the true
    // segment collapse to one, while genuinely distinct runs (outliers) survive.
    const key = `${Math.round(run.startPoint / 4)}:${Math.round(run.endPoint / 4)}`;
    if (entry.keys.has(key)) return;
    entry.keys.add(key);
    entry.runs.push(run);
}

/**
 * Compare every unordered pair and collect each episode's candidate runs. Yields
 * to the event loop periodically so the heartbeat / lock-renewal timers are not
 * starved.
 */
async function collectCandidates(
    episodes: FingerprintedEpisode[],
    config: ChromaprintConfig,
    minPoints: number,
    maxPoints: number,
    maxGapPoints: number,
    signal: AbortSignal | undefined,
    shouldYield?: () => boolean,
): Promise<Map<string, EpisodeCandidates>> {
    const cands = new Map<string, EpisodeCandidates>();
    let comparisons = 0;

    for (let i = 0; i < episodes.length; i++) {
        // Cap comparisons to a sliding window of successors so the pairwise phase
        // is O(N · MAX_PEER_LOOKAHEAD), not O(N²), on very large seasons.
        const peerLimit = Math.min(episodes.length, i + 1 + MAX_PEER_LOOKAHEAD);
        for (let j = i + 1; j < peerLimit; j++) {
            if (signal?.aborted) return cands;
            if (shouldYield?.()) throw new AnalysisBudgetReachedError();

            const a = episodes[i];
            const b = episodes[j];
            // Never compare a physical file against itself. Two episodes can
            // resolve to the SAME file — a genuine combined file holding both
            // (257 such files in one production library), or a scanner mis-link
            // — and then the two fingerprints are byte-identical. Every point
            // matches on diagonal 0, so the "shared run" is the entire window
            // and both episodes get an intro covering their whole head window.
            //
            // The consensus band normally hides this: in a season with a real
            // intro, the median run length is the real intro's and the
            // full-window run falls out of band. It only surfaces when NOTHING
            // in the season has a genuine shared intro, because then the
            // degenerate runs ARE the consensus. Recess S6 (rips with no title
            // sequence, three episodes mis-linked to one combined file) came out
            // as Intro 0-83.19s = 97% of the window, marking real content
            // skippable. A self-match carries no evidence either way, so it must
            // never enter the candidate pool.
            if (a.fileKey === b.fileKey) continue;
            for (const diagonal of proposeDiagonals(a, b, config.invertedIndexShift)) {
                const runs = denseRunsOnDiagonal(
                    a.points,
                    b.points,
                    diagonal,
                    config.maxPointDifferences,
                    maxGapPoints,
                    minPoints,
                    maxPoints,
                );
                for (const run of runs) {
                    addCandidate(cands, a.episodeId, run);
                    // The same stretch maps onto B by shifting along the diagonal.
                    addCandidate(cands, b.episodeId, {
                        startPoint: run.startPoint + diagonal,
                        endPoint: run.endPoint + diagonal,
                    });
                }
            }

            if (++comparisons % YIELD_EVERY_PAIRS === 0) await yieldToEventLoop();
        }
    }
    return cands;
}

// ── Cohort-consensus selection ──────────────────────────────────────────────────

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Choose one run per episode. The season's consensus length (median over the
 * per-episode-deduplicated candidates) defines an acceptance band; each episode
 * keeps the in-band run closest to the boundary that matters for the pass
 * (credits → nearest the episode end; intro → nearest the start). An episode
 * whose only candidates fall outside the band gets no segment.
 */
function selectCohortSegments(
    cands: Map<string, EpisodeCandidates>,
    pass: Pass,
    minPoints: number,
    maxPoints: number,
): Map<string, LocalRun> {
    const pool: number[] = [];
    for (const entry of cands.values()) {
        for (const run of entry.runs) pool.push(run.endPoint - run.startPoint);
    }

    let band: [number, number] | null = null;
    if (pool.length >= CONSENSUS_MIN_SUPPORT) {
        const consensus = median(pool);
        band = [
            Math.max(minPoints, consensus * CONSENSUS_BAND_LO),
            Math.min(maxPoints, consensus * CONSENSUS_BAND_HI),
        ];
    }

    const out = new Map<string, LocalRun>();
    for (const [episodeId, entry] of cands) {
        const inBand = band
            ? entry.runs.filter((r) => {
                  const len = r.endPoint - r.startPoint;
                  return len >= band![0] && len <= band![1];
              })
            : entry.runs;
        // With a consensus band, an episode with no in-band run is left blank
        // (better than emitting a length outlier). Without consensus, fall back
        // to the episode's own candidates.
        const choices = inBand.length ? inBand : band ? [] : entry.runs;

        let pick: LocalRun | null = null;
        for (const run of choices) {
            if (!pick) {
                pick = run;
                continue;
            }
            if (pass === 'credits') {
                const better =
                    run.endPoint > pick.endPoint ||
                    (run.endPoint === pick.endPoint &&
                        run.endPoint - run.startPoint > pick.endPoint - pick.startPoint);
                if (better) pick = run;
            } else {
                const better =
                    run.startPoint < pick.startPoint ||
                    (run.startPoint === pick.startPoint &&
                        run.endPoint - run.startPoint > pick.endPoint - pick.startPoint);
                if (better) pick = run;
            }
        }
        if (pick) out.set(episodeId, pick);
    }
    return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

async function analyzeSeason(
    episodes: EpisodeWithFile[],
    tmpDir: string,
    config: ChromaprintConfig,
    concurrency: number,
    ffmpegThreads: number | undefined,
    signal: AbortSignal | undefined,
    pass: Pass,
    checkpoint?: FingerprintCheckpoint,
): Promise<Map<string, DetectedSegment>> {
    const out = new Map<string, DetectedSegment>();
    if (signal?.aborted) return out;

    const fingerprinted = await extractFingerprints(
        episodes,
        tmpDir,
        config,
        pass,
        concurrency,
        ffmpegThreads,
        signal,
        checkpoint,
    );
    if (fingerprinted.length < 2 || signal?.aborted) return out;

    const minPoints = Math.ceil(config.minIntroDuration / SECONDS_PER_POINT);
    const maxPoints = Math.floor(config.maxIntroDuration / SECONDS_PER_POINT);
    const maxGapPoints = Math.max(0, Math.floor(config.maxTimeSkip / SECONDS_PER_POINT));

    const cands = await collectCandidates(
        fingerprinted,
        config,
        minPoints,
        maxPoints,
        maxGapPoints,
        signal,
        checkpoint?.shouldYield,
    );
    const selected = selectCohortSegments(cands, pass, minPoints, maxPoints);

    const windowStartById = new Map(fingerprinted.map((f) => [f.episodeId, f.windowStartSec]));
    const type: DetectedSegmentType = pass === 'intro' ? 'Intro' : 'Outro';

    for (const [episodeId, run] of selected) {
        const windowStart = windowStartById.get(episodeId) ?? 0;
        let startTime = windowStart + run.startPoint * SECONDS_PER_POINT;
        const endTime = windowStart + run.endPoint * SECONDS_PER_POINT;
        // Snap-to-zero: in the intro pass the window starts at 0, so an intro
        // that begins almost immediately should cover from the episode start.
        if (pass === 'intro' && startTime <= 5) startTime = 0;
        out.set(episodeId, { type, startTime, endTime, method: 'chromaprint' });
    }
    return out;
}

/**
 * Intro pass — fingerprint each episode's head window and report the shared
 * intro per episode, if any.
 */
export async function analyzeSeasonFingerprints(
    episodes: EpisodeWithFile[],
    tmpDir: string,
    config: ChromaprintConfig = DEFAULT_CHROMAPRINT_CONFIG,
    concurrency = 1,
    ffmpegThreads?: number,
    signal?: AbortSignal,
    checkpoint?: FingerprintCheckpoint,
): Promise<Map<string, DetectedSegment>> {
    return analyzeSeason(
        episodes,
        tmpDir,
        config,
        concurrency,
        ffmpegThreads,
        signal,
        'intro',
        checkpoint,
    );
}

/**
 * Credits pass — fingerprint each episode's tail window and report the shared
 * end-credits per episode, in absolute episode time.
 */
export async function analyzeSeasonCreditsFingerprints(
    episodes: EpisodeWithFile[],
    tmpDir: string,
    config: ChromaprintConfig,
    concurrency: number,
    ffmpegThreads: number | undefined,
    signal?: AbortSignal,
    checkpoint?: FingerprintCheckpoint,
): Promise<Map<string, DetectedSegment>> {
    return analyzeSeason(
        episodes,
        tmpDir,
        config,
        concurrency,
        ffmpegThreads,
        signal,
        'credits',
        checkpoint,
    );
}
