// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildProviderDetailResult } from './detail-coerce.js';

vi.mock('$lib/server/config', () => ({
    config: {
        TMDB_API_KEY: '0123456789abcdef0123456789abcdef',
        TMDB_LANGUAGE: 'de-DE',
    },
}));
const { createTMDBApi } = await import('./client.js');
const requests: URL[] = [];
beforeEach(() => {
    requests.length = 0;
    vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
            const url = new URL(input);
            requests.push(url);
            const languages = url.searchParams.get('include_image_language')?.split(',') ?? [];
            return new Response(
                JSON.stringify({
                    id: 42,
                    title: 'Fixture',
                    name: 'Fixture',
                    images: {
                        logos: languages.includes('en')
                            ? [{ file_path: '/english-logo.png', iso_639_1: 'en' }]
                            : [],
                        backdrops: languages.includes('null')
                            ? [{ file_path: '/neutral-backdrop.jpg', iso_639_1: null }]
                            : [],
                    },
                }),
                { headers: { 'Content-Type': 'application/json' } },
            );
        }),
    );
});
afterEach(() => {
    vi.unstubAllGlobals();
});

describe('localized metadata preserves available artwork', () => {
    it.each(['movie', 'tv'] as const)(
        'keeps an English logo for German %s metadata',
        async (type) => {
            const api = createTMDBApi('de-DE');
            const details =
                type === 'tv' ? await api.getTVShowDetails(42) : await api.getMovieDetails(42);
            expect(requests[0].searchParams.get('language')).toBe('de-DE');
            expect(requests[0].searchParams.get('include_image_language')).toBe('de,en,null');
            expect(buildProviderDetailResult({ ...details }, type).artwork?.logoUrl).toContain(
                '/english-logo.png',
            );
            expect(details.images?.backdrops).toHaveLength(1);
        },
    );
    it.each(['movie', 'tv'] as const)('covers the arbitrary-appends %s path too', async (type) => {
        const api = createTMDBApi('fr-FR');
        if (type === 'tv') await api.getTVDetailsWithAppends(42, ['credits', 'images']);
        else await api.getMovieDetailsWithAppends(42, ['images']);
        expect(requests[0].searchParams.get('include_image_language')).toBe('fr,en,null');
    });
    it('deduplicates English and leaves non-image requests alone', async () => {
        const api = createTMDBApi('en-US');
        await api.getMovieDetails(42);
        await api.searchMulti('Fixture');
        expect(requests[0].searchParams.get('include_image_language')).toBe('en,null');
        expect(requests[1].searchParams.has('include_image_language')).toBe(false);
    });
});
