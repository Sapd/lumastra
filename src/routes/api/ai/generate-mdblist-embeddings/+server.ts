// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * MDBList Embeddings API Endpoint (BullMQ)
 *
 * Manages MDBList embedding generation via BullMQ job queue.
 * Job processed by embedding-processor using EmbeddingOnlyGenerator.
 *
 * Extended handlers support:
 * - GET ?lists=true - Returns available MDBList lists
 * - POST action=preview - Preview embedding text for a sample item
 */

import { json } from '@sveltejs/kit';
import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { mount } from '$lib/server/api/mount.js';
import { CURATED_LISTS } from '$lib/server/ai/list-sync';
import { mdblistApi } from '$lib/server/services/mdblist-api';
import { tmdbApi } from '$lib/server/providers/implementations/tmdb/index.js';
import { type JellyseerrMovieData } from '$lib/server/ai/dual-embedding-generator';
import { createDiscoveryEmbeddingText } from '$lib/server/ai/embedding-text-formatter';
import { Logger } from '$lib/server/utils/logger';
import { generateMdblistEmbeddingsBodySchema } from '$lib/schemas/ai';
import { isRecord } from '$lib/utils/data-extraction';
import { orchestrator } from '$lib/server/tasks/orchestrator.js';
import { isMovie, isSeries } from '$lib/server/utils/media-types.js';
import { MDBListInfoSchema } from '$lib/schemas/admin-types';

const logger = Logger.for('MDBListEmbeddingsAPI');

const toNumber = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

const toString = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

const toBoolean = (value: unknown): boolean | undefined =>
    typeof value === 'boolean' ? value : undefined;

const toArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

// TMDB API response types for type-safe filtering/mapping
interface TMDBGenre {
    id: number;
    name: string;
}

interface TMDBCompany {
    id: number;
    name: string;
}

interface TMDBCountry {
    iso_3166_1: string;
    name: string;
}

interface TMDBKeyword {
    id: number;
    name: string;
}

interface TMDBNetwork {
    id: number;
    name: string;
}

interface TMDBCastMember {
    id: number;
    name: string;
    character?: string;
    order?: number;
    profile_path?: string;
}

interface TMDBCrewMember {
    id: number;
    name: string;
    job: string;
    department: string;
}

const MdblistListsResponseSchema = z.object({
    lists: z.array(MDBListInfoSchema),
    apiConfigured: z.boolean(),
});

const JobNameResponseSchema = z.object({ jobName: z.string() });

const TaskStartedResponseSchema = z.object({
    started: z.boolean(),
    jobId: z.string(),
});

const PreviewItemSchema = z.object({
    externalIds: z.record(z.string(), z.string()),
    title: z.string(),
    mediaType: z.string(),
    releaseDate: z.string().optional(),
    genres: z.array(z.string()).optional(),
    voteAverage: z.number().optional(),
    overview: z.string().optional(),
    cast: z.array(z.string()).optional(),
    directors: z.array(z.string()).optional(),
    mdblist_score: z.number().optional(),
    letterboxd_rating: z.number().optional(),
    rt_rating: z.number().optional(),
    rt_audience_score: z.number().optional(),
    trakt_score: z.number().optional(),
    keywords: z.array(z.string()).optional(),
    mdblist_keywords: z.array(z.string()).optional(),
});

const PreviewResponseSchema = z.object({
    success: z.boolean(),
    list: z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
    }),
    item: PreviewItemSchema,
    embeddingText: z.string(),
    embeddingTextLength: z.number(),
});

async function handlePreview(listId?: string): Promise<Response> {
    if (!mdblistApi.isAvailable()) {
        return ApiProblem.validationFailed('MDBList API key not configured');
    }

    try {
        // Find the list config
        const listConfig = listId
            ? CURATED_LISTS.find((l) => l.list_id === listId)
            : CURATED_LISTS[0]; // Default to first list

        if (!listConfig) {
            return ApiProblem.notFound(
                `List not found: ${listId}. Available: ${CURATED_LISTS.map((l) => l.list_id).join(', ')}`,
            );
        }

        logger.info('Fetching preview from list', {
            listId: listConfig.list_id,
            path: listConfig.list_path,
        });

        // Fetch first few items from the list
        const items = await mdblistApi.getList(listConfig.list_path, 3);

        if (!items || items.length === 0) {
            return ApiProblem.notFound(`List ${listConfig.list_id} is empty`);
        }

        // Get the first item with a valid TMDB ID
        const firstItem = items.find((item) => {
            if (!isRecord(item)) return false;
            const id = toNumber(item.id);
            return typeof id === 'number' && id > 0;
        });
        if (!firstItem) {
            return ApiProblem.notFound('No items with valid TMDB ID found in list');
        }

        const tmdbId = toNumber(firstItem.id) ?? 0;
        const firstItemTitle = toString(firstItem.title);
        // Normalise rather than assert — the sibling isMovie()/isSeries() calls
        // below accept 'series' as well as 'tv', so the raw value may be either.
        const mediaType: 'movie' | 'tv' = isMovie(listConfig.media_type) ? 'movie' : 'tv';

        logger.info('Fetching TMDB details for preview', {
            tmdbId,
            mediaType,
            title: firstItemTitle,
        });

        // Fetch detailed TMDB data
        const appendToResponse = isMovie(listConfig.media_type)
            ? ['external_ids', 'keywords', 'release_dates', 'credits']
            : ['external_ids', 'keywords', 'content_ratings', 'credits'];

        if (!tmdbApi.isAvailable()) {
            return ApiProblem.dependencyUnavailable('TMDB API is currently unavailable');
        }

        const detailData: unknown = isMovie(listConfig.media_type)
            ? await tmdbApi.getMovieDetailsWithAppends(tmdbId, appendToResponse)
            : await tmdbApi.getTVDetailsWithAppends(tmdbId, appendToResponse);

        if (!detailData) {
            return ApiProblem.notFound(`TMDB data for ID ${tmdbId}`);
        }

        const detailRecord = isRecord(detailData) ? detailData : {};
        const externalIds = isRecord(detailRecord.external_ids)
            ? detailRecord.external_ids
            : undefined;
        const keywordsContainer = isRecord(detailRecord.keywords)
            ? detailRecord.keywords
            : undefined;
        const credits = isRecord(detailRecord.credits) ? detailRecord.credits : undefined;

        const genresRaw = toArray(detailRecord.genres);
        const productionCompaniesRaw = toArray(detailRecord.production_companies);
        const productionCountriesRaw = toArray(detailRecord.production_countries);
        const networksRaw = toArray(detailRecord.networks);
        const castRaw = credits ? toArray(credits.cast) : [];
        const crewRaw = credits ? toArray(credits.crew) : [];

        // Build JellyseerrMovieData structure (same as in generator)
        // NOTE: Internal processing only - tmdbId is transformed to externalIds before returning to client
        const item: JellyseerrMovieData = {
            id: tmdbId,
            tmdbId: tmdbId,
            title:
                toString(detailRecord.title) ||
                toString(detailRecord.name) ||
                firstItemTitle ||
                'Unknown',
            overview: toString(detailRecord.overview) || '',
            releaseDate:
                toString(detailRecord.release_date) || toString(detailRecord.first_air_date) || '',
            genres: genresRaw
                .map((g) => {
                    if (!isRecord(g)) return null;
                    const id = toNumber(g.id);
                    const name = toString(g.name);
                    if (typeof id !== 'number' || !name) return null;
                    return { id, name };
                })
                .filter((g): g is TMDBGenre => g !== null),
            voteAverage: toNumber(detailRecord.vote_average) ?? 0,
            voteCount: toNumber(detailRecord.vote_count) ?? 0,
            popularity: toNumber(detailRecord.popularity) ?? 0,
            mediaType: mediaType,
            originalLanguage: toString(detailRecord.original_language) || 'en',
            originalTitle:
                toString(detailRecord.original_title) ||
                toString(detailRecord.original_name) ||
                firstItemTitle ||
                'Unknown',
            adult: toBoolean(detailRecord.adult) ?? false,
            runtime: toNumber(detailRecord.runtime),
        };

        // Extract IMDB ID
        if (externalIds && typeof externalIds.imdb_id === 'string') {
            (item as JellyseerrMovieData & { imdb_id?: string }).imdb_id = externalIds.imdb_id;
        }

        // Production metadata
        if (productionCompaniesRaw.length > 0) {
            item.productionCompanies = productionCompaniesRaw
                .map((c) => {
                    if (!isRecord(c)) return null;
                    const id = toNumber(c.id);
                    const name = toString(c.name);
                    if (typeof id !== 'number' || !name) return null;
                    return { id, name };
                })
                .filter((c): c is TMDBCompany => c !== null);
        }

        if (productionCountriesRaw.length > 0) {
            item.productionCountries = productionCountriesRaw
                .map((c) => {
                    if (!isRecord(c)) return null;
                    const iso = toString(c.iso_3166_1);
                    const name = toString(c.name);
                    if (!iso || !name) return null;
                    return { iso_3166_1: iso, name };
                })
                .filter((c): c is TMDBCountry => c !== null);
        }

        // Keywords
        if (keywordsContainer) {
            const keywordsRaw = toArray(keywordsContainer.keywords).length
                ? toArray(keywordsContainer.keywords)
                : toArray(keywordsContainer.results);
            if (keywordsRaw.length > 0) {
                item.keywords = keywordsRaw
                    .map((k) => {
                        if (!isRecord(k)) return null;
                        const id = toNumber(k.id);
                        const name = toString(k.name);
                        if (typeof id !== 'number' || !name) return null;
                        return { id, name };
                    })
                    .filter((k): k is TMDBKeyword => k !== null);
            }
        }

        // Networks for TV
        if (networksRaw.length > 0) {
            item.networks = networksRaw
                .map((n) => {
                    if (!isRecord(n)) return null;
                    const id = toNumber(n.id);
                    const name = toString(n.name);
                    if (typeof id !== 'number' || !name) return null;
                    return { id, name };
                })
                .filter((n): n is TMDBNetwork => n !== null);
        }

        // Cast and crew
        if (castRaw.length > 0) {
            const castItems: TMDBCastMember[] = [];
            for (const p of castRaw) {
                if (!isRecord(p)) continue;
                const id = toNumber(p.id);
                const name = toString(p.name);
                if (typeof id !== 'number' || !name) continue;
                castItems.push({
                    id,
                    name,
                    character: toString(p.character),
                    order: toNumber(p.order),
                    profile_path: toString(p.profile_path),
                });
                if (castItems.length >= 10) break;
            }
            item.cast = castItems;
        }

        if (crewRaw.length > 0) {
            const importantJobs = [
                'Director',
                'Producer',
                'Executive Producer',
                'Writer',
                'Screenplay',
                'Cinematographer',
            ];
            const crewItems: TMDBCrewMember[] = [];
            for (const p of crewRaw) {
                if (!isRecord(p)) continue;
                const id = toNumber(p.id);
                const name = toString(p.name);
                const job = toString(p.job);
                if (typeof id !== 'number' || !name || !job) continue;
                if (!importantJobs.includes(job)) continue;
                crewItems.push({
                    id,
                    name,
                    job,
                    department: toString(p.department) || '',
                });
            }
            item.crew = crewItems;
        }

        // Fetch MDBList enrichment data
        try {
            const mdbData = await mdblistApi.getByTmdbId(
                tmdbId,
                isSeries(listConfig.media_type) ? 'show' : 'movie',
            );
            if (mdbData) {
                item.mdblist_score = mdbData.score ?? undefined;
                item.letterboxd_rating =
                    mdblistApi.extractRating(mdbData, 'letterboxd')?.value ?? undefined;
                item.rt_rating = mdblistApi.extractRating(mdbData, 'tomatoes')?.value ?? undefined;
                item.rt_audience_score =
                    mdblistApi.extractRating(mdbData, 'popcorn')?.value ?? undefined;
                item.trakt_score = mdblistApi.extractRating(mdbData, 'trakt')?.value ?? undefined;

                if (mdbData.keywords?.length) {
                    item.mdblist_keywords = mdbData.keywords.map((k) => k.name);
                }
            }
        } catch (error) {
            logger.debug('Failed to fetch MDBList data for preview', {
                tmdbId,
                error: (error as Error).message,
            });
        }

        // Generate embedding text
        const embeddingText = createDiscoveryEmbeddingText(item);

        return json(
            PreviewResponseSchema.parse({
                success: true,
                list: {
                    id: listConfig.list_id,
                    name: listConfig.name,
                    type: listConfig.media_type,
                },
                item: {
                    // TMDB API response — tmdbId comes from MDBList item.id which always references a TMDB ID
                    externalIds: { tmdb: String(tmdbId) },
                    title: item.title,
                    mediaType: item.mediaType,
                    releaseDate: item.releaseDate,
                    genres: item.genres?.map((g) => g.name),
                    voteAverage: item.voteAverage,
                    overview:
                        item.overview?.substring(0, 200) +
                        (item.overview && item.overview.length > 200 ? '...' : ''),
                    cast: item.cast?.slice(0, 5).map((c) => c.name),
                    directors: item.crew?.filter((c) => c.job === 'Director').map((c) => c.name),
                    mdblist_score: item.mdblist_score,
                    letterboxd_rating: item.letterboxd_rating,
                    rt_rating: item.rt_rating,
                    rt_audience_score: item.rt_audience_score,
                    trakt_score: item.trakt_score,
                    keywords: item.keywords?.slice(0, 10).map((k) => k.name),
                    mdblist_keywords: item.mdblist_keywords?.slice(0, 10),
                },
                embeddingText,
                embeddingTextLength: embeddingText.length,
            }),
        );
    } catch (error) {
        logger.error('Preview generation failed', error as Error);
        return ApiProblem.dependencyUnavailable('Failed to generate preview from external APIs');
    }
}

const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        body: generateMdblistEmbeddingsBodySchema,
        query: z.object({
            lists: z.string().optional(),
        }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            // Return available lists if requested
            if (ctx.input?.query?.lists === 'true') {
                return json(
                    MdblistListsResponseSchema.parse({
                        lists: CURATED_LISTS.map((l) => ({
                            id: l.list_id,
                            name: l.name,
                            path: l.list_path,
                            type: l.media_type,
                        })),
                        apiConfigured: mdblistApi.isAvailable(),
                    }),
                );
            }

            // Default: return task name
            return json(JobNameResponseSchema.parse({ jobName: 'discovery-embeddings' }));
        },

        POST: async (event, ctx) => {
            const { action, listId } = ctx.input!.body;

            // Handle preview action
            if (action === 'preview') {
                return await handlePreview(listId);
            }

            // Enqueue discovery-embeddings with DB-driven options.
            // MDBList-specific fields (lists, itemsPerList, etc.) are ignored —
            // the new generator reads from the database, not the MDBList API.
            const result = await orchestrator.startRun(
                'discovery-embeddings',
                {
                    force: ctx.input!.body.skipExisting === false,
                },
                {
                    trigger: {
                        kind: 'manual',
                        by: event.locals.user?.username,
                        sourceRoute: 'ai/generate-mdblist-embeddings',
                    },
                },
            );

            return json(
                TaskStartedResponseSchema.parse({
                    started: true,
                    jobId: result.runId,
                }),
            );
        },
    },
});

const { GET, POST } = mount(def, { surface: 'internal' });
export { GET, POST };
