// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink, readdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkScannerEligibility, resetScannerEligibilityCache } from './walk-directory.js';
import { walkDirectoryWithResult } from './walk-directory.js';
import { setSensitivePrefixesForTests } from './contained-fs.js';
import { LoggerInstance } from './logger.js';

// No database in unit tests: only the walked root counts for symlink containment.
vi.mock('../database/connection.js', () => ({ getDb: () => null }));

describe('checkScannerEligibility parity with walkDirectoryWithResult', () => {
    let base: string;
    let root: string;

    async function put(rel: string, content = ''): Promise<void> {
        const p = join(root, rel);
        await mkdir(join(p, '..'), { recursive: true });
        await writeFile(p, content);
    }

    beforeEach(async () => {
        resetScannerEligibilityCache();
        base = await mkdtemp(join(tmpdir(), 'eligibility-'));
        root = join(base, 'lib');
        const secret = join(base, 'secret');
        const outside = join(base, 'outside');
        await mkdir(root, { recursive: true });
        await mkdir(secret, { recursive: true });
        await mkdir(outside, { recursive: true });
        setSensitivePrefixesForTests([secret]);

        await writeFile(join(secret, 'master.key'), 'secret');
        await writeFile(join(outside, 'ext.mkv'), '');
        await writeFile(join(outside, 'o.mkv'), '');
        await writeFile(join(outside, 'l.lrc'), '');

        // Pruned folders and name rules
        await put('Film/Film.mkv');
        await put('Film/Film-trailer.mkv');
        await put('Film/extras/x.mkv');
        await put('Film/Samples/s.mkv');
        await put('Film/trailers/t.mkv');
        await put('Film/BDMV/b.m2ts');
        await put('Film/@eaDir/e.mkv');
        await put('Film/#recycle/r.mkv');
        await put('Film/Film.x.trickplay/z.mkv');
        await put('Film/Sample.mkv');
        await put('Film/resample.mkv');
        await put('Film/._a.mkv');
        await put('Film/notes.nfo');
        await put('Short/Short-trailer.mkv');

        // Ignore files
        await put('Ign/.lumastraignore', '# comment\n*.skip.mkv\nIgn/hidden/*\nnodir\n');
        await put('Ign/a.skip.mkv');
        await put('Ign/keep.mkv');
        await put('Ign/hidden/h.mkv');
        await put('Ign/nodir/n.mkv');
        await put('Marker/ok.mkv');
        await put('Marker/sub/.ignore', '');
        await put('Marker/sub/m.mkv');
        await put('Marker/sub/deep/d.mkv');
        await put('Marker/pat/.ignore', '*.no.mkv\n');
        await put('Marker/pat/y.mkv');
        await put('Marker/pat/z.no.mkv');
        // An empty .ignore at the library root is refused: the root is scanned normally.
        await put('.ignore', '');
        await put('Root.mkv');

        // Music, lyrics, symlinks
        await put('Music/01.flac');
        await put('Music/01.lrc');
        await put('Music/readme.txt');
        await symlink(join(secret, 'master.key'), join(root, 'Music/02.mp3'));
        await symlink(join(outside, 'l.lrc'), join(root, 'Music/03.lrc'));
        await symlink(join(root, 'Film/Film.mkv'), join(root, 'Music/05.mkv'));
        await symlink(join(root, 'Music/01.lrc'), join(root, 'Music/06.lrc'));
        await symlink(join(outside, 'ext.mkv'), join(root, 'Music/07.mkv'));
        await symlink(join(root, 'Music/missing.mkv'), join(root, 'Music/08.mkv'));

        // Directory links
        await symlink(outside, join(root, 'out'));
        await put('Loop/l.mkv');
        await symlink(join(root, 'Loop'), join(root, 'Loop/loop'));

        // Non-UTF-8 name (the file system on macOS rejects it)
        if (process.platform !== 'darwin') {
            const bad = Buffer.concat([
                Buffer.from(join(root, 'Film') + '/bad'),
                Buffer.from([0xff]),
                Buffer.from('.mkv'),
            ]);
            await writeFile(bad, '');
        }
    });

    afterEach(async () => {
        setSensitivePrefixesForTests([]);
        await rm(base, { recursive: true, force: true });
    });

    /** Every non-directory entry, following directory links (at most two per path). */
    async function candidates(dir: string, links = 0, depth = 0): Promise<string[]> {
        if (depth > 8) return [];
        const out: string[] = [];
        for (const e of await readdir(dir, { withFileTypes: true })) {
            const p = join(dir, e.name);
            let isDir = e.isDirectory();
            let nextLinks = links;
            if (e.isSymbolicLink()) {
                try {
                    isDir = (await stat(p)).isDirectory();
                } catch {
                    isDir = false;
                }
                if (isDir) nextLinks++;
            }
            if (isDir) {
                if (nextLinks <= 2) out.push(...(await candidates(p, nextLinks, depth + 1)));
            } else {
                out.push(p);
            }
        }
        return out;
    }

    it('says eligible exactly for the files the bulk walk reports', async () => {
        const walk = await walkDirectoryWithResult(root);
        const walked = new Set([...walk.files, ...walk.lyricsSidecars]);

        const eligible = new Set<string>();
        const reasons = new Map<string, string>();
        for (const p of await candidates(root)) {
            const res = await checkScannerEligibility(root, p);
            if (res.eligible) {
                eligible.add(p);
                expect(res.kind).toBe(walk.lyricsSidecars.includes(p) ? 'lyrics' : 'media');
            } else {
                reasons.set(p, res.reason);
            }
        }

        expect([...eligible].sort()).toEqual([...walked].sort());

        const rel = (r: string): string => join(root, r);
        for (const r of [
            'Film/Film.mkv',
            'Short/Short-trailer.mkv',
            'Ign/keep.mkv',
            'Marker/ok.mkv',
            'Marker/pat/y.mkv',
            'Root.mkv',
            'Music/01.flac',
            'Music/01.lrc',
            'Music/05.mkv',
            'Music/06.lrc',
            'Music/07.mkv',
            'Loop/l.mkv',
        ]) {
            expect(walked.has(rel(r)), `walk should report ${r}`).toBe(true);
        }
        for (const r of [
            'Film/Film-trailer.mkv',
            'Film/extras/x.mkv',
            'Film/Samples/s.mkv',
            'Film/trailers/t.mkv',
            'Film/BDMV/b.m2ts',
            'Film/@eaDir/e.mkv',
            'Film/#recycle/r.mkv',
            'Film/Film.x.trickplay/z.mkv',
            'Film/Sample.mkv',
            'Film/._a.mkv',
            'Ign/a.skip.mkv',
            'Ign/hidden/h.mkv',
            'Ign/nodir/n.mkv',
            'Marker/sub/m.mkv',
            'Marker/sub/deep/d.mkv',
            'Marker/pat/z.no.mkv',
            'Music/02.mp3',
            'Music/03.lrc',
            'Music/08.mkv',
            'out/o.mkv',
            'Loop/loop/l.mkv',
        ]) {
            expect(walked.has(rel(r)), `walk should not report ${r}`).toBe(false);
            expect(reasons.has(rel(r)), `eligibility should refuse ${r}`).toBe(true);
        }
        // Word-boundary rule: "resample" is not a sample.
        expect(walked.has(rel('Film/resample.mkv'))).toBe(true);
    });

    it('sees a directory retargeted out of the root on the very next check', async () => {
        await mkdir(join(root, 'Real'), { recursive: true });
        await writeFile(join(root, 'Real', 'a.mkv'), '');
        await writeFile(join(root, 'Real', 'b.mkv'), '');
        await symlink(join(root, 'Real'), join(root, 'Link'));
        const first = await checkScannerEligibility(root, join(root, 'Link', 'a.mkv'));
        expect(first.eligible).toBe(true);
        await rm(join(root, 'Link'));
        await mkdir(join(base, 'elsewhere'), { recursive: true });
        await writeFile(join(base, 'elsewhere', 'b.mkv'), '');
        await symlink(join(base, 'elsewhere'), join(root, 'Link'));
        const second = await checkScannerEligibility(root, join(root, 'Link', 'b.mkv'));
        expect(second.eligible).toBe(false);
    });

    it('sees a new empty .ignore marker on the very next check', async () => {
        await mkdir(join(root, 'Fresh'), { recursive: true });
        await writeFile(join(root, 'Fresh', 'a.mkv'), '');
        expect((await checkScannerEligibility(root, join(root, 'Fresh', 'a.mkv'))).eligible).toBe(
            true,
        );
        await writeFile(join(root, 'Fresh', '.ignore'), '');
        expect((await checkScannerEligibility(root, join(root, 'Fresh', 'a.mkv'))).eligible).toBe(
            false,
        );
        await rm(join(root, 'Fresh', '.ignore'));
        await writeFile(join(root, 'Fresh', '.lumastraignore'), '*.mkv\n');
        expect((await checkScannerEligibility(root, join(root, 'Fresh', 'a.mkv'))).eligible).toBe(
            false,
        );
    });

    it('refuses paths outside the root', async () => {
        const res = await checkScannerEligibility(root, join(base, 'outside', 'o.mkv'));
        expect(res.eligible).toBe(false);
        const same = await checkScannerEligibility(root, root);
        expect(same.eligible).toBe(false);
    });

    it.skipIf(process.platform === 'darwin')(
        'warns once per directory per scan for non-UTF-8 names',
        async () => {
            // The fixture already has one invalid name in Film. Add a second there
            // and another in Music to distinguish per-directory from per-walk limits.
            for (const folder of ['Film', 'Music']) {
                await writeFile(
                    Buffer.concat([
                        Buffer.from(join(root, folder) + '/other'),
                        Buffer.from([0xfe]),
                        Buffer.from('.mkv'),
                    ]),
                    '',
                );
            }
            // A real replacement character is a valid filename and must stay eligible.
            await put('Music/valid�.flac');
            const warn = vi.spyOn(LoggerInstance.prototype, 'warn').mockImplementation(() => {});
            const debug = vi.spyOn(LoggerInstance.prototype, 'debug').mockImplementation(() => {});
            try {
                for (let scan = 0; scan < 2; scan++) {
                    warn.mockClear();
                    debug.mockClear();
                    const result = await walkDirectoryWithResult(root);
                    expect(result.files).toContain(join(root, 'Music/valid�.flac'));
                    expect(
                        result.files.filter(
                            (file) => file.includes('bad�') || file.includes('other�'),
                        ),
                    ).toEqual([]);
                    const warnings = warn.mock.calls.filter(([message]) =>
                        message.includes('non-UTF-8'),
                    );
                    expect(warnings).toHaveLength(2);
                    expect(
                        warnings.filter(([message]) => message.includes(join(root, 'Film'))),
                    ).toHaveLength(1);
                    expect(
                        warnings.filter(([message]) => message.includes(join(root, 'Music'))),
                    ).toHaveLength(1);
                    expect(
                        debug.mock.calls.filter(([message]) =>
                            message.includes('non-UTF-8 name skipped'),
                        ),
                    ).toHaveLength(1);
                }
            } finally {
                warn.mockRestore();
                debug.mockRestore();
            }
        },
    );

    it.skipIf(process.platform === 'darwin')('refuses a non-UTF-8 file name', async () => {
        const walk = await walkDirectoryWithResult(root);
        const lossy = walk.files.filter((f) => f.includes('�'));
        expect(lossy).toEqual([]);
        const res = await checkScannerEligibility(root, join(root, 'Film', 'bad�.mkv'));
        expect(res).toEqual({ eligible: false, reason: 'non-UTF-8 name' });
    });
});
