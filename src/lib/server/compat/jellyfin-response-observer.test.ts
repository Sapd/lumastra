// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    __resetJellyfinResponseObserverForTests,
    jellyfinResponseObserverHandle,
    registerJellyfinResponseObserver,
} from './jellyfin-response-observer';

const ev = (path: string) => ({ url: new URL(`http://x${path}`) }) as never;

afterEach(() => __resetJellyfinResponseObserverForTests());

describe('jellyfinResponseObserverHandle', () => {
    it('returns the response untouched when no observer is registered', async () => {
        const res = new Response('x');
        const out = await jellyfinResponseObserverHandle({
            event: ev('/j/Items'),
            resolve: async () => res,
        });
        expect(out).toBe(res);
    });
    it('calls the observer only for /j paths', async () => {
        const obs = vi.fn();
        registerJellyfinResponseObserver(obs);
        const res = new Response('x');
        for (const p of ['/j', '/j/Items', '/api/v1/x', '/jx', '/']) {
            const out = await jellyfinResponseObserverHandle({
                event: ev(p),
                resolve: async () => res,
            });
            expect(out).toBe(res);
        }
        expect(obs).toHaveBeenCalledTimes(2);
        expect(obs.mock.calls[0]?.[1]).toBe(res);
    });
    it('still returns the response when the observer throws', async () => {
        registerJellyfinResponseObserver(() => {
            throw new Error('boom');
        });
        const res = new Response('x');
        const out = await jellyfinResponseObserverHandle({
            event: ev('/j/Items'),
            resolve: async () => res,
        });
        expect(out).toBe(res);
    });
});
