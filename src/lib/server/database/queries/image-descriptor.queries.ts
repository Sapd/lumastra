// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ImageCandidate } from '$lib/schemas/image-candidates.js';
import type postgres from 'postgres';
import { buildOverrideAwareMetadataLateralJoin } from './builders/provider-metadata.builder.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

export type ArtworkRole = 'poster' | 'backdrop' | 'logo' | 'thumb' | 'banner';
export interface LocalImageInput {
    path: string | null;
    updatedAt: string | null;
}
export interface ImageCandidateWithLocalContent extends ImageCandidate {
    /** Internal measured file identity; never exposed in the public candidate contract. */
    local_content_hash?: string | null;
}
export interface ImageOwnerRow {
    id: string;
    parent_id: string | null;
    media_type: string;
    is_various_artists: boolean;
    preferred_provider: string | null;
    poster_blurhash: string | null;
    backdrop_blurhash: string | null;
    provider_paths: Partial<Record<ArtworkRole, string | null>>;
    custom_urls: Partial<Record<ArtworkRole, string | null>>;
    suppressed_roles?: string[];
    selected_candidates?: Partial<Record<ArtworkRole, ImageCandidateWithLocalContent>>;
    abs_cover_path?: string | null;
    abs_cover_updated_at?: string | null;
    local_artwork: Partial<Record<ArtworkRole, LocalImageInput>>;
}

/** One DB snapshot for all requested items and at most three parent edges. */
export async function getImageDescriptorOwners(
    sql: postgres.Sql,
    itemIds: readonly string[],
): Promise<ImageOwnerRow[]> {
    const ids = [...new Set(itemIds.filter(isUuid))];
    if (!ids.length) return [];
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- caller scopes requested IDs; only their own bounded ancestor chain is added
    return await sql<ImageOwnerRow[]>`
        WITH RECURSIVE ancestors(id, depth) AS (
            SELECT id, 0 FROM media_items WHERE id = ANY(${ids}::uuid[])
            UNION ALL
            SELECT mi.parent_id, a.depth + 1
            FROM ancestors a JOIN media_items mi ON mi.id = a.id
            WHERE a.depth < 3 AND mi.parent_id IS NOT NULL
        ), nodes AS (SELECT DISTINCT id FROM ancestors)
        ${imageDescriptorOwnersSql(sql, sql`SELECT id FROM nodes`)}
    `;
}

/** Own descriptor evidence for an already-scoped, distinct set of owner IDs. */
export function imageDescriptorOwnersSql(
    sql: postgres.Sql,
    ownerIds: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    const metadata = sql.unsafe(
        buildOverrideAwareMetadataLateralJoin(undefined, 'a.id', 'a.preferred_provider'),
    );
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- ownerIds is supplied by the caller's scoped item/ancestor query
    return sql`
        SELECT a.id, a.parent_id, a.media_type, a.is_various_artists, a.preferred_provider,
            a.poster_blurhash, a.backdrop_blurhash,
            a.custom_metadata #>> '{audiobookshelf,coverPath}' AS abs_cover_path,
            a.custom_metadata #>> '{audiobookshelf,updatedAt}' AS abs_cover_updated_at,
            (SELECT jsonb_object_agg(slot.key,CASE WHEN EXISTS (
                SELECT 1 FROM image_candidates hidden WHERE hidden.media_item_id=a.id
                    AND hidden.suppressed AND hidden.artwork_type=slot.key
                    AND (hidden.provider_ref=slot.value #>> '{}' OR hidden.remote_url=slot.value #>> '{}'
                        OR hidden.file_path=slot.value #>> '{}')
                ) THEN NULL::jsonb ELSE slot.value END)
            FROM jsonb_each(jsonb_build_object(
                'poster', COALESCE(NULLIF(pm.metadata->>'poster_path', ''), NULLIF(pm.metadata->'artwork'->>'poster', ''),
                    CASE WHEN a.media_type = 'audiobook' AND NULLIF(a.custom_metadata #>> '{audiobookshelf,coverPath}', '') IS NOT NULL
                    THEN (a.custom_metadata #>> '{audiobookshelf,coverPath}') || ':' || COALESCE(a.custom_metadata #>> '{audiobookshelf,updatedAt}', '') END),
                'backdrop', COALESCE(NULLIF(pm.metadata->>'backdrop_path', ''), NULLIF(pm.metadata->'artwork'->>'backdrop', '')),
                'logo', COALESCE(NULLIF(pm.metadata->>'logo_path', ''), NULLIF(pm.metadata->'artwork'->>'logo', '')),
                'thumb', COALESCE(NULLIF(pm.metadata->>'still_path', ''), NULLIF(pm.metadata->'artwork'->>'still', ''))
            )) slot) AS provider_paths,
            jsonb_build_object('poster', a.custom_poster_url, 'backdrop', a.custom_backdrop_url,
                'logo', a.custom_logo_url, 'thumb', a.custom_thumb_url) AS custom_urls,
            COALESCE(art.roles, '{}'::jsonb) AS local_artwork, COALESCE(candidates.roles, '{}'::jsonb) AS selected_candidates,
            ARRAY(SELECT role FROM image_provider_suppressions WHERE owner = a.id::text) AS suppressed_roles
        FROM (${ownerIds}) n JOIN media_items a ON a.id = n.id
        ${metadata}
        LEFT JOIN LATERAL (
            SELECT jsonb_object_agg(chosen.artwork_type,
                jsonb_build_object('path', chosen.file_path, 'updatedAt', chosen.updated_at)) AS roles
            FROM (
                SELECT DISTINCT ON (ma.artwork_type)
                    ma.artwork_type, ma.file_path, ma.updated_at
                FROM (
                    SELECT id,artwork_type,file_path,updated_at,sort_order,created_at,selection_order
                    FROM image_candidates WHERE media_item_id=a.id AND source='local' AND selected AND NOT suppressed
                    UNION ALL
                    SELECT ma.id,ma.artwork_type,ma.file_path,ma.updated_at,ma.sort_order,ma.created_at,2147483647
                    FROM media_artwork ma WHERE ma.media_item_id=a.id AND ma.source='local' AND ma.file_path IS NOT NULL
                        AND NOT EXISTS (SELECT 1 FROM image_provider_suppressions s WHERE s.owner=a.id::text
                            AND s.provider IN ('*',image_provider(ma.remote_url,ma.file_path)) AND s.role IN ('*',ma.artwork_type))
                        AND NOT EXISTS (SELECT 1 FROM media_artwork_suppressions s WHERE s.media_item_id=a.id
                            AND s.artwork_type=ma.artwork_type AND s.file_path=ma.file_path)
                ) ma
                ORDER BY ma.artwork_type, ma.selection_order, ma.sort_order, ma.created_at, ma.id
            ) chosen
        ) art ON true
        LEFT JOIN LATERAL (
            SELECT jsonb_object_agg(chosen.artwork_type, to_jsonb(chosen)) AS roles FROM (
                SELECT DISTINCT ON (artwork_type) * FROM image_candidates
                WHERE media_item_id = a.id AND selected AND NOT suppressed
                ORDER BY artwork_type, selection_order, sort_order, created_at, id
            ) chosen
        ) candidates ON true
    `;
}

/** Poster evidence on one owner. CASE avoids provider work for selected/custom artwork. */
function ownedPosterSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    const metadata = sql.unsafe(
        buildOverrideAwareMetadataLateralJoin(undefined, 'a.id', 'a.preferred_provider'),
    );
    return sql`CASE
        WHEN EXISTS (SELECT 1 FROM image_candidates ic
            WHERE ic.media_item_id = a.id AND ic.artwork_type = 'poster' AND ic.selected AND NOT ic.suppressed) THEN true
        WHEN EXISTS (SELECT 1 FROM image_provider_suppressions s
            WHERE s.owner = a.id::text AND s.role IN ('*', 'poster')) THEN false
        WHEN NULLIF(a.custom_poster_url, '') IS NOT NULL
            OR (a.media_type = 'audiobook' AND NULLIF(a.custom_metadata #>> '{audiobookshelf,coverPath}', '') IS NOT NULL) THEN true
        ELSE EXISTS (
            SELECT 1 FROM (SELECT 1) seed ${metadata}
            WHERE COALESCE(NULLIF(pm.metadata->>'poster_path', ''),
                NULLIF(pm.metadata->'artwork'->>'poster', '')) IS NOT NULL
                AND NOT EXISTS (SELECT 1 FROM image_candidates hidden WHERE hidden.media_item_id=a.id
                    AND hidden.suppressed AND hidden.artwork_type='poster'
                    AND (hidden.provider_ref=COALESCE(NULLIF(pm.metadata->>'poster_path',''),NULLIF(pm.metadata->'artwork'->>'poster',''))
                        OR hidden.remote_url=COALESCE(NULLIF(pm.metadata->>'poster_path',''),NULLIF(pm.metadata->'artwork'->>'poster',''))))
        ) OR EXISTS (SELECT 1 FROM media_artwork ma
            WHERE ma.media_item_id = a.id AND ma.artwork_type = 'poster'
              AND ma.source = 'local' AND NULLIF(ma.file_path, '') IS NOT NULL
              AND NOT EXISTS (SELECT 1 FROM media_artwork_suppressions s
                  WHERE s.media_item_id = a.id AND s.artwork_type = 'poster' AND s.file_path = ma.file_path))
    END`;
}

/** Ancestor eligibility, shared by the scalar and set-based forms. */
function posterAncestorSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`(chain.depth = 0
        OR (chain.own_type IN ('season', 'episode') AND a.media_type = 'tv')
        OR (chain.own_type = 'episode' AND a.media_type = 'season')
        OR (chain.own_type = 'track' AND a.media_type = 'album')
        OR (chain.own_type = 'album' AND a.media_type = 'artist' AND NOT a.is_various_artists))`;
}

/** Displayable poster/cover. Blurhash is only a placeholder, never artwork evidence. */
export function effectivePosterSql(
    sql: postgres.Sql,
    itemId: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- scalar projection of one caller-scoped item; the admin browser gates its outer rows
    return sql`EXISTS (
        SELECT 1 FROM media_items a WHERE a.id = ${itemId}
        AND CASE WHEN ${ownedPosterSql(sql)} THEN true
            WHEN a.media_type IN ('season', 'episode', 'track', 'album') THEN EXISTS (
                WITH RECURSIVE ancestors(id, depth, own_type) AS (
                    SELECT a.parent_id, 1, a.media_type WHERE a.parent_id IS NOT NULL
                    UNION ALL
                    SELECT mi.parent_id, chain.depth + 1, chain.own_type
                    FROM ancestors chain JOIN media_items mi ON mi.id = chain.id
                    WHERE chain.depth < 3 AND mi.parent_id IS NOT NULL
                )
                SELECT 1 FROM ancestors chain JOIN media_items a ON a.id = chain.id
                WHERE ${posterAncestorSql(sql)} AND ${ownedPosterSql(sql)}
            ) ELSE false END
    )`;
}

/**
 * IDs with a displayable poster in a caller-scoped population (id, media_type).
 * Walk ancestors once for the set and evaluate each distinct owner's artwork
 * once. Saved-view counts can join this result instead of running two recursive
 * subplans per row (artwork plus attention).
 */
export function effectivePosterItemsSql(
    sql: postgres.Sql,
    items: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- every owner is reached from the caller-scoped population
    return sql`
        WITH RECURSIVE ancestors(item_id, id, depth, own_type) AS (
            SELECT id, id, 0, media_type FROM (${items}) scope
            UNION ALL
            SELECT chain.item_id, mi.parent_id, chain.depth + 1, chain.own_type
            FROM ancestors chain JOIN media_items mi ON mi.id = chain.id
            WHERE chain.depth < 3 AND mi.parent_id IS NOT NULL
              AND chain.own_type IN ('season', 'episode', 'track', 'album')
        ), available AS MATERIALIZED (
            SELECT a.id FROM media_items a
            WHERE a.id IN (SELECT id FROM ancestors) AND ${ownedPosterSql(sql)}
        )
        SELECT DISTINCT chain.item_id AS id
        FROM ancestors chain JOIN media_items a ON a.id = chain.id
        JOIN available ON available.id = a.id
        WHERE ${posterAncestorSql(sql)}
    `;
}
