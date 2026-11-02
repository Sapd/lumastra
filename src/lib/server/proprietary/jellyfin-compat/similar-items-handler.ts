// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * GET /Items/{itemId}/Similar and its Jellyfin aliases /Movies/{itemId}/Similar,
 * /Shows/{itemId}/Similar and /Trailers/{itemId}/Similar (LibraryController.
 * GetSimilarItems answers all of them with one action). Album and artist
 * similarity are separate routes (music).
 */

import { json, type RequestEvent } from '@sveltejs/kit';
import type postgres from 'postgres';
import {
    serializeBaseItems,
    type MediaItemForSerialization,
} from '$lib/server/proprietary/jellyfin-compat/serializers/base-item';
import { applyJellyfinContentLanguage } from '$lib/server/proprietary/jellyfin-compat/content-language';
import { applyFolderUserData } from '$lib/server/proprietary/jellyfin-compat/folder-user-data';
import { buildJellyfinAccessContext } from '$lib/server/proprietary/jellyfin-compat/access-context';
import { getDb } from '$lib/server/database';
import { EMBEDDING_SOURCE } from '$lib/server/utils/embedding-source';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { getParam, getJfToken } from '$lib/server/proprietary/jellyfin-compat/utils';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser.js';
import {
    enrichItemsWithMediaSources,
    dropFilelessPlayables,
} from '$lib/server/proprietary/jellyfin-compat/media-source-enrichment';
import { enrichItemsWithProviderIds } from '$lib/server/proprietary/jellyfin-compat/provider-ids-enrichment';
import { enrichItemsWithMusicArtists } from '$lib/server/proprietary/jellyfin-compat/music-artists-enrichment';
import { enrichItemsWithImages } from '$lib/server/proprietary/jellyfin-compat/image-enrichment';
import {
    parseDtoOptions,
    shapeItemsResponse,
} from '$lib/server/proprietary/jellyfin-compat/dto-options';
import { buildMetadataLateralJoinFragment } from '$lib/server/database/queries/builders/provider-metadata.builder';
import {
    getDeniedLibraryGroups,
    toLibraryAccessUser,
} from '$lib/server/cache/library-group-permissions-cache';
import { buildLibraryAccessFilter } from '$lib/server/database/queries/builders/library-access.builder';
import { parseEmbedding } from '$lib/server/utils/embedding-utils';
import { findSimilarMediaDual } from '$lib/server/database/queries/suggestion-search.queries';
import { restrictedAccess } from '$lib/server/database/queries/builders/media-access-boundary';
import { config } from '$lib/server/config';
import { isEpisode, isSeries } from '$lib/server/utils/media-types.js';
import { getMediaTypeAndParent } from '$lib/server/database/queries/media-extras.queries';

const logger = Logger.for('JellyfinCompat:SimilarItems');

/**
 * `itemId` defaults to the route's `[itemId]`; /Shows/{id}/Similar lives under
 * `[seriesId]` (a sibling of Shows/{seriesId}/Episodes) and passes it explicitly.
 */
export async function handleSimilarItems(
    event: RequestEvent,
    routeItemId: string | undefined = event.params.itemId,
): Promise<Response> {
    const { locals, url } = event;
    const sql = getDb();
    if (!sql) {
        return ApiResponses.error('Database unavailable');
    }

    if (!routeItemId) {
        return ApiResponses.badRequest('Item ID is required');
    }
    if (!isUuid(routeItemId)) {
        return ApiResponses.notFound('Item not found');
    }
    // Dashless Jellyfin ids must compare equal to media_uuid below.
    let itemId = normalizeUuid(routeItemId);

    // A local trailer or other extra (/Trailers/{id}/Similar) has no embedding
    // of its own: answer for the movie/series it belongs to. Resolve that
    // BEFORE gating, and gate only the parent (as preview-session.ts does):
    // an extra's own files may carry library_group_id NULL (world-readable to
    // the library gate) and it has no age_rating. An orphaned extra is 404.
    const typeAndParent = await getMediaTypeAndParent(sql, itemId);
    if (typeAndParent?.media_type === 'extra') {
        if (!typeAndParent.parent_id) {
            return ApiResponses.notFound('Item not found');
        }
        itemId = typeAndParent.parent_id;
    }

    if (!(await checkMediaAccess(sql, itemId, locals.user))) {
        return ApiResponses.notFound('Item not found');
    }

    const limit = Math.min(Math.max(1, parseInt(getParam(url, 'Limit') ?? '12', 10) || 12), 50);

    try {
        const denied = await getDeniedLibraryGroups(sql, toLibraryAccessUser(locals.user));

        // Fetch source item with embeddings
        const sourceRows = await sql<
            {
                id: string;
                media_type: string;
                library_embedding: unknown;
                discovery_embedding: unknown;
            }[]
        >`
            SELECT
                mi.id,
                mi.media_type,
                lib_emb.embedding as library_embedding,
                disc_emb.embedding as discovery_embedding
            FROM media_items mi
            LEFT JOIN media_embeddings lib_emb ON lib_emb.media_id = mi.id AND lib_emb.source = ${EMBEDDING_SOURCE.LIBRARY}
            LEFT JOIN media_embeddings disc_emb ON disc_emb.media_id = mi.id AND disc_emb.source = ${EMBEDDING_SOURCE.DISCOVERY}
            WHERE mi.id = ${itemId}::uuid
              AND mi.status = 'active'
        `;

        if (sourceRows.length === 0) {
            return ApiResponses.notFound('Item not found');
        }

        const source = sourceRows[0];
        // Jellyfin answers an empty result for episodes.
        if (isEpisode(source.media_type)) {
            return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
        }
        const mediaType = isSeries(source.media_type) ? ('tv' as const) : ('movie' as const);

        // Get best available embedding; fall back to genre-based if none
        const embedding =
            parseEmbedding(source.library_embedding as number[] | string | null) ??
            parseEmbedding(source.discovery_embedding as number[] | string | null);

        let similarIds: string[] = [];

        if (embedding && embedding.length > 0) {
            const similar = await findSimilarMediaDual(sql, embedding, {
                limit: limit + 1,
                mediaTypes: [mediaType],
                // Library axis from the real user; age axis deliberately `any`
                // because this route age-gates its own hydration query inline
                // further down (`ageFilterFragment`). That inline gate keys off
                // `isAgeRestricted` and a `maxAgeRating ?? 0` default, which is
                // NOT the same predicate a boundary-derived age scope would
                // emit — enabling both would change which rows an age-limited
                // caller sees. Built directly from the `denied` list so the
                // mapping is provably the one the old `deniedGroupIds` encoded.
                access: restrictedAccess({
                    deniedGroupIds: denied ?? [],
                    maxAgeRating: null,
                    allowUnrated: false,
                }),
            });
            similarIds = similar
                .filter((r) => r.media_uuid !== itemId)
                .slice(0, limit)
                .map((r) => r.media_uuid);
        }

        // Age-gate the similar list inline: findSimilarMediaDual and the
        // fallback only filter by library_group_id, not by age_rating. For
        // an age-restricted user we drop rows whose media_items.age_rating
        // exceeds maxAgeRating (and unrated items when the global flag
        // forbids them). Folded into the main fetch as an AND clause so we
        // still do a single query.
        const isAgeRestricted = locals.user?.isAgeRestricted ?? false;
        const maxAge = locals.user?.maxAgeRating ?? 0;
        const allowUnrated = config.UNRATED_CONTENT_VISIBLE;
        const ageFilterFragment = isAgeRestricted
            ? sql`AND (
                    (mi.age_rating IS NULL AND ${allowUnrated}::boolean)
                    OR mi.age_rating <= ${maxAge}
                )`
            : sql``;

        // Fallback: same media_type, ordered by vote_average DESC
        const fallbackIds = async (): Promise<string[]> => {
            const fallback = await sql<{ id: string }[]>`
                    SELECT mi.id
                    FROM media_items mi
                    ${buildMetadataLateralJoinFragment(sql)}
                    WHERE mi.status = 'active'
                      AND mi.has_files = true
                      AND mi.media_type = ${source.media_type}
                      AND mi.id != ${itemId}::uuid
                      ${buildLibraryAccessFilter(sql, denied)}
                    ORDER BY (pm.metadata->>'vote_average')::float DESC NULLS LAST
                    LIMIT ${limit}
                `;
            return fallback.map((r) => r.id);
        };

        // Fetch full item rows for serialization
        const hydrate = (ids: string[]): Promise<postgres.RowList<postgres.Row[]>> =>
            sql`
                SELECT
                    mi.id,
                    mi.title,
                    mi.original_title,
                    mi.media_type,
                    mi.year,
                    mi.created_at,
                    mi.runtime_seconds,
                    mi.parent_id,
                    mi.season_number,
                    mi.episode_number,
                    mi.overview as mi_overview,
                    mi.premiere_date,
                    (pm.metadata->>'overview')::text as pm_overview,
                    (pm.metadata->>'poster_path')::text as poster_path,
                    (pm.metadata->>'backdrop_path')::text as backdrop_path,
                    (pm.metadata->>'vote_average')::float as vote_average,
                    (pm.metadata->>'content_rating')::text as content_rating,
                    (pm.metadata->>'tagline')::text as tagline,
                    CASE WHEN pm.metadata->'genres' IS NOT NULL AND jsonb_typeof(pm.metadata->'genres') = 'array'
                        THEN ARRAY(SELECT (g->>'name')::text FROM jsonb_array_elements(pm.metadata->'genres') AS g WHERE g->>'name' IS NOT NULL)
                        ELSE NULL
                    END as genre_names
                FROM media_items mi
                ${buildMetadataLateralJoinFragment(sql)}
                WHERE mi.id = ANY(${ids}::uuid[])
                  AND mi.status = 'active'
                  AND mi.has_files = true
                  ${ageFilterFragment}
            `;

        const fromEmbeddings = similarIds.length > 0;
        if (!fromEmbeddings) similarIds = await fallbackIds();
        if (similarIds.length === 0) {
            return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
        }
        let rows = await hydrate(similarIds);
        // Every embedding neighbour may be unavailable (no local files, or
        // age-gated): fall back rather than answer with an empty list.
        if (rows.length === 0 && fromEmbeddings) {
            similarIds = await fallbackIds();
            if (similarIds.length > 0) rows = await hydrate(similarIds);
        }

        // Preserve similarity order
        const rowMap = new Map(rows.map((r) => [r.id as string, r]));
        const orderedRows = similarIds.map((id) => rowMap.get(id)).filter(Boolean);

        const items: MediaItemForSerialization[] = orderedRows.map((row) => ({
            id: row!.id as string,
            title: row!.title as string,
            media_type: row!.media_type as string,
            original_title: row!.original_title as string | null,
            overview: (row!.pm_overview ?? row!.mi_overview) as string | null,
            year: row!.year as number | null,
            premiere_date: row!.premiere_date as string | null,
            created_at: row!.created_at as string | null,
            runtime_seconds: row!.runtime_seconds as number | null,
            parent_id: row!.parent_id as string | null,
            season_number: row!.season_number as number | null,
            episode_number: row!.episode_number as number | null,
            poster_path: row!.poster_path as string | null,
            backdrop_path: row!.backdrop_path as string | null,
            vote_average: row!.vote_average as number | null,
            content_rating: row!.content_rating as string | null,
            tagline: row!.tagline as string | null,
            genres: row!.genre_names as string[] | null,
        }));

        await applyJellyfinContentLanguage(sql, locals.user.userId, items);
        const access = await buildJellyfinAccessContext(sql, locals.user);
        await applyFolderUserData(sql, items, locals.user.userId, access.boundary);
        const serialized = serializeBaseItems(items);
        // Similar can mix Movies/Episodes/Series — playable items need
        // MediaSources or Infuse drops them; the helper skips folder types.
        const apiKey = getJfToken(locals as unknown as Record<string, unknown>);
        await enrichItemsWithMediaSources(sql, serialized, apiKey);
        await enrichItemsWithProviderIds(sql, serialized);
        await enrichItemsWithMusicArtists(sql, serialized);
        await enrichItemsWithImages(sql, serialized);
        const filtered = dropFilelessPlayables(serialized);

        return json(
            shapeItemsResponse(
                { Items: filtered, TotalRecordCount: filtered.length, StartIndex: 0 },
                parseDtoOptions(url),
            ),
        );
    } catch (error) {
        logger.error('Similar items query failed', error as Error, { itemId });
        return ApiResponses.error('Failed to get similar items');
    }
}
