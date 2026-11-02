// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Seam test for requestBodyDrainHandle: a real Node HTTP server wired the way
 * adapter-node's handler is (`getRequest` / `setResponse` from
 * `@sveltejs/kit/node`, with a BODY_SIZE_LIMIT), real body readers, and a
 * client that sends an oversized body on a keep-alive connection and then a
 * second request on the SAME socket.
 *
 * Before the fix the second request never got an answer: the early 413 left
 * the body unread with the socket paused, so the server never parsed the next
 * request (Caddy and Traefik answered it with a 502), and the bounded reader's
 * cancel() destroyed the socket before the 413 went out.
 */

import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent, ResolveOptions } from '@sveltejs/kit';
import { getRequest, setResponse } from '@sveltejs/kit/node';
import { problem } from '$lib/server/api/problem';
import { readAvatarUpload } from '$lib/server/utils/avatar-upload';
import { BODY_TOO_LARGE, readBoundedBodyText } from '$lib/server/utils/bounded-body-reader';
import { MAX_DRAIN_BYTES, requestBodyDrainHandle } from './request-body-drain';

const BODY_SIZE_LIMIT = 4 * 1024 * 1024;
const MiB = 1024 * 1024;

/** The routes under test, each an early-rejection shape found in the app. */
async function route(event: RequestEvent): Promise<Response> {
    const { pathname } = new URL(event.request.url);
    switch (pathname) {
        case '/avatar':
        case '/unlimited/avatar': {
            // Declared Content-Length over the cap: answered before a byte is read.
            const upload = await readAvatarUpload(event.request);
            if (upload.kind === 'too_large') {
                return problem('payload_too_large', { error: 'File too large' });
            }
            return new Response(null, { status: 204 });
        }
        case '/bounded': {
            // Streamed cap (mount.ts / withValidation): stops reading partway.
            const text = await readBoundedBodyText(event.request, 64 * 1024);
            if (text === BODY_TOO_LARGE) return problem('payload_too_large');
            return new Response(null, { status: 204 });
        }
        case '/limit': {
            // adapter-node's BODY_SIZE_LIMIT, surfaced by a body read.
            try {
                await event.request.arrayBuffer();
            } catch {
                return problem('payload_too_large');
            }
            return new Response(null, { status: 204 });
        }
        case '/denied':
            // An auth / CSRF rejection that never looks at the body.
            return problem('forbidden');
        default:
            return Response.json({ ok: true });
    }
}

let server: http.Server;
let port: number;
/** TCP connections the server has accepted; one per keep-alive socket. */
let connections = 0;
const savedLimit = process.env.BODY_SIZE_LIMIT;

beforeAll(async () => {
    process.env.BODY_SIZE_LIMIT = '4M';
    server = http.createServer((req, res) => {
        void (async () => {
            const request = await getRequest({
                request: req,
                base: 'http://localhost',
                // /unlimited stands in for an install with a raised BODY_SIZE_LIMIT.
                bodySizeLimit: req.url?.startsWith('/unlimited') ? Infinity : BODY_SIZE_LIMIT,
            });
            const event = { request } as RequestEvent;
            const response = await requestBodyDrainHandle({
                event,
                resolve: (e: RequestEvent, _opts?: ResolveOptions) => route(e),
            });
            await setResponse(res, response);
        })();
    });
    server.on('connection', () => connections++);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
    if (savedLimit === undefined) delete process.env.BODY_SIZE_LIMIT;
    else process.env.BODY_SIZE_LIMIT = savedLimit;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

interface Reply {
    status: number;
    headers: http.IncomingHttpHeaders;
    body: string;
}

function send(
    agent: http.Agent,
    method: string,
    path: string,
    body?: Buffer,
    headers: Record<string, string> = {},
): Promise<Reply> {
    return new Promise((resolve, reject) => {
        const req = http.request(
            { host: '127.0.0.1', port, method, path, agent, headers, timeout: 10_000 },
            (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (c: Buffer) => chunks.push(c));
                res.on('end', () =>
                    resolve({
                        status: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString(),
                    }),
                );
            },
        );
        req.on('timeout', () => req.destroy(new Error(`${method} ${path} timed out`)));
        req.on('error', reject);
        req.end(body);
    });
}

/** Oversized upload, then a normal request that must reuse the same socket. */
async function oversizeThenNext(
    path: string,
    body: Buffer,
    headers: Record<string, string>,
): Promise<{ first: Reply; next: Reply; sockets: number }> {
    // maxSockets 1: the second request waits for the first one's socket, and
    // only gets it once the server has answered and the body is off the wire.
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    const before = connections;
    try {
        const first = await send(agent, 'PUT', path, body, headers);
        const next = await send(agent, 'GET', '/next');
        return { first, next, sockets: connections - before };
    } finally {
        agent.destroy();
    }
}

function expectProblem413(reply: Reply): void {
    expect(reply.status).toBe(413);
    expect(reply.headers['content-type']).toMatch(/json/);
    expect(JSON.parse(reply.body)).toMatchObject({ code: 'payload_too_large', status: 413 });
}

describe('requestBodyDrainHandle on a keep-alive socket', () => {
    const octets = { 'content-type': 'application/octet-stream' };

    it('drains a body refused on its Content-Length so the next request is answered', async () => {
        // Over the 2 MB avatar cap, under BODY_SIZE_LIMIT: the stream is live
        // and nobody reads it.
        const body = Buffer.alloc(3 * MiB, 1);
        const { first, next, sockets } = await oversizeThenNext('/avatar', body, {
            'content-type': 'multipart/form-data; boundary=x',
        });
        expectProblem413(first);
        expect(first.headers.connection).toBe('keep-alive');
        expect(next.status).toBe(200);
        expect(sockets).toBe(1);
    });

    it('answers a streamed-cap 413 instead of dropping the socket, then serves the next request', async () => {
        const { first, next, sockets } = await oversizeThenNext(
            '/bounded',
            Buffer.alloc(2 * MiB, 1),
            octets,
        );
        expectProblem413(first);
        expect(next.status).toBe(200);
        expect(sockets).toBe(1);
    });

    it('keeps the socket usable after a rejection that never reads the body', async () => {
        const { first, next, sockets } = await oversizeThenNext(
            '/denied',
            Buffer.alloc(3 * MiB, 1),
            octets,
        );
        expect(first.status).toBe(403);
        expect(next.status).toBe(200);
        expect(sockets).toBe(1);
    });

    it('keeps BODY_SIZE_LIMIT rejections clean: 413 JSON, next request on the same socket', async () => {
        const { first, next, sockets } = await oversizeThenNext(
            '/limit',
            Buffer.alloc(BODY_SIZE_LIMIT + MiB, 1),
            octets,
        );
        expectProblem413(first);
        expect(first.headers.connection).toBe('keep-alive');
        expect(next.status).toBe(200);
        expect(sockets).toBe(1);
    });

    it('leaves a fully read body alone: no Connection: close on a normal upload', async () => {
        const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
        try {
            const first = await send(agent, 'PUT', '/bounded', Buffer.alloc(1024, 1), octets);
            expect(first.status).toBe(204);
            expect(first.headers.connection).toBe('keep-alive');
        } finally {
            agent.destroy();
        }
    });

    it('closes instead of draining a live body declared over MAX_DRAIN_BYTES, after sending the 413', async () => {
        // Declare a huge body but send only a little of it: the server must
        // answer and close rather than wait for the rest.
        const socket = net.connect(port, '127.0.0.1');
        const received: Buffer[] = [];
        socket.on('data', (c: Buffer) => received.push(c));
        const closed = new Promise<void>((resolve) => socket.on('close', () => resolve()));
        socket.on('error', () => {});
        socket.write(
            `PUT /unlimited/avatar HTTP/1.1\r\nHost: localhost\r\nConnection: keep-alive\r\n` +
                `Content-Type: multipart/form-data; boundary=x\r\n` +
                `Content-Length: ${MAX_DRAIN_BYTES + 1}\r\n\r\n`,
        );
        socket.write(Buffer.alloc(256 * 1024, 1));

        const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('server kept the socket open')), 10_000),
        );
        await Promise.race([closed, timeout]);

        const raw = Buffer.concat(received).toString();
        expect(raw).toMatch(/^HTTP\/1\.1 413 /);
        expect(raw.toLowerCase()).toContain('connection: close');
        expect(raw).toContain('"payload_too_large"');
    });
});
