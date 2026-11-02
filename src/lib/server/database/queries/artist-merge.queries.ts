// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Query functions for artist collaboration merging.
 */
import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { insertAdminAuditEvent } from './admin-audit.queries.js';
import { Logger } from '../../utils/logger.js';
import { withTx } from '../with-tx.js';
import { bulkSetLockMediaItems } from './media-items.queries.js';
import { collaborationNeedsReviewSql } from './collaboration-review.queries.js';
import { mediaReferenceGuard, noOperatorCurationSql } from './media-retention.queries.js';
import {
    lockMediaPair,
    MediaReferenceMoveRefusedError,
    moveMediaReferences,
} from './media-reference-migration.queries.js';

const logger = Logger.for('ArtistMergeQueries');

/**
 * SQLSTATEs a reference move can hit that must not abort the caller's merge:
 * unique / foreign-key violations from an index the move does not model,
 * deadlock, serialization failure, lock and statement timeout.
 */
const MOVE_FALLBACK_SQLSTATES = new Set(['23505', '23503', '40P01', '40001', '55P03', '57014']);

/**
 * Find all artist records whose title contains collaboration separators.
 *
 * The token list covers every joiner the scanner stores unsplit: the strong
 * markers plus the ambiguous " & ", " + ", " und " and " and ". Matching is only
 * a candidate filter — the merge decides each row with library evidence
 * (`resolveArtistCredit`), so "Peter und die Firma", "Ich und Ich" and "Rob &
 * Chris" match this pattern and are still left whole.
 *
 * Keep this list in sync with the separators in `artist-credit.ts`: a
 * marker the scanner splits on but this query does not match leaves every row
 * created *before* that marker was added combined forever, because this pass is
 * the only thing that retro-splits already-stored artists. That is exactly what
 * happened to " x " ("Liora Vale x Lantern Pitch x Lanternlovers United") — the
 * scanner learned it, this query did not. Space-flanking keeps "x" from
 * matching inside names like "Lanternxman".
 *
 * The two marker regexes below are the backslash rendering of ONE table,
 * `$lib/shared/artist-conjunction.ts`, shared with the hygiene fragment that
 * LISTS these same rows (`music-hygiene.queries.ts`). Edit that table, not these
 * literals: `artist-merge.queries.test.ts` asserts the emitted SQL still is the
 * shared rendering, and that module's own suite proves what it matches. Note
 * `\\s` and `\\.` — a single backslash inside a template literal is stripped by
 * JS before Postgres sees it, turning an escaped dot into "any character".
 *
 * Rows flagged `custom_metadata.no_split = true` are excluded. That flag is the
 * operator escape hatch for the inherent ambiguity of "X & Y": it can be a real
 * collaboration ("Aria Fenwick & Nora Vale") or one act's name ("Above &
 * Lanterns"), and no string-only heuristic distinguishes them. Curators flag the
 * single-act rows in their own library (data), so no artist names are hardcoded
 * in this shared code.
 * MusicBrainz-identified acts are protected too: preview rejects them, so they
 * must not enter either the scanner queue or the hygiene queue.
 */
export async function findCollaborationArtists(
    sql: postgres.Sql,
): Promise<{ id: string; title: string; library_group_id: string | null }[]> {
    const needsReview = collaborationNeedsReviewSql(sql, 'mi');
    return sql<{ id: string; title: string; library_group_id: string | null }[]>`
        SELECT mi.id, mi.title, mi.library_group_id FROM media_items mi
        WHERE mi.media_type = 'artist'
          AND mi.status = 'active'
          AND mi.parent_id IS NULL
          AND COALESCE(mi.custom_metadata->>'no_split', '') <> 'true'
          AND COALESCE(mi.custom_metadata->>'musicbrainz_artist_id', '') = ''
          AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id=mi.id
            AND ei.provider='musicbrainz' AND ei.external_id<>'')
          AND ${needsReview}
          AND (
            mi.title ~* '\\s+(feat\\.?|ft\\.?|featuring|vs\\.?|x|und|and)\\s+'
            OR mi.title ~ '\\s+[&+]\\s+'
          )
    `;
}

export async function getTrackIdsForArtist(sql: postgres.Sql, artistId: string): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT t.id FROM media_items t
        JOIN media_items album ON t.parent_id = album.id AND album.media_type = 'album'
        WHERE t.media_type = 'track' AND album.parent_id = ${artistId}
    `;
    return rows.map((r) => r.id);
}

/**
 * Track ids that reference an artist through `custom_metadata.additional_artist_ids`
 * rather than album parentage. This is how a *compilation* track credits a
 * per-track artist: the track sits under a "Various Artists" album, so the only
 * link to the real performer is this id array. The merge pass must remap these
 * too, otherwise splitting a combined artist ("A und B") leaves compilation
 * tracks pointing at the deleted combined row.
 */
export async function getTrackIdsReferencingArtistId(
    sql: postgres.Sql,
    artistId: string,
): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE media_type = 'track'
          AND custom_metadata->'additional_artist_ids' @> jsonb_build_array(${artistId}::text)
    `;
    return rows.map((r) => r.id);
}

export async function getAlbumsForArtist(
    sql: postgres.Sql,
    artistId: string,
): Promise<{ id: string; title: string }[]> {
    return sql<{ id: string; title: string }[]>`
        SELECT id, title FROM media_items
        WHERE media_type = 'album' AND parent_id = ${artistId}
    `;
}

export async function findDuplicateAlbumByTitle(
    sql: postgres.Sql,
    artistId: string,
    title: string,
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE media_type = 'album'
          AND parent_id = ${artistId}
          AND status = 'active' AND metadata_locked IS NOT TRUE
          -- Drop everything but letters, digits and spaces (any script: the
          -- database ctype is UTF-8, so [:alnum:] covers CJK/Cyrillic/accents),
          -- then collapse spaces. The old '[^a-z0-9 ]' strip reduced any
          -- non-Latin title to '' and so merged unrelated albums ("愛" with
          -- "夢") inside the artist merge passes. A title with no letter or
          -- digit at all only matches itself.
          AND (
              (btrim(regexp_replace(regexp_replace(LOWER(title), '[^[:alnum:][:space:]]', '', 'g'), '\\s+', ' ', 'g'))
                 = btrim(regexp_replace(regexp_replace(LOWER(${title}), '[^[:alnum:][:space:]]', '', 'g'), '\\s+', ' ', 'g'))
               AND regexp_replace(LOWER(${title}), '[^[:alnum:]]', '', 'g') <> '')
              OR LOWER(TRIM(title)) = LOWER(TRIM(${title}))
          )
        ORDER BY created_at, id
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

export async function reparentTracksToAlbum(
    sql: postgres.Sql,
    fromAlbumId: string,
    toAlbumId: string,
): Promise<void> {
    await sql`
        UPDATE media_items
        SET parent_id = ${toAlbumId}
        WHERE media_type = 'track' AND parent_id = ${fromAlbumId}
          AND EXISTS (SELECT 1 FROM media_items a WHERE a.id=${fromAlbumId} AND a.metadata_locked IS NOT TRUE)
          AND EXISTS (SELECT 1 FROM media_items a WHERE a.id=${toAlbumId} AND a.metadata_locked IS NOT TRUE)
    `;
}

/**
 * Deletes the album only if it has no track children and nothing references
 * it. Atomic check-and-delete via NOT EXISTS — a concurrent scan adding a
 * track between a caller's count-check and the delete won't lose the parent.
 *
 * With a `targetAlbumId` — the album that received its tracks — a childless
 * album first hands every user reference (history, playlist, rating, …) to
 * the target, keeping the target's row on a conflict, and is then deleted.
 * Without a target, when the move is refused (the target vanished or is not
 * an album), or if the delete still fails (operator curation — locked
 * metadata, uploaded artwork, a custom image URL — or a reference the move
 * does not cover), a referenced album is kept rather than
 * cascading those rows away: when it has no children at all it becomes a
 * soft-deleted, file-less row (status 'deleted' keeps it out of browse and of
 * the per-artist unique title index), moved under the target's artist when a
 * target is given, so the old artist can be removed. Returns true only when
 * the row was deleted.
 */
export async function deleteEmptyAlbum(
    sql: postgres.Sql,
    albumId: string,
    targetAlbumId?: string,
    ruleSource = 'album-rule',
): Promise<boolean> {
    const guardedDelete = async (db: postgres.Sql): Promise<boolean> => {
        const result = await db`
            DELETE FROM media_items mi
            WHERE mi.id = ${albumId}
              AND NOT EXISTS (
                SELECT 1 FROM media_items
                WHERE parent_id = ${albumId} AND media_type = 'track'
              )
              AND NOT EXISTS (SELECT 1 FROM media_items alias WHERE alias.canonical_id = mi.id)
              AND ${noOperatorCurationSql(db, 'mi')}
              AND ${mediaReferenceGuard(db, 'mi')}
        `;
        return result.count > 0;
    };

    const normalizedId = (id: string): string => id.toLowerCase().replace(/-/g, '');
    const hasTarget =
        targetAlbumId !== undefined && normalizedId(targetAlbumId) !== normalizedId(albumId);
    const softDelete = async (db: postgres.Sql): Promise<void> => {
        const target = hasTarget
            ? db`(SELECT t.parent_id FROM media_items t WHERE t.id = ${targetAlbumId})`
            : db`mi.parent_id`;
        await db`
            UPDATE media_items mi
            SET status = 'deleted',
                has_files = false,
                parent_id = COALESCE(${target}, mi.parent_id),
                updated_at = NOW()
            WHERE mi.id = ${albumId}
              AND mi.media_type = 'album'
              AND NOT EXISTS (SELECT 1 FROM media_items c WHERE c.parent_id = ${albumId})
        `;
    };

    // 'skipped': nothing moved (album populated or gone), soft-delete outside.
    const moveAndDelete = (target: string): Promise<'deleted' | 'soft-deleted' | 'skipped'> =>
        withTx(sql, async (tx) => {
            await lockMediaPair(tx, albumId, target);
            // Row lock first, then the childless check in its own statement:
            // after waiting on a concurrent track insert, a fresh snapshot
            // sees the track and the album keeps its references.
            const [locked] = await tx<{ id: string }[]>`
                SELECT mi.id FROM media_items mi
                WHERE mi.id = ${albumId} AND mi.media_type = 'album'
                FOR UPDATE
            `;
            if (!locked) return 'skipped' as const;
            const [child] =
                await tx`SELECT 1 FROM media_items WHERE parent_id = ${albumId} LIMIT 1`;
            if (child) return 'skipped' as const;
            const [parents] = await tx<{ old_parent: string | null; new_parent: string | null }[]>`
                SELECT a.parent_id AS old_parent, b.parent_id AS new_parent
                FROM media_items a JOIN media_items b ON b.id=${target} WHERE a.id=${albumId}
            `;
            await moveMediaReferences(tx, albumId, target);
            await insertAdminAuditEvent(tx, {
                instanceId: config.INSTANCE_ID,
                actor: 'system task',
                action: 'music.album.merge',
                target: albumId,
                outcome: 'ok',
                detail: {
                    albumId,
                    survivorAlbumId: target,
                    oldParent: parents?.old_parent,
                    newParent: parents?.new_parent,
                    ruleSource,
                },
            });
            if (await guardedDelete(tx)) return 'deleted' as const;
            // References already moved: soft-delete in the same transaction so
            // a crash cannot leave an active album without them.
            await softDelete(tx);
            return 'soft-deleted' as const;
        }).catch((error: unknown) => {
            // The savepoint is rolled back, so nothing moved; fall back to the
            // soft delete instead of failing the caller's whole merge.
            if (error instanceof MediaReferenceMoveRefusedError) return 'skipped' as const;
            const code =
                typeof error === 'object' && error !== null && 'code' in error
                    ? String(error.code)
                    : '';
            if (MOVE_FALLBACK_SQLSTATES.has(code)) {
                logger.warn('Album reference move failed; keeping the album soft-deleted', {
                    albumId,
                    targetAlbumId: target,
                    code,
                    error: error instanceof Error ? error.message : String(error),
                });
                return 'skipped' as const;
            }
            throw error;
        });

    if (hasTarget && targetAlbumId) {
        const outcome = await moveAndDelete(targetAlbumId);
        if (outcome === 'deleted') return true;
        if (outcome === 'soft-deleted') return false;
    } else if (await guardedDelete(sql)) {
        return true;
    }
    await softDelete(sql);
    return false;
}

/** A manual assignment must validate the current rows while holding their locks. */
export class ManualAlbumArtistAssignmentError extends Error {
    constructor(public readonly reason: 'missing-album' | 'not-album' | 'missing-artist') {
        super(reason);
    }
}

export async function reparentAlbumToArtist(
    sql: postgres.Sql,
    albumId: string,
    artistId: string,
    options: { respectMetadataLock?: boolean; ruleSource?: string; manualActor?: string } = {},
): Promise<string | undefined> {
    return withTx(sql, async (tx) => {
        if (options.manualActor !== undefined) {
            // Match NFO settling's UUID-sorted media-owner acquisition. NO KEY
            // UPDATE protects status/type/title while allowing scanner FK
            // KEY SHARE checks, so album-first automatic parent writes cannot
            // form a second cycle through their target artist.
            await tx`SELECT id FROM media_items WHERE id=ANY(${[albumId, artistId]}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
        }
        const albumLock = options.manualActor !== undefined ? tx`` : tx`FOR UPDATE`;
        const [old] = await tx<
            { parent_id: string | null; media_type: string; status: string }[]
        >`SELECT parent_id, media_type, status FROM media_items WHERE id=${albumId} ${albumLock}`;
        if (options.manualActor !== undefined) {
            if (!old || old.status !== 'active')
                throw new ManualAlbumArtistAssignmentError('missing-album');
            if (old.media_type !== 'album') throw new ManualAlbumArtistAssignmentError('not-album');
            // Both owners are already locked; re-read and validate their
            // current state after any wait, without changing the lock order.
            const [artist] = await tx<{ title: string }[]>`
                SELECT COALESCE(title, '') AS title FROM media_items
                WHERE id=${artistId} AND media_type='artist' AND status='active'
            `;
            if (!artist) throw new ManualAlbumArtistAssignmentError('missing-artist');
            if (old.parent_id !== artistId) {
                await tx`UPDATE media_items SET parent_id=${artistId}, updated_at=NOW() WHERE id=${albumId}`;
            }
            // Same-parent confirmation is intentional curation too. Reuse the
            // editor policy: refresh actor/time even when already locked.
            await bulkSetLockMediaItems(tx, [albumId], true, options.manualActor);
            return artist.title;
        }
        if (!old || old.parent_id === artistId) return;
        const changed = await tx`
            UPDATE media_items SET parent_id=${artistId}, updated_at=NOW()
            WHERE id=${albumId} AND (${options.respectMetadataLock !== true} OR metadata_locked IS NOT TRUE)
        `;
        if (changed.count && options.respectMetadataLock) {
            await insertAdminAuditEvent(tx, {
                instanceId: config.INSTANCE_ID,
                actor: 'system task',
                action: 'music.album.reparent',
                target: albumId,
                outcome: 'ok',
                detail: {
                    albumId,
                    oldParent: old.parent_id,
                    newParent: artistId,
                    ruleSource: options.ruleSource ?? 'album-rule',
                },
            });
        }
    });
}

export async function mergeAdditionalArtistIds(
    sql: postgres.Sql,
    trackId: string,
    artistIds: string[],
): Promise<boolean> {
    if (artistIds.length === 0) return false;
    // Build from the row as locked by UPDATE, not a preceding SELECT: a manual
    // confirmation can otherwise be overwritten between the two statements.
    const changed = await sql`
        UPDATE media_items t
        SET custom_metadata = jsonb_set(COALESCE(t.custom_metadata, '{}'::jsonb),
            '{additional_artist_ids}', (
                SELECT COALESCE(jsonb_agg(id ORDER BY first_ord), '[]'::jsonb)
                FROM (
                    SELECT id, MIN(ord) AS first_ord
                    FROM (
                        SELECT value AS id, ord
                        FROM jsonb_array_elements_text(
                            CASE WHEN jsonb_typeof(t.custom_metadata->'additional_artist_ids') = 'array'
                                 THEN t.custom_metadata->'additional_artist_ids' ELSE '[]'::jsonb END
                        ) WITH ORDINALITY AS existing(value, ord)
                        UNION ALL
                        SELECT value, 1000000 + ord
                        FROM unnest(${artistIds}::text[]) WITH ORDINALITY AS incoming(value, ord)
                    ) all_ids GROUP BY id
                ) deduped
            ))
        WHERE t.id = ${trackId} AND t.media_type = 'track' AND t.metadata_locked IS NOT TRUE
    `;
    return changed.count > 0;
}

/** Track `custom_metadata` arrays of artist ids that a merge rewrites. */
const TRACK_ARTIST_ID_ARRAY_KEYS = [
    'additional_artist_ids',
    'file_artist_ids',
    'album_artist_ids',
    'remixer_artist_ids',
    'title_remixer_artist_ids',
    'independent_remixer_artist_ids',
] as const;

/**
 * Replaces `oldArtistId` with `newArtistId` in every track's artist-id arrays
 * ({@link TRACK_ARTIST_ID_ARRAY_KEYS}) and in `track_artist_credits`. Used when
 * merging an artist into another.
 *
 * Each array keeps its first-occurrence order and drops the duplicate a rename
 * can create. A credit keeps its other fields and only its `id` changes;
 * credits are deduplicated on id (or `name:` + credited_name when id-less),
 * keeping the earliest.
 *
 * One UPDATE: every key is rewritten in the same pass, and only keys that
 * contain the old id. The candidate rows come from containment tests on the
 * whole `custom_metadata`, which `idx_media_items_custom_metadata` (GIN,
 * partial on `custom_metadata <> '{}'`) answers; that predicate is repeated
 * literally so the planner can use the index.
 */
export async function replaceArtistIdInTracks(
    sql: postgres.Sql,
    oldArtistId: string,
    newArtistId: string,
): Promise<void> {
    const credit = sql`jsonb_build_object('track_artist_credits',
        jsonb_build_array(jsonb_build_object('id', ${oldArtistId}::text)))`;
    const remixerCredit = sql`jsonb_build_object('track_remixer_credits',
        jsonb_build_array(jsonb_build_object('id', ${oldArtistId}::text)))`;
    const candidates = TRACK_ARTIST_ID_ARRAY_KEYS.reduce(
        (acc, key) =>
            sql`${acc} OR t.custom_metadata @> jsonb_build_object(${key}::text,
                jsonb_build_array(${oldArtistId}::text))`,
        sql`t.custom_metadata @> ${credit} OR t.custom_metadata @> ${remixerCredit}`,
    );
    await sql`
        UPDATE media_items t
        SET custom_metadata = t.custom_metadata
            || COALESCE((
                SELECT jsonb_object_agg(k.key, (
                    SELECT jsonb_agg(value ORDER BY first_ord)
                    FROM (
                        SELECT value, min(ord) AS first_ord
                        FROM (
                            SELECT CASE WHEN elem = to_jsonb(${oldArtistId}::text)
                                        THEN to_jsonb(${newArtistId}::text) ELSE elem END AS value, ord
                            FROM jsonb_array_elements(t.custom_metadata->k.key)
                                WITH ORDINALITY entries(elem, ord)
                        ) remapped GROUP BY value
                    ) unique_ids
                ))
                FROM unnest(${sql.array([...TRACK_ARTIST_ID_ARRAY_KEYS])}::text[]) AS k(key)
                WHERE jsonb_typeof(t.custom_metadata->k.key) = 'array'
                  AND t.custom_metadata->k.key @> jsonb_build_array(${oldArtistId}::text)
            ), '{}'::jsonb)
            || CASE
                WHEN jsonb_typeof(t.custom_metadata->'track_artist_credits') = 'array'
                 AND t.custom_metadata->'track_artist_credits'
                     @> jsonb_build_array(jsonb_build_object('id', ${oldArtistId}::text))
                THEN jsonb_build_object('track_artist_credits', (
                    SELECT jsonb_agg(credit ORDER BY ord)
                    FROM (
                        SELECT DISTINCT ON (COALESCE(credit->>'id', 'name:' || (credit->>'credited_name'))) credit, ord
                        FROM (
                            SELECT CASE WHEN entry->>'id' = ${oldArtistId}
                                        THEN entry || jsonb_build_object('id', ${newArtistId}::text)
                                        ELSE entry END AS credit, ord
                            FROM jsonb_array_elements(t.custom_metadata->'track_artist_credits')
                                WITH ORDINALITY entries(entry, ord)
                        ) remapped
                        ORDER BY COALESCE(credit->>'id', 'name:' || (credit->>'credited_name')), ord
                    ) unique_credits
                ))
                ELSE '{}'::jsonb
            END
            || CASE
                WHEN jsonb_typeof(t.custom_metadata->'track_remixer_credits') = 'array'
                 AND t.custom_metadata->'track_remixer_credits'
                     @> jsonb_build_array(jsonb_build_object('id', ${oldArtistId}::text))
                THEN jsonb_build_object('track_remixer_credits', (
                    SELECT jsonb_agg(credit ORDER BY ord)
                    FROM (
                        SELECT DISTINCT ON (COALESCE(credit->>'id', 'name:' || (credit->>'credited_name'))) credit, ord
                        FROM (
                            SELECT CASE WHEN entry->>'id' = ${oldArtistId}
                                        THEN entry || jsonb_build_object('id', ${newArtistId}::text)
                                        ELSE entry END AS credit, ord
                            FROM jsonb_array_elements(t.custom_metadata->'track_remixer_credits')
                                WITH ORDINALITY entries(entry, ord)
                        ) remapped
                        ORDER BY COALESCE(credit->>'id', 'name:' || (credit->>'credited_name')), ord
                    ) unique_credits
                ))
                ELSE '{}'::jsonb
            END
        WHERE t.media_type = 'track'
          AND t.metadata_locked IS NOT TRUE
          AND t.custom_metadata <> '{}'::jsonb
          AND (${candidates})
    `;
}

/**
 * Rebuilds `custom_metadata.additional_artist_ids` on every track that
 * currently carries a duplicate of `artistId`, keeping the FIRST occurrence
 * of each distinct element in original array order.
 *
 * Needed because `replaceArtistIdInTracks` is a pure rename (dead id →
 * canonical id) and does not dedupe: a track that already referenced the
 * canonical artist AND the dead alias (e.g. `[canonicalId, deadId]`) ends up
 * with the canonical id twice after the rename. Order matters here — the
 * display/queue code zips `additional_artist_ids` by position against a
 * parallel tag-derived array, so this must preserve first-occurrence order,
 * not just any order.
 *
 * Uses `jsonb_array_elements(...) WITH ORDINALITY` to capture each element's
 * original position, `DISTINCT ON (elem)` (ordered by position ascending) to
 * keep only the first occurrence of each distinct element, then re-aggregates
 * ordered by that captured position so the surviving elements come back in
 * their original relative order.
 *
 * Scoped to rows containing `artistId` (not a table-wide sweep) so callers
 * can target just the artist they touched. Only rewrites rows that actually
 * contain a duplicate (count mismatch guard) — a no-op elsewhere.
 *
 * Returns the number of track rows deduped.
 */
export async function dedupeAdditionalArtistIds(
    sql: postgres.Sql,
    artistId: string,
): Promise<number> {
    const result = await sql`
        UPDATE media_items t
        SET custom_metadata = jsonb_set(
            t.custom_metadata,
            '{additional_artist_ids}',
            (
                SELECT jsonb_agg(elem ORDER BY first_ord)
                FROM (
                    SELECT DISTINCT ON (elem) elem, ord AS first_ord
                    FROM jsonb_array_elements(t.custom_metadata->'additional_artist_ids')
                        WITH ORDINALITY AS x(elem, ord)
                    ORDER BY elem, ord ASC
                ) dedup
            )
        )
        WHERE t.media_type = 'track'
          AND t.status = 'active'
          AND t.metadata_locked IS NOT TRUE
          AND jsonb_typeof(t.custom_metadata->'additional_artist_ids') = 'array'
          AND t.custom_metadata->'additional_artist_ids' @> jsonb_build_array(${artistId}::text)
          AND (
              SELECT COUNT(*) FROM jsonb_array_elements(t.custom_metadata->'additional_artist_ids')
          ) != (
              SELECT COUNT(*) FROM (
                  SELECT DISTINCT elem
                  FROM jsonb_array_elements(t.custom_metadata->'additional_artist_ids') elem
              ) distinct_elems
          )
    `;
    return result.count;
}

/**
 * Set or clear the `custom_metadata.no_split` flag on an artist row.
 *
 * A targeted jsonb merge — it does NOT replace the whole `custom_metadata`
 * object and does NOT lock the row's metadata, so it is safe to toggle without
 * disturbing enrichment. Setting merges `{ "no_split": true }`; clearing removes
 * the key entirely (so `COALESCE(... ->> 'no_split', '')` reads empty again).
 *
 * Returns true when a matching active artist row was updated.
 */
export async function setArtistNoSplit(
    sql: postgres.Sql,
    artistId: string,
    value: boolean,
): Promise<boolean> {
    const result = value
        ? await sql`
            UPDATE media_items
            SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb) || '{"no_split": true}'::jsonb
            WHERE id = ${artistId} AND media_type = 'artist' AND status = 'active'
        `
        : await sql`
            UPDATE media_items
            SET custom_metadata = COALESCE(custom_metadata, '{}'::jsonb) - 'no_split'
            WHERE id = ${artistId} AND media_type = 'artist' AND status = 'active'
        `;
    return result.count > 0;
}

/**
 * Deletes the artist only if it has no album children.
 * Atomic — see deleteEmptyAlbum for rationale. Returns true on actual delete.
 */
export async function deleteEmptyArtist(sql: postgres.Sql, artistId: string): Promise<boolean> {
    const result = await sql`
        DELETE FROM media_items mi
        WHERE mi.id = ${artistId} AND mi.media_type = 'artist'
          AND ${noOperatorCurationSql(sql, 'mi')}
          AND ${mediaReferenceGuard(sql, 'mi')}
          AND NOT EXISTS (SELECT 1 FROM media_items alias WHERE alias.canonical_id = mi.id)
          AND NOT EXISTS (SELECT 1 FROM media_artwork art WHERE art.media_item_id = mi.id)
          AND NOT EXISTS (
            SELECT 1 FROM media_items
            WHERE parent_id = ${artistId} AND media_type = 'album'
          )
          AND NOT EXISTS (
            SELECT 1 FROM media_items t WHERE t.media_type='track'
              AND (t.custom_metadata->'additional_artist_ids' @> jsonb_build_array(mi.id::text)
                OR t.custom_metadata->'file_artist_ids' @> jsonb_build_array(mi.id::text)
                OR t.custom_metadata->'album_artist_ids' @> jsonb_build_array(mi.id::text)
                OR t.custom_metadata->'remixer_artist_ids' @> jsonb_build_array(mi.id::text)
                OR t.custom_metadata->'title_remixer_artist_ids' @> jsonb_build_array(mi.id::text)
                OR t.custom_metadata->'independent_remixer_artist_ids' @> jsonb_build_array(mi.id::text)
                OR t.custom_metadata->'track_artist_credits' @> jsonb_build_array(jsonb_build_object('id', mi.id::text))
                OR t.custom_metadata->'track_remixer_credits' @> jsonb_build_array(jsonb_build_object('id', mi.id::text)))
          )
    `;
    return result.count > 0;
}

/**
 * Everything artist-credit evidence is built from (`artist-credit.ts`): every
 * distinct artist tag string on an active track — the scalar ARTIST and
 * ALBUMARTIST plus each entry of the multi-value arrays — and the titles of
 * artist rows that are known single acts (operator `no_split` flag, or an
 * NFO-supplied MusicBrainz id).
 *
 * Tags, not artist rows, on purpose: the rows are what the old splitter
 * produced, so asking "does an artist called Rob exist?" would read its own
 * mistake back as evidence. The tags are what the files actually say.
 */
export async function listArtistCreditEvidenceSources(
    sql: postgres.Sql,
): Promise<{ tags: string[]; knownActs: string[] }> {
    // Each track's metadata (~4 KB, TOAST-compressed) is decoded once into the
    // four fields; four branches each extracting from the raw column decoded it
    // four to six times (prod: 1.18M -> 163k buffers, 1.2 s -> 0.5 s, same 7,621
    // tags). jsonb_to_record raises on a non-object, so a non-object is replaced
    // by '{}' inside the call (a WHERE filter has no evaluation-order guarantee);
    // such rows yielded no tags before either (->> on a non-object is NULL).
    const tagRows = await sql<{ tag: string }[]>`
        WITH r AS MATERIALIZED (
            SELECT x.artist, x.album_artist, x.artists, x.album_artists
            FROM media_items mi
            CROSS JOIN LATERAL jsonb_to_record(
                CASE WHEN jsonb_typeof(mi.custom_metadata) = 'object'
                     THEN mi.custom_metadata ELSE '{}'::jsonb END
            ) AS x(artist text, album_artist text, artists jsonb, album_artists jsonb)
            WHERE mi.media_type = 'track'
              AND mi.status = 'active'
        )
        SELECT DISTINCT tag FROM (
            SELECT artist AS tag FROM r
            UNION ALL
            SELECT album_artist FROM r
            UNION ALL
            SELECT jsonb_array_elements_text(artists) FROM r
            WHERE jsonb_typeof(artists) = 'array'
            UNION ALL
            SELECT jsonb_array_elements_text(album_artists) FROM r
            WHERE jsonb_typeof(album_artists) = 'array'
        ) s
        WHERE tag IS NOT NULL AND tag <> ''
    `;
    const actRows = await sql<{ title: string }[]>`
        SELECT title FROM media_items
        WHERE media_type = 'artist'
          AND status = 'active'
          AND (
            COALESCE(custom_metadata->>'no_split', '') = 'true'
            OR COALESCE(custom_metadata->>'musicbrainz_artist_id', '') <> ''
          )
    `;
    return { tags: tagRows.map((r) => r.tag), knownActs: actRows.map((r) => r.title) };
}

/**
 * Replaces `oldArtistId` with `newArtistId` in EVERY track's
 * `additional_artist_ids`, or drops it when `newArtistId` is null. Order of the
 * other ids is kept and a repeat created by the rename is collapsed.
 *
 * Unlike {@link replaceArtistIdInTracks} this also rewrites `metadata_locked`
 * tracks and tracks of any status. It exists for the moment the old artist ROW
 * is about to disappear (admin hard delete, admin merge): a locked track that
 * kept the id would point at no row for good, and the locked-metadata promise
 * is about tag content, not about ids of rows that no longer exist.
 * Returns the number of tracks rewritten.
 */
export async function remapAdditionalArtistId(
    sql: postgres.Sql,
    oldArtistId: string,
    newArtistId: string | null,
): Promise<number> {
    const result = await sql`
        UPDATE media_items t
        SET custom_metadata = jsonb_set(
            t.custom_metadata,
            '{additional_artist_ids}',
            COALESCE((
                SELECT jsonb_agg(to_jsonb(id) ORDER BY first_ord)
                FROM (
                    SELECT id, MIN(ord) AS first_ord
                    FROM (
                        SELECT CASE WHEN value = ${oldArtistId}::text
                                    THEN ${newArtistId}::text ELSE value END AS id, ord
                        FROM jsonb_array_elements_text(t.custom_metadata->'additional_artist_ids')
                            WITH ORDINALITY AS x(value, ord)
                    ) mapped
                    WHERE id IS NOT NULL
                    GROUP BY id
                ) deduped
            ), '[]'::jsonb)
        )
        WHERE t.media_type = 'track'
          AND t.custom_metadata <> '{}'::jsonb
          AND jsonb_typeof(t.custom_metadata->'additional_artist_ids') = 'array'
          AND t.custom_metadata @> jsonb_build_object('additional_artist_ids',
                jsonb_build_array(${oldArtistId}::text))
    `;
    return result.count;
}

