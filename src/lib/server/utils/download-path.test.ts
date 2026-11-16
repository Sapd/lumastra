// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Strict download containment on real temp dirs and symlinks; playback keeps its own rule.

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('./media-path-resolver.js', () => ({ getLibraryRootPaths: async () => [] }));

import { resolveDownloadablePathIn } from './download-path';
import { resolveContainedMediaFile, resetContainmentRootsCache } from './contained-fs';

let base = '';
let lib = '';
let mount = '';
let outside = '';

beforeAll(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), 'dl-path-')));
    lib = join(base, 'library');
    mount = join(base, 'debrid-mount');
    outside = join(base, 'outside');
    for (const d of [lib, mount, outside]) mkdirSync(d);
    writeFileSync(join(lib, 'real.mkv'), 'a');
    writeFileSync(join(mount, 'remote.mkv'), 'b');
    writeFileSync(join(outside, 'passwd'), 'secret');
    symlinkSync(join(lib, 'real.mkv'), join(lib, 'inside-link.mkv'));
    symlinkSync(join(outside, 'passwd'), join(lib, 'evil.mkv'));
    symlinkSync(join(mount, 'remote.mkv'), join(lib, 'debrid.mkv'));
    symlinkSync(outside, join(lib, 'dirlink'));
});
afterAll(() => rmSync(base, { recursive: true, force: true }));

describe('resolveDownloadablePathIn', () => {
    it('a plain file and a symlink inside the root resolve to the canonical path', async () => {
        expect(await resolveDownloadablePathIn(join(lib, 'real.mkv'), [lib])).toBe(
            join(lib, 'real.mkv'),
        );
        expect(await resolveDownloadablePathIn(join(lib, 'inside-link.mkv'), [lib])).toBe(
            join(lib, 'real.mkv'),
        );
    });

    it('a symlink to a file outside the roots (an /etc/passwd stand-in) is refused', async () => {
        expect(await resolveDownloadablePathIn(join(lib, 'evil.mkv'), [lib])).toBeNull();
    });

    it('a file reached through a directory link that leaves the roots is refused', async () => {
        expect(await resolveDownloadablePathIn(join(lib, 'dirlink', 'passwd'), [lib])).toBeNull();
    });

    it('a symlink into a configured extra (debrid) root is allowed, and returns the canonical target', async () => {
        expect(await resolveDownloadablePathIn(join(lib, 'debrid.mkv'), [lib])).toBeNull();
        expect(await resolveDownloadablePathIn(join(lib, 'debrid.mkv'), [lib, mount])).toBe(
            join(mount, 'remote.mkv'),
        );
    });

    it('missing files and directories are refused', async () => {
        expect(await resolveDownloadablePathIn(join(lib, 'nope.mkv'), [lib])).toBeNull();
        expect(await resolveDownloadablePathIn(lib, [lib])).toBeNull();
    });

    it('a root that is itself reached through a symlink still matches canonically', async () => {
        const rootLink = join(base, 'lib-alias');
        symlinkSync(lib, rootLink);
        expect(await resolveDownloadablePathIn(join(rootLink, 'real.mkv'), [lib])).toBe(
            join(lib, 'real.mkv'),
        );
    });

    it('playback is unchanged: the permissive media resolver still serves the outside-root symlink', async () => {
        resetContainmentRootsCache();
        expect(await resolveContainedMediaFile(join(lib, 'evil.mkv'), [lib])).toBe(
            join(outside, 'passwd'),
        );
        // ... while the same path is refused for download
        expect(await resolveDownloadablePathIn(join(lib, 'evil.mkv'), [lib])).toBeNull();
    });
});
