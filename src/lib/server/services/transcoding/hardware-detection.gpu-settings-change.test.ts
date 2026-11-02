// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A failed encoder probe is cached for the life of the process, and the probe
 * args bake in VAAPI_DEVICE. Saving a corrected GPU setting must reach the
 * cache through the config-change listener, so the next transcode re-probes
 * against the new device instead of staying on "no GPU" until a restart.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { spawnMock, config, listeners } = vi.hoisted(() => ({
    spawnMock: vi.fn(),
    config: {
        GPU_ACCELERATION: 'vaapi',
        VAAPI_DEVICE: '/dev/dri/wrong',
        QSV_DEVICE: '',
        ALLOW_HEVC_ENCODING: true,
        ALLOW_AV1_ENCODING: true,
    } as Record<string, unknown>,
    listeners: [] as Array<(keys: readonly string[] | null) => void>,
}));

vi.mock('../../config.js', () => ({ config }));
vi.mock('../../config/index.js', () => ({
    onConfigChange: (fn: (keys: readonly string[] | null) => void) => {
        listeners.push(fn);
        return () => undefined;
    },
}));
// No nvidia-smi: the NVENC AV1 check cannot confirm the card, so it prunes.
vi.mock('child_process', () => ({
    execFile: (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) =>
        cb(new Error('nvidia-smi: not found')),
}));
vi.mock('../../utils/ffmpeg-spawn.js', () => ({
    spawnFFmpegSafely: (...args: unknown[]) => spawnMock(...args),
}));
vi.mock('../../utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('../../cache/valkey.js', () => ({
    cacheGet: vi.fn(async () => null),
    cacheSet: vi.fn(async () => true),
}));
vi.mock('../../cache/decode-deny-bus.js', () => ({
    publishDecodeDenySync: vi.fn(),
    onRemoteDecodeDenyLearn: vi.fn(),
    onRemoteDecodeDenyReset: vi.fn(),
}));

import { hardwareDetection, HardwareDetectionService } from './hardware-detection.js';

const WORKING_DEVICE = '/dev/dri/renderD128';

/** What the save path does in every process: config changes, listeners fire. */
function saveConfig(updates: Record<string, unknown>): void {
    Object.assign(config, updates);
    for (const fn of listeners) fn(Object.keys(updates));
}

function probeSpawns(): string[][] {
    return spawnMock.mock.calls
        .map((c) => (c[0] as { args: string[] }).args)
        .filter((args) => args.includes('-vaapi_device'));
}

beforeEach(() => {
    spawnMock.mockReset();
    // Capability listing + a one-frame encode that only works on the real device.
    spawnMock.mockImplementation(async ({ args }: { args: string[] }) => {
        if (args[0] === '-encoders') {
            return {
                stdout:
                    ' V..... h264_vaapi           H.264/AVC (VAAPI)\n' +
                    ' V..... av1_nvenc            NVIDIA NVENC av1\n',
                stderr: '',
            };
        }
        if (args[0] === '-version') return { stdout: 'ffmpeg version 7.1', stderr: '' };
        if (args.includes('-vaapi_device')) {
            const device = args[args.indexOf('-vaapi_device') + 1];
            if (device !== WORKING_DEVICE) throw new Error('Failed to open VAAPI device');
            return { stdout: '', stderr: '' };
        }
        return { stdout: '', stderr: '' };
    });
    saveConfig({ GPU_ACCELERATION: 'vaapi', VAAPI_DEVICE: '/dev/dri/wrong' });
    hardwareDetection.refreshAllProbes();
});

describe('GPU settings change clears the hardware probe cache', () => {
    it('re-probes with the new VAAPI_DEVICE after the setting is saved', async () => {
        expect(await hardwareDetection.getBestEncoder('h264')).toBeNull();
        // Cached: a second transcode does not re-probe on its own.
        expect(await hardwareDetection.getBestEncoder('h264')).toBeNull();
        expect(probeSpawns()).toHaveLength(1);

        saveConfig({ VAAPI_DEVICE: WORKING_DEVICE });

        expect(await hardwareDetection.getBestEncoder('h264')).toBe('h264_vaapi');
        const spawns = probeSpawns();
        expect(spawns).toHaveLength(2);
        expect(spawns[1]).toContain(WORKING_DEVICE);
    });

    it('re-probes after GPU_ACCELERATION is switched back on', async () => {
        saveConfig({ VAAPI_DEVICE: WORKING_DEVICE });
        spawnMock.mockRejectedValueOnce(new Error('device busy'));
        expect(await hardwareDetection.probeEncoder('h264_vaapi')).toBe(false);

        saveConfig({ GPU_ACCELERATION: 'none' });
        saveConfig({ GPU_ACCELERATION: 'vaapi' });

        expect(await hardwareDetection.getBestEncoder('h264')).toBe('h264_vaapi');
    });

    it('leaves the cache alone when a save does not touch the GPU settings', async () => {
        expect(await hardwareDetection.getBestEncoder('h264')).toBeNull();
        saveConfig({ ALLOW_HEVC_ENCODING: false });
        // A reload after another replica's save reports no keys at all.
        for (const fn of listeners) fn(null);

        expect(await hardwareDetection.getBestEncoder('h264')).toBeNull();
        expect(probeSpawns()).toHaveLength(1);
    });

    it('drops a tone-map probe result that was measured on the old device', async () => {
        let finish!: (ok: boolean) => void;
        spawnMock.mockImplementationOnce(
            () =>
                new Promise((resolve, reject) => {
                    finish = (ok) =>
                        ok ? resolve({ stdout: '', stderr: '' }) : reject(new Error('no HDR'));
                }),
        );
        const stale = hardwareDetection.probeVaapiHdrTonemap();

        saveConfig({ VAAPI_DEVICE: WORKING_DEVICE });
        finish(false);

        // The caller that was waiting gets the current device's answer, and the
        // old device's "no hardware tone-map" does not stick.
        expect(await stale).toBe(true);
        expect(hardwareDetection.supportsVaapiHdrTonemap()).toBe(true);
        expect(probeSpawns().at(-1)).toContain(WORKING_DEVICE);
    });

    it('re-detects capabilities, so switching to NVENC prunes the unconfirmed av1_nvenc', async () => {
        // Detected under VA-API: the NVENC-only AV1 prune does not apply.
        await hardwareDetection.refreshCapabilities();
        expect(hardwareDetection.getCachedCapabilities()?.encoders).toContain('av1_nvenc');

        saveConfig({ GPU_ACCELERATION: 'nvenc' });

        // No cold window while the new detection runs, then the pruned list.
        expect(hardwareDetection.getCachedCapabilities()).not.toBeNull();
        await vi.waitFor(() =>
            expect(hardwareDetection.getCachedCapabilities()?.encoders).not.toContain('av1_nvenc'),
        );
        expect(await hardwareDetection.getBestEncoder('av1')).toBeNull();
    });

    it('does not hand callers a detection that started under the old settings', async () => {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const base = spawnMock.getMockImplementation()!;
        spawnMock.mockImplementation(async (opts: { args: string[] }) => {
            if (opts.args[0] === '-encoders') await gate;
            return base(opts);
        });
        // Force a cold cache with a detection in flight.
        const fresh = new HardwareDetectionService();
        const old = fresh.getCapabilities();

        saveConfig({ GPU_ACCELERATION: 'nvenc' });
        fresh.resetForGpuSettingsChange();
        const after = fresh.getCapabilities();
        release();

        await old;
        expect((await after).encoders).not.toContain('av1_nvenc');
        expect(fresh.getCachedCapabilities()?.encoders).not.toContain('av1_nvenc');
    });
});
