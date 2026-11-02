// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { resolveMountRoot, decideArtworkMissAction } from './artwork-reaper.service.js';

describe('resolveMountRoot', () => {
    it('returns the containing library root', () => {
        expect(
            resolveMountRoot('/data/movies/Haze (1995)/poster.jpg', [
                '/data/movies',
                '/data/series',
            ]),
        ).toBe('/data/movies');
    });

    it('prefers the longest (most specific) matching root', () => {
        expect(
            resolveMountRoot('/data/movies/4k/Haze/poster.jpg', [
                '/data/movies',
                '/data/movies/4k',
            ]),
        ).toBe('/data/movies/4k');
    });

    it('normalizes trailing slashes and duplicate separators on the root', () => {
        expect(resolveMountRoot('/data/movies/Haze/poster.jpg', ['/data//movies/'])).toBe(
            '/data/movies',
        );
    });

    it('does not match a sibling that merely shares a string prefix', () => {
        expect(
            resolveMountRoot('/data/movies-backup/Haze/poster.jpg', ['/data/movies']),
        ).toBeUndefined();
    });

    it('returns undefined for a path under no library root', () => {
        // Central-storage artwork (METADATA_STORAGE_LOCATION='central') lives
        // outside every library root; the caller must then fall back to the
        // immediate-parent probe rather than walking a bogus mount root.
        expect(
            resolveMountRoot('/config/artwork/abc/poster.jpg', ['/data/movies']),
        ).toBeUndefined();
    });

    it('treats the filesystem root as a container of everything', () => {
        expect(resolveMountRoot('/data/movies/Haze/poster.jpg', ['/'])).toBe('/');
    });

    it('returns undefined when there are no roots at all', () => {
        expect(resolveMountRoot('/data/movies/Haze/poster.jpg', [])).toBeUndefined();
    });
});

describe('decideArtworkMissAction', () => {
    it('resets the counter when the file is present', () => {
        expect(
            decideArtworkMissAction(
                'present',
                '/data/a/poster.jpg',
                { filePath: '/data/a/poster.jpg', misses: 2 },
                3,
            ),
        ).toEqual({ action: 'reset' });
    });

    it('ignores a transient verdict without touching the counter', () => {
        // An NFS flap is neither evidence of deletion nor evidence of life.
        // Deleting here is what would wipe a library's artwork table.
        expect(
            decideArtworkMissAction(
                'transient',
                '/data/a/poster.jpg',
                { filePath: '/data/a/poster.jpg', misses: 2 },
                3,
            ),
        ).toEqual({ action: 'ignore' });
    });

    it('never deletes on a transient verdict even at the threshold', () => {
        expect(
            decideArtworkMissAction(
                'transient',
                '/data/a/poster.jpg',
                { filePath: '/data/a/poster.jpg', misses: 99 },
                3,
            ),
        ).toEqual({ action: 'ignore' });
    });

    it('counts the first miss instead of deleting', () => {
        expect(decideArtworkMissAction('missing', '/data/a/poster.jpg', null, 3)).toEqual({
            action: 'count',
            next: { filePath: '/data/a/poster.jpg', misses: 1 },
        });
    });

    it('increments an existing counter for the same path', () => {
        expect(
            decideArtworkMissAction(
                'missing',
                '/data/a/poster.jpg',
                { filePath: '/data/a/poster.jpg', misses: 1 },
                3,
            ),
        ).toEqual({ action: 'count', next: { filePath: '/data/a/poster.jpg', misses: 2 } });
    });

    it('deletes once the threshold is reached', () => {
        expect(
            decideArtworkMissAction(
                'missing',
                '/data/a/poster.jpg',
                { filePath: '/data/a/poster.jpg', misses: 2 },
                3,
            ),
        ).toEqual({ action: 'delete' });
    });

    it('restarts the count when the row was repointed at a different file', () => {
        // The row now claims a different path; the old path's miss history
        // says nothing about the new one.
        expect(
            decideArtworkMissAction(
                'missing',
                '/data/a/folder.jpg',
                { filePath: '/data/a/poster.jpg', misses: 2 },
                3,
            ),
        ).toEqual({ action: 'count', next: { filePath: '/data/a/folder.jpg', misses: 1 } });
    });

    it('deletes on the first miss when the threshold is 1', () => {
        expect(decideArtworkMissAction('missing', '/data/a/poster.jpg', null, 1)).toEqual({
            action: 'delete',
        });
    });
});
