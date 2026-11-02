// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import { dispatchFeatureRequest } from './feature-dispatch.js';
import type { FeatureDefinition, PluginContext } from '@sapd/lumastra-plugin-sdk';

const feature: FeatureDefinition = {
    id: 'demo',
    capabilities: { browserUi: true },
    routes: [
        {
            method: 'GET',
            path: '/hello',
            handler: async (ctx) => Response.json({ user: ctx.user?.username ?? null }),
        },
    ],
};

function deps(found: FeatureDefinition | undefined) {
    return {
        getFeature: (id: string) => (found && found.id === id ? found : undefined),
        buildCtx: () => ({ user: { username: 'alice' } }) as unknown as PluginContext,
    };
}

describe('dispatchFeatureRequest', () => {
    it('401s when no user', async () => {
        const res = await dispatchFeatureRequest(
            {
                featureId: 'demo',
                rest: 'hello',
                method: 'GET',
                request: new Request('http://x/hello'),
                user: null,
            },
            deps(feature),
        );
        expect(res.status).toBe(401);
    });

    it('404s for unknown feature', async () => {
        const res = await dispatchFeatureRequest(
            {
                featureId: 'nope',
                rest: 'hello',
                method: 'GET',
                request: new Request('http://x/hello'),
                user: { userId: 'test-user-id-a', username: 'a', groups: [], isAdmin: false },
            },
            deps(feature),
        );
        expect(res.status).toBe(404);
    });

    it('invokes the matched handler with a built ctx', async () => {
        const res = await dispatchFeatureRequest(
            {
                featureId: 'demo',
                rest: 'hello',
                method: 'GET',
                request: new Request('http://x/hello'),
                user: {
                    userId: 'test-user-id-alice',
                    username: 'alice',
                    groups: [],
                    isAdmin: false,
                },
            },
            deps(feature),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ user: 'alice' });
    });

    it('passes matched :param values to the handler as the 3rd arg', async () => {
        // Regression: handlers like GET /messages/:id read `params.id`. The
        // dispatcher must pass match.params, or every param route 404s.
        const paramFeature: FeatureDefinition = {
            id: 'demo',
            capabilities: { browserUi: true },
            routes: [
                {
                    method: 'GET',
                    path: '/messages/:id',
                    handler: async (_ctx, _req, params) => Response.json({ id: params.id }),
                },
            ],
        };
        const res = await dispatchFeatureRequest(
            {
                featureId: 'demo',
                rest: 'messages/abc-123',
                method: 'GET',
                request: new Request('http://x/messages/abc-123'),
                user: { userId: 'test-user-id-a', username: 'a', groups: [], isAdmin: false },
            },
            deps(paramFeature),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ id: 'abc-123' });
    });

    it('maps a rejecting buildCtx to a 500 (context-build failures are caught)', async () => {
        // buildRequestPluginContext awaits buildAiSurface/buildPluginContext;
        // a rejection there must surface as the dispatcher's JSON 500 contract,
        // not escape unhandled to SvelteKit's default error path.
        const res = await dispatchFeatureRequest(
            {
                featureId: 'demo',
                rest: 'hello',
                method: 'GET',
                request: new Request('http://x/hello'),
                user: {
                    userId: 'test-user-id-alice',
                    username: 'alice',
                    groups: [],
                    isAdmin: false,
                },
            },
            {
                getFeature: (id: string) => (id === feature.id ? feature : undefined),
                buildCtx: () => Promise.reject(new Error('ai module boom')),
            },
        );
        expect(res.status).toBe(500);
        expect(await res.json()).toEqual({ error: 'Internal error' });
    });
});

// C26 (2026-09-16 fix plan): every feature route handler previously read
// req.json()/.text() itself with no shared cap — a plugin's own limiter
// (e.g. shoutbox's 280-char message cap) only runs AFTER the parse, so an
// oversized body was fully buffered and synchronously JSON.parse'd per
// request. dispatchFeatureRequest now bounds the body BEFORE any handler
// sees it.
describe('dispatchFeatureRequest — body size cap (C26)', () => {
    const echoBodyFeature: FeatureDefinition = {
        id: 'demo',
        capabilities: { browserUi: true },
        routes: [
            {
                method: 'POST',
                path: '/messages',
                handler: async (_ctx, req) => {
                    const text = await req.text();
                    return Response.json({ received: text.length });
                },
            },
        ],
    };

    function postDeps() {
        return {
            getFeature: (id: string) => (id === echoBodyFeature.id ? echoBodyFeature : undefined),
            buildCtx: () => ({ user: { username: 'alice' } }) as unknown as PluginContext,
        };
    }

    const user = { userId: 'test-user-id-alice', username: 'alice', groups: [], isAdmin: false };

    it('rejects a genuinely streamed oversized body (413) even when Content-Length LIES (understates it), before the body is fully read', async () => {
        const encoder = new TextEncoder();
        const realBody = JSON.stringify({ padding: 'x'.repeat(300_000) }); // over the 256 KiB default cap
        const chunkSize = 16384;
        let offset = 0;
        const drainTracker = { reachedEnd: false };
        const stream = new ReadableStream<Uint8Array>({
            async pull(controller) {
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
        const request = new Request('http://x/messages', {
            method: 'POST',
            headers: { 'content-length': '10' }, // lies — claims a tiny body
            body: stream,
            duplex: 'half',
        } as RequestInit & { duplex: 'half' });

        const res = await dispatchFeatureRequest(
            { featureId: 'demo', rest: 'messages', method: 'POST', request, user },
            postDeps(),
        );

        expect(res.status).toBe(413);
        // The finding is specifically that the body must never be FULLY
        // buffered — assert the reader was never drained to completion, not
        // merely that the status is 413.
        expect(drainTracker.reachedEnd).toBe(false);
    });

    it('an honest declared Content-Length over the cap is rejected before any byte is read', async () => {
        const request = new Request('http://x/messages', {
            method: 'POST',
            headers: { 'content-length': String(300_000) },
            body: JSON.stringify({ padding: 'x'.repeat(300_000) }),
        });
        const res = await dispatchFeatureRequest(
            { featureId: 'demo', rest: 'messages', method: 'POST', request, user },
            postDeps(),
        );
        expect(res.status).toBe(413);
    });

    it('a normal small body still reaches the handler intact', async () => {
        const request = new Request('http://x/messages', {
            method: 'POST',
            body: JSON.stringify({ hello: 'world' }),
        });
        const res = await dispatchFeatureRequest(
            { featureId: 'demo', rest: 'messages', method: 'POST', request, user },
            postDeps(),
        );
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ received: JSON.stringify({ hello: 'world' }).length });
    });

    it('a bodyless GET request is untouched (no body to bound, no crash)', async () => {
        const res = await dispatchFeatureRequest(
            {
                featureId: 'demo',
                rest: 'hello',
                method: 'GET',
                request: new Request('http://x/hello'),
                user,
            },
            deps(feature),
        );
        expect(res.status).toBe(200);
    });

    // Fix-round-1 review finding: the original C26 fix applied the
    // read-as-text-then-restoreRequestBody round trip to EVERY body,
    // including multipart/binary ones — TextDecoder's U+FFFD replacement on
    // invalid UTF-8 sequences silently corrupts non-text bytes, with no error
    // raised. A plugin's SDK-typed `FeatureRoute` handler may legitimately
    // call `req.formData()`/`req.arrayBuffer()` for an upload.
    it('a multipart/form-data body reaches the handler byte-for-byte, uncorrupted (not text-round-tripped)', async () => {
        // Deliberately invalid UTF-8 bytes (a lone continuation byte) inside
        // the multipart body — TextDecoder would replace this with U+FFFD if
        // the body were ever round-tripped through text.
        const binaryFeature: FeatureDefinition = {
            id: 'demo',
            capabilities: { browserUi: true },
            routes: [
                {
                    method: 'POST',
                    path: '/upload',
                    handler: async (_ctx, req) => {
                        const buf = new Uint8Array(await req.arrayBuffer());
                        return Response.json({ bytes: Array.from(buf) });
                    },
                },
            ],
        };
        const rawBytes = new Uint8Array([
            0x2d, 0x2d, 0x78, 0x0d, 0x0a, 0xff, 0x80, 0xfe, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0x2d,
            0x78, 0x2d, 0x2d,
        ]);
        const request = new Request('http://x/upload', {
            method: 'POST',
            headers: { 'content-type': 'multipart/form-data; boundary=x' },
            body: rawBytes,
        });
        const res = await dispatchFeatureRequest(
            {
                featureId: 'demo',
                rest: 'upload',
                method: 'POST',
                request,
                user,
            },
            {
                getFeature: (id: string) => (id === binaryFeature.id ? binaryFeature : undefined),
                buildCtx: () => ({ user: { username: 'alice' } }) as unknown as PluginContext,
            },
        );
        expect(res.status).toBe(200);
        const { bytes } = (await res.json()) as { bytes: number[] };
        expect(bytes).toEqual(Array.from(rawBytes));
    });

    it('an oversized multipart body is still rejected by the declared-Content-Length check', async () => {
        const request = new Request('http://x/messages', {
            method: 'POST',
            headers: {
                'content-type': 'multipart/form-data; boundary=x',
                'content-length': String(300_000),
            },
            body: new Uint8Array(10),
        });
        const res = await dispatchFeatureRequest(
            { featureId: 'demo', rest: 'messages', method: 'POST', request, user },
            postDeps(),
        );
        expect(res.status).toBe(413);
    });

    // Fix-round-2 review finding: the declared-Content-Length check alone
    // left multipart/binary bodies with NO real streamed cap — a body with
    // no Content-Length (chunked transfer-encoding) or a lying one still
    // reached the plugin handler's own req.formData()/arrayBuffer()
    // completely unbounded, capped only by the adapter's ~50 MB ceiling
    // instead of the intended 256 KB. These three tests use a genuinely
    // streamed (not pre-buffered) multipart body, mirroring the technique
    // native/login/server.test.ts (C15) and webhook-dispatch.test.ts (C17)
    // use for the same class of finding.
    describe('multipart/binary streamed byte-count cap (fix-round-2)', () => {
        const uploadFeature: FeatureDefinition = {
            id: 'demo',
            capabilities: { browserUi: true },
            routes: [
                {
                    method: 'POST',
                    path: '/upload',
                    handler: async (_ctx, req) => {
                        const buf = new Uint8Array(await req.arrayBuffer());
                        return Response.json({ receivedBytes: buf.length });
                    },
                },
            ],
        };
        function uploadDeps() {
            return {
                getFeature: (id: string) => (id === uploadFeature.id ? uploadFeature : undefined),
                buildCtx: () => ({ user: { username: 'alice' } }) as unknown as PluginContext,
            };
        }

        /** A genuinely streamed multipart body, with a real per-chunk delay so a cancel() has a chance to run between chunks (see bounded-body-reader.test.ts's own makeSlowStream). */
        function makeStreamedMultipartRequest(opts: {
            totalBytes: number;
            declaredContentLength: string | undefined;
            drainTracker?: { reachedEnd: boolean };
        }): Request {
            let offset = 0;
            const chunkSize = 8192;
            const stream = new ReadableStream<Uint8Array>({
                async pull(controller) {
                    await new Promise((r) => setTimeout(r, 1));
                    if (offset >= opts.totalBytes) {
                        if (opts.drainTracker) opts.drainTracker.reachedEnd = true;
                        controller.close();
                        return;
                    }
                    const size = Math.min(chunkSize, opts.totalBytes - offset);
                    controller.enqueue(new Uint8Array(size).fill(0x41));
                    offset += size;
                },
            });
            const headers: Record<string, string> = {
                'content-type': 'multipart/form-data; boundary=x',
            };
            if (opts.declaredContentLength !== undefined) {
                headers['content-length'] = opts.declaredContentLength;
            }
            return new Request('http://x/upload', {
                method: 'POST',
                headers,
                body: stream,
                duplex: 'half',
            } as RequestInit & { duplex: 'half' });
        }

        it('a multipart body with NO Content-Length that exceeds the cap is rejected before the handler sees an unbounded body', async () => {
            const drainTracker = { reachedEnd: false };
            const request = makeStreamedMultipartRequest({
                totalBytes: 300_000, // over the 256 KiB default cap
                declaredContentLength: undefined,
                drainTracker,
            });
            const res = await dispatchFeatureRequest(
                { featureId: 'demo', rest: 'upload', method: 'POST', request, user },
                uploadDeps(),
            );
            expect(res.status).toBe(413);
            // The finding is specifically that the body must never be FULLY
            // buffered/handed to the handler — assert the reader was never
            // drained to completion, not merely that the status is 413.
            expect(drainTracker.reachedEnd).toBe(false);
        });

        it('a multipart body declaring a small Content-Length and then streaming past the cap is rejected, not handed to the handler unbounded', async () => {
            const drainTracker = { reachedEnd: false };
            const request = makeStreamedMultipartRequest({
                totalBytes: 300_000, // over the 256 KiB default cap
                declaredContentLength: '10', // lies — claims a tiny body
                drainTracker,
            });
            const res = await dispatchFeatureRequest(
                { featureId: 'demo', rest: 'upload', method: 'POST', request, user },
                uploadDeps(),
            );
            expect(res.status).toBe(413);
            expect(drainTracker.reachedEnd).toBe(false);
        });

        it('a legitimate under-cap multipart upload with no Content-Length still reaches the handler intact', async () => {
            const request = makeStreamedMultipartRequest({
                totalBytes: 50_000, // well under the 256 KiB cap
                declaredContentLength: undefined,
            });
            const res = await dispatchFeatureRequest(
                { featureId: 'demo', rest: 'upload', method: 'POST', request, user },
                uploadDeps(),
            );
            expect(res.status).toBe(200);
            expect(await res.json()).toEqual({ receivedBytes: 50_000 });
        });
    });
});
