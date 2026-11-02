// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// fetch-and-verify.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'node:http';

// The plain "rejects a private IP" test and the redirect re-gate test would be
// IDENTICAL if both started from a 127.0.0.1 URL — the initial hop is already
// private and rejected at hop 0, so the per-hop redirect re-gate ([review C4],
// the headline fix) would never execute. So the real ssrf-guard runs with DNS
// mocked: the sentinel host `public.test` resolves to a PUBLIC address, and its
// pinned request goes to a mocked undici transport that answers with a 302 to
// a private literal. That forces the rejection onto hop 1. [review C4]
const h = vi.hoisted(() => ({
    assertNotPrivateUrl: vi.fn(),
    undiciFetch: vi.fn(),
    agentOpts: [] as Array<{
        connect: {
            lookup: (
                host: string,
                opts: unknown,
                cb: (err: null, addrs: Array<{ address: string; family: number }>) => void,
            ) => void;
        };
    }>,
}));
vi.mock('node:dns/promises', () => ({
    default: {
        lookup: async (host: string) => {
            if (host === 'public.test') return [{ address: '93.184.216.34', family: 4 }];
            throw new Error(`unexpected DNS lookup: ${host}`);
        },
    },
}));
vi.mock('$lib/server/utils/ssrf-guard.js', async (importOriginal) => {
    const real = await importOriginal<typeof import('$lib/server/utils/ssrf-guard.js')>();
    h.assertNotPrivateUrl.mockImplementation(real.assertNotPrivateUrl);
    return { ...real, assertNotPrivateUrl: h.assertNotPrivateUrl };
});
// The allowPrivate branch uses the global fetch against real loopback servers;
// only the pinned (public) branch goes through undici.
vi.mock('undici', () => ({
    Agent: class {
        constructor(opts: (typeof h.agentOpts)[number]) {
            h.agentOpts.push(opts);
        }
        close(): Promise<void> {
            return Promise.resolve();
        }
        destroy(): Promise<void> {
            return Promise.resolve();
        }
    },
    fetch: (...args: unknown[]) => h.undiciFetch(...args),
}));
import { fetchWithGuards } from './fetch-and-verify.js';

let server: http.Server | undefined;
function listen(handler: http.RequestListener): Promise<string> {
    return new Promise((resolve) => {
        server = http.createServer(handler);
        server.listen(0, '127.0.0.1', () => {
            const addr = server!.address();
            if (addr && typeof addr === 'object') resolve(`http://127.0.0.1:${addr.port}`);
        });
    });
}
afterEach(() => {
    server?.close();
    server = undefined;
    h.assertNotPrivateUrl.mockClear();
    h.undiciFetch.mockReset();
    h.agentOpts.length = 0;
});

describe('fetchWithGuards', () => {
    it('rejects non-http(s) protocols before any fetch', async () => {
        await expect(
            fetchWithGuards('file:///etc/passwd', {
                maxBytes: 1024,
                allowPrivate: true,
                timeoutMs: 1000,
            }),
        ).rejects.toThrow();
    });
    it('fetches a small body when allowPrivate=true', async () => {
        const base = await listen((_req, res) => {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end('{"ok":true}');
        });
        const { bytes, contentType } = await fetchWithGuards(`${base}/m`, {
            maxBytes: 1024,
            allowPrivate: true,
            timeoutMs: 2000,
        });
        expect(bytes.toString('utf8')).toBe('{"ok":true}');
        expect(contentType).toContain('application/json');
    });
    it('aborts when the body exceeds maxBytes', async () => {
        const base = await listen((_req, res) => {
            res.writeHead(200);
            res.end(Buffer.alloc(4096, 0x41));
        });
        await expect(
            fetchWithGuards(`${base}/big`, { maxBytes: 1024, allowPrivate: true, timeoutMs: 2000 }),
        ).rejects.toThrow();
    });
    it('aborts when the server never responds (timeout)', async () => {
        const base = await listen(() => {
            /* never write, never end → hang */
        });
        await expect(
            fetchWithGuards(`${base}/hang`, { maxBytes: 1024, allowPrivate: true, timeoutMs: 150 }),
        ).rejects.toThrow();
    });
    it('rejects a private IP when allowPrivate=false', async () => {
        const base = await listen((_req, res) => {
            res.writeHead(200);
            res.end('x');
        });
        await expect(
            fetchWithGuards(`${base}/m`, { maxBytes: 1024, allowPrivate: false, timeoutMs: 2000 }),
        ).rejects.toThrow();
    });
    it('re-gates each redirect hop: 302 from a PUBLIC host to a private IP is rejected on hop 1 [review C4]', async () => {
        h.undiciFetch.mockResolvedValueOnce(
            new Response(null, {
                status: 302,
                headers: { location: 'http://127.0.0.1:5432/secret' },
            }),
        );
        await expect(
            fetchWithGuards('http://public.test/r', {
                maxBytes: 1024,
                allowPrivate: false,
                timeoutMs: 2000,
            }),
        ).rejects.toThrow(/private IP/);
        // Proof the gate ran per hop, not just at hop 0: public.test (hop 0) + the private target (hop 1)
        expect(h.assertNotPrivateUrl).toHaveBeenCalledTimes(2);
        expect(h.assertNotPrivateUrl.mock.calls[1][0].hostname).toBe('127.0.0.1');
        // Only hop 0 was fetched, pinned to the vetted IP with the hostname kept.
        expect(h.undiciFetch).toHaveBeenCalledTimes(1);
        expect(String(h.undiciFetch.mock.calls[0][0])).toBe('http://public.test/r');
        // The pinned lookup answers on a later tick, so wait for its callback.
        const dialed = await new Promise<string>((resolve) => {
            h.agentOpts[0].connect.lookup('public.test', { all: true }, (_e, addrs) => {
                resolve(addrs[0].address);
            });
        });
        expect(dialed).toBe('93.184.216.34');
    });

    it('fetches a public URL through the pinned transport', async () => {
        h.undiciFetch.mockResolvedValueOnce(
            new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } }),
        );
        const { bytes } = await fetchWithGuards('https://public.test/manifest.json', {
            maxBytes: 1024,
            allowPrivate: false,
            timeoutMs: 2000,
        });
        expect(bytes.toString('utf8')).toBe('{"ok":true}');
        const init = h.undiciFetch.mock.calls[0][1] as RequestInit;
        expect(init.redirect).toBe('manual');
        expect(new Headers(init.headers).has('host')).toBe(false);
    });
});
