// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for POST /api/setup/library-probe — samples a candidate folder and
 * reports whether its contents match the chosen media type. All filesystem
 * access mocked via `safe-fs`; `isPathReadable` mocked via `dependency-checks`.
 * Covers: video/audio classification + mismatch detection, empty and mixed
 * folders, unreadable paths, symlinked directories never being followed, and
 * the bounded-walk caps (depth, file count, directory count).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockIsPathReadable, mockSafeReaddir } = vi.hoisted(() => ({
    mockIsPathReadable: vi.fn(),
    mockSafeReaddir: vi.fn(),
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/preflight/dependency-checks.js', () => ({
    isPathReadable: (...a: unknown[]) => mockIsPathReadable(...a),
}));
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeReaddir: (...a: unknown[]) => mockSafeReaddir(...a),
}));

/** Minimal Dirent-like stubs. */
function file(name: string) {
    return { name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
}
function dir(name: string) {
    return { name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
}
function symlinkedDir(name: string) {
    // A real fs.Dirent for a symlink reports isSymbolicLink() true and
    // isDirectory() false (the dirent type is "symlink", not "directory" —
    // following it would require an extra stat this walk deliberately skips).
    return { name, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true };
}

const callPost = async (body: unknown) => {
    const { POST } = await import('./+server.js');
    const event = {
        request: new Request('http://localhost/test', {
            method: 'POST',
            body: JSON.stringify(body),
        }),
    };
    return (POST as (event: unknown) => Promise<Response>)(event);
};

describe('POST /api/setup/library-probe', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockIsPathReadable.mockResolvedValue(true);
        mockSafeReaddir.mockRejectedValue(new Error('ENOENT'));
    });

    it('rejects a malformed body', async () => {
        const res = await callPost('not an object');
        expect(res.status).toBe(422);
    });

    it('rejects a non-absolute path', async () => {
        const res = await callPost({ path: 'relative/path', mediaType: 'movie' });
        expect(res.status).toBe(422);
    });

    it('rejects an unknown media type', async () => {
        const res = await callPost({ path: '/data/movies', mediaType: 'nope' });
        expect(res.status).toBe(422);
    });

    it('reports readable:false without walking when the path is unreadable', async () => {
        mockIsPathReadable.mockResolvedValue(false);
        const res = await callPost({ path: '/data/missing', mediaType: 'movie' });
        const body = await res.json();

        expect(body).toEqual({ ok: true, readable: false });
        expect(mockSafeReaddir).not.toHaveBeenCalled();
    });

    it('video folder + movie type -> no mismatch', async () => {
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data/movies') {
                return [
                    file('movie1.mkv'),
                    file('movie2.mp4'),
                    file('folder.jpg'),
                    file('movie.nfo'),
                ];
            }
            throw new Error('ENOENT');
        });

        const res = await callPost({ path: '/data/movies', mediaType: 'movie' });
        const body = await res.json();

        expect(body.ok).toBe(true);
        expect(body.readable).toBe(true);
        expect(body.inferredKind).toBe('video');
        expect(body.mismatch).toBe(false);
        expect(body.filesSampled).toBe(4);
    });

    it('flac folder + movie type -> mismatch true', async () => {
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data/music-in-movies') {
                return [file('track1.flac'), file('track2.flac'), file('track3.flac')];
            }
            throw new Error('ENOENT');
        });

        const res = await callPost({ path: '/data/music-in-movies', mediaType: 'movie' });
        const body = await res.json();

        expect(body.inferredKind).toBe('audio');
        expect(body.mismatch).toBe(true);
    });

    it('empty folder -> inferredKind empty, mismatch false', async () => {
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data/empty') return [];
            throw new Error('ENOENT');
        });

        const res = await callPost({ path: '/data/empty', mediaType: 'movie' });
        const body = await res.json();

        expect(body.inferredKind).toBe('empty');
        expect(body.mismatch).toBe(false);
        expect(body.filesSampled).toBe(0);
    });

    it('mixed video+audio folder -> mismatch false', async () => {
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data/mixed') {
                return [
                    file('a.mkv'),
                    file('b.mkv'),
                    file('c.mkv'),
                    file('d.mkv'),
                    file('e.flac'),
                    file('f.flac'),
                ];
            }
            throw new Error('ENOENT');
        });

        const res = await callPost({ path: '/data/mixed', mediaType: 'movie' });
        const body = await res.json();

        expect(body.inferredKind).toBe('mixed');
        expect(body.mismatch).toBe(false);
    });

    it('never follows a symlinked directory', async () => {
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data/symtest') return [symlinkedDir('linked'), file('real.mkv')];
            throw new Error('ENOENT');
        });

        const res = await callPost({ path: '/data/symtest', mediaType: 'movie' });
        const body = await res.json();

        expect(body.filesSampled).toBe(1);
        expect(body.inferredKind).toBe('video');
        expect(mockSafeReaddir).not.toHaveBeenCalledWith('/data/symtest/linked');
    });

    it('reports top-5 sample extensions by count', async () => {
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data/many-exts') {
                return [
                    ...Array.from({ length: 5 }, (_, i) => file(`v${i}.mkv`)),
                    ...Array.from({ length: 3 }, (_, i) => file(`s${i}.srt`)),
                    file('folder.jpg'),
                    file('movie.nfo'),
                ];
            }
            throw new Error('ENOENT');
        });

        const res = await callPost({ path: '/data/many-exts', mediaType: 'movie' });
        const body = await res.json();

        expect(body.sampleExtensions[0]).toEqual({ ext: 'mkv', count: 5 });
        expect(body.sampleExtensions.length).toBeLessThanOrEqual(5);
    });

    it('caps the walk at 200 sampled files even when a folder has more', async () => {
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data/huge') {
                return Array.from({ length: 250 }, (_, i) => file(`f${i}.mkv`));
            }
            throw new Error('ENOENT');
        });

        const res = await callPost({ path: '/data/huge', mediaType: 'movie' });
        const body = await res.json();

        expect(body.filesSampled).toBe(200);
    });

    it('stops recursing past depth 3', async () => {
        // /data/deep -> l1 -> l2 -> l3 -> l4 (l4 must never be walked: depth 4).
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data/deep') return [dir('l1')];
            if (path === '/data/deep/l1') return [dir('l2')];
            if (path === '/data/deep/l1/l2') return [dir('l3')];
            if (path === '/data/deep/l1/l2/l3') return [dir('l4'), file('found.mkv')];
            if (path === '/data/deep/l1/l2/l3/l4') return [file('too-deep.mkv')];
            throw new Error('ENOENT');
        });

        const res = await callPost({ path: '/data/deep', mediaType: 'movie' });
        const body = await res.json();

        expect(body.filesSampled).toBe(1); // only found.mkv, not too-deep.mkv
        expect(mockSafeReaddir).not.toHaveBeenCalledWith('/data/deep/l1/l2/l3/l4');
    });

    it('stops after visiting 100 directories', async () => {
        // A wide tree of 150 empty subdirectories under the root.
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data/wide') {
                return Array.from({ length: 150 }, (_, i) => dir(`d${i}`));
            }
            if (path.startsWith('/data/wide/d')) return [];
            throw new Error('ENOENT');
        });

        const res = await callPost({ path: '/data/wide', mediaType: 'movie' });
        const body = await res.json();

        // Root + up to 99 subdirs = 100 dirsVisited cap; some subdirs never read.
        const wideSubdirCalls = mockSafeReaddir.mock.calls.filter(([p]) =>
            String(p).startsWith('/data/wide/d'),
        );
        expect(wideSubdirCalls.length).toBeLessThan(150);
        expect(body.inferredKind).toBe('empty');
    });
});
