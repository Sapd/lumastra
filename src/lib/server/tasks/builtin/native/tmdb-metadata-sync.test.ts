// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The tmdb-metadata demo task sends its secret in the shape TMDB expects:
 * a v3 API key as ?api_key=, a v4 Read Access Token as a Bearer header.
 */

import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';
import { mockContext, mockLogger } from '@sapd/lumastra-plugin-sdk-testing';

vi.mock('../../registry.js', () => ({ registry: { registerTask: vi.fn() } }));

import { withApiCallSpend } from '../../api-call-spend.js';
import { countExternalCall } from '../../../utils/external-request-counter.js';

import { tmdbMetadataSyncTask } from './tmdb-metadata-sync.js';

const V3_KEY = '0123456789abcdef0123456789abcdef';
const V4_TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJhdWQiOiJ0ZXN0In0.sig';

async function runWith(key: string): Promise<{ url: URL; headers: Record<string, string> }> {
    const fetch = vi.fn(
        async (_url: string, _init?: RequestInit) =>
            new Response(JSON.stringify({ page: 1, results: [{ id: 1, title: 'A' }] }), {
                status: 200,
            }),
    );
    const ctx = {
        ...mockContext({ input: { page: 1 }, logger: mockLogger() }),
        secrets: { get: vi.fn(async () => key) },
        dep: () => ({ fetch }),
        spend: vi.fn(),
        reportProgress: vi.fn(),
    } as unknown as PluginContext;

    const result = await tmdbMetadataSyncTask.execute(ctx as never);

    expect(result.success).toBe(true);
    const [url, init] = fetch.mock.calls[0];
    return { url: new URL(url), headers: (init?.headers ?? {}) as Record<string, string> };
}

describe('tmdb-metadata demo task auth', () => {
    it('sends a v3 key as ?api_key= without a Bearer header', async () => {
        const { url, headers } = await runWith(V3_KEY);
        expect(url.searchParams.get('api_key')).toBe(V3_KEY);
        expect(url.searchParams.get('page')).toBe('1');
        expect(headers.Authorization).toBeUndefined();
        expect(headers.Accept).toBe('application/json');
    });

    it('sends a v4 token as Bearer and keeps it out of the URL', async () => {
        const { url, headers } = await runWith(V4_TOKEN);
        expect(url.searchParams.has('api_key')).toBe(false);
        expect(headers.Authorization).toBe(`Bearer ${V4_TOKEN}`);
    });
});

it('uses measured request spend without a second manual api_calls charge', async () => {
    const spend = vi.fn();
    const ctx = mockContext({ input: { page: 1 } });
    ctx.spend = spend;
    ctx.secrets.get = vi.fn(async () => V3_KEY);
    ctx.dep = () => ({
        fetch: async () => {
            countExternalCall('https://api.themoviedb.org/3/movie/popular', 200);
            return new Response(JSON.stringify({ page: 1, results: [] }));
        },
    });
    await withApiCallSpend(ctx, () => tmdbMetadataSyncTask.execute(ctx as never));
    expect(spend.mock.calls.filter(([kind]) => kind === 'api_calls')).toEqual([['api_calls', 1]]);
});
