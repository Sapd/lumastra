// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fix round 1, finding 3: this module was extracted from mount.ts specifically
 * so `readBoundedBodyText()` could be shared with `middleware/validate.ts`.
 * The extraction surfaced a real hang: `reader.cancel()` on a reader obtained
 * from `Request.clone()`'s body never resolves in Node's fetch implementation
 * once any data has flowed. `readBoundedBodyText()` must therefore be called
 * on a request's OWN body stream, never a clone — this suite pins that with a
 * genuinely streamed (not pre-buffered) oversized body and a real timeout, so
 * a future regression to `.clone()` fails LOUD instead of hanging a test run.
 */

import { describe, it, expect } from 'vitest';
import {
    DEFAULT_MAX_BODY_BYTES,
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyText,
    readBoundedBodyBytes,
    readBoundedJson,
    BodyTooLargeError,
    isPayloadTooLargeError,
    restoreRequestBody,
    restoreRequestBodyBytes,
} from './bounded-body-reader.js';

/** A ReadableStream that trickles chunks out over several ticks, like a real network body. */
function makeSlowStream(totalChunks: number, chunkSize: number): ReadableStream<Uint8Array> {
    let i = 0;
    return new ReadableStream({
        async pull(controller) {
            if (i >= totalChunks) {
                controller.close();
                return;
            }
            await new Promise((r) => setTimeout(r, 1));
            controller.enqueue(new Uint8Array(chunkSize).fill(65));
            i++;
        },
    });
}

describe('isDeclaredContentLengthOverCap', () => {
    it('true when Content-Length exceeds the cap', () => {
        const req = new Request('http://localhost/x', {
            headers: { 'content-length': '1000' },
        });
        expect(isDeclaredContentLengthOverCap(req, 500)).toBe(true);
    });

    it('false when Content-Length is within the cap', () => {
        const req = new Request('http://localhost/x', {
            headers: { 'content-length': '100' },
        });
        expect(isDeclaredContentLengthOverCap(req, 500)).toBe(false);
    });

    it('false when there is no Content-Length header at all', () => {
        const req = new Request('http://localhost/x');
        expect(isDeclaredContentLengthOverCap(req, 500)).toBe(false);
    });
});

describe('readBoundedBodyText', () => {
    it('returns the decoded text for a body within the cap', async () => {
        const req = new Request('http://localhost/x', {
            method: 'POST',
            body: JSON.stringify({ a: 1 }),
        });
        const text = await readBoundedBodyText(req, DEFAULT_MAX_BODY_BYTES);
        expect(text).toBe(JSON.stringify({ a: 1 }));
    });

    it('returns "" for a request with no body', async () => {
        const req = new Request('http://localhost/x');
        const text = await readBoundedBodyText(req, DEFAULT_MAX_BODY_BYTES);
        expect(text).toBe('');
    });

    // 10s > the 5s timeout below is intentional: if this ever regresses to
    // reading a `.clone()`'d stream, the test FAILS on timeout rather than
    // hanging the whole suite indefinitely.
    it('aborts a genuinely STREAMED (not pre-buffered) oversized body without hanging', async () => {
        const stream = makeSlowStream(50, 1000); // 50 chunks * 1000 bytes = 50,000 bytes
        const req = new Request('http://localhost/x', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });

        const result = await readBoundedBodyText(req, 5_000);
        expect(result).toBe(BODY_TOO_LARGE);
    }, 5_000);
});

describe('restoreRequestBody', () => {
    it('makes the request re-readable after its stream was already consumed', async () => {
        const original = new Request('http://localhost/x', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ hello: 'world' }),
        });
        const event = { request: original } as { request: Request };

        const text = await readBoundedBodyText(event.request, DEFAULT_MAX_BODY_BYTES);
        expect(text).toBe(JSON.stringify({ hello: 'world' }));

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        restoreRequestBody(event as any, text as string);

        // A second, independent read must succeed with the SAME content —
        // this is exactly what a handler downstream of withValidation()/
        // mount() does when it also calls event.request.json().
        const rehydrated = (await event.request.json()) as Record<string, unknown>;
        expect(rehydrated).toEqual({ hello: 'world' });
        expect(event.request.headers.get('content-type')).toBe('application/json');
    });
});

// Fix-round-2, 2026-09-16 fix plan (C26): byte-preserving counterparts, used
// where a text round trip would corrupt a binary/multipart body — see
// feature-dispatch.ts's isTextSafeContentType.
describe('readBoundedBodyBytes', () => {
    it('returns the exact bytes for a body within the cap, even invalid UTF-8', async () => {
        const rawBytes = new Uint8Array([0xff, 0x80, 0xfe, 0x00, 0x01]);
        const req = new Request('http://localhost/x', { method: 'POST', body: rawBytes });
        const result = await readBoundedBodyBytes(req, DEFAULT_MAX_BODY_BYTES);
        expect(result).not.toBe(BODY_TOO_LARGE);
        expect(Array.from(result as Uint8Array)).toEqual(Array.from(rawBytes));
    });

    it('returns an empty Uint8Array for a request with no body', async () => {
        const req = new Request('http://localhost/x');
        const result = await readBoundedBodyBytes(req, DEFAULT_MAX_BODY_BYTES);
        expect(result).not.toBe(BODY_TOO_LARGE);
        expect((result as Uint8Array).length).toBe(0);
    });

    it('aborts a genuinely STREAMED oversized body without hanging, never draining it', async () => {
        const stream = makeSlowStream(50, 1000); // 50,000 bytes
        const req = new Request('http://localhost/x', {
            method: 'POST',
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });
        const result = await readBoundedBodyBytes(req, 5_000);
        expect(result).toBe(BODY_TOO_LARGE);
    }, 5_000);
});

describe('restoreRequestBodyBytes', () => {
    it('makes the request re-readable (via arrayBuffer) after its stream was already consumed', async () => {
        const rawBytes = new Uint8Array([1, 2, 3, 4, 250, 251]);
        const original = new Request('http://localhost/x', {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: rawBytes,
        });
        const event = { request: original } as { request: Request };

        const bytes = await readBoundedBodyBytes(event.request, DEFAULT_MAX_BODY_BYTES);
        expect(bytes).not.toBe(BODY_TOO_LARGE);

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        restoreRequestBodyBytes(event as any, bytes as Uint8Array);

        const rehydrated = new Uint8Array(await event.request.arrayBuffer());
        expect(Array.from(rehydrated)).toEqual(Array.from(rawBytes));
        expect(event.request.headers.get('content-type')).toBe('application/octet-stream');
    });
});

describe('readBoundedJson', () => {
    const post = (body: BodyInit) => new Request('http://localhost/x', { method: 'POST', body });

    it('parses a body under the cap', async () => {
        await expect(readBoundedJson(post('{"a":1}'), 64)).resolves.toEqual({ a: 1 });
    });

    it('throws a 413 BodyTooLargeError past the cap, by Content-Length', async () => {
        const err = await readBoundedJson(post('{"a":"' + 'x'.repeat(100) + '"}'), 16).catch(
            (e) => e,
        );
        expect(err).toBeInstanceOf(BodyTooLargeError);
        expect(isPayloadTooLargeError(err)).toBe(true);
    });

    it('throws past the cap for a chunked body that declares no length', async () => {
        const stream = makeSlowStream(8, 1024);
        const request = new Request('http://localhost/x', {
            method: 'POST',
            body: stream,
            // @ts-expect-error Node's fetch needs duplex for a streamed body
            duplex: 'half',
        });
        expect(request.headers.get('content-length')).toBeNull();
        await expect(readBoundedJson(request, 2048)).rejects.toBeInstanceOf(BodyTooLargeError);
    });

    it('rejects malformed and empty JSON with SyntaxError, like request.json()', async () => {
        await expect(readBoundedJson(post('{nope'), 64)).rejects.toBeInstanceOf(SyntaxError);
        await expect(readBoundedJson(post(''), 64)).rejects.toBeInstanceOf(SyntaxError);
    });
});
