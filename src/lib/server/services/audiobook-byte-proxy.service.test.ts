// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Byte-proxy behaviour, measured against a real HTTP upstream rather than a
 * mocked `fetch`.
 *
 * A stub `fetch` would let us assert whatever we believe ABS does; six bugs on
 * this integration were correctly-typed reads of shapes that never carried the
 * data. So the upstream here is an actual `node:http` server: Range arithmetic,
 * `206` status, `content-range` framing and the `X-Accel-Redirect` handoff are
 * exercised end-to-end, and the accompanying `.live.integration.test.ts` re-runs
 * the same assertions against the production AudiobookShelf.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { gzipSync } from 'node:zlib';
import type { AddressInfo } from 'node:net';
import {
    absFilePath,
    absHlsPath,
    AudiobookProxyError,
    proxyAudiobookBytes,
} from './audiobook-byte-proxy.service.js';

/** 64 KiB of deterministic bytes, so a range's CONTENT can be checked, not just its length. */
const BODY = Buffer.from(Array.from({ length: 65536 }, (_, i) => i % 251));

const PLAYLIST = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:6',
    '#EXT-X-PLAYLIST-TYPE:VOD',
    '#EXTINF:6,',
    'output-0.ts',
    '#EXTINF:6,',
    'output-1.ts',
    '#EXT-X-ENDLIST',
    '',
].join('\n');

interface Recorded {
    url: string;
    method: string | undefined;
    range: string | undefined;
    auth: string | undefined;
    acceptEncoding: string | undefined;
    ifRange: string | undefined;
}

let server: Server;
let baseUrl: string;
const recorded: Recorded[] = [];
/** Flipped by the X-Accel test so one upstream can play both operator configs. */
let xAccelEnabled = false;

beforeAll(async () => {
    server = createServer((req, res) => {
        recorded.push({
            url: req.url ?? '',
            method: req.method,
            range: req.headers.range,
            auth: req.headers.authorization,
            acceptEncoding: req.headers['accept-encoding'],
            ifRange:
                typeof req.headers['if-range'] === 'string' ? req.headers['if-range'] : undefined,
        });

        if (req.url === '/api/items/abs-1/file/5193') {
            if (xAccelEnabled) {
                // Exactly what ABS does when the operator sets `global.XAccel`:
                // 204, no body, and a header naming an internal nginx location.
                res.writeHead(204, { 'X-Accel-Redirect': '/internal/audiobooks/book.m4b' });
                res.end();
                return;
            }
            const range = req.headers.range;
            if (range) {
                const m = /^bytes=(\d+)-(\d*)$/.exec(range);
                if (!m) {
                    res.writeHead(416).end();
                    return;
                }
                const start = Number(m[1]);
                const end = m[2] ? Number(m[2]) : BODY.length - 1;
                const slice = BODY.subarray(start, end + 1);
                res.writeHead(206, {
                    'Content-Type': 'audio/mp4',
                    'Content-Length': String(slice.length),
                    'Content-Range': `bytes ${start}-${end}/${BODY.length}`,
                    'Accept-Ranges': 'bytes',
                    ETag: 'W/"deadbeef"',
                });
                res.end(slice);
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'audio/mp4',
                'Content-Length': String(BODY.length),
                'Accept-Ranges': 'bytes',
            });
            res.end(BODY);
            return;
        }

        if (req.url === '/hls/sess-1/output.m3u8') {
            res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
            res.end(PLAYLIST);
            return;
        }
        if (/^\/hls\/sess-1\/output-\d+\.ts$/.test(req.url ?? '')) {
            res.writeHead(200, { 'Content-Type': 'video/mp2t' });
            res.end(Buffer.from('segment'));
            return;
        }
        if (req.url === '/resumable') {
            const headers = {
                'Content-Type': 'audio/mp4',
                ETag: '"original-file"',
                'Last-Modified': 'Wed, 21 Oct 2026 12:00:00 GMT',
                'Accept-Ranges': 'bytes',
            };
            const range = req.headers.range;
            if (
                range &&
                (!req.headers['if-range'] ||
                    req.headers['if-range'] === headers.ETag ||
                    req.headers['if-range'] === headers['Last-Modified'])
            ) {
                const match = /^bytes=(\d+)-(\d*)$/.exec(range);
                const start = match ? Number(match[1]) : -1;
                const end = match?.[2]
                    ? Math.min(Number(match[2]), BODY.length - 1)
                    : BODY.length - 1;
                if (start < 0 || start >= BODY.length || end < start) {
                    res.writeHead(416, {
                        ...headers,
                        'Content-Range': `bytes */${BODY.length}`,
                    }).end();
                    return;
                }
                res.writeHead(206, {
                    ...headers,
                    'Content-Range': `bytes ${start}-${end}/${BODY.length}`,
                    'Content-Length': end - start + 1,
                });
                res.end(BODY.subarray(start, end + 1));
                return;
            }
            res.writeHead(200, { ...headers, 'Content-Length': BODY.length });
            res.end(BODY);
            return;
        }
        if (req.url === '/conditional') {
            if (req.headers['if-none-match'] === 'W/"deadbeef"') {
                res.writeHead(304, { ETag: 'W/"deadbeef"' });
                res.end();
                return;
            }
            res.writeHead(200, { 'Content-Type': 'audio/mp4', ETag: 'W/"deadbeef"' });
            res.end(BODY.subarray(0, 16));
            return;
        }
        if (req.url === '/upstream-error') {
            res.writeHead(500, { 'Content-Type': 'text/html' });
            res.end('<h1>ABS internal detail: /srv/audiobooks/secret/path</h1>');
            return;
        }
        if (req.url === '/bad-range') {
            res.writeHead(416, { 'Content-Range': 'bytes */65536' });
            res.end();
            return;
        }
        if (req.url === '/always-gzip') {
            // An operator's nginx with `gzip on` covering
            // application/vnd.apple.mpegurl, ignoring our Accept-Encoding.
            const gz = gzipSync(Buffer.from(PLAYLIST));
            res.writeHead(200, {
                'Content-Type': 'application/vnd.apple.mpegurl',
                'Content-Encoding': 'gzip',
                'Content-Length': String(gz.length),
            });
            res.end(gz);
            return;
        }
        if (req.url === '/redirect-me') {
            res.writeHead(302, { Location: 'https://elsewhere.invalid/login' });
            res.end();
            return;
        }

        res.writeHead(404).end();
    });

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

const target = (upstreamPath: string) => ({ baseUrl, apiKey: 'abs-key-abc', upstreamPath });
const get = (headers: Record<string, string> = {}) =>
    new Request('https://lumastra.test/whatever', { headers });

describe('audiobook byte proxy — Range passthrough', () => {
    it('forwards Range and returns 206 with the upstream content-range', async () => {
        const res = await proxyAudiobookBytes(
            target(absFilePath('abs-1', '5193')),
            get({ Range: 'bytes=1000-1999' }),
        );

        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toBe('bytes 1000-1999/65536');
        expect(res.headers.get('accept-ranges')).toBe('bytes');
        expect(res.headers.get('content-length')).toBe('1000');

        // The BYTES, not just the framing: a proxy that re-fetched from zero
        // would still report 206 if it copied headers blindly.
        const body = Buffer.from(await res.arrayBuffer());
        expect(body.length).toBe(1000);
        expect(body.equals(BODY.subarray(1000, 2000))).toBe(true);

        expect(recorded.at(-1)?.range).toBe('bytes=1000-1999');
    });

    it('sends an open-ended Range through unchanged (the seek-to-here shape)', async () => {
        const res = await proxyAudiobookBytes(
            target(absFilePath('abs-1', '5193')),
            get({ Range: 'bytes=60000-' }),
        );
        expect(res.status).toBe(206);
        expect(res.headers.get('content-range')).toBe('bytes 60000-65535/65536');
        expect(recorded.at(-1)?.range).toBe('bytes=60000-');
    });

    it('returns 200 and advertises accept-ranges when no Range is asked for', async () => {
        const res = await proxyAudiobookBytes(target(absFilePath('abs-1', '5193')), get());
        expect(res.status).toBe(200);
        expect(res.headers.get('accept-ranges')).toBe('bytes');
        expect(recorded.at(-1)?.range).toBeUndefined();
    });

    it('authenticates upstream with the listener key and never leaks it downstream', async () => {
        const res = await proxyAudiobookBytes(target(absFilePath('abs-1', '5193')), get());
        expect(recorded.at(-1)?.auth).toBe('Bearer abs-key-abc');
        expect(res.headers.get('authorization')).toBeNull();
        // `private` keeps per-user-authorised audio out of shared caches;
        // `max-age=0, must-revalidate` (NOT `no-store`) is what leaves the
        // browser a cached copy to revalidate — the conditional-request
        // forwarding above is pointless without it.
        const cacheControl = res.headers.get('cache-control');
        expect(cacheControl).toContain('private');
        expect(cacheControl).toContain('must-revalidate');
        expect(cacheControl).not.toContain('no-store');
    });

    it('asks upstream for identity encoding so content-length stays truthful', async () => {
        // undici otherwise negotiates gzip on its own, decodes the body, and
        // leaves the COMPRESSED content-length behind — forwarding that
        // truncates the response.
        await proxyAudiobookBytes(target(absFilePath('abs-1', '5193')), get());
        expect(recorded.at(-1)?.acceptEncoding).toBe('identity');
    });

    it('forwards HEAD rather than pulling the whole book to discard it', async () => {
        await proxyAudiobookBytes(target(absFilePath('abs-1', '5193')), get(), { method: 'HEAD' });
        expect(recorded.at(-1)?.method).toBe('HEAD');
    });
});

describe('audiobook byte proxy — HLS relative segments', () => {
    /**
     * The claim under test: preserving the path suffix means the manifest needs
     * no rewriting. Measured with `new URL(relative, base)` — the same
     * relative-reference algorithm a media element uses — rather than asserted.
     */
    it('passes the manifest through byte-for-byte, segments still relative', async () => {
        const res = await proxyAudiobookBytes(target(absHlsPath('sess-1', 'output.m3u8')), get());
        const text = await res.text();

        expect(res.status).toBe(200);
        expect(text).toBe(PLAYLIST);
        expect(text).toContain('\noutput-0.ts\n');
        expect(text).not.toContain(baseUrl);
        expect(text).not.toContain('stream_');
    });

    it('resolves those relative segments back onto the token-carrying path', async () => {
        const playlistUrl =
            'https://lumastra.test/api/v1/audiobook/M/hls/stream_tok/sess-1/output.m3u8';
        expect(new URL('output-0.ts', playlistUrl).pathname).toBe(
            '/api/v1/audiobook/M/hls/stream_tok/sess-1/output-0.ts',
        );
    });

    /**
     * The reason the token is NOT a query parameter. This is the measurement
     * that decided the route shape: relative resolution drops `?stream_token=`,
     * so every segment would arrive anonymous.
     */
    it('drops a query-carried token during relative resolution', async () => {
        const playlistUrl =
            'https://lumastra.test/api/v1/audiobook/M/hls/sess-1/output.m3u8?stream_token=stream_tok';
        const resolved = new URL('output-0.ts', playlistUrl);
        expect(resolved.searchParams.get('stream_token')).toBeNull();
        expect(resolved.href).not.toContain('stream_tok');
    });

    it('drops content-length when something upstream compresses anyway', async () => {
        // The fetch layer decodes the body but leaves the COMPRESSED
        // content-length on the response. Forwarding it would tell the client
        // the manifest is ~40 bytes when it is several hundred — a silently
        // truncated playlist (Node's strictContentLength is off by default).
        const res = await proxyAudiobookBytes(target('/always-gzip'), get());
        expect(res.headers.get('content-length')).toBeNull();
        expect(await res.text()).toBe(PLAYLIST);
    });

    it('serves a segment through the same upstream path shape', async () => {
        const res = await proxyAudiobookBytes(target(absHlsPath('sess-1', 'output-1.ts')), get());
        expect(res.status).toBe(200);
        expect(await res.text()).toBe('segment');
        expect(recorded.at(-1)?.url).toBe('/hls/sess-1/output-1.ts');
    });

    it('rejects a traversal attempt in the session id or file name', () => {
        expect(() => absHlsPath('../../api/items', 'output.m3u8')).toThrow(AudiobookProxyError);
        expect(() => absHlsPath('sess-1', '../../../etc/passwd')).toThrow(AudiobookProxyError);
        expect(() => absHlsPath('sess-1', 'output-0.ts/../../x')).toThrow(AudiobookProxyError);
    });
});

describe('audiobook byte proxy — X-Accel-Redirect', () => {
    /**
     * The failure this guards is silent: `204` is a success status, so a proxy
     * that copies status+headers emits a valid-looking empty response and the
     * player stalls on a zero-byte track with nothing in the logs.
     */
    it('refuses a 204 + X-Accel-Redirect instead of treating it as success', async () => {
        xAccelEnabled = true;
        try {
            await expect(
                proxyAudiobookBytes(target(absFilePath('abs-1', '5193')), get()),
            ).rejects.toMatchObject({ reason: 'xaccel', status: 502 });
        } finally {
            xAccelEnabled = false;
        }
    });

    it('still serves bytes once the operator unsets XAccel', async () => {
        const res = await proxyAudiobookBytes(target(absFilePath('abs-1', '5193')), get());
        expect(res.status).toBe(200);
        expect((await res.arrayBuffer()).byteLength).toBe(BODY.length);
    });
});

describe('audiobook byte proxy — upstream failures', () => {
    it('does not follow a redirect into a login page', async () => {
        await expect(proxyAudiobookBytes(target('/redirect-me'), get())).rejects.toMatchObject({
            reason: 'redirect',
            status: 502,
        });
    });

    it('passes a 404 through rather than masking it as 502', async () => {
        // A dead ABS transcode session 404s its segments; the player needs to
        // see that specific status to restart the session.
        const res = await proxyAudiobookBytes(target('/hls/sess-gone/output-0.ts'), get());
        expect(res.status).toBe(404);
    });

    it('keeps the status of an upstream 5xx but never its body', async () => {
        // ABS's error pages leak filesystem paths and internal detail, and they
        // are never audio — a media element cannot use them for anything.
        const res = await proxyAudiobookBytes(target('/upstream-error'), get());
        expect(res.status).toBe(500);
        expect(await res.json()).toMatchObject({ status: 500, code: 'bad_gateway' });
        expect(res.headers.get('content-type')).toContain('application/problem+json');
    });

    it('keeps content-range on a 416, which is meaningless without it', async () => {
        const res = await proxyAudiobookBytes(
            target('/bad-range'),
            get({ Range: 'bytes=999999999-' }),
        );
        expect(res.status).toBe(416);
        expect(res.headers.get('content-range')).toBe('bytes */65536');
    });

    it('passes a conditional 304 through instead of calling it a redirect', async () => {
        // if-none-match is forwarded on purpose, so 3xx is a NORMAL answer here.
        // Lumping it in with redirects turned every revalidation into a 502.
        const first = await proxyAudiobookBytes(target('/conditional'), get());
        expect(first.status).toBe(200);
        const etag = first.headers.get('etag');
        expect(etag).toBe('W/"deadbeef"');
        await first.arrayBuffer();

        const second = await proxyAudiobookBytes(
            target('/conditional'),
            get({ 'If-None-Match': etag! }),
        );
        expect(second.status).toBe(304);
        expect(second.headers.get('etag')).toBe('W/"deadbeef"');
    });

    it('reports an unreachable server as 502, not a thrown fetch error', async () => {
        await expect(
            proxyAudiobookBytes(
                { baseUrl: 'http://127.0.0.1:1', apiKey: 'k', upstreamPath: '/api/x' },
                get(),
            ),
        ).rejects.toMatchObject({ reason: 'upstream_unreachable', status: 502 });
    });
});

describe('byte response media contract', () => {
    it.each([401, 403])(
        'maps an upstream %i (our ABS key refused) to 502 bad_gateway',
        async (code) => {
            const response = await proxyAudiobookBytes(target('/x'), get(), {
                fetchImpl: async () => new Response('nope', { status: code }),
            });
            expect(response.status).toBe(502);
            expect(response.headers.get('content-type')).toContain('application/problem+json');
            expect(await response.json()).toMatchObject({ code: 'bad_gateway' });
        },
    );
    it.each(['video/mp4', 'audio/mp4', 'video/iso.segment', 'application/mp4'])(
        'accepts %s as media',
        async (type) => {
            const response = await proxyAudiobookBytes(target('/x'), get(), {
                fetchImpl: async () => new Response('bytes', { headers: { 'Content-Type': type } }),
            });
            expect(response.status).toBe(200);
        },
    );
    it('turns upstream JSON success into a problem instead of 200 audio', async () => {
        const response = await proxyAudiobookBytes(target('/json'), get(), {
            fetchImpl: async () =>
                new Response('{"secret":"abs path"}', {
                    headers: { 'Content-Type': 'application/json' },
                }),
        });
        expect(response.status).toBe(502);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(await response.text()).not.toContain('abs path');
    });
    it('returns a problem on 416 while preserving Content-Range', async () => {
        const response = await proxyAudiobookBytes(
            target('/bad-range'),
            get({ Range: 'bytes=invalid' }),
        );
        expect(response.status).toBe(416);
        expect(response.headers.get('content-type')).toContain('application/problem+json');
        expect(response.headers.get('content-range')).toBe('bytes */65536');
    });
});

it.each(['update', 'cold launch', 'background resumption'])(
    'resumes original bytes after %s using a refreshed URL and stable validators',
    async () => {
        const first = await proxyAudiobookBytes(
            target('/resumable'),
            get({ Range: 'bytes=0-4095' }),
        );
        const saved = Buffer.from(await first.arrayBuffer());
        const etag = first.headers.get('etag')!;
        const modified = first.headers.get('last-modified')!;
        expect(first.status).toBe(206);
        expect(first.headers.get('content-range')).toBe(`bytes 0-4095/${BODY.length}`);
        // Persisted partial bytes/validators outlive both the old URL and process state.
        const resumed = await proxyAudiobookBytes(
            target('/resumable'),
            new Request(
                'http://localhost/api/v1/audiobooks/book/files/1?PlaySessionId=new&grant=renewed',
                { headers: { Range: `bytes=${saved.length}-`, 'If-Range': etag } },
            ),
        );
        expect(resumed.status).toBe(206);
        expect(resumed.headers.get('content-range')).toBe(
            `bytes 4096-${BODY.length - 1}/${BODY.length}`,
        );
        expect(resumed.headers.get('etag')).toBe(etag);
        expect(resumed.headers.get('last-modified')).toBe(modified);
        expect(recorded.at(-1)?.ifRange).toBe(etag);
        expect(Buffer.concat([saved, Buffer.from(await resumed.arrayBuffer())])).toEqual(BODY);
    },
);
it('If-Range mismatch returns a complete replacement; invalid ranges return a problem', async () => {
    const replaced = await proxyAudiobookBytes(
        target('/resumable'),
        get({ Range: 'bytes=4096-', 'If-Range': '"old-file"' }),
    );
    expect(replaced.status).toBe(200);
    expect(Buffer.from(await replaced.arrayBuffer())).toEqual(BODY);
    for (const range of ['bytes=90000-', 'bytes=40-20', 'bytes=bogus']) {
        const rejected = await proxyAudiobookBytes(target('/resumable'), get({ Range: range }));
        expect(rejected.status).toBe(416);
        expect(rejected.headers.get('content-range')).toBe(`bytes */${BODY.length}`);
        expect(await rejected.json()).toMatchObject({ status: 416 });
    }
});
