// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Essentia Audio Analysis Service
 *
 * Wraps the Essentia CLI (essentia_streaming_extractor_music) to extract
 * audio features from music tracks at scan time:
 * - BPM, beat grid, downbeats
 * - Key + scale
 * - Energy, danceability, loudness (LUFS)
 * - Intro/outro boundaries
 * - Mood tags
 *
 * Results are stored in media_items.custom_metadata JSONB, merged with
 * any existing metadata rather than replacing it.
 *
 * Configuration:
 * - ESSENTIA_EXTRACTOR_PATH: Override binary path (optional)
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getCpuBudgetCores } from '../utils/cpu-budget.js';
import { Logger } from '../utils/logger.js';
import { fetchWithTimeout } from '../utils/fetch-utils.js';
import { AsyncSemaphore } from '../utils/async-semaphore.js';
import { TARGET_LUFS } from '$lib/utils/lufs-gain.js';
import { config } from '../config.js';
import { assertTranscodeInputIsMedia } from './transcoding/input-guard.js';
import { analyzeOne, type SidecarAnalysis } from './music-analysis-sidecar.service.js';
import type postgres from 'postgres';

const execFileAsync = promisify(execFile);
const logger = Logger.for('EssentiaAnalysis');

// ============================================================================
// Process-level concurrency gate
// ============================================================================

/**
 * Shared, process-level semaphore for Essentia binary analysis.
 *
 * Without this, each concurrent BullMQ job invocation creates its own
 * AsyncSemaphore, so two jobs each requesting concurrency=4 would spawn
 * 8 Essentia processes on a machine with only 6 cores.
 *
 * This singleton ensures the total number of concurrent Essentia processes
 * across ALL job invocations never exceeds (CPUs - 2).
 *
 * Sized off the EFFECTIVE CPU budget (cgroup-aware), not os.availableParallelism()
 * — the latter ignores a Docker `cpus:` / cgroup CFS quota, so on a capped worker
 * it would over-report the host's cores and spawn more Essentia processes than the
 * cap allows, starving the serving path. See utils/cpu-budget.ts.
 */
const MAX_ESSENTIA_CONCURRENCY = Math.max(1, getCpuBudgetCores() - 2);
const essentiaSemaphore = new AsyncSemaphore(MAX_ESSENTIA_CONCURRENCY);

/**
 * Shared, process-level semaphore for sidecar /analyze concurrency.
 *
 * The sidecar runs a single-worker uvicorn process; each /analyze request spawns
 * librosa with threads=6. Sending getCpuBudgetCores()-2 concurrent requests (e.g.
 * 10 on a 12-core host) creates ~60 threads competing with ~12 cores — CPU
 * starvation causes fetch timeouts that were incorrectly tombstoned as permanent.
 *
 * Sized off MUSIC_ANALYSIS_SIDECAR_CONCURRENCY (default 3). Initialized lazily
 * (via getter) so config reads happen after the config service is ready.
 */
let _sidecarSemaphore: AsyncSemaphore | null = null;
let _sidecarSemaphoreLimit = 0;

function getSidecarSemaphore(): AsyncSemaphore {
    const limit = Math.max(1, config.MUSIC_ANALYSIS_SIDECAR_CONCURRENCY);
    if (!_sidecarSemaphore || _sidecarSemaphoreLimit !== limit) {
        _sidecarSemaphore = new AsyncSemaphore(limit);
        _sidecarSemaphoreLimit = limit;
    }
    return _sidecarSemaphore;
}

/**
 * Run a function under the active engine's process-level concurrency gate.
 *
 * - sidecar engine → MUSIC_ANALYSIS_SIDECAR_CONCURRENCY semaphore (default 3)
 * - essentia binary → getCpuBudgetCores()-2 semaphore (unchanged behavior)
 *
 * Use this instead of creating per-job AsyncSemaphore instances.
 */
export async function withEssentiaConcurrency<T>(fn: () => Promise<T>): Promise<T> {
    if (config.MUSIC_ANALYSIS_ENGINE === 'sidecar') {
        return getSidecarSemaphore().withPermit(fn);
    }
    return essentiaSemaphore.withPermit(fn);
}

/** Current concurrency limit for the active engine (for logging). */
export function getEssentiaConcurrencyLimit(): number {
    if (config.MUSIC_ANALYSIS_ENGINE === 'sidecar') {
        return Math.max(1, config.MUSIC_ANALYSIS_SIDECAR_CONCURRENCY);
    }
    return MAX_ESSENTIA_CONCURRENCY;
}

// ============================================================================
// Types
// ============================================================================

export interface EssentiaResult {
    bpm: number;
    // key encodes mode via 'm' suffix (e.g. 'Am' for A minor)
    key: string;
    energy: number;
    danceability: number;
    loudness_lufs: number;
    beat_grid: number[];
    downbeats: number[];
    intro_end_ms: number;
    outro_start_ms: number;
    energy_curve: number[];
    mood_tags: string[];
    /** Whether the track is classified as voice or instrumental */
    vocal_instrumental: 'voice' | 'instrumental';
    /** Confidence of the voice/instrumental classification (0-1) */
    vocal_confidence: number;
    /** How outro_start_ms was computed: bar-counting, percentage fallback,
     *  fade-out detection, or the DJ-outro pull-forward (fade point moved to
     *  just after the last vocal on extended/DJ-format tracks). */
    outro_source: 'downbeat' | 'percentage' | 'fade' | 'dj-outro';
    /** End of DJ intro zone in ms (extended mixes only). Null when not a DJ-style track. */
    dj_intro_end_ms: number | null;
    /** Start of the first detected vocal phrase in ms. Null when the track is
     *  instrumental, the engine supplies no vocal-band signal (binary path), or
     *  detection was unreliable. */
    first_vocal_start_ms: number | null;
    /** End of the last detected vocal phrase in ms. Same null semantics as
     *  {@link first_vocal_start_ms}. Consumers (crossfade trigger) use it to
     *  avoid fading out while the outgoing track is still singing. */
    last_vocal_end_ms: number | null;
}

/**
 * Engine-neutral inputs the TS derivation consumes (Integration Shape A).
 *
 * Both the Essentia parser ({@link essentiaRawToFeatures}) and the sidecar adapter
 * ({@link adaptSidecarAnalysis}) produce this struct; {@link deriveAnalysis}
 * consumes it. The shared seam keeps all derivation in exactly one place — the
 * two engines differ ONLY in how they fill these fields (and in `loudnessLufs`,
 * the single behavioral branch).
 */
export interface RawAudioFeatures {
    bpm: number;
    /** Bare pitch class: "A", "C", "F#" (no 'm'). The "Am" join happens in deriveAnalysis. */
    key: string;
    /** Mode kept separate so the join lives in one place. */
    scale: 'major' | 'minor';
    /** 0..1 (Essentia average_loudness analogue). */
    averageLoudness: number;
    /** Real EBU R128 dB when known; null → derive an approximation from averageLoudness. */
    loudnessLufs: number | null;
    /** ~0..3 Essentia scale (NOT 0..1) — passed through untouched. */
    danceability: number;
    /** FULL uncapped beat times (sec), ascending. */
    beatsPosition: number[];
    /** Per-frame RMS (fade detection); null if unavailable. */
    frameRms: number[] | null;
    /** Per-frame spectral energy (energy curve); null if unavailable. */
    frameEnergy: number[] | null;
    durationSec: number;
    /** Already lowercase, deduped. */
    moodTags: string[];
    /** Engine-specific heuristic inputs for the three detectors. */
    extras: DerivationExtras;
    /**
     * Optional pre-resolved voice/instrumental verdict. Set ONLY by
     * {@link essentiaRawToFeatures} when the Gaia SVM classifier fires (binary
     * path, never in prod, never in the sidecar). When present, deriveAnalysis
     * uses it directly; otherwise it falls back to the librosa-fed heuristic.
     * This keeps the binary path byte-identical to the pre-refactor behavior.
     */
    vocalOverride?: { classification: 'voice' | 'instrumental'; confidence: number };
}

/**
 * Engine-specific heuristic inputs the three detectors need. Essentia fills these
 * from lowlevel JSON paths; the sidecar supplies librosa values plus neutral
 * nulls/zeros for the Essentia-only signals it cannot reproduce.
 */
export interface DerivationExtras {
    zcrMean: number | null;
    spectralEntropyMean: number | null;
    spectralCentroidMean: number | null;
    dynamicComplexity: number | null;
    /**
     * True when silenceRate60 was filled from a real Essentia measurement (binary
     * path). False for the sidecar — the sidecar always sends 0, so the fade
     * detector must not rely on it to gate the RMS-scan (the scan self-gates via
     * the 50–98% window check). The guard in detectArtistFadeOut checks this flag
     * before the threshold, keeping the binary path byte-identical.
     */
    hasSilenceRateHint: boolean;
    silenceRate60: number;
    /** 0 → DJ-intro profile branch. */
    spectralComplexityVar: number;
    beatsLoudnessBandRatioMean: number[] | null;
    beatsLoudnessBandRatioVar: number[] | null;
    /** Vocal-band harmonic energy ratio per bin (0..1, sidecar only). Null on
     *  the binary path — the vocal-boundary derivation then yields nulls. */
    vocalBandRatio: number[] | null;
    /** Bin size of vocalBandRatio in ms (sidecar only). */
    vocalRatioHopMs: number | null;
}

// ============================================================================
// Engine selection
// ============================================================================

type AnalysisEngine = 'essentia' | 'sidecar';

/**
 * Which analysis engine is active. Defaults to 'essentia' (the binary path —
 * zero behavior change). Set MUSIC_ANALYSIS_ENGINE='sidecar' to route through the
 * Python /analyze sidecar. Any unknown value falls back to 'essentia' in config.
 */
function selectedEngine(): AnalysisEngine {
    return config.MUSIC_ANALYSIS_ENGINE === 'sidecar' ? 'sidecar' : 'essentia';
}

// ============================================================================
// Binary detection
// ============================================================================

function getEssentiaPath(): string | null {
    const envPath = process.env.ESSENTIA_EXTRACTOR_PATH;
    if (envPath && existsSync(envPath)) return envPath;

    const commonPaths = [
        '/usr/local/bin/essentia_streaming_extractor_music',
        '/usr/bin/essentia_streaming_extractor_music',
    ];
    for (const p of commonPaths) {
        if (existsSync(p)) return p;
    }
    return null;
}

// ============================================================================
// SVM model auto-detection and profile generation
// ============================================================================

/** Directories to search for SVM .history model files */
const SVM_MODEL_DIRS = [
    process.env.ESSENTIA_MODELS_PATH,
    '/data/essentia-models',
    '/data/essentia-models/svm_models',
    '/data/essentia-models/essentia-extractor-svm_models-v2.1_beta1',
].filter(Boolean) as string[];

let _profilePath: string | null | undefined; // undefined = not checked yet

/**
 * Find or auto-generate the Essentia SVM profile YAML.
 *
 * Generates a profile that:
 * 1. Enables outputFrames (for per-frame RMS fade detection)
 * 2. Registers SVM models if a Gaia-enabled binary is available
 *
 * The pre-built static binary does NOT include Gaia, so SVM models
 * are silently ignored. But outputFrames works and is essential for
 * accurate fade-out detection.
 */
function getEssentiaProfilePath(): string | null {
    if (_profilePath !== undefined) return _profilePath;

    const envProfile = process.env.ESSENTIA_PROFILE_PATH;
    if (envProfile && existsSync(envProfile)) {
        _profilePath = envProfile;
        return _profilePath;
    }

    // One private directory per process (the path is cached above).
    // Atomic write: build under a unique temp name, then rename onto the
    // final path. Concurrent process starts cannot interleave a partial
    // YAML — readers always see either the previous file or a complete new
    // one.
    // Private 0700 dir: a fixed name in a shared tmpdir can be pre-planted.
    const profilePath = join(mkdtempSync(join(tmpdir(), 'essentia-profile-')), 'profile.yaml');
    const lines = ['outputFrames: 1'];

    // Also register SVM models if found (for Gaia-enabled binaries)
    for (const dir of SVM_MODEL_DIRS) {
        if (!existsSync(dir)) continue;
        try {
            const files = readdirSync(dir).filter((f) => f.endsWith('.history'));
            if (files.length === 0) continue;

            lines.push('highlevel:');
            for (const file of files) {
                const name = basename(file, '.history');
                lines.push(`    ${name}:`);
                lines.push(`        type: svm`);
                lines.push(`        model: ${join(dir, file)}`);
            }
            logger.info('Essentia SVM models found', {
                dir,
                models: files.length,
            });
            break;
        } catch {
            // ignore — directory not readable
        }
    }

    const tmpProfilePath = `${profilePath}.${process.pid}.tmp`;
    writeFileSync(tmpProfilePath, lines.join('\n'));
    renameSync(tmpProfilePath, profilePath);
    _profilePath = profilePath;
    return _profilePath;
}

let _essentiaAvailable: boolean | null = null;

export function isEssentiaAvailable(): boolean {
    // Sidecar mode: "available" means the /analyze URL is configured. There is no
    // local binary to probe; analyzeTrack falls back to the binary only if the URL
    // is empty (handled there).
    if (selectedEngine() === 'sidecar') {
        return Boolean(config.SONIC_ANALYZE_URL);
    }

    if (_essentiaAvailable === null) {
        _essentiaAvailable = getEssentiaPath() !== null;
        if (!_essentiaAvailable) {
            logger.warn('Essentia binary not found — music audio analysis will be skipped');
        }
    }
    return _essentiaAvailable;
}

let _essentiaUsable: boolean | null = null;

/**
 * Build a small in-memory WAV (5s, 44.1kHz stereo, 16-bit) — a 220Hz tone with
 * light noise under a 2Hz amplitude pulse. Long/rich enough to exercise the full
 * feature-computation DSP (FFT / spectral / rhythm) — which is exactly where the
 * 2015 static extractor segfaults in incompatible environments — without
 * depending on ffmpeg or a real track on disk.
 */
function synthesizeSelfTestWav(): Buffer {
    const sampleRate = 44_100;
    const channels = 2;
    const bytesPerSample = 2;
    const seconds = 5;
    const frames = sampleRate * seconds;
    const dataBytes = frames * channels * bytesPerSample;

    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataBytes, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16); // PCM fmt chunk size
    buf.writeUInt16LE(1, 20); // audioFormat = PCM
    buf.writeUInt16LE(channels, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * channels * bytesPerSample, 28); // byteRate
    buf.writeUInt16LE(channels * bytesPerSample, 32); // blockAlign
    buf.writeUInt16LE(16, 34); // bitsPerSample
    buf.write('data', 36);
    buf.writeUInt32LE(dataBytes, 40);

    let off = 44;
    for (let i = 0; i < frames; i++) {
        const t = i / sampleRate;
        const env = 0.5 + 0.5 * Math.sin(2 * Math.PI * 2 * t); // 2Hz "beat" envelope
        const sample = (Math.sin(2 * Math.PI * 220 * t) * 0.6 + (Math.random() - 0.5) * 0.2) * env;
        const v = Math.round(Math.max(-1, Math.min(1, sample)) * 32_767);
        buf.writeInt16LE(v, off);
        buf.writeInt16LE(v, off + 2);
        off += 4;
    }
    return buf;
}

/**
 * One-shot, crash-aware verification that the Essentia binary actually RUNS in
 * this environment — not merely that it's present on disk.
 *
 * `isEssentiaAvailable()` only checks the binary exists. But the bundled 2015
 * static extractor segfaults in some environments (notably Docker Desktop /
 * WSL2) while working fine on native Linux. Without this guard a present-but-
 * crashing binary logs an error for EVERY track while the feature is silently
 * dead and noisy.
 *
 * We probe once per process by analyzing a small synthetic WAV. We conclude
 * "unusable" ONLY when the probe is killed by a crash signal
 * (SIGSEGV/SIGABRT/SIGILL/SIGBUS, or the equivalent 139/134/132/135 exit codes)
 * or produces no output at all; a non-crash failure on the synthetic sample is
 * treated as inconclusive and we proceed (real tracks decide), so a healthy
 * binary is never disabled on a synthetic-input quirk. Result cached for the
 * process.
 *
 * IMPORTANT: this spawns a subprocess, so callers MUST gate it behind the
 * music-analysis feature switch (`DISABLE_MUSIC_ANALYSIS`) — never probe on an
 * instance that has analysis turned off.
 */
export async function verifyEssentiaUsable(): Promise<boolean> {
    // Sidecar mode: there is no local binary to crash-probe. The HTTP client
    // surfaces per-track failures itself, so report usable and let real /analyze
    // calls decide.
    if (selectedEngine() === 'sidecar') return true;

    if (_essentiaUsable !== null) return _essentiaUsable;
    // One probe per process even when the stage sweep (isAnalysisEngineUsable)
    // and a drain ask at the same time.
    _selfTestInFlight ??= runEssentiaSelfTest().finally(() => {
        _selfTestInFlight = null;
    });
    return _selfTestInFlight;
}

let _selfTestInFlight: Promise<boolean> | null = null;

/**
 * Synchronous "can this host analyse audio at all?" for the music-analysis
 * stage's eligibility + terminal disposition (run by the sweep every tick).
 *
 * `isEssentiaAvailable()` only proves the binary is on disk. When it is present
 * but crashes here (Docker Desktop / WSL2), the self-test verdict used to live
 * only inside the isolated drain thread, so the sweep kept every track
 * `pending` and the admin pipeline showed "Analyze Music Audio 0 of N" and
 * "N items not progressing" forever (Windows e2e 2026-09-27, S7). Now the
 * sweep's own process runs the one-shot self-test in the background on first
 * use; once it reports a crash this returns false and the rows are disposed as
 * `skipped_permanent` / 'essentia-unavailable' (reclaimed by the stage's
 * recoverWhenAdditionalReasons as soon as a restart finds a working engine).
 *
 * Until the probe finishes it answers from binary presence alone, so a healthy
 * host is never tombstoned. Never probes when music analysis is disabled.
 */
export function isAnalysisEngineUsable(): boolean {
    if (!isEssentiaAvailable()) return false;
    if (selectedEngine() === 'sidecar') return true;
    if (_essentiaUsable === false) return false;
    if (_essentiaUsable === null && !config.DISABLE_MUSIC_ANALYSIS) {
        void verifyEssentiaUsable().catch(() => {
            // runEssentiaSelfTest never rejects; belt and braces for the sweep.
        });
    }
    return true;
}

async function runEssentiaSelfTest(): Promise<boolean> {
    const essentiaPath = getEssentiaPath();
    if (!essentiaPath) {
        _essentiaUsable = false;
        return false;
    }

    const wavPath = join(tmpdir(), `essentia-selftest-${randomUUID()}.wav`);
    const outputPath = join(tmpdir(), `essentia-selftest-${randomUUID()}.json`);
    const framesPath = `${outputPath}_frames`;

    try {
        writeFileSync(wavPath, synthesizeSelfTestWav());

        const args = [wavPath, outputPath];
        const profilePath = getEssentiaProfilePath();
        if (profilePath) args.push(profilePath);

        await execFileAsync(essentiaPath, args, {
            timeout: 60_000,
            killSignal: 'SIGKILL',
        });

        // Ran to completion and wrote output → the binary works here.
        await readFile(outputPath, 'utf-8');
        _essentiaUsable = true;
        logger.info('Essentia self-test passed — binary is functional in this environment');
    } catch (error) {
        const err = error as { signal?: string | null; code?: number | string | null };
        const crashSignals = new Set(['SIGSEGV', 'SIGABRT', 'SIGILL', 'SIGBUS']);
        const crashed =
            (typeof err.signal === 'string' && crashSignals.has(err.signal)) ||
            err.code === 139 || // 128 + SIGSEGV
            err.code === 134 || // 128 + SIGABRT
            err.code === 132 || // 128 + SIGILL
            err.code === 135 || // 128 + SIGBUS
            !existsSync(outputPath);

        if (crashed) {
            _essentiaUsable = false;
            logger.warn(
                'Essentia self-test FAILED — the binary is present but crashes in this ' +
                    'environment (e.g. Docker Desktop / WSL2). Music audio analysis will be ' +
                    'skipped for this process; CLAP/sonic embeddings are unaffected.',
                { signal: err.signal, code: err.code },
            );
        } else {
            // Ran but failed for a non-crash reason on the synthetic sample — don't
            // disable a healthy binary on a synthetic-input quirk; let real tracks judge.
            _essentiaUsable = true;
            logger.warn(
                'Essentia self-test inconclusive (non-crash failure on synthetic sample); ' +
                    'proceeding with analysis.',
                { signal: err.signal, code: err.code },
            );
        }
    } finally {
        for (const p of [wavPath, outputPath, framesPath]) {
            try {
                await unlink(p);
            } catch {
                // ignore — may not exist
            }
        }
    }

    return _essentiaUsable;
}

/**
 * Readiness check for the active analysis engine.
 *
 * In sidecar mode: GET {SONIC_ANALYZE_URL}/health — returns true only on HTTP
 * 200. A 503 (model loading) or network error returns false so the caller can
 * skip cleanly without marking every track failed.
 *
 * In binary mode: delegates to the existing {@link verifyEssentiaUsable} crash-
 * probe so the behavior is byte-identical to today.
 *
 * Call this after the DISABLE_MUSIC_ANALYSIS gate, never before — the binary
 * probe spawns a subprocess and must not run on instances with analysis disabled.
 */
export async function verifyAnalysisEngineReady(): Promise<boolean> {
    if (selectedEngine() === 'sidecar') {
        const url = config.SONIC_ANALYZE_URL;
        if (!url) return false;
        try {
            // Routed through the same-origin-only redirect guard (C22
            // fix-plan finding) — SONIC_ANALYZE_URL is an admin-configured
            // host, same class as ABS/Kavita/the arr apps.
            const res = await fetchWithTimeout(`${url}/health`, {}, 5_000);
            return res.status === 200;
        } catch {
            return false;
        }
    }
    return verifyEssentiaUsable();
}

// ============================================================================
// Analysis
// ============================================================================

/** Per-frame data extracted from the Essentia _frames output file. */
interface FrameData {
    /** Per-frame RMS values for fade-out detection */
    rms: number[];
    /** Per-frame spectral energy for real energy curve */
    energy: number[];
}

/**
 * Extract per-frame arrays from the Essentia frames output file.
 *
 * Uses targeted string search instead of JSON.parse on the ~35MB file,
 * extracting only spectral_rms and spectral_energy (~60ms total).
 * Returns null if the frames file doesn't exist.
 */
async function extractFrameData(framesPath: string): Promise<FrameData | null> {
    if (!existsSync(framesPath)) return null;

    try {
        const raw = await readFile(framesPath, 'utf-8');

        const extractArray = (key: string): number[] | null => {
            const keyStr = `"${key}"`;
            const keyIdx = raw.indexOf(keyStr);
            if (keyIdx === -1) return null;
            const arrStart = raw.indexOf('[', keyIdx);
            if (arrStart === -1) return null;
            const arrEnd = raw.indexOf(']', arrStart);
            if (arrEnd === -1) return null;
            return JSON.parse(raw.substring(arrStart, arrEnd + 1)) as number[];
        };

        const rms = extractArray('spectral_rms');
        const energy = extractArray('spectral_energy');

        if (!rms || rms.length === 0) return null;

        return { rms, energy: energy ?? [] };
    } catch {
        return null;
    }
}

/**
 * Bridge to the Python sonic-embedder /analyze sidecar. Keeps the HTTP plumbing
 * in the client module; returns the raw {@link SidecarAnalysis} for one path, or
 * null when the sidecar produced a genuine per-path analysis error.
 *
 * {@link SidecarUnreachableError} (transport failure: fetch throws or HTTP non-2xx)
 * is NOT caught here — it propagates to {@link analyzeTrack} and further to the
 * task, where it is treated as transient (the track stays pending for retry).
 *
 * No `threads` is passed here — the sidecar env default governs CPU. Wiring the
 * task's per-task `cpuThreads` knob through is a non-structural follow-up
 * (`analyzeOne` already accepts an optional `threads`).
 */
async function analyzeViaSidecar(
    filePath: string,
    signal?: AbortSignal,
): Promise<SidecarAnalysis | null> {
    // SidecarUnreachableError propagates — do not catch it here. `signal` only ends a
    // wait for a busy sidecar (HTTP 429); a running analysis is never cut short.
    return analyzeOne(filePath, undefined, signal);
}

/**
 * Analyze a single audio track using Essentia CLI.
 * The CLI outputs a large JSON profile — we extract the relevant features.
 *
 * Returns null if the binary is unavailable or analysis fails.
 *
 * No AbortSignal parameter by design: the Essentia binary is a blocking
 * subprocess that can take 30-90s on a 2-hour audiobook chapter, but
 * killing it mid-run leaves partial output files in tmp and — more
 * importantly — means the track never lands a processing_state marker.
 * The plugin's soft-budget abort check fires between tracks, not
 * within; the process-level AsyncSemaphore bounds concurrency so a
 * stopped drain simply stops queuing new analyses rather than killing
 * the ones already in flight. If a future refactor needs to cut a
 * long-running analysis short, plumb the signal into the spawn here
 * AND update every caller to write a "cancelled" marker before the
 * slot releases — otherwise the cancelled track stays eligible and
 * the next drain runs it again from scratch.
 */
export async function analyzeTrack(
    filePath: string,
    signal?: AbortSignal,
): Promise<EssentiaResult | null> {
    // Sidecar mode: call the Python /analyze endpoint and adapt the raw features
    // through the SAME derivation pipeline the binary uses. Falls through to the
    // binary path when no /analyze URL is configured (SONIC_ANALYZE_URL empty).
    if (selectedEngine() === 'sidecar' && config.SONIC_ANALYZE_URL) {
        const raw = await analyzeViaSidecar(filePath, signal);
        return raw ? adaptSidecarAnalysis(raw) : null;
    }

    const essentiaPath = getEssentiaPath();
    if (!essentiaPath) return null;

    const outputPath = join(tmpdir(), `essentia-${randomUUID()}.json`);

    const framesPath = `${outputPath}_frames`;

    try {
        // essentia_streaming_extractor_music <input> <output.json> [profile.yaml]
        // With outputFrames: 1, a second file <output.json>_frames is written
        // containing per-frame feature arrays (used for fade-out detection).
        // SIGKILL ensures the process actually dies on timeout — SIGTERM can be
        // ignored by Essentia under heavy CPU load, causing zombie processes that
        // leak past the AsyncSemaphore concurrency limit.
        // The extractor decodes with libavformat and takes no -format_whitelist,
        // so refuse a playlist/manifest body here, right before it opens the file.
        await assertTranscodeInputIsMedia({ localFilePath: filePath });
        const args = [filePath, outputPath];
        const profilePath = getEssentiaProfilePath();
        if (profilePath) args.push(profilePath);

        await execFileAsync(essentiaPath, args, {
            timeout: 300_000, // 5 minute timeout (long DJ mixes need more time)
            killSignal: 'SIGKILL',
        });

        const rawJson = await readFile(outputPath, 'utf-8');
        const raw = JSON.parse(rawJson) as Record<string, unknown>;

        // Extract per-frame data from the frames file for fade-out detection
        // and real energy curve. Uses targeted string search (~60ms) instead
        // of parsing the full ~35MB JSON.
        const frameData = await extractFrameData(framesPath);

        return parseEssentiaOutput(raw, frameData);
    } catch (error) {
        logger.error('Essentia analysis failed', error as Error, {
            filePath,
        });
        return null;
    } finally {
        // Clean up both output files
        for (const path of [outputPath, framesPath]) {
            try {
                await unlink(path);
            } catch {
                // ignore — file may not exist if execFile failed before writing
            }
        }
    }
}

// ============================================================================
// Output parsing
// ============================================================================

/**
 * Safely navigate a nested object by dot-separated path.
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
    const parts = path.split('.');
    let current: unknown = obj;
    for (const part of parts) {
        if (
            current !== null &&
            typeof current === 'object' &&
            part in (current as Record<string, unknown>)
        ) {
            current = (current as Record<string, unknown>)[part];
        } else {
            return undefined;
        }
    }
    return current;
}

/**
 * Parse the raw Essentia JSON output into our structured result.
 *
 * Essentia output format has nested keys like:
 * - rhythm.bpm
 * - tonal.key_key / tonal.key_scale (or tonal.chords_key / tonal.chords_scale)
 * - lowlevel.average_loudness
 * - rhythm.beats_position (array of beat times in seconds)
 * - metadata.audio_properties.length (duration in seconds)
 * - highlevel.mood_*.value
 */
/**
 * Lowlevel heuristic voice/instrumental classifier (Method 2).
 *
 * The SVM Method-1 branch (Gaia-only) is NOT here — it is engine-specific and
 * lifted into {@link essentiaRawToFeatures}, which sets `vocalOverride` when the
 * SVM fires. {@link deriveAnalysis} uses this heuristic only as the fallback.
 *
 * Uses spectral features to estimate vocal presence:
 * - Vocals occupy 300-3400 Hz (speech) to 8000 Hz (sibilants)
 * - Vocal tracks have higher zero-crossing rate (fricatives, consonants)
 * - Vocal tracks have higher spectral entropy (more complex spectrum)
 * - Instrumental tracks have lower, more stable spectral centroid
 */
function extractVoiceInstrumental(extras: DerivationExtras): {
    classification: 'voice' | 'instrumental';
    confidence: number;
} {
    const {
        zcrMean: zcr,
        spectralEntropyMean: spectralEntropy,
        spectralCentroidMean: spectralCentroid,
        dynamicComplexity,
    } = extras;

    // Only run heuristic if we have at least 3 features to score
    const hasFeatures =
        [zcr, spectralEntropy, spectralCentroid, dynamicComplexity].filter(
            (v) => v !== undefined && v !== null,
        ).length >= 3;

    if (hasFeatures) {
        let instrumentalScore = 0;
        if (typeof zcr === 'number' && zcr < 0.055) instrumentalScore++;
        if (typeof spectralEntropy === 'number' && spectralEntropy < 7.3) instrumentalScore++;
        if (typeof spectralCentroid === 'number' && spectralCentroid < 1200) instrumentalScore++;
        if (typeof dynamicComplexity === 'number' && dynamicComplexity > 4.0) instrumentalScore++;

        if (instrumentalScore >= 3) {
            const conf = Math.min(0.5, instrumentalScore * 0.15);
            return { classification: 'instrumental', confidence: conf };
        }
    }

    // Default to 'voice' — safer (conservative outro boundary)
    return { classification: 'voice', confidence: 0 };
}

// ── Vocal-boundary derivation constants ─────────────────────────────────────
/** Smoothing window over the vocal-band ratio (ms) — spans short consonant gaps. */
const VOCAL_SMOOTH_WINDOW_MS = 1_000;
/** Minimum segment length (ms) counted as a vocal phrase — rejects one-shot blips. */
const VOCAL_MIN_SEGMENT_MS = 800;
/** Absolute threshold floor — guards near-silent tracks where p95 is tiny. */
const VOCAL_THRESHOLD_FLOOR = 0.06;
/** Fraction of the smoothed signal's p95 used as the adaptive threshold. */
const VOCAL_THRESHOLD_P95_FRACTION = 0.45;
/** Minimum fraction of the track that must be vocal for the result to be trusted. */
const VOCAL_MIN_COVERAGE = 0.05;
/** Segments shorter than this are outlier candidates at the edges (vocal chops,
 *  FX stabs in DJ outros/intros) — real sung phrases are longer. */
const VOCAL_SOLID_SEGMENT_MS = 3_000;
/** An edge segment separated from its neighbor by more than this gap AND shorter
 *  than {@link VOCAL_SOLID_SEGMENT_MS} is trimmed as an outlier. Verified on prod
 *  extended mixes: lone 1-2s chops sat 40-70s after the last real vocal block and
 *  pushed last_vocal_end_ms to seconds before track end, killing the DJ-outro blend. */
const VOCAL_EDGE_OUTLIER_GAP_MS = 20_000;

// ── DJ-outro early fade point ───────────────────────────────────────────────
/** Minimum track length for the DJ-outro pull-forward (extended-mix territory). */
const DJ_OUTRO_MIN_DURATION_SEC = 300;
/** Minimum instrumental tail after the last vocal to treat it as a DJ outro.
 *  Radio edits end within ~15s of the last vocal and must not qualify. */
const DJ_OUTRO_MIN_TAIL_MS = 30_000;
/** Never pull the fade point forward by more than this much track time —
 *  caps how much of a long outro a crossfade may replace. */
const DJ_OUTRO_MAX_TAIL_MS = 60_000;
/** Breathing room after the last vocal phrase before the fade may start (beats). */
const DJ_OUTRO_PAD_BEATS = 8;
/** A last-vocal-end this close to the track end is not a sung line: in extended
 *  mixes the vocal-band signal is held up by synth leads/pads through the mix-out
 *  (prod 2026-10-01: ~1850 DJ-intro tracks ended "vocals" within 4s of the end,
 *  falling off smoothly beyond). Such tracks fall back to mirroring the DJ intro. */
const DJ_OUTRO_VOCAL_AT_END_MS = 4_000;

/**
 * Derive first/last vocal-phrase boundaries from the sidecar's vocal-band
 * harmonic ratio signal.
 *
 * The signal (HPSS harmonic energy in 300-4000 Hz over total frame energy, one
 * value per ~100ms bin) rises during sung phrases and falls in drum-only or
 * noise-dominated passages. Detection: smooth with a ~1s moving average,
 * threshold adaptively at a fraction of the track's own 95th percentile
 * (with an absolute floor), and keep segments ≥ {@link VOCAL_MIN_SEGMENT_MS}.
 *
 * Known limitation (accepted for a heuristic without a source-separation
 * model): sustained harmonic lead instruments (synth leads, strings, pads)
 * also score high, so boundaries err toward "vocals present" — which is the
 * safe direction for the crossfade consumer (waits longer before fading).
 *
 * Returns null when: the track is classified instrumental, the signal is
 * absent (binary engine / older sidecar), or total vocal coverage is below
 * {@link VOCAL_MIN_COVERAGE} of the duration (unreliable detection).
 */
export function deriveVocalPresenceBounds(
    extras: Pick<DerivationExtras, 'vocalBandRatio' | 'vocalRatioHopMs'>,
    durationSec: number,
    isVoice: boolean,
): { firstVocalStartMs: number; lastVocalEndMs: number } | null {
    if (!isVoice) return null;
    const ratio = extras.vocalBandRatio;
    const hopMs = extras.vocalRatioHopMs;
    if (!ratio || ratio.length === 0 || !hopMs || hopMs <= 0 || durationSec <= 0) {
        return null;
    }

    // Sanity: the binned signal must roughly span the track. A large mismatch
    // means bins were dropped or truncated somewhere in transport — every
    // bin index maps to `i * hopMs`, so a shortened array would silently
    // shift all boundary timestamps instead of erroring.
    const durationMs = durationSec * 1000;
    const spanMs = ratio.length * hopMs;
    if (spanMs < durationMs * 0.75 || spanMs > durationMs * 1.25) return null;

    // Centered moving average over ~VOCAL_SMOOTH_WINDOW_MS.
    const half = Math.max(1, Math.round(VOCAL_SMOOTH_WINDOW_MS / hopMs / 2));
    const smoothed = new Array<number>(ratio.length);
    for (let i = 0; i < ratio.length; i++) {
        const start = Math.max(0, i - half);
        const end = Math.min(ratio.length - 1, i + half);
        let sum = 0;
        for (let j = start; j <= end; j++) sum += ratio[j];
        smoothed[i] = sum / (end - start + 1);
    }

    const sorted = [...smoothed].sort((a, b) => a - b);
    const p95 = sorted[Math.floor(0.95 * (sorted.length - 1))];
    const threshold = Math.max(VOCAL_THRESHOLD_FLOOR, p95 * VOCAL_THRESHOLD_P95_FRACTION);

    // Collect above-threshold segments ≥ VOCAL_MIN_SEGMENT_MS as [startBin, endBin).
    const minBins = Math.max(1, Math.round(VOCAL_MIN_SEGMENT_MS / hopMs));
    const segments: Array<[number, number]> = [];
    let runStart = -1;
    for (let i = 0; i <= smoothed.length; i++) {
        const above = i < smoothed.length && smoothed[i] >= threshold;
        if (above && runStart === -1) {
            runStart = i;
        } else if (!above && runStart !== -1) {
            if (i - runStart >= minBins) segments.push([runStart, i]);
            runStart = -1;
        }
    }

    if (segments.length === 0) return null;

    const coveredBins = segments.reduce((sum, [s, e]) => sum + (e - s), 0);
    const coverage = (coveredBins * hopMs) / durationMs;
    if (coverage < VOCAL_MIN_COVERAGE) return null;

    // Trim edge outliers: a short segment far from its neighbor is a vocal
    // chop / FX stab (common in extended-mix intros and outros), not a sung
    // phrase — without this, one lone blip near the track end drags
    // last_vocal_end_ms to seconds before the end and defeats the DJ blend.
    const solidBins = Math.max(1, Math.round(VOCAL_SOLID_SEGMENT_MS / hopMs));
    const gapBins = Math.max(1, Math.round(VOCAL_EDGE_OUTLIER_GAP_MS / hopMs));
    let lo = 0;
    let hi = segments.length - 1;
    while (hi > lo) {
        const [s, e] = segments[hi];
        if (e - s < solidBins && s - segments[hi - 1][1] > gapBins) hi--;
        else break;
    }
    while (lo < hi) {
        const [s, e] = segments[lo];
        if (e - s < solidBins && segments[lo + 1][0] - e > gapBins) lo++;
        else break;
    }

    // If trimming collapsed everything onto a single SHORT segment, the
    // track's "vocals" are one isolated chop by the outlier definition —
    // there is no reliable boundary (reachable on short tracks where two
    // mutual outliers pass the coverage gate; the trim only removes one).
    if (hi === lo && segments[lo][1] - segments[lo][0] < solidBins) return null;

    const clampMs = (v: number): number => Math.round(Math.min(durationMs, Math.max(0, v)));
    return {
        firstVocalStartMs: clampMs(segments[lo][0] * hopMs),
        lastVocalEndMs: clampMs(segments[hi][1] * hopMs),
    };
}

/**
 * Compute intro/outro boundaries based on vocal classification and beat data.
 * IMPORTANT: `downbeats` must be the UNCAPPED array (not the slice(0, 100) used for storage).
 */
function computeSmartBoundaries(
    durationSec: number,
    downbeats: number[],
    isVocal: boolean,
): {
    introEndMs: number;
    outroStartMs: number;
    source: 'downbeat' | 'percentage';
} {
    const durationMs = durationSec * 1000;

    if (downbeats.length < 4) {
        if (isVocal) {
            return {
                introEndMs: Math.round(durationMs * 0.05),
                outroStartMs: Math.round(durationMs * 0.9),
                source: 'percentage',
            };
        }
        return {
            introEndMs: Math.round(durationMs * 0.03),
            outroStartMs: Math.round(durationMs * 0.85),
            source: 'percentage',
        };
    }

    const introBars = 4;
    const outroBars = isVocal ? 4 : 8;

    const introEndSec =
        introBars < downbeats.length ? downbeats[introBars] : downbeats[downbeats.length - 1];

    const outroSlice = downbeats.slice(-outroBars);
    const outroStartSec = outroSlice[0];

    const introEndMs = Math.round(introEndSec * 1000);
    let outroStartMs = Math.round(outroStartSec * 1000);

    if (outroStartMs - introEndMs < 30_000) {
        return {
            introEndMs,
            outroStartMs: Math.round(durationMs * 0.9),
            source: 'percentage',
        };
    }

    return { introEndMs, outroStartMs, source: 'downbeat' };
}

/**
 * Detect where an artistic fade-out begins using per-frame RMS data.
 *
 * Scans backwards from the end of the track to find where the RMS level
 * last exceeded 30% of the track average. This is the point where the
 * fade-out begins — everything after is the volume ramp-down.
 *
 * Falls back to the old 85% heuristic if frame data is unavailable.
 *
 * @returns Fade-out start time in seconds, or null if no fade detected
 */
function detectArtistFadeOut(
    extras: DerivationExtras,
    durationSec: number,
    frameRms: number[] | null,
): number | null {
    const silenceRate60 = extras.silenceRate60;

    // Binary path: silence_rate_60dB < 5% means the track does not end quietly —
    // skip RMS-scan and return no fade. Sidecar path: hasSilenceRateHint is false
    // (the sidecar always sends 0 for this Essentia-only signal), so the guard
    // does NOT fire; the RMS-scan runs and self-gates via the 50–98% window check.
    if (extras.hasSilenceRateHint && silenceRate60 < 0.05) return null;

    // Method 1: Per-frame RMS analysis (accurate)
    if (frameRms && frameRms.length > 100) {
        const frameRate = frameRms.length / durationSec;
        const avg = frameRms.reduce((a, b) => a + b, 0) / frameRms.length;

        if (avg <= 0) return durationSec * 0.85; // silent track, use fallback

        const threshold = avg * 0.3;
        // 2-second sliding window, scan backwards from end
        const winSize = Math.max(1, Math.round(frameRate * 2));

        let fadeStartFrame = frameRms.length;
        for (
            let i = frameRms.length - winSize;
            i >= Math.floor(frameRms.length * 0.5);
            i -= Math.max(1, Math.round(winSize / 2))
        ) {
            let winAvg = 0;
            const end = Math.min(i + winSize, frameRms.length);
            for (let j = i; j < end; j++) winAvg += frameRms[j];
            winAvg /= end - i;

            if (winAvg >= threshold) {
                fadeStartFrame = Math.min(i + winSize, frameRms.length);
                break;
            }
        }

        const fadeStartSec = fadeStartFrame / frameRate;
        // Sanity: fade must start after 50% and before 98% of the track
        if (fadeStartSec > durationSec * 0.5 && fadeStartSec < durationSec * 0.98) {
            return fadeStartSec;
        }
        // RMS-scan ran but found no valid fade window. For the sidecar path
        // (hasSilenceRateHint=false) we have no other fade evidence — return null.
        if (!extras.hasSilenceRateHint) return null;
    }

    // Method 2: Heuristic fallback (85% of duration). Only reached on the binary
    // path (hasSilenceRateHint=true) when silenceRate60 >= 0.05 but frame data
    // is unavailable or the scan found no valid window.
    if (!extras.hasSilenceRateHint) return null;
    return durationSec * 0.85;
}

// ============================================================================
// DJ intro detection
// ============================================================================

/**
 * Detect DJ intro zones in extended mixes.
 *
 * DJ intros are long (16-64 bar) sections of repetitive kicks/percussion
 * with no vocals or melody, designed for DJs to mix into.
 *
 * Detection uses Essentia's aggregate statistics (the streaming extractor
 * outputs statistics, not per-beat arrays):
 * - `spectral_complexity.var` — high variance = distinct sections (simple intro vs complex body)
 * - `beats_loudness_band_ratio.var` — bass-band variance indicates energy distribution changes
 * - Duration, BPM range, danceability as pre-filters
 *
 * Intro length is estimated from track duration using standard DJ conventions
 * (16/32/48 bars), snapped to the nearest downbeat.
 *
 * @returns dj_intro_end_ms or null if not a DJ-style track
 */
function detectDjIntro(
    extras: DerivationExtras,
    durationSec: number,
    allDownbeats: number[],
    bpm: number,
    isInstrumental: boolean,
    danceability: number,
    moodTags: string[],
): number | null {
    // Pre-filter: only consider tracks that could be DJ/extended mixes
    if (durationSec < 240) return null; // under 4 min — not an extended mix
    if (bpm < 100 || bpm > 160) return null; // outside typical DJ BPM range
    if (allDownbeats.length < 16) return null;

    const isElectronic = moodTags.includes('electronic') || moodTags.includes('party');

    // Essentia classifies most electronic tracks as "voice" even with
    // minimal vocals, so we can't rely on isInstrumental alone. Use
    // danceability > 1.0 (Essentia's scale) as a strong electronic signal.
    const isHighDanceability = danceability > 1.0;

    // Must have at least one electronic signal
    if (!isInstrumental && !isElectronic && !isHighDanceability) return null;

    // ---------------------------------------------------------------------------
    // Spectral statistics analysis
    // ---------------------------------------------------------------------------
    // The streaming extractor outputs aggregate stats, not per-beat arrays.
    // We use spectral_complexity.var as a proxy: high variance indicates
    // the track has sections with very different spectral content (e.g.,
    // a simple percussive intro vs a spectrally rich body with vocals/synths).

    const spectralComplexityVar = extras.spectralComplexityVar;

    // Band ratio variance — high bass-band variance with low mid-band mean
    // indicates energy concentrated in bass (kicks) with sparse mid content
    const bandRatioMean = extras.beatsLoudnessBandRatioMean;
    const bandRatioVar = extras.beatsLoudnessBandRatioVar;

    let spectralScore = 0;

    // High spectral complexity variance → distinct sections
    if (spectralComplexityVar > 120) spectralScore += 1;
    if (spectralComplexityVar > 180) spectralScore += 1;

    // Bass-dominant energy distribution (band 0 = sub-bass, band 2 = mid)
    if (Array.isArray(bandRatioMean) && bandRatioMean.length >= 3) {
        const bassMean = Number(bandRatioMean[0]) || 0;
        const midMean = Number(bandRatioMean[2]) || 0;
        // DJ tracks: bass energy much higher than mid
        if (bassMean > 0.4 && midMean < 0.15) spectralScore += 1;
    }

    // High bass-band variance → energy distribution changes across track
    if (Array.isArray(bandRatioVar) && bandRatioVar.length >= 1) {
        const bassVar = Number(bandRatioVar[0]) || 0;
        if (bassVar > 0.06) spectralScore += 1;
    }

    // Need strong spectral evidence (score ≥ 2) OR the track is clearly
    // a DJ candidate (instrumental + long + high danceability)
    const isDjByStats = spectralScore >= 2;
    const isDjByProfile =
        durationSec >= 300 &&
        isHighDanceability &&
        (isInstrumental || isElectronic || danceability > 1.2);

    if (!isDjByStats && !isDjByProfile) return null;

    // ---------------------------------------------------------------------------
    // Estimate DJ intro length from duration
    // ---------------------------------------------------------------------------
    // Standard DJ intro lengths scale with track duration:
    // 4-5 min → 16 bars, 5-7 min → 32 bars, 7+ min → 48 bars
    let introBars: number;
    if (durationSec >= 420) introBars = 48;
    else if (durationSec >= 300) introBars = 32;
    else introBars = 16;

    if (introBars >= allDownbeats.length) return null;

    const djIntroEndMs = Math.round(allDownbeats[introBars] * 1000);

    // Sanity: DJ intro shouldn't exceed 40% of the track
    if (djIntroEndMs > durationSec * 1000 * 0.4) return null;

    return djIntroEndMs;
}

/**
 * Engine-neutral derivation core — the shared seam of Integration Shape A.
 *
 * This is the back half of the original `parseEssentiaOutput`: given the raw
 * features in {@link RawAudioFeatures}, it computes every derived field
 * (beat cap, downbeat decimation, energy curve, smart boundaries, fade, key join,
 * DJ intro, mood). Both the Essentia parser ({@link essentiaRawToFeatures}) and
 * the sidecar adapter ({@link adaptSidecarAnalysis}) feed this exact function, so
 * the derivation behavior is identical across engines.
 *
 * The ONLY engine-conditional branch is `loudnessLufs`: when `f.loudnessLufs` is
 * null (the binary has no real R128) we reproduce the original average-loudness
 * approximation byte-for-byte; when it is a real EBU R128 measurement (sidecar)
 * we use it verbatim.
 */
export function deriveAnalysis(f: RawAudioFeatures): EssentiaResult {
    // Beat positions: full array for boundary computation, capped to 500 for storage
    const beatPositions: number[] = f.beatsPosition.slice(0, 500);

    // Downbeats: every 4th beat (simplified 4/4 assumption), uniformly decimated
    // to 100 samples across the full track so long DJ mixes retain coverage at the end.
    const allDownbeats = f.beatsPosition.filter((_, i) => i % 4 === 0);
    const stride = Math.max(1, Math.ceil(allDownbeats.length / 100));
    const downbeats = allDownbeats.filter((_, i) => i % stride === 0).slice(0, 100);

    // Energy: normalized average_loudness (0..1)
    const energy = Math.min(1, Math.max(0, f.averageLoudness));

    // Energy curve: real per-frame data downsampled to ~10 windows,
    // or uniform fallback if frame data unavailable
    const energyCurve =
        f.frameEnergy && f.frameEnergy.length > 0
            ? computeRealEnergyCurve(f.frameEnergy, f.durationSec)
            : computeEnergyCurve(energy, f.durationSec);

    // Voice/instrumental classification: SVM override (Gaia binaries only) wins,
    // otherwise the librosa-fed lowlevel heuristic.
    const voiceInstrumental = f.vocalOverride ?? extractVoiceInstrumental(f.extras);

    // Smart intro/outro boundaries (uses full-track allDownbeats to handle long tracks)
    const boundaries = computeSmartBoundaries(
        f.durationSec,
        allDownbeats,
        voiceInstrumental.classification === 'voice',
    );
    const introEndMs = boundaries.introEndMs;
    let outroStartMs = boundaries.outroStartMs;
    let outroSource: EssentiaResult['outro_source'] = boundaries.source;

    // Check for artistic fade-out — if present, start crossfade before the fade begins
    const artistFadeStart = detectArtistFadeOut(f.extras, f.durationSec, f.frameRms);
    if (artistFadeStart !== null) {
        const fadeStartMs = Math.round(artistFadeStart * 1000);
        if (fadeStartMs < outroStartMs) {
            outroStartMs = fadeStartMs;
            outroSource = 'fade';
        }
    }

    const moodTags = f.moodTags;

    // LUFS — the ONE engine-conditional branch. Real R128 (sidecar) is used
    // verbatim; null (binary) reproduces the original average-loudness approximation.
    const loudnessLufs =
        f.loudnessLufs ??
        (f.averageLoudness > 0 ? TARGET_LUFS + (f.averageLoudness - 0.5) * 20 : TARGET_LUFS);

    // Vocal phrase boundaries (sidecar-only signal; nulls on the binary path)
    const vocalBounds = deriveVocalPresenceBounds(
        f.extras,
        f.durationSec,
        voiceInstrumental.classification === 'voice',
    );

    // DJ intro detection (extended mixes with percussive-only intros)
    const djIntroEndMs = detectDjIntro(
        f.extras,
        f.durationSec,
        allDownbeats,
        f.bpm,
        voiceInstrumental.classification === 'instrumental',
        f.danceability,
        moodTags,
    );

    // DJ-outro pull-forward: extended/DJ-format tracks (detected DJ intro is
    // the format signal — a track built with a percussive mix-in intro has a
    // matching mix-out outro) whose vocals end well before the track does get
    // their fade point moved to just after the last vocal phrase. The
    // crossfade then blends through the instrumental DJ outro the way a DJ
    // would, instead of idling through it and fading in the final bars.
    // Capped at DJ_OUTRO_MAX_TAIL_MS so a crossfade never replaces more than
    // the last minute of a track.
    if (
        vocalBounds !== null &&
        djIntroEndMs !== null &&
        f.durationSec >= DJ_OUTRO_MIN_DURATION_SEC
    ) {
        const durMs = f.durationSec * 1000;
        const tailMs = durMs - vocalBounds.lastVocalEndMs;
        let earlyMs: number | null = null;
        if (tailMs >= DJ_OUTRO_MIN_TAIL_MS) {
            const padMs = f.bpm > 0 ? (60_000 / f.bpm) * DJ_OUTRO_PAD_BEATS : 4_000;
            earlyMs = Math.round(
                Math.max(vocalBounds.lastVocalEndMs + padMs, durMs - DJ_OUTRO_MAX_TAIL_MS),
            );
        } else if (tailMs <= DJ_OUTRO_VOCAL_AT_END_MS) {
            // The vocal signal runs to the end, so it can't locate the mix-out.
            // DJ edits are symmetric: the mix-out matches the mix-in.
            earlyMs = Math.round(Math.max(durMs - djIntroEndMs, durMs - DJ_OUTRO_MAX_TAIL_MS));
        }
        if (earlyMs !== null && earlyMs < outroStartMs) {
            outroStartMs = earlyMs;
            outroSource = 'dj-outro';
        }
    }

    return {
        bpm: f.bpm,
        key: `${f.key}${f.scale === 'minor' ? 'm' : ''}`,
        energy,
        danceability: f.danceability,
        loudness_lufs: Math.round(loudnessLufs * 10) / 10,
        beat_grid: beatPositions,
        downbeats,
        intro_end_ms: introEndMs,
        outro_start_ms: outroStartMs,
        energy_curve: energyCurve,
        mood_tags: moodTags,
        vocal_instrumental: voiceInstrumental.classification,
        vocal_confidence: voiceInstrumental.confidence,
        outro_source: outroSource,
        dj_intro_end_ms: djIntroEndMs,
        first_vocal_start_ms: vocalBounds?.firstVocalStartMs ?? null,
        last_vocal_end_ms: vocalBounds?.lastVocalEndMs ?? null,
    };
}

/**
 * Map the raw Essentia JSON output into engine-neutral {@link RawAudioFeatures}.
 *
 * This keeps ALL Essentia-JSON knowledge (the `tonal.*`/`lowlevel.*`/`rhythm.*`/
 * `metadata.*` key paths, the mood-value reader, and the Gaia SVM Method-1 branch)
 * in one place. Sets `loudnessLufs: null` (the binary has no real R128, so
 * deriveAnalysis reproduces the original approximation) and sets `vocalOverride`
 * only when the SVM fires (Gaia-enabled binaries — never in prod, never in the
 * sidecar).
 */
function essentiaRawToFeatures(
    raw: Record<string, unknown>,
    frame: FrameData | null,
): RawAudioFeatures {
    const get = (path: string): unknown => getNestedValue(raw, path);

    const bpm = Number(get('rhythm.bpm')) || 0;

    // Essentia streaming extractor outputs key at tonal.key_key / tonal.key_scale
    // (NOT tonal.key_edma.key which requires a custom profile).
    // Also try chords-based key as fallback.
    const key = String(get('tonal.key_key') ?? get('tonal.chords_key') ?? 'C');
    const scaleRaw = String(get('tonal.key_scale') ?? get('tonal.chords_scale') ?? 'major');
    const scale: 'major' | 'minor' = scaleRaw === 'minor' ? 'minor' : 'major';

    const rawBeats = get('rhythm.beats_position');
    const beatsPosition: number[] = Array.isArray(rawBeats) ? (rawBeats as number[]) : [];

    const averageLoudness = Number(get('lowlevel.average_loudness')) || 0;
    const danceability = Number(get('rhythm.danceability')) || 0;
    const durationSec = Number(get('metadata.audio_properties.length')) || 0;

    const extras: DerivationExtras = {
        zcrMean: numberOrNull(get('lowlevel.zerocrossingrate.mean')),
        spectralEntropyMean: numberOrNull(get('lowlevel.spectral_entropy.mean')),
        spectralCentroidMean: numberOrNull(get('lowlevel.spectral_centroid.mean')),
        dynamicComplexity: numberOrNull(get('lowlevel.dynamic_complexity')),
        hasSilenceRateHint: true,
        silenceRate60: Number(get('lowlevel.silence_rate_60dB.mean')) || 0,
        spectralComplexityVar: Number(get('lowlevel.spectral_complexity.var')) || 0,
        beatsLoudnessBandRatioMean: numberArrayOrNull(get('rhythm.beats_loudness_band_ratio.mean')),
        beatsLoudnessBandRatioVar: numberArrayOrNull(get('rhythm.beats_loudness_band_ratio.var')),
        // The binary emits no per-frame vocal-band signal — vocal boundaries stay null.
        vocalBandRatio: null,
        vocalRatioHopMs: null,
    };

    // SVM Method-1 branch (Gaia-enabled binaries only). When it fires we resolve
    // the voice/instrumental verdict here so deriveAnalysis uses it directly.
    let vocalOverride: RawAudioFeatures['vocalOverride'];
    const svmValue = get('highlevel.voice_instrumental.value');
    const svmProbability = Number(get('highlevel.voice_instrumental.probability')) || 0;
    if (typeof svmValue === 'string' && svmProbability > 0.6) {
        if (svmValue === 'instrumental') {
            vocalOverride = { classification: 'instrumental', confidence: svmProbability };
        } else if (svmValue === 'voice') {
            vocalOverride = { classification: 'voice', confidence: svmProbability };
        }
    }

    return {
        bpm,
        key,
        scale,
        averageLoudness,
        loudnessLufs: null, // binary has no real EBU R128 — deriveAnalysis approximates
        danceability,
        beatsPosition,
        frameRms: frame?.rms ?? null,
        frameEnergy: frame?.energy ?? null,
        durationSec,
        moodTags: extractMoodTags(raw),
        extras,
        ...(vocalOverride ? { vocalOverride } : {}),
    };
}

/**
 * Parse the raw Essentia JSON output into our structured result.
 *
 * Now a thin composition: map the Essentia JSON into engine-neutral
 * {@link RawAudioFeatures}, then run the shared {@link deriveAnalysis} core. The
 * binary path in {@link analyzeTrack} calls this exactly as before.
 */
function parseEssentiaOutput(
    raw: Record<string, unknown>,
    frameData: FrameData | null = null,
): EssentiaResult {
    return deriveAnalysis(essentiaRawToFeatures(raw, frameData));
}

function computeEnergyCurve(avgEnergy: number, durationSec: number): number[] {
    // Uniform energy curve from average — fallback when frame data unavailable
    const segments = Math.min(10, Math.max(1, Math.floor(durationSec / 10)));
    const clamped = Math.round(Math.min(1, Math.max(0, avgEnergy)) * 100) / 100;
    return Array.from({ length: segments }, () => clamped);
}

/**
 * Build a real energy curve from per-frame spectral_energy data.
 * Downsamples thousands of frames into ~10 windows, normalized to 0-1.
 */
function computeRealEnergyCurve(frameEnergy: number[], durationSec: number): number[] {
    const targetSegments = Math.min(10, Math.max(1, Math.floor(durationSec / 10)));
    const framesPerSegment = Math.floor(frameEnergy.length / targetSegments);
    if (framesPerSegment === 0) return computeEnergyCurve(0.5, durationSec);

    // Average energy per segment
    const segments: number[] = [];
    for (let i = 0; i < targetSegments; i++) {
        const start = i * framesPerSegment;
        const end = Math.min(start + framesPerSegment, frameEnergy.length);
        let sum = 0;
        for (let j = start; j < end; j++) sum += frameEnergy[j];
        segments.push(sum / (end - start));
    }

    // Normalize to 0-1 range
    const max = Math.max(...segments);
    if (max <= 0) return segments.map(() => 0);
    return segments.map((v) => Math.round((v / max) * 100) / 100);
}

function extractMoodTags(raw: Record<string, unknown>): string[] {
    const get = (path: string): unknown => getNestedValue(raw, path);

    const moodPaths = [
        'highlevel.mood_acoustic.value',
        'highlevel.mood_aggressive.value',
        'highlevel.mood_electronic.value',
        'highlevel.mood_happy.value',
        'highlevel.mood_party.value',
        'highlevel.mood_relaxed.value',
        'highlevel.mood_sad.value',
    ];

    const tags: string[] = [];
    for (const path of moodPaths) {
        const value = get(path);
        if (typeof value === 'string' && value.length > 0) {
            tags.push(value.toLowerCase());
        }
    }

    return Array.from(new Set(tags));
}

// ============================================================================
// Sidecar adapter (Integration Shape A) + edge-coercion helpers
// ============================================================================

/** Finite number or `null`. Used when reading Essentia/sidecar fields that may be
 *  absent — a null cleanly signals "feature unavailable" to the detectors. */
function numberOrNull(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** A number[] when the value is a non-undefined/null array of numbers, else null. */
function numberArrayOrNull(v: unknown): number[] | null {
    if (!Array.isArray(v)) return null;
    const nums = v.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
    return nums;
}

/** Finite number, else the default. */
function finiteOr(v: unknown, d: number): number {
    return typeof v === 'number' && Number.isFinite(v) ? v : d;
}

/** Finite number, else null. */
function finiteOrNull(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Clamp x to [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
    return Math.min(hi, Math.max(lo, x));
}

/** Clamp to [0, 1]. */
function clamp01(x: number): number {
    return clamp(x, 0, 1);
}

/** Filter non-finite, then sort ascending. */
function sortedAscendingFinite(v: unknown): number[] {
    if (!Array.isArray(v)) return [];
    return v
        .filter((x): x is number => typeof x === 'number' && Number.isFinite(x))
        .sort((a, b) => a - b);
}

/** A non-empty number[] or null. */
function nonEmptyNumArrayOrNull(v: unknown): number[] | null {
    const arr = numberArrayOrNull(v);
    return arr && arr.length > 0 ? arr : null;
}

/** Lowercase, dedupe, drop empties. Order preserved (first occurrence). */
function dedupLowercase(v: unknown): string[] {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of v) {
        if (typeof x !== 'string') continue;
        const t = x.toLowerCase();
        if (t.length === 0 || seen.has(t)) continue;
        seen.add(t);
        out.push(t);
    }
    return out;
}

/** Extract the bare pitch-class root from a key string ("Am" → "A", "f#" → "F#").
 *  Strips any stray 'm' mode suffix and uppercases the root; defaults to "C". */
function normalizeKeyRoot(s: unknown): string {
    if (typeof s !== 'string') return 'C';
    const m = /^([A-Ga-g]#?)/.exec(s.trim());
    if (!m) return 'C';
    return m[1].toUpperCase();
}

/**
 * Adapt the raw sidecar /analyze JSON into an {@link EssentiaResult} by mapping it
 * to {@link RawAudioFeatures} and running the SAME {@link deriveAnalysis} core the
 * binary uses (Integration Shape A).
 *
 * Every scale contract is enforced at this boundary so a misbehaving sidecar can
 * never poison a downstream consumer:
 *  - danceability is clamped to [0, 3] (the Essentia scale — NOT 0..1) and passed
 *    through deriveAnalysis untouched;
 *  - averageLoudness → energy is clamped to [0, 1] (here AND again in deriveAnalysis);
 *  - loudness_lufs: real R128 negative dB is used verbatim, null derives a negative
 *    approximation;
 *  - key delivered as bare root + scale; the "Am" join happens once in deriveAnalysis;
 *  - beats sorted ascending; mood lowercased + deduped; beat_grid capped to 500 by
 *    deriveAnalysis (the sidecar sends the uncapped array).
 *
 * The sidecar has no Gaia SVM, so `vocalOverride` is deliberately omitted —
 * deriveAnalysis runs the librosa-fed extractVoiceInstrumental heuristic. Because
 * `extras.hasSilenceRateHint === false` the fade detector skips the
 * silenceRate60 threshold gate and runs the RMS-scan directly (self-gated by the
 * 50–98% window). Because `extras.spectralComplexityVar === 0` with empty band
 * ratios the DJ-intro detector leans on its danceability/duration profile branch.
 */
export function adaptSidecarAnalysis(j: SidecarAnalysis): EssentiaResult {
    const f: RawAudioFeatures = {
        bpm: finiteOr(j.bpm, 0),
        key: normalizeKeyRoot(j.key),
        scale: j.scale === 'minor' ? 'minor' : 'major',
        averageLoudness: clamp01(finiteOr(j.average_loudness, 0)),
        loudnessLufs: finiteOrNull(j.loudness_lufs),
        danceability: clamp(finiteOr(j.danceability, 0), 0, 3),
        beatsPosition: sortedAscendingFinite(j.beats_position),
        frameRms: nonEmptyNumArrayOrNull(j.frame_rms),
        frameEnergy: nonEmptyNumArrayOrNull(j.frame_energy),
        durationSec: finiteOr(j.duration, 0),
        moodTags: dedupLowercase(j.mood_tags),
        extras: {
            zcrMean: finiteOrNull(j.extras?.zcr_mean),
            spectralEntropyMean: finiteOrNull(j.extras?.spectral_entropy_mean),
            spectralCentroidMean: finiteOrNull(j.extras?.spectral_centroid_mean),
            dynamicComplexity: finiteOrNull(j.extras?.dynamic_complexity),
            hasSilenceRateHint: false,
            silenceRate60: finiteOr(j.extras?.silence_rate_60, 0),
            spectralComplexityVar: finiteOr(j.extras?.spectral_complexity_var, 0),
            beatsLoudnessBandRatioMean: numberArrayOrNull(j.extras?.band_ratio_mean),
            beatsLoudnessBandRatioVar: numberArrayOrNull(j.extras?.band_ratio_var),
            vocalBandRatio: numberArrayOrNull(j.extras?.vocal_band_ratio ?? null),
            vocalRatioHopMs: finiteOrNull(j.extras?.vocal_ratio_hop_ms ?? null),
        },
    };
    return deriveAnalysis(f);
}

// ============================================================================
// Storage
// ============================================================================

/**
 * Merge Essentia analysis results into a track's custom_metadata JSONB column.
 *
 * Writes all Essentia-owned fields under a dedicated `essentia` subkey so the
 * namespace is cleanly separable from scanner-written or user-tagged metadata
 * (artist, album, genre, year, ...). Existing top-level metadata and any
 * prior essentia subobject are preserved.
 */
export async function storeAnalysis(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    sql: postgres.Sql<any>,
    mediaId: string,
    result: EssentiaResult,
): Promise<void> {
    const essentiaPayload = {
        bpm: result.bpm,
        key: result.key,
        energy: result.energy,
        danceability: result.danceability,
        loudness_lufs: result.loudness_lufs,
        beat_grid: result.beat_grid,
        downbeats: result.downbeats,
        intro_end_ms: result.intro_end_ms,
        outro_start_ms: result.outro_start_ms,
        energy_curve: result.energy_curve,
        mood_tags: result.mood_tags,
        vocal_instrumental: result.vocal_instrumental,
        vocal_confidence: result.vocal_confidence,
        outro_source: result.outro_source,
        dj_intro_end_ms: result.dj_intro_end_ms,
        first_vocal_start_ms: result.first_vocal_start_ms,
        last_vocal_end_ms: result.last_vocal_end_ms,
        essentia_analyzed: true,
    };

    await sql`
        UPDATE media_items
        SET
            custom_metadata = COALESCE(custom_metadata, '{}'::jsonb)
                || jsonb_build_object(
                    'essentia',
                    COALESCE(custom_metadata->'essentia', '{}'::jsonb)
                        || ${sql.json(essentiaPayload)}::jsonb
                ),
            updated_at = NOW()
        WHERE id = ${mediaId}
    `;
}
