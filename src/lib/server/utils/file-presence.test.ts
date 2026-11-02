// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tests for file-presence classification.
 *
 * The transient-mount-outage heuristic is load-bearing for every file-based
 * plugin slice — if it ever silently misclassifies a gone-mount as a
 * hard-miss we poison every row in the tree. Pin the behaviour here.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assessFilePresence } from './file-presence.js';

describe('assessFilePresence', () => {
    let scratchDir: string;
    let realFile: string;

    beforeAll(async () => {
        scratchDir = await mkdtemp(join(tmpdir(), 'file-presence-'));
        realFile = join(scratchDir, 'track.flac');
        await writeFile(realFile, 'dummy');
    });

    afterAll(async () => {
        await rm(scratchDir, { recursive: true, force: true });
    });

    it('returns "present" when the file exists', async () => {
        expect(await assessFilePresence(realFile)).toBe('present');
    });

    it('returns "missing" when the file is gone but the parent exists', async () => {
        const gonePath = join(scratchDir, 'does-not-exist.flac');
        expect(await assessFilePresence(gonePath)).toBe('missing');
    });

    it('returns "transient" when both the file AND the parent dir are gone', async () => {
        // Reference a path under a fake mount point that doesn't exist —
        // simulates an unmounted NFS share.
        const fakeMount = join(scratchDir, 'unmounted-share', 'album');
        const transientFile = join(fakeMount, 'track.flac');
        expect(await assessFilePresence(transientFile)).toBe('transient');
    });

    it('returns "missing" for root-like paths with no real parent', async () => {
        // `dirname('/')` === `/` — the short-circuit in the helper avoids
        // an infinite classification loop.
        expect(await assessFilePresence('/does-not-exist-at-root')).toBe('missing');
    });

    describe('mount-aware (mountRoot option)', () => {
        it('mountRoot present but file+parent gone → missing (real folder deletion)', async () => {
            // The library root (scratchDir) is present, but the whole
            // Artist/Album subtree under it was deleted. Walking up from the
            // file we reach an existing ancestor (the mount root) → the mount
            // is live, so this is a genuine deletion.
            const deletedTree = join(scratchDir, 'GoneArtist', 'GoneAlbum', 'track.flac');
            expect(await assessFilePresence(deletedTree, { mountRoot: scratchDir })).toBe(
                'missing',
            );
        });

        it('whole mount gone (root absent) → transient', async () => {
            // The mount root itself does not exist — the share is offline.
            // Every ancestor up to & including the root is absent → transient.
            const ghostMount = join(scratchDir, 'ghost-mount');
            const fileUnderGhost = join(ghostMount, 'Artist', 'Album', 'track.flac');
            expect(await assessFilePresence(fileUnderGhost, { mountRoot: ghostMount })).toBe(
                'transient',
            );
        });

        it('present file with a mountRoot still returns present', async () => {
            expect(await assessFilePresence(realFile, { mountRoot: scratchDir })).toBe('present');
        });

        it('no mountRoot → legacy immediate-parent behavior (regression lock)', async () => {
            // Parent present → missing.
            const gonePath = join(scratchDir, 'does-not-exist.flac');
            expect(await assessFilePresence(gonePath)).toBe('missing');
            // Parent absent → transient.
            const deepGone = join(scratchDir, 'unmounted-share', 'album', 'track.flac');
            expect(await assessFilePresence(deepGone)).toBe('transient');
        });

        it('still honors a bare AbortSignal (overload back-compat)', async () => {
            const ac = new AbortController();
            ac.abort();
            expect(await assessFilePresence(realFile, ac.signal)).toBe('transient');
        });

        it('sibling-prefix mountRoot is not matched (uses boundary, not startsWith)', async () => {
            // A sibling directory that merely shares a string prefix with the
            // mountRoot (e.g. '/data/movies' vs '/data/movies-backup') must NOT
            // be treated as "under" the root — bare startsWith() would wrongly
            // walk the sibling tree using the wrong root's semantics.
            const siblingRoot = `${scratchDir}-backup`;
            const fileUnderSibling = join(siblingRoot, 'x.mkv');
            // Sibling root doesn't exist on disk, so the legacy immediate-parent
            // fallback applies: parent (siblingRoot) is absent → transient.
            expect(await assessFilePresence(fileUnderSibling, { mountRoot: scratchDir })).toBe(
                'transient',
            );
        });

        it('trailing-slash mountRoot: offline mount → transient (not missing)', async () => {
            // A trailing slash on mountRoot must not defeat the `dir === root`
            // termination check — otherwise the walk runs past the root to a
            // present local ancestor (e.g. the OS temp dir) and misclassifies
            // an offline mount as a real deletion.
            const ghostMount = join(scratchDir, 'ghost-mount-slash');
            const fileUnderGhost = join(ghostMount, 'Artist', 'Album', 'track.flac');
            expect(await assessFilePresence(fileUnderGhost, { mountRoot: `${ghostMount}/` })).toBe(
                'transient',
            );
        });

        it('filePath === mountRoot probes the root itself', async () => {
            // Root present → the initial file-existence probe already reports
            // the root as present (it IS the path being checked).
            expect(await assessFilePresence(scratchDir, { mountRoot: scratchDir })).toBe('present');
            // Root absent → the walk must start AT the root (not its parent,
            // which may still exist) so an offline mount is never
            // misclassified as a real deletion just because some ancestor
            // above the root happens to be present.
            const ghostRoot = join(scratchDir, 'ghost-root-itself');
            expect(await assessFilePresence(ghostRoot, { mountRoot: ghostRoot })).toBe('transient');
        });
    });
});
