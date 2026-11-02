// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for GET /api/setup/library-mounts — the no-input candidate-folder
 * suggestion endpoint for the first-run wizard. All filesystem access mocked via
 * `safe-fs`; verifies missing roots are skipped, output is sorted (non-empty
 * before empty, then alphabetical), and both the per-root and total candidate
 * caps are respected.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockSafeStat, mockSafeReaddir } = vi.hoisted(() => ({
    mockSafeStat: vi.fn(),
    mockSafeReaddir: vi.fn(),
}));

vi.mock('$lib/server/middleware/auth.js', () => ({
    requireAdmin: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/middleware/error-handler.js', () => ({
    withErrorHandler: (fn: (event: unknown) => unknown) => fn,
}));
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeStat: (...a: unknown[]) => mockSafeStat(...a),
    safeReaddir: (...a: unknown[]) => mockSafeReaddir(...a),
}));

/** Minimal Dirent-like stub. */
function direntDir(name: string) {
    return { name, isDirectory: () => true, isFile: () => false, isSymbolicLink: () => false };
}
function direntFile(name: string) {
    return { name, isDirectory: () => false, isFile: () => true, isSymbolicLink: () => false };
}

const callGet = async () => {
    const { GET } = await import('./+server.js');
    return (GET as (event: unknown) => Promise<Response>)({});
};

describe('GET /api/setup/library-mounts', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: no root exists.
        mockSafeStat.mockRejectedValue(new Error('ENOENT'));
        mockSafeReaddir.mockRejectedValue(new Error('ENOENT'));
    });

    it('skips roots that do not exist', async () => {
        const res = await callGet();
        const body = await res.json();
        expect(body).toEqual({ candidates: [] });
    });

    it('lists immediate child directories, skipping dotdirs and non-media names, sorted non-empty first then alphabetically', async () => {
        mockSafeStat.mockImplementation(async (path: string) => {
            if (path === '/data') return { isDirectory: () => true };
            throw new Error('ENOENT');
        });
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data') {
                return [
                    direntDir('.hidden'),
                    direntDir('lost+found'),
                    direntDir('b'),
                    direntDir('a'),
                ];
            }
            if (path === '/data/b') return [];
            if (path === '/data/a') return [direntFile('one.mkv'), direntFile('two.mkv')];
            throw new Error('ENOENT');
        });

        const res = await callGet();
        const body = await res.json();

        expect(body.candidates).toEqual([
            { path: '/data/a', entries: 2 },
            { path: '/data/b', entries: 0 },
        ]);
    });

    it('includes the root itself as a candidate when it directly contains files', async () => {
        mockSafeStat.mockImplementation(async (path: string) => {
            if (path === '/music') return { isDirectory: () => true };
            throw new Error('ENOENT');
        });
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/music') return [direntFile('song.flac'), direntFile('other.flac')];
            throw new Error('ENOENT');
        });

        const res = await callGet();
        const body = await res.json();

        expect(body.candidates).toEqual([{ path: '/music', entries: 2 }]);
    });

    it('drops a candidate whose readdir errors (permission/timeout) rather than failing the request', async () => {
        mockSafeStat.mockImplementation(async (path: string) => {
            if (path === '/data') return { isDirectory: () => true };
            throw new Error('ENOENT');
        });
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data') return [direntDir('locked'), direntDir('ok')];
            if (path === '/data/locked') throw new Error('EACCES');
            if (path === '/data/ok') return [];
            throw new Error('ENOENT');
        });

        const res = await callGet();
        const body = await res.json();

        expect(body.candidates).toEqual([{ path: '/data/ok', entries: 0 }]);
    });

    it('replaces a folder that groups libraries with its library subfolders', async () => {
        mockSafeStat.mockImplementation(async (path: string) => {
            if (path === '/data') return { isDirectory: () => true };
            throw new Error('ENOENT');
        });
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data') return [direntDir('media')];
            if (path === '/data/media') {
                return [direntDir('movies'), direntDir('series'), direntDir('.cache')];
            }
            if (path === '/data/media/movies') return [direntDir('Alien (1979)')];
            if (path === '/data/media/series') return [];
            throw new Error('ENOENT');
        });

        const res = await callGet();
        const body = await res.json();

        expect(body.candidates).toEqual([
            { path: '/data/media/movies', entries: 1 },
            { path: '/data/media/series', entries: 0 },
        ]);
    });

    it('keeps a movies folder of per-title folders as one candidate', async () => {
        mockSafeStat.mockImplementation(async (path: string) => {
            if (path === '/data') return { isDirectory: () => true };
            throw new Error('ENOENT');
        });
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data') return [direntDir('movies')];
            if (path === '/data/movies')
                return [direntDir('Alien (1979)'), direntDir('Heat (1995)')];
            throw new Error('ENOENT');
        });

        const res = await callGet();
        const body = await res.json();

        expect(body.candidates).toEqual([{ path: '/data/movies', entries: 2 }]);
    });

    function dataRoot(tree: Record<string, ReturnType<typeof direntDir>[]>) {
        mockSafeStat.mockImplementation(async (path: string) => {
            if (path === '/data') return { isDirectory: () => true };
            throw new Error('ENOENT');
        });
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path in tree) return tree[path];
            throw new Error('ENOENT');
        });
    }

    it('still groups when the parent holds only OS clutter files', async () => {
        dataRoot({
            '/data': [direntDir('media')],
            '/data/media': [direntDir('movies'), direntFile('.DS_Store'), direntFile('Thumbs.db')],
            '/data/media/movies': [direntFile('a.mkv')],
        });
        const body = await (await callGet()).json();
        expect(body.candidates).toEqual([{ path: '/data/media/movies', entries: 1 }]);
    });

    it('keeps a parent with real files as one library', async () => {
        dataRoot({
            '/data': [direntDir('media')],
            '/data/media': [direntDir('movies'), direntFile('readme.txt')],
        });
        const body = await (await callGet()).json();
        expect(body.candidates).toEqual([{ path: '/data/media', entries: 2 }]);
    });

    it('keeps a library-named folder whole even with genre folders inside', async () => {
        dataRoot({
            '/data': [direntDir('movies')],
            '/data/movies': [direntDir('Kids'), direntDir('Anime'), direntDir('Alien (1979)')],
        });
        const body = await (await callGet()).json();
        expect(body.candidates).toEqual([{ path: '/data/movies', entries: 3 }]);
    });

    it('groups German library folder names, and leaves audiobook folders out', async () => {
        dataRoot({
            '/data': [direntDir('medien')],
            '/data/medien': [direntDir('Filme'), direntDir('Serien'), direntDir('Hörbücher')],
            '/data/medien/Filme': [direntDir('Nosferatu (1922)')],
            '/data/medien/Serien': [direntDir('Show')],
            '/data/medien/Hörbücher': [direntDir('Book')],
        });
        const body = await (await callGet()).json();
        // Audiobooks come only from Audiobookshelf, so that folder is no candidate.
        expect(body.candidates.map((c: { path: string }) => c.path)).toEqual([
            '/data/medien/Filme',
            '/data/medien/Serien',
        ]);
    });

    it('leaves download working folders out of a grouped parent', async () => {
        dataRoot({
            '/data': [direntDir('media')],
            '/data/media': [direntDir('series'), direntDir('downloads'), direntDir('incomplete')],
            '/data/media/series': [direntDir('Show')],
        });
        const body = await (await callGet()).json();
        expect(body.candidates).toEqual([{ path: '/data/media/series', entries: 1 }]);
    });

    it('applies the per-root cap inside a grouped parent', async () => {
        const subs = [
            'movies',
            'series',
            'music',
            'anime',
            'kids',
            'shows',
            'tv',
            'films',
            'kino',
            'serien',
            'musik',
            'documentaries',
        ];
        const tree: Record<string, ReturnType<typeof direntDir>[]> = {
            '/data': [direntDir('media')],
            '/data/media': subs.map((n) => direntDir(n)),
        };
        for (const n of subs) tree[`/data/media/${n}`] = [];
        dataRoot(tree);
        const body = await (await callGet()).json();
        expect(body.candidates).toHaveLength(10);
    });

    it('caps per-root children at 10', async () => {
        mockSafeStat.mockImplementation(async (path: string) => {
            if (path === '/data') return { isDirectory: () => true };
            throw new Error('ENOENT');
        });
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (path === '/data') {
                return Array.from({ length: 15 }, (_, i) =>
                    direntDir(`dir${i.toString().padStart(2, '0')}`),
                );
            }
            return []; // every child dir is empty
        });

        const res = await callGet();
        const body = await res.json();

        expect(body.candidates).toHaveLength(10);
    });

    it('caps total candidates at 20 across multiple roots', async () => {
        const roots = ['/data', '/media', '/mnt', '/srv'];
        mockSafeStat.mockImplementation(async (path: string) => {
            if (roots.includes(path)) return { isDirectory: () => true };
            throw new Error('ENOENT');
        });
        mockSafeReaddir.mockImplementation(async (path: string) => {
            if (roots.includes(path)) {
                // 8 children per root x 4 roots = 32 candidates, well over the cap.
                return Array.from({ length: 8 }, (_, i) => direntDir(`sub${i}`));
            }
            return [];
        });

        const res = await callGet();
        const body = await res.json();

        expect(body.candidates).toHaveLength(20);
    });
});
