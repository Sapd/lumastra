// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cast, crew, studios and tags as the Jellyfin-compatible surface exposes
 * them: per-item credit lists, person and studio lookups, and the PersonIds /
 * StudioIds browse predicates.
 *
 * Identity. Lumastra stores credits by name, so person and studio ids are
 * derived from the name by the SQL functions `person_key()` / `studio_key()`
 * (migration 16.294.0). Every id is computed here, in Postgres; callers never
 * hash a name themselves.
 *
 * Where credits live:
 * - Item detail reads the winning provider row's metadata (`cast` with billing
 *   order, character and TMDB person id; `actors` as the fallback when no
 *   structured cast exists; `directors`, `writers`, `producers`).
 * - Lookups by id read the indexed side tables: `media_people` (actors from
 *   the flat `actors` list and directors; its music `artist` rows are not
 *   persons) and `media_credits` (every structured-cast actor with its TMDB
 *   person id, writers, producers, and studios — `networks` and
 *   `production_companies` of any provider row of the title).
 *
 * Access: a person or studio exists for a caller only through a movie or
 * series the caller can see (`visibleOwnersFragment`), and every count is over
 * those items only.
 */

import type postgres from 'postgres';
import { buildMetadataLateralJoinFragment } from './builders/provider-metadata.builder';
import { buildLibraryAccessFilter } from './builders/library-access.builder';
import { buildAgeRatingFilter } from './builders/age-rating.builder';
import { buildFileBackedVideoItemFilter } from './builders/file-backed-media.builder.js';
import { deniesEverything, type MediaAccessBoundary } from './builders/media-access-boundary.js';

type Fragment = postgres.PendingQuery<postgres.Row[]>;

/** Person credit roles as stored in `media_people.role` / `media_credits.role`. */
export type CreditRole = 'actor' | 'director' | 'writer' | 'producer';
export const CREDIT_ROLES: readonly CreditRole[] = ['actor', 'director', 'writer', 'producer'];

/** One credit of an item, in display order (actors by billing, then crew). */
export interface ItemCreditRow {
    media_id: string;
    name: string;
    person_id: string;
    role: CreditRole;
    /** The character an actor plays. */
    character: string | null;
    /** Numeric TMDB person id, when the structured cast has one. */
    tmdb_id: string | null;
    /** false when the provider said there is no headshot; null when unknown. */
    has_profile: boolean | null;
}

export interface ItemStudiosTagsRow {
    media_id: string;
    studios: Array<{ name: string; id: string }>;
    tags: string[];
}

export interface VisiblePersonRow {
    id: string;
    name: string;
    movie_count: number;
    series_count: number;
    /** TMDB person id from a visible title's structured cast. */
    tmdb_id: string | null;
    has_profile: boolean | null;
}

export interface VisibleStudioRow {
    id: string;
    name: string;
    movie_count: number;
    series_count: number;
}

/** Owner kinds a Persons / Studios listing can be narrowed to. */
export type OwnerType = 'movie' | 'tv';

const UUID_RE = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;

/** Dashed, lower-case UUIDs; anything that is not a UUID is dropped. */
export function normalizeUuids(ids: readonly string[]): string[] {
    const out = new Set<string>();
    for (const raw of ids) {
        const id = raw.trim();
        if (!UUID_RE.test(id)) continue;
        const hex = id.replace(/-/g, '').toLowerCase();
        out.add(
            `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
        );
    }
    return [...out];
}

/** `LIKE` pattern for a substring match, with the wildcards escaped. */
function containsPattern(term: string): string {
    return `%${term.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Movies and series the caller can see, as `SELECT mi.id, mi.media_type`.
 * `parentId` narrows to one library group (a movie with a file in it, a
 * series with an episode file in it); `types` to movies or series.
 */
function visibleOwnersFragment(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
    opts: { types?: readonly OwnerType[]; parentId?: string | null } = {},
): Fragment {
    const types = opts.types && opts.types.length > 0 ? [...opts.types] : ['movie', 'tv'];
    const parentId = opts.parentId && UUID_RE.test(opts.parentId) ? opts.parentId : null;

    return sql`
        SELECT mi.id, mi.media_type
        FROM media_items mi
        WHERE mi.status = 'active'
          AND mi.media_type = ANY(${types}::text[])
          ${buildFileBackedVideoItemFilter(sql, false, types)}
          ${
              parentId
                  ? sql`AND EXISTS (
                SELECT 1
                FROM media_file_items _mfi
                JOIN media_files _mf ON _mf.id = _mfi.file_id
                LEFT JOIN media_items _ep ON _ep.id = _mfi.media_item_id
                LEFT JOIN media_items _season ON _season.id = _ep.parent_id
                WHERE _mf.library_group_id = ${parentId}::uuid
                  AND (_mfi.media_item_id = mi.id OR _season.parent_id = mi.id)
            )`
                  : sql``
          }
          ${buildLibraryAccessFilter(sql, access.library)}
          ${buildAgeRatingFilter(sql, access.age)}
    `;
}

/**
 * Credits naming one of `personIds`, as
 * `SELECT media_id, name, provider_person_id, has_profile`. Index-backed:
 * `idx_media_people_person_key` / `idx_media_credits_person_key`.
 */
function creditsForPersonsFragment(
    sql: postgres.Sql,
    personIds: readonly string[],
    roles: readonly CreditRole[] = CREDIT_ROLES,
): Fragment {
    const peopleRoles = roles.filter((r) => r === 'actor' || r === 'director');
    const creditRoles = roles.filter((r) => r !== 'director');
    return sql`
        SELECT mp.media_id, mp.name, NULL::text AS provider_person_id, NULL::boolean AS has_profile
        FROM media_people mp
        WHERE person_key(mp.name) = ANY(${[...personIds]}::uuid[])
          AND mp.role = ANY(${peopleRoles}::text[])
        UNION ALL
        SELECT mc.media_id, mc.name, mc.provider_person_id, mc.has_profile
        FROM media_credits mc
        WHERE person_key(mc.name) = ANY(${[...personIds]}::uuid[])
          AND mc.role <> 'studio'
          AND mc.role = ANY(${creditRoles}::text[])
    `;
}

/**
 * The TMDB person id and headshot flag of a group of credit rows `c`
 * (aggregate expressions): prefer an id whose headshot is not known missing;
 * has_profile is false only when every id-carrying credit says so.
 */
function personImageAggregates(sql: postgres.Sql): Fragment {
    return sql`
        COALESCE(
            min(c.provider_person_id) FILTER (WHERE c.has_profile IS NOT FALSE),
            min(c.provider_person_id)
        ) AS tmdb_id,
        CASE WHEN bool_and(c.has_profile IS FALSE) FILTER (WHERE c.provider_person_id IS NOT NULL)
             THEN false END AS has_profile
    `;
}

/** `lower(btrim(col)) LIKE lower(prefix) || '%'`, lowered by Postgres. */
function startsWithFilter(sql: postgres.Sql, col: Fragment, prefix: string): Fragment {
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`);
    return sql`AND lower(btrim(${col})) LIKE lower(${escaped}) || '%'`;
}

/** NameStartsWith / NameStartsWithOrGreater / NameLessThan / SearchTerm on `col`. */
function nameFilters(
    sql: postgres.Sql,
    col: Fragment,
    opts: {
        searchTerm?: string | null;
        nameStartsWith?: string | null;
        nameStartsWithOrGreater?: string | null;
        nameLessThan?: string | null;
    },
): Fragment {
    const search = opts.searchTerm?.trim();
    const startsWith = opts.nameStartsWith?.trim();
    const orGreater = opts.nameStartsWithOrGreater?.trim();
    const lessThan = opts.nameLessThan?.trim();
    return sql`
        ${search ? sql`AND immutable_unaccent(${col}) ILIKE immutable_unaccent(${containsPattern(search)})` : sql``}
        ${startsWith ? startsWithFilter(sql, col, startsWith) : sql``}
        ${orGreater ? sql`AND lower(btrim(${col})) >= lower(${orGreater})` : sql``}
        ${lessThan ? sql`AND lower(btrim(${col})) < lower(${lessThan})` : sql``}
    `;
}

// ---------------------------------------------------------------------------
// Browse predicates (used by jellyfin-browse.queries.ts on the row `mi`)
// ---------------------------------------------------------------------------

/** `AND mi.id IN (credits of any of these persons)`. */
export function personFilterFragment(
    sql: postgres.Sql,
    personIds: readonly string[],
    roles: readonly CreditRole[] = CREDIT_ROLES,
): Fragment {
    return sql`AND mi.id IN (SELECT c.media_id FROM (${creditsForPersonsFragment(sql, personIds, roles)}) c)`;
}

/** `AND` the row `mi` carries a studio whose id is one of `studioIds` (index-backed). */
export function studioFilterFragment(sql: postgres.Sql, studioIds: readonly string[]): Fragment {
    return sql`AND mi.id IN (
        SELECT mc.media_id FROM media_credits mc
        WHERE mc.role = 'studio' AND studio_key(mc.name) = ANY(${[...studioIds]}::uuid[])
    )`;
}

/** person_key() of each name, computed by Postgres (same as every emitted id). */
export async function personKeysForNames(
    sql: postgres.Sql,
    names: readonly string[],
): Promise<string[]> {
    if (names.length === 0) return [];
    const rows = await sql<{ id: string }[]>`
        SELECT DISTINCT person_key(n)::text AS id FROM unnest(${[...names]}::text[]) AS n
        WHERE btrim(n) <> ''
    `;
    return rows.map((r) => r.id);
}

/** studio_key() of each name, computed by Postgres. */
export async function studioKeysForNames(
    sql: postgres.Sql,
    names: readonly string[],
): Promise<string[]> {
    if (names.length === 0) return [];
    const rows = await sql<{ id: string }[]>`
        SELECT DISTINCT studio_key(n)::text AS id FROM unnest(${[...names]}::text[]) AS n
        WHERE btrim(n) <> ''
    `;
    return rows.map((r) => r.id);
}

// ---------------------------------------------------------------------------
// Per-item credits, studios, tags
// ---------------------------------------------------------------------------

/**
 * The items' "credit owner": an episode or season answers with its series'
 * credits (Lumastra keeps credits per title, not per episode).
 */
function ownersCte(sql: postgres.Sql, mediaIds: readonly string[]): Fragment {
    // Callers pass ids of items they already serialized for this user.

    return sql`
        SELECT mi.id AS media_id,
            CASE mi.media_type
                WHEN 'episode' THEN COALESCE(
                    (SELECT s.parent_id FROM media_items s WHERE s.id = mi.parent_id AND s.media_type = 'season'),
                    mi.parent_id
                )
                WHEN 'season' THEN mi.parent_id
                ELSE mi.id
            END AS owner_id
        FROM media_items mi
        WHERE mi.id = ANY(${[...mediaIds]}::uuid[])
    `;
}

/**
 * Cast and crew of each item in display order: billed actors (structured
 * `cast`, else the flat `actors` names), then directors, writers, producers.
 * The caller dedupes a name credited twice in one role.
 */
export async function getItemCredits(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<ItemCreditRow[]> {
    const ids = normalizeUuids(mediaIds);
    if (ids.length === 0) return [];
    return sql<ItemCreditRow[]>`
        WITH o AS (${ownersCte(sql, ids)})
        SELECT o.media_id::text AS media_id,
               btrim(c.name) AS name,
               person_key(c.name)::text AS person_id,
               c.role,
               c.character,
               c.tmdb_id,
               c.has_profile
        FROM o
        ${buildMetadataLateralJoinFragment(sql, undefined, 'o.owner_id')}
        CROSS JOIN LATERAL (
            SELECT 0 AS grp, e.ord, e.v->>'name' AS name, 'actor' AS role,
                   NULLIF(btrim(e.v->>'character'), '') AS character,
                   CASE WHEN e.v->>'person_id' ~ '^[0-9]+$' THEN e.v->>'person_id' END AS tmdb_id,
                   CASE WHEN jsonb_typeof(e.v->'has_profile') = 'boolean'
                        THEN (e.v->>'has_profile')::boolean END AS has_profile
            FROM jsonb_array_elements(
                CASE WHEN jsonb_typeof(pm.metadata->'cast') = 'array' THEN pm.metadata->'cast' ELSE '[]'::jsonb END
            ) WITH ORDINALITY e(v, ord)
            WHERE jsonb_typeof(e.v) = 'object'
            UNION ALL
            SELECT 1, a.ord, a.v, 'actor', NULL, NULL, NULL
            FROM jsonb_array_elements_text(
                CASE
                    WHEN jsonb_typeof(pm.metadata->'cast') = 'array'
                         AND jsonb_array_length(pm.metadata->'cast') > 0 THEN '[]'::jsonb
                    WHEN jsonb_typeof(pm.metadata->'actors') = 'array' THEN pm.metadata->'actors'
                    ELSE '[]'::jsonb
                END
            ) WITH ORDINALITY a(v, ord)
            UNION ALL
            SELECT g.grp, x.ord, x.v, g.role, NULL, NULL, NULL
            FROM (VALUES (2, 'director', 'directors'), (3, 'writer', 'writers'), (4, 'producer', 'producers'))
                AS g(grp, role, field)
            CROSS JOIN LATERAL jsonb_array_elements_text(
                CASE WHEN jsonb_typeof(pm.metadata->g.field) = 'array' THEN pm.metadata->g.field ELSE '[]'::jsonb END
            ) WITH ORDINALITY x(v, ord)
        ) c
        WHERE btrim(COALESCE(c.name, '')) <> ''
        ORDER BY o.media_id, c.grp, c.ord
    `;
}

/** Studios (deduped by id, name order) and tags (TMDB keywords) of each item. */
export async function getItemStudiosAndTags(
    sql: postgres.Sql,
    mediaIds: readonly string[],
): Promise<ItemStudiosTagsRow[]> {
    const ids = normalizeUuids(mediaIds);
    if (ids.length === 0) return [];
    return sql<ItemStudiosTagsRow[]>`
        WITH o AS (${ownersCte(sql, ids)})
        SELECT o.media_id::text AS media_id,
            COALESCE((
                SELECT json_agg(json_build_object('name', s.name, 'id', s.id) ORDER BY lower(s.name), s.id)
                FROM (
                    SELECT DISTINCT ON (studio_key(mc.name)) mc.name, studio_key(mc.name)::text AS id
                    FROM media_credits mc
                    WHERE mc.media_id = o.owner_id AND mc.role = 'studio'
                    ORDER BY studio_key(mc.name), mc.name
                ) s
            ), '[]'::json) AS studios,
            COALESCE(ARRAY(
                SELECT DISTINCT btrim(k)
                FROM jsonb_array_elements_text(
                    CASE WHEN jsonb_typeof(pm.metadata->'keywords') = 'array' THEN pm.metadata->'keywords' ELSE '[]'::jsonb END
                ) k
                WHERE btrim(k) <> ''
                ORDER BY btrim(k)
            ), ARRAY[]::text[]) AS tags
        FROM o
        ${buildMetadataLateralJoinFragment(sql, undefined, 'o.owner_id')}
    `;
}

// ---------------------------------------------------------------------------
// Persons
// ---------------------------------------------------------------------------

/**
 * One person by id, when the caller can see at least one title crediting
 * them. Counts are over those titles only.
 */
export async function findVisiblePerson(
    sql: postgres.Sql,
    personId: string,
    access: MediaAccessBoundary,
): Promise<VisiblePersonRow | null> {
    const [id] = normalizeUuids([personId]);
    if (!id || deniesEverything(access)) return null;
    const rows = await sql<VisiblePersonRow[]>`
        WITH v AS (${visibleOwnersFragment(sql, access)})
        SELECT ${id}::text AS id,
               mode() WITHIN GROUP (ORDER BY btrim(c.name)) AS name,
               (COUNT(DISTINCT c.media_id) FILTER (WHERE v.media_type = 'movie'))::int AS movie_count,
               (COUNT(DISTINCT c.media_id) FILTER (WHERE v.media_type = 'tv'))::int AS series_count,
               ${personImageAggregates(sql)}
        FROM (${creditsForPersonsFragment(sql, [id])}) c
        JOIN v ON v.id = c.media_id
        HAVING COUNT(*) > 0
    `;
    return rows[0] ?? null;
}

export interface ListPersonsOptions {
    /** Jellyfin person types already mapped to roles; empty = every role. */
    roles: readonly CreditRole[];
    searchTerm?: string | null;
    nameStartsWith?: string | null;
    nameStartsWithOrGreater?: string | null;
    nameLessThan?: string | null;
    parentId?: string | null;
    /** Only these person ids (`appearsInItemId`: the people of one title). */
    personIds?: readonly string[];
    startIndex: number;
    limit: number;
}

/**
 * Persons credited on any title the caller can see, by name. Without a name
 * or id filter this groups every credit of the visible library (Jellyfin's
 * People view does the same); see the results notes for its cost.
 */
export async function listVisiblePersons(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
    opts: ListPersonsOptions,
): Promise<{ rows: VisiblePersonRow[]; totalCount: number }> {
    if (deniesEverything(access) || opts.roles.length === 0) return { rows: [], totalCount: 0 };
    const peopleRoles = opts.roles.filter((r) => r === 'actor' || r === 'director');
    const creditRoles = opts.roles.filter((r) => r !== 'director');
    const ids = opts.personIds ? normalizeUuids(opts.personIds) : null;
    if (ids && ids.length === 0) return { rows: [], totalCount: 0 };
    const filter = (col: Fragment): Fragment => sql`
        ${ids ? sql`AND person_key(${col}) = ANY(${ids}::uuid[])` : sql``}
        ${nameFilters(sql, col, opts)}
    `;
    const query = (limit: number, offset: number) => sql<
        (VisiblePersonRow & { total_count: string })[]
    >`
        WITH v AS (${visibleOwnersFragment(sql, access, { parentId: opts.parentId })}),
        c AS (
            SELECT mp.media_id, mp.name, NULL::text AS provider_person_id, NULL::boolean AS has_profile
            FROM media_people mp
            WHERE mp.role = ANY(${peopleRoles}::text[]) ${filter(sql`mp.name`)}
            UNION ALL
            SELECT mc.media_id, mc.name, mc.provider_person_id, mc.has_profile
            FROM media_credits mc
            WHERE mc.role <> 'studio' AND mc.role = ANY(${creditRoles}::text[]) ${filter(sql`mc.name`)}
        ),
        p AS (
            SELECT person_key(c.name)::text AS id,
                   mode() WITHIN GROUP (ORDER BY btrim(c.name)) AS name,
                   (COUNT(DISTINCT c.media_id) FILTER (WHERE v.media_type = 'movie'))::int AS movie_count,
                   (COUNT(DISTINCT c.media_id) FILTER (WHERE v.media_type = 'tv'))::int AS series_count,
                   ${personImageAggregates(sql)}
            FROM c JOIN v ON v.id = c.media_id
            GROUP BY person_key(c.name)
        )
        SELECT p.*, COUNT(*) OVER() AS total_count
        FROM p
        ORDER BY lower(p.name), p.id
        LIMIT ${limit} OFFSET ${offset}
    `;
    return pageWithTotal(await query(opts.limit, opts.startIndex), opts, () => query(1, 0));
}

/**
 * Strip `total_count` from a page. When the page is empty because of paging
 * (past the end, or Limit=0) the total comes from `probe`, a one-row query.
 */
async function pageWithTotal<T extends { total_count: string }>(
    rows: T[],
    opts: { startIndex: number; limit: number },
    probe: () => Promise<T[]>,
): Promise<{ rows: Omit<T, 'total_count'>[]; totalCount: number }> {
    const strip = (list: T[]): Omit<T, 'total_count'>[] =>
        list.map(({ total_count: _t, ...r }) => r);
    if (rows.length > 0) return { rows: strip(rows), totalCount: Number(rows[0].total_count) };
    if (opts.startIndex === 0 && opts.limit > 0) return { rows: [], totalCount: 0 };
    const [first] = await probe();
    return { rows: [], totalCount: first ? Number(first.total_count) : 0 };
}

// ---------------------------------------------------------------------------
// Studios
// ---------------------------------------------------------------------------

export interface ListStudiosOptions {
    types?: readonly OwnerType[];
    parentId?: string | null;
    searchTerm?: string | null;
    nameStartsWith?: string | null;
    nameStartsWithOrGreater?: string | null;
    nameLessThan?: string | null;
    /** Only this studio id (a `/Studios/{name}` or `/Items/{studioId}` lookup). */
    studioId?: string | null;
    startIndex: number;
    limit: number;
}

/** Studios of the titles the caller can see, by name, with title counts. */
export async function listVisibleStudios(
    sql: postgres.Sql,
    access: MediaAccessBoundary,
    opts: ListStudiosOptions,
): Promise<{ rows: VisibleStudioRow[]; totalCount: number }> {
    if (deniesEverything(access)) return { rows: [], totalCount: 0 };
    const studioId = opts.studioId ? normalizeUuids([opts.studioId])[0] : null;
    if (opts.studioId && !studioId) return { rows: [], totalCount: 0 };
    const query = (limit: number, offset: number) => sql<
        (VisibleStudioRow & { total_count: string })[]
    >`
        WITH v AS (${visibleOwnersFragment(sql, access, { types: opts.types, parentId: opts.parentId })}),
        g AS (
            SELECT studio_key(mc.name)::text AS id,
                   mode() WITHIN GROUP (ORDER BY mc.name) AS name,
                   (COUNT(DISTINCT mc.media_id) FILTER (WHERE v.media_type = 'movie'))::int AS movie_count,
                   (COUNT(DISTINCT mc.media_id) FILTER (WHERE v.media_type = 'tv'))::int AS series_count
            FROM media_credits mc
            JOIN v ON v.id = mc.media_id
            WHERE mc.role = 'studio'
              ${studioId ? sql`AND studio_key(mc.name) = ${studioId}::uuid` : sql``}
              ${nameFilters(sql, sql`mc.name`, opts)}
            GROUP BY studio_key(mc.name)
        )
        SELECT g.*, COUNT(*) OVER() AS total_count
        FROM g
        ORDER BY lower(g.name), g.id
        LIMIT ${limit} OFFSET ${offset}
    `;
    return pageWithTotal(await query(opts.limit, opts.startIndex), opts, () => query(1, 0));
}

/** One studio by id when a visible title carries it. */
export async function findVisibleStudio(
    sql: postgres.Sql,
    studioId: string,
    access: MediaAccessBoundary,
): Promise<VisibleStudioRow | null> {
    const { rows } = await listVisibleStudios(sql, access, { studioId, startIndex: 0, limit: 1 });
    return rows[0] ?? null;
}

/** studio_key() of a name (for `/Studios/{name}`). */
export async function studioKeyForName(sql: postgres.Sql, name: string): Promise<string | null> {
    const [id] = await studioKeysForNames(sql, [name]);
    return id ?? null;
}

/** person_key() of a name (for `/Persons/{name}`). */
export async function personKeyForName(sql: postgres.Sql, name: string): Promise<string | null> {
    const [id] = await personKeysForNames(sql, [name]);
    return id ?? null;
}
