// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * person.service.ts — shared person-fetch logic for the catalog domain.
 *
 * The service exposes `handlePersonGet(event)`: a raw async handler that
 * takes a SvelteKit RequestEvent (with `params.personId` populated) and
 * returns a Response.  Auth and error handling are the caller's
 * responsibility (the def layer uses `mount()` for both).
 *
 * The private cache retains provider metadata; response mapping runs only after
 * the per-caller access filter. The pkg11 cache-key prefix drops pre-cap entries.
 */

import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { resolvePersonImageSet } from './image-descriptor/people.js';
import { personImageSet } from './image-descriptor/resources.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { RequestEvent } from '@sveltejs/kit';
import { typedJson } from '$lib/server/utils/typed-response.js';
import { config, isUnavailableMediaVisible } from '$lib/server/config.js';
import { tmdbAuthorizedRequest } from '$lib/server/providers/implementations/tmdb/auth.js';
import { ApiResponses } from '$lib/server/utils/api-responses.js';
import { Logger } from '$lib/server/utils/logger.js';
import { cacheManager, CACHE_NAMESPACES } from '$lib/server/cache/index.js';
import { parsePersonHandle, formatPersonHandle } from '$lib/shared/person-handle.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { buildImageSet } from '$lib/shared/image-descriptor.js';
import type { PersonCredit, PersonDetailResponse } from '$lib/schemas/api-person-responses.js';
import { PersonDetailResponseSchema } from '$lib/schemas/api-person-responses.js';
import { aiDbService } from '$lib/server/services/database.service.js';
import { getExternalIdFor } from '$lib/utils/external-ids.js';
import {
    batchGetAvailability,
    isAvailableExpr,
} from '$lib/server/database/queries/availability.queries.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { filterAccessibleMediaIds } from '$lib/server/utils/media-access-batch.js';
import {
    denyAllAccess,
    deniesEverything,
    isUnrestricted,
} from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { MediaAccessBoundary } from '$lib/server/database/queries/builders/media-access-boundary.js';
import type { UserContext } from '$lib/server/types.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import {
    getProvidersByPriority,
    invokeProviderGetPersonDetail,
} from '$lib/server/tasks/plugin-context.js';
import { fetchWithTimeout } from '$lib/server/utils/fetch-utils.js';
import { trackExternalCall } from '$lib/server/utils/external-request-counter.js';

const logger = Logger.for('PersonService');

const personCache = cacheManager.for(CACHE_NAMESPACES.personDetails);

// ---------------------------------------------------------------------------
// Internal types (mirrors person/[personId]/+server.ts)
// ---------------------------------------------------------------------------

interface TmdbCastCredit {
    id: number;
    title?: string;
    name?: string;
    character?: string;
    job?: string;
    media_type: 'movie' | 'tv';
    poster_path?: string | null;
    backdrop_path?: string | null;
    release_date?: string;
    first_air_date?: string;
    vote_average?: number;
    popularity?: number;
    overview?: string;
    genre_ids?: number[];
    episode_count?: number;
}

interface PersonMovieCredit {
    externalIds: { tmdb: string; internal?: string };
    mediaType: 'movie';
    title: string;
    character?: string;
    job?: string;
    posterPath?: string;
    year?: string;
    rating?: number;
    popularity?: number;
    overview?: string;
    isAvailable: boolean;
    canRequest: boolean;
}

interface PersonTvCredit {
    externalIds: { tmdb: string; internal?: string };
    // Canonical public discriminator: 'series' (replaces legacy 'tv'). The
    // person-details cache namespace was bumped alongside this flip to drop
    // any stale 'tv'-shaped entries.
    mediaType: 'series';
    title: string;
    character?: string;
    job?: string;
    posterPath?: string;
    year?: string;
    rating?: number;
    popularity?: number;
    overview?: string;
    isAvailable: boolean;
    canRequest: boolean;
    episodeCount?: number;
}

interface LibraryAvailabilityRow {
    tmdb_id: string;
    media_type: string;
    internal_id: string;
    is_available: boolean;
}

export interface PersonDetails {
    id: number;
    name: string;
    biography?: string;
    birthday?: string;
    deathday?: string;
    placeOfBirth?: string;
    profilePath?: string;
    knownForDepartment?: string;
    popularity?: number;
    movieCredits: PersonMovieCredit[];
    tvCredits: PersonTvCredit[];
}

type TmdbPersonDetails = {
    id: number;
    name: string;
    biography?: string;
    birthday?: string;
    deathday?: string;
    place_of_birth?: string;
    profile_path?: string;
    known_for_department?: string;
    popularity?: number;
};

type TmdbCreditsResponse = { cast?: TmdbCastCredit[]; crew?: TmdbCastCredit[] };

// ---------------------------------------------------------------------------
// Rate limiting — module-level, shared across all requests (legacy direct fetch)
// ---------------------------------------------------------------------------

let lastRequestTime = 0;
const MIN_REQUEST_INTERVAL = 100;

async function rateLimitedFetch(url: string, options: RequestInit = {}) {
    const now = Date.now();
    const timeSinceLastRequest = now - lastRequestTime;
    if (timeSinceLastRequest < MIN_REQUEST_INTERVAL) {
        await new Promise((resolve) =>
            setTimeout(resolve, MIN_REQUEST_INTERVAL - timeSinceLastRequest),
        );
    }
    lastRequestTime = Date.now();
    // C22 fix-plan finding scope: every caller of this helper targets a
    // fixed, non-admin-configurable public host (api.themoviedb.org) — see
    // docs/dev/eslint-exceptions.md.
    return trackExternalCall(url, () => fetchWithTimeout(url, options, 10_000), options.signal);
}

// ---------------------------------------------------------------------------
// Provider-based person fetch helpers
// ---------------------------------------------------------------------------

/**
 * Fetch person detail via the provider SDK. Tries each registered provider
 * in priority order, then falls back to the TMDB provider explicitly (in case
 * it is not highest-priority but is configured). Returns null when no provider
 * with `getPersonDetail` is available or all invocations fail.
 */
async function fetchPersonDetailViaProvider(
    personId: number,
): Promise<Record<string, unknown> | null> {
    const providers = getProvidersByPriority();
    for (const p of providers) {
        if (typeof p.getPersonDetail !== 'function') continue;
        const result = await invokeProviderGetPersonDetail(p.id, personId);
        if (result != null) return result as Record<string, unknown>;
    }
    return null;
}

/**
 * Normalize a raw person-detail result returned by a provider's
 * `getPersonDetail` into the `TmdbPersonDetails` + cast credits shape
 * consumed by the rest of `handlePersonGet`.
 *
 * TMDB's `detailPerson` appends `movie_credits` and `tv_credits` as separate
 * arrays (not the combined_credits endpoint). Both shapes are handled here so
 * a provider that happens to return `combined_credits.cast` also works.
 */
function normalizeProviderPersonResult(raw: Record<string, unknown>): {
    details: TmdbPersonDetails;
    credits: TmdbCreditsResponse;
} {
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    const num = (v: unknown): number | undefined =>
        typeof v === 'number' && isFinite(v) ? v : undefined;
    const arrOf = <T>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

    const details: TmdbPersonDetails = {
        id: typeof raw['id'] === 'number' ? raw['id'] : 0,
        name: str(raw['name']),
        biography: str(raw['biography']) || undefined,
        birthday: str(raw['birthday']) || undefined,
        deathday: str(raw['deathday']) || undefined,
        place_of_birth: str(raw['place_of_birth']) || undefined,
        profile_path: str(raw['profile_path']) || undefined,
        known_for_department: str(raw['known_for_department']) || undefined,
        popularity: num(raw['popularity']),
    };

    // Provider may return movie_credits + tv_credits (TMDB detailPerson path)
    // OR combined_credits (legacy direct-fetch path). Merge both into a single
    // cast array with a media_type discriminator, matching TmdbCreditsResponse.
    const movieCreditsRaw = raw['movie_credits'] as Record<string, unknown> | undefined;
    const tvCreditsRaw = raw['tv_credits'] as Record<string, unknown> | undefined;
    const combinedCreditsRaw = raw['combined_credits'] as Record<string, unknown> | undefined;

    const movieCast = arrOf<TmdbCastCredit>(movieCreditsRaw?.['cast']).map((c) => ({
        ...c,
        media_type: 'movie' as const,
    }));
    const tvCast = arrOf<TmdbCastCredit>(tvCreditsRaw?.['cast']).map((c) => ({
        ...c,
        media_type: 'tv' as const,
    }));
    const combinedCast = arrOf<TmdbCastCredit>(combinedCreditsRaw?.['cast']);

    const allCast = combinedCast.length > 0 ? combinedCast : [...movieCast, ...tvCast];
    const crew = [
        ...arrOf<TmdbCastCredit>(movieCreditsRaw?.['crew']).map((c) => ({
            ...c,
            media_type: 'movie' as const,
        })),
        ...arrOf<TmdbCastCredit>(tvCreditsRaw?.['crew']).map((c) => ({
            ...c,
            media_type: 'tv' as const,
        })),
    ];
    allCast.push(
        ...(arrOf<TmdbCastCredit>(combinedCreditsRaw?.['crew']).length
            ? arrOf<TmdbCastCredit>(combinedCreditsRaw?.['crew'])
            : crew),
    );

    return { details, credits: { cast: allCast } };
}

/** The biographical subset of a person, for surfaces that show one person. */
export interface PersonBio {
    name?: string;
    biography?: string;
    birthday?: string;
    deathday?: string;
    placeOfBirth?: string;
}

/**
 * Biography, birthday, deathday and birthplace of a provider person id: read
 * from the person-details cache when `handlePersonGet` filled it, otherwise
 * from the provider (itself cached by the plugin runtime). Never throws; null
 * when no provider knows the person.
 */
export async function fetchPersonBio(personId: number): Promise<PersonBio | null> {
    if (!Number.isInteger(personId) || personId <= 0) return null;
    try {
        const cached = await personCache.get<PersonDetails>(`v2:person-details:${personId}`);
        if (cached) {
            return {
                name: cached.name,
                biography: cached.biography,
                birthday: cached.birthday,
                deathday: cached.deathday,
                placeOfBirth: cached.placeOfBirth,
            };
        }
        const raw = await fetchPersonDetailViaProvider(personId);
        if (!raw) return null;
        const { details } = normalizeProviderPersonResult(raw);
        return {
            name: details.name || undefined,
            biography: details.biography,
            birthday: details.birthday,
            deathday: details.deathday,
            placeOfBirth: details.place_of_birth,
        };
    } catch (error) {
        logger.debug('Person bio lookup failed', { personId, error: String(error) });
        return null;
    }
}

// ---------------------------------------------------------------------------
// Library access filter
// ---------------------------------------------------------------------------

/**
 * Resolve the media access boundary for a person request.
 *
 * Fail-closed on every path where the boundary cannot be established:
 * - no user (the route ran without auth, or auth left `locals.user` unset)
 * - no database (the library-group / age lookup cannot run)
 * - the lookup throws
 *
 * The previous code expressed the no-user case as
 * `unauthenticatedSearchAccessContext()`, whose library axis is WIDE OPEN
 * (`deniedGroupIds: null`) and whose closure came entirely from the fake
 * `maxAgeRating: -1` age predicate. `denyAllAccess()` is the same outcome
 * (no credit keeps its internal UUID) stated directly on both axes.
 */
export async function resolvePersonAccessBoundary(
    user: UserContext | undefined,
): Promise<MediaAccessBoundary> {
    if (!user) return denyAllAccess();
    const sql = await aiDbService.getSql();
    if (!sql) return denyAllAccess();
    try {
        return searchAccessBoundary(await buildSearchAccessContext(sql, user));
    } catch (error) {
        logger.warn(
            'Failed to build person access boundary, denying all',
            { username: user.username },
            error as Error,
        );
        return denyAllAccess();
    }
}

/**
 * Strip internal UUIDs and mark isAvailable=false for credits whose media
 * item is not accessible under `boundary` (library group + age gate).
 *
 * The boundary is REQUIRED. The person-details cache is deliberately
 * user-agnostic — it stores the base payload WITH internal UUIDs and this
 * post-read pass is the only thing standing between a cache hit and internal
 * UUIDs for media the caller may not see. There is no permissive default here
 * precisely because omitting one would be invisible.
 */
export async function applyLibraryAccessFilter(
    details: PersonDetails,
    boundary: MediaAccessBoundary,
): Promise<PersonDetails> {
    let availability = new Map<string, boolean>();
    const stripInaccessible = (accessible: ReadonlySet<string>): PersonDetails => {
        const filterCredit = <T extends PersonMovieCredit | PersonTvCredit>(credit: T): T => {
            const internalId = getExternalIdFor(credit.externalIds, 'internal');
            if (!internalId) return credit;
            if (accessible.has(internalId)) {
                const isAvailable = availability.get(internalId) ?? false;
                return { ...credit, isAvailable, canRequest: !isAvailable };
            }
            // eslint-disable-next-line callback-safety/no-direct-external-id-access
            const { internal: _stripped, ...remainingIds } = credit.externalIds;
            return { ...credit, externalIds: remainingIds, isAvailable: false, canRequest: true };
        };
        return {
            ...details,
            movieCredits: details.movieCredits.map(filterCredit),
            tvCredits: details.tvCredits.map(filterCredit),
        };
    };

    // denyAll is checked FIRST so it can never fall through to the
    // unrestricted short-circuit below. No database round trip needed.
    if (deniesEverything(boundary)) return stripInaccessible(new Set());

    const allInternalIds = [
        ...details.movieCredits
            .map((c) => getExternalIdFor(c.externalIds, 'internal'))
            .filter((id): id is string => !!id),
        ...details.tvCredits
            .map((c) => getExternalIdFor(c.externalIds, 'internal'))
            .filter((id): id is string => !!id),
    ];

    if (allInternalIds.length === 0) return details;

    const sql = await aiDbService.getSql();
    // Fail CLOSED. This used to `return details` — handing back every internal
    // UUID in the cached payload whenever the database was unavailable, i.e.
    // exactly when enforcement was impossible.
    if (!sql) return stripInaccessible(new Set());

    // Person metadata is cached for a day. File availability must be read at
    // response time even when the caller has unrestricted library access.
    availability = await batchGetAvailability(sql, allInternalIds);
    const accessible = isUnrestricted(boundary)
        ? new Set(allInternalIds)
        : await filterAccessibleMediaIds(sql, allInternalIds, boundary);
    return stripInaccessible(accessible);
}

// ---------------------------------------------------------------------------
// Core handler — called by both person/[personId] and people/[id] routes
// ---------------------------------------------------------------------------

/**
 * Handle GET /person/{personId} or GET /people/{id}.
 *
 * Reads `event.params.personId` (caller must remap `id` → `personId` for the
 * new route).  Auth has already been enforced by the caller (requireAuth or
 * mount(def, {auth: user})).
 *
 * `boundary` is REQUIRED and must be built by the caller, normally via
 * {@link resolvePersonAccessBoundary}. It is not derived from `event.locals`
 * here so that "which access boundary does this endpoint apply" is answerable
 * by reading the def, and so a def that serves a non-user principal has to
 * make its choice explicit rather than inheriting a permissive default.
 */
export async function handlePersonGet(
    event: RequestEvent,
    boundary: MediaAccessBoundary,
    surface: ApiSurface = 'v1',
): Promise<Response> {
    const personId = event.params.personId ?? '';

    const parsed = parsePersonHandle(personId);
    if (!parsed.ok)
        return ApiProblem.validationFailed([
            { field: 'id', message: 'Use a positive TMDB person ID or tmdb:<id>' },
        ]);
    const id = parsed.numericId;
    const libraryOnly =
        !isUnavailableMediaVisible() || event.url?.searchParams.get('libraryOnly') === 'true';

    // Check cache — stores base enriched data with internal UUIDs; access
    // filter runs per-user after cache read.
    try {
        const cached = await personCache.get<PersonDetails>(`v2:person-details:${id}`);
        if (cached) {
            logger.debug('Person cache hit', { personId: id });
            const filtered = await applyLibraryAccessFilter(cached, boundary);
            const imageSql = await aiDbService.getSql();
            if (!imageSql) return ApiProblem.dependencyUnavailable('Database unavailable');
            return typedJson(PersonDetailResponseSchema, {
                ...toPersonResponse(filtered, surface, libraryOnly),
                images: await resolvePersonImageSet(
                    imageSql,
                    surface,
                    String(id),
                    filtered.profilePath,
                ),
            });
        }
    } catch (error) {
        logger.warn('Cache read error', { personId: id }, error as Error);
    }

    try {
        // Attempt person fetch via the provider SDK (highest-priority provider
        // that declares getPersonDetail, with TMDB as fallback). Only fall
        // through to the legacy direct-TMDB path when no provider is available.
        let details: TmdbPersonDetails;
        let credits: TmdbCreditsResponse;

        const providerResult = await fetchPersonDetailViaProvider(id);
        if (providerResult != null) {
            ({ details, credits } = normalizeProviderPersonResult(providerResult));
        } else {
            // Legacy direct-TMDB fallback: requires TMDB_API_KEY.
            const TMDB_API_KEY = config.TMDB_API_KEY;
            if (!TMDB_API_KEY) {
                return ApiResponses.error(
                    'Person detail unavailable: no configured provider supports person lookup',
                    undefined,
                    500,
                );
            }

            const jsonHeaders = { 'Content-Type': 'application/json' };
            const detailsRequest = tmdbAuthorizedRequest(
                `https://api.themoviedb.org/3/person/${id}`,
                TMDB_API_KEY,
                jsonHeaders,
            );
            const creditsRequest = tmdbAuthorizedRequest(
                `https://api.themoviedb.org/3/person/${id}/combined_credits`,
                TMDB_API_KEY,
                jsonHeaders,
            );
            const [detailsResponse, creditsResponse] = await Promise.all([
                rateLimitedFetch(detailsRequest.url, { headers: detailsRequest.headers }),
                rateLimitedFetch(creditsRequest.url, { headers: creditsRequest.headers }),
            ]);

            if (!detailsResponse.ok) {
                if (detailsResponse.status === 404) {
                    return ApiResponses.notFound('Person');
                }
                return ApiResponses.error(
                    'Failed to fetch person details',
                    undefined,
                    detailsResponse.status,
                );
            }

            details = (await detailsResponse.json()) as TmdbPersonDetails;
            credits = creditsResponse.ok
                ? ((await creditsResponse.json()) as TmdbCreditsResponse)
                : { cast: [] };
        }

        const movieCredits: PersonMovieCredit[] = [...(credits.cast ?? []), ...(credits.crew ?? [])]
            .filter(
                (c: TmdbCastCredit) =>
                    isMovie(c.media_type) && Number.isSafeInteger(c.id) && c.id > 0,
            )
            .map((c: TmdbCastCredit) => ({
                externalIds: { tmdb: String(c.id) },
                mediaType: 'movie' as const,
                title: c.title ?? '',
                character: c.character,
                job: c.job,
                posterPath: c.poster_path ?? undefined,
                year: c.release_date?.substring(0, 4),
                rating: c.vote_average,
                popularity: c.popularity,
                overview: c.overview,
                isAvailable: false,
                canRequest: true,
            }))
            .sort(
                (a: PersonMovieCredit, b: PersonMovieCredit) =>
                    (b.popularity ?? 0) - (a.popularity ?? 0),
            );

        const tvCredits: PersonTvCredit[] = [...(credits.cast ?? []), ...(credits.crew ?? [])]
            .filter(
                (c: TmdbCastCredit) =>
                    isSeries(c.media_type) && Number.isSafeInteger(c.id) && c.id > 0,
            )
            .map((c: TmdbCastCredit) => ({
                externalIds: { tmdb: String(c.id) },
                mediaType: 'series' as const,
                title: c.name ?? '',
                character: c.character,
                job: c.job,
                posterPath: c.poster_path ?? undefined,
                year: c.first_air_date?.substring(0, 4),
                rating: c.vote_average,
                popularity: c.popularity,
                overview: c.overview,
                isAvailable: false,
                canRequest: true,
                episodeCount: c.episode_count,
            }))
            .sort(
                (a: PersonTvCredit, b: PersonTvCredit) => (b.popularity ?? 0) - (a.popularity ?? 0),
            );

        // Enrich with library availability + internal UUIDs
        try {
            const sql = await aiDbService.getSql();
            if (sql) {
                const allTmdbIds = [
                    ...new Set([
                        ...movieCredits.map((c) => getExternalIdFor(c.externalIds, 'tmdb') ?? ''),
                        ...tvCredits.map((c) => getExternalIdFor(c.externalIds, 'tmdb') ?? ''),
                    ]),
                ].filter(Boolean);

                if (allTmdbIds.length > 0) {
                    // Deliberately NOT access-filtered. The payload this builds
                    // is written to the user-agnostic `person-details-v2` cache
                    // and served to every caller; folding one caller's boundary
                    // in here would bake their restrictions into everyone else's
                    // cache entry. Enforcement is the applyLibraryAccessFilter
                    // post-pass, which runs per-request on BOTH the cache-hit
                    // and the fresh-fetch path.
                    const rows = await sql<LibraryAvailabilityRow[]>`
						SELECT DISTINCT ON (ei.external_id, mi.media_type)
							ei.external_id AS tmdb_id,
							mi.media_type,
							mi.id AS internal_id,
							${isAvailableExpr(sql)} AS is_available
						FROM external_ids ei
						JOIN media_items mi ON mi.id = ei.media_id
						WHERE ei.provider = 'tmdb'
						  AND ei.external_id = ANY(${allTmdbIds}::text[])
						  AND mi.status = 'active'
						  AND mi.media_type IN ('movie', 'tv')
						ORDER BY ei.external_id, mi.media_type, mi.has_files DESC NULLS LAST, mi.id
					`;

                    const availMap = new Map<
                        string,
                        { internalId: string; isAvailable: boolean }
                    >();
                    for (const row of rows) {
                        availMap.set(`${row.tmdb_id}:${row.media_type}`, {
                            internalId: row.internal_id,
                            isAvailable: row.is_available,
                        });
                    }

                    for (const credit of movieCredits) {
                        const tmdbId = getExternalIdFor(credit.externalIds, 'tmdb');
                        const match = tmdbId ? availMap.get(`${tmdbId}:movie`) : undefined;
                        if (match) {
                            credit.externalIds = {
                                ...credit.externalIds,
                                internal: match.internalId,
                            };
                            credit.isAvailable = match.isAvailable;
                            credit.canRequest = !match.isAvailable;
                        }
                    }
                    for (const credit of tvCredits) {
                        const tmdbId = getExternalIdFor(credit.externalIds, 'tmdb');
                        const match = tmdbId ? availMap.get(`${tmdbId}:tv`) : undefined;
                        if (match) {
                            credit.externalIds = {
                                ...credit.externalIds,
                                internal: match.internalId,
                            };
                            credit.isAvailable = match.isAvailable;
                            credit.canRequest = !match.isAvailable;
                        }
                    }

                    movieCredits.sort(
                        (a, b) =>
                            Number(b.isAvailable) - Number(a.isAvailable) ||
                            (b.popularity ?? 0) - (a.popularity ?? 0),
                    );
                    tvCredits.sort(
                        (a, b) =>
                            Number(b.isAvailable) - Number(a.isAvailable) ||
                            (b.popularity ?? 0) - (a.popularity ?? 0),
                    );
                }
            }
        } catch (err) {
            logger.warn(
                'Library availability lookup failed, using defaults',
                { personId: id },
                err as Error,
            );
        }

        const personDetails: PersonDetails = {
            id,
            name: details.name,
            biography: details.biography ?? undefined,
            birthday: details.birthday ?? undefined,
            deathday: details.deathday ?? undefined,
            placeOfBirth: details.place_of_birth ?? undefined,
            profilePath: details.profile_path ?? undefined,
            knownForDepartment: details.known_for_department ?? undefined,
            popularity: details.popularity ?? undefined,
            movieCredits,
            tvCredits,
        };

        try {
            await personCache.set(`v2:person-details:${id}`, personDetails);
        } catch (error) {
            logger.warn('Cache write error', { personId: id }, error as Error);
        }

        const filtered = await applyLibraryAccessFilter(personDetails, boundary);
        const imageSql = await aiDbService.getSql();
        if (!imageSql) return ApiProblem.dependencyUnavailable('Database unavailable');
        return typedJson(PersonDetailResponseSchema, {
            ...toPersonResponse(filtered, surface, libraryOnly),
            images: await resolvePersonImageSet(
                imageSql,
                surface,
                String(id),
                filtered.profilePath,
            ),
        });
    } catch (error) {
        logger.error('Failed to fetch person details', error as Error, { personId: id });
        return ApiResponses.error('Failed to fetch person details', error as Error, 500);
    }
}

/** Map the private cache payload only after its library boundary has been applied. */
export function toPersonResponse(
    details: PersonDetails,
    surface: ApiSurface = 'v1',
    libraryOnly = false,
): PersonDetailResponse {
    const mapCredit = (credit: PersonMovieCredit | PersonTvCredit): PersonCredit => {
        const catalogId = getExternalIdFor(credit.externalIds, 'internal') ?? null;
        const tmdb = getExternalIdFor(credit.externalIds, 'tmdb');
        const providerId = `tmdb:${tmdb}:${credit.mediaType}`;
        const images: ImageSet = credit.posterPath
            ? buildImageSet(surface, {
                  poster: {
                      ownerId: providerId,
                      source: 'provider',
                      revision: credit.posterPath,
                  },
              })
            : {};
        // The provider path is already known: no second metadata request is needed.
        if (images.poster && credit.posterPath) {
            const posterPath = credit.posterPath;
            const withPath = (href: string): string =>
                `${href}&path=${encodeURIComponent(posterPath)}`;
            images.poster.href = withPath(images.poster.href);
            images.poster.variants = Object.fromEntries(
                Object.entries(images.poster.variants ?? {}).map(([k, v]) => [k, withPath(v)]),
            );
        }
        const year = credit.year ? Number(credit.year) : undefined;
        return {
            id: catalogId ?? providerId,
            catalogId,
            ids: tmdb ? { tmdb } : {},
            type: credit.mediaType,
            title: credit.title,
            images,
            character: credit.character,
            job: credit.job,
            episodeCount: 'episodeCount' in credit ? credit.episodeCount : undefined,
            year: year && Number.isInteger(year) ? year : undefined,
            rating: credit.rating,
            overview: credit.overview,
            availability: { isAvailable: credit.isAvailable, canRequest: credit.canRequest },
        };
    };
    const select = (credits: (PersonMovieCredit | PersonTvCredit)[]): PersonCredit[] =>
        credits
            // "Library only" means available (has files). An internal id alone
            // is not enough: file-less discovery rows carry one too.
            .filter((c) => !libraryOnly || c.isAvailable)
            .sort(
                (a, b) =>
                    Number(b.isAvailable) - Number(a.isAvailable) ||
                    (b.popularity ?? 0) - (a.popularity ?? 0),
            )
            .map(mapCredit);
    const movies = select(details.movieCredits),
        tv = select(details.tvCredits);
    return {
        id: formatPersonHandle(details.id),
        ids: { tmdb: String(details.id) },
        name: details.name,
        biography: details.biography,
        birthday: details.birthday,
        deathday: details.deathday,
        placeOfBirth: details.placeOfBirth,
        knownForDepartment: details.knownForDepartment,
        popularity: details.popularity,
        images: personImageSet(surface, formatPersonHandle(details.id), details.profilePath),
        movieCredits: movies.slice(0, 30),
        tvCredits: tv.slice(0, 30),
        creditsTruncated: movies.length > 30 || tv.length > 30,
    };
}
