// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** App-side source fetches must traverse the configured upstream proxy.
 * The Rust media transport is covered by native upstream_transport tests. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import net from 'node:net';

interface TestServer {
    port: number;
    close: () => Promise<void>;
}

// ── In-process forward proxy (records every target it is asked to reach) ───────
const proxyHits: string[] = [];
function startProxy(): Promise<TestServer> {
    const server = http.createServer((req, res) => {
        // Classic forward proxy: req.url is an absolute URI (ffmpeg/curl style).
        proxyHits.push(`HTTP ${req.url}`);
        const target = new URL(req.url ?? '');
        const upstream = http.request(
            {
                host: target.hostname,
                port: target.port,
                path: target.pathname + target.search,
                method: req.method,
                headers: req.headers,
            },
            (pr) => {
                res.writeHead(pr.statusCode ?? 502, pr.headers);
                pr.pipe(res);
            },
        );
        upstream.on('error', () => {
            res.writeHead(502);
            res.end('proxy upstream error');
        });
        req.pipe(upstream);
    });
    // CONNECT tunnelling (undici ProxyAgent style).
    server.on('connect', (req, clientSocket, head) => {
        proxyHits.push(`CONNECT ${req.url}`);
        const [host, portStr] = (req.url ?? '').split(':');
        const serverSocket = net.connect(Number(portStr), host, () => {
            clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            serverSocket.write(head);
            serverSocket.pipe(clientSocket);
            clientSocket.pipe(serverSocket);
        });
        serverSocket.on('error', () => clientSocket.end());
        clientSocket.on('error', () => serverSocket.destroy());
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as net.AddressInfo).port;
            resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
        });
    });
}

// ── In-process origin (the "IPTV provider") ───────────────────────────────────
let clipBytes: Buffer | null = null;
function startOrigin(): Promise<TestServer> {
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith('/playlist.m3u8')) {
            res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
            res.end('#EXTM3U\n#EXTINF:-1,Test Channel\nhttp://example/stream.ts\n');
            return;
        }
        if (req.url?.startsWith('/clip.ts') && clipBytes) {
            res.writeHead(200, { 'content-type': 'video/mp2t' });
            res.end(clipBytes);
            return;
        }
        res.writeHead(404);
        res.end('nope');
    });
    return new Promise((resolve) => {
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as net.AddressInfo).port;
            resolve({ port, close: () => new Promise((r) => server.close(() => r())) });
        });
    });
}

describe('E2E: LiveTV upstream proxy routes traffic through a real proxy', () => {
    let proxy: TestServer;
    let origin: TestServer;
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(async () => {
        savedEnv.LIVETV_UPSTREAM_PROXY_URL = process.env.LIVETV_UPSTREAM_PROXY_URL;
        savedEnv.LIVETV_ALLOW_PRIVATE_URLS = process.env.LIVETV_ALLOW_PRIVATE_URLS;
        proxy = await startProxy();
        origin = await startOrigin();
    });

    afterAll(async () => {
        await proxy?.close();
        await origin?.close();
        for (const key of ['LIVETV_UPSTREAM_PROXY_URL', 'LIVETV_ALLOW_PRIVATE_URLS']) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
    });

    it('APP SIDE — M3U import goes through the proxy when configured, direct when not', async () => {
        const originUrl = `http://127.0.0.1:${origin.port}/playlist.m3u8`;

        // (1) Proxy configured — exercise the real import fetch path. config.ts
        // snapshots process.env at module load, so set env then re-import fresh.
        process.env.LIVETV_UPSTREAM_PROXY_URL = `http://127.0.0.1:${proxy.port}`;
        process.env.LIVETV_ALLOW_PRIVATE_URLS = 'true'; // origin is on 127.0.0.1
        vi.resetModules();
        const proxied = await import('./fetch-source.js');
        const logger = { error() {}, warn() {}, info() {} } as unknown as Parameters<
            typeof proxied.fetchSsrfValidatedText
        >[1]['logger'];
        const before = proxyHits.length;
        const text = await proxied.fetchSsrfValidatedText(originUrl, {
            sourceId: 'e2e',
            logger,
            contentLabel: 'M3U',
            fetchFailLogMessage: 'fail',
        });
        const seen = proxyHits.slice(before);

        expect(text).toContain('#EXTM3U');
        expect(seen.some((h) => h.includes(`:${origin.port}`))).toBe(true);

        // (2) No proxy — must reach the origin directly, never touching the proxy.
        delete process.env.LIVETV_UPSTREAM_PROXY_URL;
        vi.resetModules();
        const direct = await import('./fetch-source.js');
        const before2 = proxyHits.length;
        const text2 = await direct.fetchSsrfValidatedText(originUrl, {
            sourceId: 'e2e',
            logger,
            contentLabel: 'M3U',
            fetchFailLogMessage: 'fail',
        });
        expect(text2).toContain('#EXTM3U');
        expect(proxyHits.length).toBe(before2);
    });
});
