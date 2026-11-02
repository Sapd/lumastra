// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { audiobookDurationMs } from './audiobook-duration.js';
import type { AudiobookKind, Contributor, SeriesItem } from '$lib/schemas/api-audiobook.js';
import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { audiobookRowToPreview } from '$lib/server/utils/audiobook-cards.js';
import { resolveImageSets } from '$lib/server/services/image-descriptor/resolver.js';
import {
    baseFilter,
    searchPredicate,
    languageFilter,
    languageJoin,
} from './audiobook-browse.queries.js';
import { deniesEverything, type MediaAccessBoundary } from './builders/media-access-boundary.js';

export interface CatalogOptions {
    access: MediaAccessBoundary;
    viewerId: string | null;
    surface: ApiSurface;
    q?: string;
    letter?: string;
    authorId?: string;
    narratorId?: string;
    seriesId?: string;
    groupId?: string;
    lang?: string;
    sort?: 'title' | 'added' | 'year' | 'series';
    order?: 'asc' | 'desc';
    collapse?: 'series';
    limit: number;
    offset: number;
}
export interface CatalogBookRow {
    id: string;
    title: string;
    year: number | null;
    ids: Record<string, string>;
    authors: AudiobookKind['authors'];
    narrators: AudiobookKind['narrators'];
    series: AudiobookKind['series'];
    position_ms: string | null;
    duration_ms: string | null;
    finished: boolean;
    updated_at: Date | null;
    state_id: string | null;
    series_finished_count?: string;
    series_duration_ms?: string | null;
}

/**
 * The visibility boundary excludes dismissed, unavailable and inactive books.
 * Selection-only reads may omit language output; a language filter always keeps its join.
 */
export function catalogBooks(
    sql: postgres.Sql,
    o: CatalogOptions,
    includeLanguage = true,
): postgres.PendingQuery<postgres.Row[]> {
    const needsLanguage = includeLanguage || Boolean(o.lang);
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- the caller supplies the library/age access fragment in `o`
    return sql`
        SELECT mi.id, mi.title, mi.year, mi.library_group_id, ${needsLanguage ? sql`lp.language` : sql`NULL::text`} AS language, COALESCE(NULLIF(mi.sort_title, ''), lower(mi.title)) AS title_key,
            COALESCE(mi.library_added_at, mi.created_at) AS added_at,
            jsonb_strip_nulls(jsonb_build_object('isbn', mi.custom_metadata #>> '{audiobookshelf,isbn}',
                'asin', mi.custom_metadata #>> '{audiobookshelf,asin}')) AS ids,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY bc.position)
                FROM audiobook_book_contributors bc JOIN audiobook_contributors c ON c.id = bc.contributor_id
                WHERE bc.media_id = mi.id AND bc.role = 'author'), '[]'::jsonb) AS authors,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY bc.position)
                FROM audiobook_book_contributors bc JOIN audiobook_contributors c ON c.id = bc.contributor_id
                WHERE bc.media_id = mi.id AND bc.role = 'narrator'), '[]'::jsonb) AS narrators,
            CASE WHEN s.id IS NOT NULL THEN jsonb_build_object('id', s.id, 'name', s.name, 'position', bs.sequence) END AS series,
            s.id AS series_id, s.sort_name AS series_key, bs.sequence,
            ums.media_id AS state_id, ums.resume_position_ms::text AS position_ms,
            ${audiobookDurationMs(sql)}::text AS duration_ms,
            COALESCE(ums.is_watched, false) AS finished, ums.last_event_at AS updated_at
        FROM media_items mi
        ${needsLanguage ? languageJoin(sql) : sql``}
        LEFT JOIN audiobook_book_series bs ON bs.media_id = mi.id
        LEFT JOIN audiobook_series s ON s.id = bs.series_id
        LEFT JOIN user_media_state ums ON ums.media_id = mi.id AND ums.user_id = ${o.viewerId}::uuid
        WHERE ${baseFilter(sql, { access: o.access, groupId: o.groupId })}
            ${languageFilter(sql, o.lang)}
            ${searchPredicate(sql, o.q)}
            ${o.seriesId ? sql`AND bs.series_id = ${o.seriesId}::uuid` : sql``}
            ${o.authorId ? sql`AND EXISTS (SELECT 1 FROM audiobook_book_contributors bc WHERE bc.media_id = mi.id AND bc.contributor_id = ${o.authorId}::uuid AND bc.role = 'author')` : sql``}
            ${o.narratorId ? sql`AND EXISTS (SELECT 1 FROM audiobook_book_contributors bc WHERE bc.media_id = mi.id AND bc.contributor_id = ${o.narratorId}::uuid AND bc.role = 'narrator')` : sql``}
    `;
}

function entries(
    sql: postgres.Sql,
    o: CatalogOptions,
    includeLanguage = true,
): postgres.PendingQuery<postgres.Row[]> {
    const collapsed = o.collapse === 'series';
    if (!collapsed)
        return sql`SELECT b.*, b.id AS group_key, 1 AS book_count,
        b.title_key AS entry_sort_key, b.added_at AS entry_added_at, b.year AS entry_year
        FROM (${catalogBooks(sql, o, includeLanguage)}) b`;
    return sql`WITH visible AS (
        SELECT b.*,
            count(*) OVER series_window AS series_total,
            count(*) FILTER (WHERE finished) OVER series_window AS series_finished_count,
            sum(duration_ms::bigint) OVER series_window AS series_duration_ms,
            max(added_at) OVER series_window AS series_added_at,
            max(year) OVER series_window AS series_year
        FROM (${catalogBooks(
            sql,
            {
                ...o,
                q: undefined,
                lang: undefined,
                groupId: undefined,
                authorId: undefined,
                narratorId: undefined,
                seriesId: undefined,
            },
            false,
        )}) b WINDOW series_window AS (PARTITION BY COALESCE(series_id, id))
    ) SELECT DISTINCT ON (group_key) b.*,
        CASE WHEN book_count > 1 THEN series_key ELSE title_key END AS entry_sort_key FROM (
        SELECT b.*, ${collapsed ? sql`COALESCE(b.series_id, b.id)` : sql`b.id`} AS group_key,
            ${collapsed ? sql`v.series_total` : sql`1`} AS book_count,
            v.series_finished_count, v.series_duration_ms,
            ${collapsed ? sql`v.series_added_at` : sql`b.added_at`} AS entry_added_at,
            ${collapsed ? sql`v.series_year` : sql`b.year`} AS entry_year
        FROM (${catalogBooks(sql, o, includeLanguage)}) b JOIN visible v ON v.id = b.id
    ) b ORDER BY group_key, sequence NULLS LAST, title_key COLLATE "C", id`;
}
function letterPredicate(
    sql: postgres.Sql,
    letter?: string,
): postgres.PendingQuery<postgres.Row[]> {
    return !letter
        ? sql``
        : letter === '#'
          ? sql`WHERE b.entry_sort_key !~ '^[a-z]'`
          : sql`WHERE b.entry_sort_key LIKE ${letter.toLowerCase() + '%'}`;
}
export async function listCatalogBooks(
    sql: postgres.Sql,
    o: CatalogOptions,
): Promise<{
    items: AudiobookPreview[];
    page: { limit: number; offset: number; hasMore: boolean; total: number };
}> {
    if (deniesEverything(o.access))
        return { items: [], page: { limit: o.limit, offset: o.offset, hasMore: false, total: 0 } };
    const key =
        o.sort === 'added'
            ? sql`b.entry_added_at`
            : o.sort === 'year'
              ? sql`b.entry_year`
              : o.sort === 'series'
                ? sql`b.series_key COLLATE "C"`
                : sql`b.entry_sort_key COLLATE "C"`;
    const direction = o.order === 'desc' ? sql`DESC` : sql`ASC`;
    const orderBy = sql`ORDER BY ${key} ${direction} NULLS LAST,
        ${o.sort === 'series' ? sql`b.sequence ${direction} NULLS LAST,` : sql``}
        b.title_key COLLATE "C", b.id`;
    // Collapse/sort/count only selection fields. Presentation (including
    // contributor JSON and provider identifiers) belongs to the admitted page.
    const page = sql`
        SELECT ${
            o.collapse === 'series'
                ? sql`b.id, b.series_id, b.title_key, b.series_key, b.sequence,
                b.group_key, b.book_count, b.series_finished_count, b.series_duration_ms,
                b.entry_added_at, b.entry_year, b.entry_sort_key`
                : sql`b.*`
        }, count(*) OVER ()::text AS total
        FROM (${entries(sql, o, o.collapse !== 'series')}) b ${letterPredicate(sql, o.letter)}
        ${orderBy} LIMIT ${o.limit} OFFSET ${o.offset}`;
    const rows = await sql<(CatalogBookRow & { book_count: string; total: string })[]>`
        ${
            o.collapse === 'series'
                ? sql`WITH page AS MATERIALIZED (${page})
                SELECT b.* FROM (
                    SELECT d.*, p.group_key, p.book_count, p.series_finished_count,
                        p.series_duration_ms, p.entry_added_at, p.entry_year,
                        p.entry_sort_key, p.total
                    FROM page p JOIN LATERAL (
                        SELECT d.* FROM (${catalogBooks(sql, o)}) d
                        WHERE d.id = p.id AND d.series_id IS NOT DISTINCT FROM p.series_id
                        OFFSET 0
                    ) d ON true
                ) b ${orderBy}`
                : page
        }`;
    if (o.collapse === 'series')
        for (const row of rows)
            if (row.series && Number(row.book_count) > 1)
                row.series.bookCount = Number(row.book_count);
    let total = Number(rows[0]?.total ?? 0);
    // An out-of-range page has no row carrying its window count.
    if (!rows.length && o.offset > 0) {
        const [count] = await sql<{ total: string }[]>`SELECT count(*)::text AS total
            FROM (${entries(sql, o)}) b ${letterPredicate(sql, o.letter)}`;
        total = Number(count.total);
    }
    return {
        items: await catalogPreviews(sql, o.surface, rows),
        page: { limit: o.limit, offset: o.offset, hasMore: o.offset + rows.length < total, total },
    };
}

export interface ResourceOptions extends CatalogOptions {
    resource: 'author' | 'narrator' | 'series';
    id?: string;
    resourceSort?: 'name' | 'books';
}
interface ResourceRow {
    id: string;
    name: string;
    book_count: string;
    duration_ms: string;
    finished_count: string;
    cover_id: string;
}
function resources(sql: postgres.Sql, o: ResourceOptions): postgres.PendingQuery<postgres.Row[]> {
    const series = o.resource === 'series';
    return sql`SELECT r.id, r.name, count(*)::text AS book_count,
        COALESCE(sum(b.duration_ms::bigint), 0)::text AS duration_ms,
        count(*) FILTER (WHERE b.finished)::text AS finished_count,
        (array_agg(b.id ORDER BY b.sequence NULLS LAST, b.title_key COLLATE "C", b.id))[1] AS cover_id
        FROM (${catalogBooks(sql, { ...o, q: undefined })}) b
        ${
            series
                ? sql`JOIN audiobook_book_series link ON link.media_id = b.id JOIN audiobook_series r ON r.id = link.series_id`
                : sql`JOIN audiobook_book_contributors link ON link.media_id = b.id AND link.role = ${o.resource} JOIN audiobook_contributors r ON r.id = link.contributor_id`
        }
        WHERE true ${o.id ? sql`AND r.id = ${o.id}::uuid` : sql``}
            ${o.q ? sql`AND r.name ILIKE ${'%' + o.q.replace(/[\\%_]/g, '\\$&') + '%'}` : sql``}
        GROUP BY r.id, r.name`;
}
export async function listCatalogResources(
    sql: postgres.Sql,
    o: ResourceOptions,
): Promise<{
    items: (Contributor | SeriesItem)[];
    page: { limit: number; offset: number; hasMore: boolean; total: number };
}> {
    if (deniesEverything(o.access))
        return { items: [], page: { limit: o.limit, offset: o.offset, hasMore: false, total: 0 } };
    const [count] = await sql<
        { total: string }[]
    >`SELECT count(*)::text AS total FROM (${resources(sql, o)}) r`;
    const rows = await sql<ResourceRow[]>`SELECT * FROM (${resources(sql, o)}) r
        ORDER BY ${o.resourceSort === 'books' ? sql`r.book_count::bigint` : sql`lower(r.name) COLLATE "C"`}
            ${o.order === 'desc' ? sql`DESC` : sql`ASC`}, r.id LIMIT ${o.limit} OFFSET ${o.offset}`;
    const images =
        o.resource === 'series'
            ? await resolveImageSets(
                  sql,
                  o.surface,
                  rows.map((r) => ({ id: r.cover_id, mediaType: 'audiobook' })),
              )
            : new Map<string, ImageSet>();
    const total = Number(count.total);
    return {
        items: rows.map((r) => ({
            id: r.id,
            name: r.name,
            bookCount: Number(r.book_count),
            ...(o.resource === 'series'
                ? { durationMs: Number(r.duration_ms), images: images.get(r.cover_id) ?? {} }
                : {}),
        })),
        page: { limit: o.limit, offset: o.offset, hasMore: o.offset + rows.length < total, total },
    };
}
export async function getCatalogResource(
    sql: postgres.Sql,
    o: Pick<ResourceOptions, 'access' | 'viewerId' | 'surface' | 'resource'> & { id: string },
): Promise<
    | (Contributor & {
          durationMs: number;
          images?: SeriesItem['images'];
          progress?: { finishedCount: number; bookCount: number };
          nextUp?: AudiobookPreview | null;
      })
    | null
> {
    if (deniesEverything(o.access)) return null;
    const scope = {
        access: o.access,
        viewerId: o.viewerId,
        surface: o.surface,
        resource: o.resource,
        id: o.id,
        limit: 60,
        offset: 0,
    };
    const [row] = await sql<ResourceRow[]>`SELECT * FROM (${resources(sql, scope)}) r`;
    if (!row) return null;
    const base = {
        id: row.id,
        name: row.name,
        bookCount: Number(row.book_count),
        durationMs: Number(row.duration_ms),
    };
    if (o.resource !== 'series') return base;
    const [next] = await sql<
        CatalogBookRow[]
    >`SELECT * FROM (${catalogBooks(sql, { ...scope, seriesId: o.id })}) b
        WHERE NOT b.finished ORDER BY (COALESCE(b.position_ms::bigint, 0) > 0) DESC,
        b.sequence NULLS LAST, b.title_key COLLATE "C", b.id LIMIT 1`;
    const images = await resolveImageSets(sql, o.surface, [
        { id: row.cover_id, mediaType: 'audiobook' },
    ]);
    return {
        ...base,
        images: images.get(row.cover_id) ?? {},
        progress: { finishedCount: Number(row.finished_count), bookCount: base.bookCount },
        nextUp: next ? (await catalogPreviews(sql, o.surface, [next]))[0] : null,
    };
}

/** Batched image resolution; no provider calls or per-book database reads. */
export async function catalogPreviews(
    sql: postgres.Sql,
    surface: ApiSurface,
    rows: CatalogBookRow[],
): Promise<AudiobookPreview[]> {
    const images = await resolveImageSets(
        sql,
        surface,
        rows.map(({ id }) => ({ id, mediaType: 'audiobook' })),
        { inherit: 'none' },
    );
    return rows.map((row) => audiobookRowToPreview(row, images.get(row.id) ?? {}));
}

export async function catalogLetterCounts(
    sql: postgres.Sql,
    o: CatalogOptions,
): Promise<{ letter: string; count: number }[]> {
    if (deniesEverything(o.access)) return [];
    const rows = await sql<{ letter: string; count: string }[]>`
        SELECT CASE WHEN b.entry_sort_key ~ '^[a-z]' THEN upper(left(b.entry_sort_key, 1)) ELSE '#' END AS letter,
            count(*)::text AS count FROM (${entries(sql, { ...o, letter: undefined })}) b GROUP BY letter ORDER BY letter`;
    return rows.map((r) => ({ letter: r.letter, count: Number(r.count) }));
}

/** Callers MUST admit ids through their own library/age access boundary before calling. */
export async function audiobookPreviewsForAdmittedIds(
    sql: postgres.Sql,
    ids: string[],
    viewerId: string | null,
    surface: ApiSurface,
): Promise<AudiobookPreview[]> {
    if (!ids.length) return [];
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- ids were already admitted by the caller's access filter
    const rows = await sql<CatalogBookRow[]>`
        SELECT mi.id, mi.title, mi.year,
            jsonb_strip_nulls(jsonb_build_object('isbn', mi.custom_metadata #>> '{audiobookshelf,isbn}',
                'asin', mi.custom_metadata #>> '{audiobookshelf,asin}')) AS ids,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY bc.position)
                FROM audiobook_book_contributors bc JOIN audiobook_contributors c ON c.id = bc.contributor_id
                WHERE bc.media_id = mi.id AND bc.role = 'author'), '[]'::jsonb) AS authors,
            COALESCE((SELECT jsonb_agg(jsonb_build_object('id', c.id, 'name', c.name) ORDER BY bc.position)
                FROM audiobook_book_contributors bc JOIN audiobook_contributors c ON c.id = bc.contributor_id
                WHERE bc.media_id = mi.id AND bc.role = 'narrator'), '[]'::jsonb) AS narrators,
            (SELECT jsonb_build_object('id', s.id, 'name', s.name, 'position', bs.sequence)
                FROM audiobook_book_series bs JOIN audiobook_series s ON s.id = bs.series_id WHERE bs.media_id = mi.id) AS series,
            ums.media_id AS state_id, ums.resume_position_ms::text AS position_ms,
            ${audiobookDurationMs(sql)}::text AS duration_ms,
            COALESCE(ums.is_watched, false) AS finished, ums.last_event_at AS updated_at
        FROM media_items mi LEFT JOIN user_media_state ums ON ums.media_id = mi.id AND ums.user_id = ${viewerId}::uuid
        WHERE mi.id = ANY(${ids}::uuid[]) AND mi.media_type = 'audiobook' AND mi.status = 'active'
            AND mi.is_dismissed = false AND mi.has_files = true
        ORDER BY array_position(${ids}::uuid[], mi.id)`;
    return catalogPreviews(sql, surface, rows);
}

/** Every facet uses the same book filters and collapse policy as the letter rail. */
export async function catalogFacets(
    sql: postgres.Sql,
    o: CatalogOptions,
): Promise<{
    shelves: { id: string; name: string; bookCount: number }[];
    languages: { language: string; bookCount: number }[];
    letterCounts: { letter: string; count: number }[];
}> {
    if (deniesEverything(o.access)) return { shelves: [], languages: [], letterCounts: [] };
    const scope = { ...o, letter: undefined };
    const [shelves, languages, letterCounts] = await Promise.all([
        sql<{ id: string; name: string; count: string }[]>`
            SELECT g.id, g.name, count(*)::text AS count FROM (${entries(sql, scope)}) b
            JOIN library_groups g ON g.id = b.library_group_id GROUP BY g.id, g.name ORDER BY g.name, g.id`,
        sql<{ language: string; count: string }[]>`
            SELECT b.language, count(*)::text AS count FROM (${entries(sql, scope)}) b
            WHERE NULLIF(btrim(b.language), '') IS NOT NULL GROUP BY b.language ORDER BY b.language`,
        catalogLetterCounts(sql, scope),
    ]);
    return {
        shelves: shelves.map((r) => ({ id: r.id, name: r.name, bookCount: Number(r.count) })),
        languages: languages.map((r) => ({ language: r.language, bookCount: Number(r.count) })),
        letterCounts,
    };
}
