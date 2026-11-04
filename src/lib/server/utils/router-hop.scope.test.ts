// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The router-hop verdict lives in an AsyncLocalStorage scope. These tests pin the properties that
 * rely on that: concurrent requests never see each other's verdict, the scope survives the
 * handle chain of SvelteKit's real sequence() with a Request swap in the middle, and only
 * routerHopHandle opens a scope.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { sequence } from '@sveltejs/kit/hooks';
import type { Handle, RequestEvent } from '@sveltejs/kit';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getClientIpStrict } from './client-ip';
import { deriveRouterHopSecret, isRouterHopAuthenticated, runWithRouterHop } from './router-hop';

// SvelteKit's internal request store (no published types): sequence() reads it per request.
const INTERNAL_SERVER = '@sveltejs/kit/internal/server';
type WithRequestStore = <T>(store: { event: RequestEvent; state: never }, fn: () => T) => T;

const KEY = '7'.repeat(64);
const SECRET = deriveRouterHopSecret(KEY);

const saved = process.env.LUMASTRA_MASTER_KEY;
beforeEach(() => {
    process.env.LUMASTRA_MASTER_KEY = KEY;
});
afterEach(() => {
    if (saved === undefined) delete process.env.LUMASTRA_MASTER_KEY;
    else process.env.LUMASTRA_MASTER_KEY = saved;
});

function req(xff: string, hop?: string): Request {
    const headers = new Headers({ 'x-forwarded-for': xff });
    if (hop !== undefined) headers.set('x-lumastra-router-hop', hop);
    return new Request('https://app.example/x', { headers });
}

function eventFor(request: Request, peer: string): RequestEvent {
    return {
        request,
        getClientAddress: () => peer,
        // sequence() wraps every handle in a tracing span (state.tracing below).
        tracing: { enabled: false, root: {}, current: {} },
        route: { id: null },
        url: new URL(request.url),
    } as unknown as RequestEvent;
}

const tick = () => new Promise<void>((r) => setImmediate(r));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe('concurrent requests keep their own verdict', () => {
    it('two interleaved requests with opposite verdicts never cross, across awaits and timers', async () => {
        const seen: Record<string, string[]> = { a: [], b: [] };

        async function serve(name: 'a' | 'b', request: Request, peer: string, delay: number) {
            await runWithRouterHop(request, async () => {
                const event = eventFor(request, peer);
                for (let i = 0; i < 6; i++) {
                    // Resolve through the real strict resolver at each step, with different suspension kinds.
                    seen[name].push(getClientIpStrict(event));
                    if (i % 3 === 0) await Promise.resolve();
                    else if (i % 3 === 1) await sleep(delay);
                    else await tick();
                }
            });
        }

        await Promise.all([
            // a: carries the secret, so X-Forwarded-For is believed.
            serve('a', req('203.0.113.1', SECRET), '10.42.0.11', 1),
            // b: no secret (a pod bypassing the router): the peer is the address.
            serve('b', req('6.6.6.6'), '10.42.0.99', 2),
        ]);

        expect(new Set(seen.a)).toEqual(new Set(['203.0.113.1']));
        expect(new Set(seen.b)).toEqual(new Set(['10.42.0.99']));
    });

    it('many interleaved requests, alternating verdicts', async () => {
        const results = await Promise.all(
            Array.from({ length: 40 }, async (_, i) => {
                const authed = i % 2 === 0;
                const request = req(`198.51.100.${i}`, authed ? SECRET : 'forged');
                return runWithRouterHop(request, async () => {
                    await sleep(i % 5);
                    await tick();
                    return [authed, isRouterHopAuthenticated(request)] as const;
                });
            }),
        );
        for (const [expected, actual] of results) expect(actual).toBe(expected);
    });

    it('a nested scope (event.fetch re-entering the chain) does not leak out when it ends', async () => {
        const outer = req('203.0.113.1', SECRET);
        await runWithRouterHop(outer, async () => {
            expect(isRouterHopAuthenticated(outer)).toBe(true);
            await runWithRouterHop(req('6.6.6.6'), async () => {
                expect(isRouterHopAuthenticated(undefined)).toBe(false);
            });
            expect(isRouterHopAuthenticated(outer)).toBe(true);
        });
    });
});

describe('through the real SvelteKit sequence()', () => {
    it('the verdict survives a handle that replaces event.request (Paraglide) and a later reader', async () => {
        const original = req('203.0.113.1', SECRET);
        const event = eventFor(original, '10.42.0.52');

        const routerHop: Handle = ({ event, resolve }) =>
            runWithRouterHop(event.request, () => resolve(event));
        const swapRequest: Handle = ({ event, resolve }) => {
            event.request = new Request(event.request.url, {
                method: event.request.method,
                headers: new Headers(event.request.headers),
            });
            return resolve(event);
        };
        let resolved = '';
        const reader: Handle = async ({ event }) => {
            await sleep(1);
            resolved = getClientIpStrict(event);
            return new Response(event.request.headers.get('x-lumastra-router-hop') ?? 'stripped');
        };

        // sequence() reads SvelteKit's request store, which the server runtime sets per request.
        const { with_request_store } = (await import(/* @vite-ignore */ INTERNAL_SERVER)) as {
            with_request_store: WithRequestStore;
        };
        const res = await with_request_store(
            {
                event,
                state: {
                    tracing: { record_span: ({ fn }: { fn: (s: unknown) => unknown }) => fn({}) },
                } as never,
            },
            () =>
                sequence(
                    routerHop,
                    swapRequest,
                    reader,
                )({
                    event,
                    resolve: async () => new Response('unused'),
                }),
        );
        expect(resolved).toBe('203.0.113.1');
        expect(await res.text()).toBe('stripped');
    });
});

describe('guards', () => {
    it('only routerHopHandle in hooks.server.ts opens a hop scope', () => {
        const root = new URL('../../../', import.meta.url).pathname;
        const hits: string[] = [];
        const walk = (dir: string) => {
            for (const name of readdirSync(dir)) {
                const path = join(dir, name);
                if (statSync(path).isDirectory()) walk(path);
                else if (/\.(ts|js|svelte)$/.test(name) && !/\.test\.ts$/.test(name)) {
                    if (/\brunWithRouterHop\s*\(/.test(readFileSync(path, 'utf8'))) {
                        hits.push(relative(root, path));
                    }
                }
            }
        };
        walk(root);
        expect(hits.sort()).toEqual(['hooks.server.ts']);
    });
});
