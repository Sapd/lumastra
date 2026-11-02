// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Prototype 4b, run against the REAL AudiobookShelf.
 *
 * The sibling unit test pins the proxy's behaviour against an upstream we wrote,
 * which can only ever confirm what we believe ABS does. This file answers the
 * three questions the player design flagged as "should work" by asking the
 * production server:
 *
 *  1. Does a mid-file seek of a long m4b come back as a `206` partial, or does
 *     ABS restart the file?
 *  2. Does a transcoded playlist reference its segments relatively, so the
 *     manifest needs no rewriting?
 *  3. Does this server hand off with `X-Accel-Redirect` instead of bytes?
 *
 * Skipped unless `AUDIOURL` + `AUDIOAPIKEY` are set. Point
 * `AUDIOBOOKSHELF_TEST_SEEK_ITEM_ID` at a LONG SINGLE-FILE book — a multi-file
 * book proves nothing about seeking, because every "seek" is just a different
 * small file. Without it the test discovers one, which costs a library scan.
 *
 * The transcode half starts a real ffmpeg job on the ABS server and closes the
 * session afterwards. It uses its own `deviceId` so it cannot evict a human's
 * live session (ABS closes any other open session for the same user+device).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { absFilePath, absHlsPath, proxyAudiobookBytes } from './audiobook-byte-proxy.service.js';

const BASE_URL = (process.env.AUDIOURL ?? '').replace(/\/+$/, '');
const API_KEY = process.env.AUDIOAPIKEY ?? '';
const SEEK_ITEM_ID = process.env.AUDIOBOOKSHELF_TEST_SEEK_ITEM_ID ?? '';
const LIVE = Boolean(BASE_URL && API_KEY);

/** Its own device id — see the file header. */
const DEVICE_ID = 'lumastra-proto-4b-integration';

const suite = LIVE ? describe : describe.skip;

interface AudioFileShape {
    ino: string;
    duration: number;
    metadata: { size: number; ext: string };
}
interface TrackShape {
    contentUrl: string;
    startOffset: number;
    duration: number;
    mimeType: string;
}
interface SessionShape {
    id: string;
    playMethod: number;
    audioTracks: TrackShape[];
}

async function absJson<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${API_KEY}`,
            'Content-Type': 'application/json',
            ...(init?.headers ?? {}),
        },
    });
    if (!res.ok) throw new Error(`${path} → ${res.status}`);
    return (await res.json()) as T;
}

/**
 * Start a playback session.
 *
 * Session creation belongs to the player store, not to the byte proxy, so it is
 * inline here rather than added to `AudiobookshelfClient` — this prototype must
 * not pre-commit the client's session API before §1 is implemented.
 */
function startSession(itemId: string, transcode: boolean): Promise<SessionShape> {
    return absJson<SessionShape>(`/api/items/${itemId}/play`, {
        method: 'POST',
        body: JSON.stringify({
            deviceInfo: {
                clientName: 'Lumastra',
                clientVersion: '0.0.0-proto4b',
                deviceId: `${DEVICE_ID}${transcode ? '-hls' : '-direct'}`,
            },
            supportedMimeTypes: transcode ? [] : ['audio/mpeg', 'audio/mp4', 'audio/flac'],
            mediaPlayer: 'html5',
            forceDirectPlay: false,
            forceTranscode: transcode,
        }),
    });
}

const request = (headers: Record<string, string> = {}) =>
    new Request('https://lumastra.test/proxy', { headers });

/**
 * Poll until a transcode segment materialises.
 *
 * MEASURED 2026-07-29: ABS emits the FULL segment list in the playlist the
 * instant the session is created (4012 entries for a 45-hour book), but the
 * files behind them appear only as ffmpeg encodes. `output-0.ts` 404s for
 * ~850 ms after session start, and a segment far ahead of the encoder
 * (`output-3000.ts`, ~5 h in) still 404s long after playback could have begun.
 *
 * So "the playlist lists it" does NOT mean "the bytes exist" — the proxy passes
 * that 404 through deliberately, and the player must treat a 404 on a listed
 * segment as "not yet", not as "gone".
 */
async function waitForSegment(sessionId: string, file: string, timeoutMs = 30_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const res = await fetch(`${BASE_URL}${absHlsPath(sessionId, file)}`, {
            headers: { Authorization: `Bearer ${API_KEY}` },
        });
        await res.body?.cancel();
        if (res.status === 200) return;
        if (Date.now() > deadline) {
            throw new Error(`${file} still ${res.status} after ${timeoutMs}ms`);
        }
        await new Promise((r) => setTimeout(r, 250));
    }
}

suite('prototype 4b — byte proxy against a live AudiobookShelf', () => {
    let itemId = SEEK_ITEM_ID;
    let file: AudioFileShape;

    beforeAll(async () => {
        if (!itemId) {
            // Discovery fallback: the biggest single-file book on the server.
            const libs = await absJson<{ libraries: Array<{ id: string }> }>('/api/libraries');
            for (const lib of libs.libraries) {
                const page = await absJson<{
                    results: Array<{
                        id: string;
                        media: { numAudioFiles?: number; size?: number };
                    }>;
                }>(`/api/libraries/${lib.id}/items?limit=500&sort=media.size&desc=1`);
                const hit = page.results.find((r) => (r.media.numAudioFiles ?? 0) === 1);
                if (hit) {
                    itemId = hit.id;
                    break;
                }
            }
        }
        expect(
            itemId,
            'no single-file book found; set AUDIOBOOKSHELF_TEST_SEEK_ITEM_ID',
        ).toBeTruthy();

        const expanded = await absJson<{ media: { audioFiles: AudioFileShape[] } }>(
            `/api/items/${itemId}?expanded=1`,
        );
        file = expanded.media.audioFiles[0];
        // A 1 KB range of a 1 MB file would pass the 206 assertions while still
        // being cheap to serve whole; the point is a file big enough that a
        // re-fetch would be obvious.
        expect(file.metadata.size).toBeGreaterThan(50_000_000);
    }, 120_000);

    it('answers a mid-file seek with 206 and only the requested bytes', async () => {
        // Deep into the file — roughly the two-thirds mark of a long book, i.e.
        // a resume position rather than a first-play buffer fill.
        const start = Math.floor(file.metadata.size * 0.66);
        const end = start + 262_143; // 256 KiB

        const res = await proxyAudiobookBytes(
            { baseUrl: BASE_URL, apiKey: API_KEY, upstreamPath: absFilePath(itemId, file.ino) },
            request({ Range: `bytes=${start}-${end}` }),
        );

        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toBe(
            `bytes ${start}-${end}/${file.metadata.size}`,
        );
        expect(res.headers.get('content-length')).toBe('262144');

        // Read the body: content-length can be right while the body is the whole
        // file. This is the assertion that actually rules out a re-fetch.
        const body = await res.arrayBuffer();
        expect(body.byteLength).toBe(262_144);
        expect(body.byteLength).toBeLessThan(file.metadata.size / 100);
    }, 120_000);

    it('advertises range support on the unranged response', async () => {
        const res = await proxyAudiobookBytes(
            { baseUrl: BASE_URL, apiKey: API_KEY, upstreamPath: absFilePath(itemId, file.ino) },
            request(),
        );
        expect(res.status).toBe(200);
        expect(res.headers.get('accept-ranges')).toBe('bytes');
        expect(res.headers.get('content-length')).toBe(String(file.metadata.size));
        // Do not download a gigabyte to prove a header.
        await res.body?.cancel();
    }, 120_000);

    it('does not hand off with X-Accel-Redirect on this server', async () => {
        // Not a tautology: if an operator enables `global.XAccel`, this test is
        // the one that fails, and it fails with the reason named.
        const res = await proxyAudiobookBytes(
            { baseUrl: BASE_URL, apiKey: API_KEY, upstreamPath: absFilePath(itemId, file.ino) },
            request({ Range: 'bytes=0-1023' }),
        );
        expect(res.status).toBe(206);
        await res.body?.cancel();
    }, 60_000);

    it('rejects a request with no ABS credential', async () => {
        // Confirms the file endpoint is genuinely credential-gated upstream, so
        // the proxy is not the only thing standing between the internet and the
        // bytes on THIS path. (The /hls path is a different story — below.)
        const res = await fetch(`${BASE_URL}${absFilePath(itemId, file.ino)}`);
        expect(res.status).toBe(401);
        await res.body?.cancel();
    }, 60_000);

    describe('transcode (HLS)', () => {
        let session: SessionShape | null = null;

        afterAll(async () => {
            if (!session) return;
            // Free the ffmpeg job rather than waiting for ABS's own reaper.
            await fetch(`${BASE_URL}/api/session/${session.id}/close`, {
                method: 'POST',
                headers: { Authorization: `Bearer ${API_KEY}` },
            }).catch(() => {});
        });

        it('returns a single HLS track when nothing is directly playable', async () => {
            session = await startSession(itemId, true);
            expect(session.playMethod).toBe(2); // TRANSCODE
            expect(session.audioTracks).toHaveLength(1);
            expect(session.audioTracks[0].contentUrl).toBe(`/hls/${session.id}/output.m3u8`);
            expect(session.audioTracks[0].mimeType).toBe('application/vnd.apple.mpegurl');
        }, 120_000);

        it('serves a playlist whose segments are relative, needing no rewrite', async () => {
            expect(session).toBeTruthy();
            const res = await proxyAudiobookBytes(
                {
                    baseUrl: BASE_URL,
                    apiKey: API_KEY,
                    upstreamPath: absHlsPath(session!.id, 'output.m3u8'),
                },
                request(),
            );
            expect(res.status).toBe(200);
            const text = await res.text();

            const segments = text
                .split('\n')
                .map((l) => l.trim())
                .filter((l) => l && !l.startsWith('#'));
            expect(segments.length).toBeGreaterThan(10);
            // Relative: no scheme, no leading slash, no ABS hostname anywhere.
            for (const seg of segments.slice(0, 50)) {
                expect(seg).toMatch(/^output-\d+\.ts$/);
            }
            expect(text).not.toContain(BASE_URL);
            expect(text).not.toContain('/hls/');
        }, 180_000);

        it('reaches the right upstream when a segment is resolved relatively', async () => {
            expect(session).toBeTruthy();
            // Resolve exactly as a media element would, off the proxy URL the
            // player would have used — token in the path, so it survives.
            const playlistUrl = `https://lumastra.test/api/v1/audiobook/MEDIA/hls/stream_tok/${session!.id}/output.m3u8`;
            const resolved = new URL('output-0.ts', playlistUrl);
            const parts = resolved.pathname.split('/');
            const fileName = parts.at(-1)!;
            const sessionId = parts.at(-2)!;
            const token = parts.at(-3)!;

            expect(token).toBe('stream_tok');
            expect(sessionId).toBe(session!.id);

            await waitForSegment(sessionId, fileName);
            const res = await proxyAudiobookBytes(
                {
                    baseUrl: BASE_URL,
                    apiKey: API_KEY,
                    upstreamPath: absHlsPath(sessionId, fileName),
                },
                request(),
            );
            expect(res.status).toBe(200);
            expect(res.headers.get('content-type')).toContain('mp2t');
            expect((await res.arrayBuffer()).byteLength).toBeGreaterThan(1000);
        }, 180_000);

        it('confirms ABS serves HLS segments UNAUTHENTICATED — the proxy is the only gate', async () => {
            expect(session).toBeTruthy();
            // Measured, and load-bearing: it is why the /hls proxy route must
            // never be "simplified" into a redirect to ABS.
            await waitForSegment(session!.id, 'output-0.ts');
            const res = await fetch(`${BASE_URL}/hls/${session!.id}/output-0.ts`);
            expect(res.status).toBe(200);
            await res.body?.cancel();
        }, 120_000);

        /**
         * A far seek into a transcoded book is NOT a byte-range problem — the
         * segment simply does not exist yet, and the proxy returns the 404 ABS
         * gave it. Resuming 30 hours into a transcoded book therefore needs a
         * NEW session started at that offset, not a seek within this one. This
         * is the transcode path's equivalent of the direct path's 206, and the
         * two behave nothing alike.
         */
        it('404s a segment beyond the encoder rather than stalling or lying', async () => {
            expect(session).toBeTruthy();
            const res = await proxyAudiobookBytes(
                {
                    baseUrl: BASE_URL,
                    apiKey: API_KEY,
                    upstreamPath: absHlsPath(session!.id, 'output-3000.ts'),
                },
                request(),
            );
            expect(res.status).toBe(404);
            await res.body?.cancel();
        }, 120_000);
    });
});
