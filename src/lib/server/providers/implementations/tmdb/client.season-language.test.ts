// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MockInstance } from 'vitest';
import { createTMDBApi, type TMDBApiService } from './client';

type MakeRequestFn = (
    endpoint: string,
    params?: Record<string, string | number>,
    options?: { signal?: AbortSignal },
) => Promise<unknown>;

type MockableTMDBApi = TMDBApiService & { makeRequest: MakeRequestFn };

/**
 * Spy on the private `makeRequest` HTTP primitive so the real
 * `getSeasonEpisodesInLanguage` logic runs against a stubbed transport.
 *
 * `vi.spyOn` types the result as `never` for a private+generic method (the
 * class's `makeRequest` is `private async makeRequest<T>()`), so the concrete
 * `MockInstance` type is restored explicitly. The runtime spy is unchanged.
 */
function spyMakeRequest(api: TMDBApiService): MockInstance<MakeRequestFn> {
    return vi.spyOn(api as MockableTMDBApi, 'makeRequest') as MockInstance<MakeRequestFn>;
}

describe('TMDBApiService.getSeasonEpisodesInLanguage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('returns overview and propagates errors when throwOnError', async () => {
        const api = createTMDBApi('de-DE');

        // Test 1: Returns overview when available
        spyMakeRequest(api).mockResolvedValueOnce({
            episodes: [
                {
                    id: 1,
                    name: 'Folge 1',
                    overview: 'Die Handlung…',
                    episode_number: 1,
                    season_number: 2,
                },
            ],
        });
        const eps = await api.getSeasonEpisodesInLanguage(42, 2, 'de-DE', { throwOnError: true });
        expect(eps[0].overview).toBe('Die Handlung…');

        // Test 2: Propagates errors when throwOnError is true
        spyMakeRequest(api).mockRejectedValueOnce(new Error('tmdb 500'));
        await expect(
            api.getSeasonEpisodesInLanguage(42, 2, 'de-DE', { throwOnError: true }),
        ).rejects.toThrow('tmdb 500');

        // Test 3: Legacy default still swallows errors
        spyMakeRequest(api).mockRejectedValueOnce(new Error('tmdb 500'));
        await expect(api.getSeasonEpisodesInLanguage(42, 2, 'de-DE')).resolves.toEqual([]);
    });

    it('returns null for missing overview', async () => {
        const api = createTMDBApi('de-DE');
        spyMakeRequest(api).mockResolvedValueOnce({
            episodes: [
                {
                    id: 1,
                    name: 'Folge 1',
                    episode_number: 1,
                    season_number: 2,
                },
            ],
        });
        const eps = await api.getSeasonEpisodesInLanguage(42, 2, 'de-DE');
        expect(eps[0].overview).toBe(null);
    });

    it('trims whitespace from overview', async () => {
        const api = createTMDBApi('de-DE');
        spyMakeRequest(api).mockResolvedValueOnce({
            episodes: [
                {
                    id: 1,
                    name: 'Folge 1',
                    overview: '  Die Handlung…  ',
                    episode_number: 1,
                    season_number: 2,
                },
            ],
        });
        const eps = await api.getSeasonEpisodesInLanguage(42, 2, 'de-DE');
        expect(eps[0].overview).toBe('Die Handlung…');
    });
});
