// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestEvent } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    execFileSync: vi.fn(),
    execSync: vi.fn(() => {
        throw new Error('Shell execution must not be used for FFmpeg');
    }),
    config: {
        FFMPEG_PATH: '/opt/media tools/ffmpeg;$(echo injected)&binary',
        GPU_ACCELERATION: 'unknown',
    },
}));

vi.mock('child_process', async (importOriginal) => ({
    ...(await importOriginal<typeof import('child_process')>()),
    execFileSync: mocks.execFileSync,
    execSync: mocks.execSync,
}));
vi.mock('$lib/server/config.js', () => ({ config: mocks.config }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));
vi.mock('$lib/server/services/admin-cluster-core.service.js', () => ({
    getClusterCore: async () => ({
        nodes: [],
        events: [],
        totalOnline: 0,
        totalRegistered: 0,
        generatedAt: '2026-10-22T12:00:00.000Z',
    }),
}));
vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => ({ getAllActiveJobsInfoMultiPod: async () => [] }),
}));
vi.mock('$lib/server/services/bandwidth-tracker.service.js', () => ({
    bandwidthTracker: { getAggregatedMetrics: async () => undefined },
}));

async function getMetrics(): Promise<Response> {
    const { def } = await import('./system-metrics.js');
    return def.handlers.GET!({} as RequestEvent, { surface: 'internal' });
}

describe('system metrics FFmpeg probes', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.clearAllMocks();
        mocks.execFileSync.mockReset();
    });

    it('passes a configured path with spaces and shell characters literally for both probes', async () => {
        mocks.execFileSync.mockImplementation((_file: string, args: string[]): string =>
            args.includes('-filters')
                ? 'Filters:\n .S. tonemap V->V Tone mapping\n'
                : 'ffmpeg version 7.1-custom Copyright\nconfiguration: example\n',
        );

        const response = await getMetrics();
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
            ffmpegPath: mocks.config.FFMPEG_PATH,
            ffmpegVersion: '7.1-custom',
            gpu: { capabilities: ['HDR Tonemapping (CPU)'] },
            hosts: [],
            hostsGeneratedAt: '2026-10-22T12:00:00.000Z',
        });
        expect(mocks.execFileSync.mock.calls).toEqual([
            [
                mocks.config.FFMPEG_PATH,
                ['-hide_banner', '-filters'],
                { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
            ],
            [
                mocks.config.FFMPEG_PATH,
                ['-version'],
                { encoding: 'utf-8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] },
            ],
        ]);
        expect(mocks.execSync).not.toHaveBeenCalled();

        // Repeated polls retain the existing process-lifetime filter/version caches.
        await getMetrics();
        expect(mocks.execFileSync).toHaveBeenCalledTimes(2);
    });

    it('uses only the first version output line, including the fallback', async () => {
        mocks.execFileSync.mockImplementation((_file: string, args: string[]): string =>
            args.includes('-filters') ? '' : 'custom binary banner\nffmpeg version later-line\n',
        );
        expect(await (await getMetrics()).json()).toMatchObject({
            ffmpegVersion: 'custom binary banner',
        });
    });

    it('keeps metrics available when the FFmpeg executable fails', async () => {
        mocks.execFileSync.mockImplementation(() => {
            throw new Error('ENOENT');
        });
        const response = await getMetrics();
        expect(response.status).toBe(200);
        const metrics = await response.json();
        expect(metrics).not.toHaveProperty('ffmpegVersion');
        expect(metrics.gpu.capabilities).toEqual([]);
    });
});
