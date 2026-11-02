// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { isRedirect, type RequestEvent } from '@sveltejs/kit';

const requestEnv = vi.hoisted(() => ({ PUBLIC_REQUESTURL: 'https://requests.example.test' }));
const resolveToTmdb = vi.hoisted(() => vi.fn());

vi.mock('$env/dynamic/public', () => ({ env: requestEnv }));
vi.mock('$lib/server/services/provider-resolution.service.js', () => ({
    providerResolutionService: { resolveToTmdb },
}));

const { GET } = await import('../../../../../routes/api/request/redirect/+server.js');

function event(query: string): RequestEvent {
    const url = new URL(`https://app.example.test/api/request/redirect${query}`);
    return {
        url,
        request: new Request(url),
        params: {},
        locals: {},
        route: { id: '/api/request/redirect' },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    requestEnv.PUBLIC_REQUESTURL = 'https://requests.example.test';
    resolveToTmdb.mockResolvedValue({ success: true, tmdbId: 60625 });
});

describe('GET /api/request/redirect (mounted)', () => {
    it.each([
        ['?id=tmdb%3A60625%3Atv', { tmdb: '60625' }, 'tv'],
        ['?id=tmdb%3A60625&mediaType=series', { tmdb: '60625' }, 'tv'],
        ['?id=imdb%3Att0137523%3Amovie', { imdb: 'tt0137523' }, 'movie'],
    ])('redirects validated provider input %s', async (query, externalIds, mediaType) => {
        const thrown = await Promise.resolve(GET!(event(query as string))).catch(
            (err: unknown) => err,
        );
        expect(isRedirect(thrown)).toBe(true);
        expect(thrown).toMatchObject({
            status: 302,
            location: `https://requests.example.test/${mediaType}/60625`,
        });
        expect(resolveToTmdb).toHaveBeenCalledExactlyOnceWith(externalIds, mediaType);
    });

    it('rejects missing media type before resolving a provider', async () => {
        const response = await GET!(event('?id=tmdb%3A60625'));
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: 'validation_failed' });
        expect(resolveToTmdb).not.toHaveBeenCalled();
    });

    it('returns a dependency problem when the request service is not configured', async () => {
        requestEnv.PUBLIC_REQUESTURL = '';
        const response = await GET!(event('?id=tmdb%3A60625%3Atv'));
        expect(response.status).toBe(503);
        expect(await response.json()).toMatchObject({ code: 'dependency_unavailable' });
        expect(resolveToTmdb).not.toHaveBeenCalled();
    });

    it('returns a validation problem when provider resolution fails', async () => {
        resolveToTmdb.mockResolvedValue({ success: false, error: 'Unknown title' });
        const response = await GET!(event('?id=tmdb%3A60625%3Atv'));
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({ code: 'validation_failed' });
    });
});
