// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDetect = vi.fn();

vi.mock('$lib/server/services/cluster-heartbeat.service.js', () => ({
    readClusterNodes: async () => [],
    HEARTBEAT_TTL_SECONDS: 30,
}));

vi.mock('$lib/server/services/transcoding/gpu-detection.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/services/transcoding/gpu-detection.js')>()),
    detectGpuForOnboarding: (...args: unknown[]) => mockDetect(...args),
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));

vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));

describe('GET /api/setup/gpu-detect', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns the detection result fields', async () => {
        mockDetect.mockResolvedValue({
            ffmpegReady: true,
            recommended: 'nvenc',
            recommendedVendor: 'NVIDIA GeForce RTX 4070',
            candidates: [{ accel: 'nvenc', encoder: 'h264_nvenc', vendor: 'NVIDIA', works: true }],
        });

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(res.ok).toBe(true);
        expect(body.ffmpegReady).toBe(true);
        expect(body.recommended).toBe('nvenc');
        expect(body.recommendedVendor).toBe('NVIDIA GeForce RTX 4070');
        expect(body.candidates).toHaveLength(1);
    });

    it('surfaces the no-GPU result', async () => {
        mockDetect.mockResolvedValue({
            ffmpegReady: true,
            recommended: null,
            recommendedVendor: null,
            candidates: [],
        });

        const { GET } = await import('./+server.js');
        const res = await (GET as (event: unknown) => Promise<Response>)({});
        const body = await res.json();

        expect(res.ok).toBe(true);
        expect(body.recommended).toBeNull();
        expect(body.candidates).toEqual([]);
    });
});
