// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({ stat: vi.fn(), probe: vi.fn() }));
vi.mock('node:fs/promises', () => ({ stat: mocks.stat }));
vi.mock('$lib/server/utils/ffprobe.js', () => ({ probeMediaFile: mocks.probe }));

import { probeMediaFileCached, clearProbeCache } from './probe-cache.js';

const OK = { success: true };

beforeEach(() => {
    vi.clearAllMocks();
    clearProbeCache();
    mocks.stat.mockResolvedValue({ size: 10, mtimeMs: 1 });
    mocks.probe.mockResolvedValue(OK);
});

describe('probeMediaFileCached', () => {
    it('spawns ffprobe once for an unchanged file', async () => {
        await probeMediaFileCached('/a.mkv', 5000);
        await probeMediaFileCached('/a.mkv', 5000);
        expect(mocks.probe).toHaveBeenCalledTimes(1);
        expect(mocks.probe).toHaveBeenCalledWith('/a.mkv', 5000);
    });

    it('concurrent callers share one probe', async () => {
        await Promise.all([
            probeMediaFileCached('/a.mkv', 5000),
            probeMediaFileCached('/a.mkv', 5000),
            probeMediaFileCached('/a.mkv', 5000),
        ]);
        expect(mocks.probe).toHaveBeenCalledTimes(1);
    });

    it('probes again when the size or mtime changed', async () => {
        await probeMediaFileCached('/a.mkv', 5000);
        mocks.stat.mockResolvedValue({ size: 10, mtimeMs: 2 });
        await probeMediaFileCached('/a.mkv', 5000);
        mocks.stat.mockResolvedValue({ size: 11, mtimeMs: 2 });
        await probeMediaFileCached('/a.mkv', 5000);
        expect(mocks.probe).toHaveBeenCalledTimes(3);
    });

    it('does not cache a failed probe', async () => {
        mocks.probe.mockResolvedValueOnce({ success: false });
        expect((await probeMediaFileCached('/a.mkv', 5000)).success).toBe(false);
        expect((await probeMediaFileCached('/a.mkv', 5000)).success).toBe(true);
        expect(mocks.probe).toHaveBeenCalledTimes(2);
    });

    it('does not cache a rejected probe', async () => {
        mocks.probe.mockRejectedValueOnce(new Error('spawn'));
        await expect(probeMediaFileCached('/a.mkv', 5000)).rejects.toThrow('spawn');
        await expect(probeMediaFileCached('/a.mkv', 5000)).resolves.toEqual(OK);
    });

    it('probes (uncached) when the file cannot be stat-ed', async () => {
        mocks.stat.mockRejectedValue(new Error('ENOENT'));
        await probeMediaFileCached('/gone.mkv', 5000);
        await probeMediaFileCached('/gone.mkv', 5000);
        expect(mocks.probe).toHaveBeenCalledTimes(2);
    });
});
