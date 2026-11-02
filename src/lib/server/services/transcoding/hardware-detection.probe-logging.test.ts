// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A failing encoder probe (e.g. h264_nvenc on a CPU-only host) is an expected
 * measurement: the spawn must be marked `expectFailure` so the spawn helper does
 * not log ERROR + the whole ffmpeg banner, and our own log is a one-line info.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn();
const infoMock = vi.fn();
const warnMock = vi.fn();
const errorMock = vi.fn();

vi.mock('../../utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: (...args: unknown[]) => spawnMock(...args),
}));

vi.mock('../../utils/logger.js', () => ({
    Logger: {
        for: () => ({
            debug: vi.fn(),
            info: (...a: unknown[]) => infoMock(...a),
            warn: (...a: unknown[]) => warnMock(...a),
            error: (...a: unknown[]) => errorMock(...a),
        }),
    },
}));

vi.mock('../../cache/valkey.js', () => ({
    cacheGet: vi.fn(async () => null),
    cacheSet: vi.fn(async () => true),
    cacheDel: vi.fn(async () => 1),
}));

vi.mock('../../cache/decode-deny-bus.js', () => ({
    publishDecodeDenySync: vi.fn(),
    onRemoteDecodeDenyLearn: vi.fn(),
    onRemoteDecodeDenyReset: vi.fn(),
}));

import { hardwareDetection, summarizeProbeFailure } from './hardware-detection.js';

const BANNER = [
    'ffmpeg version 7.1 Copyright (c) 2000-2024 the FFmpeg developers',
    '  built with gcc 12',
    '  configuration: --enable-nvenc',
    '[vost#0:0/h264_nvenc @ 0x1] Could not open encoder before EOF',
    'Error while opening encoder - maybe incorrect parameters such as bit_rate',
].join('\n');

describe('encoder probe failure logging', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        hardwareDetection.refreshAllProbes();
    });

    it('marks the probe spawn as an expected failure', async () => {
        spawnMock.mockRejectedValue(new Error(BANNER));

        await expect(hardwareDetection.probeEncoder('h264_nvenc')).resolves.toBe(false);

        expect(spawnMock).toHaveBeenCalledTimes(1);
        expect(spawnMock.mock.calls[0]![0]).toMatchObject({ expectFailure: true });
    });

    it('logs a one-line reason at info, never warn/error, with no banner', async () => {
        spawnMock.mockRejectedValue(new Error(BANNER));

        await hardwareDetection.probeEncoder('h264_nvenc');

        expect(warnMock).not.toHaveBeenCalled();
        expect(errorMock).not.toHaveBeenCalled();
        const call = infoMock.mock.calls.find((c) => String(c[0]).includes('probe failed'));
        expect(call).toBeDefined();
        const meta = call![1] as { encoder: string; reason: string };
        expect(meta.encoder).toBe('h264_nvenc');
        expect(meta.reason).not.toContain('\n');
        expect(meta.reason).toContain('Error while opening encoder');
    });

    it('summarizeProbeFailure keeps the last non-empty line and caps its length', () => {
        expect(summarizeProbeFailure(new Error('a\nb\n\n'))).toBe('b');
        expect(summarizeProbeFailure('x'.repeat(500))).toHaveLength(200);
        expect(summarizeProbeFailure(new Error(''))).toBe('unknown');
    });
});
