// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A local HTTP/2 server that impersonates APNs, plus the scaffolding a test
 * needs to point `DirectApnsTransport` at it.
 *
 * 🔴 **No test here reaches Apple.** Everything binds to 127.0.0.1 on an
 * ephemeral port.
 *
 * Real HTTP/2 over TLS, not a stubbed dispatcher, because the things most
 * likely to be wrong are protocol-level: whether the fan-out actually issues
 * one request per token, whether the headers land with the right names, whether
 * the streams multiplex over one connection instead of serialising. A stubbed
 * dispatcher would assert none of that — and the undici `idempotent` trap the
 * transport documents is invisible without a real connection.
 *
 * TLS is unavoidable: undici only negotiates HTTP/2 through ALPN, so a
 * cleartext server would silently be answered over HTTP/1.1. The certificate is
 * generated per test process with `openssl` and lives in a temp directory —
 * nothing is committed, and the test dispatcher passes `rejectUnauthorized:
 * false`, so its contents never matter.
 *
 * Named `*.testing.ts` rather than `*.test.ts` so vitest treats it as a module,
 * not a suite (a file with no tests counts as a failure in this repo).
 *
 * @module services/push/fake-apns.testing
 */

import { execFileSync } from 'node:child_process';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http2, {
    type Http2SecureServer,
    type ServerHttp2Session,
    type ServerHttp2Stream,
} from 'node:http2';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeJwt, decodeProtectedHeader } from 'jose';
import { Pool, type Dispatcher } from 'undici';
import type { ApnsDispatcherFactory } from './direct-apns-transport.js';

export interface RecordedApnsRequest {
    method: string;
    path: string;
    /** The device token parsed out of `/3/device/<token>`. */
    token: string;
    headers: Record<string, string>;
    body: string;
    receivedAt: number;
}

export interface FakeApnsReply {
    status?: number;
    /** Serialised as `{"reason": "..."}`, the way Apple reports failures. */
    reason?: string;
    apnsId?: string;
    delayMs?: number;
}

export type FakeApnsHandler = (
    request: RecordedApnsRequest,
    index: number,
) => FakeApnsReply | Promise<FakeApnsReply>;

let cachedTls: { key: string; cert: string } | null = null;

/**
 * A throwaway self-signed certificate for 127.0.0.1, generated at run time.
 *
 * Generated rather than committed: an EC private key checked into a public
 * repository is a finding in every security audit, however loudly its comment
 * insists it is only a test fixture.
 */
function tlsMaterial(): { key: string; cert: string } {
    if (cachedTls) return cachedTls;
    const dir = mkdtempSync(join(tmpdir(), 'lumastra-fake-apns-'));
    try {
        const keyPath = join(dir, 'key.pem');
        const certPath = join(dir, 'cert.pem');
        execFileSync('openssl', [
            'ecparam',
            '-name',
            'prime256v1',
            '-genkey',
            '-noout',
            '-out',
            keyPath,
        ]);
        execFileSync('openssl', [
            'req',
            '-new',
            '-x509',
            '-key',
            keyPath,
            '-out',
            certPath,
            '-days',
            '2',
            '-subj',
            '/CN=localhost',
        ]);
        cachedTls = { key: readFileSync(keyPath, 'utf8'), cert: readFileSync(certPath, 'utf8') };
        return cachedTls;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

export class FakeApns {
    readonly requests: RecordedApnsRequest[] = [];

    #server: Http2SecureServer;
    #handler: FakeApnsHandler;
    #origin = '';
    #sessionCount = 0;
    #sessions = new Set<ServerHttp2Session>();

    private constructor(server: Http2SecureServer, handler: FakeApnsHandler) {
        this.#server = server;
        this.#handler = handler;
    }

    static async start(handler: FakeApnsHandler = () => ({ status: 200 })): Promise<FakeApns> {
        const { key, cert } = tlsMaterial();
        const server = http2.createSecureServer({ key, cert, allowHTTP1: false });
        const fake = new FakeApns(server, handler);

        server.on('session', (session) => {
            fake.#sessionCount += 1;
            fake.#sessions.add(session);
            session.on('close', () => fake.#sessions.delete(session));
            session.on('error', () => {});
        });
        server.on('stream', (stream, headers) => {
            // `Http2SecureServer`'s 'stream' event is typed with the base
            // `Http2Stream`; on a server it is always the server variant, which
            // is the one carrying `respond()`.
            void fake.#onStream(stream as ServerHttp2Stream, headers);
        });
        // A client abandoning a stream when its deadline fires is expected.
        server.on('sessionError', () => {});
        server.on('clientError', () => {});

        await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
        const address = server.address() as AddressInfo;
        fake.#origin = `https://127.0.0.1:${address.port}`;
        return fake;
    }

    get origin(): string {
        return this.#origin;
    }

    /** Tokens seen, in arrival order. */
    get tokens(): string[] {
        return this.requests.map((r) => r.token);
    }

    /** HTTP/2 sessions accepted. One fan-out must not open one per token. */
    get sessionCount(): number {
        return this.#sessionCount;
    }

    /** The `authorization` header of every request, in arrival order. */
    get authorizations(): string[] {
        return this.requests.map((r) => r.headers.authorization ?? '');
    }

    setHandler(handler: FakeApnsHandler): void {
        this.#handler = handler;
    }

    reset(): void {
        this.requests.length = 0;
    }

    async stop(): Promise<void> {
        // Force-close kept-alive sessions first: `Http2SecureServer` has no
        // `closeAllConnections()`, so `close()` alone waits for undici's
        // keep-alive to lapse and the test process hangs.
        for (const session of this.#sessions) session.destroy();
        this.#sessions.clear();
        await new Promise<void>((resolve) => this.#server.close(() => resolve()));
    }

    async #onStream(stream: ServerHttp2Stream, headers: http2.IncomingHttpHeaders): Promise<void> {
        const chunks: Buffer[] = [];
        stream.on('data', (chunk: Buffer) => chunks.push(chunk));
        stream.on('error', () => {});

        await new Promise<void>((resolve) => {
            stream.on('end', resolve);
            stream.on('close', resolve);
        });

        const path = String(headers[':path'] ?? '');
        const flat: Record<string, string> = {};
        for (const [name, value] of Object.entries(headers)) {
            if (name.startsWith(':')) continue;
            flat[name] = Array.isArray(value) ? (value[0] ?? '') : String(value ?? '');
        }

        const record: RecordedApnsRequest = {
            method: String(headers[':method'] ?? ''),
            path,
            token: path.startsWith('/3/device/') ? path.slice('/3/device/'.length) : '',
            headers: flat,
            body: Buffer.concat(chunks).toString('utf8'),
            receivedAt: Date.now(),
        };
        const index = this.requests.push(record) - 1;

        let reply: FakeApnsReply;
        try {
            reply = await this.#handler(record, index);
        } catch {
            reply = { status: 500 };
        }

        if (reply.delayMs) {
            await new Promise((resolve) => setTimeout(resolve, reply.delayMs));
        }
        if (stream.destroyed || stream.closed) return;

        const status = reply.status ?? 200;
        const responseHeaders: Record<string, string | number> = {
            ':status': status,
            'apns-id': reply.apnsId ?? '00000000-0000-0000-0000-000000000000',
        };

        if (status === 200) {
            stream.respond(responseHeaders);
            stream.end();
            return;
        }

        const body = JSON.stringify({ reason: reply.reason ?? 'InternalServerError' });
        responseHeaders['content-type'] = 'application/json';
        responseHeaders['content-length'] = Buffer.byteLength(body);
        stream.respond(responseHeaders);
        stream.end(body);
    }
}

/**
 * A P-256 private key in the shape Apple ships a `.p8`. Generated per call;
 * nothing here is or has ever been a real Apple key.
 */
export function testSigningKey(): string {
    const { privateKey } = generateKeyPairSync('ec', {
        namedCurve: 'prime256v1',
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
        publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    return privateKey;
}

/**
 * Dispatchers for the fake APNs. `rejectUnauthorized: false` is scoped to
 * tests; production uses the default trust store.
 */
export const testApnsDispatcherFactory: ApnsDispatcherFactory = (origin: string): Dispatcher =>
    new Pool(origin, {
        allowH2: true,
        connections: 1,
        // Mirrors production: without an explicit pipelining value undici
        // carries one stream at a time and the fan-out silently serialises.
        pipelining: 100,
        connect: { rejectUnauthorized: false },
    });

/** A device token of the shape iOS produces: 64 lowercase hex characters. */
export function deviceToken(seed: number): string {
    return seed.toString(16).padStart(2, '0').repeat(32).slice(0, 64);
}

/** Decoded parts of a provider JWT, for asserting on what was signed. */
export function inspectProviderJwt(authorizationHeader: string): {
    jwt: string;
    kid: string | undefined;
    alg: string | undefined;
    iss: string | undefined;
    iat: number | undefined;
} {
    const jwt = authorizationHeader.replace(/^bearer\s+/i, '');
    const header = decodeProtectedHeader(jwt);
    const claims = decodeJwt(jwt);
    return { jwt, kid: header.kid, alg: header.alg, iss: claims.iss, iat: claims.iat };
}
