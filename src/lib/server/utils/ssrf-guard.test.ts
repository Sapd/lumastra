// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for SSRF Guard
 *
 * Tests private-IP blocking, DNS-rebinding protection, and allowlist positive controls.
 */

import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import https from 'node:https';
import tls from 'node:tls';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { ProxyAgent } from 'undici';
import {
    assertNotPrivateUrl,
    resolveSafePublicUrl,
    pinnedFetch,
    _resetSsrfDnsCacheForTests,
} from './ssrf-guard';

describe('SSRF Guard', () => {
    beforeEach(() => {
        _resetSsrfDnsCacheForTests();
    });

    describe('assertNotPrivateUrl — literal private IPv4', () => {
        it('blocks 10.0.0.0/8', async () => {
            await expect(assertNotPrivateUrl(new URL('http://10.0.0.1/api'))).rejects.toThrow(
                'private IP',
            );
        });

        it('blocks 172.16.0.0/12', async () => {
            await expect(assertNotPrivateUrl(new URL('http://172.16.5.5/health'))).rejects.toThrow(
                'private IP',
            );
        });

        it('blocks 192.168.0.0/16', async () => {
            await expect(assertNotPrivateUrl(new URL('http://192.168.1.50/'))).rejects.toThrow(
                'private IP',
            );
        });

        it('blocks 127.0.0.0/8 (loopback)', async () => {
            await expect(assertNotPrivateUrl(new URL('http://127.0.0.1/test'))).rejects.toThrow(
                'private IP',
            );
        });

        it('blocks 169.254.0.0/16 (link-local)', async () => {
            await expect(assertNotPrivateUrl(new URL('http://169.254.1.1/'))).rejects.toThrow(
                'private IP',
            );
        });

        it('blocks 100.64.0.0/10 (CGNAT)', async () => {
            await expect(assertNotPrivateUrl(new URL('http://100.64.0.1/'))).rejects.toThrow(
                'private IP',
            );
        });

        it('blocks 0.0.0.0/8', async () => {
            await expect(assertNotPrivateUrl(new URL('http://0.0.0.0/'))).rejects.toThrow(
                'private IP',
            );
        });
    });

    describe('assertNotPrivateUrl — literal private IPv6', () => {
        it('blocks ::1 (loopback)', async () => {
            await expect(assertNotPrivateUrl(new URL('http://[::1]/api'))).rejects.toThrow(
                'private IP',
            );
        });

        it('blocks fc00::/7 (unique local)', async () => {
            await expect(assertNotPrivateUrl(new URL('http://[fc00::1]/'))).rejects.toThrow(
                'private IP',
            );
        });

        it('blocks fe80::/10 (link-local)', async () => {
            await expect(assertNotPrivateUrl(new URL('http://[fe80::1]/'))).rejects.toThrow(
                'private IP',
            );
        });
    });

    describe('resolveSafePublicUrl — special-purpose ranges', () => {
        // `http://[::]:<port>/` reaches a loopback listener on Linux and macOS,
        // like 0.0.0.0 does, so it must be refused wherever a URL is vetted.
        it.each([
            'http://[::]/',
            'http://[::7f00:1]/',
            'http://[fec0::1]/',
            'http://[ff02::1]/',
            'http://[64:ff9b::a00:1]/', // NAT64 of 10.0.0.1
            'http://[64:ff9b::7f00:1]/', // NAT64 of 127.0.0.1
            'http://[64:ff9b:1::1]/',
            'http://192.0.0.1/',
            'http://198.18.0.1/',
            'http://224.0.0.1/',
            'http://255.255.255.255/',
        ])('refuses %s', async (url) => {
            await expect(resolveSafePublicUrl(new URL(url))).rejects.toThrow('private IP');
        });

        it('accepts a NAT64 address of a public IPv4 host', async () => {
            const safe = await resolveSafePublicUrl(new URL('http://[64:ff9b::101:101]/')); // 1.1.1.1
            expect(safe.resolvedIp).toBe('64:ff9b::101:101');
        });
    });

    describe('assertNotPrivateUrl — DNS resolution (rebinding protection)', () => {
        it('blocks localhost (resolves to 127.0.0.1)', async () => {
            await expect(assertNotPrivateUrl(new URL('http://localhost/'))).rejects.toThrow(
                'private IP',
            );
        });
    });

    describe('assertNotPrivateUrl — allowlist positive controls', () => {
        it('allows public IPv4', async () => {
            // 1.1.1.1 is Cloudflare DNS — public
            await expect(assertNotPrivateUrl(new URL('http://1.1.1.1/'))).resolves.toBeUndefined();
        });

        it('allows public IPv6', async () => {
            // 2001:db8::1 is documentation range, but treated as non-private
            // Use a real public IPv6 address
            await expect(
                assertNotPrivateUrl(new URL('http://[2001:4860:4860::8888]/')),
            ).resolves.toBeUndefined();
        });
    });

    describe('resolveSafePublicUrl', () => {
        it('resolves public IP and returns SafeUrl', async () => {
            const safe = await resolveSafePublicUrl(new URL('http://1.1.1.1/'));
            expect(safe.url.toString()).toBe('http://1.1.1.1/');
            expect(safe.resolvedIp).toBe('1.1.1.1');
        });

        it('throws for private IP', async () => {
            await expect(resolveSafePublicUrl(new URL('http://192.168.1.1/'))).rejects.toThrow(
                'private IP',
            );
        });

        // The opt-in exists for operators pointing Live TV at a LAN provider
        // (LIVETV_ALLOW_PRIVATE_URLS). It must stay strictly opt-in, and it must
        // still hand back an IP so pinnedFetch keeps pinning the connection
        // — lifting the private-range rejection is the ONLY thing it changes.
        it('still rejects a private IP when allowPrivate is false', async () => {
            await expect(
                resolveSafePublicUrl(new URL('http://192.168.1.1/'), { allowPrivate: false }),
            ).rejects.toThrow('private IP');
        });

        it('accepts a private IP when allowPrivate is true, and still pins it', async () => {
            const safe = await resolveSafePublicUrl(new URL('http://192.168.1.1/'), {
                allowPrivate: true,
            });
            expect(safe.resolvedIp).toBe('192.168.1.1');
        });

        it('leaves the default strict when no options are passed', async () => {
            await expect(resolveSafePublicUrl(new URL('http://10.0.0.5/'))).rejects.toThrow(
                'private IP',
            );
        });
    });

    // Real undici, real sockets: the URL names a host that does not resolve,
    // and the pin is the only way the request can reach the loopback server.
    // What the server sees is what a name-based virtual host would see.
    describe('pinnedFetch', () => {
        let server: http.Server | undefined;
        let proxy: http.Server | undefined;
        afterEach(() => {
            server?.close();
            proxy?.close();
            server = proxy = undefined;
        });

        function listen(srv: http.Server): Promise<number> {
            return new Promise((resolve) => {
                srv.listen(0, '127.0.0.1', () => resolve((srv.address() as AddressInfo).port));
            });
        }

        it('dials the vetted IP and keeps the hostname for Host (vhost routing)', async () => {
            const seen: Array<string | undefined> = [];
            server = http.createServer((req, res) => {
                seen.push(req.headers.host);
                res.end(req.headers.host === `radio.invalid:${port}` ? 'right-vhost' : 'default');
            });
            const port = await listen(server);

            const res = await pinnedFetch({
                url: new URL(`http://radio.invalid:${port}/stream`),
                resolvedIp: '127.0.0.1',
            });

            expect(await res.text()).toBe('right-vhost');
            expect(seen).toEqual([`radio.invalid:${port}`]);
        });

        it('passes the caller init through and leaves redirects to the caller', async () => {
            let icy: string | string[] | undefined;
            server = http.createServer((req, res) => {
                icy = req.headers['icy-metadata'];
                res.writeHead(302, { location: 'http://10.0.0.1/' });
                res.end();
            });
            const port = await listen(server);

            const res = await pinnedFetch(
                { url: new URL(`http://radio.invalid:${port}/`), resolvedIp: '127.0.0.1' },
                { headers: { 'Icy-MetaData': '1' }, redirect: 'manual' },
            );

            expect(res.status).toBe(302);
            expect(res.headers.get('location')).toBe('http://10.0.0.1/');
            expect(icy).toBe('1');
        });

        it('streams a body that outlives the response headers', async () => {
            server = http.createServer((_req, res) => {
                res.write('a');
                setTimeout(() => res.end('b'), 50);
            });
            const port = await listen(server);

            const res = await pinnedFetch({
                url: new URL(`http://radio.invalid:${port}/`),
                resolvedIp: '127.0.0.1',
            });

            expect(await res.text()).toBe('ab');
        });

        it('hands a caller dispatcher (upstream proxy) the real hostname', async () => {
            const proxied: string[] = [];
            proxy = http.createServer((req, res) => {
                proxied.push(`${req.url} host=${req.headers.host}`);
                res.end('via-proxy');
            });
            const proxyPort = await listen(proxy);
            const dispatcher = new ProxyAgent(`http://127.0.0.1:${proxyPort}`);

            const res = await pinnedFetch(
                { url: new URL('http://logos.invalid/a.png'), resolvedIp: '93.184.216.34' },
                { dispatcher },
            );

            expect(await res.text()).toBe('via-proxy');
            expect(proxied).toEqual(['http://logos.invalid/a.png host=logos.invalid']);
            await dispatcher.close();
        });

        it('sends URL credentials as Basic auth and strips them from the request', async () => {
            const seen: Array<{ url?: string; auth?: string }> = [];
            server = http.createServer((req, res) => {
                seen.push({ url: req.url, auth: req.headers.authorization });
                res.end('ok');
            });
            const port = await listen(server);

            const res = await pinnedFetch({
                url: new URL(`http://us%40er:p%3Ass@radio.invalid:${port}/list.m3u`),
                resolvedIp: '127.0.0.1',
            });

            expect(await res.text()).toBe('ok');
            const expected = Buffer.from('us@er:p:ss', 'utf8').toString('base64');
            expect(seen).toEqual([{ url: '/list.m3u', auth: `Basic ${expected}` }]);
        });

        it('keeps a caller-set Authorization header over URL credentials', async () => {
            let auth: string | undefined;
            server = http.createServer((req, res) => {
                auth = req.headers.authorization;
                res.end('ok');
            });
            const port = await listen(server);

            const res = await pinnedFetch(
                { url: new URL(`http://u:p@radio.invalid:${port}/`), resolvedIp: '127.0.0.1' },
                { headers: { Authorization: 'Bearer caller' } },
            );

            await res.text();
            expect(auth).toBe('Bearer caller');
        });

        it('rejects when the pinned address refuses the connection', async () => {
            server = http.createServer();
            const port = await listen(server);
            server.close();
            server = undefined;

            await expect(
                pinnedFetch({
                    url: new URL(`http://radio.invalid:${port}/`),
                    resolvedIp: '127.0.0.1',
                }),
            ).rejects.toThrow();
        });
    });

    // Real TLS: a throwaway self-signed cert (generated per run, so no key is
    // committed) for `radio.invalid`, trusted through the default CA store. The
    // pin dials 127.0.0.1, yet the handshake must still carry the hostname as
    // SNI and verify the certificate against it.
    const canTls = (() => {
        try {
            execFileSync('openssl', ['version'], { stdio: 'ignore' });
            return typeof tls.setDefaultCACertificates === 'function';
        } catch {
            return false;
        }
    })();

    describe.skipIf(!canTls)('pinnedFetch over TLS', () => {
        let dir: string;
        let server: https.Server | undefined;
        const originalCas = canTls ? tls.getCACertificates('default') : [];

        function makeCert(name: string): { key: string; cert: string } {
            const key = join(dir, `${name}.key`);
            const cert = join(dir, `${name}.crt`);
            execFileSync(
                'openssl',
                [
                    'req',
                    '-x509',
                    '-newkey',
                    'ec',
                    '-pkeyopt',
                    'ec_paramgen_curve:prime256v1',
                    '-nodes',
                    '-keyout',
                    key,
                    '-out',
                    cert,
                    '-days',
                    '1',
                    '-subj',
                    `/CN=${name}`,
                    '-addext',
                    `subjectAltName=DNS:${name}`,
                ],
                { stdio: 'ignore' },
            );
            return { key: readFileSync(key, 'utf8'), cert: readFileSync(cert, 'utf8') };
        }

        async function serve(creds: { key: string; cert: string }) {
            const seen: Array<{ sni: string | false; alpn: string | false | null; host?: string }> =
                [];
            server = https.createServer(
                { ...creds, ALPNProtocols: ['h2', 'http/1.1'] },
                (req, res) => {
                    const sock = req.socket as tls.TLSSocket;
                    seen.push({
                        sni: (sock as tls.TLSSocket & { servername: string | false }).servername,
                        alpn: sock.alpnProtocol,
                        host: req.headers.host,
                    });
                    res.end('tls-ok');
                },
            );
            const port = await new Promise<number>((resolve) => {
                server!.listen(0, '127.0.0.1', () =>
                    resolve((server!.address() as AddressInfo).port),
                );
            });
            return { port, seen };
        }

        beforeAll(() => {
            dir = mkdtempSync(join(tmpdir(), 'pinned-tls-'));
        });
        afterEach(() => {
            server?.close();
            server = undefined;
            tls.setDefaultCACertificates(originalCas);
        });
        afterAll(() => {
            rmSync(dir, { recursive: true, force: true });
        });

        it('sends the hostname as SNI and verifies the certificate against it', async () => {
            const creds = makeCert('radio.invalid');
            tls.setDefaultCACertificates([...originalCas, creds.cert]);
            const { port, seen } = await serve(creds);

            const res = await pinnedFetch({
                url: new URL(`https://radio.invalid:${port}/`),
                resolvedIp: '127.0.0.1',
            });

            expect(await res.text()).toBe('tls-ok');
            expect(seen).toHaveLength(1);
            expect(seen[0].sni).toBe('radio.invalid');
            expect(seen[0].host).toBe(`radio.invalid:${port}`);
            // h1 only, like the global dispatcher: h2 is never negotiated.
            expect(seen[0].alpn).not.toBe('h2');
        });

        it('refuses a trusted certificate issued for a different hostname', async () => {
            const creds = makeCert('other.invalid');
            tls.setDefaultCACertificates([...originalCas, creds.cert]);
            const { port, seen } = await serve(creds);

            const err = await pinnedFetch({
                url: new URL(`https://radio.invalid:${port}/`),
                resolvedIp: '127.0.0.1',
            }).then(
                () => null,
                (e: unknown) => e as Error & { cause?: { code?: string } },
            );

            expect(err?.cause?.code).toBe('ERR_TLS_CERT_ALTNAME_INVALID');
            expect(seen).toHaveLength(0);
        });
    });
});
