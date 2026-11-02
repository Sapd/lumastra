// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Media Items Query Utilities
 *
 * Focused queries on the media_items table for plugin status reporting.
 */

import type postgres from 'postgres';
import { applyNationalAgeRating } from './age-rating-source.queries.js';
import type { FilenameTitleConfirmation } from '$lib/schemas/api-admin-unmatched-responses.js';
import type { ExtraType, ArtworkType } from '../../utils/media-extras.js';
import { resolveExternalIdToUuid } from './media-lookup.queries.js';
import { buildAutoEpisodeOrderingJoinFragment } from './episode-search.queries.js';
import type { ExternalIdProvider } from '../../utils/provider-config.js';
import { withTx } from '../with-tx.js';
import { normalizeJellyfinId } from '../../utils/jellyfin-id.js';
import { VARIOUS_ARTISTS_LABEL, isVariousArtistsName } from '$lib/shared/various-artists.js';
import {
    replaceArtistIdInTracks,
    dedupeAdditionalArtistIds,
    remapAdditionalArtistId,
} from './artist-merge.queries.js';
import { recomputeHasFilesBatch } from './media-files.queries.js';
import { buildLibraryGroupRootFilter } from './builders/library-group.builder.js';
import { refreshSortTitles } from './sort-title.queries.js';

/**
 * Count media items that have a Jellyfin external ID.
 * Used by the Jellyfin media-source plugin status report.
 */
export async function getJellyfinItemCount(sql: postgres.Sql): Promise<number> {
    const result = await sql<[{ count: string }]>`
        SELECT COUNT(DISTINCT mi.id)::text AS count
        FROM media_items mi
        JOIN external_ids ei ON ei.media_id = mi.id
        WHERE ei.provider = 'jellyfin'
    `;
    return parseInt(result[0]?.count ?? '0', 10);
}

export interface InsertScannedMediaItemParams {
    title: string;
    mediaType: string;
    year?: number;
    /**
     * Description for the item. Only populated for provider-less local media
     * from an NFO sidecar `<plot>` — matched items get their overview from
     * metadata-sync instead. NULL when absent.
     */
    overview?: string;
    parentId?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    customMetadata?: Record<string, unknown>;
    sortOrder?: number;
    runtimeSeconds?: number;
    libraryGroupId?: string;
    /**
     * `media_items.title_source` — where `title` came from. Only the music
     * scanner sets it, for tracks (see `trackTitleSource`); NULL otherwise.
     */
    titleSource?: 'tag' | 'filename';
}

/**
 * Insert a new media_items row for a file-scanner discovered item.
 * Returns the new row's UUID.
 *
 * NOTE: For 'anime' library paths, pass mediaType='tv' (the DB constraint does not
 * include 'anime' — anime series are stored as 'tv').
 */
export async function insertScannedMediaItem(
    sql: postgres.Sql,
    params: InsertScannedMediaItemParams,
): Promise<string> {
    const customMeta = params.customMetadata ?? {};
    const rows = await sql<[{ id: string }]>`
        INSERT INTO media_items (title, media_type, year, overview, parent_id, season_number, episode_number, custom_metadata, sort_order, runtime_seconds, library_group_id, title_source)
        VALUES (
            ${params.title},
            ${params.mediaType},
            ${params.year ?? null},
            ${params.overview ?? null},
            ${params.parentId ?? null},
            ${params.seasonNumber ?? null},
            ${params.episodeNumber ?? null},
            ${sql.json(customMeta as Record<string, never>)},
            ${params.sortOrder ?? null},
            ${params.runtimeSeconds ?? null},
            ${params.libraryGroupId ?? null},
            ${params.titleSource ?? null}
        )
        RETURNING id
    `;
    if (!rows[0]) {
        throw new Error(`insertScannedMediaItem: no row returned for title="${params.title}"`);
    }
    await refreshSortTitles(sql, [rows[0].id]);
    return rows[0].id;
}

/** What a local NFO sidecar contributes to an item. `certification` is already picked for the country. */
export interface LocalNfoContent {
    overview?: string;
    year?: number;
    certification?: string;
}

/**
 * Surface NFO content on the DISPLAY path. The detail modal reads overview/year
 * from `provider_metadata` (merged provider chain, 'aggregated' first) — NOT
 * from `media_items` — so a provider-less local movie needs its description in
 * an 'aggregated' provider_metadata row to render. Guarded: only fills the
 * overview/release_date keys when they are currently absent/blank, so if the
 * item is later matched and its 'aggregated' row is rebuilt from a real provider
 * (TMDB), that value wins and the NFO never competes. `year` becomes a
 * `YYYY-01-01` release_date (the modal derives the year from it).
 */
export async function applyLocalNfoDisplayMetadata(
    sql: postgres.Sql,
    mediaId: string,
    content: LocalNfoContent,
): Promise<void> {
    // The NFO's content rating sets the age rating (a weaker national source than
    // TMDB: it never replaces a rating that already came from a national
    // certification). Not gated on the metadata lock, like every age_rating writer.
    if (content.certification) {
        await applyNationalAgeRating(sql, mediaId, content.certification, { onlyFill: true });
    }

    const overview = content.overview && content.overview.trim() !== '' ? content.overview : null;
    const certification = content.certification?.trim() ? content.certification.trim() : null;
    // Only a positive year yields a release date — `<year>0000</year>` (year 0)
    // must not become a '0000-01-01' row.
    const releaseDate = content.year && content.year > 0 ? `${content.year}-01-01` : null;
    // Nothing worth writing → skip entirely (avoids inserting an empty aggregated row).
    if (overview === null && releaseDate === null && certification === null) return;
    // INSERT ... SELECT ... WHERE NOT metadata_locked makes the lock check atomic
    // with the write (no separate SELECT/TOCTOU) and also verifies the item still
    // exists. A locked/absent item yields zero source rows → no insert or update.
    await sql`
        INSERT INTO provider_metadata (media_id, provider, metadata, fetched_at)
        SELECT
            mi.id,
            'aggregated',
            jsonb_strip_nulls(
                jsonb_build_object('overview', ${overview}::text, 'release_date', ${releaseDate}::text,
                                   'certification', ${certification}::text)
            ),
            NOW()
        FROM media_items mi
        WHERE mi.id = ${mediaId} AND NOT mi.metadata_locked
        ON CONFLICT (media_id, provider) DO UPDATE SET
            metadata = provider_metadata.metadata || jsonb_strip_nulls(jsonb_build_object(
                'overview', CASE
                    WHEN (provider_metadata.metadata->>'overview') IS NULL
                         OR BTRIM(provider_metadata.metadata->>'overview') = ''
                    THEN ${overview}::text ELSE NULL END,
                'release_date', CASE
                    WHEN (provider_metadata.metadata->>'release_date') IS NULL
                    THEN ${releaseDate}::text ELSE NULL END,
                'certification', CASE
                    WHEN BTRIM(COALESCE(provider_metadata.metadata->>'certification', '')) = ''
                    THEN ${certification}::text ELSE NULL END
            )),
            updated_at = NOW()
    `;
}

/**
 * Backfill NFO-sourced content onto an already-existing local item, filling
 * only NULL/empty columns so a re-scan heals a row that was ingested before
 * NFO content was read — without ever clobbering values a later metadata sync
 * or a user edit supplied. `overview` fills only when currently NULL/blank;
 * `year` fills only when currently NULL. Skips items with `metadata_locked`
 * (an explicit user lock). Also surfaces the content on the display path via
 * applyLocalNfoDisplayMetadata (provider_metadata). Returns true when the
 * media_items row was updated.
 */
export async function backfillLocalMediaContent(
    sql: postgres.Sql,
    id: string,
    content: LocalNfoContent,
): Promise<boolean> {
    if (content.overview === undefined && content.year === undefined) {
        // Rating only: still surface it (age rating + display certification).
        if (content.certification) await applyLocalNfoDisplayMetadata(sql, id, content);
        return false;
    }
    const rows = await sql<{ id: string }[]>`
        UPDATE media_items
           SET overview = CASE
                   WHEN ${content.overview ?? null}::text IS NOT NULL
                        AND (overview IS NULL OR BTRIM(overview) = '')
                   THEN ${content.overview ?? null}::text
                   ELSE overview
               END,
               year = CASE
                   WHEN ${content.year ?? null}::int IS NOT NULL AND year IS NULL
                   THEN ${content.year ?? null}::int
                   ELSE year
               END
         WHERE id = ${id}
           AND NOT metadata_locked
           AND (
               (${content.overview ?? null}::text IS NOT NULL AND (overview IS NULL OR BTRIM(overview) = ''))
               OR (${content.year ?? null}::int IS NOT NULL AND year IS NULL)
           )
        RETURNING id
    `;
    // Also surface on the display path (provider_metadata). Self-guarding on
    // metadata_locked, so no separate lock read is needed here.
    await applyLocalNfoDisplayMetadata(sql, id, content);
    return rows.length > 0;
}

/**
 * Cheap gate for the scanner's unchanged-file fast path: return the linked
 * MOVIE item id ONLY when it has NO description on the display path — no
 * non-blank overview in its 'aggregated' provider_metadata row (what the modal
 * reads) — is not metadata_locked, and carries NO discovery provider id
 * (tmdb/imdb). Returns null otherwise so a steady-state re-scan of a complete
 * item pays just this one lookup and never re-reads the NFO from disk. Gapping
 * on the aggregated overview (not media_items.overview) matches the display
 * source. Movie-scoped because an NFO <plot> is item-level.
 */
export async function findLocalContentGapMovieByFile(
    sql: postgres.Sql,
    fileId: string,
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mfi.file_id = ${fileId}
          AND mi.media_type = 'movie'
          AND mi.status = 'active'
          AND NOT mi.is_dismissed
          AND NOT mi.metadata_locked
          AND NOT EXISTS (
              SELECT 1 FROM external_ids ei
              WHERE ei.media_id = mi.id AND ei.provider IN ('tmdb', 'imdb')
          )
          AND NOT EXISTS (
              SELECT 1 FROM provider_metadata pm
              WHERE pm.media_id = mi.id AND pm.provider = 'aggregated'
                AND BTRIM(COALESCE(pm.metadata->>'overview', '')) <> ''
          )
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * Get the metadata lock status for a media item.
 */
export async function getMediaItemLockStatus(
    sql: postgres.Sql,
    id: string,
): Promise<{
    locked: boolean;
    lockedBy: string | null;
    lockedAt: string | null;
} | null> {
    const rows = await sql<
        {
            metadata_locked: boolean;
            metadata_locked_by: string | null;
            metadata_locked_at: Date | null;
        }[]
    >`
        SELECT metadata_locked, metadata_locked_by, metadata_locked_at
        FROM media_items
        WHERE id = ${id}
    `;
    if (!rows[0]) return null;
    return {
        locked: rows[0].metadata_locked,
        lockedBy: rows[0].metadata_locked_by,
        lockedAt: rows[0].metadata_locked_at?.toISOString() ?? null,
    };
}

/**
 * Clear a specific custom image URL column on a media item.
 * Used when deleting custom artwork to reset the column to NULL.
 */
export async function clearCustomImageUrl(
    sql: postgres.Sql,
    id: string,
    column: 'custom_poster_url' | 'custom_backdrop_url' | 'custom_logo_url' | 'custom_thumb_url',
): Promise<void> {
    await sql`
        UPDATE media_items
        SET ${sql(column)} = NULL
        WHERE id = ${id}
    `;
}

/**
 * Clear a `custom_<type>_url` ONLY when it still holds a provider CDN URL.
 *
 * Installs that ran the 2026-06-21 season-poster code have
 * `custom_poster_url = 'https://image.tmdb.org/...'` on their seasons. That value
 * BLOCKS the local-artwork invariant: `upsertLocalArtwork` claims the column only
 * when it is NULL (media-artwork.queries.ts:135), so materializing a file would
 * leave the read path still serving the remote URL.
 *
 * The predicate is the in-tree one from metadata-sync-single.service.ts:1125 — an
 * admin's manual override does not match and survives untouched, and so does our
 * own `/api/image/custom/...` proxy URL.
 */
export async function clearProviderCdnCustomImageUrl(
    sql: postgres.Sql,
    id: string,
    column: 'custom_poster_url' | 'custom_backdrop_url' | 'custom_logo_url' | 'custom_thumb_url',
): Promise<void> {
    await sql`
        UPDATE media_items
        SET ${sql(column)} = NULL
        WHERE id = ${id}
          AND ${sql(column)} LIKE 'https://image.tmdb.org/%'
    `;
}

/**
 * Drop the cached blurhash placeholder for an artwork slot so it is recomputed
 * from the newly materialized image.
 *
 * `maybeSaveBlurhash` (image-proxy/service.ts:2041-2054) returns early when a
 * value already exists (:2048) and its UPDATE carries `AND <column> IS NULL`
 * (:2054), so a season holding the INHERITED series blurhash would keep flashing
 * the wrong placeholder colour forever once it gains its own poster.
 *
 * Only `poster` and `backdrop` have a column — there is no `logo_blurhash` or
 * `thumb_blurhash` (:2042-2043) — so every other type is a deliberate no-op.
 */
export async function clearArtworkBlurhash(
    sql: postgres.Sql,
    mediaItemId: string,
    artworkType: ArtworkType,
): Promise<void> {
    const column =
        artworkType === 'poster'
            ? 'poster_blurhash'
            : artworkType === 'backdrop'
              ? 'backdrop_blurhash'
              : null;
    if (!column) return;
    await sql`
        UPDATE media_items
        SET ${sql(column)} = NULL
        WHERE id = ${mediaItemId}
    `;
}

/**
 * Pipeline rows the `metadata-locked` stage rule parked for these items
 * (`metadata-update`, `mdblist-sync`) go back to `pending`, eligible now. An
 * unlock fires no invalidation event, so without this the row sat out the
 * rule's `retryAfterMs` (6 h for mdblist) before the stage looked again.
 * Only rows skipped for that reason are touched. Used inside the unlock
 * statements below, as a data-modifying CTE over the unlocked ids.
 */
function releaseMetadataLockedStageRows(
    sql: postgres.Sql,
    unlocked: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        WITH unlocked AS (${unlocked}),
        released AS (
            UPDATE media_item_stage_state s
               SET status = 'pending',
                   skipped_reason = NULL,
                   next_eligible_at = NULL,
                   declines = 0,
                   declines_since = NULL,
                   updated_at = now()
              FROM unlocked u
             WHERE s.media_item_id = u.id
               AND s.status = 'skipped_transient'
               AND s.skipped_reason = 'metadata-locked'
        )
        SELECT id FROM unlocked
    `;
}

/**
 * Unlock a media item — allow metadata syncs to update it again, and release
 * its `metadata-locked` pipeline rows in the same statement.
 * Returns true if the item was found and unlocked, false if not found.
 */
export async function unlockMediaItem(sql: postgres.Sql, id: string): Promise<boolean> {
    const rows = await releaseMetadataLockedStageRows(
        sql,
        sql`
            UPDATE media_items
            SET metadata_locked    = false,
                metadata_locked_by = NULL,
                metadata_locked_at = NULL
            WHERE id = ${id}
            RETURNING id
        `,
    );
    return rows.length > 0;
}

/**
 * Bulk lock/unlock a set of media items in one statement (an unlock also
 * releases the items' `metadata-locked` pipeline rows, as `unlockMediaItem`).
 *
 * Mirrors the single-item lock/unlock semantics in `updateAndLockMediaItem` /
 * `unlockMediaItem` (metadata_locked[_by][_at]) but for an id array, so a bulk
 * admin action doesn't cost one round trip per item. `RETURNING id` is the
 * only way to know which of the requested ids actually matched a row — the
 * caller diffs the input array against this to report `failedIds`.
 */
export async function bulkSetLockMediaItems(
    sql: postgres.Sql,
    ids: string[],
    locked: boolean,
    lockedBy: string | null,
): Promise<string[]> {
    if (ids.length === 0) return [];
    const rows = locked
        ? await sql<{ id: string }[]>`
            UPDATE media_items
            SET metadata_locked    = true,
                metadata_locked_by = ${lockedBy},
                metadata_locked_at = NOW()
            WHERE id = ANY(${ids}::uuid[])
            RETURNING id
        `
        : await releaseMetadataLockedStageRows(
              sql,
              sql`
                  UPDATE media_items
                  SET metadata_locked    = false,
                      metadata_locked_by = NULL,
                      metadata_locked_at = NULL
                  WHERE id = ANY(${ids}::uuid[])
                  RETURNING id
              `,
          );
    return rows.map((r) => r.id as string);
}

/**
 * Music media types whose scanner-side identity IS their title: the file
 * scanner resolves them by `(parent, LOWER(TRIM(title)))` rather than by an
 * external id, so an admin rename makes the row unfindable from the tags.
 * Renames of these types leave a `custom_metadata.scan_aliases` breadcrumb —
 * see {@link SCAN_ALIASES_KEY}.
 */
const TITLE_ADDRESSED_MUSIC_TYPES = new Set(['album', 'artist']);

/**
 * `custom_metadata` key holding the titles this row has previously been known
 * by. The music scanner matches against it so a hand-renamed album/artist
 * still absorbs newly-scanned files whose tags carry the OLD name, instead of
 * minting a duplicate row beside it.
 */
export const SCAN_ALIASES_KEY = 'scan_aliases';

// `updateAndLockMediaItem` spells this key as a SQL literal inside
// jsonb_build_object (a bind parameter in key position is a 42P18), so the two
// can drift silently. Fail at import instead.
if (SCAN_ALIASES_KEY !== 'scan_aliases') {
    throw new Error('SCAN_ALIASES_KEY changed; update the SQL literal in updateAndLockMediaItem');
}

/** Bound on retained aliases — a rename loop must not grow the row forever. */
const MAX_SCAN_ALIASES = 10;

/** Mirrors the DB-side `LOWER(TRIM(...))` the album/artist lookups compare on. */
function normalizeScanAlias(value: string): string {
    return value.trim().toLowerCase();
}

/**
 * Read the alias list a title change should leave behind, or null when this
 * update does not need one (no rename, not a title-addressed music type, or
 * the row is gone). The previous title goes last; the list is deduplicated on
 * the same normalization the lookups use and capped at
 * {@link MAX_SCAN_ALIASES}.
 */
async function nextScanAliases(
    sql: postgres.Sql,
    id: string,
    newTitle: string | undefined,
): Promise<string[] | null> {
    if (newTitle === undefined) return null;
    // FOR UPDATE: the alias list is read here and written by the UPDATE that
    // follows, so two concurrent renames of the same row both read the same
    // "before" state and the second one's write loses the first's outgoing
    // title. That title then resolves to nothing, and the scanner mints a
    // DUPLICATE row for files still carrying it — the exact failure this alias
    // list exists to prevent. Callers run this inside a transaction so the lock
    // is still held when the UPDATE lands.
    const [current] = await sql<
        {
            title: string | null;
            media_type: string;
            custom_metadata: Record<string, unknown> | null;
        }[]
    >`
        SELECT title, media_type, custom_metadata FROM media_items WHERE id = ${id} FOR UPDATE
    `;
    if (!current?.title) return null;
    if (!TITLE_ADDRESSED_MUSIC_TYPES.has(current.media_type)) return null;
    if (normalizeScanAlias(current.title) === normalizeScanAlias(newTitle)) return null;

    const raw = current.custom_metadata?.[SCAN_ALIASES_KEY];
    const existing = Array.isArray(raw)
        ? raw.filter((a): a is string => typeof a === 'string')
        : [];
    // Drop any alias equal to the title being retired (re-adding it below keeps
    // it newest) and any equal to the NEW title — the live title is never an
    // alias of itself, and leaving it in would let a future rename-back resolve
    // two rows.
    const retired = normalizeScanAlias(current.title);
    const incoming = normalizeScanAlias(newTitle);
    const kept = existing.filter((a) => {
        const n = normalizeScanAlias(a);
        return n !== retired && n !== incoming;
    });
    return [...kept, current.title].slice(-MAX_SCAN_ALIASES);
}

/**
 * Confirm only the reviewed filename title. Use the scanner/deletion item lock,
 * then the row lock used by edits, and compare the complete observed snapshot.
 * No title, sort key, custom metadata or related row is rewritten.
 */
export async function confirmFilenameTitle(
    sql: postgres.Sql,
    id: string,
    lockedBy: string,
    expected: FilenameTitleConfirmation,
): Promise<'confirmed' | 'conflict' | 'ineligible' | 'not_found'> {
    return withTx(sql, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${id}))`;
        const [item] = await tx<
            {
                title: string | null;
                title_source: string | null;
                media_type: string;
                status: string;
                is_dismissed: boolean;
                canonical_id: string | null;
                metadata_locked: boolean;
                metadata_locked_by: string | null;
                lock_version: string | null;
            }[]
        >`
            SELECT title, title_source, media_type, status, is_dismissed, canonical_id,
                   metadata_locked, metadata_locked_by, EXTRACT(EPOCH FROM metadata_locked_at)::text AS lock_version
            FROM media_items WHERE id = ${id} FOR UPDATE`;
        if (!item) return 'not_found';
        if (
            item.media_type !== 'track' ||
            item.status !== 'active' ||
            item.is_dismissed ||
            item.canonical_id
        )
            return 'ineligible';
        if (
            item.title !== expected.title ||
            item.title_source !== expected.source ||
            item.metadata_locked !== expected.locked ||
            item.metadata_locked_by !== (expected.lockedBy ?? null) ||
            item.lock_version !== (expected.lockedAt ?? null)
        )
            return 'conflict';
        await tx`
            UPDATE media_items SET title_source = NULL, metadata_locked = true,
                metadata_locked_by = ${lockedBy}, metadata_locked_at = NOW()
            WHERE id = ${id}`;
        return 'confirmed';
    });
}

/**
 * Update editable metadata on a media item and auto-lock it.
 * Only updates fields that are provided (non-undefined).
 * Always sets metadata_locked = true.
 *
 * Renaming a music album/artist also records the outgoing title under
 * `custom_metadata.scan_aliases` so the file scanner keeps recognising the row
 * from the unchanged file tags (see {@link SCAN_ALIASES_KEY}).
 */
export async function updateAndLockMediaItem(
    sql: postgres.Sql,
    id: string,
    lockedBy: string,
    fields: {
        title?: string;
        releaseYear?: number | null;
        overview?: string | null;
        customPosterUrl?: string | null;
        customBackdropUrl?: string | null;
        customLogoUrl?: string | null;
        customThumbUrl?: string | null;
        customMetadata?: Record<string, unknown>;
    },
): Promise<boolean> {
    // One transaction: nextScanAliases takes a FOR UPDATE row lock, and a lock
    // only lives as long as the transaction that took it. Outside one, each
    // statement is its own transaction and the lock is released before the
    // UPDATE — leaving exactly the race the lock is there to close. Nested
    // inside a caller's transaction this is a savepoint, which is harmless.
    return sql.begin(async (tx) => {
        const aliases = await nextScanAliases(tx, id, fields.title);
        // `tx.json(obj)` — NOT a pre-stringified `JSON.stringify(obj)` bound to a
        // `::jsonb` cast. postgres.js JSON-encodes the bound value for a jsonb
        // parameter, so handing it a STRING wrote the metadata as a jsonb *string
        // scalar* instead of an object: `jsonb_typeof` returned 'string' and every
        // `custom_metadata->>'key'` read back NULL. sql.json is the idiom the rest
        // of the codebase uses (see updateItemCustomMetadata).
        //
        // Base expression first, alias merge on top: when a caller supplies BOTH a
        // replacement custom_metadata and a rename, the alias must survive the
        // replacement rather than be overwritten by it.
        const baseMeta =
            fields.customMetadata !== undefined
                ? tx`${tx.json(fields.customMetadata as Record<string, never>)}::jsonb`
                : tx`custom_metadata`;
        // Replacing custom_metadata WITHOUT renaming used to drop the aliases a
        // previous rename had recorded: `aliases` is null when there is no rename,
        // so the replacement object went in wholesale and took the key with it. The
        // row then no longer answers to its old title and the scanner mints a
        // duplicate. Carry the stored list across instead — `custom_metadata` on
        // the right-hand side of SET still reads the row's OLD value.
        //
        // The key is a SQL literal, not a bind parameter: jsonb_build_object is
        // VARIADIC "any", so a parameter in key position has no inferable type and
        // Postgres rejects the statement outright (42P18). Same reason the patch
        // below is a whole jsonb object rather than a build_object call.
        const preserveAliases = tx`
        CASE WHEN custom_metadata -> 'scan_aliases' IS NOT NULL
             THEN jsonb_build_object('scan_aliases', custom_metadata -> 'scan_aliases')
             ELSE '{}'::jsonb END`;
        const metaExpr =
            aliases !== null
                ? tx`COALESCE(${baseMeta}, '{}'::jsonb) || ${tx.json({ [SCAN_ALIASES_KEY]: aliases })}::jsonb`
                : fields.customMetadata !== undefined
                  ? tx`COALESCE(${baseMeta}, '{}'::jsonb) || ${preserveAliases}`
                  : baseMeta;
        const rows = await tx<[{ id: string }]>`
        UPDATE media_items
        SET
            title                = ${fields.title !== undefined ? fields.title : tx`title`},
            -- A title the admin actually changed is typed by hand, not read
            -- from a tag or a file name: forget the scanner's provenance so the
            -- music-hygiene "title from file name" finding lets go of the row.
            -- Re-saving the SAME title (the edit form always sends it) keeps it:
            -- locking a filename-derived title does not make it a tag. SET
            -- reads the row's OLD title here.
            title_source         = ${
                fields.title !== undefined
                    ? tx`CASE WHEN title IS DISTINCT FROM ${fields.title} THEN NULL ELSE title_source END`
                    : tx`title_source`
            },
            year                 = ${fields.releaseYear !== undefined ? (fields.releaseYear ?? null) : tx`year`},
            overview             = ${fields.overview !== undefined ? (fields.overview ?? null) : tx`overview`},
            custom_poster_url    = ${fields.customPosterUrl !== undefined ? (fields.customPosterUrl ?? null) : tx`custom_poster_url`},
            custom_backdrop_url  = ${fields.customBackdropUrl !== undefined ? (fields.customBackdropUrl ?? null) : tx`custom_backdrop_url`},
            custom_logo_url      = ${fields.customLogoUrl !== undefined ? (fields.customLogoUrl ?? null) : tx`custom_logo_url`},
            custom_thumb_url     = ${fields.customThumbUrl !== undefined ? (fields.customThumbUrl ?? null) : tx`custom_thumb_url`},
            custom_metadata      = ${metaExpr}
                #- ${fields.customPosterUrl !== undefined ? ['artist_enrichment', 'provenance', 'poster'] : []}::text[]
                #- ${fields.customPosterUrl !== undefined ? ['album_enrichment', 'provenance', 'poster'] : []}::text[]
                #- ${fields.customBackdropUrl !== undefined ? ['artist_enrichment', 'provenance', 'backdrop'] : []}::text[]
                #- ${fields.customBackdropUrl !== undefined ? ['album_enrichment', 'provenance', 'backdrop'] : []}::text[],
            metadata_locked      = true,
            metadata_locked_by   = ${lockedBy},
            metadata_locked_at   = NOW()
        WHERE id = ${id}
        RETURNING id
    `;
        if (rows[0] && fields.title !== undefined) await refreshSortTitles(tx, [rows[0].id]);
        return rows.length > 0;
    });
}

export interface PersonalMediaRow {
    id: string;
    title: string;
    media_type: string;
    release_year: number | null;
    overview: string | null;
    custom_poster_url: string | null;
    custom_backdrop_url: string | null;
    custom_logo_url: string | null;
    custom_thumb_url: string | null;
    metadata_locked: boolean;
    metadata_locked_by: string | null;
    metadata_locked_at: Date | null;
    created_at: Date;
    episode_count?: number;
    season_count?: number;
    /** Default (or first) file's path — disambiguation context for the Identify modal. */
    file_path?: string | null;
}

export interface ListPersonalMediaOpts {
    limit: number;
    offset: number;
    search?: string;
    libraryGroupId?: string;
    mediaType?: string;
    sort?: 'title' | 'episodes' | 'added';
    disposition?: 'unresolved' | 'kept';
}

/**
 * List media items that have no external_ids rows — "personal" or unmatched items.
 * Only returns top-level items (parent_id IS NULL). Excludes dismissed items.
 * The default view excludes explicitly kept personal media.
 * Supports search, media type filter, library group filter, and sort order.
 */
export async function listPersonalMediaItems(
    sql: postgres.Sql,
    opts: ListPersonalMediaOpts,
): Promise<PersonalMediaRow[]> {
    return sql<PersonalMediaRow[]>`
        WITH base AS (
            SELECT mi.id
            FROM media_items mi
            WHERE NOT EXISTS (
                SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file'
            )
              AND NOT mi.is_dismissed
              AND mi.parent_id IS NULL
              ${
                  opts.disposition === 'kept'
                      ? sql`AND EXISTS (SELECT 1 FROM personal_media_dispositions d WHERE d.media_id = mi.id AND d.disposition = 'kept')`
                      : sql`AND NOT EXISTS (SELECT 1 FROM personal_media_dispositions d WHERE d.media_id = mi.id AND d.disposition = 'kept')`
              }
              AND (
                EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id)
                OR EXISTS (
                  SELECT 1 FROM media_items season
                  JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode'
                  JOIN media_file_items mfi ON mfi.media_item_id = ep.id
                  WHERE season.parent_id = mi.id AND season.media_type = 'season'
                )
              )
              ${opts.search ? sql`AND mi.title ILIKE ${'%' + opts.search + '%'}` : sql``}
              ${opts.mediaType ? sql`AND mi.media_type = ${opts.mediaType}` : sql``}
              ${buildLibraryGroupRootFilter(sql, opts.libraryGroupId, sql`mi.id`)}
        ),
        counted AS (
            SELECT
                b.id,
                COUNT(DISTINCT ep.id)::int AS episode_count
            FROM base b
            LEFT JOIN media_items s ON s.parent_id = b.id AND s.media_type = 'season'
            LEFT JOIN media_items ep ON ep.media_type = 'episode'
                AND (ep.parent_id = b.id OR ep.parent_id = s.id)
            LEFT JOIN media_file_items mfi ON mfi.media_item_id = ep.id
            GROUP BY b.id
        )
        SELECT
            mi.id, mi.title, mi.media_type,
            mi.year          AS release_year,
            mi.overview,
            mi.custom_poster_url, mi.custom_backdrop_url,
            mi.custom_logo_url, mi.custom_thumb_url,
            mi.metadata_locked, mi.metadata_locked_by, mi.metadata_locked_at,
            mi.created_at,
            c.episode_count,
            (SELECT COUNT(DISTINCT s.season_number)::int FROM media_items s
             WHERE s.parent_id = mi.id AND s.media_type = 'season'
            ) AS season_count,
            file_info.file_path
        FROM media_items mi
        JOIN counted c ON c.id = mi.id
        -- Default (or first) file for this item — a movie has its own file
        -- directly; a series falls back to its first episode's file.
        -- Disambiguation context for the Identify modal.
        LEFT JOIN LATERAL (
            SELECT mf.file_path
              FROM media_file_items mfi
              JOIN media_files mf ON mf.id = mfi.file_id
             WHERE mfi.media_item_id = mi.id
                OR mfi.media_item_id IN (
                     SELECT ep.id
                       FROM media_items s2
                       JOIN media_items ep ON ep.parent_id = s2.id AND ep.media_type = 'episode'
                      WHERE s2.parent_id = mi.id AND s2.media_type = 'season'
                   )
             ORDER BY mf.file_path
             LIMIT 1
        ) file_info ON true
        ORDER BY ${opts.sort === 'episodes' ? sql`c.episode_count DESC, mi.title ASC` : opts.sort === 'added' ? sql`mi.created_at DESC` : sql`mi.title ASC`}
        LIMIT ${opts.limit} OFFSET ${opts.offset}
    `;
}

/**
 * Count media items with no external_ids (personal / unmatched), excluding dismissed items.
 * Only counts top-level items (parent_id IS NULL). Supports optional filters.
 */
export async function countPersonalMediaItems(
    sql: postgres.Sql,
    opts?: {
        search?: string;
        libraryGroupId?: string;
        mediaType?: string;
        disposition?: 'unresolved' | 'kept';
    },
): Promise<number> {
    // Unmatched-first: the attention derive cycle runs this every 60 s. Checking
    // "backed by a file" for every top-level item BEFORE the external_ids
    // anti-join cost ~310 ms on prod (2026-09-26: 27k top-level items, 377k
    // buffer hits walking seasons -> episodes -> files) to count 9 rows. The
    // MATERIALIZED CTE narrows to the few-thousand unmatched items first (riding
    // idx_media_items_top_level_live), so the file walk only runs for those: 85 ms.
    const [row] = await sql<[{ count: string }]>`
        WITH unmatched AS MATERIALIZED (
            SELECT u.id
              FROM media_items u
             WHERE u.parent_id IS NULL
               AND NOT u.is_dismissed
               AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = u.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
               ${
                   opts?.disposition === 'kept'
                       ? sql`AND EXISTS (SELECT 1 FROM personal_media_dispositions d WHERE d.media_id = u.id AND d.disposition = 'kept')`
                       : sql`AND NOT EXISTS (SELECT 1 FROM personal_media_dispositions d WHERE d.media_id = u.id AND d.disposition = 'kept')`
               }
        )
        SELECT COUNT(*)::text AS count
        FROM unmatched
        JOIN media_items mi ON mi.id = unmatched.id
        WHERE (
            EXISTS (SELECT 1 FROM media_file_items mfi WHERE mfi.media_item_id = mi.id)
            OR EXISTS (
              SELECT 1 FROM media_items season
              JOIN media_items ep ON ep.parent_id = season.id AND ep.media_type = 'episode'
              JOIN media_file_items mfi ON mfi.media_item_id = ep.id
              WHERE season.parent_id = mi.id AND season.media_type = 'season'
            )
          )
          ${opts?.search ? sql`AND mi.title ILIKE ${'%' + opts.search + '%'}` : sql``}
          ${opts?.mediaType ? sql`AND mi.media_type = ${opts.mediaType}` : sql``}
          ${buildLibraryGroupRootFilter(sql, opts?.libraryGroupId, sql`mi.id`)}
    `;
    return parseInt(row.count, 10);
}

/**
 * Check whether a media item with the given UUID exists.
 */
export async function mediaItemExistsById(sql: postgres.Sql, id: string): Promise<boolean> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_items WHERE id = ${id}
    `;
    return rows.length > 0;
}

export interface InsertExtraMediaItemParams {
    parentId: string;
    title: string;
    extraType: ExtraType;
}

/**
 * Insert a media_items row for an extra (trailer, featurette, etc.).
 * Links to the parent movie via parent_id.
 * Returns the new UUID.
 */
export async function insertExtraMediaItem(
    sql: postgres.Sql,
    params: InsertExtraMediaItemParams,
): Promise<string> {
    // Reuse an existing FILE-LESS extra with the same parent + type + title
    // before inserting a fresh one. The extras reconcile/exclusion pass can
    // detach a trailer's file from its extra row without deleting the now-empty
    // row; without this reuse every subsequent scan minted a brand-new extra and
    // orphaned the previous one (223 file-less phantom rows were observed in prod
    // for a single trailer). Scoped to the same parent + extra_type so unrelated
    // extras never collide, and to file-less rows only so a still-linked extra is
    // never stolen. Same punctuation-stripping normalization as title matching
    // elsewhere in this module.
    const reusable = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_items mi
        WHERE mi.media_type = 'extra'
          AND mi.parent_id = ${params.parentId}
          AND mi.extra_type = ${params.extraType}
          AND mi.status = 'active'
          AND mi.has_files = false
          AND BTRIM(regexp_replace(regexp_replace(LOWER(TRIM(mi.title)), '[^a-z0-9 ]', '', 'g'), ' +', ' ', 'g'))
              = BTRIM(regexp_replace(regexp_replace(LOWER(TRIM(${params.title}::text)), '[^a-z0-9 ]', '', 'g'), ' +', ' ', 'g'))
        ORDER BY mi.created_at ASC
        LIMIT 1
    `;
    if (reusable[0]) return reusable[0].id;

    const rows = await sql<[{ id: string }]>`
        INSERT INTO media_items (title, media_type, extra_type, parent_id)
        VALUES (${params.title}, 'extra', ${params.extraType}, ${params.parentId})
        RETURNING id
    `;
    if (!rows[0]) {
        throw new Error(`insertExtraMediaItem: no row returned for title="${params.title}"`);
    }
    await refreshSortTitles(sql, [rows[0].id]);
    return rows[0].id;
}

/**
 * The ASCII normalization findPersonalMediaItemByTitleYear compares titles on
 * (lowercase, keep [a-z0-9 ]), or null when a title cannot be compared that
 * way: one with letters outside the Latin script, which the normalization
 * would strip — every Japanese/Cyrillic/Greek/Arabic title collapsed to the
 * same "" (or " 2") and different movies were grouped as versions of one.
 * Accented Latin letters keep their old behaviour (stripped on both sides).
 */
export function normalizeTitleForVersionDedupe(title: string): string | null {
    if (/(?!\p{Script=Latin})\p{L}/u.test(title)) return null;
    const normalized = title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9 ]/g, '');
    return normalized.trim() === '' ? null : normalized;
}

/**
 * Find an existing media item by normalized title + year + media_type.
 * Used by the file scanner to detect multi-version files (e.g. Director's Cut)
 * that should link to an existing item rather than create a duplicate.
 *
 * Normalizes both sides by stripping non-alphanumeric chars before comparing,
 * so "Obersalzberg - der Film" matches a file parsed as "Obersalzberg der Film".
 * Searches ALL items (personal and enriched), preferring enriched (external IDs)
 * over personal when both match — mirrors the TV findOrCreateSeries behavior.
 * A missing year on either side matches any year, so grouping that involves an
 * undated file still depends on which file was created first. Titles
 * normalizeTitleForVersionDedupe can't compare (non-Latin) never match.
 *
 * Returns the UUID of the matching item, or null if not found.
 */
export async function findPersonalMediaItemByTitleYear(
    sql: postgres.Sql,
    title: string,
    year: number | undefined,
    mediaType: string,
): Promise<string | null> {
    const normalizedTitle = normalizeTitleForVersionDedupe(title);
    if (normalizedTitle === null) return null;
    const yearVal = year ?? null;

    const rows = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_items mi
        WHERE mi.media_type = ${mediaType}
          AND mi.parent_id IS NULL
          AND (
              regexp_replace(LOWER(TRIM(mi.title)), '[^a-z0-9 ]', '', 'g') = ${normalizedTitle}
              OR regexp_replace(LOWER(TRIM(mi.english_title)), '[^a-z0-9 ]', '', 'g') = ${normalizedTitle}
              OR regexp_replace(LOWER(TRIM(mi.original_title)), '[^a-z0-9 ]', '', 'g') = ${normalizedTitle}
          )
          AND (mi.year = ${yearVal}::int OR mi.year IS NULL OR ${yearVal}::int IS NULL)
          AND NOT mi.is_dismissed
        ORDER BY
            CASE WHEN EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file') THEN 0 ELSE 1 END,
            mi.created_at,
            mi.id
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * Scanner duplicate-prevention: find a file-less DISCOVERY row to adopt for a
 * freshly-scanned file that carries NO provider id of its own.
 *
 * The scanner cross-links by provider id (step 2b in resolveOrCreateMediaItem),
 * but a library file with no embedded TMDB/IMDB/TVDB id (pure filename parse)
 * has nothing to cross-link on and would create a SIBLING row — duplicating an
 * existing discovery row (has_files=false, with a tmdb id) that "requests ready"
 * cards key on. Attaching the file to that discovery row instead keeps a single
 * canonical row.
 *
 * Deliberately conservative to avoid false adoption (see merge-tool risk notes):
 *   - exact normalized-title match (lowercase, trim and remove punctuation),
 *   - exact year match — caller must pass a concrete year (NULL years never match),
 *   - top-level, active, not dismissed,
 *   - the row must currently be file-less (has_files = false),
 *   - the row must already carry a real external id from `providers` — i.e. it is
 *     a genuine metadata row, not another bare file row. Defaults to discovery
 *     providers (tmdb/imdb/tvdb); the provider-less local-movie path also passes
 *     'jellyfin' so a Jellyfin metadata-only import gets adopted instead of
 *     leaving a fileless duplicate,
 *   - returns a match ONLY when exactly one candidate exists (ambiguous → null,
 *     let the caller create a fresh row that the admin reconcile tool can fix).
 */
export async function findAdoptableDiscoveryRowByTitle(
    sql: postgres.Sql,
    params: { title: string; year: number; mediaType: string; providers?: ExternalIdProvider[] },
): Promise<string | null> {
    const providers = params.providers ?? ['tmdb', 'imdb', 'tvdb'];
    const rows = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_items mi
        WHERE mi.media_type = ${params.mediaType}
          AND mi.parent_id IS NULL
          AND mi.status = 'active'
          AND NOT mi.is_dismissed
          AND mi.has_files = false
          AND mi.year = ${params.year}::int
          -- Collapse whitespace after stripping punctuation so "A - B" matches
          -- "A B" (removing the hyphen would otherwise leave a double space).
          AND BTRIM(regexp_replace(regexp_replace(LOWER(TRIM(mi.title)), '[^a-z0-9 ]', '', 'g'), ' +', ' ', 'g'))
              = BTRIM(regexp_replace(regexp_replace(LOWER(TRIM(${params.title}::text)), '[^a-z0-9 ]', '', 'g'), ' +', ' ', 'g'))
          AND EXISTS (
              SELECT 1 FROM external_ids ei
              WHERE ei.media_id = mi.id
                AND ei.provider = ANY(${providers})
          )
        LIMIT 2
    `;
    return rows.length === 1 ? rows[0].id : null;
}

/**
 * Get the media_type of a media item by its UUID.
 * Returns null if the item does not exist.
 */
export async function getMediaItemType(sql: postgres.Sql, id: string): Promise<string | null> {
    const [row] = await sql<[{ media_type: string }]>`
        SELECT media_type FROM media_items WHERE id = ${id}
    `;
    return row?.media_type ?? null;
}

/** media_type, title and year of a media item, or null if it does not exist. */
export async function getMediaItemTypeTitleYear(
    sql: postgres.Sql,
    id: string,
): Promise<{ media_type: string; title: string | null; year: number | null } | null> {
    const [row] = await sql<[{ media_type: string; title: string | null; year: number | null }]>`
        SELECT media_type, title, year FROM media_items WHERE id = ${id}
    `;
    return row ?? null;
}

/**
 * Find an existing personal series by normalized title, or create one.
 * "Personal" means no external_ids rows.
 * Uses regexp_replace to normalize punctuation for matching (e.g. "What's" = "Whats").
 * Concurrency-safe: INSERT ON CONFLICT DO NOTHING + fallback SELECT.
 */
export async function findOrCreatePersonalSeries(
    sql: postgres.Sql,
    params: {
        title: string;
        year?: number;
        libraryGroupId?: string;
        mediaType?: string;
    },
): Promise<string> {
    const mediaType = params.mediaType ?? 'tv';

    // Try to find an existing personal series with normalized title match
    const existing = await sql<{ id: string }[]>`
        SELECT mi.id
        FROM media_items mi
        WHERE mi.media_type = ${mediaType}
          AND mi.parent_id IS NULL
          AND regexp_replace(LOWER(TRIM(mi.title)), '[^a-z0-9 ]', '', 'g')
            = regexp_replace(LOWER(TRIM(${params.title})), '[^a-z0-9 ]', '', 'g')
          AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
          AND NOT mi.is_dismissed
        LIMIT 1
    `;
    if (existing[0]) return existing[0].id;

    // Create new series item
    const rows = await sql<[{ id: string }]>`
        INSERT INTO media_items (title, media_type, year)
        VALUES (${params.title}, ${mediaType}, ${params.year ?? null})
        RETURNING id
    `;
    await refreshSortTitles(sql, [rows[0].id]);
    return rows[0].id;
}

/**
 * The title fold a series lookup compares on, and the advisory-lock key that
 * serializes find-or-create (and a rename, see `renamePersonalSeries`) per
 * folded title. A title with no Latin letters or digits ("進撃の巨人") folds to
 * "" — as does every other such title, so they all shared one lock and
 * title-matched each other. Those compare on the exact (lowercased, trimmed)
 * title instead.
 */
function seriesTitleKey(
    title: string,
    mediaType: string,
): { normalizedTitle: string; exactTitle: string | null; lockKey: string } {
    const normalizedTitle = title
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9 ]/g, '');
    const exactTitle = normalizedTitle.trim() === '' ? title.toLowerCase().trim() : null;
    const lockKey =
        exactTitle === null
            ? `series:${normalizedTitle}:${mediaType}`
            : `series-exact:${exactTitle}:${mediaType}`;
    return { normalizedTitle, exactTitle, lockKey };
}

/** `mi` carries `title` as its title, English title or original title (folded). */
function seriesTitleMatches(
    tx: postgres.Sql,
    title: string,
): postgres.PendingQuery<postgres.Row[]> {
    const { normalizedTitle, exactTitle } = seriesTitleKey(title, '');
    return exactTitle === null
        ? tx`(
                  regexp_replace(LOWER(TRIM(mi.title)), '[^a-z0-9 ]', '', 'g') = ${normalizedTitle}
                  OR regexp_replace(LOWER(TRIM(mi.english_title)), '[^a-z0-9 ]', '', 'g') = ${normalizedTitle}
                  OR regexp_replace(LOWER(TRIM(mi.original_title)), '[^a-z0-9 ]', '', 'g') = ${normalizedTitle}
              )`
        : tx`(
                  LOWER(TRIM(mi.title)) = ${exactTitle}
                  OR LOWER(TRIM(mi.english_title)) = ${exactTitle}
                  OR LOWER(TRIM(mi.original_title)) = ${exactTitle}
              )`;
}

/**
 * Give a provider-less series the title (and year) of the folder its files
 * were renamed to, so the scan finds it under the new name instead of creating
 * a second series and stranding the old one's watch state. Runs under the same
 * per-title lock as `findOrCreateSeries`, so a concurrent episode of the new
 * folder either sees the renamed row or has already created one (then this
 * declines). The caller has checked that the old files are gone.
 *
 * Returns the series id when it now carries the new title (renamed here, or
 * already by a sibling episode), null when it declined: another active series
 * already answers to the new title (the files join that one, as before), or
 * the series gained a provider id, is locked, dismissed or gone.
 */
export async function renamePersonalSeries(
    sql: postgres.Sql,
    params: { seriesId: string; title: string; year?: number; mediaType?: string },
): Promise<string | null> {
    const mediaType = params.mediaType ?? 'tv';
    const { lockKey } = seriesTitleKey(params.title, mediaType);
    const yearVal = params.year ?? null;
    return withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
        // What findOrCreateSeries would pick for the new title (naked title scan).
        const holders = await tx<{ id: string }[]>`
            SELECT mi.id::text AS id
            FROM media_items mi
            WHERE mi.media_type = ${mediaType}
              AND mi.parent_id IS NULL
              AND ${seriesTitleMatches(tx, params.title)}
              AND (mi.year = ${yearVal}::int OR mi.year IS NULL OR ${yearVal}::int IS NULL)
              AND NOT mi.is_dismissed
        `;
        if (holders.some((h) => h.id !== params.seriesId)) return null;
        if (holders.length > 0) return params.seriesId;
        const [renamed] = await tx<{ id: string }[]>`
            UPDATE media_items mi
               SET title = ${params.title},
                   year = COALESCE(${yearVal}::int, mi.year),
                   updated_at = now()
             WHERE mi.id = ${params.seriesId}
               AND mi.media_type = ${mediaType}
               AND mi.parent_id IS NULL
               AND mi.status = 'active'
               AND NOT mi.is_dismissed
               AND NOT mi.metadata_locked
               AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
         RETURNING mi.id::text AS id
        `;
        if (renamed) await refreshSortTitles(tx, [renamed.id]);
        return renamed?.id ?? null;
    });
}

/**
 * Find or create a series media_item, trying external ID first, then title match.
 *
 * Unlike `findOrCreatePersonalSeries` (which only matches items WITHOUT external IDs),
 * this function matches ANY series — personal or enriched. This is the unified entry
 * point for all TV file scanning.
 *
 * Resolution order:
 *   1. External ID match (if candidate provided) — finds TMDB-synced series
 *   2. Title match (normalized, any series) — finds personal OR enriched series,
 *      subject to the cross-provider primary-identity guards described below.
 *   3. Create new series
 *
 * Cross-provider primary identity guards (when `params.externalId` is supplied):
 *
 *   The naive title-match step would silently fuse two genuinely distinct shows
 *   that happen to share an English title — "The Outpost (US)" vs "The Outpost (AU)",
 *   "Glimmers (US)" vs "Glimmers (UK)", "Shorebound (US)" vs "Shorebound (UK)", and so on.
 *   We've already burned ourselves twice on this in preprod: Office AU's row ended
 *   up carrying both `tmdb=256480` (AU) AND `jellyseerr=2996` (UK) external_ids,
 *   and Glimmers UK's row inherited US-Glimmers episodes via a German Jellyfin library
 *   merge. Both rows became internally inconsistent, contaminating downstream
 *   recommendations, watch state, and metadata refreshes.
 *
 *   To prevent this, the title-match SELECT is filtered by TWO rules:
 *
 *   (a) Same-provider conflict — the existing rule. A row that already carries an
 *       external_id for the SAME (provider, media_type) but a DIFFERENT id is the
 *       wrong show; exclude it.
 *
 *   (b) Cross-provider conflict — the broadened rule. A row that carries ANY
 *       external_id (primary OR non-primary) that disagrees with the incoming
 *       (provider, id, media_type) triple is presumed to belong to a different
 *       show in some provider's view. We have no way to verify cross-provider
 *       equivalence at this layer (that would require an external mapping table),
 *       so we err on the side of creating a fresh row.
 *
 *       Why drop the `is_primary = TRUE` filter the original guard had? A row
 *       carrying e.g. a non-primary `tmdb=2316` from a previous backfill but no
 *       primary external_id at all would still be matched by an incoming
 *       `jellyfin=abc` for a *different show*. The advisory lock + step-1
 *       external-ID resolve still let exact-match cases through (step 1 returns
 *       the row before we even reach the title fallback), so this is purely a
 *       hardening of the title fallback.
 *
 *   Combined effect: rows with NO external_ids at all (fresh personal stubs) still
 *   match by title — the caller will then attach the incoming primary id to the
 *   matched row. Rows whose external_ids agree with the incoming triple continue
 *   to match (and step 1 short-circuits anyway). Rows with any conflicting
 *   external_id are skipped.
 *
 *   Year-NULL bypass: when `params.externalId` is supplied the caller has
 *   authoritative metadata, so we tighten the year predicate to `mi.year =
 *   yearVal OR mi.year IS NULL` — we no longer let an incoming "no year" claim
 *   match an existing row with a different concrete year. Naked title scans
 *   (no externalId) keep the permissive `OR yearVal IS NULL` disjunct.
 *
 *   Jellyfin id normalization: when `params.externalId.provider === 'jellyfin'`,
 *   the supplied id may arrive dashed or dashless. We normalize to the dashless
 *   storage form before BOTH the step-1 resolve and the conflict-filter binding
 *   so that `a1b2-c3d4-...` matches a stored `a1b2c3d4...`.
 */
export async function findOrCreateSeries(
    sql: postgres.Sql,
    params: {
        title: string;
        year?: number;
        libraryGroupId?: string;
        mediaType?: string;
        externalId?: {
            provider: string;
            id: string;
            mediaType: string;
        };
    },
): Promise<string> {
    const mediaType = params.mediaType ?? 'tv';

    // Normalize Jellyfin ids to dashless storage form before any lookup or filter
    // binding. Mirrors the catalog.service.ts pattern (findByExternalIdTx).
    const normalizedExternalIdValue = params.externalId
        ? params.externalId.provider === 'jellyfin'
            ? normalizeJellyfinId(params.externalId.id)
            : params.externalId.id
        : null;

    // 1. Try by external ID (e.g. TMDB series ID)
    if (params.externalId && normalizedExternalIdValue !== null) {
        const byExtId = await resolveExternalIdToUuid(
            sql,
            normalizedExternalIdValue,
            params.externalId.mediaType,
            params.externalId.provider as ExternalIdProvider,
        );
        if (byExtId) {
            await backfillLibraryGroupIdIfNull(sql, byExtId, params.libraryGroupId);
            return byExtId;
        }
    }

    // 2. Try by normalized title (matches both personal AND enriched series)
    //    Uses advisory lock to prevent concurrent duplicate creation.
    //    Lock key = hash of normalized title + media type.
    const { lockKey } = seriesTitleKey(params.title, mediaType);
    const yearVal = params.year ?? null;

    // Use a transaction with advisory lock to serialize find-or-create.
    // We use `withTx` (not raw `sql.begin`) because callers like the Jellyfin
    // sync path may pass a `ReservedSql` handle that has neither `.begin` nor
    // `.savepoint`; `withTx` falls back to a manual BEGIN/COMMIT in that case.
    const result = await withTx(sql, async (txRaw) => {
        const tx = txRaw as unknown as postgres.Sql;
        // Advisory lock scoped to this transaction — released on commit/rollback.
        // hashtext() returns a stable int4 hash of the string.
        await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

        // (a) Same-provider conflict: exclude rows that already carry a different
        // external_id for our provider+mediaType. Catches the obvious AU-vs-US
        // case when both shows already have TMDB ids attached.
        // (b) Cross-provider conflict (broadened): exclude rows that carry ANY
        // external_id (primary or non-primary) that disagrees with the incoming
        // (provider, id, media_type) triple. A row whose existing external_id is
        // from a *different* provider, or a different id within our provider, is
        // presumed to belong to a different show. A row with no external_ids at
        // all still matches; a row whose external_id equals exactly the incoming
        // triple still matches. See doc-comment above for full motivation
        // (Office AU + Glimmers UK incidents) and why the previous `is_primary =
        // TRUE` filter was insufficient (a non-primary tmdb=2316 from a prior
        // backfill, with no primary at all, would still match a different show
        // by title).
        const conflictingIdFilter =
            params.externalId && normalizedExternalIdValue !== null
                ? tx`
                AND NOT EXISTS (
                    SELECT 1 FROM external_ids ei
                    WHERE ei.media_id = mi.id
                      AND ei.provider    = ${params.externalId.provider}
                      AND ei.media_type  = ${params.externalId.mediaType}
                      AND ei.external_id != ${normalizedExternalIdValue}
                )
                AND NOT EXISTS (
                    SELECT 1 FROM external_ids ei
                    WHERE ei.media_id = mi.id
                      AND NOT (
                          ei.provider    = ${params.externalId.provider}
                          AND ei.external_id = ${normalizedExternalIdValue}
                          AND ei.media_type  = ${params.externalId.mediaType}
                      )
                )
            `
                : tx``;

        // Year predicate: when the caller has an external_id they have
        // authoritative metadata, so don't let an incoming "no year" claim
        // match a row with a different concrete year. Naked title scans (no
        // external_id) keep the permissive disjunct because we don't yet know
        // the canonical year.
        const yearPredicate = params.externalId
            ? tx`(mi.year = ${yearVal}::int OR mi.year IS NULL)`
            : tx`(mi.year = ${yearVal}::int OR mi.year IS NULL OR ${yearVal}::int IS NULL)`;

        const existing = await tx<{ id: string }[]>`
            SELECT mi.id
            FROM media_items mi
            WHERE mi.media_type = ${mediaType}
              AND mi.parent_id IS NULL
              AND ${seriesTitleMatches(tx, params.title)}
              AND ${yearPredicate}
              AND NOT mi.is_dismissed
              ${conflictingIdFilter}
            ORDER BY
                -- Prefer items with external IDs (enriched) over personal
                CASE WHEN EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file') THEN 0 ELSE 1 END,
                mi.created_at
            LIMIT 1
        `;
        if (existing[0]) {
            await backfillLibraryGroupIdIfNull(tx, existing[0].id, params.libraryGroupId);
            return existing[0].id;
        }

        // 2b. Re-resolve the external ID *under the lock* before creating.
        //
        // Step 1 ran OUTSIDE this lock, so its MISS is only as fresh as the
        // moment it executed. A concurrent scan worker (SCAN_CONCURRENCY
        // defaults to 8 files in flight) can have created AND enriched the
        // series row while we were queued on the advisory lock. The title
        // fallback above does not rescue us in that case: the cross-provider
        // conflict guard rejects any row carrying an external_id that isn't
        // exactly our incoming triple, and the file scanner attaches `imdb`
        // immediately after `tmdb` — so the winner becomes invisible to the
        // title fallback within milliseconds of being created.
        //
        // Without this re-check the loser INSERTs a second series row, then
        // silently fails to claim the external ID (unique violation on
        // external_ids, swallowed by the scanner's catch in video-processor.ts)
        // and is left with no identity at all — permanently unresolvable, and
        // holding whichever episode files landed on it. That is exactly how
        // three prod shows ended up split across two rows on 2026-08-20/21,
        // reporting 4 of 12 episodes as "not on disk".
        //
        // The read is safe here precisely because we hold the lock: no other
        // creator can be mid-flight, and READ COMMITTED gives this statement a
        // fresh snapshot that includes anything committed while we waited.
        if (params.externalId && normalizedExternalIdValue !== null) {
            const racedWinner = await resolveExternalIdToUuid(
                tx,
                normalizedExternalIdValue,
                params.externalId.mediaType,
                params.externalId.provider as ExternalIdProvider,
            );
            if (racedWinner) {
                await backfillLibraryGroupIdIfNull(tx, racedWinner, params.libraryGroupId);
                return racedWinner;
            }
        }

        // 3. Create new series (inside the advisory lock — no concurrent duplicate possible)
        const rows = await tx<[{ id: string }]>`
            INSERT INTO media_items (title, media_type, year, library_group_id)
            VALUES (${params.title}, ${mediaType}, ${yearVal}::int, ${params.libraryGroupId ?? null})
            RETURNING id
        `;
        await refreshSortTitles(tx, [rows[0].id]);
        return rows[0].id;
    });

    return result;
}

/**
 * Find an existing season for a personal series, or create one.
 * Concurrency-safe via uq_media_items_season unique constraint +
 * ON CONFLICT DO NOTHING + fallback SELECT.
 */
export async function findOrCreatePersonalSeason(
    sql: postgres.Sql,
    params: { seriesId: string; seasonNumber: number },
): Promise<string> {
    // Try to find existing season
    const existing = await sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE parent_id = ${params.seriesId}
          AND media_type = 'season'
          AND season_number = ${params.seasonNumber}
        LIMIT 1
    `;
    if (existing[0]) return existing[0].id;

    // Create — ON CONFLICT handles concurrent inserts
    const title = `Season ${params.seasonNumber}`;
    const inserted = await sql<{ id: string }[]>`
        INSERT INTO media_items (title, media_type, parent_id, season_number)
        VALUES (${title}, 'season', ${params.seriesId}, ${params.seasonNumber})
        ON CONFLICT (parent_id, season_number)
        WHERE media_type = 'season' AND parent_id IS NOT NULL AND season_number IS NOT NULL
        DO NOTHING
        RETURNING id
    `;
    if (inserted[0]) await refreshSortTitles(sql, [inserted[0].id]);

    // Fallback SELECT in case ON CONFLICT fired
    const rows = await sql<[{ id: string }]>`
        SELECT id FROM media_items
        WHERE parent_id = ${params.seriesId}
          AND media_type = 'season'
          AND season_number = ${params.seasonNumber}
    `;
    return rows[0].id;
}

/**
 * Find an existing episode in a season, or create one.
 * Concurrency-safe via the episode partial-unique index + ON CONFLICT DO
 * NOTHING. `created` is accurate even under concurrent inserts: it is true
 * only when THIS call's INSERT actually wrote the row (detected via the CTE's
 * RETURNING), false when the row already existed or a concurrent insert won.
 */
export async function findOrCreatePersonalEpisode(
    sql: postgres.Sql,
    params: {
        seasonId: string;
        seasonNumber: number;
        episodeNumber: number;
        title: string;
    },
): Promise<{ id: string; created: boolean }> {
    // Try to find existing episode
    const existing = await sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE parent_id = ${params.seasonId}
          AND media_type = 'episode'
          AND season_number = ${params.seasonNumber}
          AND episode_number = ${params.episodeNumber}
        LIMIT 1
    `;
    if (existing[0]) return { id: existing[0].id, created: false };

    // Create — ON CONFLICT handles concurrent inserts. The CTE reports
    // `created` ACCURATELY: the `ins` arm yields a row only when our INSERT
    // actually wrote one; on the conflict path (a concurrent insert won the
    // race, or a row appeared between the SELECT above and this INSERT) `ins`
    // is empty and the fallback arm returns the existing id with created=false.
    // (Same shape as findOrCreateChild in metadata-sync-single.service.ts —
    // DO NOTHING returns no row on conflict, so we can't use the xmax=0 trick
    // and must detect insertion via the CTE's RETURNING instead.)
    const [row] = await sql<Array<{ id: string; created: boolean }>>`
        WITH ins AS (
            INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number)
            VALUES (${params.title}, 'episode', ${params.seasonId}, ${params.seasonNumber}, ${params.episodeNumber})
            ON CONFLICT (parent_id, season_number, episode_number)
                WHERE media_type = 'episode' AND parent_id IS NOT NULL
                    AND season_number IS NOT NULL AND episode_number IS NOT NULL
            DO NOTHING
            RETURNING id
        )
        SELECT id, TRUE AS created FROM ins
        UNION ALL
        SELECT id, FALSE AS created FROM media_items
        WHERE parent_id = ${params.seasonId}
            AND media_type = 'episode'
            AND season_number = ${params.seasonNumber}
            AND episode_number = ${params.episodeNumber}
            AND NOT EXISTS (SELECT 1 FROM ins)
        LIMIT 1
    `;
    if (!row) {
        // The CTE guarantees one arm returns a row: the INSERT wrote one, or
        // the fallback SELECT finds the row a concurrent insert created. Zero
        // rows means a concurrent hard-delete slipped between the arms or the
        // partial unique index is missing (migration drift).
        throw new Error(
            `findOrCreatePersonalEpisode: no row returned ` +
                `(seasonId=${params.seasonId}, season=${params.seasonNumber}, episode=${params.episodeNumber})`,
        );
    }
    if (row.created) await refreshSortTitles(sql, [row.id]);
    return { id: row.id, created: row.created };
}

/**
 * Resolve a music album/artist by a title it was PREVIOUSLY known by.
 *
 * The scanner addresses these rows by title, so a hand-rename in
 * `/admin/library/media` used to make the row invisible to the very files it
 * owns: the next newly-added or moved file still carried the old ALBUM /
 * ARTIST tag, missed the renamed row, and minted a duplicate beside it — the
 * album silently split in two. `updateAndLockMediaItem` records the outgoing
 * title in `custom_metadata.scan_aliases`; this lookup is the read side.
 *
 * Runs only after the live-title lookup misses, i.e. on the create path, so
 * the extra scan costs nothing on the steady-state hit path.
 *
 * The alias comparison MUST mirror the live-title comparison of the caller —
 * plain `LOWER(TRIM())` for albums, the NFC key for artists — or an alias would
 * resolve where the live title would not. The artist branch reads
 * `music_artist_alias_keys`, which the partial GIN index
 * `idx_music_artist_alias_keys` covers; its predicates are literals so a
 * generic prepared plan still matches the index.
 */
async function findMusicItemByScanAlias(
    sql: postgres.Sql,
    params: {
        mediaType: 'album' | 'artist';
        /** null → top-level (artists); a UUID → children of that parent (albums). */
        parentId: string | null;
        title: string;
    },
): Promise<string | null> {
    const rows =
        params.mediaType === 'artist'
            ? await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'artist' AND parent_id IS NULL AND status = 'active'
                  AND custom_metadata ? 'scan_aliases'
                  AND music_artist_alias_keys(custom_metadata)
                      @> ARRAY[LOWER(TRIM(normalize(${params.title}::text, NFC)))]
                ORDER BY created_at ASC
                LIMIT 2
            `
            : await sql<{ id: string }[]>`
                SELECT id FROM media_items
                WHERE media_type = 'album'
                  AND status = 'active'
                  AND ${params.parentId === null ? sql`parent_id IS NULL` : sql`parent_id = ${params.parentId}`}
                  AND jsonb_typeof(custom_metadata->'scan_aliases') = 'array'
                  AND EXISTS (
                      SELECT 1
                      FROM jsonb_array_elements_text(custom_metadata->'scan_aliases') AS a(alias)
                      WHERE LOWER(TRIM(alias)) = LOWER(TRIM(${params.title}))
                  )
                ORDER BY created_at ASC
                LIMIT 2
            `;
    if (rows.length > 1)
        throw new Error('Ambiguous scan alias; refusing to select an arbitrary music identity');
    return rows[0]?.id ?? null;
}

/** No artist row could be found or created for the name (see findOrCreateMusicArtist). */
export class MusicArtistNotCreatableError extends Error {
    constructor(readonly artistName: string) {
        super(`findOrCreateMusicArtist: could not resolve artist "${artistName}" after retries`);
        this.name = 'MusicArtistNotCreatableError';
    }
}

/**
 * Find an existing music artist by normalized title, or create one.
 * Artists are top-level items (parent_id IS NULL) with media_type='artist'.
 * Concurrency-safe: INSERT ON CONFLICT DO NOTHING + fallback SELECT.
 *
 * The lookup ignores `library_group_id` so the same artist that appears in
 * two music libraries reuses one row. Scoping the lookup by lgid produced
 * duplicate stubs whenever a library_group_id was added later (existing
 * NULL-lgid row + new lgid-set scan = two "Arlen" rows, then artist-
 * enrichment fights over the MusicBrainz ID and rejects everyone after the
 * first). lgid stays on the INSERT path because new artists still benefit
 * from being marked with the library that introduced them.
 */
export async function findOrCreateMusicArtist(
    sql: postgres.Sql,
    params: {
        name: string;
        libraryGroupId?: string | null;
    },
): Promise<string> {
    // Canonicalize VA aliases ("Various", "VA", "V.A.", "V/A") to the single
    // canonical label so they never create a second artist row.
    const name = isVariousArtistsName(params.name)
        ? VARIOUS_ARTISTS_LABEL
        : params.name.normalize('NFC');
    const isVa = isVariousArtistsName(params.name);
    const lgid = params.libraryGroupId ?? null;

    // Concurrency-safe find-or-create against the uq_music_artist_title_nfc
    // partial unique index (base schema). Every lookup below
    // spells its key, LOWER(TRIM(normalize(title, NFC))), so it is index-driven.
    // The bounded retry exists for one
    // narrow race: if the active row that ON CONFLICT collides with is
    // soft-deleted between the INSERT and the fallback SELECT, it no longer
    // occupies the (status='active') partial index, so the next iteration
    // re-inserts cleanly instead of dereferencing an empty fallback.
    for (let attempt = 0; attempt < 3; attempt++) {
        // Cross-lgid name match. status='active' matches the partial index so a
        // soft-deleted same-name row never shadows the live one; ORDER BY
        // created_at keeps the oldest (most-attached) row as the canonical one.
        const existing = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE media_type = 'artist'
              AND parent_id IS NULL
              AND status = 'active'
              AND LOWER(TRIM(normalize(title, NFC)))
                = LOWER(TRIM(normalize(${name}, NFC)))
            ORDER BY created_at ASC
            LIMIT 2
        `;
        // Unreachable while uq_music_artist_title_nfc exists; kept in case the
        // index is missing. The match-only resolvers return null on ambiguity
        // before they get here.
        if (existing.length > 1) throw new Error('Ambiguous Unicode artist identity');
        if (existing[0]) return existing[0].id;

        // No live title match — before minting a new row, check whether an
        // admin renamed this artist and we are looking at its former name.
        const aliased = await findMusicItemByScanAlias(sql, {
            mediaType: 'artist',
            parentId: null,
            title: name,
        });
        if (aliased) return aliased;

        // Target-less on purpose: every unique artist index is an arbiter.
        // Databases upgraded from before the 0.1 squash may keep the legacy
        // uq_music_artist_norm_title next to uq_music_artist_title_nfc; a
        // conflict on either must not raise 23505 and abort the caller's
        // transaction. A conflict the NFC lookup below cannot explain ends
        // in MusicArtistNotCreatableError.
        const rows = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, library_group_id, is_various_artists)
            VALUES (${name}, 'artist', ${lgid}, ${isVa})
            ON CONFLICT DO NOTHING
            RETURNING id
        `;
        if (rows[0]) {
            await refreshSortTitles(sql, [rows[0].id]);
            return rows[0].id;
        }

        // ON CONFLICT fired — another active row owns the name. Fetch it; if it
        // vanished (concurrent soft-delete) the fallback is empty, so loop and
        // re-insert rather than crash on `fallback[0].id`.
        const fallback = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE media_type = 'artist'
              AND parent_id IS NULL
              AND status = 'active'
              AND LOWER(TRIM(normalize(title, NFC)))
                = LOWER(TRIM(normalize(${name}, NFC)))
            ORDER BY created_at ASC
            LIMIT 2
        `;
        if (fallback.length > 1) throw new Error('Ambiguous Unicode artist identity');
        if (fallback[0]) return fallback[0].id;
    }
    throw new MusicArtistNotCreatableError(name);
}

/**
 * Match-only lookup for `findOrCreateMusicArtist`'s normalized-title
 * comparison — used by the remixer-credit scan pass, which must NEVER
 * create an artist from free text inside a track title. Cross-lgid on
 * purpose (see findOrCreateMusicArtist's doc for why lgid-scoped lookup
 * produced duplicate stubs). Returns null for Various-Artists aliases.
 */
export async function findMusicArtistByName(
    sql: postgres.Sql,
    name: string,
): Promise<string | null> {
    if (isVariousArtistsName(name)) return null;
    const rows = await sql<{ id: string }[]>`${musicArtistNameCandidatesSql(sql, name)} LIMIT 2`;
    return rows.length === 1 ? rows[0].id : null;
}

/**
 * Ids of active top-level artists whose title or a scan alias has the NFC key
 * of `name`. Two index-driven arms (the unique title index and the alias GIN
 * index) joined by UNION, because one `title = … OR EXISTS (aliases)` predicate
 * can use neither. The partial-index predicates are literals so generic
 * prepared plans match them.
 */
function musicArtistNameCandidatesSql(
    sql: postgres.Sql,
    name: string,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        SELECT id FROM media_items
        WHERE media_type = 'artist' AND parent_id IS NULL AND status = 'active'
          AND LOWER(TRIM(normalize(title, NFC))) = LOWER(TRIM(normalize(${name}::text, NFC)))
        UNION
        SELECT id FROM media_items
        WHERE media_type = 'artist' AND parent_id IS NULL AND status = 'active'
          AND custom_metadata ? 'scan_aliases'
          AND music_artist_alias_keys(custom_metadata)
              @> ARRAY[LOWER(TRIM(normalize(${name}::text, NFC)))]
    `;
}

/**
 * Every MusicBrainz id an artist row carries, lower-cased: its external_ids
 * rows and its custom_metadata.musicbrainz_artist_id. `artist` is the alias.
 */
function musicArtistProviderIdsSql(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`ARRAY(
        SELECT LOWER(known_id.external_id) FROM external_ids known_id
        WHERE known_id.media_id = artist.id AND known_id.provider = 'musicbrainz' AND known_id.media_type = 'artist'
        UNION SELECT LOWER(artist.custom_metadata->>'musicbrainz_artist_id')
            WHERE artist.custom_metadata->>'musicbrainz_artist_id' IS NOT NULL
    )`;
}

export interface MusicArtistProviderMatch {
    id: string;
    provider_ids: string[];
}

/**
 * Match-only provider identity lookup; multiple claimants remain ambiguous.
 * The two sources of a MusicBrainz id are separate UNION arms so each uses its
 * expression index (`idx_external_ids_musicbrainz_artist_lower`,
 * `idx_music_artist_custom_mbid`).
 */
export async function findMusicArtistProviderMatches(
    sql: postgres.Sql,
    musicbrainzId: string,
): Promise<MusicArtistProviderMatch[]> {
    const mbid = musicbrainzId.toLowerCase();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mbid)) return [];
    return sql<MusicArtistProviderMatch[]>`
        SELECT artist.id, ${musicArtistProviderIdsSql(sql)} AS provider_ids
        FROM (
            SELECT ei.media_id AS id FROM external_ids ei
            WHERE ei.provider = 'musicbrainz' AND ei.media_type = 'artist'
              AND LOWER(ei.external_id) = ${mbid}
            UNION
            SELECT claimed.id FROM media_items claimed
            WHERE claimed.media_type = 'artist' AND claimed.parent_id IS NULL AND claimed.status = 'active'
              AND LOWER(claimed.custom_metadata->>'musicbrainz_artist_id') = ${mbid}
        ) matched
        JOIN media_items artist ON artist.id = matched.id
        WHERE artist.media_type = 'artist' AND artist.parent_id IS NULL AND artist.status = 'active'
        LIMIT 2
    `;
}

/** Validate an established identity without depending on its current title. */
export async function isActiveMusicArtistCredit(
    sql: postgres.Sql,
    id: string,
    providerId?: string,
): Promise<boolean> {
    if (providerId === undefined) {
        const [row] = await sql<{ valid: boolean }[]>`
            SELECT true AS valid FROM media_items artist
            WHERE artist.id = ${id}::uuid AND artist.media_type = 'artist'
              AND artist.parent_id IS NULL AND artist.status = 'active'
        `;
        return Boolean(row);
    }
    // Tags may carry an upper-case MBID; every stored side is compared lowered.
    providerId = providerId.toLowerCase();
    // The identity must carry no other MusicBrainz id, and no other active
    // artist may claim this one. Each claim source is its own NOT EXISTS so
    // both use their expression index.
    const [row] = await sql<{ valid: boolean }[]>`
        SELECT true AS valid FROM media_items artist
        WHERE artist.id = ${id}::uuid AND artist.media_type = 'artist'
          AND artist.parent_id IS NULL AND artist.status = 'active'
          AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = artist.id
              AND ei.provider = 'musicbrainz' AND ei.media_type = 'artist'
              AND LOWER(ei.external_id) <> ${providerId})
          AND (artist.custom_metadata->>'musicbrainz_artist_id' IS NULL
              OR LOWER(artist.custom_metadata->>'musicbrainz_artist_id') = ${providerId})
          AND NOT EXISTS (SELECT 1 FROM external_ids ei
              JOIN media_items other ON other.id = ei.media_id
              WHERE ei.provider = 'musicbrainz' AND ei.media_type = 'artist'
                AND LOWER(ei.external_id) = ${providerId}
                AND other.id <> artist.id AND other.media_type = 'artist'
                AND other.parent_id IS NULL AND other.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM media_items other
              WHERE other.media_type = 'artist' AND other.parent_id IS NULL AND other.status = 'active'
                AND LOWER(other.custom_metadata->>'musicbrainz_artist_id') = ${providerId}
                AND other.id <> artist.id)
    `;
    return Boolean(row);
}

/** Resolve a tag credit without attaching contradictory provider identities. */
export async function resolveMusicArtistCredit(
    sql: postgres.Sql,
    name: string,
    musicbrainzId?: string,
    libraryGroupId?: string | null,
): Promise<string | null> {
    const mbid = musicbrainzId?.toLowerCase();
    if (mbid && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(mbid)) {
        return null;
    }
    if (mbid) {
        const known = await findMusicArtistProviderMatches(sql, mbid);
        if (known.length > 1) return null;
        if (known[0]) return known[0].provider_ids.some((id) => id !== mbid) ? null : known[0].id;
    }
    const candidates = await sql<{ id: string; provider_ids: string[] }[]>`
        SELECT artist.id, ${musicArtistProviderIdsSql(sql)} AS provider_ids
        FROM (${musicArtistNameCandidatesSql(sql, name)}) matched
        JOIN media_items artist ON artist.id = matched.id
        LIMIT 2
    `;
    if (candidates.length > 1) return null;
    if (candidates[0]) {
        if (mbid && candidates[0].provider_ids.some((id) => id !== mbid)) return null;
        return candidates[0].id;
    }
    // An unverified tag ID is evidence, never a catalog identity write. Provider
    // enrichment may establish it later through CatalogService.
    try {
        return await findOrCreateMusicArtist(sql, { name, libraryGroupId });
    } catch (error) {
        // An uncreatable name stays an unresolved, name-only credit.
        if (error instanceof MusicArtistNotCreatableError) return null;
        throw error;
    }
}

/**
 * Find an existing music album under a given artist, or create one.
 * Albums have media_type='album', parent_id=artistId.
 * Concurrency-safe: INSERT ON CONFLICT DO NOTHING + fallback SELECT.
 *
 * Same cross-lgid lookup discipline as findOrCreateMusicArtist: the album
 * is uniquely identified by (parentArtistId, title) and the lgid is
 * only used on the INSERT path. Scoping the lookup by lgid produced the
 * same duplicate-on-library-change failure mode that hit artist-enrichment
 * on preprod; this prevents the same drift for album-enrichment.
 */
export async function findOrCreateMusicAlbum(
    sql: postgres.Sql,
    params: {
        title: string;
        artistId: string;
        year?: number;
        libraryGroupId?: string | null;
    },
): Promise<string> {
    const lgid = params.libraryGroupId ?? null;
    const sortOrder = params.year != null && params.year > 0 ? params.year : null;

    // Concurrency-safe find-or-create against uq_music_album_parent_title
    // (migration 16.77.0). Same bounded-retry rationale as
    // findOrCreateMusicArtist: albums CAN be soft-deleted
    // (softDeleteOrphanMusicItems), so the active row ON CONFLICT collides with
    // may vanish between the INSERT and the fallback SELECT — loop and re-insert
    // instead of crashing on an empty fallback.
    for (let attempt = 0; attempt < 3; attempt++) {
        const existing = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE media_type = 'album'
              AND parent_id = ${params.artistId}
              AND status = 'active'
              AND LOWER(TRIM(title)) = LOWER(TRIM(${params.title}))
            ORDER BY created_at ASC
            LIMIT 1
        `;
        if (existing[0]) return existing[0].id;

        // No live title match — the album may simply have been renamed by hand
        // while the files still carry the original ALBUM tag. Absorb into the
        // renamed row instead of splitting the album into two.
        const aliased = await findMusicItemByScanAlias(sql, {
            mediaType: 'album',
            parentId: params.artistId,
            title: params.title,
        });
        if (aliased) return aliased;

        // As with the artist resolver, the old bare `ON CONFLICT DO NOTHING` had
        // no unique index to fire on, so concurrent scans created duplicate
        // albums under the same artist. The conflict target + partial-index
        // WHERE must match the index exactly for arbiter inference.
        const rows = await sql<{ id: string }[]>`
            INSERT INTO media_items (title, media_type, parent_id, year, sort_order, library_group_id)
            VALUES (${params.title}, 'album', ${params.artistId}, ${params.year ?? null}, ${sortOrder}, ${lgid})
            ON CONFLICT (parent_id, LOWER(TRIM(title)))
                WHERE media_type = 'album' AND parent_id IS NOT NULL AND status = 'active'
            DO NOTHING
            RETURNING id
        `;
        if (rows[0]) {
            await refreshSortTitles(sql, [rows[0].id]);
            return rows[0].id;
        }

        const fallback = await sql<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE media_type = 'album'
              AND parent_id = ${params.artistId}
              AND status = 'active'
              AND LOWER(TRIM(title)) = LOWER(TRIM(${params.title}))
            ORDER BY created_at ASC
            LIMIT 1
        `;
        if (fallback[0]) return fallback[0].id;
    }
    throw new Error(
        `findOrCreateMusicAlbum: could not resolve album "${params.title}" under artist ${params.artistId} after retries`,
    );
}

/**
 * Find an existing episode media_item under a series by season+episode position.
 *
 * Returns the episode UUID if found, else null. Used by the W2.2 Jellyfin
 * attach-only metadata-sync path to look up a TMDB-derived episode row that
 * Jellyfin should attach its own external_id to (instead of creating a new
 * episode row from Jellyfin's possibly-contaminated children list).
 *
 * Constrained to series → season → episode hierarchy: the season's parent must
 * be the series UUID, and the season's media_type must be 'season'.
 */
export async function findEpisodeByPosition(
    sql: postgres.Sql,
    seriesId: string,
    seasonNumber: number,
    episodeNumber: number,
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        SELECT e.id
        FROM media_items e
        JOIN media_items s ON s.id = e.parent_id AND s.media_type = 'season'
        WHERE s.parent_id = ${seriesId}
          AND e.media_type = 'episode'
          AND s.season_number = ${seasonNumber}
          AND e.episode_number = ${episodeNumber}
        ORDER BY e.id
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

export async function findEpisodeDataByPosition(
    sql: postgres.Sql,
    seriesId: string,
    seasonNumber: number,
    episodeNumber: number,
): Promise<{
    id: string;
    title: string;
    seasonNumber: number;
    episodeNumber: number;
    runtimeSeconds: number | null;
    hasFiles: boolean;
} | null> {
    const rows = await sql<
        {
            id: string;
            title: string;
            season_number: number;
            episode_number: number;
            runtime_seconds: number | null;
            has_files: boolean;
        }[]
    >`
        SELECT ep.id, ep.title,
               COALESCE(eo.order_season_number, season.season_number) AS season_number,
               COALESCE(eo.order_episode_number, ep.episode_number) AS episode_number,
               ep.runtime_seconds,
               ep.has_files
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        ${buildAutoEpisodeOrderingJoinFragment(sql, 'ep', 'season.parent_id')}
        WHERE season.parent_id = ${seriesId}
          AND ep.media_type = 'episode'
          AND COALESCE(eo.order_season_number, season.season_number) = ${seasonNumber}
          AND COALESCE(eo.order_episode_number, ep.episode_number) = ${episodeNumber}
        -- Duplicate S/E rows: the same pick as new-episode alerts
        -- (new-episodes.service.ts), so an alert's episode and the modal's
        -- "Watch SxEy" agree: active first, then one with a file.
        ORDER BY (ep.status = 'active') DESC, ep.has_files DESC, ep.created_at ASC, ep.id ASC
        LIMIT 1
    `;
    if (!rows[0]) return null;
    return {
        id: rows[0].id,
        title: rows[0].title,
        seasonNumber: rows[0].season_number,
        episodeNumber: rows[0].episode_number,
        runtimeSeconds: rows[0].runtime_seconds,
        hasFiles: rows[0].has_files,
    };
}

/**
 * The one duration the API shows for a playable item, in milliseconds, for every
 * caller (the media node, episode nodes, next-episode, play-session start). In order:
 *
 *  1. the item's own segment window on a combined file (`end_offset_ms -
 *     start_offset_ms` of its link, default link first): the span the player
 *     plays for that episode;
 *  2. the probed length of its longest linked file (an episode in a multi-episode
 *     file gets its share, computed as in {@link findEffectiveRuntimeSeconds});
 *  3. `media_items.runtime_seconds`.
 *
 * Note the precedence is the reverse of findEffectiveRuntimeSeconds (which prefers
 * runtime_seconds): the probe is what the player actually plays. Metadata runtimes
 * (TMDB minutes) are NOT used here. Items without a value are absent from the map.
 *
 * Batch twin of {@link findPlaybackDurationMs}: the one SQL lives here, so the two
 * cannot drift. Ids are canonical lowercase UUIDs (as the database returns them).
 *
 * No access check: callers pass already access-checked ids.
 */
export async function findPlaybackDurationsMs(
    sql: postgres.Sql,
    mediaItemIds: readonly string[],
): Promise<Map<string, number>> {
    const durations = new Map<string, number>();
    const ids = [...new Set(mediaItemIds)];
    if (ids.length === 0) return durations;

    const rows = await sql<{ media_item_id: string; duration_ms: string | number | null }[]>`
        SELECT mi.id::text AS media_item_id,
               COALESCE(
                   (
                       SELECT (win.end_offset_ms - win.start_offset_ms)::bigint
                       FROM media_file_items win
                       WHERE win.media_item_id = mi.id
                         AND win.start_offset_ms IS NOT NULL
                         AND win.end_offset_ms > win.start_offset_ms
                       ORDER BY win.is_default DESC, win.file_id
                       LIMIT 1
                   ),
                   (
                       SELECT ROUND(share.seconds * 1000)::bigint
                       FROM media_files mf
                       JOIN media_file_items mfi ON mfi.file_id = mf.id
                       CROSS JOIN LATERAL (
                           SELECT mf.duration_seconds / CASE
                               WHEN mi.media_type = 'episode' THEN GREATEST(1, (
                                   SELECT COUNT(DISTINCT sib.media_item_id)
                                   FROM media_file_items sib
                                   JOIN media_items sibi ON sibi.id = sib.media_item_id
                                   WHERE sib.file_id = mf.id
                                     AND sibi.media_type = 'episode'
                                     AND sibi.status = 'active'
                               ))
                               ELSE 1
                           END AS seconds
                       ) share
                       WHERE mfi.media_item_id = mi.id
                         AND mf.duration_seconds IS NOT NULL
                         AND mf.duration_seconds > 0
                       ORDER BY share.seconds DESC
                       LIMIT 1
                   ),
                   NULLIF(mi.runtime_seconds, 0)::bigint * 1000
               ) AS duration_ms
        FROM media_items mi
        WHERE mi.id = ANY(${ids}::uuid[])
    `;
    for (const row of rows) {
        if (row.duration_ms == null) continue;
        const value = Number(row.duration_ms);
        if (value > 0) durations.set(row.media_item_id, value);
    }
    return durations;
}

/**
 * Single-item form of {@link findPlaybackDurationsMs}; same rule, same SQL.
 * Returns null when no source gives a positive value.
 */
export async function findPlaybackDurationMs(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<number | null> {
    const durations = await findPlaybackDurationsMs(sql, [mediaItemId]);
    return durations.get(mediaItemId.toLowerCase()) ?? null;
}

/**
 * Effective runtime of a media item in whole seconds: `media_items.runtime_seconds`
 * when set (metadata wins over files), else the item's share of a probed
 * `media_files.duration_seconds` linked to it.
 *
 * Fresh episodes often have a probed file before their metadata carries a
 * runtime. A combined multi-episode file is linked to several episode rows, so
 * an episode gets `duration / number of active episode rows linked to that file`; for
 * any other item (a movie) the full duration counts. The longest share wins
 * when an item has several file variants. Returns null when neither source gives
 * a positive value (e.g. an unaired episode).
 *
 * No access check: callers pass an id derived from an already access-checked series.
 */
export async function findEffectiveRuntimeSeconds(
    sql: postgres.Sql,
    mediaItemId: string,
): Promise<number | null> {
    const rows = await sql<{ runtime_seconds: number | null }[]>`
        SELECT COALESCE(
            NULLIF(mi.runtime_seconds, 0),
            (
                SELECT ROUND(share.seconds)::int
                FROM media_files mf
                JOIN media_file_items mfi ON mfi.file_id = mf.id
                CROSS JOIN LATERAL (
                    SELECT mf.duration_seconds / CASE
                        WHEN mi.media_type = 'episode' THEN GREATEST(1, (
                            SELECT COUNT(DISTINCT sib.media_item_id)
                            FROM media_file_items sib
                            JOIN media_items sibi ON sibi.id = sib.media_item_id
                            WHERE sib.file_id = mf.id
                              AND sibi.media_type = 'episode'
                              AND sibi.status = 'active'
                        ))
                        ELSE 1
                    END AS seconds
                ) share
                WHERE mfi.media_item_id = mi.id
                  AND mf.duration_seconds IS NOT NULL
                  AND mf.duration_seconds > 0
                ORDER BY share.seconds DESC
                LIMIT 1
            )
        ) AS runtime_seconds
        FROM media_items mi
        WHERE mi.id = ${mediaItemId}::uuid
    `;
    const value = rows[0]?.runtime_seconds ?? null;
    return value !== null && value > 0 ? value : null;
}

/**
 * Find an existing episode media_item under a series by the provider's
 * per-episode ID (e.g. TMDB episode id), matched through `external_ids`.
 *
 * This is the identity-stable counterpart to `findEpisodeDataByPosition`:
 * position matching breaks whenever the provider's *current* season/episode
 * numbering diverges from what we stored — either because the provider
 * re-numbered the season after our initial sync (TMDB frequently re-orders
 * older shows, e.g. Hafentage S2), or because an active custom/absolute ordering
 * override shifts our display numbers away from the provider's standard order.
 * In both cases a provider-supplied title fetched for "S/E position N" would
 * be stapled onto the wrong local episode. The per-episode external_id is the
 * only key that survives both, and it is the same identity the main metadata
 * sync uses when it attaches episodes (`metadata-sync-single.service.ts`).
 *
 * Constrained to the series → season → episode hierarchy: the resolved
 * episode's season must be a direct child of `seriesId`.
 *
 * Does not filter dismissed/soft-deleted episodes (parity with
 * `findEpisodeDataByPosition`): the UNIQUE `(provider, external_id, media_type)`
 * constraint on `external_ids` guarantees at most one local row holds a given
 * tmdb episode id, and `CatalogService.upsertExternalId` throws rather than
 * re-point it, so this can only ever resolve that single row — writing a
 * translation onto a dismissed row is a harmless cosmetic no-op, not a
 * mis-attach. `ei.media_type` is intentionally omitted from the join: the outer
 * `ep.media_type = 'episode'` already disambiguates a numeric id that a movie
 * might share, so adding it would be redundant.
 */
export async function findEpisodeDataByProviderEpisodeId(
    sql: postgres.Sql,
    seriesId: string,
    provider: string,
    providerEpisodeId: string,
): Promise<{
    id: string;
    title: string;
    seasonNumber: number;
    episodeNumber: number;
    runtimeSeconds: number | null;
} | null> {
    const rows = await sql<
        {
            id: string;
            title: string;
            season_number: number;
            episode_number: number;
            runtime_seconds: number | null;
        }[]
    >`
        SELECT ep.id, ep.title, season.season_number, ep.episode_number, ep.runtime_seconds
        FROM media_items ep
        JOIN media_items season ON season.id = ep.parent_id AND season.media_type = 'season'
        JOIN external_ids ei
          ON ei.media_id = ep.id
         AND ei.provider = ${provider}
         AND ei.external_id = ${providerEpisodeId}
        WHERE season.parent_id = ${seriesId}
          AND ep.media_type = 'episode'
        ORDER BY ep.id
        LIMIT 1
    `;
    if (!rows[0]) return null;
    return {
        id: rows[0].id,
        title: rows[0].title,
        seasonNumber: rows[0].season_number,
        episodeNumber: rows[0].episode_number,
        runtimeSeconds: rows[0].runtime_seconds,
    };
}

/**
 * Find an existing season media_item under a series by season number.
 *
 * Returns the season UUID if found, else null. Companion to
 * `findEpisodeByPosition` for the W2.2 Jellyfin attach-only path: when a
 * Jellyfin season exists in the metadata payload but no TMDB-derived season
 * row is present locally, the caller quarantines the season and skips its
 * episodes (we have nowhere to attach them).
 */
export async function findSeasonByNumber(
    sql: postgres.Sql,
    seriesId: string,
    seasonNumber: number,
): Promise<string | null> {
    const rows = await sql<{ id: string }[]>`
        SELECT id FROM media_items
        WHERE parent_id = ${seriesId}
          AND media_type = 'season'
          AND season_number = ${seasonNumber}
        LIMIT 1
    `;
    return rows[0]?.id ?? null;
}

/**
 * Get the next available episode number for a season.
 * Returns MAX(episode_number) + 1, or 1 if the season has no episodes yet.
 */
export async function getNextEpisodeNumber(sql: postgres.Sql, seasonId: string): Promise<number> {
    const [row] = await sql<[{ next_ep: number }]>`
        SELECT COALESCE(MAX(episode_number), 0)::int + 1 AS next_ep
        FROM media_items
        WHERE parent_id = ${seasonId}
          AND media_type = 'episode'
    `;
    return row.next_ep;
}

/**
 * Returns true if the season already has at least one episode carrying a
 * provider id (canonical metadata). Used by the file-scanner to refuse blindly
 * auto-numbering past the canonical range when the filename parser failed.
 *
 * Any provider counts, not just Jellyfin. This was Jellyfin-only when Jellyfin
 * supplied episode metadata; with TMDB as the usual source (Jellyfin optional),
 * a TMDB-only season read as non-canonical — on production that auto-numbered
 * ACCA's 12 files to invented "Episode 13".."23" beside the real, file-less
 * episodes 1-12. Scanner-created episodes carry no provider id, so they still
 * do not count and cannot block one another.
 */
export async function seasonHasCanonicalEpisodes(
    sql: postgres.Sql,
    seasonId: string,
): Promise<boolean> {
    const [row] = await sql<[{ has_canonical: boolean }]>`
        SELECT EXISTS(
            SELECT 1
            FROM media_items mi
            JOIN external_ids ei ON ei.media_id = mi.id
            WHERE mi.parent_id = ${seasonId}
              AND mi.media_type = 'episode'
        ) AS has_canonical
    `;
    return row.has_canonical;
}

export interface CanonicalEpisodeTitleRow {
    id: string;
    title: string;
    english_title: string | null;
    original_title: string | null;
}

/**
 * Titles of the canonical (provider-identified) episodes in one season, or in
 * every season of a series. Feeds the scanner's title match for files whose
 * name carries no episode number. Admin-scoped scanner read: no library filter.
 */
export async function listCanonicalEpisodeTitles(
    sql: postgres.Sql,
    scope: { seasonId: string } | { seriesId: string },
): Promise<CanonicalEpisodeTitleRow[]> {
    const parentFilter =
        'seasonId' in scope
            ? sql`mi.parent_id = ${scope.seasonId}`
            : sql`mi.parent_id IN (
                  SELECT s.id FROM media_items s
                  WHERE s.parent_id = ${scope.seriesId} AND s.media_type = 'season'
              )`;
    return sql<CanonicalEpisodeTitleRow[]>`
        SELECT mi.id, mi.title, mi.english_title, mi.original_title
        FROM media_items mi
        WHERE ${parentFilter}
          AND mi.media_type = 'episode'
          AND EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
    `;
}

/**
 * Whether any season of the series holds a canonical (provider-identified)
 * episode. Series-wide twin of {@link seasonHasCanonicalEpisodes}, for
 * daily-show files whose folder season ("Season 2021") never holds one.
 */
export async function seriesHasCanonicalEpisodes(
    sql: postgres.Sql,
    seriesId: string,
): Promise<boolean> {
    const [row] = await sql<[{ has_canonical: boolean }]>`
        SELECT EXISTS(
            SELECT 1
            FROM media_items mi
            JOIN media_items s ON s.id = mi.parent_id AND s.media_type = 'season'
            JOIN external_ids ei ON ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file'
            WHERE s.parent_id = ${seriesId}
              AND mi.media_type = 'episode'
        ) AS has_canonical
    `;
    return row.has_canonical;
}

export interface CanonicalEpisodeByAirDateRow {
    id: string;
    season_id: string;
    season_number: number;
    episode_number: number | null;
}

/**
 * Canonical (provider-identified) episodes of a series that aired on one day,
 * for daily-show files named by date ("The Show 2021.03.14.mkv"). Searches
 * every season: providers number daily shows by year or by run, never by the
 * folder the files sit in. Admin-scoped scanner read: no library filter.
 */
export async function findCanonicalEpisodesByAirDate(
    sql: postgres.Sql,
    seriesId: string,
    airDate: string,
): Promise<CanonicalEpisodeByAirDateRow[]> {
    return sql<CanonicalEpisodeByAirDateRow[]>`
        SELECT mi.id, mi.parent_id AS season_id, mi.season_number, mi.episode_number
        FROM media_items mi
        JOIN media_items s ON s.id = mi.parent_id AND s.media_type = 'season'
        WHERE s.parent_id = ${seriesId}
          AND mi.media_type = 'episode'
          AND mi.premiere_date = ${airDate}::date
          AND EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
        ORDER BY mi.season_number, mi.episode_number
    `;
}

export interface PersonalMediaLibraryGroup {
    id: string;
    name: string;
}

/**
 * Get the distinct library groups that contain personal (unmatched) media items.
 * Used to populate the library group filter in the admin unmatched items UI.
 * Derives the group name from the first library path in each group.
 */
export async function getPersonalMediaLibraryGroups(
    sql: postgres.Sql,
): Promise<PersonalMediaLibraryGroup[]> {
    const rows = await sql<{ id: string; path: string }[]>`
        SELECT DISTINCT ON (lp.library_group_id)
            lp.library_group_id AS id,
            lp.path
        FROM library_paths lp
        JOIN media_files mf ON mf.library_group_id = lp.library_group_id
        JOIN media_file_items mfi ON mfi.file_id = mf.id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
          AND NOT mi.is_dismissed
        ORDER BY lp.library_group_id, lp.created_at ASC
    `;
    return rows.map((r) => {
        const trimmed = r.path.endsWith('/') ? r.path.slice(0, -1) : r.path;
        const name = trimmed.split('/').pop() || trimmed;
        return { id: r.id, name };
    });
}

export interface SeriesChildRow {
    season_id: string;
    /** Always an integer — NULL stored as 0 via COALESCE */
    season_number: number;
    season_title: string;
    episode_id: string;
    /** Always an integer — NULL stored as 0 via COALESCE */
    episode_number: number;
    episode_title: string;
    file_path: string | null;
    file_size_bytes: number | null;
    duration_seconds: number | null;
}

/**
 * Get all seasons and episodes for a personal series, ordered by season then episode number.
 * Returns a flat list of season+episode rows for the caller to group into a tree.
 *
 * DISTINCT ON (s.id, ep.id) ensures each episode appears exactly once even when the
 * episode has multiple files attached — the file with the largest file_size_bytes is
 * preferred (ORDER BY mf.file_size_bytes DESC NULLS LAST within the distinct group).
 * season_number / episode_number are coalesced to 0 so callers never receive NULL for
 * fields that the schema declares as z.number().int().
 */
export async function getSeriesChildren(
    sql: postgres.Sql,
    seriesId: string,
): Promise<SeriesChildRow[]> {
    return sql<SeriesChildRow[]>`
        SELECT DISTINCT ON (s.id, ep.id)
            s.id AS season_id,
            COALESCE(s.season_number, 0) AS season_number,
            COALESCE(s.title, 'Season ' || COALESCE(s.season_number::text, '0')) AS season_title,
            ep.id AS episode_id,
            COALESCE(ep.episode_number, 0) AS episode_number,
            ep.title AS episode_title,
            mf.file_path AS file_path,
            mf.file_size_bytes AS file_size_bytes,
            mf.duration_seconds
        FROM media_items s
        JOIN media_items ep ON ep.parent_id = s.id AND ep.media_type = 'episode'
        LEFT JOIN media_file_items mfi ON mfi.media_item_id = ep.id
        LEFT JOIN media_files mf ON mf.id = mfi.file_id
        WHERE s.parent_id = ${seriesId}
          AND s.media_type = 'season'
          AND NOT ep.is_dismissed
        ORDER BY s.id, ep.id, mf.file_size_bytes DESC NULLS LAST
    `;
}

/**
 * Soft-dismiss a media item and all its descendants (seasons, episodes).
 * Uses a recursive CTE to collect all child IDs before updating.
 * The rows and their media_file_items links are preserved so the file scanner
 * does not re-create the item on subsequent scans.
 *
 * `has_files` is cleared in the same statement: every library surface (browse,
 * search, home, /j, /api/v1) gates on `has_files = true` and never reads
 * `is_dismissed`, so a dismissal that kept the flag left the item playable for
 * every user. While a row is dismissed the has_files re-derivers
 * (media-files.queries.ts, the cleanup backfill) leave it alone;
 * restoreDismissedMediaItemWithChildren re-derives it from the untouched links.
 * Items that have any external id are left alone (returns 0).
 * Returns the number of rows dismissed.
 */
export async function dismissMediaItemWithChildren(sql: postgres.Sql, id: string): Promise<number> {
    const rows = await sql<{ id: string }[]>`
        WITH RECURSIVE descendants AS (
            -- Only an item with no provider match: dismissing clears has_files,
            -- which hides the item for everyone and starts the retention clock.
            -- A matched item is not an "unmatched file" (the list's own rule).
            SELECT id FROM media_items mi0
            WHERE mi0.id = ${id}
              AND NOT EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id = mi0.id AND ei.source IS DISTINCT FROM 'watch-sync-file')
            UNION ALL
            SELECT mi.id FROM media_items mi
            JOIN descendants d ON mi.parent_id = d.id
        )
        UPDATE media_items SET is_dismissed = true, has_files = false
        WHERE id IN (SELECT id FROM descendants)
        RETURNING id
    `;
    return rows.length;
}

// =============================================================================
// Duplicate Series Cleanup
// =============================================================================

/**
 * Thrown by {@link mergeDuplicateSeries} with `guard: 'adminPair'` when the
 * pair no longer satisfies the operator merge rules once the rows are locked.
 */
export class MergeGuardError extends Error {
    constructor(
        readonly reason: 'missing' | 'inactive' | 'media-type' | 'files',
        message: string,
    ) {
        super(message);
        this.name = 'MergeGuardError';
    }
}

export interface MergeDuplicateSeriesOptions {
    /**
     * 'adminPair': the operator merge endpoint's rules, re-checked on the
     * locked rows inside the transaction: both rows active and not dismissed,
     * same media_type, the keeper has files and the merged row has none. The
     * endpoint checks the same before calling, but outside the transaction a
     * concurrent scan or identify could change either row in between.
     * Reconciliation callers merge ghost rows where both or neither have files
     * and must not pass it.
     */
    guard?: 'adminPair';
}

/**
 * Merge duplicate series: re-parent children from source to target, then delete source.
 * Handles: seasons, episodes (via seasons), external_ids, media_file_items, watchlist, ratings.
 */
export async function mergeDuplicateSeries(
    sql: postgres.Sql,
    keepId: string,
    mergeId: string,
    opts: MergeDuplicateSeriesOptions = {},
): Promise<{ seasonsReparented: number; itemsDeleted: number }> {
    // withTx (not raw sql.begin): worker task handlers pass a ReservedSql,
    // which has no .begin — raw sql.begin threw "not a function" there and
    // silently failed every merge issued from a background task (season-
    // structure ghost merges, 2026-07-10). withTx handles all handle types.
    return withTx(sql, (txRaw) =>
        mergeDuplicateSeriesInTx(txRaw as unknown as postgres.Sql, keepId, mergeId, opts),
    );
}

/**
 * The merge itself, on a handle that is already inside the caller's
 * transaction. Opens no transaction or savepoint of its own: a caller that
 * holds a ReservedSql in a manual BEGIN would have its transaction committed
 * early by a nested withTx. Callers that need the merge to commit or roll back
 * together with other writes (the reconciliation services) use this directly
 * and fire the lifecycle hooks themselves after their commit
 * (MediaDeletionService.runMergeHooks).
 */
export async function mergeDuplicateSeriesInTx(
    tx: postgres.Sql,
    keepId: string,
    mergeId: string,
    opts: MergeDuplicateSeriesOptions = {},
): Promise<{ seasonsReparented: number; itemsDeleted: number }> {
    // Serialize merges that touch the same pair of items, in EITHER
    // direction. Under READ COMMITTED two concurrent callers running
    // mergeDuplicateSeries(A, B) and mergeDuplicateSeries(B, A) acquire row
    // locks on A and B in opposite orders across the many UPDATEs below and
    // PostgreSQL aborts one with a deadlock (40P01) that propagates as an
    // uncaught 500. A transaction-scoped advisory lock keyed on the SORTED
    // pair forces both directions to contend on the same lock, so the second
    // caller waits for the first to commit instead of deadlocking. The key
    // is a stable hash of the ordered "least|greatest" id string; collisions
    // only cause extra (harmless) serialization, never incorrectness.
    await tx`
        SELECT pg_advisory_xact_lock(
            hashtextextended(LEAST(${keepId}, ${mergeId}) || '|' || GREATEST(${keepId}, ${mergeId}), 0)
        )
    `;

    if (opts.guard === 'adminPair') {
        // Locked in id order, like the advisory key, so two merges of the
        // same pair cannot deadlock here either.
        const rows = await tx<
            {
                id: string;
                media_type: string;
                has_files: boolean;
                status: string;
                is_dismissed: boolean;
            }[]
        >`
            SELECT id, media_type, has_files, status, is_dismissed
            FROM media_items
            WHERE id IN (${keepId}, ${mergeId})
            ORDER BY id
            FOR UPDATE
        `;
        const keep = rows.find((r) => r.id === keepId);
        const merge = rows.find((r) => r.id === mergeId);
        if (!keep || !merge) {
            throw new MergeGuardError('missing', 'A media item to merge no longer exists');
        }
        if (
            keep.status !== 'active' ||
            merge.status !== 'active' ||
            keep.is_dismissed ||
            merge.is_dismissed
        ) {
            throw new MergeGuardError('inactive', 'A media item to merge is no longer active');
        }
        if (keep.media_type !== merge.media_type) {
            throw new MergeGuardError('media-type', 'Cannot merge across media types');
        }
        if (!keep.has_files || merge.has_files) {
            throw new MergeGuardError(
                'files',
                'The kept item must have files and the merged item none',
            );
        }
    }

    // Re-parent seasons that don't conflict with existing seasons in keepId.
    // If keepId already has that season_number, re-parent episodes instead.
    const sourceSeasonsRows = await tx<{ id: string; season_number: number | null }[]>`
        SELECT id, season_number FROM media_items
        WHERE parent_id = ${mergeId} AND media_type = 'season'
    `;

    let seasonsReparented = 0;
    let itemsDeleted = 0;

    // Rows whose has_files must be re-derived once the moves are done.
    // The keeper's episode rows were created file-less; re-pointing a
    // media_file_items row onto them does NOT flip the denormalized flag,
    // and availability is has_files alone (availability.queries.ts). Before
    // this, a merge that correctly moved every link still left the episodes
    // reporting "not on disk" — the 2026-08-21 prod repair needed a separate
    // recompute pass to actually fix the symptom. recomputeHasFilesBatch
    // walks UP from each seed, so seeding the episodes covers their season
    // and series rollup too.
    const hasFilesSeeds = new Set<string>([keepId]);

    for (const sourceSeason of sourceSeasonsRows) {
        // Check if keepId already has this season (IS NOT DISTINCT FROM handles NULL)
        const existingSeason = await tx<{ id: string }[]>`
            SELECT id FROM media_items
            WHERE parent_id = ${keepId}
              AND media_type = 'season'
              AND season_number IS NOT DISTINCT FROM ${sourceSeason.season_number}
            LIMIT 1
        `;

        if (existingSeason[0]) {
            // Season exists — move non-conflicting episodes to existing season
            const movedEpisodes = await tx<{ id: string }[]>`
                UPDATE media_items
                SET parent_id = ${existingSeason[0].id}
                WHERE parent_id = ${sourceSeason.id} AND media_type = 'episode'
                  AND NOT EXISTS (
                      SELECT 1 FROM media_items existing
                      WHERE existing.parent_id = ${existingSeason[0].id}
                        AND existing.media_type = 'episode'
                        AND existing.episode_number IS NOT DISTINCT FROM media_items.episode_number
                        AND existing.season_number IS NOT DISTINCT FROM media_items.season_number
                  )
                RETURNING id
            `;
            for (const row of movedEpisodes) hasFilesSeeds.add(row.id);
            // For remaining (conflicting) episodes: move their file associations
            // to the kept episode before deleting, so we don't lose file links.
            const relinked = await tx<{ media_item_id: string }[]>`
                UPDATE media_file_items mfi
                SET media_item_id = kept_ep.id
                FROM media_items dup_ep
                JOIN media_items kept_ep
                  ON kept_ep.parent_id = ${existingSeason[0].id}
                 AND kept_ep.media_type = 'episode'
                 AND kept_ep.episode_number IS NOT DISTINCT FROM dup_ep.episode_number
                 AND kept_ep.season_number IS NOT DISTINCT FROM dup_ep.season_number
                WHERE dup_ep.parent_id = ${sourceSeason.id}
                  AND dup_ep.media_type = 'episode'
                  AND mfi.media_item_id = dup_ep.id
                  AND NOT EXISTS (
                      SELECT 1 FROM media_file_items mfi2
                      WHERE mfi2.file_id = mfi.file_id
                        AND mfi2.media_item_id = kept_ep.id
                  )
                RETURNING mfi.media_item_id
            `;
            for (const row of relinked) hasFilesSeeds.add(row.media_item_id);
            // Files alone are not the episode: preserve resume, events, ratings,
            // playlists and flags before the duplicate children cascade-delete.
            // Reuse the root merge's collision policy: canonical data wins.
            const duplicateEpisodes = await tx<{ source_id: string; target_id: string }[]>`
                SELECT dup_ep.id AS source_id, kept_ep.id AS target_id
                FROM media_items dup_ep
                JOIN media_items kept_ep
                  ON kept_ep.parent_id = ${existingSeason[0].id}
                 AND kept_ep.media_type = 'episode'
                 AND kept_ep.episode_number IS NOT DISTINCT FROM dup_ep.episode_number
                 AND kept_ep.season_number IS NOT DISTINCT FROM dup_ep.season_number
                WHERE dup_ep.parent_id = ${sourceSeason.id} AND dup_ep.media_type = 'episode'
            `;
            for (const pair of duplicateEpisodes) {
                await moveMergedItemUserData(tx, pair.target_id, pair.source_id);
            }
            await moveMergedItemUserData(tx, existingSeason[0].id, sourceSeason.id);
            const removedChildren =
                await tx`DELETE FROM media_items WHERE parent_id = ${sourceSeason.id} RETURNING id`;
            const removedSeason =
                await tx`DELETE FROM media_items WHERE id = ${sourceSeason.id} RETURNING id`;
            itemsDeleted += removedChildren.length + removedSeason.length;
        } else {
            // No conflict — just re-parent the entire season
            await tx`
                UPDATE media_items SET parent_id = ${keepId}
                WHERE id = ${sourceSeason.id}
            `;
            seasonsReparented++;
        }
    }

    // Move any direct children (non-season) that might exist
    await tx`
        UPDATE media_items SET parent_id = ${keepId}
        WHERE parent_id = ${mergeId} AND media_type != 'season'
    `;

    // Move external_ids that aren't already on keepId. The conflict guard
    // must match the unique key the move can actually collide with —
    // idx_external_ids_one_per_provider UNIQUE (media_id, provider,
    // media_type), i.e. one external id per provider PER media_type per item.
    // The original guard matched provider alone, which is wrong because
    // provider ids are reused across media types (TMDB 1429 = a movie AND a
    // series): it would treat a distinct cross-type id as a conflict and
    // delete it, or — if keepId lacked that exact (provider, media_type) —
    // let a genuine collision through. Including media_type fixes both.
    await tx`
        UPDATE external_ids SET media_id = ${keepId}
        WHERE media_id = ${mergeId}
          AND NOT EXISTS (
              SELECT 1 FROM external_ids e2
              WHERE e2.media_id = ${keepId}
                AND e2.provider = external_ids.provider
                AND e2.media_type = external_ids.media_type
          )
    `;
    // Delete remaining conflicting external_ids for the source item. Kept as
    // pure SQL inside this transaction (mirroring the UPDATE external_ids
    // re-parent above) to preserve the query-module = pure-SQL tier boundary —
    // a query module must not depend on a service. Cache invalidation is owned
    // by the merge's service caller: MediaDeletionService.mergeInto fires
    // afterDeleted(mergeId) once after this transaction commits.
    await tx`
        DELETE FROM external_ids WHERE media_id = ${mergeId}
    `;

    await moveMergedItemUserData(tx, keepId, mergeId);

    // Artists are credited two ways: by album parentage (handled by the
    // generic child re-parent above) and by id inside a track's
    // `custom_metadata.additional_artist_ids` — a plain jsonb array with no
    // FK, so nothing here would have caught it. Merging an artist without
    // remapping those ids leaves every reference-only track pointing at a
    // row that the DELETE below removes; `trackArtistsSql` inner-joins the
    // ids, so the credit does not error, it silently disappears from the
    // track line and from the surviving artist's page. Remap, then dedupe
    // the tracks that already credited both rows — the same sequence
    // `mergeCollaborationArtists` uses.
    const [mergeRow] = await tx<{ media_type: string }[]>`
        SELECT media_type FROM media_items WHERE id = ${mergeId}
    `;
    if (mergeRow?.media_type === 'artist') {
        await replaceArtistIdInTracks(tx, mergeId, keepId);
        // replaceArtistIdInTracks skips metadata_locked tracks; the row is
        // deleted below, so a locked track must not keep the id.
        await remapAdditionalArtistId(tx, mergeId, keepId);
        await dedupeAdditionalArtistIds(tx, keepId);
    }

    // Delete the empty duplicate series (remaining CASCADE FKs like
    // media_embeddings, media_streams, trickplay_params will be regenerated)
    const removedRoot = await tx`DELETE FROM media_items WHERE id = ${mergeId} RETURNING id`;
    itemsDeleted += removedRoot.length;

    // Re-derive has_files for everything that gained (or lost) links above,
    // plus their ancestors. Inside the transaction so no reader can observe
    // a merged hierarchy with stale availability.
    await recomputeHasFilesBatch(tx, [...hasFilesSeeds]);

    return { seasonsReparented, itemsDeleted };
}

/**
 * Backfill media_items.runtime_seconds from a probed file duration when the
 * column is still NULL. Used by the scanner's self-heal path for movies
 * whose runtime never got populated on insert. No-op if runtime is already
 * set — we never downgrade to a lower number.
 */
export async function setRuntimeSecondsIfNull(
    sql: postgres.Sql,
    mediaItemId: string,
    durationSeconds: number,
): Promise<void> {
    if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return;
    await sql`
        UPDATE media_items
        SET runtime_seconds = ${Math.round(durationSeconds)},
            updated_at = now()
        WHERE id = ${mediaItemId} AND runtime_seconds IS NULL
    `;
}

/**
 * Backfill media_items.library_group_id when the scanner adopts an existing
 * row (a discovery stub from TMDB trending/mdblist sync, or a title/external-id
 * match) into a real scanned file. Discovery stubs are never tied to a library
 * scan at creation time, so they never get a library_group_id — only a fresh
 * INSERT sets it. Idempotent no-op if the row already has a library_group_id
 * or if the caller has no libraryGroupId to backfill with.
 */
export async function backfillLibraryGroupIdIfNull(
    sql: postgres.Sql,
    mediaItemId: string,
    libraryGroupId: string | undefined,
): Promise<void> {
    if (!libraryGroupId) return;
    await sql`
        UPDATE media_items
        SET library_group_id = ${libraryGroupId}::uuid,
            updated_at = now()
        WHERE id = ${mediaItemId} AND library_group_id IS NULL
    `;
}

/** Move user state before deleting a duplicate; canonical rows win collisions. */
async function moveMergedItemUserData(
    tx: postgres.Sql,
    keepId: string,
    mergeId: string,
): Promise<void> {
    // Move user data (ratings, watchlist, etc.) — skip conflicts
    await tx`
        UPDATE user_ratings SET media_id = ${keepId}
        WHERE media_id = ${mergeId}
          AND NOT EXISTS (
              SELECT 1 FROM user_ratings ur2
              WHERE ur2.media_id = ${keepId} AND ur2.user_id = user_ratings.user_id
          )
    `;
    await tx`DELETE FROM user_ratings WHERE media_id = ${mergeId}`;

    await tx`
        UPDATE watchlist_activities SET media_id = ${keepId}
        WHERE media_id = ${mergeId}
          AND NOT EXISTS (
              SELECT 1 FROM watchlist_activities wa2
              WHERE wa2.media_id = ${keepId} AND wa2.user_id = watchlist_activities.user_id
          )
    `;
    await tx`DELETE FROM watchlist_activities WHERE media_id = ${mergeId}`;

    // Entries of these playlists move or vanish: bump their revision first.
    await tx`
        UPDATE playlists SET revision = revision + 1, updated_at = NOW()
        WHERE id IN (SELECT playlist_id FROM playlist_items WHERE media_id = ${mergeId})
    `;
    // Move playlist_items (ON DELETE CASCADE would silently remove user playlists)
    await tx`
        UPDATE playlist_items SET media_id = ${keepId}
        WHERE media_id = ${mergeId}
          AND NOT EXISTS (
              SELECT 1 FROM playlist_items pi2
              WHERE pi2.playlist_id = playlist_items.playlist_id
                AND pi2.media_id = ${keepId}
          )
    `;
    await tx`DELETE FROM playlist_items WHERE media_id = ${mergeId}`;

    // Move media_file_items for the series item itself (if any direct file links)
    await tx`
        UPDATE media_file_items SET media_item_id = ${keepId}
        WHERE media_item_id = ${mergeId}
          AND NOT EXISTS (
              SELECT 1 FROM media_file_items mfi2
              WHERE mfi2.file_id = media_file_items.file_id
                AND mfi2.media_item_id = ${keepId}
          )
    `;

    // Move references from tables without ON DELETE CASCADE
    await tx`
        UPDATE play_sessions SET media_id = ${keepId}
        WHERE media_id = ${mergeId}
    `;
    await tx`
        UPDATE watch_history SET media_id = ${keepId}
        WHERE media_id = ${mergeId}
    `;
    await tx`
        UPDATE hls_playback_tokens SET media_item_id = ${keepId}
        WHERE media_item_id = ${mergeId}
    `;

    // ─────────────────────────────────────────────────────────────────
    // Re-point the user-data tables whose FK to media_items is ON DELETE
    // CASCADE. These were NOT handled before, so the final DELETE below
    // silently destroyed resume positions, watch-event history, user
    // flags, watchlist entries, AI suggestions and cached-list membership
    // for the merged row. Watch state was refactored from user_watch_state
    // into the user_media_* tables (migrations 12.44.0/12.45.0) and
    // user_watchlist became the live watchlist table — this routine was
    // never updated. Mirror the canonical fold in migration
    // 12.20.0_remove_edition_of.ts: UPDATE…SET media_id=keepId skipping
    // rows that would collide on the table's unique key, then DELETE the
    // remaining (now-duplicate) source rows. All inside this transaction.
    //
    // NOTE: when adding a new table with an ON DELETE CASCADE FK to
    // media_items that carries user-visible state, add a re-point block
    // here (and to migration 12.20.0's fold) or it will be silently
    // dropped on every merge.
    // ─────────────────────────────────────────────────────────────────

    // user_media_state — resume positions + is_watched/watch_count.
    // Source of truth for movie/episode watch state. PK (user_id, media_id).
    await tx`
        UPDATE user_media_state SET media_id = ${keepId}
        WHERE media_id = ${mergeId}
          AND NOT EXISTS (
              SELECT 1 FROM user_media_state ums2
              WHERE ums2.media_id = ${keepId} AND ums2.user_id = user_media_state.user_id
          )
    `;
    await tx`DELETE FROM user_media_state WHERE media_id = ${mergeId}`;

    // Only an identified event can be proven to duplicate a canonical event.
    // NULL IDs identify distinct playback sessions too; preserve them all.
    await tx`
        UPDATE user_media_events SET media_id = ${keepId}
        WHERE media_id = ${mergeId}
          AND (
              user_media_events.source_event_id IS NULL
              OR NOT EXISTS (
                  SELECT 1 FROM user_media_events ume2
                  WHERE ume2.media_id = ${keepId}
                    AND ume2.user_id = user_media_events.user_id
                    AND ume2.source = user_media_events.source
                    AND ume2.source_event_id = user_media_events.source_event_id
              )
          )
    `;
    await tx`DELETE FROM user_media_events WHERE media_id = ${mergeId}`;

    // user_media_flags — hide / not-interested etc. FK column is
    // target_id. UNIQUE (user_id, target_id, flag_type).
    await tx`
        UPDATE user_media_flags SET target_id = ${keepId}
        WHERE target_id = ${mergeId}
          AND NOT EXISTS (
              SELECT 1 FROM user_media_flags umf2
              WHERE umf2.target_id = ${keepId}
                AND umf2.user_id = user_media_flags.user_id
                AND umf2.flag_type = user_media_flags.flag_type
          )
    `;
    await tx`DELETE FROM user_media_flags WHERE target_id = ${mergeId}`;

    // Watchlist rows are now ordinary playlist_items rows (playlist_type =
    // 'watchlist') — already folded above by the playlist_items UPDATE/DELETE
    // pair, so no separate user_watchlist step is needed here.

    // user_suggestions — AI suggestion rows.
    // UNIQUE (user_id, media_id, cache_context).
    await tx`
        UPDATE user_suggestions SET media_id = ${keepId}
        WHERE media_id = ${mergeId}
          AND NOT EXISTS (
              SELECT 1 FROM user_suggestions us2
              WHERE us2.media_id = ${keepId}
                AND us2.user_id = user_suggestions.user_id
                AND us2.cache_context = user_suggestions.cache_context
          )
    `;
    await tx`DELETE FROM user_suggestions WHERE media_id = ${mergeId}`;

    // cached_list_items — cached list membership.
    // UNIQUE (list_id, media_id).
    await tx`
        UPDATE cached_list_items SET media_id = ${keepId}
        WHERE media_id = ${mergeId}
          AND NOT EXISTS (
              SELECT 1 FROM cached_list_items cli2
              WHERE cli2.media_id = ${keepId} AND cli2.list_id = cached_list_items.list_id
          )
    `;
    await tx`DELETE FROM cached_list_items WHERE media_id = ${mergeId}`;
}
