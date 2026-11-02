// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, writeFile, rm, readdir, readFile, stat, symlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_SIDECAR_TEXT_BYTES, SidecarTooLargeError, readSidecarText } from './sidecar-text.js';
import { readNfoForVideo, readAlbumNfo, readArtistNfo } from './nfo-parser.js';
import { ContainmentError } from './contained-fs.js';

// No database in unit tests: no library roots, so every symlink is out of bounds.
vi.mock('../database/connection.js', () => ({ getDb: () => null }));

let dir: string;

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'sidecar-text-'));
});

afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe('readSidecarText', () => {
    it('reads a small file as UTF-8', async () => {
        const p = join(dir, 'small.vtt');
        await writeFile(p, 'WEBVTT\n\ncafé\n');
        expect(await readSidecarText(p)).toBe('WEBVTT\n\ncafé\n');
    });

    it('accepts a file exactly at the cap', async () => {
        const p = join(dir, 'at-cap.vtt');
        await writeFile(p, 'a'.repeat(MAX_SIDECAR_TEXT_BYTES));
        expect((await readSidecarText(p)).length).toBe(MAX_SIDECAR_TEXT_BYTES);
    });

    it('rejects a file one byte over the cap', async () => {
        const p = join(dir, 'over-cap.vtt');
        await writeFile(p, 'a'.repeat(MAX_SIDECAR_TEXT_BYTES + 1));
        await expect(readSidecarText(p)).rejects.toBeInstanceOf(SidecarTooLargeError);
    });

    it('honours an explicit smaller limit', async () => {
        const p = join(dir, 'limit.vtt');
        await writeFile(p, 'abcdef');
        await expect(readSidecarText(p, 5)).rejects.toBeInstanceOf(SidecarTooLargeError);
        expect(await readSidecarText(p, 6)).toBe('abcdef');
    });
});

describe('NFO readers refuse an over-cap file', () => {
    const body = `<movie><uniqueid type="imdb">tt0063350</uniqueid>${' '.repeat(MAX_SIDECAR_TEXT_BYTES)}</movie>`;

    it('readNfoForVideo returns nothing for an over-cap NFO', async () => {
        await writeFile(join(dir, 'big.nfo'), body);
        expect(await readNfoForVideo(join(dir, 'big.mkv'))).toEqual({});
    });

    it('readNfoForVideo still reads a normal NFO', async () => {
        await writeFile(
            join(dir, 'ok.nfo'),
            '<movie><uniqueid type="imdb">tt0063350</uniqueid></movie>',
        );
        expect((await readNfoForVideo(join(dir, 'ok.mkv'))).imdbId).toBe('tt0063350');
    });

    it('readAlbumNfo / readArtistNfo return nothing for an over-cap NFO', async () => {
        const album = join(dir, 'album');
        const artist = join(dir, 'artist');
        await Promise.all([
            rm(album, { recursive: true, force: true }),
            rm(artist, { recursive: true, force: true }),
        ]);
        const { mkdir } = await import('node:fs/promises');
        await mkdir(album);
        await mkdir(artist);
        await writeFile(join(album, 'album.nfo'), `<album><title>x</title>${body}</album>`);
        await writeFile(join(artist, 'artist.nfo'), `<artist><name>x</name>${body}</artist>`);
        expect(await readAlbumNfo(album)).toEqual({});
        expect(await readArtistNfo(artist)).toEqual({});
    });
});

describe('every sidecar text reader is bounded', () => {
    const SRC = fileURLToPath(new URL('../../..', import.meta.url));
    const DIRECT_READ =
        /\b(?:readFile|readFileSync|safeReadFile|readContainedFile|createReadStream)\s*\(/;
    // Modules whose input is an untrusted sidecar text file.
    const SIDECAR_PARSERS = /utils\/(?:subtitle-sanitizer|webvtt-parser|nfo-parser)(?:\.js)?['"]/;

    async function walk(d: string, out: string[] = []): Promise<string[]> {
        for (const e of await readdir(d, { withFileTypes: true })) {
            if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
            const p = join(d, e.name);
            if (e.isDirectory()) await walk(p, out);
            else if (/\.ts$/.test(e.name) && !/\.test\.ts$/.test(e.name)) out.push(p);
        }
        return out;
    }

    it('files that feed sidecar text to a parser read it through the shared cap', async () => {
        const offenders: string[] = [];
        const readers: string[] = [];
        for (const file of await walk(SRC)) {
            if ((await stat(file)).size > 400_000) continue;
            const text = await readFile(file, 'utf8');
            const feedsParser =
                SIDECAR_PARSERS.test(text) ||
                /\bsubtitle_path\b/.test(text) ||
                /(?:^|\/)nfo-parser\.ts$/.test(file);
            if (!feedsParser || !DIRECT_READ.test(text)) continue;
            readers.push(relative(SRC, file));
            if (!/readSidecarText|MAX_SIDECAR_TEXT_BYTES/.test(text)) {
                offenders.push(relative(SRC, file));
            }
        }
        expect(offenders).toEqual([]);
        // Guards against the scan silently matching nothing.
        expect(readers).toContain('lib/server/services/subtitle-resolver.service.ts');
    });
});

describe('sidecar readers do not follow planted links or block on special files', () => {
    it('refuses a symlinked .vtt pointing at a secret outside the library', async () => {
        const secret = join(dir, 'master.key');
        await writeFile(secret, 'TESTKEY-123');
        const link = join(dir, 'Movie.en.vtt');
        await symlink(secret, link);
        await expect(readSidecarText(link)).rejects.toBeInstanceOf(ContainmentError);
    });

    it('refuses a FIFO instead of blocking', async () => {
        const fifo = join(dir, 'pipe.vtt');
        execFileSync('mkfifo', [fifo]);
        await expect(readSidecarText(fifo)).rejects.toBeInstanceOf(ContainmentError);
    });

    it('the NFO reader ignores a symlinked movie.nfo', async () => {
        const secret = join(dir, 'secret.nfo');
        await writeFile(secret, '<movie><uniqueid type="imdb">tt0063350</uniqueid></movie>');
        await symlink(secret, join(dir, 'linked.nfo'));
        expect(await readNfoForVideo(join(dir, 'linked.mkv'))).toEqual({});
    });
});
