// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks -----------------------------------------------------------------

const mockGetCapabilities = vi.fn();
const mockProbeEncoder = vi.fn();
const mockGetNvidiaGpuName = vi.fn();

vi.mock('./hardware-detection.js', () => ({
    hardwareDetection: {
        getCapabilities: (...args: unknown[]) => mockGetCapabilities(...args),
        probeEncoder: (...args: unknown[]) => mockProbeEncoder(...args),
        getNvidiaGpuName: (...args: unknown[]) => mockGetNvidiaGpuName(...args),
    },
}));

vi.mock('$lib/server/config', () => ({
    config: { VAAPI_DEVICE: '/dev/dri/renderD128' },
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

const mockExistsSync = vi.fn();
const mockReaddirSync = vi.fn();
const mockReadFileSync = vi.fn();

vi.mock('fs', () => ({
    existsSync: (...args: unknown[]) => mockExistsSync(...args),
    readdirSync: (...args: unknown[]) => mockReaddirSync(...args),
    readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}));

import { detectGpuForOnboarding } from './gpu-detection.js';

// --- Helpers ---------------------------------------------------------------

function caps(encoders: string[]): unknown {
    return {
        encoders,
        decoders: [],
        hwaccels: [],
        filters: [],
        ffmpegVersion: 'x',
        detected: true,
    };
}

/** Make the host look like it has no DRM render node (NVIDIA-only / CPU box). */
function noRenderNode(): void {
    mockExistsSync.mockReturnValue(false);
    mockReaddirSync.mockReturnValue([]);
}

/** Make the host look like it exposes NVIDIA device nodes (no nvidia-smi name). */
function withNvidiaDevice(): void {
    mockExistsSync.mockImplementation((p: string) => p === '/dev/nvidiactl');
}

/** Make the host look like it has a VAAPI/QSV render node. */
function withRenderNode(): void {
    mockExistsSync.mockReturnValue(true);
}

describe('detectGpuForOnboarding', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetNvidiaGpuName.mockResolvedValue(null);
        mockProbeEncoder.mockResolvedValue(false);
        noRenderNode();
    });

    it('reports no GPU when FFmpeg capabilities are unavailable', async () => {
        mockGetCapabilities.mockResolvedValue({ detected: false, encoders: [] });

        const result = await detectGpuForOnboarding();

        expect(result.ffmpegReady).toBe(false);
        expect(result.recommended).toBeNull();
        expect(result.candidates).toEqual([]);
        expect(mockProbeEncoder).not.toHaveBeenCalled();
    });

    it('degrades to no-GPU (not throw) when the capability probe rejects', async () => {
        mockGetCapabilities.mockRejectedValue(new Error('ffmpeg missing'));

        const result = await detectGpuForOnboarding();

        expect(result.ffmpegReady).toBe(false);
        expect(result.recommended).toBeNull();
    });

    it('recommends NVENC when a working NVIDIA encoder is verified', async () => {
        mockGetCapabilities.mockResolvedValue(caps(['h264_nvenc', 'libx264']));
        mockGetNvidiaGpuName.mockResolvedValue('NVIDIA GeForce RTX 4070');
        mockProbeEncoder.mockImplementation(async (e: string) => e === 'h264_nvenc');

        const result = await detectGpuForOnboarding();

        expect(result.recommended).toBe('nvenc');
        expect(result.recommendedVendor).toBe('NVIDIA GeForce RTX 4070');
        expect(result.candidates).toHaveLength(1);
        expect(result.candidates[0]).toMatchObject({ accel: 'nvenc', works: true });
    });

    it('does not recommend a GPU when the only candidate fails its probe', async () => {
        withNvidiaDevice();
        mockGetCapabilities.mockResolvedValue(caps(['h264_nvenc']));
        mockProbeEncoder.mockResolvedValue(false);

        const result = await detectGpuForOnboarding();

        expect(result.recommended).toBeNull();
        expect(result.candidates[0]).toMatchObject({ accel: 'nvenc', works: false });
    });

    it('falls through to VAAPI (AMD) when NVENC is listed but its probe fails', async () => {
        withRenderNode();
        mockReadFileSync.mockReturnValue('0x1002\n'); // AMD PCI vendor id
        mockGetNvidiaGpuName.mockResolvedValue('NVIDIA GeForce RTX 3090');
        mockGetCapabilities.mockResolvedValue(caps(['h264_nvenc', 'h264_vaapi']));
        mockProbeEncoder.mockImplementation(async (e: string) => e === 'h264_vaapi');

        const result = await detectGpuForOnboarding();

        expect(result.recommended).toBe('vaapi');
        expect(result.recommendedVendor).toBe('AMD (VAAPI)');
    });

    it('prefers NVENC over QSV when both work', async () => {
        withRenderNode();
        mockGetNvidiaGpuName.mockResolvedValue('NVIDIA GeForce RTX 4070');
        mockGetCapabilities.mockResolvedValue(caps(['h264_nvenc', 'h264_qsv']));
        mockProbeEncoder.mockResolvedValue(true);

        const result = await detectGpuForOnboarding();

        expect(result.recommended).toBe('nvenc');
        // Both backends were probed and recorded.
        expect(result.candidates.map((c) => c.accel).sort()).toEqual(['nvenc', 'qsv']);
    });

    it('skips the NVENC probe on a host with no NVIDIA GPU or device nodes', async () => {
        // FFmpeg lists h264_nvenc (compiled in), but nvidia-smi is silent and
        // there is no /dev/nvidia*: a probe could only fail.
        mockGetCapabilities.mockResolvedValue(caps(['h264_nvenc', 'libx264']));

        const result = await detectGpuForOnboarding();

        expect(result.recommended).toBeNull();
        expect(result.candidates).toEqual([]);
        expect(mockProbeEncoder).not.toHaveBeenCalled();
    });

    it('still probes NVENC when only the NVIDIA device node is visible', async () => {
        withNvidiaDevice();
        mockGetCapabilities.mockResolvedValue(caps(['h264_nvenc']));
        mockProbeEncoder.mockResolvedValue(true);

        const result = await detectGpuForOnboarding();

        expect(result.recommended).toBe('nvenc');
        expect(result.recommendedVendor).toBe('NVIDIA');
    });

    it('skips QSV/VAAPI probes entirely when no render node is present', async () => {
        // QSV is listed by FFmpeg, but with no /dev/dri device it must not be probed.
        mockGetCapabilities.mockResolvedValue(caps(['h264_qsv', 'h264_vaapi']));

        const result = await detectGpuForOnboarding();

        expect(result.recommended).toBeNull();
        expect(result.candidates).toEqual([]);
        expect(mockProbeEncoder).not.toHaveBeenCalled();
    });

    it('labels an Intel VAAPI node from sysfs', async () => {
        withRenderNode();
        mockReadFileSync.mockReturnValue('0x8086');
        mockGetCapabilities.mockResolvedValue(caps(['h264_vaapi']));
        mockProbeEncoder.mockResolvedValue(true);

        const result = await detectGpuForOnboarding();

        expect(result.recommended).toBe('vaapi');
        expect(result.recommendedVendor).toBe('Intel (VAAPI)');
    });
});
