// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * TMDB normalization helpers.
 *
 * Converts raw TmdbItem (Record<string, unknown>) shapes returned by the
 * native provider's search() and detail() methods into the canonical
 * MetadataCandidate / MediaMetadata types consumed by the legacy plugin
 * runtime and downstream enrichment services.
 *
 * Logic mirrors the legacy plugin's transformToMetadata /
 * transformSearchResultToMetadata / searchMovie / searchSeries helpers
 * exactly — no new fields are added or removed.
 */

import type { MetadataCandidate, MediaMetadata } from '$lib/server/providers/types.js';
import { isMovie } from '$lib/server/utils/media-types.js';
import { normalizeTitle } from '$lib/server/utils/string-utils.js';
import { normalizedSimilarity } from '$lib/server/utils/string-similarity.js';

// ---------------------------------------------------------------------------
// Title-similarity gate
// ---------------------------------------------------------------------------

/**
 * Compute a normalized title-similarity score (0–1) between a query title
 * (e.g. a personal-media item's title) and a candidate title returned by a
 * provider search.
 *
 * Uses a token-set ratio: titles are normalized (lowercased, punctuation and
 * leetspeak stripped via {@link normalizeTitle}), split into word tokens, and
 * compared as order-independent sets. This is more forgiving than a raw
 * Levenshtein on the whole string for reordered / partially-overlapping titles
 * (e.g. "The Outpost" vs "Outpost, The"), while still rejecting unrelated titles.
 * Falls back to whole-string {@link normalizedSimilarity} and takes the higher
 * of the two so single-token titles still score sensibly.
 *
 * @returns A score in [0, 1]; 1.0 = identical normalized titles, 0 = no overlap.
 */
export function titleSimilarity(queryTitle: string, candidateTitle: string): number {
    const a = normalizeTitle(queryTitle ?? '');
    const b = normalizeTitle(candidateTitle ?? '');
    if (!a || !b) return 0;
    if (a === b) return 1;

    // Token-set ratio: intersection size over union size.
    const tokensA = new Set(a.split(' ').filter(Boolean));
    const tokensB = new Set(b.split(' ').filter(Boolean));
    let intersection = 0;
    for (const t of tokensA) {
        if (tokensB.has(t)) intersection++;
    }
    const unionSize = tokensA.size + tokensB.size - intersection;
    const tokenSet = unionSize > 0 ? intersection / unionSize : 0;

    // Whole-string Levenshtein similarity as a fallback signal.
    const stringSim = normalizedSimilarity(a, b);

    return Math.max(tokenSet, stringSim);
}

/**
 * Proximity score (0–1) between two release years.
 *
 * 1.0 when the years are equal (or either is unknown — absent year data must
 * not penalise an otherwise-good title match), degrading linearly to 0 at a
 * 3-year gap. Used as a multiplicative bonus alongside {@link titleSimilarity}
 * when ranking auto-identify candidates.
 */
export function yearProximity(queryYear?: number, candidateYear?: number): number {
    if (queryYear == null || candidateYear == null) return 1;
    const gap = Math.abs(queryYear - candidateYear);
    if (gap === 0) return 1;
    if (gap >= 3) return 0;
    return 1 - gap / 3;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function parseReleaseYear(dateStr?: unknown): number | undefined {
    if (typeof dateStr !== 'string' || !dateStr) return undefined;
    const year = parseInt(dateStr.split('-')[0], 10);
    return isNaN(year) ? undefined : year;
}

function str(v: unknown): string {
    return typeof v === 'string' ? v : '';
}

function num(v: unknown): number | undefined {
    if (typeof v === 'number' && isFinite(v)) return v;
    return undefined;
}

function arr<T>(v: unknown): T[] {
    return Array.isArray(v) ? (v as T[]) : [];
}

// ---------------------------------------------------------------------------
// searchResultToCandidate
// ---------------------------------------------------------------------------

/**
 * Map a raw TMDB search result item to MetadataCandidate.
 *
 * The raw item must carry a `media_type` field ('movie' | 'tv') — the native
 * provider injects this when dispatching to /search/movie or /search/tv.
 *
 * Returns null if the item is missing required fields (id, title).
 */
export function searchResultToCandidate(
    raw: unknown,
    type: 'movie' | 'tv',
    queryYear?: number,
): MetadataCandidate | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;

    const id = r['id'];
    if (id === undefined || id === null) return null;

    const mediaType = type; // caller supplies the type
    const isMovieType = isMovie(mediaType);

    const title =
        str(isMovieType ? r['title'] : r['name']) || str(isMovieType ? r['name'] : r['title']);
    if (!title) return null;

    const popularity = num(r['popularity']);

    return {
        externalId: String(id),
        provider: 'tmdb',
        title,
        // queryYear=0 is treated as "no year supplied" — use parsed year instead.
        year: isMovieType
            ? queryYear != null && queryYear > 0
                ? queryYear
                : parseReleaseYear(r['release_date'] ?? r['first_air_date'])
            : parseReleaseYear(r['first_air_date'] ?? r['release_date']),
        mediaType: isMovieType ? 'movie' : 'tv',
        confidence: popularity != null ? Math.min(popularity / 100, 1) : 0.5,
        overview: str(r['overview']) || undefined,
        posterUrl:
            typeof r['poster_path'] === 'string' && r['poster_path']
                ? `https://image.tmdb.org/t/p/w185${r['poster_path']}`
                : undefined,
    };
}

// ---------------------------------------------------------------------------
// detailToMetadata
// ---------------------------------------------------------------------------

/**
 * Map a raw TMDB detail response (with append_to_response fields) to
 * MediaMetadata. Returns null if the raw object is missing or invalid.
 *
 * Mirrors transformToMetadata from the legacy TMDB plugin exactly.
 * Extended fields (networks, totalEpisodes, budget, revenue, etc.) are
 * preserved via `as MediaMetadata & Record<string, unknown>`.
 */
export function detailToMetadata(raw: unknown, type: 'movie' | 'tv'): MediaMetadata | null {
    if (!raw || typeof raw !== 'object') return null;
    const details = raw as Record<string, unknown>;

    const isMovieType = isMovie(type);

    // credits
    const creditsRaw = details['credits'] as Record<string, unknown> | undefined;
    const castRaw = arr<Record<string, unknown>>(creditsRaw?.['cast']).slice(0, 50);
    const crewRaw = arr<Record<string, unknown>>(creditsRaw?.['crew']);

    const cast = castRaw.map((m) => ({
        name: str(m['name']),
        character: str(m['character']) || undefined,
        order: num(m['order']),
    }));

    const directors: string[] = [];
    const writers: string[] = [];
    const producers: string[] = [];
    const crew: Array<{ name: string; job: string; department?: string }> = [];

    for (const m of crewRaw) {
        const name = str(m['name']);
        const job = str(m['job']);
        const department = str(m['department']) || undefined;
        crew.push({ name, job, department });
        if (job === 'Director') {
            directors.push(name);
        } else if (department === 'Writing' || job === 'Writer' || job === 'Screenplay') {
            if (!writers.includes(name)) writers.push(name);
        } else if (job === 'Producer' || job === 'Executive Producer') {
            if (!producers.includes(name)) producers.push(name);
        }
    }

    // trailer
    let trailerUrl: string | undefined;
    const videosRaw = details['videos'] as Record<string, unknown> | undefined;
    const videoResults = arr<Record<string, unknown>>(videosRaw?.['results']);
    const trailer = videoResults.find(
        (v) => v['site'] === 'YouTube' && (v['type'] === 'Trailer' || v['type'] === 'Teaser'),
    );
    if (trailer) {
        trailerUrl = `https://www.youtube.com/watch?v=${str(trailer['key'])}`;
    }

    // keywords — TMDB returns movie keywords under `.keywords` and TV keywords
    // under `.results`. Pick whichever is present (the other will be undefined,
    // not an empty array — the `||` between `.map()` results is dead because
    // `arr([])` is truthy in JS).
    const keywordsRaw = details['keywords'] as Record<string, unknown> | undefined;
    const keywordsField = keywordsRaw?.['keywords'] ?? keywordsRaw?.['results'];
    const keywords = arr<Record<string, unknown>>(keywordsField).map((k) => str(k['name']));

    // English translations
    const translationsRaw = details['translations'] as Record<string, unknown> | undefined;
    const translations = arr<Record<string, unknown>>(translationsRaw?.['translations']);
    const englishTranslation = translations.find((t) => t['iso_639_1'] === 'en');
    const enData = englishTranslation?.['data'] as Record<string, unknown> | undefined;
    const englishTitle = isMovieType ? str(enData?.['title']) : str(enData?.['name']);
    const englishOverview = str(enData?.['overview']);
    const englishTagline = str(enData?.['tagline']);

    const rawTagline = str((details as Record<string, unknown>)['tagline']);

    // genres
    const genresArr = arr<Record<string, unknown>>(details['genres']).map((g) => str(g['name']));

    // external IDs
    const externalIdsRaw = details['external_ids'] as Record<string, unknown> | undefined;
    const imdbId = str(externalIdsRaw?.['imdb_id']) || undefined;

    // TV-specific
    const numberOfEpisodes = num(details['number_of_episodes']);
    const numberOfSeasons = num(details['number_of_seasons']);
    const tvStatus = str(details['status']) || undefined;
    const networks = arr<Record<string, unknown>>(details['networks']).map((n) => str(n['name']));
    const budget = num(details['budget']);
    const revenue = num(details['revenue']);

    return {
        title: isMovieType ? str(details['title']) : str(details['name']),
        originalTitle: isMovieType
            ? str(details['original_title']) || undefined
            : str(details['original_name']) || undefined,
        englishTitle: englishTitle || undefined,
        year: parseReleaseYear(isMovieType ? details['release_date'] : details['first_air_date']),
        releaseDate: isMovieType
            ? str(details['release_date']) || undefined
            : str(details['first_air_date']) || undefined,
        overview: str(details['overview']) || str(englishOverview) || undefined,
        tagline: rawTagline || englishTagline || undefined,
        genres: genresArr,
        keywords,
        runtime: num(details['runtime']),
        status: tvStatus,
        language: str(details['original_language']) || undefined,
        countries: arr<Record<string, unknown>>(details['production_countries']).map((c) =>
            str(c['name']),
        ),
        cast,
        crew,
        externalIds: imdbId ? { imdb: imdbId } : undefined,
        posterUrl:
            typeof details['poster_path'] === 'string' && details['poster_path']
                ? `https://image.tmdb.org/t/p/original${details['poster_path']}`
                : undefined,
        backdropUrl:
            typeof details['backdrop_path'] === 'string' && details['backdrop_path']
                ? `https://image.tmdb.org/t/p/original${details['backdrop_path']}`
                : undefined,
        // Extended TV fields
        ...(!isMovieType && {
            networks,
            totalEpisodes: numberOfEpisodes,
            totalSeasons: numberOfSeasons,
            seriesStatus: tvStatus,
        }),
        // Extended movie fields
        ...(isMovieType && {
            budget,
            revenue,
        }),
        directors,
        writers,
        actors: cast.slice(0, 20).map((c) => c.name),
        voteAverage: num(details['vote_average']),
        voteCount: num(details['vote_count']),
        popularity: num(details['popularity']),
        trailerUrl,
        productionCompanies: arr<Record<string, unknown>>(details['production_companies']).map(
            (c) => str(c['name']),
        ),
        spokenLanguages: arr<Record<string, unknown>>(details['spoken_languages']).map(
            (l) => str(l['english_name']) || str(l['name']),
        ),
    } as MediaMetadata & Record<string, unknown>;
}
