// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fault proxy between the browsers and the e2e server.
 *
 * Transparent by default (every method, streamed bodies, SSE). A scenario arms a
 * fault through the control path, which is answered here and never forwarded:
 *
 *   POST /__e2e_proxy/fault {match, kind:'cut', afterBytes, count}   drop the TCP
 *        connection after `afterBytes` of the response body (a network drop mid-track)
 *   POST /__e2e_proxy/fault {match, kind:'status', status, count}     answer `status`
 *        without asking the server (a dead stream: 404, expired 401)
 *   POST /__e2e_proxy/reset                                           clear faults + log
 *   GET  /__e2e_proxy/log?match=…                                     requests seen for
 *        URLs containing `match`: range header, status, content-range, bytes sent, cut
 *
 * `match` is a substring of the request path. `count` faults the next N matching
 * requests (default 1); later ones pass through, like a network that recovers.
 *
 * It runs in the Playwright runner process (started by globalSetup), so the spec
 * workers reach it only over HTTP — which is also what makes it survive a worker
 * restart after a failed test.
 */

import http from 'http';
import net from 'net';

export interface ProxyFault {
    match: string;
    kind: 'cut' | 'status';
    afterBytes?: number;
    status?: number;
    count?: number;
}

export interface ProxyLogEntry {
    t: number;
    method: string;
    url: string;
    range: string | null;
    status: number;
    contentRange: string | null;
    bytes: number;
    fault: 'cut' | 'status' | null;
}

export function startFaultProxy(listenPort: number, targetPort: number): Promise<http.Server> {
    let faults: (ProxyFault & { left: number })[] = [];
    let log: ProxyLogEntry[] = [];

    const takeFault = (url: string): (ProxyFault & { left: number }) | null => {
        const f = faults.find((x) => x.left > 0 && url.includes(x.match));
        if (!f) return null;
        f.left--;
        return f;
    };

    const server = http.createServer((req, res) => {
        const url = req.url ?? '/';
        if (url.startsWith('/__e2e_proxy/')) {
            let body = '';
            req.on('data', (c: Buffer) => (body += c.toString()));
            req.on('end', () => {
                res.setHeader('Content-Type', 'application/json');
                if (url.startsWith('/__e2e_proxy/fault')) {
                    const f = JSON.parse(body || '{}') as ProxyFault;
                    faults.push({ ...f, left: f.count ?? 1 });
                    res.end('{"ok":true}');
                } else if (url.startsWith('/__e2e_proxy/reset')) {
                    faults = [];
                    log = [];
                    res.end('{"ok":true}');
                } else if (url.startsWith('/__e2e_proxy/log')) {
                    const match = new URL(url, 'http://x').searchParams.get('match') ?? '';
                    res.end(JSON.stringify(log.filter((e) => e.url.includes(match))));
                } else {
                    res.statusCode = 404;
                    res.end('{}');
                }
            });
            return;
        }

        const fault = takeFault(url);
        const entry: ProxyLogEntry = {
            t: Date.now(),
            method: req.method ?? 'GET',
            url,
            range: (req.headers.range as string | undefined) ?? null,
            status: 0,
            contentRange: null,
            bytes: 0,
            fault: fault?.kind ?? null,
        };
        if (url.includes('/stream')) log.push(entry);
        if (log.length > 500) log.shift();

        if (fault?.kind === 'status') {
            entry.status = fault.status ?? 404;
            res.writeHead(entry.status, { 'Content-Type': 'application/json' });
            res.end('{"error":"injected by e2e proxy"}');
            req.resume();
            return;
        }

        const upstream = http.request(
            {
                host: '127.0.0.1',
                port: targetPort,
                method: req.method,
                path: url,
                headers: req.headers,
            },
            (up) => {
                entry.status = up.statusCode ?? 0;
                entry.contentRange = (up.headers['content-range'] as string | undefined) ?? null;
                res.writeHead(up.statusCode ?? 502, up.statusMessage, up.headers);
                if (fault?.kind === 'cut') {
                    const limit = fault.afterBytes ?? 0;
                    up.on('data', (chunk: Buffer) => {
                        if (entry.bytes >= limit) return;
                        const room = limit - entry.bytes;
                        const part = chunk.length > room ? chunk.subarray(0, room) : chunk;
                        entry.bytes += part.length;
                        res.write(part);
                        if (entry.bytes >= limit) {
                            // An abrupt drop, not a clean end: the client sees a
                            // truncated body on a broken connection.
                            up.destroy();
                            res.socket?.destroy();
                        }
                    });
                    up.on('end', () => res.end());
                    return;
                }
                up.on('data', (chunk: Buffer) => (entry.bytes += chunk.length));
                up.pipe(res);
            },
        );
        upstream.on('error', () => {
            if (!res.headersSent) res.writeHead(502);
            res.end();
        });
        req.pipe(upstream);
        res.on('close', () => upstream.destroy());
    });

    // WebSocket/upgrade passthrough (Vite HMR in dev mode; harmless otherwise).
    server.on('upgrade', (req, socket, head) => {
        const up = net.connect(targetPort, '127.0.0.1', () => {
            up.write(
                `${req.method} ${req.url} HTTP/1.1\r\n` +
                    Object.entries(req.headers)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join('\r\n') +
                    '\r\n\r\n',
            );
            up.write(head);
            socket.pipe(up).pipe(socket);
        });
        up.on('error', () => socket.destroy());
        socket.on('error', () => up.destroy());
    });

    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(listenPort, '127.0.0.1', () => resolve(server));
    });
}
