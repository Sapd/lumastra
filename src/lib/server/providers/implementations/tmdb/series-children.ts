// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * TMDB series-children helper.
 *
 * Returns a `SeriesChildrenResult` (seasons + episodes) for a TMDB series.
 * Extracted from the legacy `TmdbMetadataPlugin.getSeriesChildren` so callers
 * can drive series-children sync against the new SDK provider registry without
 * routing through the deleted legacy plugin shell.
 *
 * Walks the TV details (season list) and fetches the episodes of the selected
 * seasons (default: all) in one batched `api.getSeasonsEpisodes()` call.
 * Best-effort: a season TMDB returns nothing for is logged and skipped so a
 * single broken season doesn't drop the whole sync.
 *
 * Language: a fresh `TMDBApiService` is constructed per call via
 * `createTMDBApi()` rather than importing the frozen `tmdbApi` singleton.
 * The singleton bakes `config.TMDB_LANGUAGE` in at process-boot time (its
 * constructor default param is only evaluated once, when the module-level
 * `new TMDBApiService()` runs) — so a config change never reaches it without
 * a process restart. Callers should resolve the correct per-item language
 * (e.g. `resolveItemLanguage()` in metadata-sync-single.service.ts) and pass
 * it as `language`; omitting it falls back to the CURRENT `config.TMDB_LANGUAGE`
 * value (read fresh on every call), not whatever it was at boot.
 */

import type {
    EpisodeMetadata,
    SeasonMetadata,
    SeriesChildrenResult,
} from '$lib/server/providers/types.js';
import { createTMDBApi } from './client.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('TmdbSeriesChildren');

/** A season as listed in the TMDB `/tv/{id}` details (no episodes). */
export interface TmdbSeasonListing {
    season_number: number;
    name?: string;
    overview?: string;
    air_date?: string;
    poster_path?: string | null;
    episode_count?: number;
}

export interface GetSeriesChildrenOptions {
    /**
     * Decide from the TV details' season list which seasons are fetched. Seasons
     * it rejects are omitted from the result entirely (no episodes, no season
     * metadata), so the caller must treat the result as PARTIAL. Omitted = fetch
     * every season (a full sync).
     */
    selectSeasons?: (seasons: TmdbSeasonListing[]) => ReadonlySet<number>;
}

export async function getSeriesChildren(
    seriesExternalId: string,
    signal?: AbortSignal,
    language?: string | null,
    options: GetSeriesChildrenOptions = {},
): Promise<SeriesChildrenResult> {
    const tmdbId = parseInt(seriesExternalId, 10);
    if (isNaN(tmdbId)) return { seasons: [] };

    const api = createTMDBApi(language ?? config.TMDB_LANGUAGE);

    const details = (await api.getTVShowDetails(tmdbId)) as { seasons?: TmdbSeasonListing[] };
    const listing = details.seasons ?? [];
    const selected = options.selectSeasons?.(listing);
    const wanted = listing.filter((s) => !selected || selected.has(s.season_number));

    // Honor the abort signal before the (batched) season fetch. A TMDB
    // rate-limit backoff of 30s+ per call once kept a per-season loop running
    // 24 min past the task's 10 min cap (preprod 2026-05-22, "The League");
    // the caller surfaces stopReason='aborted' when it sees the signal.
    const aborted = () => {
        logger.info('TMDB getSeriesChildren aborted during season fetch', {
            tmdbId,
            totalSeasons: listing.length,
        });
        return { seasons: [] as SeasonMetadata[] };
    };
    if (signal?.aborted) return aborted();

    // One request for up to 20 seasons (append_to_response=season/N,...). The
    // signal reaches the requests; a 429 / failed batch rejects (retryable
    // step failure) instead of fanning out into one request per season.
    let episodesBySeason: Awaited<ReturnType<typeof api.getSeasonsEpisodes>>;
    try {
        episodesBySeason = await api.getSeasonsEpisodes(
            tmdbId,
            wanted.map((s) => s.season_number),
            signal,
        );
    } catch (err) {
        if (signal?.aborted) return aborted();
        throw err;
    }

    const seasons: SeasonMetadata[] = [];
    const incompleteSeasons: number[] = [];
    for (const rawSeason of wanted) {
        const rawEpisodes = episodesBySeason.get(rawSeason.season_number);
        if (!rawEpisodes) {
            // A failed season is INCOMPLETE, not empty: never written (so the
            // season's stored episodes stay), never counted as full coverage.
            logger.warn('TMDB season episodes unavailable, season left incomplete', {
                tmdbId,
                seasonNumber: rawSeason.season_number,
            });
            incompleteSeasons.push(rawSeason.season_number);
            continue;
        }

        const episodes: EpisodeMetadata[] = rawEpisodes.map((ep) => ({
            seriesExternalId,
            season: ep.seasonNumber,
            episode: ep.episodeNumber,
            title: ep.name,
            overview: ep.overview,
            airDate: ep.airDate,
            runtime: ep.runtimeMinutes,
            externalId: String(ep.id),
            stillUrl: ep.stillPath ? `https://image.tmdb.org/t/p/w300${ep.stillPath}` : undefined,
        }));

        seasons.push({
            seasonNumber: rawSeason.season_number,
            name: rawSeason.name ?? `Season ${rawSeason.season_number}`,
            overview: rawSeason.overview,
            airDate: rawSeason.air_date,
            posterUrl: rawSeason.poster_path
                ? `https://image.tmdb.org/t/p/w342${rawSeason.poster_path}`
                : undefined,
            episodes,
        });
    }

    return {
        seasons,
        ...(wanted.length < listing.length ? { partial: true } : {}),
        ...(incompleteSeasons.length > 0 ? { incompleteSeasons } : {}),
    };
}
