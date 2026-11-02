// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { gzipSync } from 'node:zlib';
import {
    ResponseTooLargeError,
    gunzipBounded,
    readBoundedResponseBytes,
    readBoundedResponseJson,
    readBoundedResponseText,
} from './bounded-response.js';

/** A body that would deliver `total` bytes in 64 KiB chunks and counts what was pulled. */
function endlessBody(total: number): { response: Response; pulled: () => number } {
    let pulled = 0;
    const chunk = new Uint8Array(64 * 1024).fill(0x61);
    const stream = new ReadableStream<Uint8Array>({
        pull(controller) {
            if (pulled >= total) {
                controller.close();
                return;
            }
            pulled += chunk.byteLength;
            controller.enqueue(chunk);
        },
    });
    return { response: new Response(stream), pulled: () => pulled };
}

describe('readBoundedResponse*', () => {
    it('returns a body at or under the cap', async () => {
        const body = 'x'.repeat(1000);
        expect((await readBoundedResponseBytes(new Response(body), 1000)).length).toBe(1000);
        expect(await readBoundedResponseText(new Response('héllo'), 100)).toBe('héllo');
        expect(await readBoundedResponseJson(new Response('{"a":1}'), 100)).toEqual({ a: 1 });
    });

    it('stops pulling from the network once the cap is passed', async () => {
        const { response, pulled } = endlessBody(512 * 1024 * 1024);
        await expect(readBoundedResponseBytes(response, 1024 * 1024)).rejects.toBeInstanceOf(
            ResponseTooLargeError,
        );
        expect(pulled()).toBeLessThan(8 * 1024 * 1024);
    });

    it('rejects an uncompressed body that declares a length over the cap before reading it', async () => {
        const { response, pulled } = endlessBody(10 * 1024 * 1024);
        const declared = new Response(response.body, {
            headers: { 'content-length': '999999999' },
        });
        await expect(readBoundedResponseBytes(declared, 1024)).rejects.toBeInstanceOf(
            ResponseTooLargeError,
        );
        expect(pulled()).toBeLessThan(1024 * 1024);
    });

    it('does not trust Content-Length of a compressed body, only the bytes that arrive', async () => {
        const res = new Response('tiny', {
            headers: { 'content-length': '999999999', 'content-encoding': 'gzip' },
        });
        expect(await readBoundedResponseText(res, 100)).toBe('tiny');
    });

    it('propagates malformed JSON like response.json()', async () => {
        await expect(readBoundedResponseJson(new Response('{'), 100)).rejects.toBeInstanceOf(
            SyntaxError,
        );
    });
});

describe('gunzipBounded', () => {
    it('inflates a payload under the cap', async () => {
        const out = await gunzipBounded(gzipSync('hello world'), 1024);
        expect(out.toString()).toBe('hello world');
    });

    it('refuses a gzip bomb at the cap', async () => {
        const bomb = gzipSync(Buffer.alloc(64 * 1024 * 1024));
        expect(bomb.length).toBeLessThan(1024 * 1024);
        await expect(gunzipBounded(bomb, 8 * 1024 * 1024)).rejects.toBeInstanceOf(
            ResponseTooLargeError,
        );
    });

    it('passes a malformed archive through as the zlib error', async () => {
        await expect(gunzipBounded(Buffer.from('not gzip'), 1024)).rejects.toThrow();
    });
});
