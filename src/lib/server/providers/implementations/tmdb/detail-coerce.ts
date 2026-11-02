// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure raw-TMDB → provider-neutral coercion.
 *
 * This is the canonical home for the TMDB detail coercion (per
 * `providers/CLAUDE.md`: provider code that isn't a `defineProvider` declaration
 * lives under `providers/implementations/<id>/`). Keeping it here — rather than
 * in the task-registry provider declaration (`tasks/builtin/native/providers/tmdb.ts`,
 * which self-registers on import) — lets non-task callers (the per-item metadata
 * sync, the canonical-fields backfill) reuse it WITHOUT eagerly loading the
 * plugin registry.
 */

import type { ProviderArtwork, ProviderDetailResult } from '@sapd/lumastra-plugin-sdk';
import {
    keywordNamesToSlugs,
    tmdbGenreIdsToSlugs,
} from '$lib/server/database/queries/metadata-aggregation.queries.js';

/** A raw TMDB API item (untyped bag of provider-specific keys). */
export type TmdbItem = Record<string, unknown>;

/**
 * The enriched return type of TMDB's `detail()`.
 *
 * Extends the raw `TmdbItem` (so it still satisfies `ProviderDefinition<…,
 * TmdbItem>.detail`) AND implements the provider-neutral `ProviderDetailResult`
 * contract so callers can read structured fields without re-parsing raw TMDB
 * keys. The raw TMDB response fields (title, poster_path, credits, …) are
 * spread in alongside the neutral fields — nothing is removed.
 */
export type TmdbDetailResult = TmdbItem & ProviderDetailResult;

/**
 * Coerce a raw TMDB API response (movie or TV detail with
 * `append_to_response=credits,videos,keywords,images,translations,external_ids`)
 * into the provider-neutral `ProviderDetailResult` shape.
 *
 * ALL source fields in the raw response are preserved on the returned object —
 * this function only ADDS the neutral fields, never removes raw ones.
 */
/** Character of an aggregate-credits member's most-credited role. */
function mainRoleCharacter(roles: unknown): string | undefined {
    if (!Array.isArray(roles)) return undefined;
    const best = (roles as Array<Record<string, unknown>>)
        .filter((r) => typeof r['character'] === 'string' && r['character'] !== '')
        .sort((a, b) => (Number(b['episode_count']) || 0) - (Number(a['episode_count']) || 0))[0];
    return best ? (best['character'] as string) : undefined;
}

export function buildProviderDetailResult(raw: TmdbItem, kind: 'movie' | 'tv'): TmdbDetailResult {
    const isMovieKind = kind === 'movie';

    // ── Helpers ──────────────────────────────────────────────────────────────
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const num = (v: unknown): number | undefined =>
        typeof v === 'number' && isFinite(v) ? v : undefined;
    const arrOf = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

    // ── Titles ───────────────────────────────────────────────────────────────
    const title = str(isMovieKind ? raw['title'] : raw['name']);
    const originalTitle =
        str(isMovieKind ? raw['original_title'] : raw['original_name']) || undefined;

    // translations → english title + tagline
    const translationsRaw = raw['translations'] as Record<string, unknown> | undefined;
    const translations = arrOf<Record<string, unknown>>(translationsRaw?.['translations']);
    const enTranslation = translations.find((t) => t['iso_639_1'] === 'en');
    const enData = enTranslation?.['data'] as Record<string, unknown> | undefined;
    const englishTitle =
        (isMovieKind ? str(enData?.['title']) : str(enData?.['name'])) || undefined;
    const englishTagline = str(enData?.['tagline']) || undefined;
    const rawTagline = str(raw['tagline']) || undefined;
    const tagline = rawTagline ?? englishTagline;

    // ── Overview ─────────────────────────────────────────────────────────────
    const overview = str(raw['overview']) || str(enData?.['overview']) || undefined;

    // ── Dates + runtime ──────────────────────────────────────────────────────
    const releaseDate = str(isMovieKind ? raw['release_date'] : raw['first_air_date']) || undefined;
    const runtime = num(raw['runtime']);

    // ── Genres ───────────────────────────────────────────────────────────────
    const genreObjs = arrOf<Record<string, unknown>>(raw['genres']);
    const genreNames = genreObjs.map((g) => str(g['name'])).filter(Boolean);
    // Derive neutral slugs from numeric IDs via the canonical TMDB_GENRE_SLUG_MAP
    // so the enrichment path and the discovery path always produce identical slugs.
    const genreIds = genreObjs
        .map((g) => (typeof g['id'] === 'number' ? (g['id'] as number) : null))
        .filter((id): id is number => id !== null);
    // Use the canonical TMDB-genre-ID→slug map so slugs are identical to those
    // produced by the aggregation path. Falls back to name-based derivation for
    // any ID not in the map (future genres not yet added to TMDB_GENRE_SLUG_MAP).
    const genreSlugs =
        genreIds.length > 0 ? tmdbGenreIdsToSlugs(genreIds) : keywordNamesToSlugs(genreNames);

    // ── Keywords ─────────────────────────────────────────────────────────────
    const keywordsRaw = raw['keywords'] as Record<string, unknown> | undefined;
    const keywordsField = keywordsRaw?.['keywords'] ?? keywordsRaw?.['results'];
    const keywordObjs = arrOf<Record<string, unknown>>(keywordsField);
    const keywordNames = keywordObjs.map((k) => str(k['name'])).filter(Boolean);
    const rawKeywordIds = keywordObjs
        .map((k) => (typeof k['id'] === 'number' ? (k['id'] as number) : null))
        .filter((id): id is number => id !== null);
    const keywordSlugs = keywordNamesToSlugs(keywordNames);

    // ── Cast + crew ───────────────────────────────────────────────────────────
    const creditsRaw = raw['credits'] as Record<string, unknown> | undefined;
    const crewObjs = arrOf<Record<string, unknown>>(creditsRaw?.['crew']);
    // A TV series' `credits` holds only the LATEST season's regulars and is
    // often empty (Jujutsu Kaisen, American Horror Stories: 0 vs 254 / 197 in
    // `aggregate_credits`). Fall back to the whole-run cast; its members carry
    // `roles[]` instead of a single `character`.
    let castObjs = arrOf<Record<string, unknown>>(creditsRaw?.['cast']);
    if (castObjs.length === 0) {
        const aggregateRaw = raw['aggregate_credits'] as Record<string, unknown> | undefined;
        castObjs = arrOf<Record<string, unknown>>(aggregateRaw?.['cast']).map((m) => ({
            ...m,
            character: mainRoleCharacter(m['roles']),
        }));
    }

    const cast = castObjs.slice(0, 50).map((m) => ({
        name: str(m['name']),
        character: str(m['character']) || undefined,
        order: num(m['order']),
        // TMDB person id → lets the app proxy+cache the headshot via
        // /api/image/person/{id} and expose the id to clients.
        personId: typeof m['id'] === 'number' ? String(m['id']) : undefined,
        profileUrl:
            typeof m['profile_path'] === 'string' && m['profile_path']
                ? `https://image.tmdb.org/t/p/w185${m['profile_path']}`
                : null,
    }));

    const directors: string[] = [];
    const producers: string[] = [];
    const writers: string[] = [];
    for (const m of crewObjs) {
        const name = str(m['name']);
        const job = str(m['job']);
        const dept = str(m['department']);
        if (job === 'Director') {
            if (!directors.includes(name)) directors.push(name);
        } else if (job === 'Producer' || job === 'Executive Producer') {
            if (!producers.includes(name)) producers.push(name);
        } else if (
            dept === 'Writing' ||
            job === 'Writer' ||
            job === 'Screenplay' ||
            job === 'Story'
        ) {
            if (!writers.includes(name)) writers.push(name);
        }
    }

    // ── TV-specific ───────────────────────────────────────────────────────────
    const networks = arrOf<Record<string, unknown>>(raw['networks']).map((n) => str(n['name']));
    const totalEpisodes = num(raw['number_of_episodes']);
    const totalSeasons = num(raw['number_of_seasons']);
    const seriesStatus = !isMovieKind ? str(raw['status']) || undefined : undefined;
    const lastAirDate = !isMovieKind ? str(raw['last_air_date']) || undefined : undefined;

    // ── Quality + popularity ─────────────────────────────────────────────────
    const voteAverage = num(raw['vote_average']);
    const voteCount = num(raw['vote_count']);
    const popularity = num(raw['popularity']);
    const status = isMovieKind ? str(raw['status']) || undefined : undefined;

    // ── External IDs ─────────────────────────────────────────────────────────
    const extIdsRaw = raw['external_ids'] as Record<string, unknown> | undefined;
    const imdbId = str(extIdsRaw?.['imdb_id']) || undefined;
    const tvdbId =
        typeof extIdsRaw?.['tvdb_id'] === 'number' ? String(extIdsRaw['tvdb_id']) : undefined;
    // Provider-neutral external-id map on ProviderDetailResult (a plain Record,
    // NOT the app's ExternalIdMap) — build via object literal so the direct-
    // external-id-access lint rule (which targets ExternalIdMap) doesn't misfire.
    const externalIds: Record<string, string> = {
        ...(imdbId ? { imdb: imdbId } : {}),
        ...(tvdbId ? { tvdb: tvdbId } : {}),
    };

    // ── Artwork ───────────────────────────────────────────────────────────────
    const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p/original';
    const posterPath = raw['poster_path'];
    const backdropPath = raw['backdrop_path'];

    // Pick best logo from the images append (language-neutral logos first).
    const imagesRaw = raw['images'] as Record<string, unknown> | undefined;
    const logos = arrOf<Record<string, unknown>>(imagesRaw?.['logos']);
    const bestLogo =
        logos.find((l) => l['iso_639_1'] === null || l['iso_639_1'] === 'en') ?? logos[0];
    const logoPath = bestLogo ? str(bestLogo['file_path']) : undefined;

    const artwork: ProviderArtwork = {
        posterUrl:
            typeof posterPath === 'string' && posterPath ? `${TMDB_IMAGE_BASE}${posterPath}` : null,
        backdropUrl:
            typeof backdropPath === 'string' && backdropPath
                ? `${TMDB_IMAGE_BASE}${backdropPath}`
                : null,
        logoUrl: logoPath ? `${TMDB_IMAGE_BASE}${logoPath}` : null,
        thumbUrl: null,
    };

    // ── Trailer ───────────────────────────────────────────────────────────────
    const videosRaw = raw['videos'] as Record<string, unknown> | undefined;
    const videoResults = arrOf<Record<string, unknown>>(videosRaw?.['results']);
    const ytVideos = videoResults.filter((v) => v['site'] === 'YouTube');
    const trailerVideo =
        ytVideos.find((v) => v['type'] === 'Trailer' && v['official'] === true) ??
        ytVideos.find((v) => v['type'] === 'Trailer') ??
        ytVideos.find((v) => v['type'] === 'Teaser');
    const trailerUrl = trailerVideo
        ? `https://www.youtube.com/watch?v=${str(trailerVideo['key'])}`
        : undefined;

    // ── Production meta ───────────────────────────────────────────────────────
    const productionCompanies = arrOf<Record<string, unknown>>(raw['production_companies']).map(
        (c) => str(c['name']),
    );
    const productionCountries = arrOf<Record<string, unknown>>(raw['production_countries']).map(
        (c) => str(c['iso_3166_1']),
    );
    const spokenLanguages = arrOf<Record<string, unknown>>(raw['spoken_languages']).map((l) =>
        str(l['iso_639_1']),
    );
    const budget = isMovieKind ? num(raw['budget']) : undefined;
    const revenue = isMovieKind ? num(raw['revenue']) : undefined;

    // ── Compose result (raw spread + neutral overlay) ─────────────────────────
    // `genre_ids` is populated from the parsed genre objects so downstream
    // tmdbGenreIdsToSlugs() can produce canonical slugs if needed.
    const neutral: ProviderDetailResult = {
        title: title || undefined,
        originalTitle,
        englishTitle,
        overview,
        tagline,
        releaseDate,
        runtime,
        genreNames: genreNames.length > 0 ? genreNames : undefined,
        genreSlugs: genreSlugs.length > 0 ? genreSlugs : undefined,
        keywordNames: keywordNames.length > 0 ? keywordNames : undefined,
        keywordSlugs: keywordSlugs.length > 0 ? keywordSlugs : undefined,
        rawKeywordIds: rawKeywordIds.length > 0 ? rawKeywordIds : undefined,
        cast: cast.length > 0 ? cast : undefined,
        directors: directors.length > 0 ? directors : undefined,
        producers: producers.length > 0 ? producers : undefined,
        writers: writers.length > 0 ? writers : undefined,
        networks: networks.length > 0 ? networks : undefined,
        totalEpisodes,
        totalSeasons,
        seriesStatus,
        lastAirDate,
        voteAverage,
        voteCount,
        popularity,
        status,
        imdbId,
        externalIds: Object.keys(externalIds).length > 0 ? externalIds : undefined,
        artwork,
        trailerUrl,
        productionCompanies: productionCompanies.length > 0 ? productionCompanies : undefined,
        productionCountries: productionCountries.length > 0 ? productionCountries : undefined,
        spokenLanguages: spokenLanguages.length > 0 ? spokenLanguages : undefined,
        budget,
        revenue,
    };

    return {
        // Spread the raw TMDB fields first so callers that still read raw
        // TMDB key names (poster_path, vote_average, credits, …) continue to work.
        ...raw,
        // Expose numeric genre_ids alongside the parsed genre objects so
        // downstream tmdbGenreIdsToSlugs() can produce canonical slugs.
        genre_ids: genreIds.length > 0 ? genreIds : raw['genre_ids'],
        // Overlay the structured neutral fields.
        ...neutral,
    };
}
