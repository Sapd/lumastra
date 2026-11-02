// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A volume whose statfs fails or times out is reported in `unmeasured`, not
 * dropped, and the transcode scratch directory is measured alongside the
 * config volume.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('$lib/server/database/connection.js', () => ({ getAdminDb: () => ({}) }));
vi.mock('$lib/server/database/queries/library-paths.queries.js', () => ({
    getEnabledLibraryPaths: async () => [{ id: 'p1', path: '/mnt/nas' }],
}));
vi.mock('$lib/server/config/config.service.js', () => ({
    getConfigFilePath: () => '/config/settings.json',
}));
vi.mock('$lib/server/config.js', () => ({
    config: { FFMPEG_TRANSCODE_DIR: '/tmp/lumastra-transcode' },
}));
vi.mock('$lib/server/utils/safe-fs.js', async (orig) => {
    const actual = await orig<typeof import('$lib/server/utils/safe-fs.js')>();
    return {
        ...actual,
        safeStatfs: async (path: string) => {
            if (path === '/mnt/nas') throw new actual.FsTimeoutError('statfs', path, 4000);
            return { blocks: 100, bsize: 4096, bavail: 50 };
        },
    };
});

const memoryVersion = vi.hoisted(() => ({ v1: false }));
afterEach(() => {
    memoryVersion.v1 = false;
});

vi.mock('node:fs/promises', async (orig) => ({
    ...(await orig<typeof import('node:fs/promises')>()),
    readFile: vi.fn(async (path: string) => {
        if (memoryVersion.v1) {
            if (path === '/sys/fs/cgroup/memory/memory.limit_in_bytes') return '1000';
            if (path === '/sys/fs/cgroup/memory/memory.usage_in_bytes') return '900';
            if (path === '/sys/fs/cgroup/memory/memory.stat') return 'total_inactive_file 300\n';
            throw new Error('missing');
        }
        if (path === '/sys/fs/cgroup/memory.max') return '1000';
        if (path === '/sys/fs/cgroup/memory.current') return '900';
        if (path === '/sys/fs/cgroup/memory.stat') return 'anon 500\ninactive_file 300\n';
        throw new Error('missing');
    }),
}));

import { readHostPressure } from './host-pressure.js';

describe('readHostPressure volumes', () => {
    it('reports a timed-out mount and measures the transcode scratch', async () => {
        const p = await readHostPressure();
        expect(p.unmeasured).toEqual([{ path: '/mnt/nas', label: '/mnt/nas', reason: 'timeout' }]);
        expect(p.volumes.map((v) => v.label)).toEqual(['Config & cache', 'Transcode scratch']);
        expect(p.pathsLookupFailed).toBe(false);
    });
});

it('reports the same working set as cluster metrics, excluding inactive file cache', async () => {
    expect((await readHostPressure()).memory.usageBytes).toBe(600);
});

it('uses total_inactive_file for the cgroup v1 working set', async () => {
    memoryVersion.v1 = true;
    expect((await readHostPressure()).memory).toMatchObject({
        usageBytes: 600,
        source: 'cgroup-v1',
    });
});
