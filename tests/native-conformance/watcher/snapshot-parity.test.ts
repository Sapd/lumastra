// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildNativeWatcherPolicy } from '../../../src/lib/server/utils/native-watcher-policy.js';
import { walkDirectoryWithResult } from '../../../src/lib/server/utils/walk-directory.js';

// Like the rest of this directory, only runs where the native job built the binary.
const binary = process.env.LUMASTRA_WATCHER_BINARY;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
beforeAll(() => {
    if (binary) accessSync(binary, constants.X_OK);
});

/**
 * Files the Rust child may emit although the scanner's walk does not list them: the
 * filename-suffix extra rule needs media-extras.ts's parser, so it stays Node-only and is
 * enforced in ingestSingleFile. Anything else in the child's output must be in the walk.
 */
const SUFFIX_EXTRA_NAMES = new Set(['Film-trailer.mkv', 'Film-behindthescenes.mkv']);

async function put(root: string, rel: string, body = 'x'): Promise<void> {
    const target = join(root, rel);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, body);
}

async function buildTree(): Promise<string> {
    const base = await mkdtemp(join(tmpdir(), 'watcher-parity-'));
    cleanups.push(() => rm(base, { recursive: true, force: true }));
    const root = join(base, 'library');
    const outside = join(base, 'outside');
    await mkdir(root);
    await mkdir(outside);
    for (const rel of [
        'Film/Film.mkv',
        'Film/Film-trailer.mkv',
        'Film/Film-behindthescenes.mkv',
        'Film/Film.en.srt',
        'Film/sample.mkv',
        'Film/Film sample.mkv',
        'Film/Sampler.mkv',
        // ASCII word boundary: a non-ASCII letter before "sample" still bounds the word,
        // an underscore does not.
        'Film/ésample.mkv',
        'Film/my_sample.mkv',
        'Film/._Film.mkv',
        'Show/Season 01/S01E01.mkv',
        'Show/Season 01/S01E01.nfo',
        'Show/extras/Bonus.mkv',
        'Show/@eaDir/thumb.mkv',
        'Show/Season 01.trickplay/frame.mkv',
        '.Trash-1000/deleted.mkv',
        '#recycle/old.mkv',
        '#snapshot/old.mkv',
        'Music/Artist/Album/01 Song.flac',
        'Music/Artist/Album/01 Song.lrc',
        'Music/Artist/Album/cover.jpg',
        'Music/Artist/Album/readme.TXT',
        'Music/@Artist/Album/02 Song.FLAC',
        'Dotted/.hidden title/Movie.mkv',
        'Ignored/keep.mkv',
        'Ignored/skip-me.mkv',
        'Ignored/sub/skip-me.flac',
        'Marked/.ignore',
        'Marked/hidden.mkv',
        // .ignore with patterns (non-empty) instead of the empty skip-marker form
        'Pat/b.mkv',
        'Pat/a.skip.mkv',
        'Pat/deep/c.skip.mkv',
        // root-level patterns: a "/" pattern matches the path relative to the root,
        // matching is case-insensitive, "?" is exactly one character
        'Rel/secret/a.mkv',
        'Rel/open/a.mkv',
        'UpperCase.MKV',
        'qa.mkv',
        'qab.mkv',
        // an unreadable (oversized) ignore file skips the directory and its subtree
        'Huge/skip.mkv',
        'Huge/sub/skip2.mkv',
    ])
        await put(root, rel);
    await put(root, 'Ignored/.lumastraignore', '# comment\nskip-me.*\n');
    // an EMPTY .ignore is the skip-the-folder marker (a non-empty one holds patterns)
    await put(root, 'Marked/.ignore', '');
    await put(root, 'Pat/.ignore', '# patterns\n*.skip.mkv\n');
    await put(root, '.lumastraignore', 'Rel/secret/*.mkv\nupper*.mkv\nQ?.MKV\n');
    await put(root, 'Huge/.lumastraignore', `${'# padding\n'.repeat(8000)}never.mkv\n`);
    expect((await stat(join(root, 'Huge/.lumastraignore'))).size).toBeGreaterThan(64 * 1024);

    await writeFile(join(outside, 'real.lrc'), 'lyrics');
    await writeFile(join(outside, 'real.mkv'), 'video');
    await symlink(join(root, 'Film/Film.mkv'), join(root, 'Film/link-to-film.mkv'));
    // lyrics/other targets must be inside a containment root: this one is not
    await symlink(join(outside, 'real.lrc'), join(root, 'Music/out.lrc'));
    // media targets may live anywhere that is not a sensitive prefix
    await symlink(join(outside, 'real.mkv'), join(root, 'Film/ext-link.mkv'));
    // ... and /proc is sensitive
    await symlink('/proc/self/environ', join(root, 'Film/escape.mkv'));
    if (process.platform === 'linux') {
        // A name that is not UTF-8 is skipped by both sides and never ingested.
        const bad = Buffer.concat([
            Buffer.from(join(root, 'Film/bad-')),
            Buffer.from([0xff, 0xfe]),
            Buffer.from('.mkv'),
        ]);
        await writeFile(bad, 'x');
    }
    return resolve(root);
}

async function snapshot(root: string): Promise<string[]> {
    const child = spawn(binary!, ['--snapshot'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (err += chunk.toString()));
    const exited = new Promise<number | null>((resolveExit) => child.once('close', resolveExit));
    child.stdin.end(
        JSON.stringify({
            type: 'init',
            version: 2,
            paths: [root],
            networkPaths: [],
            networkReconcileSecs: 0,
            policy: await buildNativeWatcherPolicy([root]),
            stabilityMs: 500,
            pollMs: 100,
            aliveMs: 10_000,
        }) + '\n',
    );
    const code = await exited;
    expect(code, err).toBe(0);
    return out
        .split('\n')
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as string);
}

describe.skipIf(!binary)('Rust --snapshot parity with the scanner walk', () => {
    it('emits exactly the scanner files, lyrics sidecars and Node-only suffix extras', async () => {
        const root = await buildTree();
        const walk = await walkDirectoryWithResult(root);
        // The oversized .lumastraignore is a listing failure on the Node side.
        expect(walk.hadErrors).toBe(true);
        const node = new Set([...walk.files, ...walk.lyricsSidecars]);
        const rust = new Set(await snapshot(root));

        const missingInRust = [...node].filter((path) => !rust.has(path)).sort();
        const extraInRust = [...rust]
            .filter((path) => !node.has(path))
            .filter((path) => !SUFFIX_EXTRA_NAMES.has(path.split('/').at(-1) ?? ''))
            .sort();
        expect({ missingInRust, extraInRust }).toEqual({ missingInRust: [], extraInRust: [] });

        const rel = (set: Set<string>): string[] =>
            [...set].map((path) => path.slice(root.length + 1));
        for (const set of [node, rust]) {
            const names = rel(set);
            // kept
            for (const kept of [
                'Film/Film.mkv',
                'Film/my_sample.mkv',
                'Pat/b.mkv',
                'Rel/open/a.mkv',
                'qab.mkv',
                'Music/Artist/Album/01 Song.lrc',
                'Dotted/.hidden title/Movie.mkv',
            ])
                expect(names, kept).toContain(kept);
            // skipped
            for (const skipped of [
                'Film/sample.mkv',
                'Film/ésample.mkv',
                'Film/._Film.mkv',
                'Pat/a.skip.mkv',
                'Pat/deep/c.skip.mkv',
                'Rel/secret/a.mkv',
                'UpperCase.MKV',
                'qa.mkv',
                'Huge/skip.mkv',
                'Huge/sub/skip2.mkv',
                'Marked/hidden.mkv',
                'Music/out.lrc',
                'Film/escape.mkv',
                'Show/@eaDir/thumb.mkv',
            ])
                expect(names, skipped).not.toContain(skipped);
            expect(names.some((name) => name.includes('\uFFFD') || name.includes('bad-'))).toBe(
                false,
            );
        }
        expect(node.size).toBeGreaterThan(8);
    });
});
