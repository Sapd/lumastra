// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi } from 'vitest';

// Native network roots are identified for periodic reconciliation, never skipped.
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return {
        ...actual,
        readFileSync: vi.fn((...args: Parameters<typeof actual.readFileSync>) => {
            if (args[0] === '/proc/mounts') {
                return '/dev/foo /srv/nfs-lib nfs4 rw 0 0\n/dev/bar /srv/space\\040mount cifs rw 0 0\n';
            }
            return (actual.readFileSync as (...a: unknown[]) => unknown)(...args);
        }),
    };
});

import { isUnderMount, computeNetworkPaths } from './watcher.js';

describe('watcher network-root detection', () => {
    describe('isUnderMount', () => {
        it('matches an exact mount point and nested paths', () => {
            expect(isUnderMount('/data', '/data')).toBe(true);
            expect(isUnderMount('/data/media/movies', '/data')).toBe(true);
        });

        it('does NOT match a sibling whose name shares the prefix (/data2 vs /data)', () => {
            // The classic prefix-match trap: /data2 must not be considered under /data.
            expect(isUnderMount('/data2', '/data')).toBe(false);
            expect(isUnderMount('/database/x', '/data')).toBe(false);
        });

        it('handles a mount string with a trailing slash', () => {
            expect(isUnderMount('/mnt/nfs/lib', '/mnt/nfs/')).toBe(true);
            expect(isUnderMount('/mnt/nfsX', '/mnt/nfs/')).toBe(false);
        });

        it('does not match unrelated paths', () => {
            expect(isUnderMount('/config/app', '/data')).toBe(false);
        });
    });

    describe('computeNetworkPaths', () => {
        it('marks network roots and descendants without matching sibling prefixes', () => {
            expect(
                computeNetworkPaths([
                    '/srv/nfs-lib',
                    '/srv/nfs-lib/movies',
                    '/srv/nfs-library',
                    '/srv/local-lib',
                ]),
            ).toEqual(['/srv/nfs-lib', '/srv/nfs-lib/movies']);
        });

        it('decodes escaped mount points', () => {
            expect(computeNetworkPaths(['/srv/space mount/media'])).toEqual([
                '/srv/space mount/media',
            ]);
        });

        it('handles empty input', () => {
            expect(computeNetworkPaths([])).toEqual([]);
        });
    });
});
