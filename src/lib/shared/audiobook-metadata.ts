// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The AudiobookShelf metadata shapes, in a client-safe module.
 *
 * These describe what the connector persists under
 * `media_items.custom_metadata.audiobookshelf`. They live here rather than in the
 * query module that reads them because Svelte components need them to type their
 * props, and a component may not import from `$lib/server` at all. The query
 * modules re-export them, so server-side import sites are unchanged.
 */

/** One entry of the chapter table of contents, as ABS models it. */
export type AudiobookChapterMetadata = {
    id: number;
    /** Offset in seconds from the start of the book. */
    start: number;
    /** Offset in seconds from the start of the book. */
    end: number;
    title: string;
    /**
     * True for the span the server invented to cover audio past the end of the
     * upstream chapter list. `title` is empty for it — the wording is the
     * client's, because the API's language negotiation is independent of the
     * client's UI locale.
     */
    synthetic?: boolean;
};

/**
 * One audio file of the book, in playback order.
 *
 * The player presents a multi-file book as ONE continuous timeline by
 * accumulating these durations into a per-file `startOffset`, and addresses the
 * bytes by `ino`. 87% of a real library is multi-file, so this is the normal
 * case — without it the player cannot build a timeline at all.
 */
export type AudiobookFileMetadata = {
    index: number;
    /** AudiobookShelf addresses files by inode: `/api/items/:id/file/:ino`. */
    ino: string | null;
    /** Seconds; null when AudiobookShelf could not probe the file. */
    duration: number | null;
    mimeType: string | null;
    codec: string | null;
};

/** Series membership. Phase 1 stores it; series parent rows are deferred. */
export type AudiobookSeriesMetadata = {
    id: string | null;
    name: string;
    /** ABS allows decimal sequences ("2.5"), so this stays a string. */
    sequence: string | null;
};

/**
 * One AudiobookShelf book as the admin book tab renders it.
 *
 * Every field is nullable or empty-able on purpose: this is a diagnostic view of
 * whatever the connector persisted, and "AudiobookShelf never reported a
 * publisher" is a fact the operator needs to see, not an error to hide.
 */
export interface AudiobookAdminDetail {
    /** `external_ids.external_id` for provider `audiobookshelf` — the ABS item id. */
    absItemId: string | null;
    /** ABS library this book belongs to. The sweep partitions local rows by it. */
    libraryId: string | null;
    /** `library_paths.id` of the row that produced this item. */
    libraryPathId: string | null;
    /** Path on the ABS server, relative to its library root. */
    relPath: string | null;
    subtitle: string | null;
    authors: string[];
    narrators: string[];
    genres: string[];
    /** The shelf the destination groups on, resolved at ingest. */
    seriesName: string | null;
    seriesSequence: number | null;
    /**
     * Where `seriesName` came from.
     *
     * The diagnostic half of the pair: `'folder'` means AudiobookShelf reported no
     * series and the ingest inferred one from the directory name, which is what an
     * operator staring at a wrongly-grouped shelf needs to know. `'none'` means
     * there is no series at all.
     */
    seriesSource: 'abs-series' | 'folder' | 'none' | null;
    publisher: string | null;
    publishedYear: string | null;
    language: string | null;
    isbn: string | null;
    asin: string | null;
    explicit: boolean | null;
    abridged: boolean | null;
    /** Total length in seconds, as ABS reported it. */
    durationSeconds: number | null;
    /** ABS `updatedAt`, epoch ms — bumped on metadata *and* chapter edits. */
    updatedAt: number | null;
    /** ABS `mtimeMs`, epoch ms — the file mtime, so file replacement moves it. */
    mtimeMs: number | null;
    addedAt: number | null;
    chapters: AudiobookChapterMetadata[];
    audioFiles: AudiobookFileMetadata[];
}
