// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin media browser's read of an AudiobookShelf book.
 *
 * Deliberately NOT served off `getAudiobookNodeDetail` (the viewer-facing read):
 * that one answers "what should the listener see", so it joins `user_media_state`
 * for a resume position and omits everything an operator needs to diagnose an
 * ingest — the owning ABS library, the relative path on the ABS server, the two
 * revision keys the sweep partitions on (`updatedAt`, `mtimeMs`) and the per-file
 * list. This one answers "what did the connector actually write", so it joins no
 * user at all and returns the blob whole.
 *
 * The mapping runs in TS rather than as `#>>` extractions in SQL for the same
 * reason `getAudiobookNodeDetail` guards its numeric reads with `jsonb_typeof`:
 * `custom_metadata` is connector-written with no schema to enforce it. In SQL a
 * single bad field is a cast error that fails the whole statement; here it costs
 * that one field and nothing else — which matters most precisely on the page an
 * operator opens *because* a book looks wrong.
 */

import type postgres from 'postgres';
import {
    AUDIOBOOK_MEDIA_TYPE,
    AUDIOBOOKSHELF_METADATA_KEY,
    AUDIOBOOKSHELF_PROVIDER,
    toChapters,
    toStringArray,
} from './audiobooks.queries.js';
import type {
    AudiobookAdminDetail,
    AudiobookFileMetadata,
} from '$lib/shared/audiobook-metadata.js';

// The shape lives in `$lib/shared` so the Book tab component can type its props
// against it; re-exported here because this module is where it is produced.
export type { AudiobookAdminDetail } from '$lib/shared/audiobook-metadata.js';

/** Read a field only when it is actually a non-empty string. */
function str(source: Record<string, unknown>, key: string): string | null {
    const value = source[key];
    return typeof value === 'string' && value !== '' ? value : null;
}

/** Read a field only when it is an actual boolean — `"yes"` is not one. */
function bool(source: Record<string, unknown>, key: string): boolean | null {
    const value = source[key];
    return typeof value === 'boolean' ? value : null;
}

/** Read a field only when it is a finite number. */
function num(source: Record<string, unknown>, key: string): number | null {
    const value = source[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * How the ingest resolved the shelf this book groups under.
 *
 * Anything the ingest did not write reads as null rather than being defaulted to
 * `'none'`: "the connector never recorded a source" and "there is genuinely no
 * series" are different facts, and the second is the one `'none'` states.
 */
function toSeriesSource(value: unknown): 'abs-series' | 'folder' | 'none' | null {
    return value === 'abs-series' || value === 'folder' || value === 'none' ? value : null;
}

/**
 * The per-file list, in playback order.
 *
 * `index` is the only required field: it is what orders the list, and an entry
 * with no position cannot be placed in it. Everything else is optional in the
 * persisted shape (the sweep copies whatever AudiobookShelf reported), and a
 * partial entry still tells the operator a file exists — which is the question
 * this table answers.
 */
function toAudioFiles(value: unknown): AudiobookFileMetadata[] {
    if (!Array.isArray(value)) return [];
    const files: AudiobookFileMetadata[] = [];
    for (const entry of value) {
        if (typeof entry !== 'object' || entry === null) continue;
        const raw = entry as Record<string, unknown>;
        const index = num(raw, 'index');
        if (index === null) continue;
        files.push({
            index,
            ino: str(raw, 'ino'),
            duration: num(raw, 'duration'),
            mimeType: str(raw, 'mimeType'),
            codec: str(raw, 'codec'),
        });
    }
    return files.sort((a, b) => a.index - b.index);
}

/**
 * Map one persisted `custom_metadata.audiobookshelf` blob to the admin shape.
 *
 * Exported separately from the query so the malformed-blob behaviour is testable
 * without a database: the shapes that break this are the ones no fixture library
 * would ever contain on purpose.
 */
export function parseAudiobookAdminDetail(
    blob: unknown,
    absItemId: string | null,
): AudiobookAdminDetail {
    const meta: Record<string, unknown> =
        typeof blob === 'object' && blob !== null && !Array.isArray(blob)
            ? (blob as Record<string, unknown>)
            : {};

    const derived =
        typeof meta.derivedSeries === 'object' && meta.derivedSeries !== null
            ? (meta.derivedSeries as Record<string, unknown>)
            : {};

    const durationSeconds = num(meta, 'duration');

    return {
        absItemId,
        libraryId: str(meta, 'libraryId'),
        libraryPathId: str(meta, 'libraryPathId'),
        relPath: str(meta, 'relPath'),
        subtitle: str(meta, 'subtitle'),
        authors: toStringArray(meta.authors),
        narrators: toStringArray(meta.narrators),
        genres: toStringArray(meta.genres),
        seriesName: str(derived, 'name'),
        seriesSequence: num(derived, 'sequence'),
        seriesSource: toSeriesSource(derived.source),
        publisher: str(meta, 'publisher'),
        publishedYear: str(meta, 'publishedYear'),
        language: str(meta, 'language'),
        isbn: str(meta, 'isbn'),
        asin: str(meta, 'asin'),
        explicit: bool(meta, 'explicit'),
        abridged: bool(meta, 'abridged'),
        durationSeconds,
        updatedAt: num(meta, 'updatedAt'),
        mtimeMs: num(meta, 'mtimeMs'),
        addedAt: num(meta, 'addedAt'),
        chapters: toChapters(meta.chapters, durationSeconds),
        audioFiles: toAudioFiles(meta.audioFiles),
    };
}

interface AudiobookAdminDetailSqlRow {
    metadata: unknown;
    abs_item_id: string | null;
}

/**
 * Read the AudiobookShelf payload for one already-gated audiobook id.
 *
 * Returns null when the id is not an audiobook row, so the caller renders the
 * generic tabs rather than an all-empty book tab. Not scoped to `status` — an
 * operator opening a soft-deleted or dismissed book is opening it *because* it is
 * in that state, and the ABS ids are what they need to see.
 */
export async function getAudiobookAdminDetail(
    sql: postgres.Sql,
    mediaId: string,
): Promise<AudiobookAdminDetail | null> {
    // Single-row admin read for one media id behind the route's `isAdmin` gate;
    // there is no browse surface here to scope per-user.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const [row] = await sql<AudiobookAdminDetailSqlRow[]>`
        SELECT mi.custom_metadata -> ${AUDIOBOOKSHELF_METADATA_KEY} AS metadata,
               (SELECT ei.external_id
                  FROM external_ids ei
                 WHERE ei.media_id = mi.id
                   AND ei.provider = ${AUDIOBOOKSHELF_PROVIDER}
                 LIMIT 1)                                          AS abs_item_id
        FROM media_items mi
        WHERE mi.id         = ${mediaId}::uuid
          AND mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
        LIMIT 1
    `;
    if (!row) return null;

    return parseAudiobookAdminDetail(row.metadata, row.abs_item_id);
}
