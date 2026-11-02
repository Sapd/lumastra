// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { checkProxyBypasses } from './proxy-bypass';

async function healthVerdict(response: Response | Error): Promise<boolean | null> {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        if (String(input).endsWith('/api/health')) {
            if (response instanceof Error) throw response;
            return response;
        }
        return Response.json({});
    });
    const results = await checkProxyBypasses((path) => `/lumastra${path}`, fetcher);
    expect(fetcher).toHaveBeenCalledWith('/lumastra/api/health', {
        redirect: 'manual',
        credentials: 'omit',
        cache: 'no-store',
    });
    expect(fetcher.mock.calls.map(([path]) => path)).toContain('/lumastra/api/v1/server');
    return results.find((result) => result.surface === '/api/health')!.gated;
}

describe('proxy bypass probes', () => {
    it('recognizes the real liveness response as not gated', async () => {
        expect(
            await healthVerdict(
                new Response('{"status":"pass"}', {
                    headers: { 'content-type': 'application/health+json' },
                }),
            ),
        ).toBe(false);
    });

    it.each([302, 401, 403])('recognizes a proxy auth response (%i)', async (status) => {
        expect(await healthVerdict(new Response(null, { status }))).toBe(true);
    });

    it('recognizes a manual browser redirect', async () => {
        const response = new Response(null, { status: 200 });
        Object.defineProperty(response, 'type', { value: 'opaqueredirect' });
        expect(await healthVerdict(response)).toBe(true);
    });

    it('recognizes an HTML login page even with status 200', async () => {
        expect(
            await healthVerdict(
                new Response('<html>Sign in</html>', {
                    headers: { 'content-type': 'text/html' },
                }),
            ),
        ).toBe(true);
    });

    it.each([404, 502])('does not treat status %i as proof of a bypass', async (status) => {
        expect(await healthVerdict(new Response(null, { status }))).toBeNull();
    });

    it('leaves malformed health responses and network failures unknown', async () => {
        expect(await healthVerdict(Response.json({ status: 'pass' }))).toBeNull();
        expect(await healthVerdict(new Error('offline'))).toBeNull();
    });

    it('accepts self-authenticating surfaces returning 401, but not the public v1 probe', async () => {
        const results = await checkProxyBypasses(
            (path) => path,
            vi.fn(async () => new Response(null, { status: 401 })),
        );
        expect(results).toEqual([
            { surface: '/api/health', gated: true },
            { surface: '/api/v1', gated: true },
            { surface: '/j', gated: false },
            { surface: '/subsonic', gated: false },
        ]);
    });
});
