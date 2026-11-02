// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Typed `ctx` stores for the two things plugins were reaching into raw SQL for.
 *
 * Both were already *possible* with `capabilities.database` — smart playlists
 * and intro detectors are the two most obvious plugin ideas the system could
 * host — but only by writing straight into `playlists` / `playlist_items` /
 * `media_segments`. That is not a contract: it works until a column moves, it
 * bypasses every invariant the host maintains, and it gives an author no signal
 * about which of those tables are safe to touch.
 *
 * These stores are narrow on purpose. They cover the operations those plugin
 * shapes actually need and nothing else, in internal UUIDs — the only stable
 * key a plugin should ever store.
 */

import {
    getSegmentsByMediaId,
    upsertSegments,
} from '$lib/server/database/queries/media-segments.queries.js';
import type postgres from 'postgres';
import type { MediaSegment } from '$lib/schemas/playback-types.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PluginStores');

// ---------------------------------------------------------------------------
// Media segments
// ---------------------------------------------------------------------------

/**
 * What a plugin calls a segment.
 *
 * Lowercase because that is the vocabulary the plugin API uses everywhere else;
 * the `media_segments` table has always stored capitalized values and its CHECK
 * constraint accepts only those five, so the boundary translates. There is no
 * `credits`: the table has no representation for it, and a published type that
 * promises a value every write rejects is worse than a narrower one.
 */
export type PluginSegmentType = 'intro' | 'outro' | 'recap' | 'preview' | 'commercial';

/**
 * Plugin vocabulary → the exact strings `media_segments_type_check` allows.
 *
 * This map IS the constraint, restated. Anything not in it cannot be stored,
 * so `upsert` drops it rather than sending a row Postgres will reject with a
 * 23514 — which would otherwise fail the plugin's whole task run.
 */
export const DB_SEGMENT_TYPE: Record<PluginSegmentType, MediaSegment['type']> = {
    intro: 'Intro',
    outro: 'Outro',
    recap: 'Recap',
    preview: 'Preview',
    commercial: 'Commercial',
};

const PLUGIN_SEGMENT_TYPE: Record<string, PluginSegmentType> = Object.fromEntries(
    Object.entries(DB_SEGMENT_TYPE).map(([plugin, db]) => [db, plugin as PluginSegmentType]),
);

/**
 * A stored value → the plugin vocabulary, or null when the host stores
 * something this contract has no name for. Null rather than a cast: handing a
 * plugin `'Mystery'` typed as `PluginSegmentType` is how a comparison silently
 * never matches.
 */
export function toPluginSegmentType(dbValue: string): PluginSegmentType | null {
    return PLUGIN_SEGMENT_TYPE[dbValue] ?? null;
}

export interface PluginMediaSegment {
    type: PluginSegmentType;
    /** Seconds from the start of the item. */
    startTime: number;
    endTime: number;
}

export interface MediaSegmentStore {
    /** Segments any source has recorded for this item. */
    list(mediaItemId: string): Promise<Array<PluginMediaSegment & { source: string }>>;
    /**
     * Record this plugin's segments for an item, replacing its own previous
     * ones for the same types. Segments are keyed by `(media, type, source)`,
     * and `source` is your plugin id — so you can never overwrite another
     * detector's findings, and yours are removable without touching theirs.
     */
    upsert(mediaItemId: string, segments: PluginMediaSegment[]): Promise<void>;
    /** Remove everything THIS plugin recorded for an item. */
    clear(mediaItemId: string): Promise<void>;
}

export function buildMediaSegmentStore(sql: postgres.Sql, pluginId: string): MediaSegmentStore {
    return {
        async list(mediaItemId) {
            const rows = await getSegmentsByMediaId(sql, mediaItemId);
            return rows.flatMap((r) => {
                const type = toPluginSegmentType(r.type);
                // A type this contract cannot name is omitted rather than cast:
                // a plugin filtering on `s.type === 'intro'` would silently
                // never match a value it was handed under a lying type.
                if (!type) return [];
                return [
                    {
                        type,
                        startTime: Number(r.start_time),
                        endTime: Number(r.end_time),
                        source: r.source,
                    },
                ];
            });
        },

        async upsert(mediaItemId, segments) {
            const usable = segments.filter((s) => {
                if (!(s.type in DB_SEGMENT_TYPE)) return false;
                // A zero-or-negative-length segment is a detector bug, and it
                // reaches the player as a skip button that does nothing.
                return (
                    Number.isFinite(s.startTime) &&
                    Number.isFinite(s.endTime) &&
                    s.startTime >= 0 &&
                    s.endTime > s.startTime
                );
            });
            if (usable.length !== segments.length) {
                logger.warn('dropped unusable segments from a plugin', {
                    plugin: pluginId,
                    mediaItemId,
                    dropped: segments.length - usable.length,
                });
            }
            await upsertSegments(
                sql,
                mediaItemId,
                usable.map((segment) => ({
                    type: DB_SEGMENT_TYPE[segment.type],
                    startTime: segment.startTime,
                    endTime: segment.endTime,
                })),
                pluginId,
            );
        },

        async clear(mediaItemId) {
            await sql`
                DELETE FROM media_segments
                WHERE media_id = ${mediaItemId}::uuid AND source = ${pluginId}
            `;
        },
    };
}

// ---------------------------------------------------------------------------
// Playlists
// ---------------------------------------------------------------------------

export interface PluginPlaylistSummary {
    id: number;
    name: string;
    itemCount: number;
}

export interface PlaylistStore {
    /** Playlists owned by this user. */
    listOwned(userId: string): Promise<PluginPlaylistSummary[]>;
    /** Create one and return its id. */
    create(opts: {
        userId: string;
        name: string;
        description?: string | null;
        visibility?: 'private' | 'public';
    }): Promise<number>;
    /**
     * Replace a playlist's contents with exactly these items, in this order.
     *
     * The primitive a smart playlist actually needs: recompute the set, hand it
     * over. Doing it as delete-then-insert INSIDE one transaction matters —
     * clearing and refilling in two steps leaves the playlist briefly empty,
     * and a viewer opening it in that window sees their playlist wiped.
     *
     * ONLY on a playlist your plugin created. Anything else throws. `id` here is
     * a small sequential integer, so a stale or off-by-one value is an easy
     * mistake, and this call commits its delete and insert together — a user's
     * hand-curated playlist would be gone with no undo.
     */
    replaceItems(playlistId: number, mediaItemIds: string[]): Promise<number>;
}

export function buildPlaylistStore(sql: postgres.Sql, pluginId: string): PlaylistStore {
    return {
        async listOwned(userId) {
            const rows = await sql<{ id: number; name: string; item_count: string }[]>`
                SELECT p.id, p.name,
                       (SELECT COUNT(*) FROM playlist_items pi WHERE pi.playlist_id = p.id)::text
                           AS item_count
                FROM playlists p
                WHERE p.user_id = ${userId}::uuid
                  AND p.is_system = false
                ORDER BY p.updated_at DESC
            `;
            return rows.map((r) => ({
                id: r.id,
                name: r.name,
                itemCount: Number(r.item_count),
            }));
        },

        async create({ userId, name, description = null, visibility = 'private' }) {
            const rows = await sql<{ id: number }[]>`
                INSERT INTO playlists
                    (user_id, name, description, visibility, playlist_type, created_by_plugin)
                VALUES (${userId}::uuid, ${name}, ${description}, ${visibility}, 'general', ${pluginId})
                RETURNING id
            `;
            logger.info('plugin created a playlist', { plugin: pluginId, name });
            return rows[0].id;
        },

        async replaceItems(playlistId, mediaItemIds) {
            // Checked FIRST, and for the empty case too — clearing a playlist
            // outright is the most destructive form of this call, not the least.
            // A NULL `created_by_plugin` means a person made it, which is every
            // pre-existing row and exactly the set a plugin must not overwrite.
            const owner = await sql<{ created_by_plugin: string | null }[]>`
                SELECT created_by_plugin FROM playlists WHERE id = ${playlistId}
            `;
            if (owner.length === 0) {
                throw new Error(`playlist ${playlistId} does not exist`);
            }
            if (owner[0].created_by_plugin !== pluginId) {
                throw new Error(
                    `plugin "${pluginId}" did not create playlist ${playlistId} and may not replace its items`,
                );
            }

            if (mediaItemIds.length === 0) {
                await sql.begin(async (tx) => {
                    await tx`DELETE FROM playlist_items WHERE playlist_id = ${playlistId}`;
                    // Bumped here too, or `listOwned`'s ORDER BY updated_at
                    // silently disagrees with the non-empty path.
                    await tx`UPDATE playlists SET updated_at = NOW(), revision = revision + 1 WHERE id = ${playlistId}`;
                });
                return 0;
            }
            // One transaction: see the doc comment on the interface. The
            // sub-select fills title from the media item so the row satisfies
            // its NOT NULL without the plugin having to pass display data it
            // does not own — and it silently drops ids that do not resolve,
            // which is the right outcome for a recomputed set.
            let inserted = 0;
            await sql.begin(async (tx) => {
                await tx`DELETE FROM playlist_items WHERE playlist_id = ${playlistId}`;
                const rows = await tx<{ count: string }[]>`
                    WITH ordered AS (
                        SELECT id, ord
                        FROM unnest(${mediaItemIds}::uuid[]) WITH ORDINALITY AS t(id, ord)
                    ),
                    ins AS (
                        INSERT INTO playlist_items
                            (playlist_id, media_id, title, "position")
                        SELECT ${playlistId}, mi.id, COALESCE(mi.title, 'Untitled'), o.ord
                        FROM ordered o
                        JOIN media_items mi ON mi.id = o.id
                        ORDER BY o.ord
                        RETURNING 1
                    )
                    SELECT COUNT(*)::text AS count FROM ins
                `;
                inserted = Number(rows[0]?.count ?? 0);
                await tx`UPDATE playlists SET updated_at = NOW(), revision = revision + 1 WHERE id = ${playlistId}`;
            });
            return inserted;
        },
    };
}
