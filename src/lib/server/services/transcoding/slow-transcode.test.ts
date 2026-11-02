// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import {
    RECOVER_AFTER_MS,
    RESUME_GRACE_MS,
    SLOW_AFTER_MS,
    STARTUP_GRACE_MS,
    isSlow,
    observeSpeed,
    restartSlowTracking,
    slowTranscodeReason,
    startSlowTracking,
    softwareEncoderFor,
    softwareFallbackPreset,
    toSoftwareDecision,
    type SlowTranscodeState,
} from './slow-transcode.js';
import type { TranscodeJob } from './types.js';

/** Feed one reading every 500 ms (FFmpeg's stats period) from `from` to `to`. */
function feed(state: SlowTranscodeState, speed: number, from: number, to: number): void {
    for (let t = from; t <= to; t += 500) observeSpeed(state, speed, t);
}

describe('slow transcode hysteresis', () => {
    it('ignores a slow start: readings inside the startup grace never count', () => {
        const state = startSlowTracking(0);
        feed(state, 0.2, 0, STARTUP_GRACE_MS - 500);
        expect(isSlow(state, STARTUP_GRACE_MS)).toBe(false);
        expect(state.belowSince).toBeUndefined();
    });

    it('turns slow only after the speed stayed below 1x for the whole window', () => {
        const state = startSlowTracking(0);
        const start = STARTUP_GRACE_MS;
        feed(state, 0.6, start, start + SLOW_AFTER_MS - 500);
        expect(isSlow(state, start + SLOW_AFTER_MS - 500)).toBe(false);
        observeSpeed(state, 0.6, start + SLOW_AFTER_MS);
        expect(isSlow(state, start + SLOW_AFTER_MS)).toBe(true);
    });

    it('reports the reading that flips the state, once each way (for the log line)', () => {
        const state = startSlowTracking(0);
        const start = STARTUP_GRACE_MS;
        const flips: string[] = [];
        for (let t = start; t <= start + SLOW_AFTER_MS + 2000; t += 500) {
            const flip = observeSpeed(state, 0.45, t);
            if (flip) flips.push(flip);
        }
        const back = start + SLOW_AFTER_MS + 2500;
        for (let t = back; t <= back + RECOVER_AFTER_MS + 2000; t += 500) {
            const flip = observeSpeed(state, 2, t);
            if (flip) flips.push(flip);
        }
        expect(flips).toEqual(['slow', 'recovered']);
    });

    it('a short dip does not flag the job', () => {
        const state = startSlowTracking(0);
        const start = STARTUP_GRACE_MS;
        feed(state, 0.5, start, start + 6000);
        observeSpeed(state, 1.5, start + 6500);
        feed(state, 0.5, start + 7000, start + 7000 + SLOW_AFTER_MS - 500);
        expect(isSlow(state, start + 7000 + SLOW_AFTER_MS - 500)).toBe(false);
    });

    it('clears only after the speed held 1.1x for the recovery window', () => {
        const state = startSlowTracking(0);
        const start = STARTUP_GRACE_MS;
        feed(state, 0.5, start, start + SLOW_AFTER_MS);
        expect(state.slow).toBe(true);

        const recover = start + SLOW_AFTER_MS + 500;
        feed(state, 1.4, recover, recover + RECOVER_AFTER_MS - 500);
        expect(isSlow(state, recover + RECOVER_AFTER_MS - 500)).toBe(true);
        observeSpeed(state, 1.4, recover + RECOVER_AFTER_MS);
        expect(isSlow(state, recover + RECOVER_AFTER_MS)).toBe(false);
    });

    it('readings between 1.0x and 1.1x hold the current state either way', () => {
        const slow = startSlowTracking(0);
        feed(slow, 0.5, STARTUP_GRACE_MS, STARTUP_GRACE_MS + SLOW_AFTER_MS);
        feed(slow, 1.05, 30_000, 60_000);
        expect(isSlow(slow, 60_000)).toBe(true);

        const fine = startSlowTracking(0);
        feed(fine, 1.05, STARTUP_GRACE_MS, 60_000);
        expect(isSlow(fine, 60_000)).toBe(false);
    });

    it('an encoder that stops printing progress after low readings still reads slow', () => {
        const state = startSlowTracking(0);
        const start = STARTUP_GRACE_MS;
        feed(state, 0.3, start, start + 2000);
        // No more readings at all — FFmpeg is stuck in the encoder.
        expect(isSlow(state, start + SLOW_AFTER_MS)).toBe(true);
        expect(state.slow).toBe(false);
    });

    it('a throttle pause/resume clears the flag and starts a short grace', () => {
        const state = startSlowTracking(0);
        feed(state, 0.5, STARTUP_GRACE_MS, STARTUP_GRACE_MS + SLOW_AFTER_MS);
        expect(state.slow).toBe(true);

        const resumedAt = 60_000;
        const next = restartSlowTracking(state, resumedAt);
        expect(isSlow(next, resumedAt)).toBe(false);
        // The stale pre-pause reading the job still carries is ignored.
        feed(next, 0.5, resumedAt, resumedAt + RESUME_GRACE_MS - 500);
        expect(next.belowSince).toBeUndefined();
    });

    it('ignores non-finite readings', () => {
        const state = startSlowTracking(0);
        observeSpeed(state, Number.NaN, STARTUP_GRACE_MS);
        observeSpeed(state, Number.POSITIVE_INFINITY, STARTUP_GRACE_MS);
        expect(state.belowSince).toBeUndefined();
        expect(state.aboveSince).toBeUndefined();
    });
});

describe('slowTranscodeReason', () => {
    type ReasonJob = Parameters<typeof slowTranscodeReason>[0];
    const slowState = (): SlowTranscodeState => ({ ignoreUntil: 0, slow: true });
    const live = { exitCode: null, signalCode: null } as unknown as TranscodeJob['process'];
    const decision = (
        overrides: Partial<NonNullable<TranscodeJob['transcodeDecisionResult']>>,
    ): TranscodeJob['transcodeDecisionResult'] =>
        ({
            videoAction: 'transcode',
            audioAction: 'copy',
            useGpu: false,
            needsTonemapping: false,
            ...overrides,
        }) as TranscodeJob['transcodeDecisionResult'];
    const job = (overrides: Partial<ReasonJob> = {}): ReasonJob => ({
        slowTranscode: slowState(),
        status: 'running',
        process: live,
        transcodeDecisionResult: decision({}),
        ...overrides,
    });

    it('names a busy GPU when the job encodes on the GPU', () => {
        const gpu = job({
            transcodeDecisionResult: decision({ useGpu: true, gpuEncoder: 'hevc_nvenc' }),
        });
        expect(slowTranscodeReason(gpu, 1000)).toBe('gpu_busy');
    });

    it('names the CPU for a software encode, including one that replaced the GPU', () => {
        expect(slowTranscodeReason(job(), 1000)).toBe('cpu_slow');
    });

    it("a 'ready' job (master playlist written) is still judged while it encodes", () => {
        expect(slowTranscodeReason(job({ status: 'ready' }), 1000)).toBe('cpu_slow');
    });

    it('never flags a copy job or a throttle-paused one', () => {
        expect(
            slowTranscodeReason(
                job({ transcodeDecisionResult: decision({ videoAction: 'copy' }) }),
                1000,
            ),
        ).toBeUndefined();
        expect(slowTranscodeReason(job({ throttledAt: new Date() }), 1000)).toBeUndefined();
    });

    it('a process that has exited is not slow any more, whatever it last measured', () => {
        const exited = { exitCode: 0, signalCode: null } as unknown as TranscodeJob['process'];
        const killed = {
            exitCode: null,
            signalCode: 'SIGTERM',
        } as unknown as TranscodeJob['process'];
        expect(slowTranscodeReason(job({ process: exited }), 1000)).toBeUndefined();
        expect(slowTranscodeReason(job({ process: killed }), 1000)).toBeUndefined();
        expect(slowTranscodeReason(job({ process: null }), 1000)).toBeUndefined();
        expect(slowTranscodeReason(job({ status: 'stopped' }), 1000)).toBeUndefined();
        expect(slowTranscodeReason(job({ status: 'error' }), 1000)).toBeUndefined();
    });
});

describe('toSoftwareDecision', () => {
    const gpu = {
        mode: 'full',
        reasons: 0,
        videoAction: 'transcode',
        audioAction: 'copy',
        useGpu: true,
        gpuEncoder: 'hevc_nvenc',
        gpuDecoder: 'hevc_cuvid',
        targetCodec: { video: 'hevc_nvenc', audio: 'aac' },
        needsTonemapping: true,
        preserveHdr10: false,
    } as NonNullable<TranscodeJob['transcodeDecisionResult']>;

    it('drops the GPU and swaps a GPU encoder name in targetCodec for the same codec', () => {
        expect(toSoftwareDecision(gpu)).toMatchObject({
            useGpu: false,
            gpuEncoder: undefined,
            gpuDecoder: undefined,
            targetCodec: { video: 'libx265', audio: 'aac' },
            videoAction: 'transcode',
            needsTonemapping: true,
        });
        // The input is not mutated.
        expect(gpu.targetCodec?.video).toBe('hevc_nvenc');
    });

    it('keeps a software target as it is', () => {
        const sw = { ...gpu, targetCodec: { video: 'libx264' } };
        expect(toSoftwareDecision(sw).targetCodec?.video).toBe('libx264');
        expect(toSoftwareDecision({ ...gpu, targetCodec: undefined }).targetCodec).toBeUndefined();
    });

    it.each([
        ['hevc_nvenc', 'libx265'],
        ['h264_qsv', 'libx264'],
        ['av1_nvenc', 'libsvtav1'],
        ['hevc_videotoolbox', 'libx265'],
    ])('%s → %s', (gpuEncoder, software) => {
        expect(softwareEncoderFor(gpuEncoder)).toBe(software);
    });
});

describe('softwareFallbackPreset', () => {
    it('ultrafast above 1080p, superfast otherwise', () => {
        expect(softwareFallbackPreset('veryfast', 2160)).toBe('ultrafast');
        expect(softwareFallbackPreset('medium', 1080)).toBe('superfast');
        expect(softwareFallbackPreset('veryfast', undefined)).toBe('superfast');
    });

    it('never slower than what is configured', () => {
        expect(softwareFallbackPreset('ultrafast', 720)).toBe('ultrafast');
        expect(softwareFallbackPreset('superfast', 2160)).toBe('ultrafast');
        expect(softwareFallbackPreset('not-a-preset', 720)).toBe('superfast');
    });
});
