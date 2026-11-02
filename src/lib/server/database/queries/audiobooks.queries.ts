// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Audiobook Query Module
 *
 * Pure SQL for the Audiobookshelf reconcile sweep. Audiobooks are ordinary
 * `media_items` rows (`media_type = 'audiobook'`) with **no `media_files` rows** —
 * the bytes live on the ABS server and playback resolves through `external_ids`
 * (the same shape internet-radio uses for its remote stream URL).
 *
 * Two invariants this module exists to protect:
 *
 * 1. **`has_files` means "playable in this install", not "has a local file".**
 *    Audiobook rows are written with `has_files = true` because the shared card
 *    machinery derives the play gate from it; ABS reporting `isMissing` maps to
 *    `false`. See the design doc, §2 "Decided — `has_files = true` at ingest".
 * 2. **The sweep never writes `status = 'deleted'`.** That value is a purge
 *    sentence — `findHardDeletableMediaIds` collects such rows after 30 days and
 *    `MediaDeletionService.hardDelete()` destroys ratings, sessions, reviews and
 *    watchlist entries. Its only physical guard is `NOT EXISTS media_file_items`,
 *    which file-less audiobooks pass trivially. An availability observation
 *    ("absent from a remote catalog right now") may only toggle availability
 *    flags, so absent-upstream books are dismissed, never deleted.
 *
 * The ABS revision keys (`updatedAt`, `mtimeMs`) and the owning ABS library id
 * live under `custom_metadata.audiobookshelf`, which is where the differ reads
 * them back from on the next cycle.
 */

import type postgres from 'postgres';
import { deriveSortTitle } from '$lib/server/utils/sort-title.js';
import { audiobookDurationMs } from './audiobook-duration.js';
import type { AudiobookKind, AudiobookChapter } from '$lib/schemas/api-audiobook.js';
import type { PlaybackProgress } from '$lib/schemas/api-playback-progress.js';
import { bookProgress } from '$lib/server/utils/audiobook-cards.js';
import { invalidateMediaAgeCache } from '$lib/server/middleware/media-access.js';
import { withTx } from '../with-tx.js';
import {
    lockAudiobookCatalog,
    syncAudiobookCatalog,
    cleanupAudiobookCatalog,
} from './audiobook-catalog-maintenance.queries.js';
import { buildChapterSpans } from '$lib/utils/audiobook-timeline.js';
import type {
    AudiobookChapterMetadata,
    AudiobookFileMetadata,
    AudiobookSeriesMetadata,
} from '$lib/shared/audiobook-metadata.js';

// Re-exported so every existing server-side import site keeps working; the
// definitions moved to `$lib/shared` because Svelte components need them too.
export type {
    AudiobookChapterMetadata,
    AudiobookFileMetadata,
    AudiobookSeriesMetadata,
} from '$lib/shared/audiobook-metadata.js';

/** `external_ids.provider` for Audiobookshelf items. */
export const AUDIOBOOKSHELF_PROVIDER = 'audiobookshelf';

/** `media_items.media_type` for Audiobookshelf items (radioplays included). */
export const AUDIOBOOK_MEDIA_TYPE = 'audiobook';

/** Key under `media_items.custom_metadata` owned by this connector. */
export const AUDIOBOOKSHELF_METADATA_KEY = 'audiobookshelf';

/** Grouping key derived at ingest — see `_helpers/audiobookshelf/series-derive.ts`. */
export type DerivedSeries = {
    name: string | null;
    sequence: number | null;
    source: 'abs-series' | 'folder' | 'none';
};

/**
 * The `custom_metadata.audiobookshelf` object.
 *
 * `libraryId`, `updatedAt` and `mtimeMs` are load-bearing — they are the sweep's
 * partition key and revision keys. Everything else is presentation data that the
 * modal and the `/audiobooks` destination read.
 */
export type AudiobookshelfMetadata = {
    /** ABS library this item belongs to. The sweep partitions local rows by it. */
    libraryId: string;
    /** `library_paths.id` of the row that produced this item. */
    libraryPathId: string;
    /** ABS `updatedAt` in epoch ms — bumped on metadata *and* chapter edits. */
    updatedAt: number;
    /** ABS `mtimeMs` in epoch ms — the file mtime, so file replacement moves it. */
    mtimeMs: number;
    addedAt: number | null;
    relPath: string | null;
    coverPath: string | null;
    subtitle: string | null;
    authors: string[];
    narrators: string[];
    series: AudiobookSeriesMetadata[];
    /**
     * The shelf the destination groups on, resolved at ingest from
     * `seriesName` → folder → nothing. Distinct from `series` above, which is
     * AudiobookShelf's own (frequently absent) metadata.
     */
    derivedSeries: DerivedSeries;
    /** Per-file list backing the player's virtual timeline. */
    audioFiles: AudiobookFileMetadata[];
    genres: string[];
    publisher: string | null;
    publishedYear: string | null;
    language: string | null;
    isbn: string | null;
    asin: string | null;
    explicit: boolean;
    abridged: boolean;
    /** Total duration in seconds, as ABS reports it. */
    duration: number | null;
    chapters: AudiobookChapterMetadata[];
};

/**
 * A local audiobook row as the differ needs it.
 *
 * `status` is carried (rather than filtered out in SQL) so the sweep can tell
 * "no local row exists for this ABS id" apart from "a local row exists but an
 * operator soft-deleted it". Filtering non-active rows away would make the sweep
 * re-insert them and blow up on the `external_ids` composite-key conflict.
 */
export interface LocalAudiobookRow {
    mediaId: string;
    absItemId: string;
    status: string;
    libraryGroupId: string | null;
    libraryPathId?: string | null;
    hasFiles: boolean;
    isDismissed: boolean;
    /** `custom_metadata.audiobookshelf.updatedAt`, or null when unreadable. */
    absUpdatedAt: number | null;
    /** `custom_metadata.audiobookshelf.mtimeMs`, or null when unreadable. */
    absMtimeMs: number | null;
}

interface LocalAudiobookSqlRow {
    media_id: string;
    abs_item_id: string;
    status: string;
    library_group_id: string | null;
    library_path_id: string | null;
    has_files: boolean;
    is_dismissed: boolean;
    abs_updated_at: string | null;
    abs_mtime_ms: string | null;
}

/**
 * Parse a revision key stored in jsonb.
 *
 * Read as text and parsed here rather than cast in SQL: a `::bigint` cast raises
 * `22P02` for the whole statement if a single row ever holds a non-integer, which
 * would take the sweep down for every book in the library. Unparseable reads as
 * `null`, which the differ treats as "revision unknown" → refetch.
 */
function parseEpochMs(value: string | null): number | null {
    if (value === null) return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Every local row belonging to one ABS library, keyed by ABS item id.
 *
 * Scoped by `custom_metadata.audiobookshelf.libraryId` rather than
 * `library_group_id`, because several ABS libraries map onto the same group
 * (audiobooks-en and audiobooks-de both live in "Hörbücher") — grouping by the
 * group would make each library look like it was missing the other's books and
 * dismiss them.
 */
/**
 * `media_items.id` → AudiobookShelf item id, for a batch of local book rows.
 *
 * The inverse direction of `batchResolveExternalIds`: callers that already
 * matched books in OUR catalog (search, since it stopped asking ABS to do the
 * matching) still need the ABS id to fill the `audiobookshelf` external-id slot
 * and the legacy `jellyfin` one the shipped clients read.
 *
 * A book with no `external_ids` row is simply absent from the map — that is a
 * real state (a local row whose provider link was never written), not an error,
 * and the caller emits the item without an ABS id rather than dropping it.
 */
export async function getAbsItemIdsByMediaIds(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<Map<string, string>> {
    if (mediaIds.length === 0) return new Map();
    const rows = await sql<{ media_id: string; external_id: string }[]>`
        SELECT ei.media_id::text AS media_id, ei.external_id
        FROM external_ids ei
        WHERE ei.provider = ${AUDIOBOOKSHELF_PROVIDER}
          AND ei.media_type = ${AUDIOBOOK_MEDIA_TYPE}
          AND ei.media_id = ANY(${sql.array(mediaIds as string[])}::uuid[])
    `;
    return new Map(rows.map((row) => [row.media_id, row.external_id]));
}

export async function listAudiobooksForAbsLibrary(
    sql: postgres.Sql,
    absLibraryId: string,
): Promise<LocalAudiobookRow[]> {
    // Ingest-side reconcile read, never a viewer surface: it must see EVERY row
    // the connector owns (including dismissed and soft-deleted ones) or the differ
    // would treat rows a viewer cannot see as "absent locally" and insert
    // duplicates of them forever. Viewer access is enforced downstream, off the
    // `library_group_id` this row carries.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<LocalAudiobookSqlRow[]>`
        SELECT mi.id AS media_id,
               ei.external_id AS abs_item_id,
               mi.status,
               mi.library_group_id,
               mi.custom_metadata #>> '{audiobookshelf,libraryPathId}' AS library_path_id,
               mi.has_files,
               mi.is_dismissed,
               mi.custom_metadata #>> '{audiobookshelf,updatedAt}' AS abs_updated_at,
               mi.custom_metadata #>> '{audiobookshelf,mtimeMs}' AS abs_mtime_ms
        FROM media_items mi
        JOIN external_ids ei
          ON ei.media_id = mi.id
         AND ei.provider = ${AUDIOBOOKSHELF_PROVIDER}
         AND ei.media_type = ${AUDIOBOOK_MEDIA_TYPE}
        WHERE mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
          AND mi.custom_metadata #>> '{audiobookshelf,libraryId}' = ${absLibraryId}
        ORDER BY ei.external_id
    `;

    return rows.map((row) => ({
        mediaId: row.media_id,
        absItemId: row.abs_item_id,
        status: row.status,
        libraryGroupId: row.library_group_id,
        libraryPathId: row.library_path_id,
        hasFiles: row.has_files,
        isDismissed: row.is_dismissed,
        absUpdatedAt: parseEpochMs(row.abs_updated_at),
        absMtimeMs: parseEpochMs(row.abs_mtime_ms),
    }));
}

/** Column values shared by the insert and the metadata update. */
export interface AudiobookWriteParams {
    /** Live sweeps must not commit after the administrator removed their source. */
    requireConfiguredLibrary?: boolean;
    title: string;
    /** Precomputed by `deriveSortTitle` — `sort_title` has no DB trigger. */
    sortTitle: string;
    overview: string | null;
    year: number | null;
    runtimeSeconds: number | null;
    /** `false` only when ABS reports `isMissing`. */
    hasFiles: boolean;
    libraryGroupId: string;
    /** ABS `addedAt`, so "recently added" ordering matches the source. */
    libraryAddedAt: Date | null;
    /** Derived series position, scaled — null when the book is standalone. */
    sortOrder: number | null;
    metadata: AudiobookshelfMetadata;
}

async function lockConfiguredLibrary(
    sql: postgres.Sql,
    params: AudiobookWriteParams,
): Promise<void> {
    if (!params.requireConfiguredLibrary) return;
    const [path] = await sql<{ language: string; library_group_id: string }[]>`
        SELECT language, library_group_id FROM library_paths
        WHERE id::text = ${params.metadata.libraryPathId}
          AND provider = 'audiobookshelf' AND enabled = true
        FOR SHARE`;
    if (!path) throw new Error('Audiobookshelf library was removed or disabled during sync');
    params.sortTitle = deriveSortTitle(params.title, null, null, path.language, {
        declaredLanguageOnly: true,
    });
    params.libraryGroupId = path.library_group_id;
}

/**
 * Insert a book and return its UUID.
 *
 * Does NOT write `external_ids` — that goes through
 * `CatalogService.upsertExternalId()` (the ESLint `no-direct-external-ids-write`
 * rule, and the composite-key invariant it protects).
 *
 * `is_local_only` is explicitly `false`: ABS *is* the metadata provider for these
 * items, so they carry a real external identity and must not show up in the
 * admin "local only" bucket or the "no primary external id" embedding sweeps.
 */
export async function insertAudiobook(
    sql: postgres.Sql,
    params: AudiobookWriteParams,
): Promise<string> {
    return withTx(sql, async (sql) => {
        await lockConfiguredLibrary(sql, params);
        await lockAudiobookCatalog(sql);
        const rows = await sql<{ id: string }[]>`
        INSERT INTO media_items (
            title, sort_title, overview, year, media_type, runtime_seconds,
            has_files, is_local_only, library_group_id, library_added_at, sort_order,
            custom_metadata
        )
        VALUES (
            ${params.title},
            ${params.sortTitle},
            ${params.overview},
            ${params.year},
            ${AUDIOBOOK_MEDIA_TYPE},
            ${params.runtimeSeconds},
            ${params.hasFiles},
            FALSE,
            ${params.libraryGroupId},
            ${params.libraryAddedAt},
            ${params.sortOrder},
            ${sql.json({ [AUDIOBOOKSHELF_METADATA_KEY]: params.metadata })}
        )
        RETURNING id
    `;
        const id = rows[0]?.id;
        if (!id) throw new Error('INSERT media_items (audiobook) returned no row');
        await syncAudiobookCatalog(sql, id, params.metadata);
        return id;
    });
}

/**
 * Apply a fresh expanded fetch to an existing row.
 *
 * Merges into `custom_metadata` (`||`) instead of replacing it, so keys owned by
 * other subsystems survive the reconcile. Clears any dismissal: reaching this
 * function means the id came back from ABS.
 *
 * `library_group_id` is deliberately NOT overwritten, only backfilled when NULL.
 * Which group an item sits in is *organisation*, not metadata — the design doc
 * (§6) lists it as editable in Lumastra precisely because it does not conflict
 * with reconcile. Reasserting it here would silently undo an operator's move on
 * the next ABS revision bump, and since `library_groups` carries
 * `max_age_rating`, `is_public` and the per-group permission rows, that is an
 * access-control regression rather than a cosmetic one.
 * A removed/re-added source is the exception: its new path identity explicitly
 * reattaches existing books to the newly chosen library group.
 */
export async function updateAudiobookFromRemote(
    sql: postgres.Sql,
    mediaId: string,
    params: AudiobookWriteParams,
): Promise<void> {
    await withTx(sql, async (sql) => {
        await lockConfiguredLibrary(sql, params);
        await lockAudiobookCatalog(sql);
        const contributors = await sql<{ id: string }[]>`SELECT contributor_id AS id
            FROM audiobook_book_contributors WHERE media_id = ${mediaId}::uuid`;
        const series = await sql<{ id: string }[]>`SELECT series_id AS id
            FROM audiobook_book_series WHERE media_id = ${mediaId}::uuid`;
        await sql`
        UPDATE media_items
        SET title = ${params.title},
            sort_title = ${params.sortTitle},
            overview = ${params.overview},
            year = ${params.year},
            runtime_seconds = ${params.runtimeSeconds},
            has_files = ${params.hasFiles},
            library_group_id = CASE
                WHEN ${params.requireConfiguredLibrary === true}
                 AND custom_metadata #>> '{audiobookshelf,libraryPathId}' IS DISTINCT FROM ${params.metadata.libraryPathId}
                THEN ${params.libraryGroupId}::uuid
                ELSE COALESCE(library_group_id, ${params.libraryGroupId}) END,
            library_added_at = ${params.libraryAddedAt},
            sort_order = ${params.sortOrder},
            is_dismissed = FALSE,
            dismissed_at = NULL,
            custom_metadata = COALESCE(custom_metadata, '{}'::jsonb)
                || ${sql.json({ [AUDIOBOOKSHELF_METADATA_KEY]: params.metadata })}::jsonb
        WHERE id = ${mediaId}
          AND media_type = ${AUDIOBOOK_MEDIA_TYPE}
    `;
        await syncAudiobookCatalog(sql, mediaId, params.metadata);
        if (contributors.length)
            await sql`DELETE FROM audiobook_contributors c
            WHERE c.id = ANY(${contributors.map((r) => r.id)}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM audiobook_book_contributors bc WHERE bc.contributor_id = c.id)`;
        if (series.length)
            await sql`DELETE FROM audiobook_series s
            WHERE s.id = ANY(${series.map((r) => r.id)}::uuid[])
            AND NOT EXISTS (SELECT 1 FROM audiobook_book_series bs WHERE bs.series_id = s.id)`;
    });
    // Re-adds can move the same identity to a group with a different age floor.
    // Drop the old effective rating locally and on sibling replicas after the write.
    invalidateMediaAgeCache(mediaId);
}

export interface AudiobookFlagUpdate {
    requireConfiguredLibrary?: boolean;
    hasFiles: boolean;
    isDismissed: boolean;
}

/**
 * Toggle availability/dismissal for a batch of books without refetching them.
 *
 * Both flags always move together, on purpose: a dismissed book left at
 * `has_files = true` still renders a live Listen button, because `is_dismissed`
 * is only read by admin and cleanup queries.
 *
 * The `media_type` predicate is a belt-and-braces guard — this statement can set
 * `has_files = false` in bulk and must never be able to reach a movie, whatever
 * the caller passes.
 */
export async function setAudiobookFlags(
    sql: postgres.Sql,
    mediaIds: string[],
    flags: AudiobookFlagUpdate,
): Promise<number> {
    if (mediaIds.length === 0) return 0;
    return withTx(sql, async (sql) => {
        let paths: { id: string }[] = [];
        if (flags.requireConfiguredLibrary) {
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- internal sync source lock, not a viewer read
            paths = await sql<{ id: string }[]>`
            SELECT lp.id::text AS id FROM library_paths lp
            WHERE lp.provider = 'audiobookshelf' AND lp.enabled
              AND EXISTS (SELECT 1 FROM media_items mi WHERE mi.id = ANY(${sql.array(mediaIds)}::uuid[])
                  AND mi.custom_metadata #>> '{audiobookshelf,libraryPathId}' = lp.id::text)
            ORDER BY lp.id FOR SHARE`;
        }
        await lockAudiobookCatalog(sql);

        // `COALESCE(dismissed_at, now())` preserves the ORIGINAL dismissal time
        // across repeated sweeps — re-stamping it every 15 minutes would make the
        // column useless for "how long has this been gone". A row an operator
        // already dismissed (dismissed, NULL dismissed_at) keeps its NULL: that
        // marks operator curation, which unavailable-media retention must honour.
        const dismissedAt = flags.isDismissed
            ? sql`CASE WHEN is_dismissed AND dismissed_at IS NULL THEN NULL
                   ELSE COALESCE(dismissed_at, now()) END`
            : sql`NULL`;

        const rows = await sql<{ id: string }[]>`
        UPDATE media_items
        SET has_files = ${flags.hasFiles},
            is_dismissed = ${flags.isDismissed},
            dismissed_at = ${dismissedAt}
        WHERE id = ANY(${sql.array(mediaIds)}::uuid[])
          AND media_type = ${AUDIOBOOK_MEDIA_TYPE}
          ${flags.requireConfiguredLibrary ? sql`AND custom_metadata #>> '{audiobookshelf,libraryPathId}' = ANY(${paths.map((path) => path.id)}::text[])` : sql``}
        RETURNING id
    `;
        if (!rows.length) return 0;
        if (flags.isDismissed) {
            const ids = rows.map((row) => row.id);
            await sql`DELETE FROM audiobook_book_contributors WHERE media_id = ANY(${sql.array(ids)}::uuid[])`;
            await sql`DELETE FROM audiobook_book_series WHERE media_id = ANY(${sql.array(ids)}::uuid[])`;
        }
        if (!flags.isDismissed) {
            // eslint-disable-next-line callback-safety/no-unscoped-media-items -- sync-side metadata refresh by id; no viewer
            const books = await sql<{ id: string; metadata: AudiobookshelfMetadata }[]>`
            SELECT id, custom_metadata->'audiobookshelf' AS metadata FROM media_items
            WHERE id = ANY(${sql.array(rows.map((row) => row.id))}::uuid[])`;
            for (const book of books) await syncAudiobookCatalog(sql, book.id, book.metadata);
        }
        await cleanupAudiobookCatalog(sql);
        return rows.length;
    });
}

/**
 * Audiobook rows currently present in the catalogue, for the media-source
 * status surface.
 *
 * Counts `status = 'active' AND NOT is_dismissed` — i.e. books the sweep still
 * sees upstream. Dismissed rows are excluded on purpose: they are kept only so
 * a returning ABS id can be revived, an operator does not think of them as part
 * of the library, and `getMediaBrowserStats.audiobooks` (which filters on
 * `has_files`) would otherwise disagree with this counter about the same
 * catalogue.
 */
export async function countAudiobooks(sql: postgres.Sql): Promise<number> {
    // Bare COUNT(*) — no id/title/path or any other per-item field ever leaves
    // this query — so it is install-wide by definition and leaks no titles;
    // scoping it to a viewer would make "how much did the sweep ingest?" wrong.
    // Backs `audiobookshelfMediaSource.getStatus()` (this file's media-source
    // connector contract). As of 2026-09-22 that method has no reachable HTTP
    // caller: `defs/admin/plugins/[pluginId]/index.ts` special-cases only the
    // file-scanner source's `getStatus`, not this one — re-check that file
    // before relying on an "admin-only" caller claim here.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<{ count: string }[]>`
        SELECT COUNT(*)::text AS count
        FROM media_items
        WHERE media_type = ${AUDIOBOOK_MEDIA_TYPE}
          AND status = 'active'
          AND NOT is_dismissed
    `;
    return Number(rows[0]?.count ?? '0');
}

/** Everything the session endpoint needs to open one book. */
export interface AudiobookPlaybackTarget {
    mediaId: string;
    /** AudiobookShelf library-item id — what `POST /api/items/:id/play` takes. */
    absItemId: string;
    title: string;
    authors: string[];
    narrators: string[];
    /** Local runtime in seconds; the session's own duration wins when present. */
    runtimeSeconds: number | null;
    /**
     * PERSISTED per-file audio codec, keyed by AudiobookShelf inode.
     *
     * From `custom_metadata.audiobookshelf.audioFiles[].codec`, written by the
     * sweep. This is the authority on what is actually inside the container, and
     * it exists precisely because AudiobookShelf's own direct-play negotiation
     * cannot see it: `checkCanDirectPlay` matches bare MIME types, an E-AC-3
     * `.m4b` advertises `audio/mp4`, so ABS direct-plays a file Chromium then
     * refuses with `EncodingError`.
     *
     * Read from here rather than from the live session payload's
     * `audioTracks[].codec` for two reasons: the session's synthetic HLS track
     * reports `codec: null` (measured), and this value is available before any
     * session exists.
     */
    audioFileCodecs: Record<string, string>;
}

/**
 * Resolve one `media_items.id` to the AudiobookShelf item behind it.
 *
 * Deliberately re-checks `status`/`is_dismissed` rather than trusting the
 * caller's access gate to have done it: a book withdrawn or dismissed since the
 * card was rendered must not open a new playback session. This mirrors the
 * identical re-check the byte proxy performs on every segment — the two guards
 * are for different moments (session open vs. each byte) and neither implies
 * the other.
 *
 * Access control is NOT this query's job: the caller applies the single-id
 * media-access gate (library group + age rating) before calling it.
 *
 * ⚠️ Do NOT name that gate's function verbatim in a comment here.
 * `callback-safety/no-unscoped-media-items` treats any occurrence of an
 * access-marker token ANYWHERE IN THE FILE as proof the file is gated and then
 * stops checking every query in it — so a mention in prose silently switched the
 * access-gate lint off for this whole module. Caught only because the now-inert
 * `eslint-disable-next-line` directives turned into "unused directive"
 * warnings; the rule itself reports nothing when it disables itself.
 */
export async function resolveAudiobookPlaybackTarget(
    sql: postgres.Sql,
    mediaId: string,
): Promise<AudiobookPlaybackTarget | null> {
    // Single-row identity lookup for an id the caller has ALREADY passed
    // through the media-access gate — there is no browse surface here to scope.
    // (Naming that gate's function here would disable the rule file-wide; see
    // the doc comment above.)
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [row] = await sql<
        {
            media_id: string;
            abs_item_id: string;
            title: string;
            runtime_seconds: number | null;
            authors: unknown;
            narrators: unknown;
            audio_files: unknown;
        }[]
    >`
        SELECT mi.id                 AS media_id,
               ei.external_id        AS abs_item_id,
               mi.title,
               mi.runtime_seconds,
               mi.custom_metadata -> ${AUDIOBOOKSHELF_METADATA_KEY} -> 'authors'    AS authors,
               mi.custom_metadata -> ${AUDIOBOOKSHELF_METADATA_KEY} -> 'narrators'  AS narrators,
               mi.custom_metadata -> ${AUDIOBOOKSHELF_METADATA_KEY} -> 'audioFiles' AS audio_files
        FROM media_items mi
        JOIN external_ids ei
          ON ei.media_id   = mi.id
         AND ei.provider   = ${AUDIOBOOKSHELF_PROVIDER}
         AND ei.media_type = ${AUDIOBOOK_MEDIA_TYPE}
        WHERE mi.id           = ${mediaId}::uuid
          AND mi.media_type   = ${AUDIOBOOK_MEDIA_TYPE}
          AND mi.status       = 'active'
          AND mi.is_dismissed = FALSE
        LIMIT 1
    `;
    if (!row) return null;

    return {
        mediaId: row.media_id,
        absItemId: row.abs_item_id,
        title: row.title,
        authors: toStringArray(row.authors),
        narrators: toStringArray(row.narrators),
        runtimeSeconds: row.runtime_seconds,
        audioFileCodecs: toCodecByIno(row.audio_files),
    };
}

/**
 * The PERSISTED codec of one file of one book, by AudiobookShelf inode.
 *
 * Exists so the remux byte route records what it is actually re-encoding without
 * believing the client: the codec is a property of the file, and a query
 * parameter is a property of whoever sent the request.
 *
 * Returns null when the book has no persisted entry for that inode — a file added
 * since the last sweep, or a book ingested before `audioFiles` was persisted.
 * That is reported as unknown rather than guessed.
 */
export async function getAudiobookFileCodec(
    sql: postgres.Sql,
    mediaId: string,
    ino: string,
): Promise<string | null> {
    // Identity lookup for a (book, file) pair the caller has already proven this
    // listener may stream: the stream token is minted behind the media-access
    // gate and pinned to this one media id, and the byte route re-checks the pin
    // plus status/is_dismissed before reaching here. There is no browse surface
    // to scope. (Naming the gate's function here would switch the rule off for
    // this whole file — see the doc comment on resolveAudiobookPlaybackTarget.)
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [row] = await sql<{ codec: string | null }[]>`
        SELECT f ->> 'codec' AS codec
        FROM media_items mi
        CROSS JOIN LATERAL jsonb_array_elements(
            COALESCE(mi.custom_metadata -> ${AUDIOBOOKSHELF_METADATA_KEY} -> 'audioFiles',
                     '[]'::jsonb)
        ) AS f
        WHERE mi.id         = ${mediaId}::uuid
          AND mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
          AND f ->> 'ino'   = ${ino}
        LIMIT 1
    `;
    const codec = row?.codec;
    return typeof codec === 'string' && codec !== '' ? codec : null;
}

/**
 * Everything the detail modal needs about one book.
 *
 * Deliberately NOT served off `getMediaDetailsById` (the generic detail read):
 * that query sources `overview` from `provider_metadata.metadata->>'overview'`,
 * and an ABS book has no provider_metadata row at all — so the generic path
 * reports `overview: null` for a book whose description is sitting right there
 * in `media_items.overview`. Same story for the author/narrator/chapter data,
 * which lives only under `custom_metadata.audiobookshelf`.
 */
export interface AudiobookNodeDetail extends AudiobookKind {
    overview: string | null;
    year: number | null;
    runtimeSeconds: number | null;
    publisher: string | null;
    abridged: boolean | null;
    durationMs: number | null;
    chapters: AudiobookChapter[];
    progress?: PlaybackProgress;
    ids: Record<string, string>;
}

interface AudiobookNodeDetailSqlRow {
    ids: Record<string, string>;
    series: AudiobookKind['series'];
    state_id: string | null;
    updated_at: Date | null;
    duration_ms: string | null;
    resume_position_ms: string | null;
    is_watched: boolean | null;
    overview: string | null;
    year: number | null;
    runtime_seconds: number | null;
    authors: AudiobookKind['authors'];
    narrators: AudiobookKind['narrators'];
    publisher: string | null;
    abridged: boolean | null;
    chapters: unknown;
}

/**
 * Read the audiobook-shaped detail for one already-gated media id.
 *
 * Returns null when the id is not an active audiobook row, so the caller falls
 * back to the generic node shape rather than emitting half-empty book fields.
 *
 * `status = 'active'` but NOT `is_dismissed = FALSE`: a dismissed book is one the
 * last sweep could not see upstream, and a viewer who still holds a link to it
 * should read a complete card explaining what it is — the play gate is derived
 * from `has_files`, which the dismissal already cleared, so nothing here grants
 * playback.
 */
export async function getAudiobookNodeDetail(
    sql: postgres.Sql,
    mediaId: string,
    /**
     * Whose progress to read. Null for an anonymous request — the LEFT JOIN then
     * matches nothing and the book's own metadata still comes back, which is the
     * point: identity and chapters are not user-scoped.
     */
    viewerId: string | null,
): Promise<AudiobookNodeDetail | null> {
    // Single-row detail read for an id the caller has ALREADY passed through the
    // per-item media-access check; there is no browse surface here to scope.
    // (Naming that check's function here would switch the rule off for this whole
    // file — see the doc comment on resolveAudiobookPlaybackTarget.)
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [row] = await sql<AudiobookNodeDetailSqlRow[]>`
        SELECT mi.overview,
               mi.year,
               mi.runtime_seconds,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY bc.position)
                   FROM audiobook_book_contributors bc JOIN audiobook_contributors c ON c.id = bc.contributor_id
                   WHERE bc.media_id = mi.id AND bc.role = 'author'), '[]'::jsonb) AS authors,
               COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY bc.position)
                   FROM audiobook_book_contributors bc JOIN audiobook_contributors c ON c.id = bc.contributor_id
                   WHERE bc.media_id = mi.id AND bc.role = 'narrator'), '[]'::jsonb) AS narrators,
               (SELECT jsonb_build_object('id', s.id, 'name', s.name, 'position', bs.sequence)
                   FROM audiobook_book_series bs JOIN audiobook_series s ON s.id = bs.series_id WHERE bs.media_id = mi.id) AS series,
               jsonb_strip_nulls(jsonb_build_object('isbn', mi.custom_metadata #>> '{audiobookshelf,isbn}',
                   'asin', mi.custom_metadata #>> '{audiobookshelf,asin}')) AS ids,
               ums.media_id AS state_id, ums.last_event_at AS updated_at,
               ${audiobookDurationMs(sql)}::text AS duration_ms,
               mi.custom_metadata #>> '{audiobookshelf,publisher}'                 AS publisher,
               CASE
                   WHEN jsonb_typeof(mi.custom_metadata #> '{audiobookshelf,abridged}') = 'boolean'
                   THEN (mi.custom_metadata #>> '{audiobookshelf,abridged}')::boolean
               END                                                                 AS abridged,
               COALESCE(mi.custom_metadata #> '{audiobookshelf,chapters}', '[]'::jsonb)
                                                                                   AS chapters,
               ums.resume_position_ms                                              AS resume_position_ms,
               COALESCE(ums.is_watched, false)                                     AS is_watched
        FROM media_items mi
        LEFT JOIN user_media_state ums
               ON ums.media_id = mi.id
              AND ums.user_id  = ${viewerId}::uuid
        WHERE mi.id         = ${mediaId}::uuid
          AND mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
          AND mi.status     = 'active'
        LIMIT 1
    `;
    if (!row) return null;

    const durationMs = row.duration_ms === null ? null : Number(row.duration_ms);
    const durationSeconds = durationMs === null ? null : durationMs / 1000;
    const progress = bookProgress({
        state_id: row.state_id,
        position_ms: row.resume_position_ms,
        duration_ms: row.duration_ms,
        finished: row.is_watched === true,
        updated_at: row.updated_at,
    });
    return {
        overview: row.overview,
        year: row.year,
        runtimeSeconds: row.runtime_seconds,
        authors: row.authors,
        narrators: row.narrators,
        series: row.series,
        ids: row.ids,
        publisher: row.publisher,
        abridged: row.abridged,
        durationMs,
        chapters: toChapters(row.chapters, durationSeconds).map((chapter, index) => ({
            index,
            name: chapter.title,
            startMs: Math.round(chapter.start * 1000),
            endMs: Math.round((chapter.end ?? chapter.start) * 1000),
            ...(chapter.synthetic === true ? { synthetic: true as const } : {}),
        })),
        ...(progress ? { progress } : {}),
    };
}

/**
 * Chapters, skipping entries that cannot be rendered.
 *
 * A chapter with no numeric start is dropped rather than shown as a row at 0:00 —
 * the list is a table of contents, and one plausible-looking wrong row is worse
 * than a shorter list. A missing `title` degrades to `''` (the UI substitutes
 * "Chapter N", which is true).
 *
 * Normalised through the SAME helper the play-session payload uses, against the
 * book's own duration. Reading `custom_metadata` directly and shaping it here
 * is how this list came to disagree with the player: for Milo Farrow and the
 * Keeper of Starhaven the modal said "211 chapters" while the player showed
 * 212, because only one of the two accounted for the 16m52s the upstream
 * chapter list does not cover. One interpreter, one answer.
 *
 * `id` is the position in the normalised list — a display/key value only.
 */
export function toChapters(
    value: unknown,
    durationSeconds: number | null,
): AudiobookChapterMetadata[] {
    if (!Array.isArray(value)) return [];
    const usable = value.filter(
        (entry): entry is { start: number; end?: unknown; title?: unknown } =>
            typeof entry === 'object' &&
            entry !== null &&
            typeof (entry as { start?: unknown }).start === 'number' &&
            Number.isFinite((entry as { start: number }).start),
    );
    const spans = buildChapterSpans(
        usable.map((entry) => ({
            start: entry.start,
            end: typeof entry.end === 'number' && Number.isFinite(entry.end) ? entry.end : null,
            title: typeof entry.title === 'string' ? entry.title : '',
        })),
        (durationSeconds ?? 0) * 1000,
    );
    return spans.map((span, index) => ({
        id: index,
        start: span.startMs / 1000,
        end: span.endMs / 1000,
        // Empty rather than the ordinal `buildChapterSpans` falls back to: the
        // client localises this row, and "212" would be a worse label than the
        // one it has for exactly this case.
        title: span.untagged === true ? '' : span.title,
        ...(span.untagged === true ? { synthetic: true } : {}),
    }));
}

/** jsonb arrays arrive already parsed; anything else reads as empty. */
export function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '');
}

/**
 * `audioFiles[] → { ino: codec }`, skipping anything unusable.
 *
 * Both fields are optional in the persisted shape (the sweep copies whatever
 * AudiobookShelf reported), and a partial entry is common enough that throwing or
 * inventing a placeholder would be worse than omitting it: an absent entry means
 * "no persisted codec for this file", which the caller resolves by falling back
 * to the live session's own value.
 */
function toCodecByIno(value: unknown): Record<string, string> {
    if (!Array.isArray(value)) return {};
    const byIno: Record<string, string> = {};
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) continue;
        const { ino, codec } = entry as { ino?: unknown; codec?: unknown };
        if (typeof ino !== 'string' || ino === '') continue;
        if (typeof codec !== 'string' || codec === '') continue;
        byIno[ino] = codec;
    }
    return byIno;
}

/**
 * Advance the position on one of OUR audiobook sessions, if it is still live.
 *
 * A single conditional UPDATE rather than read-then-`upsertExternalSession`,
 * and that is the whole point of it existing:
 *
 *  - **It cannot resurrect a closed session.** The upsert path sets
 *    `status = 'ACTIVE'` and clears `stopped_at`/`stop_reason` unconditionally.
 *    The client fires a forced report on pause and a close on stop as two
 *    independent requests with no ordering guarantee, so a report that lands
 *    just after the close would flip a COMPLETED row back to ACTIVE — and the
 *    byte proxy would start serving that session's segments again.
 *  - **Ownership is checked in the same statement as the write**, so there is
 *    no window between "this row is mine" and "write to it".
 *
 * Returns the number of rows updated: 0 means no live session of ours matched,
 * which the caller turns into a 404.
 */
export async function advanceAudiobookSessionPosition(
    sql: postgres.Sql,
    args: {
        absSessionId: string;
        userId: string;
        mediaId: string;
        positionMs: number;
    },
): Promise<number> {
    const result = await sql`
        UPDATE play_sessions
           SET position_ms       = ${args.positionMs},
               last_heartbeat_at = now(),
               last_seen_at      = now()
         WHERE source            = ${AUDIOBOOKSHELF_PROVIDER}
           AND source_session_id = ${args.absSessionId}
           AND user_id           = ${args.userId}::uuid
           AND media_id          = ${args.mediaId}::uuid
           AND status IN ('ACTIVE', 'PAUSED')
    `;
    return result.count;
}

/**
 * `external_payload` key holding the highest cumulative `session_elapsed_ms` a
 * session has reported. A report that omits `listened_ms` is converted to a
 * delta against it, because AudiobookShelf adds every `timeListened` it gets.
 */
export const AUDIOBOOK_ELAPSED_KEY = '__lumastra_audiobook_elapsed_ms';

/**
 * Raise the session's stored highest elapsed time to `elapsedMs` and return the
 * value it held before. Runs under the caller's per-session advisory lock, so
 * concurrent reports cannot both read the same previous value.
 */
export async function ratchetAudiobookSessionElapsed(
    sql: postgres.Sql,
    sessionId: string,
    elapsedMs: number,
): Promise<number> {
    const [row] = await sql<{ previous: string }[]>`
        WITH prev AS (
            SELECT COALESCE((external_payload ->> ${AUDIOBOOK_ELAPSED_KEY})::bigint, 0) AS v
              FROM play_sessions WHERE id = ${sessionId}::uuid FOR UPDATE
        )
        UPDATE play_sessions ps
           SET external_payload = jsonb_set(
                   COALESCE(ps.external_payload, '{}'::jsonb),
                   ARRAY[${AUDIOBOOK_ELAPSED_KEY}]::text[],
                   to_jsonb(GREATEST(prev.v, ${Math.round(elapsedMs)}::bigint))
               )
          FROM prev
         WHERE ps.id = ${sessionId}::uuid
        RETURNING prev.v::text AS previous
    `;
    return row ? Number(row.previous) : 0;
}

/** Refresh audiobook liveness without accepting a client position. */
export async function touchAudiobookSessionHeartbeat(
    sql: postgres.Sql,
    args: {
        absSessionId: string;
        userId: string;
        mediaId: string;
        status: 'ACTIVE' | 'PAUSED';
    },
): Promise<{ positionMs: number; runtimeMs: number | null } | null> {
    const [row] = await sql<{ position_ms: number; runtime_ms: number | null }[]>`
        UPDATE play_sessions
           SET last_heartbeat_at = now(),
               last_seen_at = now(),
               status = ${args.status},
               -- last_seen_at, not now(): this stamps the ACTIVE-to-PAUSED
               -- transition, and the transition can be recorded arbitrarily
               -- late. The pause heartbeat is fire-and-forget with no retry and
               -- the periodic ping stops with it, so a dropped request leaves
               -- the row ACTIVE until something else pings — the tab coming
               -- back into view, twenty minutes later. Stamping now() there
               -- would restart the staleness clock on a position that has been
               -- stale the whole time, and closeAudiobookSession reads this
               -- column to decide whether that position is still evidence.
               -- On the right-hand side last_seen_at is still the OLD value,
               -- which for a live pause is a few seconds ago either way.
               paused_at = CASE
                   WHEN ${args.status} = 'PAUSED' AND paused_at IS NULL THEN last_seen_at
                   WHEN ${args.status} = 'ACTIVE' THEN NULL
                   ELSE paused_at
               END,
               stopped_at = NULL,
               stop_reason = NULL
         WHERE source = ${AUDIOBOOKSHELF_PROVIDER}
           AND source_session_id = ${args.absSessionId}
           AND user_id = ${args.userId}::uuid
           AND media_id = ${args.mediaId}::uuid
           AND status IN ('ACTIVE', 'PAUSED')
        RETURNING position_ms, runtime_ms
    `;
    return row ? { positionMs: Number(row.position_ms), runtimeMs: row.runtime_ms } : null;
}

/** The local identity of a book, as the Active Streams merge needs it. */
export interface AudiobookSessionIdentity {
    /** `media_items.id` — the UUID everything downstream keys on. */
    mediaId: string;
    imageRevision?: string;
    /** Local title, preferred over the one the ABS session echoes. */
    title: string;
    overview: string | null;
    year: number | null;
    /** Local runtime in seconds, used when the ABS session reports none. */
    runtimeSeconds: number | null;
}

/**
 * Resolve AudiobookShelf library-item ids to their local rows.
 *
 * Used by the Active Streams merge to turn an upstream `/api/sessions/open`
 * entry into a session row that carries a real `media_items.id`, so the card
 * links, the cover proxy and the per-viewer translation overlay all work the
 * same way they do for a book streamed through Lumastra. An ABS id with no
 * local row simply has no entry — the caller renders the session from the
 * metadata ABS echoed instead, rather than dropping a real listener because the
 * sweep has not caught up yet.
 *
 * Dismissed and non-active rows are included deliberately: someone is
 * demonstrably listening to the book right now, so the operator needs to see it
 * even if the last sweep decided it was absent upstream.
 */
export async function resolveAudiobooksByAbsItemIds(
    sql: postgres.Sql,
    absItemIds: readonly string[],
): Promise<Map<string, AudiobookSessionIdentity>> {
    if (absItemIds.length === 0) return new Map();

    // Identity lookup for rows the caller ALREADY knows are being played — the
    // ids come from AudiobookShelf's own open-session list, not from a user's
    // query, so there is no browse surface here to scope. Viewer visibility is
    // enforced downstream in buildVisibleActiveSessions by the same privacy and
    // permission gate every other active session passes through.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const rows = await sql<
        {
            abs_item_id: string;
            media_id: string;
            image_revision: string;
            title: string;
            overview: string | null;
            year: number | null;
            runtime_seconds: number | null;
        }[]
    >`
        SELECT ei.external_id AS abs_item_id,
               mi.id          AS media_id,
               COALESCE(mi.custom_metadata #>> '{audiobookshelf,updatedAt}', '0') AS image_revision,
               mi.title,
               mi.overview,
               mi.year,
               mi.runtime_seconds
        FROM media_items mi
        JOIN external_ids ei
          ON ei.media_id = mi.id
         AND ei.provider = ${AUDIOBOOKSHELF_PROVIDER}
         AND ei.media_type = ${AUDIOBOOK_MEDIA_TYPE}
        WHERE mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
          AND ei.external_id = ANY(${sql.array(absItemIds as string[])}::text[])
    `;

    return new Map(
        rows.map((row) => [
            row.abs_item_id,
            {
                mediaId: row.media_id,
                imageRevision: row.image_revision,
                title: row.title,
                overview: row.overview,
                year: row.year,
                runtimeSeconds: row.runtime_seconds,
            },
        ]),
    );
}
