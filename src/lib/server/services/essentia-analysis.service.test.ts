// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ============================================================================
// Mocks (hoisted — declared before imports)
// ============================================================================

vi.mock('node:fs', () => ({
    existsSync: vi.fn(),
    writeFileSync: vi.fn(),
    renameSync: vi.fn(),
    mkdtempSync: vi.fn((prefix: string) => `${prefix}test`),
    readFileSync: vi.fn(() => ''),
    readdirSync: vi.fn(() => []),
}));

vi.mock('node:fs/promises', () => ({
    readFile: vi.fn(),
    unlink: vi.fn(),
}));

vi.mock('node:os', () => ({
    tmpdir: vi.fn(() => '/tmp'),
    // availableParallelism is consumed by cpu-budget.ts (the service no longer
    // imports it directly); keep it mocked so the host-fallback path is stable.
    availableParallelism: vi.fn(() => 4),
}));

// The file sniff opens the track with fs/promises `open`, which the fs mock above lacks.
vi.mock('./transcoding/input-guard.js', () => ({
    assertTranscodeInputIsMedia: vi.fn(async () => undefined),
}));

// The service sizes MAX_ESSENTIA_CONCURRENCY via getCpuBudgetCores() (cgroup-aware)
// instead of os.availableParallelism() directly. Mock it explicitly so the gate is
// deterministic regardless of the test host's real CPU budget: 4 cores → max(1, 4-2) = 2.
vi.mock('$lib/server/utils/cpu-budget.js', () => ({
    getCpuBudgetCores: vi.fn(() => 4),
}));

vi.mock('node:crypto', () => ({
    randomUUID: vi.fn(() => 'test-uuid-1234'),
}));

// The service now imports config (engine selector: MUSIC_ANALYSIS_ENGINE /
// SONIC_ANALYZE_URL) and the sidecar client (which also imports config). Mock
// config so the real module's JWT_SECRET → master-key → node:crypto.randomBytes
// chain never loads (our crypto mock above only exports randomUUID). Defaults keep
// the engine on 'essentia', so every binary-path assertion in this file is unchanged.
vi.mock('$lib/server/config.js', () => ({
    config: {
        MUSIC_ANALYSIS_ENGINE: 'essentia',
        SONIC_ANALYZE_URL: '',
    },
}));

// The sidecar client is only reached on the engine='sidecar' branch (never in this
// file). Stub it so its module-load doesn't drag in extra transitive deps.
// SidecarUnreachableError is imported by essentia-analysis.service.ts so we
// must export it from the mock; the class is never instantiated in these tests.
vi.mock('./music-analysis-sidecar.service.js', () => ({
    analyzeOne: vi.fn(async () => null),
    SidecarUnreachableError: class SidecarUnreachableError extends Error {
        constructor(message: string) {
            super(message);
            this.name = 'SidecarUnreachableError';
        }
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => ({
            debug: vi.fn(),
            info: vi.fn(),
            warn: vi.fn(),
            error: vi.fn(),
        })),
    },
}));

// ============================================================================
// Imports
// ============================================================================

import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import type * as EssentiaModule from './essentia-analysis.service.js';

// essentia-analysis.service.ts does:
//   const execFileAsync = promisify(execFile);
//   await execFileAsync(essentiaPath, [...], { timeout });
//
// util.promisify on a mock execFile resolves to the raw first callback
// argument (a string), but the service destructures `{}` (unused) from it.
// Actually the service call is:
//   await execFileAsync(essentiaPath, [filePath, outputPath], { timeout: 120_000 });
// It ignores the return value — it just awaits for the side effect (writing outputPath).
// Then it calls readFile(outputPath) separately.
//
// So we only need execFileAsync to resolve (or reject) — the return value
// is discarded. We mock via promisify.custom to resolve/reject on demand.

async function importFresh(opts: {
    binaryExists: boolean;
    execFileError?: Error | null;
    readFileResult?: string | Error;
    unlinkError?: Error | null;
}): Promise<{
    mod: typeof EssentiaModule;
    readFileMock: ReturnType<typeof vi.fn>;
    unlinkMock: ReturnType<typeof vi.fn>;
}> {
    vi.resetModules();

    const existsSyncFn = vi.fn().mockImplementation((p: unknown) => {
        if (!opts.binaryExists) return false;
        return (
            String(p) === '/usr/local/bin/essentia_streaming_extractor_music' ||
            String(p) === process.env.ESSENTIA_EXTRACTOR_PATH
        );
    });

    const execFileMock = Object.assign(vi.fn(), {
        [Symbol.for('nodejs.util.promisify.custom')]: vi.fn(async () => {
            if (opts.execFileError) throw opts.execFileError;
            return { stdout: '', stderr: '' };
        }),
    });

    const readFileMock = vi.fn();
    if (opts.readFileResult instanceof Error) {
        readFileMock.mockRejectedValue(opts.readFileResult);
    } else if (typeof opts.readFileResult === 'string') {
        readFileMock.mockResolvedValue(opts.readFileResult);
    } else {
        readFileMock.mockResolvedValue('');
    }

    const unlinkMock = vi.fn().mockResolvedValue(undefined);
    if (opts.unlinkError) {
        unlinkMock.mockRejectedValue(opts.unlinkError);
    }

    vi.doMock('node:fs', () => ({
        existsSync: existsSyncFn,
        writeFileSync: vi.fn(),
        renameSync: vi.fn(),
        mkdtempSync: vi.fn((prefix: string) => `${prefix}test`),
        readFileSync: vi.fn(() => ''),
        readdirSync: vi.fn(() => []),
    }));
    vi.doMock('node:child_process', () => ({ execFile: execFileMock }));
    vi.doMock('node:fs/promises', () => ({
        readFile: readFileMock,
        unlink: unlinkMock,
    }));
    vi.doMock('node:os', () => ({
        tmpdir: () => '/tmp',
        availableParallelism: () => 4,
    }));
    vi.doMock('node:crypto', () => ({ randomUUID: () => 'test-uuid-1234' }));
    // Same reason as the top-level mock: keep the fresh service import off the real
    // config/master-key/randomBytes chain and the sidecar client (binary path only).
    vi.doMock('$lib/server/config.js', () => ({
        config: { MUSIC_ANALYSIS_ENGINE: 'essentia', SONIC_ANALYZE_URL: '' },
    }));
    vi.doMock('./transcoding/input-guard.js', () => ({
        assertTranscodeInputIsMedia: vi.fn(async () => undefined),
    }));
    vi.doMock('./music-analysis-sidecar.service.js', () => ({
        analyzeOne: vi.fn(async () => null),
    }));
    vi.doMock('$lib/server/utils/logger.js', () => ({
        Logger: {
            for: vi.fn(() => ({
                debug: vi.fn(),
                info: vi.fn(),
                warn: vi.fn(),
                error: vi.fn(),
            })),
        },
    }));

    const mod = await import('./essentia-analysis.service.js');
    return { mod, readFileMock, unlinkMock };
}

// Build a minimal valid Essentia JSON output
function buildEssentiaOutput(overrides: Record<string, unknown> = {}): string {
    const base = {
        rhythm: {
            bpm: 128.5,
            danceability: 0.72,
            beats_position: [0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0],
        },
        tonal: {
            key_key: 'A',
            key_scale: 'minor',
        },
        lowlevel: {
            average_loudness: 0.65,
        },
        metadata: {
            audio_properties: { length: 210 },
        },
        highlevel: {
            mood_acoustic: { value: 'not_acoustic' },
            mood_happy: { value: 'happy' },
            mood_aggressive: { value: '' },
        },
        ...overrides,
    };
    return JSON.stringify(base);
}

const mockExistsSync = vi.mocked(existsSync);
const mockUnlink = vi.mocked(unlink);

describe('essentia-analysis.service', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockExistsSync.mockReturnValue(false);
        mockUnlink.mockResolvedValue(undefined);
    });

    afterEach(() => {
        vi.restoreAllMocks();
    });

    // -------------------------------------------------------------------------
    // isEssentiaAvailable
    // -------------------------------------------------------------------------
    describe('isEssentiaAvailable', () => {
        it('returns a boolean (does not throw)', async () => {
            const { mod } = await importFresh({ binaryExists: false });
            const result = mod.isEssentiaAvailable();
            expect(typeof result).toBe('boolean');
        });

        it('does not throw', async () => {
            const { mod } = await importFresh({ binaryExists: false });
            expect(() => mod.isEssentiaAvailable()).not.toThrow();
        });

        it('returns false when no binary exists', async () => {
            const { mod } = await importFresh({ binaryExists: false });
            expect(mod.isEssentiaAvailable()).toBe(false);
        });

        it('returns true when binary exists', async () => {
            const { mod } = await importFresh({ binaryExists: true });
            expect(mod.isEssentiaAvailable()).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // isAnalysisEngineUsable — Windows e2e S7 (binary present but crashes)
    // -------------------------------------------------------------------------
    describe('isAnalysisEngineUsable', () => {
        it('is false without a binary, and never probes', async () => {
            const { mod } = await importFresh({ binaryExists: false });
            expect(mod.isAnalysisEngineUsable()).toBe(false);
        });

        it('turns false once the background self-test sees the binary crash', async () => {
            const segv = Object.assign(new Error('killed'), { signal: 'SIGSEGV', code: null });
            const { mod } = await importFresh({ binaryExists: true, execFileError: segv });

            // Answers from binary presence until the probe finishes — a healthy
            // host is never tombstoned on a guess.
            expect(mod.isAnalysisEngineUsable()).toBe(true);
            // Shares the in-flight probe the call above started.
            await expect(mod.verifyEssentiaUsable()).resolves.toBe(false);
            expect(mod.isAnalysisEngineUsable()).toBe(false);
        });

        it('stays true when the self-test passes', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: '{}',
            });
            expect(mod.isAnalysisEngineUsable()).toBe(true);
            await expect(mod.verifyEssentiaUsable()).resolves.toBe(true);
            expect(mod.isAnalysisEngineUsable()).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // analyzeTrack — binary unavailable
    // -------------------------------------------------------------------------
    describe('analyzeTrack — binary unavailable', () => {
        it('returns null when no essentia binary is found', async () => {
            const { mod } = await importFresh({ binaryExists: false });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result).toBeNull();
        });
    });

    // -------------------------------------------------------------------------
    // analyzeTrack — successful parse
    // -------------------------------------------------------------------------
    describe('analyzeTrack — successful analysis', () => {
        it('returns an EssentiaResult with correct BPM', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result).not.toBeNull();
            expect(result!.bpm).toBeCloseTo(128.5);
        });

        it('parses key and encodes minor mode with m suffix from tonal.key_key/key_scale', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.key).toBe('Am');
        });

        it('computes energy clamped between 0 and 1', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.energy).toBeGreaterThanOrEqual(0);
            expect(result!.energy).toBeLessThanOrEqual(1);
            expect(result!.energy).toBeCloseTo(0.65);
        });

        it('extracts danceability', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.danceability).toBeCloseTo(0.72);
        });

        it('caps beat_grid to 500 entries', async () => {
            const manyBeats = Array.from({ length: 600 }, (_, i) => i * 0.5);
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput({
                    rhythm: {
                        bpm: 120,
                        danceability: 0.5,
                        beats_position: manyBeats,
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.beat_grid.length).toBeLessThanOrEqual(500);
        });

        it('derives downbeats as every 4th beat (indices 0, 4, 8 ...)', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            // 8 beat positions: indices 0 and 4 → values 0.5 and 2.5
            expect(result!.downbeats).toEqual([0.5, 2.5]);
        });

        it('computes intro_end_ms as 5% of duration in ms', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            // duration=210s → 5% = 10.5s = 10500ms
            expect(result!.intro_end_ms).toBe(10500);
        });

        it('computes outro_start_ms as 90% of duration in ms', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            // duration=210s → 90% = 189s = 189000ms
            expect(result!.outro_start_ms).toBe(189000);
        });

        it('extracts non-empty mood tags and skips empty strings', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.mood_tags).toContain('not_acoustic');
            expect(result!.mood_tags).toContain('happy');
            expect(result!.mood_tags).not.toContain('');
        });

        it('deduplicates mood tags', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput({
                    highlevel: {
                        mood_acoustic: { value: 'acoustic' },
                        mood_happy: { value: 'acoustic' },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            const tags = result!.mood_tags;
            expect(tags).toEqual([...new Set(tags)]);
        });

        it('computes loudness_lufs from average_loudness', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            // average_loudness=0.65 → -14 + (0.65 - 0.5) * 20 = -11
            expect(result!.loudness_lufs).toBe(-11);
        });

        it('uses /tmp as the output directory', async () => {
            const { mod, readFileMock } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            await mod.analyzeTrack('/music/track.flac');
            const readFilePath = readFileMock.mock.calls[0]?.[0] as string;
            expect(readFilePath).toMatch(/^\/tmp\/essentia-/);
        });

        it('cleans up temp files after a successful analysis', async () => {
            const { mod, unlinkMock } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            await mod.analyzeTrack('/music/track.flac');
            // Cleans up both the stats file and the frames file
            expect(unlinkMock).toHaveBeenCalledTimes(2);
        });
    });

    // -------------------------------------------------------------------------
    // analyzeTrack — key fallback chain
    // -------------------------------------------------------------------------
    describe('analyzeTrack — key fallback chain', () => {
        it('falls back to chords_key when key_key is absent', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: { bpm: 100, danceability: 0.4, beats_position: [] },
                    tonal: { chords_key: 'D', chords_scale: 'major' },
                    lowlevel: { average_loudness: 0.5 },
                    metadata: { audio_properties: { length: 180 } },
                    highlevel: {},
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.key).toBe('D');
        });

        it('defaults key to C (no suffix) when both key and scale are absent', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: { bpm: 100, danceability: 0.4, beats_position: [] },
                    tonal: {},
                    lowlevel: { average_loudness: 0.5 },
                    metadata: { audio_properties: { length: 180 } },
                    highlevel: {},
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.key).toBe('C');
        });
    });

    // -------------------------------------------------------------------------
    // analyzeTrack — execFile failure
    // -------------------------------------------------------------------------
    describe('analyzeTrack — execFile failure', () => {
        it('returns null when execFile rejects (binary crashed)', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                execFileError: new Error('binary crashed'),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result).toBeNull();
        });

        it('still calls unlink after execFile failure', async () => {
            const { mod, unlinkMock } = await importFresh({
                binaryExists: true,
                execFileError: new Error('binary crashed'),
            });
            await mod.analyzeTrack('/music/track.flac');
            expect(unlinkMock).toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // analyzeTrack — malformed JSON
    // -------------------------------------------------------------------------
    describe('analyzeTrack — malformed JSON output', () => {
        it('returns null for completely invalid JSON', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: 'not valid json {{{{',
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result).toBeNull();
        });

        it('returns null for empty string output', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: '',
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result).toBeNull();
        });

        it('still cleans up the temp file after a parse failure', async () => {
            const { mod, unlinkMock } = await importFresh({
                binaryExists: true,
                readFileResult: '{{invalid',
            });
            await mod.analyzeTrack('/music/track.flac');
            expect(unlinkMock).toHaveBeenCalled();
        });
    });

    // -------------------------------------------------------------------------
    // analyzeTrack — missing optional fields
    // -------------------------------------------------------------------------
    describe('analyzeTrack — missing optional fields', () => {
        it('returns zero BPM when rhythm key is absent', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0.5 },
                    metadata: { audio_properties: { length: 180 } },
                    highlevel: {},
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.bpm).toBe(0);
        });

        it('returns empty beat_grid and downbeats when beats_position is absent', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: { bpm: 120 },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0.5 },
                    metadata: { audio_properties: { length: 180 } },
                    highlevel: {},
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.beat_grid).toEqual([]);
            expect(result!.downbeats).toEqual([]);
        });

        it('returns empty mood_tags when highlevel is absent', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: { bpm: 100, danceability: 0.4, beats_position: [] },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0.5 },
                    metadata: { audio_properties: { length: 180 } },
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.mood_tags).toEqual([]);
        });

        it('returns loudness_lufs of -14 when average_loudness is 0', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: { bpm: 100, danceability: 0.4, beats_position: [] },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0 },
                    metadata: { audio_properties: { length: 180 } },
                    highlevel: {},
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.loudness_lufs).toBe(-14);
        });
    });

    // -------------------------------------------------------------------------
    // Vocal-aware intro/outro boundaries
    // -------------------------------------------------------------------------
    describe('vocal-aware intro/outro boundaries', () => {
        it('uses downbeat-based outro for vocal tracks with beats', async () => {
            const beats = Array.from({ length: 420 }, (_, i) => i * 0.5);
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 120,
                        danceability: 0.5,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0.6 },
                    metadata: { audio_properties: { length: 210 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'voice',
                            probability: 0.85,
                        },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.outro_start_ms).toBeGreaterThan(189000);
            expect(result!.outro_source).toBe('downbeat');
        });

        it('uses downbeat-based intro for vocal tracks with beats', async () => {
            const beats = Array.from({ length: 420 }, (_, i) => i * 0.5);
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 120,
                        danceability: 0.5,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0.6 },
                    metadata: { audio_properties: { length: 210 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'voice',
                            probability: 0.85,
                        },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.intro_end_ms).toBe(8000);
        });

        it('falls back to percentage for vocal tracks without beats', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: { bpm: 0, danceability: 0.5, beats_position: [] },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0.6 },
                    metadata: { audio_properties: { length: 210 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'voice',
                            probability: 0.85,
                        },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.outro_start_ms).toBe(Math.round(210 * 0.9 * 1000));
            expect(result!.outro_source).toBe('percentage');
        });

        it('uses wider boundaries for instrumental tracks', async () => {
            const beats = Array.from({ length: 420 }, (_, i) => i * 0.5);
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 120,
                        danceability: 0.5,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0.6 },
                    metadata: { audio_properties: { length: 210 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'instrumental',
                            probability: 0.9,
                        },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.outro_start_ms).toBe(194000);
            expect(result!.outro_source).toBe('downbeat');
        });

        it('handles long tracks with many downbeats correctly', async () => {
            const beats = Array.from({ length: 1280 }, (_, i) => i * (60 / 128));
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 128,
                        danceability: 0.5,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0.6 },
                    metadata: { audio_properties: { length: 600 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'voice',
                            probability: 0.8,
                        },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.outro_start_ms).toBeGreaterThan(580000);
            expect(result!.downbeats.length).toBeLessThanOrEqual(100);
        });

        it('stores voice_instrumental classification', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 120,
                        danceability: 0.5,
                        beats_position: [0, 0.5],
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0.6 },
                    metadata: { audio_properties: { length: 210 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'voice',
                            probability: 0.85,
                        },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.vocal_instrumental).toBe('voice');
            expect(result!.vocal_confidence).toBeCloseTo(0.85);
        });

        it('defaults to voice when voice_instrumental is absent', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.vocal_instrumental).toBe('voice');
        });

        it('detects DJ intro via spectral statistics (high complexity variance + bass-dominant)', async () => {
            // 6-minute electronic track at 128 BPM with DJ intro characteristics:
            // high spectral complexity variance, bass-dominant band ratios
            const beats = Array.from({ length: 768 }, (_, i) => i * (60 / 128));

            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 128,
                        danceability: 1.3,
                        beats_position: beats,
                        // Statistics format (not per-beat arrays)
                        beats_loudness_band_ratio: {
                            mean: [0.51, 0.24, 0.09, 0.07, 0.05],
                            var: [0.09, 0.05, 0.012, 0.009, 0.003],
                        },
                    },
                    tonal: { key_key: 'A', key_scale: 'minor' },
                    lowlevel: {
                        average_loudness: 0.7,
                        spectral_complexity: {
                            mean: 17,
                            var: 160,
                        },
                    },
                    metadata: { audio_properties: { length: 360 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'voice',
                            probability: 0.6,
                        },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/extended-mix.flac');
            expect(result).not.toBeNull();
            expect(result!.dj_intro_end_ms).not.toBeNull();
            // 6 min = 360s → 32 bars for 5-7 min tracks
            expect(result!.dj_intro_end_ms!).toBeGreaterThan(30_000);
            expect(result!.dj_intro_end_ms!).toBeLessThan(90_000);
        });

        it('returns null dj_intro_end_ms for short tracks (< 4 min)', async () => {
            const beats = Array.from({ length: 200 }, (_, i) => i * 0.5);
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 128,
                        danceability: 0.85,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'A', key_scale: 'minor' },
                    lowlevel: { average_loudness: 0.7 },
                    metadata: { audio_properties: { length: 180 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'instrumental',
                            probability: 0.9,
                        },
                        mood_electronic: { value: 'electronic' },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/short.flac');
            expect(result!.dj_intro_end_ms).toBeNull();
        });

        it('returns null dj_intro_end_ms for vocal pop tracks', async () => {
            const beats = Array.from({ length: 600 }, (_, i) => i * 0.5);
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 95,
                        danceability: 0.4,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: { average_loudness: 0.6 },
                    metadata: { audio_properties: { length: 300 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'voice',
                            probability: 0.85,
                        },
                        mood_happy: { value: 'happy' },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/pop.flac');
            expect(result!.dj_intro_end_ms).toBeNull();
        });

        it('detects DJ intro by profile (high danceability + long track)', async () => {
            // 6-minute voice track with very high danceability (club remix)
            const beats = Array.from({ length: 768 }, (_, i) => i * (60 / 128));
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 128,
                        danceability: 1.4,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'A', key_scale: 'minor' },
                    lowlevel: { average_loudness: 0.7 },
                    metadata: { audio_properties: { length: 360 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'voice',
                            probability: 0.7,
                        },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/club-remix.flac');
            expect(result).not.toBeNull();
            // 6 min = 360s → 32 bars for 5-7 min tracks
            expect(result!.dj_intro_end_ms).not.toBeNull();
            expect(result!.dj_intro_end_ms!).toBeGreaterThan(30_000);
        });

        it('returns null dj_intro_end_ms for tracks outside DJ BPM range', async () => {
            const beats = Array.from({ length: 600 }, (_, i) => i * 0.5);
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 80,
                        danceability: 0.85,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'A', key_scale: 'minor' },
                    lowlevel: { average_loudness: 0.7 },
                    metadata: { audio_properties: { length: 420 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'instrumental',
                            probability: 0.9,
                        },
                        mood_electronic: { value: 'electronic' },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/slow.flac');
            expect(result!.dj_intro_end_ms).toBeNull();
        });

        it('detects artistic fade-out and adjusts outro boundary', async () => {
            const beats = Array.from({ length: 420 }, (_, i) => i * 0.5);
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 120,
                        danceability: 0.5,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: {
                        average_loudness: 0.6,
                        silence_rate_60dB: { mean: 0.08 },
                    },
                    metadata: { audio_properties: { length: 210 } },
                    highlevel: {
                        voice_instrumental: {
                            value: 'voice',
                            probability: 0.85,
                        },
                    },
                }),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.outro_source).toBe('fade');
            // Without frame data, falls back to 85% heuristic
            expect(result!.outro_start_ms).toBe(Math.round(210 * 0.85 * 1000));
        });
    });

    // -------------------------------------------------------------------------
    // Voice/instrumental lowlevel heuristic
    // -------------------------------------------------------------------------
    describe('voice/instrumental lowlevel heuristic', () => {
        it('classifies as instrumental when lowlevel features match (low ZCR, low centroid, high dynamic complexity)', async () => {
            const beats = Array.from({ length: 400 }, (_, i) => i * 0.5);
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 100,
                        danceability: 0.5,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: {
                        average_loudness: 0.5,
                        // Instrumental signature: low ZCR, low entropy, low centroid, high dynamic complexity
                        zerocrossingrate: { mean: 0.03 },
                        spectral_entropy: { mean: 6.5 },
                        spectral_centroid: { mean: 900 },
                        dynamic_complexity: 5.5,
                    },
                    metadata: { audio_properties: { length: 200 } },
                    highlevel: {}, // No SVM data
                }),
            });
            const result = await mod.analyzeTrack('/music/orchestral.flac');
            expect(result!.vocal_instrumental).toBe('instrumental');
            expect(result!.vocal_confidence).toBeGreaterThan(0);
        });

        it('defaults to voice when lowlevel features do not match instrumental profile', async () => {
            const beats = Array.from({ length: 400 }, (_, i) => i * 0.5);
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 120,
                        danceability: 0.8,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: {
                        average_loudness: 0.8,
                        // Vocal signature: high ZCR, high entropy, high centroid
                        zerocrossingrate: { mean: 0.09 },
                        spectral_entropy: { mean: 8.0 },
                        spectral_centroid: { mean: 1800 },
                        dynamic_complexity: 2.5,
                    },
                    metadata: { audio_properties: { length: 200 } },
                    highlevel: {}, // No SVM data
                }),
            });
            const result = await mod.analyzeTrack('/music/vocal.flac');
            expect(result!.vocal_instrumental).toBe('voice');
        });

        it('defaults to voice when lowlevel features are missing', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.vocal_instrumental).toBe('voice');
        });

        it('instrumental gets 8-bar outro (longer than vocal 4-bar)', async () => {
            const beats = Array.from({ length: 400 }, (_, i) => i * 0.5);
            const { mod: modInstr } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 100,
                        danceability: 0.5,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: {
                        average_loudness: 0.5,
                        zerocrossingrate: { mean: 0.03 },
                        spectral_entropy: { mean: 6.5 },
                        spectral_centroid: { mean: 900 },
                        dynamic_complexity: 5.5,
                    },
                    metadata: { audio_properties: { length: 200 } },
                    highlevel: {},
                }),
            });
            const instrResult = await modInstr.analyzeTrack('/music/orchestral.flac');

            const { mod: modVocal } = await importFresh({
                binaryExists: true,
                readFileResult: JSON.stringify({
                    rhythm: {
                        bpm: 100,
                        danceability: 0.5,
                        beats_position: beats,
                    },
                    tonal: { key_key: 'C', key_scale: 'major' },
                    lowlevel: {
                        average_loudness: 0.5,
                        zerocrossingrate: { mean: 0.09 },
                        spectral_entropy: { mean: 8.0 },
                        spectral_centroid: { mean: 1800 },
                        dynamic_complexity: 2.5,
                    },
                    metadata: { audio_properties: { length: 200 } },
                    highlevel: {},
                }),
            });
            const vocalResult = await modVocal.analyzeTrack('/music/vocal.flac');

            // Instrumental outro starts earlier (8 bars from end vs 4 bars)
            expect(instrResult!.outro_start_ms).toBeLessThan(vocalResult!.outro_start_ms);
        });
    });

    // -------------------------------------------------------------------------
    // Real energy curve
    // -------------------------------------------------------------------------
    describe('energy curve', () => {
        it('produces uniform curve when no frame data (fallback)', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            // All segments should be the same value (uniform from average)
            const curve = result!.energy_curve;
            expect(curve.length).toBeGreaterThan(0);
            const allSame = curve.every((v) => v === curve[0]);
            expect(allSame).toBe(true);
        });
    });

    // -------------------------------------------------------------------------
    // dj_intro_end_ms is stored (including null)
    // -------------------------------------------------------------------------
    describe('dj_intro_end_ms storage', () => {
        it('returns null dj_intro_end_ms for normal tracks', async () => {
            const { mod } = await importFresh({
                binaryExists: true,
                readFileResult: buildEssentiaOutput(),
            });
            const result = await mod.analyzeTrack('/music/track.flac');
            expect(result!.dj_intro_end_ms).toBeNull();
        });
    });
});
