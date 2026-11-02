// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Which images the items on one page of a Jellyfin (`/j`) listing — and their
 * season / series / album ancestors — actually have, in one set-based query.
 *
 * Jellyfin's DtoService advertises an image tag only for an image the item
 * really has, and points episodes, seasons and tracks at their parents' images
 * (`SeriesPrimaryImageTag`, `ParentBackdropItemId`, `AlbumPrimaryImageTag`, …).
 * Doing that needs, per node, the identity of each image the byte route
 * (`ImageProxyService.getImageByCatalogId`) can serve from the node's OWN
 * sources: provider metadata paths (any provider — the TMDB fallback and the
 * generic-URL provider both read them), the `custom_*_url` columns the custom
 * provider serves, local `image_candidates` files, and an AudiobookShelf cover.
 * Inheritance is NOT applied here; the caller walks the returned ancestors the
 * way Jellyfin does.
 *
 * Each `*_src` column is a deterministic string that changes when the image
 * source changes (provider path + the provider rows' revision and the item's
 * preferred provider, custom URL, local file + its `updated_at`), so a tag
 * hashed from it is a real cache key: new artwork → new tag → new image URL.
 * NULL means "no stored image". The route can still serve an image live from
 * TMDB (by the node's tmdb id) or a Jellyfin server (by its jellyfin id); the
 * caller decides from `tmdb_id` / `jellyfin_id` and the provider priority.
 *
 * Access: callers pass ids of items they already scoped and serialized. The
 * walk only adds those items' own parent chain (season, series, album, artist),
 * which the item's listing already exposes by id; nothing else is reachable.
 */

import type postgres from 'postgres';
import { imageDescriptorOwnersSql, type ImageOwnerRow } from './image-descriptor.queries.js';
import { isUuid } from '$lib/server/utils/media-key-parser.js';

/** One item or ancestor and the image sources it owns. */
export interface JellyfinImageNode {
    id: string;
    media_type: string;
    parent_id: string | null;
    /** Poster / cover (Jellyfin `Primary` for everything but episodes). */
    poster_src: string | null;
    /** Backdrop from any source, local artwork included. */
    backdrop_src: string | null;
    /**
     * Backdrop from metadata / custom URL only. An episode's local "backdrop"
     * artwork row is the ffmpeg-extracted frame the route serves as its
     * Primary still, not a backdrop a client should show behind its details.
     */
    backdrop_meta_src: string | null;
    logo_src: string | null;
    /** Landscape thumb (Jellyfin `Thumb`). */
    thumb_src: string | null;
    /** Episode still: provider still, local thumb, or the extracted frame. */
    still_src: string | null;
    poster_blurhash: string | null;
    backdrop_blurhash: string | null;
    /** The node's TMDB id, for the provider's live lookup. */
    tmdb_id: string | null;
    /** The node's Jellyfin item id, for the Jellyfin image provider. */
    jellyfin_id: string | null;
}

/** An item id and the ancestors above it, nearest first. */
export interface JellyfinImageChain {
    itemId: string;
    /** depth 0 = the item itself, then parent, grandparent, … (max 3). */
    nodeIds: string[];
}

export interface JellyfinItemImages {
    nodes: Map<string, JellyfinImageNode>;
    chains: Map<string, JellyfinImageChain>;
    /** Present when own descriptor evidence is requested in the same snapshot. */
    owners?: Map<string, ImageOwnerRow>;
}

/**
 * Load image sources for `itemIds` and their parent chains (depth < 4, the
 * same bound as `getImageMetadata`). Ids that are not UUIDs or not media items
 * (playlists, library views, programs) are simply absent from the result.
 * `includeOwners` reads canonical descriptor evidence in this same query,
 * reusing the bounded chain instead of issuing a second ancestor traversal.
 */
export async function getJellyfinItemImages(
    sql: postgres.Sql,
    itemIds: readonly string[],
    includeOwners = false,
): Promise<JellyfinItemImages> {
    const ids = [...new Set(itemIds.filter((id) => isUuid(id)))];
    const result: JellyfinItemImages = { nodes: new Map(), chains: new Map() };
    if (includeOwners) result.owners = new Map();
    if (ids.length === 0) return result;

    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- ids are items the caller already scoped; the walk adds only their own parent chain (see Access above)
    const rows = await sql<
        (JellyfinImageNode & {
            item_id: string;
            depth: number;
            descriptor_owner?: ImageOwnerRow | null;
        })[]
    >`
        WITH RECURSIVE chain(item_id, id, depth) AS (
            SELECT mi.id, mi.id, 0
            FROM media_items mi
            WHERE mi.id = ANY(${ids}::uuid[])
            UNION ALL
            SELECT c.item_id, mi.parent_id, c.depth + 1
            FROM chain c
            JOIN media_items mi ON mi.id = c.id
            WHERE c.depth < 3
              AND mi.parent_id IS NOT NULL
        ),
        nodes AS (
            SELECT DISTINCT id FROM chain
        ),
        node_images AS ${includeOwners ? sql`MATERIALIZED` : sql``} (
            SELECT
                n.id,
                m.media_type,
                m.parent_id,
                NULLIF(concat_ws('|', pm.poster, m.custom_poster_url, art.poster,
                    'abs:' || abs.external_id || ':' ||
                        COALESCE(m.custom_metadata #>> '{audiobookshelf,updatedAt}', '')), '')
                    AS poster_src,
                NULLIF(concat_ws('|', pm.backdrop, m.custom_backdrop_url, art.backdrop), '')
                    AS backdrop_src,
                NULLIF(concat_ws('|', pm.backdrop, m.custom_backdrop_url), '')
                    AS backdrop_meta_src,
                NULLIF(concat_ws('|', pm.logo, m.custom_logo_url, art.logo), '') AS logo_src,
                NULLIF(concat_ws('|', pm.thumb, art.thumb), '') AS thumb_src,
                NULLIF(concat_ws('|', pm.still, art.thumb, art.backdrop), '') AS still_src,
                m.poster_blurhash,
                m.backdrop_blurhash,
                tmdb.external_id AS tmdb_id,
                jf.external_id AS jellyfin_id
            FROM nodes n
            JOIN media_items m ON m.id = n.id
            LEFT JOIN LATERAL (
                -- Each path carries the revision of the provider rows (and the
                -- item's preferred provider), so a provider switch or refresh
                -- that keeps the path text still yields a new tag.
                SELECT
                    agg.poster || agg.rev AS poster,
                    agg.backdrop || agg.rev AS backdrop,
                    agg.logo || agg.rev AS logo,
                    agg.still || agg.rev AS still,
                    agg.thumb || agg.rev AS thumb
                FROM (
                    SELECT
                        string_agg(DISTINCT COALESCE(p.metadata->>'poster_path', p.metadata->'artwork'->>'poster'), ',') AS poster,
                        string_agg(DISTINCT COALESCE(p.metadata->>'backdrop_path', p.metadata->'artwork'->>'backdrop'), ',') AS backdrop,
                        string_agg(DISTINCT COALESCE(p.metadata->>'logo_path', p.metadata->'artwork'->>'logo'), ',') AS logo,
                        string_agg(DISTINCT COALESCE(p.metadata->>'still_path', p.metadata->'artwork'->>'still'), ',') AS still,
                        string_agg(DISTINCT p.metadata->>'thumb_path', ',') AS thumb,
                        '#' || COALESCE(m.preferred_provider, '') || '@' || COALESCE(max(p.updated_at)::text, '') AS rev
                    FROM provider_metadata p
                    WHERE p.media_id = n.id
                ) agg
            ) pm ON true
            LEFT JOIN LATERAL (
                SELECT
                    string_agg(a.file_path || '@' || COALESCE(a.updated_at, a.created_at), ',' ORDER BY a.sort_order, a.id)
                        FILTER (WHERE a.artwork_type = 'poster') AS poster,
                    string_agg(a.file_path || '@' || COALESCE(a.updated_at, a.created_at), ',' ORDER BY a.sort_order, a.id)
                        FILTER (WHERE a.artwork_type = 'backdrop') AS backdrop,
                    string_agg(a.file_path || '@' || COALESCE(a.updated_at, a.created_at), ',' ORDER BY a.sort_order, a.id)
                        FILTER (WHERE a.artwork_type = 'logo') AS logo,
                    string_agg(a.file_path || '@' || COALESCE(a.updated_at, a.created_at), ',' ORDER BY a.sort_order, a.id)
                        FILTER (WHERE a.artwork_type = 'thumb') AS thumb
                FROM image_candidates a
                WHERE a.media_item_id = n.id
                  AND a.file_path IS NOT NULL AND NOT a.suppressed
            ) art ON true
            LEFT JOIN LATERAL (
                SELECT e.external_id
                FROM external_ids e
                WHERE e.media_id = n.id
                  AND e.provider = 'audiobookshelf'
                ORDER BY e.is_primary DESC, e.created_at ASC, e.id ASC
                LIMIT 1
            ) abs ON true
            LEFT JOIN LATERAL (
                SELECT e.external_id
                FROM external_ids e
                WHERE e.media_id = n.id
                  AND e.provider = 'tmdb'
                ORDER BY e.is_primary DESC, e.created_at ASC, e.id ASC
                LIMIT 1
            ) tmdb ON true
            LEFT JOIN LATERAL (
                SELECT e.external_id
                FROM external_ids e
                WHERE e.media_id = n.id
                  AND e.provider = 'jellyfin'
                ORDER BY e.is_primary DESC, e.created_at ASC, e.id ASC
                LIMIT 1
            ) jf ON true
        )
        ${
            includeOwners
                ? sql`, descriptor_owners AS MATERIALIZED (
            ${imageDescriptorOwnersSql(sql, sql`SELECT id FROM nodes`)}
        )`
                : sql``
        }
        SELECT c.item_id, c.depth, ni.*
            ${
                includeOwners
                    ? sql`, CASE WHEN row_number() OVER (
                PARTITION BY ni.id ORDER BY c.item_id, c.depth
            ) = 1 THEN to_jsonb(own) END AS descriptor_owner`
                    : sql``
            }
        FROM chain c
        JOIN node_images ni ON ni.id = c.id
        ${includeOwners ? sql`LEFT JOIN descriptor_owners own ON own.id = ni.id` : sql``}
        ORDER BY c.item_id, c.depth
    `;

    for (const row of rows) {
        const nodeId = String(row.id);
        if (row.descriptor_owner) result.owners?.set(nodeId, row.descriptor_owner);
        if (!result.nodes.has(nodeId)) {
            result.nodes.set(nodeId, {
                id: nodeId,
                media_type: row.media_type,
                parent_id: row.parent_id ? String(row.parent_id) : null,
                poster_src: row.poster_src,
                backdrop_src: row.backdrop_src,
                backdrop_meta_src: row.backdrop_meta_src,
                logo_src: row.logo_src,
                thumb_src: row.thumb_src,
                still_src: row.still_src,
                poster_blurhash: row.poster_blurhash,
                backdrop_blurhash: row.backdrop_blurhash,
                tmdb_id: row.tmdb_id ?? null,
                jellyfin_id: row.jellyfin_id ?? null,
            });
        }
        const itemId = String(row.item_id);
        let chain = result.chains.get(itemId);
        if (!chain) {
            chain = { itemId, nodeIds: [] };
            result.chains.set(itemId, chain);
        }
        chain.nodeIds[row.depth] = nodeId;
    }
    return result;
}
