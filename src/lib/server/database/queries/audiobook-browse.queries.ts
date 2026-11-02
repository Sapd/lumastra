// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Audiobook Browse Query Module — the read side of the `/audiobooks` destination.
 *
 * `audiobooks.queries.ts` owns the ingest/reconcile writes; this module owns
 * every viewer-facing read. They are split because the two have opposite access
 * rules: the sweep MUST see rows a viewer may not (dismissed, soft-deleted),
 * while everything here is gated.
 *
 * Three things are specific to audiobooks and are the reason this cannot reuse
 * `browse.queries.ts`:
 *
 * 1. **Access runs off `media_items.library_group_id`, not files.** ABS books
 *    have no `media_files` row, and `buildLibraryAccessFilter` treats a file-less
 *    row as visible to everyone — so the shared builder would emit a predicate
 *    every audiobook passes. `buildLibraryGroupColumnFilter` is the file-less
 *    counterpart; the same applies to `buildLibraryGroupFilter`, whose group tab
 *    filter walks `media_files` and would match nothing at all.
 * 2. **The shelf tabs are library GROUPS, not media types** (`/browse` tabs on
 *    `media_type`; every book here is `media_type = 'audiobook'`), and the
 *    language chips come from `library_paths.language` — the sole carrier of the
 *    per-library language, joined through `custom_metadata.audiobookshelf.libraryPathId`.
 * 3. **Series collapse.** Measured on a real 1188-item server: 230 of 666
 *    radioplays are one series. Listing them as 230 sibling cards titled
 *    "65 - Als der Meister sich verlor" is unusable, so a series folds into ONE
 *    entry that drills in. The grouping key was already resolved at ingest
 *    (`custom_metadata.audiobookshelf.derivedSeries.name`, ABS series name →
 *    folder name → nothing) and its sequence mirrored into `sort_order`.
 *
 * Nothing here may special-case a library NAME or a language: the mapping is
 * operator configuration, and Lumastra ships open source.
 */

import type postgres from 'postgres';
import { buildAgeRatingFilter } from './builders/age-rating.builder.js';
import { buildLibraryGroupColumnFilter } from './builders/library-access.builder.js';
import { deniesEverything, type MediaAccessBoundary } from './builders/media-access-boundary.js';
import { AUDIOBOOK_MEDIA_TYPE, AUDIOBOOKSHELF_PROVIDER } from './audiobooks.queries.js';
import { Logger } from '../../utils/logger.js';

const logger = Logger.for('AudiobookBrowseQueries');

/** Sort orders the destination offers. `series_sequence` only applies inside a series. */
export type AudiobookSort =
    'title_asc' | 'title_desc' | 'added_desc' | 'year_desc' | 'year_asc' | 'series_sequence';

/** Filters shared by the entry list, the letter rail and the facet counts. */
export interface AudiobookFilter {
    access: MediaAccessBoundary;
    /** `library_groups.id` — one shelf tab. Undefined means every shelf. */
    groupId?: string;
    /** `library_paths.language` — one language chip. Undefined means every language. */
    language?: string;
    /**
     * Drill into one derived series by its exact stored name. Present means the
     * result is the books OF that series (never collapsed).
     */
    series?: string;
    /**
     * Every book credited to one author, by exact name.
     *
     * Exact rather than ILIKE: this is a destination reached by CLICKING a name
     * we ourselves rendered, so the string is known-good, and a substring match
     * would quietly fold "Andreas Fröhlich" into "Andreas Fröhlich & Oliver
     * Rohrbeck" — two different credits.
     *
     * Note what this does NOT claim: the value is whatever AudiobookShelf put in
     * the authors array, which on a real shelf is often a SERIES ("Tkkg" credits
     * 229 books, "Die Sieben Laternenzeichen ???" 178). A filter can honestly say
     * "books whose author field reads X" without asserting X is a person — which
     * is exactly why this is a filter and not an author entity.
     */
    author?: string;
    /** Same contract as {@link author}, over the narrators array. */
    narrator?: string;
    /**
     * Free-text query over title, derived series name, authors and narrators.
     *
     * Matched per BOOK and collapsed afterwards, which gives the right answer at
     * both ends without a special case: one matching volume stays a book tile
     * ("Millionendieben" → that episode), while a term that matches a whole
     * shelf collapses back into one ("KLMN" → one tile of 230, not 230 tiles).
     *
     * ILIKE per term rather than the `search_vector` FTS column — but NOT for
     * the reason this comment used to give ("that column is fed by the metadata
     * pipeline, which never runs for ABS books, so it is empty for every one of
     * them"). That was wrong: `search_vector` is maintained by a DB trigger
     * (`trg_media_items_search_vector`) and is populated for every book. The
     * real reason is coverage — the trigger indexes title/english_title/
     * original_title/overview only, while this filter must also reach the
     * author, narrator and series names that live in `custom_metadata`.
     * See {@link searchPredicate} for the term semantics.
     */
    query?: string;
}

export interface AudiobookListOptions extends AudiobookFilter {
    limit: number;
    offset: number;
    /** 'A'–'Z', or '#' for entries whose sort key does not start with a Latin letter. */
    letter?: string;
    sort: AudiobookSort;
    /**
     * Viewer whose listening state decorates the page, or null for none.
     *
     * Only the PAGE read takes this — the count and the letter rail pass null, so
     * their SQL is byte-identical to the pre-listening-state version and the
     * facets stay viewer-independent.
     */
    viewerId?: string | null;
}

/**
 * One tile on the destination: either a single book or a whole series.
 *
 * A series entry carries the representative book's `mediaId` (its first by
 * sequence) purely so the tile has a cover to render — clicking it drills into
 * the series, it does NOT open that book.
 */
export interface AudiobookEntry {
    kind: 'book' | 'series';
    /** `media_items.id` of the book, or of the series' representative book. */
    mediaId: string;
    imageRevision?: string;
    /**
     * AudiobookShelf `libraryItemId`. Carried so the modal's "open in
     * AudiobookShelf" deep link resolves from the REAL provider slot — search
     * used to smuggle this id through a fake `externalIds.jellyfin`, which §2 of
     * the design retires once books are first-class rows.
     */
    absItemId: string | null;
    /** Book title, or the derived series name. */
    title: string;
    /** The derived series this entry belongs to (both kinds), when it has one. */
    seriesName: string | null;
    /** Position within the series, from the ingest-derived sequence. */
    seriesSequence: number | null;
    /** Books in the series. Always 1 for a book entry. */
    bookCount: number;
    year: number | null;
    runtimeSeconds: number | null;
    authors: string[];
    narrators: string[];
    /** Newest `library_added_at` in the entry — drives the "recently added" sort. */
    addedAt: Date | null;
    libraryGroupId: string | null;
    /**
     * The viewer's place in this book, in ms. Null when unknown — for a series
     * entry it is ALWAYS null: the representative book's position is not the
     * series' position, and showing it would read as one.
     */
    resumePositionMs: number | null;
    /** Total length in ms — `user_media_state.runtime_ms`, else the catalog value. */
    durationMs: number | null;
    /**
     * A book the viewer finished, or a series in which they finished every book.
     * A partly-finished series is not finished.
     */
    isFinished: boolean;
    /** Books in this entry the viewer has finished. 0 or 1 for a book entry. */
    finishedCount: number;
}

export interface AudiobookListResult {
    entries: AudiobookEntry[];
    /** Entries (collapsed), not books — this is what the UI paginates over. */
    totalCount: number;
}

export interface AudiobookShelf {
    id: string;
    name: string;
    bookCount: number;
}

export interface AudiobookLanguageFacet {
    /** `library_paths.language`, e.g. `de`. */
    language: string;
    bookCount: number;
}

export interface AudiobookLetterCount {
    /** 'A'–'Z' or '#'. */
    letter: string;
    count: number;
}

/** A book the viewer is part-way through, for the resume rail. */
export interface AudiobookInProgress {
    mediaId: string;
    imageRevision?: string;
    title: string;
    seriesName: string | null;
    authors: string[];
    positionMs: number;
    /** Total length in ms — `user_media_state.runtime_ms`, falling back to the catalog value. */
    durationMs: number | null;
    lastEventAt: Date | null;
}

interface EntrySqlRow {
    kind: string;
    media_id: string;
    image_revision?: string;
    abs_item_id: string | null;
    title: string;
    series_name: string | null;
    series_sequence: number | null;
    book_count: string;
    year: number | null;
    runtime_seconds: number | null;
    authors: unknown;
    narrators: unknown;
    added_at: Date | null;
    library_group_id: string | null;
    /** bigint — postgres.js hands these back as strings, hence the ::text casts. */
    resume_position_ms: string | null;
    duration_ms: string | null;
    is_finished: boolean | null;
    finished_count: string | null;
}

/**
 * Read a jsonb string array defensively.
 *
 * `custom_metadata` is written by the connector but is not schema-enforced, and
 * an author list that arrived as a bare string (or null) must degrade to an
 * empty list rather than crash a page render.
 */
function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === 'string');
}

/** bigint-as-text → number, or null when absent/unparseable. */
function toMillis(value: string | null): number | null {
    if (value === null) return null;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : null;
}

function mapEntry(row: EntrySqlRow): AudiobookEntry {
    const kind = row.kind === 'series' ? 'series' : 'book';
    const bookCount = Number.parseInt(row.book_count, 10) || 1;
    const finishedCount = Number.parseInt(row.finished_count ?? '0', 10) || 0;

    return {
        kind,
        mediaId: row.media_id,
        imageRevision: row.image_revision ?? '0',
        absItemId: row.abs_item_id,
        title: row.title,
        seriesName: row.series_name,
        seriesSequence: row.series_sequence,
        bookCount,
        year: row.year,
        runtimeSeconds: row.runtime_seconds,
        authors: toStringArray(row.authors),
        narrators: toStringArray(row.narrators),
        addedAt: row.added_at,
        libraryGroupId: row.library_group_id,
        // A series tile stands for the shelf, so its state is the ROLLUP: it is
        // finished only when every book is, and it carries no resume position of
        // its own (the representative book's would read as the series').
        resumePositionMs: kind === 'series' ? null : toMillis(row.resume_position_ms),
        durationMs: kind === 'series' ? null : toMillis(row.duration_ms),
        isFinished:
            kind === 'series'
                ? bookCount > 0 && finishedCount >= bookCount
                : row.is_finished === true,
        finishedCount,
    };
}

/**
 * The predicate every viewer-facing read shares.
 *
 * `is_dismissed` is load-bearing, not hygiene: the sweep marks absent-upstream
 * books dismissed instead of deleting them (deletion is a 30-day purge sentence
 * that would destroy ratings and progress), so dismissed rows accumulate by
 * design and MUST NOT reach a browse surface.
 */
export function baseFilter(
    sql: postgres.Sql,
    filter: AudiobookFilter,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
        AND mi.status = 'active'
        AND mi.is_dismissed = FALSE
        AND mi.has_files = TRUE
        ${filter.groupId ? sql`AND mi.library_group_id = ${filter.groupId}::uuid` : sql``}
        ${filter.series ? sql`AND mi.custom_metadata #>> '{audiobookshelf,derivedSeries,name}' = ${filter.series}` : sql``}
        ${creditFilter(sql, 'authors', filter.author)}
        ${creditFilter(sql, 'narrators', filter.narrator)}
        ${searchPredicate(sql, filter.query)}
        ${buildLibraryGroupColumnFilter(sql, filter.access.library)}
        ${buildAgeRatingFilter(sql, filter.access.age)}
    `;
}

/**
 * Exact membership in a credits array (`authors` / `narrators`).
 *
 * `jsonb_exists` rather than the `?` operator: `?` is a parameter placeholder in
 * enough SQL tooling that writing it inside a tagged template invites a parser
 * to claim it. The function form is identical and unambiguous.
 *
 * A missing or malformed array yields no rows rather than an error — a book
 * whose metadata never arrived should be absent from an author's shelf, not a
 * 500 for everyone else on it.
 */
function creditFilter(
    sql: postgres.Sql,
    field: 'authors' | 'narrators',
    value: string | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    const trimmed = value?.trim();
    if (!trimmed) return sql``;
    const path = field === 'authors' ? '{audiobookshelf,authors}' : '{audiobookshelf,narrators}';
    return sql`AND jsonb_typeof(mi.custom_metadata #> ${path}) = 'array'
               AND jsonb_exists(mi.custom_metadata #> ${path}, ${trimmed})`;
}

/**
 * Upper bound on the number of terms a query is split into.
 *
 * Each term costs five ILIKEs, so an adversarial 200-character query (the
 * schema cap on `q`) could otherwise assemble ~500 of them. Terms past the cap
 * are DROPPED, which widens the result set rather than narrowing it — the
 * conservative direction for a filter, and irrelevant in practice: nobody
 * filters a shelf with thirteen words.
 */
const MAX_SEARCH_TERMS = 12;

/**
 * Free-text predicate — AND across terms, OR across fields.
 *
 * The query is split on whitespace and EVERY term must match SOMEWHERE (title,
 * sort title, series name, an author or a narrator); a term may match a
 * different field than its neighbour, so "king shining" finds The Shining by
 * Stephen King. It used to be one `%whole query%`, which made every
 * non-adjacent multi-word query return nothing — "farrow feuer" and
 * "farrow fire" both scored zero against a shelf that plainly contains
 * Milo Farrow, while the infix "feuerkel" matched. That is how people
 * actually search: two words they remember, not a book's full title.
 *
 * Substring (not prefix) matching per term is deliberate and unchanged — it is
 * what makes "feuerkel" find "Feuerkelch", and what makes a bare "king" find
 * "Stephen King" inside the jsonb text form of `["Stephen King"]` with no extra
 * join. `%` and `_` are escaped per term so a user typing them searches for the
 * literal character instead of silently matching everything.
 *
 * Note this is title/credit substring matching, NOT the `search_vector` FTS
 * column — that column IS populated for ABS books (a DB trigger maintains it,
 * contrary to what this comment used to claim), but it covers only
 * title/overview, so it cannot answer an author or narrator filter on its own.
 * `/search`'s audiobook lane uses the FTS column; this browse filter has to
 * reach the credit fields too.
 *
 * Exported for tests only — `audiobook-browse.search-predicate.test.ts` renders
 * the fragment against a non-connecting postgres.js instance. This is the one
 * shape in the file that composes fragments, and postgres.js glues adjacent
 * ones with NO separator, which is a runtime-only failure everywhere else.
 */
export function searchPredicate(
    sql: postgres.Sql,
    query: string | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    return query?.trim() ? sql`AND ${audiobookSearchMatch(sql, query)}` : sql``;
}

/** Shared by browse and general search, including short kana and credit terms. */
export function audiobookSearchMatch(
    sql: postgres.Sql,
    query: string | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    const trimmed = query?.trim();
    if (!trimmed) return sql`true`;

    const terms = trimmed.split(/\s+/).filter(Boolean).slice(0, MAX_SEARCH_TERMS);
    if (terms.length === 0) return sql`true`;

    const termClauses = terms.map((term) => {
        const pattern = `%${term.replace(/([%_\\])/g, '\\$1')}%`;
        // Built fresh per term: a postgres.js fragment carries its own
        // parameter slots, so one hoisted object interpolated twice would
        // collide.
        return sql`(
            mi.title ILIKE ${pattern}
            OR mi.sort_title ILIKE ${pattern}
            OR COALESCE(mi.custom_metadata #>> '{audiobookshelf,derivedSeries,name}', '') ILIKE ${pattern}
            OR COALESCE(mi.custom_metadata #>> '{audiobookshelf,authors}', '') ILIKE ${pattern}
            OR COALESCE(mi.custom_metadata #>> '{audiobookshelf,narrators}', '') ILIKE ${pattern}
        )`;
    });

    // Explicit ` AND ` between fragments: postgres.js glues `${a}${b}` with
    // nothing in between, which would emit `$3AND (…)` and fail at parse time.
    const body = termClauses.reduce((acc, clause) => sql`${acc} AND ${clause}`);
    return sql`(${body})`;
}

/**
 * Join the owning `library_paths` row, which is the sole carrier of a book's
 * language.
 *
 * Compared as TEXT rather than casting the stored id with `::uuid`: a single row
 * whose `libraryPathId` is malformed would raise 22P02 and take the whole page
 * down for every book, and `library_paths` holds a handful of rows so the lost
 * index use costs nothing. LEFT so a book whose path row was deleted still
 * appears (with no language) instead of vanishing from the catalog.
 */
export function languageJoin(sql: postgres.Sql): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        LEFT JOIN library_paths lp
            ON lp.id::text = mi.custom_metadata #>> '{audiobookshelf,libraryPathId}'
    `;
}

export function languageFilter(
    sql: postgres.Sql,
    language: string | undefined,
): postgres.PendingQuery<postgres.Row[]> {
    return language ? sql`AND lp.language = ${language}` : sql``;
}

/**
 * The per-book projection both the entry list and the letter rail build on.
 *
 * `sort_key` is what the UI actually sorts and buckets by, and it differs from
 * the book's own sort title for a collapsed series: a series must file under its
 * NAME, not under the title of its first episode ("65 - Als der Meister…").
 * `LOWER()` matches the precomputed `sort_title` convention (already
 * article-stripped and diacritics-folded at ingest).
 */
/**
 * Per-book listening state, or typed placeholders when there is no viewer.
 *
 * Emitted as a pair (columns + join) so the row shape is identical either way and
 * callers that do not want the state — the count read and the letter rail — keep
 * SQL with no `user_media_state` in it at all, rather than a join on a NULL id.
 *
 * `user_media_state`'s PK is `(user_id, media_id)`, so this is one index probe
 * per book in the access-filtered set. It has to cover the whole set rather than
 * just the page: the series rollup below is computed BEFORE the page is cut.
 */
function listeningStateColumns(
    sql: postgres.Sql,
    viewerId: string | null,
): postgres.PendingQuery<postgres.Row[]> {
    return viewerId
        ? sql`,
            ums.resume_position_ms::text                              AS resume_position_ms,
            COALESCE(ums.is_watched, false)                           AS is_finished,
            COALESCE(ums.runtime_ms, mi.runtime_seconds * 1000)::text AS duration_ms`
        : sql`,
            NULL::text  AS resume_position_ms,
            false       AS is_finished,
            NULL::text  AS duration_ms`;
}

function listeningStateJoin(
    sql: postgres.Sql,
    viewerId: string | null,
): postgres.PendingQuery<postgres.Row[]> {
    return viewerId
        ? sql`LEFT JOIN user_media_state ums
                     ON ums.media_id = mi.id
                    AND ums.user_id  = ${viewerId}::uuid`
        : sql``;
}

function scopedBooks(
    sql: postgres.Sql,
    filter: AudiobookFilter,
    collapse: boolean,
    viewerId: string | null,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        SELECT
            mi.id,
            COALESCE(mi.custom_metadata #>> '{audiobookshelf,updatedAt}', '0') AS image_revision,
            ei.external_id AS abs_item_id,
            mi.title,
            mi.year,
            mi.runtime_seconds,
            mi.sort_order,
            mi.library_group_id,
            COALESCE(mi.library_added_at, mi.created_at) AS added_at,
            NULLIF(mi.custom_metadata #>> '{audiobookshelf,derivedSeries,name}', '') AS series_name,
            mi.custom_metadata #> '{audiobookshelf,authors}'   AS authors,
            mi.custom_metadata #> '{audiobookshelf,narrators}' AS narrators,
            -- The UNSCALED sequence, for display. sort_order holds the same
            -- value multiplied by SORT_ORDER_SCALE so decimal positions (2.5)
            -- survive an integer column; that scaled form is an ordering
            -- artifact and must never reach a label.
            CASE
                WHEN jsonb_typeof(mi.custom_metadata #> '{audiobookshelf,derivedSeries,sequence}') = 'number'
                THEN (mi.custom_metadata #>> '{audiobookshelf,derivedSeries,sequence}')::float
            END AS series_sequence,
            CASE
                WHEN ${collapse}::boolean
                     AND NULLIF(mi.custom_metadata #>> '{audiobookshelf,derivedSeries,name}', '') IS NOT NULL
                THEN 's:' || (mi.custom_metadata #>> '{audiobookshelf,derivedSeries,name}')
                ELSE 'b:' || mi.id::text
            END AS group_key,
            CASE
                WHEN ${collapse}::boolean
                     AND NULLIF(mi.custom_metadata #>> '{audiobookshelf,derivedSeries,name}', '') IS NOT NULL
                THEN LOWER(mi.custom_metadata #>> '{audiobookshelf,derivedSeries,name}')
                ELSE COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title))
            END AS sort_key,
            COALESCE(NULLIF(mi.sort_title, ''), LOWER(mi.title)) AS book_sort_key
            ${listeningStateColumns(sql, viewerId)}
        FROM media_items mi
        ${languageJoin(sql)}
        LEFT JOIN external_ids ei
            ON ei.media_id = mi.id
           AND ei.provider = ${AUDIOBOOKSHELF_PROVIDER}
           AND ei.media_type = ${AUDIOBOOK_MEDIA_TYPE}
        ${listeningStateJoin(sql, viewerId)}
        WHERE ${baseFilter(sql, filter)}
          ${languageFilter(sql, filter.language)}
    `;
}

/**
 * Fold the per-book rows into one row per entry.
 *
 * `COUNT(*) OVER (PARTITION BY group_key)` is evaluated before `DISTINCT ON`
 * discards the siblings, so the surviving row still knows how many books the
 * series holds. The representative is the lowest `sort_order` — i.e. the first
 * book by the sequence derived at ingest — so a series tile shows volume 1's
 * cover rather than an arbitrary one.
 */
function collapsedEntries(
    sql: postgres.Sql,
    filter: AudiobookFilter,
    collapse: boolean,
    viewerId: string | null,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`
        SELECT DISTINCT ON (b.group_key)
            b.group_key,
            -- A one-book "series" renders as that BOOK, titled by the book
            -- (see the entry SELECT), so it must also sort and bucket by the
            -- book's title — filing it under the series name scattered
            -- "Herbst", "Winter", "Audio" between the S entries of a title sort.
            CASE
                WHEN COUNT(*) OVER (PARTITION BY b.group_key) > 1 THEN b.sort_key
                ELSE b.book_sort_key
            END AS sort_key,
            b.id,
            b.image_revision,
            b.abs_item_id,
            b.title,
            b.series_name,
            b.sort_order,
            b.series_sequence,
            b.year,
            b.runtime_seconds,
            b.authors,
            b.narrators,
            b.library_group_id,
            b.resume_position_ms,
            b.is_finished,
            b.duration_ms,
            COUNT(*)      OVER (PARTITION BY b.group_key) AS book_count,
            MAX(b.added_at) OVER (PARTITION BY b.group_key) AS added_at,
            -- Counted over the same window as book_count, so it survives the
            -- DISTINCT ON that discards the siblings — this is what makes a
            -- collapsed series tile able to say "all 65 finished".
            SUM(CASE WHEN b.is_finished THEN 1 ELSE 0 END)
                OVER (PARTITION BY b.group_key) AS finished_count
        FROM (${scopedBooks(sql, filter, collapse, viewerId)}) b
        ORDER BY b.group_key, b.sort_order NULLS LAST, b.sort_key COLLATE "C", b.id
    `;
}

/**
 * Letter-bucket predicate.
 *
 * '#' is everything that does not start with a Latin letter — the bucket that
 * keeps CJK, Cyrillic and digit-led titles reachable in one tap. Only the title
 * sorts honour a letter: the rail is hidden for the others, so a stale `letter`
 * left in the URL must not silently narrow them.
 */
function letterFilter(
    sql: postgres.Sql,
    letter: string | undefined,
    sort: AudiobookSort,
): postgres.PendingQuery<postgres.Row[]> {
    if (!letter) return sql``;
    if (sort !== 'title_asc' && sort !== 'title_desc') return sql``;
    return letter === '#'
        ? sql`WHERE e.sort_key !~ '^[a-z]'`
        : sql`WHERE e.sort_key LIKE ${letter.toLowerCase() + '%'}`;
}

function orderBy(sql: postgres.Sql, sort: AudiobookSort): postgres.PendingQuery<postgres.Row[]> {
    switch (sort) {
        case 'title_desc':
            return sql`e.sort_key COLLATE "C" DESC, e.id DESC`;
        case 'added_desc':
            return sql`e.added_at DESC NULLS LAST, e.id DESC`;
        case 'year_desc':
            return sql`e.year DESC NULLS LAST, e.sort_key COLLATE "C" ASC, e.id ASC`;
        case 'year_asc':
            return sql`e.year ASC NULLS LAST, e.sort_key COLLATE "C" ASC, e.id ASC`;
        case 'series_sequence':
            return sql`e.sort_order ASC NULLS LAST, e.sort_key COLLATE "C" ASC, e.id ASC`;
        default:
            return sql`e.sort_key COLLATE "C" ASC, e.id ASC`;
    }
}

/**
 * One page of the destination grid.
 *
 * Collapsing is implied by the filter: drilling into a series (`filter.series`)
 * lists that series' books, everything else collapses series into one tile.
 */
export async function getAudiobookEntries(
    sql: postgres.Sql,
    options: AudiobookListOptions,
): Promise<AudiobookListResult> {
    if (deniesEverything(options.access)) return { entries: [], totalCount: 0 };

    const collapse = !options.series;

    try {
        // Each statement builds its OWN fragments: a postgres.js fragment
        // carries the parameter offsets of the query it was serialized into, so
        // sharing one object across two statements is not safe.
        // The count never needs listening state — passing null keeps its SQL free
        // of the join rather than relying on the planner to remove it.
        const [countRow] = await sql<{ count: string }[]>`
            SELECT COUNT(*)::text AS count
            FROM (${collapsedEntries(sql, options, collapse, null)}) e
            ${letterFilter(sql, options.letter, options.sort)}
        `;

        const rows = await sql<EntrySqlRow[]>`
            SELECT
                CASE WHEN e.book_count > 1 THEN 'series' ELSE 'book' END AS kind,
                e.id            AS media_id,
                e.image_revision,
                e.abs_item_id,
                CASE WHEN e.book_count > 1 THEN e.series_name ELSE e.title END AS title,
                e.series_name,
                e.series_sequence,
                e.book_count::text AS book_count,
                e.year,
                -- A collapsed series' runtime would be the FIRST book's, which
                -- reads as the whole series' length. Suppress it; the tile shows
                -- the book count instead.
                CASE WHEN e.book_count > 1 THEN NULL ELSE e.runtime_seconds END AS runtime_seconds,
                e.authors,
                e.narrators,
                e.added_at,
                e.library_group_id,
                e.resume_position_ms,
                e.is_finished,
                e.duration_ms,
                e.finished_count::text AS finished_count
            FROM (${collapsedEntries(sql, options, collapse, options.viewerId ?? null)}) e
            ${letterFilter(sql, options.letter, options.sort)}
            ORDER BY ${orderBy(sql, options.sort)}
            LIMIT ${options.limit}
            OFFSET ${options.offset}
        `;

        return {
            entries: rows.map(mapEntry),
            totalCount: Number.parseInt(countRow?.count ?? '0', 10),
        };
    } catch (error) {
        logger.error('Failed to list audiobook entries', error as Error, {
            groupId: options.groupId,
            language: options.language,
            series: options.series,
        });
        return { entries: [], totalCount: 0 };
    }
}

/**
 * Per-letter counts for the jump rail, bucketed on the SAME key the grid sorts
 * by — so a collapsed series files under its own initial, not its first book's.
 */
export async function getAudiobookLetterCounts(
    sql: postgres.Sql,
    filter: AudiobookFilter,
): Promise<AudiobookLetterCount[]> {
    if (deniesEverything(filter.access)) return [];

    try {
        const rows = await sql<{ letter: string; count: string }[]>`
            SELECT
                CASE WHEN e.sort_key ~ '^[a-z]' THEN UPPER(LEFT(e.sort_key, 1)) ELSE '#' END AS letter,
                COUNT(*)::text AS count
            FROM (${collapsedEntries(sql, filter, !filter.series, null)}) e
            GROUP BY letter
            ORDER BY letter
        `;
        return rows.map((row) => ({
            letter: row.letter,
            count: Number.parseInt(row.count, 10),
        }));
    } catch (error) {
        logger.error('Failed to count audiobook letter buckets', error as Error);
        return [];
    }
}

/**
 * The shelf tabs — every library group that currently holds a visible book.
 *
 * Groups with no books are omitted rather than rendered empty: which groups
 * exist is operator configuration that may include movie libraries, and a tab
 * that always shows "no results" is worse than no tab.
 *
 * Deliberately NOT narrowed by the selected language or series: tabs that
 * appear and disappear as chips are toggled make the page feel broken, and the
 * count is the shelf's size, not the current view's.
 */
export async function getAudiobookShelves(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
): Promise<AudiobookShelf[]> {
    if (deniesEverything(access)) return [];

    try {
        const rows = await sql<{ id: string; name: string; count: string }[]>`
            SELECT lg.id,
                   COALESCE(NULLIF(lg.display_name, ''), lg.name) AS name,
                   COUNT(*)::text AS count
            FROM media_items mi
            JOIN library_groups lg ON lg.id = mi.library_group_id
            WHERE ${baseFilter(sql, { access })}
            GROUP BY lg.id, lg.name, lg.display_name, lg.sort_order
            ORDER BY lg.sort_order, name
        `;
        return rows.map((row) => ({
            id: row.id,
            name: row.name,
            bookCount: Number.parseInt(row.count, 10),
        }));
    } catch (error) {
        logger.error('Failed to list audiobook shelves', error as Error);
        return [];
    }
}

/**
 * The language chips, counted within the selected shelf.
 *
 * Language lives on `library_paths`, never on the item and never inferred from a
 * library's name — an install with no language split simply yields one chip,
 * which the UI hides.
 */
export async function getAudiobookLanguages(
    sql: postgres.Sql,
    filter: AudiobookFilter,
): Promise<AudiobookLanguageFacet[]> {
    if (deniesEverything(filter.access)) return [];

    try {
        const rows = await sql<{ language: string; count: string }[]>`
            SELECT lp.language, COUNT(*)::text AS count
            FROM media_items mi
            ${languageJoin(sql)}
            WHERE ${baseFilter(sql, { ...filter, series: undefined })}
              AND NULLIF(btrim(lp.language), '') IS NOT NULL
            GROUP BY lp.language
            ORDER BY lp.language
        `;
        return rows.map((row) => ({
            language: row.language,
            bookCount: Number.parseInt(row.count, 10),
        }));
    } catch (error) {
        logger.error('Failed to list audiobook languages', error as Error);
        return [];
    }
}

/**
 * Books the viewer is part-way through, newest activity first.
 *
 * Reads the LOCAL progress mirror (`user_media_state`), never AudiobookShelf:
 * the destination must keep working — stale, not broken — while ABS is
 * unreachable, and resume is the one thing a book reader comes back for. The
 * rail is empty until the sync connector starts writing progress; that is the
 * intended degradation, not a missing feature.
 */
export async function getAudiobooksInProgress(
    sql: postgres.Sql,
    options: { userId: string; access: MediaAccessBoundary; limit: number },
): Promise<AudiobookInProgress[]> {
    if (deniesEverything(options.access)) return [];

    try {
        const rows = await sql<
            {
                media_id: string;
                image_revision?: string;
                title: string;
                series_name: string | null;
                authors: unknown;
                position_ms: string;
                duration_ms: string | null;
                last_event_at: Date | null;
            }[]
        >`
            SELECT mi.id AS media_id,
                   COALESCE(mi.custom_metadata #>> '{audiobookshelf,updatedAt}', '0') AS image_revision,
                   mi.title,
                   NULLIF(mi.custom_metadata #>> '{audiobookshelf,derivedSeries,name}', '') AS series_name,
                   mi.custom_metadata #> '{audiobookshelf,authors}' AS authors,
                   ums.resume_position_ms::text AS position_ms,
                   COALESCE(ums.runtime_ms, mi.runtime_seconds * 1000)::text AS duration_ms,
                   ums.last_event_at
            FROM user_media_state ums
            JOIN media_items mi ON mi.id = ums.media_id
            WHERE ums.user_id = ${options.userId}::uuid
              AND ums.resume_position_ms > 0
              AND ums.is_watched = FALSE
              AND mi.media_type = ${AUDIOBOOK_MEDIA_TYPE}
              AND mi.status = 'active'
              AND mi.is_dismissed = FALSE
              AND mi.has_files = TRUE
              ${buildLibraryGroupColumnFilter(sql, options.access.library)}
              ${buildAgeRatingFilter(sql, options.access.age)}
            ORDER BY ums.last_event_at DESC NULLS LAST, mi.id
            LIMIT ${options.limit}
        `;

        return rows.map((row) => ({
            mediaId: row.media_id,
            imageRevision: row.image_revision ?? '0',
            title: row.title,
            seriesName: row.series_name,
            authors: toStringArray(row.authors),
            positionMs: Number.parseInt(row.position_ms, 10) || 0,
            durationMs: row.duration_ms === null ? null : Number.parseInt(row.duration_ms, 10),
            lastEventAt: row.last_event_at,
        }));
    } catch (error) {
        logger.error('Failed to list in-progress audiobooks', error as Error);
        return [];
    }
}

/**
 * Whether this install has any visible audiobook at all.
 *
 * Drives navigation: an install with no AudiobookShelf connector must not grow a
 * dead `/audiobooks` entry, and a viewer denied every audiobook shelf must not
 * see one either — so this is per-viewer, not install-wide.
 */
export async function hasVisibleAudiobooks(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
): Promise<boolean> {
    if (deniesEverything(access)) return false;

    try {
        const rows = await sql<{ one: number }[]>`
            SELECT 1 AS one
            FROM media_items mi
            WHERE ${baseFilter(sql, { access })}
            LIMIT 1
        `;
        return rows.length > 0;
    } catch (error) {
        logger.error('Failed to probe for audiobooks', error as Error);
        return false;
    }
}
