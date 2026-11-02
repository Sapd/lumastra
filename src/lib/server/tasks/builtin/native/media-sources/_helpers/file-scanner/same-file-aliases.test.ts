// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A shared inode number alone never makes two files one: some network and
 * FUSE filesystems hand out synthetic or reused inode numbers. Only a real
 * second name (nlink > 1), a symlink, or a case-only variant does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const stats = new Map<
    string,
    { dev: number; ino: number; size: number; nlink: number; link: boolean }
>();
vi.mock('$lib/server/utils/safe-fs.js', () => ({
    safeStat: async (p: string) => {
        const s = stats.get(p);
        if (!s) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { dev: s.dev, ino: s.ino, size: s.size, nlink: s.nlink };
    },
    safeLstat: async (p: string) => {
        const s = stats.get(p);
        if (!s) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        return { isSymbolicLink: () => s.link };
    },
}));

import { resolveSameFileAliases, swapCaseProbeName } from './same-file-aliases.js';

function put(p: string, s: Partial<{ ino: number; nlink: number; link: boolean }> = {}): void {
    stats.set(p, {
        dev: 1,
        ino: s.ino ?? 7,
        size: 100,
        nlink: s.nlink ?? 1,
        link: s.link ?? false,
    });
}

describe('resolveSameFileAliases', () => {
    beforeEach(() => stats.clear());

    it('two files that only share an inode number (nlink 1, no symlink) both stay', async () => {
        put('/lib/A.mkv');
        put('/lib/B.mkv');
        const r = await resolveSameFileAliases({
            newFiles: ['/lib/A.mkv', '/lib/B.mkv'],
            knownFileIds: new Map(),
            knownNotWalked: [],
        });
        expect(r.process).toEqual(['/lib/A.mkv', '/lib/B.mkv']);
        expect(r.skipped).toEqual([]);
    });

    it('a real hard link (nlink 2) is one file', async () => {
        put('/lib/A.mkv', { nlink: 2 });
        put('/lib/B.mkv', { nlink: 2 });
        const r = await resolveSameFileAliases({
            newFiles: ['/lib/A.mkv', '/lib/B.mkv'],
            knownFileIds: new Map(),
            knownNotWalked: [],
        });
        expect(r.process).toEqual(['/lib/A.mkv']);
        expect(r.skipped).toEqual([{ path: '/lib/B.mkv', sameAs: '/lib/A.mkv' }]);
    });

    it('a symlink to a known file is one file', async () => {
        put('/lib/A.mkv');
        put('/lib/link.mkv', { link: true });
        const r = await resolveSameFileAliases({
            newFiles: ['/lib/link.mkv'],
            knownFileIds: new Map([['1:7:100', '/lib/A.mkv']]),
            knownNotWalked: [],
        });
        expect(r.skipped).toEqual([{ path: '/lib/link.mkv', sameAs: '/lib/A.mkv' }]);
    });

    it('a case-only (and NFD vs NFC) variant of an unlisted known path is a rename', async () => {
        const nfd = '/lib/Café.mkv';
        put(nfd);
        put('/lib/café.MKV'.normalize('NFC'));
        const r = await resolveSameFileAliases({
            newFiles: ['/lib/café.MKV'.normalize('NFC')],
            knownFileIds: new Map(),
            knownNotWalked: [nfd],
        });
        expect(r.caseRenames).toEqual([{ from: nfd, to: '/lib/café.MKV'.normalize('NFC') }]);
    });
});

describe('swapCaseProbeName', () => {
    it('swaps the case of the file name only', () => {
        expect(swapCaseProbeName('/Lib/Night Film (2020).mkv')).toBe('/Lib/nIGHT fILM (2020).MKV');
    });
    it.each([
        ['/Lib/Straße.mkv', '/Lib/sTRAßE.MKV'],
        ['/Lib/İstanbul.mkv', '/Lib/İSTANBUL.MKV'],
        ['/Lib/ﬃlm.mkv', '/Lib/ﬃLM.MKV'],
    ])('preserves expanding characters while swapping the rest of %s', (path, expected) => {
        expect(swapCaseProbeName(path)).toBe(expected);
    });
    it('returns null when only expanding characters could change', () => {
        expect(swapCaseProbeName('/Lib/ßİﬃ')).toBeNull();
    });
    it('is null for a name without letters', () => {
        expect(swapCaseProbeName('/Lib/Show/01 - 02')).toBeNull();
    });
});
