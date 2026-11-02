// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Move every user, history, curation and delivery reference from a duplicate
 * media row onto the row that survives a merge, so the duplicate can be
 * deleted without cascading or orphaning anything.
 *
 * The table set is the one `mediaReferenceGuard` checks plus the extra tables
 * `mergeDuplicateSeries` moves (`cached_list_items`, `external_ids`,
 * `hls_playback_tokens`). Where a table has a unique key that the move could
 * collide on, the survivor's row wins and the duplicate's conflicting row is
 * deleted; no other row is ever dropped. Polymorphic text ids (`interactions`,
 * `interaction_reactions`, media-type `user_media_flags`) are matched
 * dash- and case-insensitively and rewritten as the survivor's dashed id.
 *
 * Pure SQL in the caller's transaction. The caller decides what counts as a
 * duplicate and deletes it afterwards through its own guarded delete.
 */

import type postgres from 'postgres';
import { MEDIA_FLAG_TARGET_TYPES } from './user-media-flags.queries.js';

type Fragment = postgres.PendingQuery<postgres.Row[]>;

export interface MovedMediaReferences {
    /** Reference rows re-pointed at the survivor. */
    moved: number;
    /** Duplicate rows deleted because the survivor already had the same row. */
    dropped: number;
}

/**
 * Tables whose media column is covered by a plain unique key: the key's other
 * columns decide whether the survivor already holds the same row.
 */
const KEYED_TABLES: ReadonlyArray<{ table: string; column: string; key: readonly string[] }> = [
    { table: 'user_ratings', column: 'media_id', key: ['user_id'] },
    { table: 'user_suggestions', column: 'media_id', key: ['user_id', 'cache_context'] },
    { table: 'user_media_state', column: 'media_id', key: ['user_id'] },
    { table: 'user_rate_skips', column: 'media_id', key: ['user_id'] },
    { table: 'user_taste_dampers', column: 'media_id', key: ['user_id'] },
    { table: 'user_media_share_opt_out', column: 'media_id', key: ['user_id'] },
    {
        table: 'watch_state_sync_log',
        column: 'media_id',
        key: ['user_id', 'provider', 'direction'],
    },
    { table: 'library_availability', column: 'media_id', key: ['library'] },
    { table: 'series_episode_ordering', column: 'media_id', key: [] },
    {
        table: 'media_artwork_suppressions',
        column: 'media_item_id',
        key: ['artwork_type', 'file_path'],
    },
    { table: 'personal_media_dispositions', column: 'media_id', key: [] },
    { table: 'cached_list_items', column: 'media_id', key: ['list_id'] },
    { table: 'user_music_state', column: 'track_id', key: ['user_id'] },
];

/** Tables with no unique key over their media column: every row moves. */
const PLAIN_TABLES: ReadonlyArray<{ table: string; column: string }> = [
    { table: 'watchlist_activities', column: 'media_id' },
    { table: 'play_sessions', column: 'media_id' },
    { table: 'watch_history', column: 'media_id' },
    { table: 'user_media_events_archive', column: 'media_id' },
    { table: 'watch_state_pending_resolution', column: 'internal_media_id' },
    { table: 'training_assignments', column: 'media_id' },
    { table: 'course_modules', column: 'media_item_id' },
    { table: 'courses', column: 'cover_media_id' },
    { table: 'upload_sessions', column: 'media_item_id' },
    { table: 'playback_incident_events', column: 'media_id' },
    { table: 'transcode_failure_events', column: 'media_id' },
    { table: 'hls_playback_tokens', column: 'media_item_id' },
];

/** Hand-written moves below, for tables whose unique keys need their own rule. */
const SPECIAL_TABLES: ReadonlyArray<{ table: string; column: string }> = [
    { table: 'admin_media_change_receipts', column: 'media_item_id' },
    { table: 'image_candidates', column: 'media_item_id' },
    { table: 'user_media_events', column: 'media_id' },
    { table: 'music_listen_events', column: 'track_id' },
    { table: 'playlist_items', column: 'media_id' },
    { table: 'media_annotations', column: 'media_id' },
    { table: 'watch_sync_activity', column: 'media_id' },
    { table: 'external_ids', column: 'media_id' },
    { table: 'media_items', column: 'canonical_id' },
];

/** Every uuid column `moveMediaReferences` re-points at the survivor. */
export const MOVED_MEDIA_REFERENCE_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
    { table: 'media_artwork', column: 'media_item_id' },
    ...KEYED_TABLES.map(({ table, column }) => ({ table, column })),
    ...PLAIN_TABLES,
    ...SPECIAL_TABLES,
];

/** Polymorphic text references (`target_id`) it re-points, matched normalized. */
export const MOVED_POLYMORPHIC_REFERENCE_TABLES = [
    'interactions',
    'interaction_reactions',
    'user_media_flags',
] as const;

/**
 * Serialize work on one pair of media rows, in either direction, for the rest
 * of the transaction. Same key as `mergeDuplicateSeries`, so the two merges
 * contend on one lock instead of deadlocking on row locks.
 */
export async function lockMediaPair(tx: postgres.Sql, a: string, b: string): Promise<void> {
    await tx`
        SELECT pg_advisory_xact_lock(
            hashtextextended(
                LEAST(${a}::uuid::text, ${b}::uuid::text) || '|' || GREATEST(${a}::uuid::text, ${b}::uuid::text),
                0
            )
        )
    `;
}

/**
 * Thrown before anything is written when a pair cannot be merged: a
 * self-merge, a missing survivor, two different media types, or a type
 * other than the caller's allowed type.
 */
export class MediaReferenceMoveRefusedError extends Error {
    constructor(message: string) {
        super(`moveMediaReferences: ${message}`);
        this.name = 'MediaReferenceMoveRefusedError';
    }
}

/**
 * Move every reference of `fromId` onto `toId` inside the caller's
 * transaction. Albums only: the merge rules for resume state, playback
 * tokens and sessions were reviewed for album merges, not for playable or
 * hierarchical types. A missing duplicate moves nothing. Throws
 * {@link MediaReferenceMoveRefusedError} for a missing survivor, a
 * self-merge, a type mismatch or a non-album pair, so a caller bug can never
 * strand references.
 */
export async function moveMediaReferences(
    tx: postgres.Sql,
    fromId: string,
    toId: string,
): Promise<MovedMediaReferences> {
    return moveReferencesForType(tx, fromId, toId, 'album');
}

async function moveReferencesForType(
    tx: postgres.Sql,
    fromId: string,
    toId: string,
    mediaType: 'album' | 'track',
): Promise<MovedMediaReferences> {
    const f = uuidParam(tx, fromId);
    const t = uuidParam(tx, toId);
    const [{ same }] = await tx<{ same: boolean }[]>`SELECT ${f} = ${t} AS same`;
    if (same) throw new MediaReferenceMoveRefusedError(`refusing to merge ${fromId} into itself`);

    await lockMediaPair(tx, fromId, toId);

    // Both rows are locked FOR UPDATE so no reference writer (an FK insert,
    // or setFlag/upsertReaction/insertComment, which take KEY SHARE on their
    // target) can land on either row between a merge or UPDATE below and its
    // leftover DELETE; such writers wait until the move commits.
    // Admin-only maintenance on two rows the caller already picked; serves no user listing.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [to] = await tx<{ media_type: string }[]>`
        SELECT media_type FROM media_items WHERE id = ${t} FOR UPDATE
    `;
    if (!to) throw new MediaReferenceMoveRefusedError(`survivor ${toId} does not exist`);
    if (to.media_type !== mediaType) {
        throw new MediaReferenceMoveRefusedError(
            `${toId} is a ${to.media_type}; only ${mediaType === 'album' ? 'albums' : 'tracks'} are merged`,
        );
    }
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [from] = await tx<{ media_type: string }[]>`
        SELECT media_type FROM media_items WHERE id = ${f} FOR UPDATE
    `;
    if (!from) return { moved: 0, dropped: 0 };
    if (from.media_type !== to.media_type) {
        throw new MediaReferenceMoveRefusedError(
            `${fromId} is a ${from.media_type}, ${toId} is a ${to.media_type}`,
        );
    }

    // Copy provider deletion tombstones before compatibility writes can discover
    // artwork on the survivor. Source-owner cleanup may then delete its copies.
    await tx`INSERT INTO image_provider_suppressions (owner, provider, role)
        SELECT ${toId}::uuid::text, provider, role FROM image_provider_suppressions
        WHERE owner = ${fromId}::uuid::text
        ON CONFLICT (owner, provider, role) DO NOTHING`;

    // One artwork row per type/provider/language is allowed. Preserve different
    // images competing for the same slot as alternatives on the survivor, while
    // its current selection wins. No image path disappears with the old id.
    // Internal maintenance of the locked album pair, never a viewer listing.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await tx`
        UPDATE media_items w SET custom_metadata = COALESCE(w.custom_metadata,'{}'::jsonb) ||
            jsonb_build_object('merged_album_artwork', alternatives.items)
        FROM (
            SELECT jsonb_agg(DISTINCT item) AS items FROM (
                SELECT jsonb_array_elements(COALESCE(custom_metadata->'merged_album_artwork','[]'::jsonb)) AS item
                FROM media_items WHERE id IN (${f},${t})
                UNION ALL
                SELECT to_jsonb(d) - 'media_item_id' FROM media_artwork d
                WHERE d.media_item_id=${f} AND EXISTS (
                    SELECT 1 FROM media_artwork a WHERE a.media_item_id=${t}
                    AND a.artwork_type=d.artwork_type AND a.source=d.source
                    AND a.language IS NOT DISTINCT FROM d.language
                )
            ) entries
        ) alternatives
        WHERE w.id=${t} AND alternatives.items IS NOT NULL
    `;
    // Move candidates before copying custom URLs: URL capture would otherwise
    // recreate a source candidate on the survivor, then discard its original id.
    // Incoming singleton selections must be cleared in the owner-changing UPDATE;
    // the reselect trigger elects only after the rows are on their new owner.
    await tx`UPDATE image_candidates incoming SET
        sort_order = GREATEST(incoming.sort_order, COALESCE((SELECT max(own.sort_order)+1 FROM image_candidates own
            WHERE own.media_item_id = ${t} AND own.artwork_type = incoming.artwork_type), incoming.sort_order)),
        locked = incoming.locked AND NOT EXISTS (SELECT 1 FROM image_candidates own
            WHERE own.media_item_id = ${t} AND own.artwork_type = incoming.artwork_type AND own.locked)
        WHERE incoming.media_item_id = ${f}`;
    const moved =
        await tx`UPDATE image_candidates incoming SET media_item_id = ${t}, selected = false
        WHERE incoming.media_item_id = ${f} AND NOT EXISTS (
            SELECT 1 FROM image_candidates own WHERE own.media_item_id = ${t}
                AND own.artwork_type = incoming.artwork_type AND own.provider = incoming.provider
                AND own.provider_ref = incoming.provider_ref
                AND COALESCE(own.language, '') = COALESCE(incoming.language, ''))`;
    const dropped = await tx`DELETE FROM image_candidates WHERE media_item_id = ${f}`;
    const result: MovedMediaReferences = { moved: moved.count, dropped: dropped.count };

    // Album-level metadata and selected images live on the row itself, not in
    // reference tables. Fill survivor gaps while retaining its chosen values.
    // Internal maintenance of the locked album pair, never a viewer listing.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await tx`
        UPDATE media_items w SET
            custom_metadata = COALESCE(d.custom_metadata, '{}'::jsonb) || COALESCE(w.custom_metadata, '{}'::jsonb),
            custom_poster_url = COALESCE(w.custom_poster_url, CASE WHEN d.custom_poster_url='/api/image/custom/' || ${f}::text || '/poster' THEN '/api/image/custom/' || ${t}::text || '/poster' ELSE d.custom_poster_url END),
            custom_backdrop_url = COALESCE(w.custom_backdrop_url, CASE WHEN d.custom_backdrop_url='/api/image/custom/' || ${f}::text || '/backdrop' THEN '/api/image/custom/' || ${t}::text || '/backdrop' ELSE d.custom_backdrop_url END),
            custom_logo_url = COALESCE(w.custom_logo_url, CASE WHEN d.custom_logo_url='/api/image/custom/' || ${f}::text || '/logo' THEN '/api/image/custom/' || ${t}::text || '/logo' ELSE d.custom_logo_url END),
            custom_thumb_url = COALESCE(w.custom_thumb_url, CASE WHEN d.custom_thumb_url='/api/image/custom/' || ${f}::text || '/thumb' THEN '/api/image/custom/' || ${t}::text || '/thumb' ELSE d.custom_thumb_url END),
            poster_blurhash = COALESCE(w.poster_blurhash, d.poster_blurhash),
            backdrop_blurhash = COALESCE(w.backdrop_blurhash, d.backdrop_blurhash),
            overview = COALESCE(w.overview, d.overview),
            year = COALESCE(w.year, d.year),
            original_title = COALESCE(w.original_title, d.original_title),
            library_added_at = LEAST(w.library_added_at, d.library_added_at),
            first_file_at = LEAST(w.first_file_at, d.first_file_at),
            updated_at = NOW()
        FROM media_items d WHERE w.id=${t} AND d.id=${f}
    `;
    // Thunks, so the DELETE of the leftovers is only built and sent once the
    // UPDATE has run.
    const tally = async (update: () => Fragment, drop: () => Fragment): Promise<void> => {
        result.moved += (await update()).count;
        result.dropped += (await drop()).count;
    };

    // Per-user state on both rows is merged into the survivor's row before the
    // duplicate's row is dropped as a conflict, so neither side's favorite,
    // watch or play history is lost. Resume data follows the later event.
    await tx`
            UPDATE user_media_state AS w SET
                is_favorite = CASE
                    WHEN w.is_favorite OR d.is_favorite THEN true
                    WHEN w.is_favorite IS NULL AND d.is_favorite IS NULL THEN NULL
                    ELSE false
                END,
                is_watched = w.is_watched OR d.is_watched,
                watch_count = ${mediaType === 'track' ? tx`w.watch_count + d.watch_count` : tx`GREATEST(w.watch_count, d.watch_count)`},
                first_watched_at = LEAST(w.first_watched_at, d.first_watched_at),
                last_watched_at = GREATEST(w.last_watched_at, d.last_watched_at),
                last_event_at = GREATEST(w.last_event_at, d.last_event_at),
                resume_position_ms = CASE WHEN ${dupIsLater(tx)} THEN d.resume_position_ms ELSE w.resume_position_ms END,
                runtime_ms = CASE WHEN ${dupIsLater(tx)} THEN d.runtime_ms ELSE w.runtime_ms END,
                last_event_source = CASE WHEN ${dupIsLater(tx)} THEN d.last_event_source ELSE w.last_event_source END,
                highest_session_elapsed_ms = CASE WHEN ${dupIsLater(tx)} THEN d.highest_session_elapsed_ms ELSE w.highest_session_elapsed_ms END
            FROM user_media_state d
            WHERE w.media_id = ${t} AND d.media_id = ${f} AND d.user_id = w.user_id
        `;
    // Plays of the duplicate are separate listens of the same track: they add up.
    await tx`
            UPDATE user_music_state AS w SET
                play_count = w.play_count + d.play_count,
                skip_count = w.skip_count + d.skip_count,
                complete_count = w.complete_count + d.complete_count,
                total_listen_ms = w.total_listen_ms + d.total_listen_ms,
                first_played_at = LEAST(w.first_played_at, d.first_played_at),
                last_played_at = GREATEST(w.last_played_at, d.last_played_at)
            FROM user_music_state d
            WHERE w.track_id = ${t} AND d.track_id = ${f} AND d.user_id = w.user_id
        `;

    if (mediaType === 'track') {
        // File-bound offline renditions still refer to the same physical bytes.
        await tx`UPDATE download_renditions SET media_item_id=${t} WHERE media_item_id=${f}`;
        await tx`UPDATE media_added_pending r SET media_item_id=${t}
            WHERE media_item_id=${f} AND NOT EXISTS (SELECT 1 FROM media_added_pending w
                WHERE w.media_item_id=${t} AND w.hook_id=r.hook_id)`;
        await tx`DELETE FROM media_added_pending WHERE media_item_id=${f}`;
        await tx`UPDATE active_transcode_jobs SET item_id=${toId}::uuid::text
            WHERE lower(replace(item_id,'-',''))=replace(${fromId}::uuid::text,'-','')`;
    }

    for (const { table, column, key } of KEYED_TABLES) {
        const sameKey = key.reduce<Fragment>(
            (acc, k) => tx`${acc} AND w.${tx(k)} IS NOT DISTINCT FROM r.${tx(k)}`,
            tx`TRUE`,
        );
        await tally(
            () => tx`
                UPDATE ${tx(table)} AS r SET ${tx(column)} = ${t}
                WHERE r.${tx(column)} = ${f}
                  AND NOT EXISTS (
                      SELECT 1 FROM ${tx(table)} w WHERE w.${tx(column)} = ${t} AND ${sameKey}
                  )
            `,
            () => tx`DELETE FROM ${tx(table)} WHERE ${tx(column)} = ${f}`,
        );
    }

    // The elected candidate mirror owns compatibility storage. Move any uncaptured
    // legacy rows too, without counting those duplicate storage rows as references.
    await tx`UPDATE media_artwork r SET media_item_id = ${t} WHERE media_item_id = ${f}
        AND NOT EXISTS (SELECT 1 FROM media_artwork w WHERE w.media_item_id = ${t}
            AND w.artwork_type = r.artwork_type AND w.source = r.source AND COALESCE(w.language,'') = COALESCE(r.language,''))`;
    await tx`DELETE FROM media_artwork WHERE media_item_id = ${f}`;

    // A receipt is addressed by its text owner and compares/restores media ids
    // inside its snapshots too. Re-pointing just the FK preserves an unusable
    // receipt. Shared-owner kinds have a structural-reference GIN index;
    // never recursively search every receipt's JSON (including chapter bytes).
    const [{ oldId, newId }] = await tx<{ oldId: string; newId: string }[]>`
        SELECT ${f}::text AS "oldId", ${t}::text AS "newId"`;
    const receipts = await tx<
        {
            id: string;
            owner: string;
            media_item_id: string | null;
            kind: string;
            before_state: postgres.JSONValue;
            after_state: postgres.JSONValue;
        }[]
    >`
        SELECT id,owner,media_item_id,kind,before_state,after_state FROM admin_media_change_receipts
        WHERE id IN (
            SELECT id FROM admin_media_change_receipts WHERE media_item_id=${f}
            UNION
            SELECT id FROM admin_media_change_receipts WHERE owner=${oldId}
            UNION
            SELECT id FROM admin_media_change_receipts WHERE undone_at IS NULL
                AND (kind LIKE 'file-mapping:%' OR kind LIKE 'file-chapters:%'
                    OR kind IN ('segments','episode-exchange'))
                AND (admin_media_change_reference_ids(before_state)
                    || admin_media_change_reference_ids(after_state)) ? ${oldId}
        ) FOR UPDATE`;
    for (const receipt of receipts) {
        const before = rekeyReceiptState(receipt.before_state, receipt.kind, oldId, newId);
        const after = rekeyReceiptState(receipt.after_state, receipt.kind, oldId, newId);
        if (
            receipt.owner !== oldId &&
            receipt.media_item_id !== oldId &&
            JSON.stringify(before) === JSON.stringify(receipt.before_state) &&
            JSON.stringify(after) === JSON.stringify(receipt.after_state)
        )
            continue;
        result.moved += (
            await tx`UPDATE admin_media_change_receipts
            SET owner=CASE WHEN owner=${oldId} THEN ${newId} ELSE owner END,
                media_item_id=CASE WHEN media_item_id=${f} THEN ${t} ELSE media_item_id END,
                before_state=${tx.json(before)},after_state=${tx.json(after)}
            WHERE id=${receipt.id}`
        ).count;
    }

    for (const { table, column } of PLAIN_TABLES) {
        result.moved += (
            await tx`UPDATE ${tx(table)} SET ${tx(column)} = ${t} WHERE ${tx(column)} = ${f}`
        ).count;
    }

    // Partial unique (user_id, media_id, source, source_event_id) WHERE
    // source_event_id IS NOT NULL: events without one never collide.
    await tally(
        () => tx`
            UPDATE user_media_events AS r SET media_id = ${t}
            WHERE r.media_id = ${f}
              AND (r.source_event_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM user_media_events w
                  WHERE w.media_id = ${t} AND w.user_id = r.user_id
                    AND w.source = r.source AND w.source_event_id = r.source_event_id
              ))
        `,
        () => tx`DELETE FROM user_media_events WHERE media_id = ${f}`,
    );

    // Partial unique (user_id, event_id, track_id) WHERE event_id IS NOT NULL.
    await tally(
        () => tx`
            UPDATE music_listen_events AS r SET track_id = ${t}
            WHERE r.track_id = ${f}
              AND (r.event_id IS NULL OR NOT EXISTS (
                  SELECT 1 FROM music_listen_events w
                  WHERE w.track_id = ${t} AND w.user_id = r.user_id AND w.event_id = r.event_id
              ))
        `,
        () => tx`DELETE FROM music_listen_events WHERE track_id = ${f}`,
    );

    // Entries of these playlists move or vanish: bump their revision first.
    await tx`
        UPDATE playlists SET revision = revision + 1, updated_at = NOW()
        WHERE id IN (SELECT playlist_id FROM playlist_items WHERE media_id = ${f})
    `;

    // Unique (playlist_id, media_id, COALESCE(season,-1), COALESCE(episode,-1)).
    await tally(
        () => tx`
            UPDATE playlist_items AS r SET media_id = ${t}
            WHERE r.media_id = ${f}
              AND NOT EXISTS (
                  SELECT 1 FROM playlist_items w
                  WHERE w.media_id = ${t} AND w.playlist_id = r.playlist_id
                    AND COALESCE(w.season_number, -1) = COALESCE(r.season_number, -1)
                    AND COALESCE(w.episode_number, -1) = COALESCE(r.episode_number, -1)
              )
        `,
        () => tx`DELETE FROM playlist_items WHERE media_id = ${f}`,
    );

    // One live review per (media, user); chats, pins and deleted reviews never collide.
    await tally(
        () => tx`
            UPDATE media_annotations AS r SET media_id = ${t}
            WHERE r.media_id = ${f}
              AND NOT (
                  r.type = 'review' AND r.deleted_at IS NULL
                  AND EXISTS (
                      SELECT 1 FROM media_annotations w
                      WHERE w.media_id = ${t} AND w.user_id = r.user_id
                        AND w.type = 'review' AND w.deleted_at IS NULL
                  )
              )
        `,
        () => tx`DELETE FROM media_annotations WHERE media_id = ${f}`,
    );

    // Partial unique (user_id, provider, COALESCE(media_id::text, external_ref, ''))
    // over recurring outcomes; terminal rows are history and never collide.
    await tally(
        () => tx`
            UPDATE watch_sync_activity AS r SET media_id = ${t}
            WHERE r.media_id = ${f}
              AND NOT (
                  (r.outcome = 'skipped' OR (r.outcome = 'failed' AND r.terminal = false))
                  AND EXISTS (
                      SELECT 1 FROM watch_sync_activity w
                      WHERE w.user_id = r.user_id AND w.provider = r.provider
                        AND COALESCE(w.media_id::text, w.external_ref, '') = ${t}::text
                        AND (w.outcome = 'skipped' OR (w.outcome = 'failed' AND w.terminal = false))
                  )
              )
        `,
        () => tx`DELETE FROM watch_sync_activity WHERE media_id = ${f}`,
    );

    // Unique (media_id, provider, media_type), plus one primary per
    // (media_id, provider): a moved id loses its primary mark rather than the
    // row when the survivor already has a primary for that provider.
    await tally(
        () => tx`
            UPDATE external_ids AS r
            SET media_id = ${t},
                is_primary = r.is_primary AND NOT EXISTS (
                    SELECT 1 FROM external_ids p
                    WHERE p.media_id = ${t} AND p.provider = r.provider AND p.is_primary
                )
            WHERE r.media_id = ${f}
              AND NOT EXISTS (
                  SELECT 1 FROM external_ids w
                  WHERE w.media_id = ${t} AND w.provider = r.provider AND w.media_type = r.media_type
              )
        `,
        () => tx`DELETE FROM external_ids WHERE media_id = ${f}`,
    );

    const fromKey = tx`replace(${f}::text, '-', '')`;
    const targetKey = (alias: string): Fragment =>
        tx`lower(replace(${tx(alias)}.target_id, '-', ''))`;

    // No unique key: every media comment moves and is normalized.
    result.moved += (
        await tx`
            UPDATE interactions AS r SET target_id = ${t}::text
            WHERE r.target_type = 'media' AND ${targetKey('r')} = ${fromKey}
        `
    ).count;

    // Unique (target_type, target_id, user_id, emoji). Legacy spellings of one
    // id are distinct texts, so the duplicate may hold several rows that all
    // normalize to the same key: only the lowest id of each moves.
    await tally(
        () => tx`
            UPDATE interaction_reactions AS r SET target_id = ${t}::text
            WHERE r.target_type = 'media' AND ${targetKey('r')} = ${fromKey}
              AND NOT EXISTS (
                  SELECT 1 FROM interaction_reactions w
                  WHERE w.target_type = 'media' AND w.user_id = r.user_id AND w.emoji = r.emoji
                    AND (${targetKey('w')} = replace(${t}::text, '-', '')
                         OR (${targetKey('w')} = ${fromKey} AND w.id < r.id))
              )
        `,
        () => tx`
            DELETE FROM interaction_reactions r
            WHERE r.target_type = 'media' AND ${targetKey('r')} = ${fromKey}
        `,
    );

    // Unique (user_id, target_id, flag_type); only flags whose target is a
    // media row move, with the same lowest-id rule for legacy spellings.
    const mediaTypes = [...MEDIA_FLAG_TARGET_TYPES];
    await tally(
        () => tx`
            UPDATE user_media_flags AS r SET target_id = ${t}::text
            WHERE r.target_type = ANY(${mediaTypes}::text[]) AND ${targetKey('r')} = ${fromKey}
              AND NOT EXISTS (
                  SELECT 1 FROM user_media_flags w
                  WHERE w.user_id = r.user_id AND w.flag_type = r.flag_type
                    AND (${targetKey('w')} = replace(${t}::text, '-', '')
                         OR (${targetKey('w')} = ${fromKey}
                             AND w.target_type = ANY(${mediaTypes}::text[]) AND w.id < r.id))
              )
        `,
        () => tx`
            DELETE FROM user_media_flags r
            WHERE r.target_type = ANY(${mediaTypes}::text[]) AND ${targetKey('r')} = ${fromKey}
        `,
    );

    // Inbound aliases follow the duplicate to the survivor; the survivor never
    // aliases itself.
    result.moved += (
        await tx`
            UPDATE media_items
            SET canonical_id = CASE WHEN id = ${t} THEN NULL ELSE ${t} END
            WHERE canonical_id = ${f}
        `
    ).count;

    return result;
}

/** The duplicate's state row (`d`) saw a later event than the survivor's (`w`). */
function dupIsLater(tx: postgres.Sql): Fragment {
    return tx`(d.last_event_at IS NOT NULL AND (w.last_event_at IS NULL OR d.last_event_at > w.last_event_at))`;
}

/** A uuid parameter, normalized by Postgres to its dashed lowercase text. */
function uuidParam(tx: postgres.Sql, id: string): Fragment {
    return tx`${id}::uuid`;
}

/** Rewrite semantic media references, never file/candidate/receipt ids or user text. */
function rekeyReceiptState(
    state: postgres.JSONValue,
    kind: string,
    from: string,
    to: string,
): postgres.JSONValue {
    const mediaKeys = new Set([
        'media_item_id',
        'media_id',
        'mediaItemId',
        'mediaId',
        'seriesId',
        'episodeId',
        'parentId',
        'canonicalId',
        'parent_id',
        'canonical_id',
        'firstId',
        'secondId',
    ]);
    const mediaString = (value: postgres.JSONValue): postgres.JSONValue =>
        typeof value === 'string' && value.toLowerCase() === from ? to : value;
    function visit(
        value: postgres.JSONValue,
        path: string[],
        mediaArray = false,
    ): postgres.JSONValue {
        if (Array.isArray(value)) {
            const mapped = value.map((item) => visit(item, path, mediaArray));
            const name = path.at(-1);
            // Captures order rows by media id; a changed UUID can change that order.
            if (name === 'items' || name === 'inputs')
                mapped.sort((a, b) => rowKey(a, 'id').localeCompare(rowKey(b, 'id')));
            if (name === 'owners')
                mapped.sort((a, b) =>
                    String(Array.isArray(a) ? a[0] : '').localeCompare(
                        String(Array.isArray(b) ? b[0] : ''),
                    ),
                );
            if (name === 'links')
                mapped.sort((a, b) => {
                    const aRow = linkRow(a),
                        bRow = linkRow(b);
                    const fields = kind.startsWith('file-mapping:')
                        ? ['file_id', 'media_item_id']
                        : ['media_item_id', 'file_id'];
                    return (
                        fields
                            .map((field) => rowKey(aRow, field).localeCompare(rowKey(bRow, field)))
                            .find((order) => order !== 0) ?? 0
                    );
                });
            return mapped;
        }
        if (!value || typeof value !== 'object') return mediaArray ? mediaString(value) : value;
        return Object.fromEntries(
            Object.entries(value).map(([key, child]) => {
                if (kind.startsWith('output:') && path.length === 0 && key === 'value')
                    return [key, child];
                if (
                    mediaKeys.has(key) ||
                    (key === 'owner' && path[0] === 'providers') ||
                    (key === 'id' && ['items', 'inputs'].includes(path.at(-1) ?? ''))
                )
                    return [key, mediaString(child)];
                if (
                    path[0] === 'urls' &&
                    typeof child === 'string' &&
                    child.startsWith(`/api/image/custom/${from}/`)
                )
                    return [
                        key,
                        `/api/image/custom/${to}/${child.slice(`/api/image/custom/${from}/`.length)}`,
                    ];
                return [
                    key,
                    visit(
                        child,
                        [...path, key],
                        ['ids', 'owners', 'mediaIds', 'mediaItemIds', 'episodeIds'].includes(key),
                    ),
                ];
            }),
        );
    }
    function rowKey(value: postgres.JSONValue, key: string): string {
        return value && typeof value === 'object' && !Array.isArray(value)
            ? String((value as Record<string, postgres.JSONValue>)[key] ?? '')
            : '';
    }
    function linkRow(value: postgres.JSONValue): postgres.JSONValue {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
        return (value as Record<string, postgres.JSONValue>).link ?? value;
    }
    return visit(state, []);
}
