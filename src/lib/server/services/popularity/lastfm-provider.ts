// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Last.fm implementation of the PopularityProvider interface.
 *
 * Wraps the pure lastfm-api.ts HTTP client and maps its responses into the
 * provider-native shape the orchestrator expects. Knows nothing about our
 * library or internal UUIDs.
 */

import { getArtistInfo, getArtistTopTracks, type LastFmTopTrack } from '../lastfm-api.js';
import type {
    ArtistPopularityRequest,
    PopularityProvider,
    PopularitySource,
    ProviderArtistPopularity,
    ProviderTopTrack,
} from './types.js';

const SOURCE_ID: PopularitySource = 'lastfm';
// Higher than Last.fm's default of 30 so deep-cut remixes and edits appear
// in the window. Catalogs with many version-variants per title (e.g. dance
// compilations) rank their individual edits well past #30.
const TOP_TRACKS_LIMIT = 200;

function toProviderTrack(t: LastFmTopTrack): ProviderTopTrack {
    return {
        providerTitle: t.name,
        providerMbid: t.mbid ?? undefined,
        rank: t.rank,
        rawListeners: t.listeners,
        rawPlaycount: t.playcount,
        providerUrl: t.url,
    };
}

export function createLastFmProvider(apiKey: string): PopularityProvider {
    return {
        id: SOURCE_ID,
        displayName: 'Last.fm',
        attributionText: 'Data from Last.fm',
        attributionUrl: 'https://www.last.fm/',

        isConfigured() {
            return apiKey.trim().length > 0;
        },

        async fetchArtistPopularity(
            input: ArtistPopularityRequest,
            options: { signal?: AbortSignal } = {},
        ): Promise<ProviderArtistPopularity | null> {
            if (!apiKey) return null;

            const [info, topTracks] = await Promise.all([
                getArtistInfo({
                    mbid: input.mbid,
                    name: input.title,
                    apiKey,
                    signal: options.signal,
                }),
                getArtistTopTracks({
                    mbid: input.mbid,
                    name: input.title,
                    apiKey,
                    limit: TOP_TRACKS_LIMIT,
                    signal: options.signal,
                }),
            ]);

            if (!info) return null;

            return {
                artist: {
                    rawListeners: info.listeners,
                    rawPlaycount: info.playcount,
                    providerUrl: info.url,
                    rawMetadata: {
                        tags: info.tags,
                        similar_artists: info.similar,
                        bio_summary: info.bioSummary,
                        mbid: info.mbid,
                    },
                },
                topTracks: (topTracks ?? []).map(toProviderTrack),
            };
        },
    };
}
