// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { findSidecarLyrics } from './music-scanner-utils.js';

vi.mock('../database/connection.js', () => ({ getDb: () => null }));
vi.mock('$lib/server/services/metadata-storage.service.js', async () => {
    const { access } = await import('node:fs/promises');
    return {
        metadataCentralBaseDirCandidates: () => [],
        resolveWritePath: vi.fn(),
        // alongside-only probe, like the real resolver in `alongside` mode
        resolveReadPath: vi.fn(async (opts: { mediaFilePath: string; fileName: string }) => {
            const p = join(dirname(opts.mediaFilePath), opts.fileName);
            return access(p).then(
                () => p,
                () => null,
            );
        }),
    };
});

describe('findSidecarLyrics with planted symlinks', () => {
    let lib: string;
    let outside: string;

    beforeEach(async () => {
        lib = await mkdtemp(join(tmpdir(), 'lyr-lib-'));
        outside = await mkdtemp(join(tmpdir(), 'lyr-out-'));
        await writeFile(join(outside, 'master.key'), 'TESTKEY-123');
        await writeFile(join(lib, 'Track.flac'), '');
    });
    afterEach(async () => {
        await rm(lib, { recursive: true, force: true });
        await rm(outside, { recursive: true, force: true });
    });

    it('does not return the bytes of a symlink pointing outside the library', async () => {
        await symlink(join(outside, 'master.key'), join(lib, 'Track.txt'));
        const result = await findSidecarLyrics(join(lib, 'Track.flac'));
        expect(result).toBeNull();
    });

    it('still reads a regular sidecar', async () => {
        await writeFile(join(lib, 'Track.txt'), 'la la la');
        const result = await findSidecarLyrics(join(lib, 'Track.flac'));
        expect(result?.plain).toBe('la la la');
    });
});
