// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The content sniff shared by the library scanner and the music-transcode
 * spawn (fix plan 6, Task 7 — rulings T7-probe-outcomes-2, T7-dash-imf,
 * T7-music). `sniffPlaylistMagic` is the pure head check;
 * `sniffFileForPlaylist` reads the file, extending past the head only for a
 * NUL-free (text) file, in search of a DASH/IMF manifest tag.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
    sniffFileForPlaylist,
    sniffPlaylistMagic,
    SNIFF_HEAD_BYTES,
    SNIFF_MANIFEST_MAX_BYTES,
} from './playlist-sniff';
import { haveFfmpeg } from '../../../../tests/helpers/have-ffmpeg';

const utf8 = (s: string): Buffer => Buffer.from(s, 'utf8');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const FIXTURE = join(process.cwd(), 'tests', 'fixtures', 'test-video.mp4');

describe('sniffPlaylistMagic — hits', () => {
    it.each([
        ['ffconcat script', 'ffconcat version 1.0\nfile v.m3u8\n', 'concat'],
        ['HLS playlist', '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\nseg.ts\n', 'hls'],
        ['bare concat script, quoted', "file '/other/library/secret.mkv'\n", 'concat'],
        ['bare concat script, unquoted', 'file secret.mkv\n', 'concat'],
        ['bare concat script after a comment', '# list\nfile secret.mkv\n', 'concat'],
        ['bare concat script, indented with a tab', '\tfile\tsecret.mkv\n', 'concat'],
        ['DASH manifest', '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">', 'dash'],
        [
            'DASH manifest behind an XML declaration',
            '<?xml version="1.0"?>\n<!-- x -->\n<MPD profiles="urn:mpeg:dash:profile:isoff-live:2011">',
            'dash',
        ],
        ['DASH manifest, lower case (dash_probe is case-insensitive)', '<mpd>', 'dash'],
        ['IMF composition playlist', '<?xml version="1.0"?><CompositionPlaylist>', 'imf'],
        ['IMF asset map', '<?xml version="1.0"?><AssetMap>', 'imf'],
    ])('%s', (_label, body, demuxer) => {
        expect(sniffPlaylistMagic(utf8(body))).toBe(demuxer);
    });

    it('skips a UTF-8 BOM and leading whitespace', () => {
        expect(sniffPlaylistMagic(Buffer.concat([BOM, utf8('\n  \r\n#EXTM3U\n')]))).toBe('hls');
        expect(sniffPlaylistMagic(Buffer.concat([BOM, utf8('ffconcat version 1.0\n')]))).toBe(
            'concat',
        );
    });
});

describe('sniffPlaylistMagic — misses (controls)', () => {
    // A binary file whose bytes contain "file" in the middle of a line is
    // not a concat script.
    it('random binary that contains "file" mid-line is not refused', () => {
        const head = Buffer.concat([randomBytes(512), utf8('xxfile yy'), randomBytes(512)]);
        // randomBytes may itself contain "\nfile " — make that impossible.
        const cleaned = Buffer.from(head.toString('latin1').replace(/\n/g, ' '), 'latin1');
        expect(sniffPlaylistMagic(cleaned)).toBeNull();
    });

    // A binary container (NUL bytes in the head) is never read as a concat
    // script, even with "\nfile " somewhere inside it.
    it('a binary head with NUL bytes and a "\\nfile " line is not refused', () => {
        const head = Buffer.concat([
            Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0]),
            utf8('\nfile x\n'),
        ]);
        expect(sniffPlaylistMagic(head)).toBeNull();
    });

    it('a magic that is not at the start of the text is not refused', () => {
        expect(sniffPlaylistMagic(utf8('hello ffconcat version 1.0\n'))).toBeNull();
        expect(sniffPlaylistMagic(utf8('see #EXTM3U\n'))).toBeNull();
        expect(sniffPlaylistMagic(utf8('profile x\n'))).toBeNull();
    });

    // Ruling T7-dash-imf: a manifest tag counts anywhere in the text part,
    // as dash_probe's av_stristr does — also behind a non-"<" first character.
    it('a manifest tag behind leading text is found', () => {
        expect(sniffPlaylistMagic(utf8('junk line\n<MPD>'))).toBe('dash');
    });

    it('an XML document that is not a manifest is not refused', () => {
        expect(
            sniffPlaylistMagic(utf8('<?xml version="1.0"?><Movie><Title>x</Title></Movie>')),
        ).toBeNull();
    });

    it('an empty head is not refused', () => {
        expect(sniffPlaylistMagic(Buffer.alloc(0))).toBeNull();
    });
});

describe('sniffFileForPlaylist', () => {
    let dir: string;
    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'lumastra-playlist-sniff-'));
    });
    afterAll(async () => {
        await rm(dir, { recursive: true, force: true });
    });

    const write = async (name: string, body: string | Buffer): Promise<string> => {
        const p = join(dir, name);
        await writeFile(p, body);
        return p;
    };

    // Ruling T7-dash-imf: a manifest tag behind a long XML comment.
    it.each([
        ['<MPD', '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011">', 'dash'],
        ['<mpd (lower case)', '<mpd>', 'dash'],
        ['<CompositionPlaylist', '<CompositionPlaylist><ContentTitle>x</ContentTitle>', 'imf'],
        ['<AssetMap', '<AssetMap>', 'imf'],
    ])('%s after 5000 bytes of comment is found', async (_label, tag, demuxer) => {
        const p = await write(
            `past-head-${demuxer}-${_label.length}.mkv`,
            `<?xml version="1.0"?>\n<!--${'x'.repeat(5000)}-->\n${tag}\n`,
        );
        expect((await sniffFileForPlaylist(p))?.magic).toBe(demuxer);
    });

    it('finds a tag that straddles two read chunks', async () => {
        // The head is 4 KiB, then 64 KiB chunks: place "<MPD" across the
        // first chunk boundary (4096 + 65536).
        const boundary = SNIFF_HEAD_BYTES + 64 * 1024;
        const body = 'x'.repeat(boundary - 2) + '<MPD>';
        const p = await write('straddle.mkv', body);
        expect((await sniffFileForPlaylist(p))?.magic).toBe('dash');
    });

    // Both FFmpeg probes treat the buffer as a C string: a tag after the
    // first NUL is invisible to them, and the read stops there.
    it('stops at the first NUL — a tag after it is not searched', async () => {
        const p = await write(
            'nul-then-tag.mkv',
            Buffer.concat([utf8('x'.repeat(8000)), Buffer.from([0]), utf8('<MPD>')]),
        );
        const r = await sniffFileForPlaylist(p);
        expect(r?.magic).toBeNull();
        expect(r?.bytesRead).toBeGreaterThan(SNIFF_HEAD_BYTES);
    });

    it(`never reads past ${SNIFF_MANIFEST_MAX_BYTES} bytes`, async () => {
        const p = await write('huge.txt', 'x'.repeat(SNIFF_MANIFEST_MAX_BYTES + 10) + '<MPD>');
        const r = await sniffFileForPlaylist(p);
        expect(r?.magic).toBeNull();
        expect(r?.bytesRead).toBe(SNIFF_MANIFEST_MAX_BYTES);
    });

    // Controls.
    it('control: real media (a NUL in its head) is read for 4 KiB only', async () => {
        const r = await sniffFileForPlaylist(FIXTURE);
        expect(r).toEqual({ magic: null, bytesRead: SNIFF_HEAD_BYTES });
    });

    // Encodes its fixtures with a real ffmpeg, which the CI unit-test job does
    // not install — skipped there; every other case here is pure fs.
    describe.skipIf(!haveFfmpeg())('with a real ffmpeg', () => {
        it('control: a real mp3, flac and webm are read for 4 KiB only', async () => {
            const run = promisify(execFile);
            for (const [ext, args] of [
                ['mp3', ['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'libmp3lame']],
                ['flac', ['-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'flac']],
                ['webm', ['-i', FIXTURE, '-c:v', 'libvpx', '-an', '-t', '1']],
            ] as const) {
                const out = join(dir, `real.${ext}`);
                await run('ffmpeg', ['-v', 'error', '-y', ...args, out]);
                expect(await sniffFileForPlaylist(out), ext).toEqual({
                    magic: null,
                    bytesRead: SNIFF_HEAD_BYTES,
                });
            }
        }, 60_000);
    });

    it('control: a 5 MB NUL-free text without a manifest tag is not refused', async () => {
        const p = await write('big-notes.txt', 'lorem ipsum dolor sit amet\n'.repeat(200_000));
        const r = await sniffFileForPlaylist(p);
        expect(r?.magic).toBeNull();
    });

    it('a file shorter than the head is read once', async () => {
        const p = await write('short.txt', 'hello\n');
        expect(await sniffFileForPlaylist(p)).toEqual({ magic: null, bytesRead: 6 });
    });

    it('rejects with an AbortError when the signal is already aborted', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(
            sniffFileForPlaylist(FIXTURE, { signal: controller.signal }),
        ).rejects.toMatchObject({ name: 'AbortError' });
    });

    it('rejects with an AbortError when aborted during the extended read', async () => {
        const p = await write('abort-mid.txt', 'y'.repeat(2 * 1024 * 1024));
        const controller = new AbortController();
        // Aborts on the first read after the head.
        let reads = 0;
        Object.defineProperty(controller.signal, 'aborted', { get: () => ++reads > 2 });
        await expect(sniffFileForPlaylist(p, { signal: controller.signal })).rejects.toMatchObject({
            name: 'AbortError',
        });
    });

    it('returns null for a directory and for a FIFO, without blocking', async () => {
        expect(await sniffFileForPlaylist(dir)).toBeNull();
        const fifo = join(dir, 'pipe.mkv');
        await promisify(execFile)('mkfifo', [fifo]);
        expect(await sniffFileForPlaylist(fifo)).toBeNull();
    }, 5_000);

    it('rejects with the fs error code for a missing file', async () => {
        await expect(sniffFileForPlaylist(join(dir, 'nope.mkv'))).rejects.toMatchObject({
            code: 'ENOENT',
        });
    });

    it('the head of the mp4 fixture is not a playlist (pure check)', async () => {
        const head = (await readFile(FIXTURE)).subarray(0, SNIFF_HEAD_BYTES);
        expect(sniffPlaylistMagic(head)).toBeNull();
    });
});
