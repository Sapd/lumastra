// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/admin/provider-search
 *
 * Searches enabled metadata provider plugins for a title.
 * Returns candidates from all available providers (TMDB, AniDB, etc.).
 *
 * Query params:
 *   q         — search query (required, min 2 chars). A TMDB or IMDb link/id
 *               (`themoviedb.org/movie/603`, `tmdb:603`, `tmdb:tv:1399`,
 *               `imdb.com/title/tt0133093`, `tt0133093`) is looked up directly
 *               instead of searched — the fastest fix for a title no search
 *               finds (raw release names, test files, foreign-only titles).
 *   mediaType — 'movie' | 'series' | 'any' (default: 'any')
 *
 * Auth: providers:admin. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import {
    getProvidersByPriority,
    invokeProviderDetail,
    invokeProviderResolveExternalId,
    invokeProviderSearch,
    isProviderConfigured,
} from '$lib/server/tasks/plugin-context.js';
import { normalizeDetail, normalizeSearchResult } from '$lib/server/providers/normalize.js';
import { encodeDetailId } from '$lib/server/providers/encode-id.js';
import type { MetadataCandidate } from '$lib/server/providers/types.js';
import {
    ProviderSearchResultSchema,
    ProviderSearchResponseSchema,
} from '$lib/schemas/api-admin-unmatched-responses.js';

// ---------------------------------------------------------------------------
// Request schema
// ---------------------------------------------------------------------------

const QuerySchema = z.object({
    q: z.string().max(200).optional(),
    mediaType: z.enum(['movie', 'series', 'any']).optional(),
});

type ProviderSearchResult = z.infer<typeof ProviderSearchResultSchema>;
type InvokeType = 'movie' | 'tv';

const TMDB_PROVIDER_ID = 'tmdb-metadata-provider';

type IdQuery = { kind: 'tmdb'; id: string; type?: InvokeType } | { kind: 'imdb'; id: string };

/** Recognise a pasted TMDB / IMDb link or id; null for an ordinary title search. */
function parseIdQuery(raw: string): IdQuery | null {
    const q = raw.trim();
    const tmdbUrl = /themoviedb\.org\/(movie|tv)\/(\d+)/i.exec(q);
    if (tmdbUrl) {
        return { kind: 'tmdb', type: tmdbUrl[1].toLowerCase() as InvokeType, id: tmdbUrl[2] };
    }
    const tmdbId = /^tmdb[:\s]+(?:(movie|tv|series)[:\s]+)?(\d+)$/i.exec(q);
    if (tmdbId) {
        const t = tmdbId[1]?.toLowerCase();
        return {
            kind: 'tmdb',
            type: t ? (t === 'movie' ? 'movie' : 'tv') : undefined,
            id: tmdbId[2],
        };
    }
    const imdb =
        /^(?:https?:\/\/)?(?:www\.|m\.)?imdb\.com\/title\/(tt\d{7,10})|^(tt\d{7,10})$/i.exec(q);
    if (imdb) return { kind: 'imdb', id: (imdb[1] ?? imdb[2]).toLowerCase() };
    return null;
}

/** Fetch one TMDB entry by id as a search result; null when it does not exist. */
async function tmdbById(id: string, type: InvokeType): Promise<ProviderSearchResult | null> {
    try {
        const raw = await invokeProviderDetail<unknown>(
            TMDB_PROVIDER_ID,
            encodeDetailId(TMDB_PROVIDER_ID, type, id),
        );
        const meta = normalizeDetail(TMDB_PROVIDER_ID, raw, type);
        if (!meta?.title) return null;
        return ProviderSearchResultSchema.parse({
            provider: 'tmdb',
            externalId: id,
            title: meta.title,
            year: meta.year,
            type: type === 'movie' ? 'movie' : 'series',
            overview: meta.overview,
            images: meta.posterUrl ? { poster: meta.posterUrl } : undefined,
        });
    } catch {
        // A 404 for this type is the normal "it's the other kind" answer.
        return null;
    }
}

async function lookupById(
    query: IdQuery,
    mediaTypeParam: 'movie' | 'tv' | 'any',
): Promise<ProviderSearchResult[]> {
    if (!(await isProviderConfigured(TMDB_PROVIDER_ID))) return [];
    const types: InvokeType[] =
        query.kind === 'tmdb' && query.type
            ? [query.type]
            : mediaTypeParam === 'any'
              ? ['movie', 'tv']
              : [mediaTypeParam];

    const found = await Promise.all(
        types.map(async (type) => {
            if (query.kind === 'tmdb') return tmdbById(query.id, type);
            const resolved = await invokeProviderResolveExternalId(
                TMDB_PROVIDER_ID,
                query.id,
                'imdb',
                type,
            );
            return resolved ? tmdbById(resolved.externalId, type) : null;
        }),
    );
    return found.filter((r): r is ProviderSearchResult => r !== null);
}

// ---------------------------------------------------------------------------
// def
// ---------------------------------------------------------------------------

const def = defineEndpoint({
    auth: { kind: 'scope', anyOf: ['providers:admin'] },
    visibility: 'internal',
    request: {
        query: QuerySchema,
    },
    handlers: {
        GET: async (event, ctx) => {
            const query = ctx.input!.query.q ?? '';
            // Accept both legacy 'tv' and canonical 'series'; treat as 'series' internally
            const rawMediaType = ctx.input!.query.mediaType ?? 'any';
            // Map canonical 'series' to the internal 'tv' invoke type
            const mediaTypeParam: 'movie' | 'tv' | 'any' =
                rawMediaType === 'series' ? 'tv' : rawMediaType;

            if (query.trim().length < 2) {
                return json(ProviderSearchResponseSchema.parse({ results: [], query }));
            }

            if (!['movie', 'tv', 'any'].includes(mediaTypeParam)) {
                return ApiProblem.validationFailed(`mediaType must be one of: movie, series, any`);
            }

            const idQuery = parseIdQuery(query);
            if (idQuery) {
                const results = await lookupById(idQuery, mediaTypeParam);
                return json(ProviderSearchResponseSchema.parse({ results, query }));
            }

            const providers = getProvidersByPriority();
            const results: ProviderSearchResult[] = [];

            await Promise.allSettled(
                providers.map(async (provider) => {
                    if (!(await isProviderConfigured(provider.id))) return;

                    const candidates = await (async (): Promise<MetadataCandidate[]> => {
                        if (mediaTypeParam === 'movie') {
                            const raw = await invokeProviderSearch(provider.id, {
                                type: 'movie',
                                query,
                            });
                            return raw
                                .map((r) => normalizeSearchResult(provider.id, r, 'movie'))
                                .filter((c): c is MetadataCandidate => c !== null);
                        }
                        if (mediaTypeParam === 'tv') {
                            const raw = await invokeProviderSearch(provider.id, {
                                type: 'tv',
                                query,
                            });
                            return raw
                                .map((r) => normalizeSearchResult(provider.id, r, 'tv'))
                                .filter((c): c is MetadataCandidate => c !== null);
                        }
                        // 'any' — search both, merge
                        const [movies, series] = await Promise.allSettled([
                            invokeProviderSearch(provider.id, { type: 'movie', query }),
                            invokeProviderSearch(provider.id, { type: 'tv', query }),
                        ]);
                        const movieCandidates =
                            movies.status === 'fulfilled'
                                ? movies.value
                                      .map((r) => normalizeSearchResult(provider.id, r, 'movie'))
                                      .filter((c): c is MetadataCandidate => c !== null)
                                : [];
                        const seriesCandidates =
                            series.status === 'fulfilled'
                                ? series.value
                                      .map((r) => normalizeSearchResult(provider.id, r, 'tv'))
                                      .filter((c): c is MetadataCandidate => c !== null)
                                : [];
                        return [...movieCandidates, ...seriesCandidates];
                    })();

                    for (const c of candidates) {
                        // Canonical discriminator: 'series' (not 'tv')
                        const type: 'movie' | 'series' =
                            c.mediaType === 'movie' ? 'movie' : 'series';
                        results.push(
                            ProviderSearchResultSchema.parse({
                                provider: c.provider,
                                externalId: c.externalId,
                                title: c.title,
                                year: c.year,
                                type,
                                overview: c.overview,
                                images: c.posterUrl ? { poster: c.posterUrl } : undefined,
                            }),
                        );
                    }
                }),
            );

            // Deduplicate by provider+externalId+type
            const seen = new Set<string>();
            const deduplicated = results.filter((r) => {
                const key = `${r.provider}:${r.externalId}:${r.type}`;
                if (seen.has(key)) return false;
                seen.add(key);
                return true;
            });

            return json(ProviderSearchResponseSchema.parse({ results: deduplicated, query }));
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
