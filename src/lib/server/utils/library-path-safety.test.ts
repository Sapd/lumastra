// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';
import { resolveUnderRoot, resolveSourceUri, realpathUnderRoot } from './library-path-safety.js';

vi.mock('node:fs/promises');

describe('resolveUnderRoot', () => {
    const root = '/data/movies';
    it('accepts a nested rel path', () => {
        expect(resolveUnderRoot(root, 'A (2020) [imdbid-tt1]/a.mkv')).toBe(
            '/data/movies/A (2020) [imdbid-tt1]/a.mkv',
        );
    });
    it.each(['', '.', '/abs', 'a/../../etc/passwd', '../x', 'a\\b'])('rejects %p', (rel) => {
        expect(resolveUnderRoot(root, rel)).toBeNull();
    });

    // F4 (fix plan 6, Task 7 fix round 1): a control character in a
    // destinationFolder/rel segment survived every existing check here
    // (`..`, leading `/`, `\`, empty segments) and could still reach the
    // ffmpeg concat list the same way an unguarded filename could.
    it.each(['a\nb', 'a\rb', 'a\u0000b'])('rejects a control character in %j', (rel) => {
        expect(resolveUnderRoot(root, rel)).toBeNull();
    });

    // M4 (fix plan 6, Task 7 fix round 2): a row written before the F4 guard
    // existed can have a control character baked into its stored path.
    // file-delta-ingest's REMOVE op must still be able to resolve that exact
    // path to retire it — the add/update/move (upsert) call site keeps
    // rejecting a control character outright.
    describe('allowControlChars option (M4 — file-delta-ingest REMOVE only)', () => {
        it.each(['a\nb', 'a\rb', 'a\u0000b'])(
            'resolves a control character in %j when explicitly allowed',
            (rel) => {
                expect(resolveUnderRoot(root, rel, { allowControlChars: true })).toBe(
                    `${root}/${rel}`,
                );
            },
        );

        // Control: traversal/absolute/backslash escapes are STILL rejected
        // even with the option set — it only lifts the control-char check.
        it.each(['', '.', '/abs', 'a/../../etc/passwd', '../x', 'a\\b'])(
            'still rejects %p even with the option set',
            (rel) => {
                expect(resolveUnderRoot(root, rel, { allowControlChars: true })).toBeNull();
            },
        );
    });
});

describe('resolveSourceUri', () => {
    const roots = [
        { id: 'm', sourcePrefix: 's3://b/movies/' },
        { id: 'mm', sourcePrefix: 's3://b/movies/4k/' }, // longer prefix wins
        { id: 'noprefix', sourcePrefix: null },
    ];
    it('longest-prefix wins', () => {
        expect(resolveSourceUri('s3://b/movies/4k/X/x.mkv', roots)).toEqual({
            libraryPathId: 'mm',
            rel: 'X/x.mkv',
        });
    });
    it('plain prefix match', () => {
        expect(resolveSourceUri('s3://b/movies/X/x.mkv', roots)).toEqual({
            libraryPathId: 'm',
            rel: 'X/x.mkv',
        });
    });
    it('unmatched → null', () => {
        expect(resolveSourceUri('s3://other/x', roots)).toBeNull();
    });
    it('prefix without trailing slash does NOT match a sibling path', () => {
        const rootsNoSlash = [{ id: 'm', sourcePrefix: 's3://b/movies' }];
        expect(resolveSourceUri('s3://b/movies-hd/x.mkv', rootsNoSlash)).toBeNull();
    });
    it('two roots with identical sourcePrefix → ambiguous → returns null', () => {
        const ambiguousRoots = [
            { id: 'lib-a', sourcePrefix: 's3://b/shared/' },
            { id: 'lib-b', sourcePrefix: 's3://b/shared/' },
        ];
        expect(resolveSourceUri('s3://b/shared/film.mkv', ambiguousRoots)).toBeNull();
    });
});

describe('realpathUnderRoot', () => {
    it('returns the real path when realpath resolves to an in-root path', async () => {
        const { realpath } = await import('node:fs/promises');
        vi.mocked(realpath).mockResolvedValue('/data/movies/film.mkv' as never);
        const result = await realpathUnderRoot('/data/movies', '/data/movies/film.mkv');
        expect(result).toBe('/data/movies/film.mkv');
    });

    it('returns abs when realpath throws ENOENT for an in-root abs', async () => {
        const { realpath } = await import('node:fs/promises');
        vi.mocked(realpath).mockRejectedValue(
            Object.assign(new Error('ENOENT'), { code: 'ENOENT' }),
        );
        const result = await realpathUnderRoot('/data/movies', '/data/movies/new-file.mkv');
        expect(result).toBe('/data/movies/new-file.mkv');
    });

    it('throws when realpath throws a non-ENOENT error (e.g. EACCES)', async () => {
        const { realpath } = await import('node:fs/promises');
        vi.mocked(realpath).mockRejectedValue(
            Object.assign(new Error('EACCES'), { code: 'EACCES' }),
        );
        await expect(
            realpathUnderRoot('/data/movies', '/data/movies/film.mkv'),
        ).rejects.toMatchObject({ code: 'EACCES' });
    });
});
