// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * C22/C26 fix-round-1 review finding: `readClientInfoBody` (used by
 * `POST /rest/getTranscodeDecision.view`) was a bare `event.request.json()`
 * — the fifth hand-written reader outside every body cap, named in the C26
 * finding text as "the same class, authenticated". Unit-tests the bounded
 * reader directly rather than through the full handler, which needs a real
 * Postgres connection + filesystem probes (see
 * `transcode.integration.test.ts` for the DB-backed suite).
 *
 * Uses the same real-per-chunk-delay streamed-body technique as
 * `native/login/server.test.ts` (C15) so the streamed reader — not just the
 * cheap declared-Content-Length precheck — is genuinely exercised.
 */

import { describe, it, expect } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { BODY_TOO_LARGE } from '$lib/server/utils/bounded-body-reader.js';
import { readClientInfoBody } from './transcode.js';

function makeEvent(request: Request): RequestEvent {
    return { request } as unknown as RequestEvent;
}

describe('readClientInfoBody', () => {
    it('parses a normal small ClientInfo body', async () => {
        const request = new Request('http://x/rest/getTranscodeDecision.view', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ name: 'DSub', platform: 'android' }),
        });
        const result = await readClientInfoBody(makeEvent(request));
        expect(result).toEqual({ name: 'DSub', platform: 'android' });
    });

    it('returns null for a GET-shaped request with no body', async () => {
        const request = new Request('http://x/rest/getTranscodeDecision.view');
        const result = await readClientInfoBody(makeEvent(request));
        expect(result).toBeNull();
    });

    it('returns null for malformed JSON (does not throw)', async () => {
        const request = new Request('http://x/rest/getTranscodeDecision.view', {
            method: 'POST',
            body: 'not json',
        });
        const result = await readClientInfoBody(makeEvent(request));
        expect(result).toBeNull();
    });

    it('rejects an honest declared Content-Length over the 16 KiB cap without reading any byte', async () => {
        const request = new Request('http://x/rest/getTranscodeDecision.view', {
            method: 'POST',
            headers: { 'content-length': String(20_000) },
            body: 'x'.repeat(20_000),
        });
        const result = await readClientInfoBody(makeEvent(request));
        expect(result).toBe(BODY_TOO_LARGE);
    });

    it('rejects a genuinely streamed oversized body even when Content-Length LIES (understates it), before the body is fully read', async () => {
        const encoder = new TextEncoder();
        const realBody = JSON.stringify({ padding: 'x'.repeat(20_000) }); // over the 16 KiB cap
        const chunkSize = 4096;
        let offset = 0;
        const drainTracker = { reachedEnd: false };
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
                // Real per-chunk delay (see bounded-body-reader.test.ts's own
                // makeSlowStream) so cancel() has a chance to run between chunks.
                await new Promise((r) => setTimeout(r, 1));
                if (offset >= realBody.length) {
                    drainTracker.reachedEnd = true;
                    controller.close();
                    return;
                }
                controller.enqueue(encoder.encode(realBody.slice(offset, offset + chunkSize)));
                offset += chunkSize;
            },
        });
        const request = new Request('http://x/rest/getTranscodeDecision.view', {
            method: 'POST',
            headers: { 'content-length': '10' }, // lies — claims a tiny body
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });

        const result = await readClientInfoBody(makeEvent(request));
        expect(result).toBe(BODY_TOO_LARGE);
        // The finding is specifically that the body must never be FULLY
        // buffered — assert the reader was never drained to completion.
        expect(drainTracker.reachedEnd).toBe(false);
    });
});
