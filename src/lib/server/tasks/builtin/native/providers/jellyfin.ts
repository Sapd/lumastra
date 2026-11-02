// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Jellyfin metadata provider — native defineProvider migration (Wave 3).
 *
 * Jellyfin provides local metadata for movies and TV shows via the Jellyfin
 * server API. This is a supplementary provider (priority 70, below TMDB at
 * 100) that enriches items already in the library. It requires a configured
 * Jellyfin instance (JELLYFINURL + JELLYFINAPIKEY). Metadata requests share
 * the circuit breaker but are independent of watch sync and its status.
 *
 * No rate limit — Jellyfin is a local server.
 *
 * Like setup and watch sync, this built-in integration calls only the
 * admin-configured Jellyfin server, including private Docker/LAN addresses.
 * fetchWithTimeout preserves the same-host redirect guard and ctx.signal;
 * the generic plugin HTTP client remains public-address-only.
 *
 * Implemented methods:
 *   search(ctx, { type, query })   — admin /Items endpoint, no userId required
 *   detail(ctx, id)                — /Items/{id} with Overview/Genres/RunTimeTicks
 *   childList(ctx, seriesId)       — /Shows/{id}/Seasons + /Shows/{id}/Episodes
 *
 * detail() id convention:
 *   Bare Jellyfin UUID (e.g. "abc123…") — works for both movies and series.
 *   The type (movie vs series) is inferred from the Type field in the response.
 */

import { joinUpstreamUrl } from '$lib/shared/upstream-url.js';
import { buildJellyfinAuthHeaders } from '$lib/server/jellyfin/auth-headers.js';
import type { PluginContext } from '@sapd/lumastra-plugin-sdk';
import { defineProvider } from '@sapd/lumastra-plugin-sdk';
import { registry } from '../../../registry.js';
import { config } from '../../../../config.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-timeout.js';
import {
    recordJellyfinTransportFailure,
    recordJellyfinTransportSuccess,
} from '$lib/server/jellyfin/runtime-gate.js';
import { encodePathSegment } from '$lib/server/utils/upstream-path';
import { circuitBreaker } from '$lib/server/jellyfin/base-client.js';

// Full series metadata (including overviews) needs longer than image fetches.
const JELLYFIN_METADATA_FETCH_TIMEOUT_MS = 30_000;
// ---------------------------------------------------------------------------
// Param / result shapes
// ---------------------------------------------------------------------------

export interface JellyfinSearchParams {
    type: 'movie' | 'tv';
    query: string;
}

/**
 * Unified Jellyfin result shape covering search candidates, detail responses,
 * and episode/season items. Fields are optional — the API omits absent fields.
 */
export interface JellyfinItem {
    // Search candidate fields (MetadataCandidate-compatible)
    Id?: string;
    Name?: string;
    OriginalTitle?: string;
    ProductionYear?: number;
    Type?: string;

    // Detail fields
    Overview?: string;
    Genres?: string[];
    RunTimeTicks?: number;
    ProviderIds?: Record<string, string>;
    PremiereDate?: string;
    Status?: string;
    CommunityRating?: number;

    // Episode-specific fields
    IndexNumber?: number; // episode number
    ParentIndexNumber?: number; // season number
    SeriesId?: string;
    SeriesName?: string;

    // Season-specific fields
    ChildCount?: number;

    [key: string]: unknown;
}

/** Structured result for childList() — wraps seasons containing their episodes. */
export interface JellyfinSeriesChildren {
    seasons: Array<{
        id: string;
        name: string;
        seasonNumber: number;
        overview?: string;
        airDate?: string;
        episodes: Array<{
            id: string;
            seriesId: string;
            name: string;
            episodeNumber: number;
            seasonNumber: number;
            overview?: string;
            runTimeTicks?: number;
            airDate?: string;
        }>;
    }>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** 1 RunTimeTick = 100 nanoseconds. */
function ticksToMinutes(ticks: number | undefined): number | undefined {
    if (!ticks) return undefined;
    return Math.round(ticks / 600_000_000);
}

interface JellyfinItemsResponse {
    Items?: JellyfinItem[];
    TotalRecordCount?: number;
}

async function jellyfinGet<T>(
    ctx: PluginContext,
    url: string,
    params?: Record<string, string>,
): Promise<T> {
    // Metadata can be configured independently of watch sync and its status.
    if (!circuitBreaker.shouldAllowRequest()) throw new Error('Jellyfin is not available');

    const fullUrl = params
        ? joinUpstreamUrl(url, `?${new URLSearchParams(params).toString()}`)
        : url;

    const apiKey = config.JELLYFINAPIKEY?.trim();
    if (!apiKey) throw new Error('JELLYFINAPIKEY is not configured');

    // Every URL above is built from JELLYFINURL and encoded item IDs, never
    // from a provider result or an arbitrary request URL. The shared redirect
    // guard refuses a different host and HTTPS downgrades before sending auth.
    let response: Response;
    try {
        response = await fetchWithTimeout(
            fullUrl,
            {
                headers: buildJellyfinAuthHeaders({ token: apiKey }),
                signal: ctx.signal,
            },
            JELLYFIN_METADATA_FETCH_TIMEOUT_MS,
        );
        recordJellyfinTransportSuccess();
    } catch (error) {
        // Cancelling a task says nothing about the health of Jellyfin.
        if (!ctx.signal?.aborted) recordJellyfinTransportFailure(error);
        throw error;
    }

    if (!response.ok) {
        throw new Error(
            `jellyfin API request failed: ${response.status} ${response.statusText} — ${fullUrl}`,
        );
    }

    return response.json() as Promise<T>;
}

function jellyfinBaseUrl(): string {
    const base = config.JELLYFINURL?.trim();
    if (!base) throw new Error('JELLYFINURL is not configured');
    return base.replace(/\/$/, '');
}

// ---------------------------------------------------------------------------
// Provider definition
// ---------------------------------------------------------------------------

export const jellyfinProvider = defineProvider<JellyfinSearchParams, JellyfinItem>({
    id: 'jellyfin-metadata-provider',
    name: 'Jellyfin',
    version: '1.0.0',

    capabilities: { http: true },

    metadata: {
        priority: 70,
    },

    settings: {
        fields: [],
    },

    async isConfigured(_ctx): Promise<boolean> {
        if (process.env['DISABLE_JELLYFIN_METADATA_PROVIDER']?.trim().toLowerCase() === 'true')
            return false;
        return (
            !!config.JELLYFINURL?.trim() &&
            !!config.JELLYFINAPIKEY?.trim() &&
            circuitBreaker.shouldAllowRequest()
        );
    },

    /**
     * Search for movies or TV shows by title.
     *
     * Uses the admin /Items endpoint (no userId required) with SearchTerm.
     * Year filtering is not supported by this endpoint — callers must
     * disambiguate using the ProductionYear field in returned items.
     *
     * params.type determines which ItemTypes filter is applied:
     *   'movie' → IncludeItemTypes=Movie
     *   'tv'    → IncludeItemTypes=Series
     */
    async search(ctx, params): Promise<JellyfinItem[]> {
        const base = jellyfinBaseUrl();
        const itemType = params.type === 'tv' ? 'Series' : 'Movie';

        const data = await jellyfinGet<JellyfinItemsResponse>(
            ctx,
            joinUpstreamUrl(base, `/Items`),
            {
                SearchTerm: params.query,
                IncludeItemTypes: itemType,
                Recursive: 'true',
                Limit: '25',
                Fields: 'Overview,ChildCount,Genres,ProviderIds',
            },
        );

        return (data.Items ?? []).filter((item) => item.Id && item.Name);
    },

    /**
     * Fetch full item details by Jellyfin UUID.
     *
     * Uses the admin /Items/{id} endpoint (no userId).
     * Works for both movies and series — the response Type field distinguishes them.
     */
    async detail(ctx, id): Promise<JellyfinItem> {
        const base = jellyfinBaseUrl();

        const item = await jellyfinGet<JellyfinItem>(
            ctx,
            joinUpstreamUrl(base, `/Items/${encodePathSegment(id)}`),
            {
                Fields: 'Overview,Genres,RunTimeTicks,ProviderIds,OriginalTitle,PremiereDate',
            },
        );

        if (!item.Id) {
            throw new Error(`jellyfin detail(): item not found for id "${id}"`);
        }

        return item;
    },

    /**
     * Fetch series children (seasons + episodes) by Jellyfin series UUID.
     *
     * Fetches /Shows/{seriesId}/Seasons and /Shows/{seriesId}/Episodes in
     * parallel, then groups episodes under their parent seasons.
     *
     * Returns a JellyfinSeriesChildren object serialised as a JellyfinItem
     * (via the `[key: string]: unknown` escape hatch) so the SDK's TItem
     * constraint is satisfied without changing the generic signature.
     */
    async childList(ctx, parentId): Promise<JellyfinItem[]> {
        const base = jellyfinBaseUrl();

        const [seasonsData, episodesData] = await Promise.all([
            jellyfinGet<JellyfinItemsResponse>(
                ctx,
                joinUpstreamUrl(base, `/Shows/${encodePathSegment(parentId)}/Seasons`),
                {
                    Fields: 'Overview,ChildCount,ImageTags',
                },
            ),
            jellyfinGet<JellyfinItemsResponse>(
                ctx,
                joinUpstreamUrl(base, `/Shows/${encodePathSegment(parentId)}/Episodes`),
                {
                    Fields: 'Overview,ProviderIds',
                },
            ),
        ]);

        const rawSeasons = (seasonsData.Items ?? []).filter(
            (s): s is JellyfinItem & { Id: string } => !!s.Id,
        );
        const rawEpisodes = (episodesData.Items ?? []).filter(
            (e): e is JellyfinItem & { Id: string } => !!e.Id,
        );

        // Group episodes by season number
        type MappedEpisode = JellyfinSeriesChildren['seasons'][0]['episodes'][0];
        const episodesBySeason = new Map<number, MappedEpisode[]>();
        for (const ep of rawEpisodes) {
            const seasonNum = typeof ep.ParentIndexNumber === 'number' ? ep.ParentIndexNumber : 1;
            const existing = episodesBySeason.get(seasonNum) ?? [];
            existing.push({
                id: ep.Id,
                seriesId: parentId,
                name: ep.Name ?? `Episode ${ep.IndexNumber ?? '?'}`,
                episodeNumber: typeof ep.IndexNumber === 'number' ? ep.IndexNumber : 1,
                seasonNumber: seasonNum,
                overview: typeof ep.Overview === 'string' ? ep.Overview : undefined,
                runTimeTicks: typeof ep.RunTimeTicks === 'number' ? ep.RunTimeTicks : undefined,
                airDate: typeof ep.PremiereDate === 'string' ? ep.PremiereDate : undefined,
            });
            episodesBySeason.set(seasonNum, existing);
        }

        type MappedSeason = JellyfinSeriesChildren['seasons'][0];
        let seasons: MappedSeason[];

        if (rawSeasons.length > 0) {
            seasons = rawSeasons.map((s) => {
                const seasonNum = typeof s.IndexNumber === 'number' ? s.IndexNumber : 0;
                return {
                    id: s.Id,
                    name: typeof s.Name === 'string' ? s.Name : `Season ${seasonNum}`,
                    seasonNumber: seasonNum,
                    overview: typeof s.Overview === 'string' ? s.Overview : undefined,
                    airDate: typeof s.PremiereDate === 'string' ? s.PremiereDate : undefined,
                    episodes: episodesBySeason.get(seasonNum) ?? [],
                };
            });
        } else {
            // Synthesise seasons from episode data when /Seasons returns empty
            seasons = Array.from(episodesBySeason.entries()).map(([seasonNum, eps]) => ({
                id: `${parentId}:season:${seasonNum}`,
                name: `Season ${seasonNum}`,
                seasonNumber: seasonNum,
                overview: undefined,
                airDate: undefined,
                episodes: eps,
            }));
        }

        const result: JellyfinSeriesChildren = { seasons };

        // Return as a single-element array; the seasons + episodes tree lives
        // inside the object at `result.seasons`. Callers (metadata-sync) will
        // unwrap it. This mirrors the legacy getSeriesChildren() return contract.
        return [result as unknown as JellyfinItem];
    },
});

// Self-register so loadBuiltins() import is sufficient.
registry.registerProvider(jellyfinProvider);

// ---------------------------------------------------------------------------
// Re-export ticksToMinutes for consumers that need it
// ---------------------------------------------------------------------------
export { ticksToMinutes };
