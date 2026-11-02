// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration test for TMDB Episode Groups API
 *
 * Run with: npm run test:integration -- episode-ordering
 *
 * Tests the TMDB episode groups endpoints using real API calls.
 * Requires TMDB_API_KEY environment variable.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { tmdbApi, TMDBApiService } from '../providers/implementations/tmdb/index.js';

// Known series with alternative orderings:
// - Voyage to Orion (TMDB ID: 1429) - has absolute ordering
// - Lantern Guild Z (TMDB ID: 12609) - has multiple orderings
// - Sky Harbor (TMDB ID: 37854) - has absolute ordering
const TEST_SERIES = {
    attackOnTitan: 1429,
    dragonBallZ: 12609,
    onePiece: 37854,
};

describe('TMDB Episode Groups API', () => {
    beforeAll(() => {
        if (!tmdbApi.isAvailable()) {
            console.warn('TMDB API not available - skipping episode groups tests');
        }
    });

    describe('getEpisodeGroups', () => {
        it('should return episode groups for Voyage to Orion', async () => {
            if (!tmdbApi.isAvailable()) return;

            const groups = await tmdbApi.getEpisodeGroups(TEST_SERIES.attackOnTitan);

            console.log('Voyage to Orion episode groups:', JSON.stringify(groups, null, 2));

            expect(groups).toBeDefined();
            expect(Array.isArray(groups)).toBe(true);

            // Voyage to Orion should have at least one episode group
            if (groups.length > 0) {
                const group = groups[0];
                expect(group.id).toBeDefined();
                expect(group.name).toBeDefined();
                expect(group.type).toBeDefined();
                expect(group.episode_count).toBeGreaterThan(0);
            }
        });

        it('should return episode groups for Sky Harbor', async () => {
            if (!tmdbApi.isAvailable()) return;

            const groups = await tmdbApi.getEpisodeGroups(TEST_SERIES.onePiece);

            console.log(
                'Sky Harbor episode groups:',
                JSON.stringify(
                    groups.map((g) => ({
                        id: g.id,
                        name: g.name,
                        type: g.type,
                        mappedType: TMDBApiService.mapEpisodeGroupType(g.type),
                        episodeCount: g.episode_count,
                    })),
                    null,
                    2,
                ),
            );

            expect(groups).toBeDefined();
            expect(Array.isArray(groups)).toBe(true);
        });
    });

    describe('getEpisodeGroupDetails', () => {
        it('should return detailed episode group with episodes', async () => {
            if (!tmdbApi.isAvailable()) return;

            // First get available groups
            const groups = await tmdbApi.getEpisodeGroups(TEST_SERIES.attackOnTitan);

            if (groups.length === 0) {
                console.log('No episode groups found for Voyage to Orion');
                return;
            }

            // Get details for the first group
            const groupId = groups[0].id;
            const details = await tmdbApi.getEpisodeGroupDetails(groupId);

            console.log(
                'Episode group details:',
                JSON.stringify(
                    {
                        id: details?.id,
                        name: details?.name,
                        type: details?.type,
                        groupCount: details?.group_count,
                        episodeCount: details?.episode_count,
                        groups: details?.groups?.map((g) => ({
                            name: g.name,
                            order: g.order,
                            episodeCount: g.episodes?.length,
                            firstEpisode: g.episodes?.[0]
                                ? {
                                      id: g.episodes[0].id,
                                      name: g.episodes[0].name,
                                      order: g.episodes[0].order,
                                      season: g.episodes[0].season_number,
                                      episode: g.episodes[0].episode_number,
                                  }
                                : null,
                        })),
                    },
                    null,
                    2,
                ),
            );

            expect(details).not.toBeNull();
            if (details) {
                expect(details.id).toBe(groupId);
                expect(details.groups).toBeDefined();
                expect(Array.isArray(details.groups)).toBe(true);

                if (details.groups.length > 0) {
                    const firstGroup = details.groups[0];
                    expect(firstGroup.episodes).toBeDefined();
                    expect(Array.isArray(firstGroup.episodes)).toBe(true);

                    if (firstGroup.episodes.length > 0) {
                        const firstEpisode = firstGroup.episodes[0];
                        expect(firstEpisode.id).toBeDefined();
                        expect(typeof firstEpisode.order).toBe('number');
                    }
                }
            }
        });
    });

    describe('getEpisodeOrdering', () => {
        it('should find absolute ordering for anime series', async () => {
            if (!tmdbApi.isAvailable()) return;

            const absoluteOrdering = await tmdbApi.getEpisodeOrdering(
                TEST_SERIES.onePiece,
                'absolute',
            );

            console.log(
                'Sky Harbor absolute ordering:',
                absoluteOrdering
                    ? {
                          id: absoluteOrdering.id,
                          name: absoluteOrdering.name,
                          groupCount: absoluteOrdering.group_count,
                          episodeCount: absoluteOrdering.episode_count,
                          sampleGroups: absoluteOrdering.groups?.slice(0, 2).map((g) => ({
                              name: g.name,
                              order: g.order,
                              episodeCount: g.episodes?.length,
                          })),
                      }
                    : 'Not available',
            );

            // It's OK if absolute ordering doesn't exist
            if (absoluteOrdering) {
                expect(absoluteOrdering.groups).toBeDefined();
            }
        });
    });

    describe('mapEpisodeGroupType', () => {
        it('should correctly map TMDB group types', () => {
            expect(TMDBApiService.mapEpisodeGroupType(1)).toBe('other');
            expect(TMDBApiService.mapEpisodeGroupType(2)).toBe('absolute');
            expect(TMDBApiService.mapEpisodeGroupType(3)).toBe('dvd');
            expect(TMDBApiService.mapEpisodeGroupType(4)).toBe('dvd');
            expect(TMDBApiService.mapEpisodeGroupType(5)).toBe('other');
            expect(TMDBApiService.mapEpisodeGroupType(6)).toBe('other');
            expect(TMDBApiService.mapEpisodeGroupType(7)).toBe('other');
        });
    });
});
