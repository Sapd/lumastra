// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { afterEach, expect, it, vi } from 'vitest';
import { tmdbApi, TMDBApiService } from './client.js';
import { TmdbEpisodeGroupProvider } from './episode-group-adapter.js';

afterEach(() => {
    vi.restoreAllMocks();
});

it('treats original-air-date groups as alternatives to standard seasons', () => {
    expect(TMDBApiService.mapEpisodeGroupType(1)).toBe('other');
});

it('never maps an alternative TMDB group to standard', () => {
    for (const type of [1, 2, 3, 4, 5, 6, 7] as const) {
        expect(TMDBApiService.mapEpisodeGroupType(type)).not.toBe('standard');
    }
});

it('uses the same non-standard type for provider summaries and details', async () => {
    const group = {
        id: '62c942aec8113d004c7b261e',
        name: 'German Broadcast Combined (Original Air Date)',
        type: 1 as const,
        episode_count: 65,
        group_count: 4,
    };
    vi.spyOn(tmdbApi, 'isAvailable').mockReturnValue(true);
    vi.spyOn(tmdbApi, 'getEpisodeGroups').mockResolvedValue([group]);
    vi.spyOn(tmdbApi, 'getEpisodeGroupDetails').mockResolvedValue({ ...group, groups: [] });
    const provider = new TmdbEpisodeGroupProvider();

    expect(await provider.getEpisodeGroups('2228')).toEqual([
        expect.objectContaining({ groupId: group.id, groupType: 'other' }),
    ]);
    expect(await provider.getGroupDetails(group.id)).toMatchObject({
        groupId: group.id,
        groupType: 'other',
    });
});
