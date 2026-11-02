// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Search Filter Builder
 *
 * Shared utilities for full-text search across query modules.
 * Provides tsquery sanitization, query building, and composable WHERE fragments
 * that use the stored search_vector GIN index on media_items.
 *
 * Two modes:
 * - Simple: WHERE mi.search_vector @@ tsquery (for flat queries on media_items)
 * - Ancestor: CTE MATERIALIZED + parent/grandparent expansion (for admin, music)
 */

import type postgres from 'postgres';
import { buildMusicTsQuery } from '../../../utils/music-search-normalize.js';

/**
 * Strip tsquery syntax characters so user input can't produce malformed tsquery expressions.
 * Characters removed: & | ! ( ) : * \
 */
export const sanitizeForTsquery = (w: string): string => w.replace(/[&|!():*\\]/g, '');

/**
 * Build a tsquery string from free-text input.
 * Sanitizes, filters short words, and joins with prefix matching: `word1:* & word2:*`
 *
 * @returns tsquery string or null if no valid words remain
 */
export function buildTsQueryFromText(
    query: string,
    minWordLength = 2,
    weight?: 'A',
): string | null {
    const words = query
        .trim()
        .split(/\s+/)
        .map(sanitizeForTsquery)
        .filter((w) => w.length >= minWordLength);
    if (words.length === 0) return null;
    return words.map((w) => `${w}:*${weight ?? ''}`).join(' & ');
}

/**
 * Backslash-escape PostgreSQL LIKE/ILIKE metacharacters so user input can't act as a
 * wildcard. PostgreSQL's default ESCAPE for LIKE is backslash, so no ESCAPE clause needed.
 */
export function escapeLikePattern(s: string): string {
    return s.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/** Build an escaped `%…%` ILIKE pattern from free-text input. */
export function buildLikePattern(query: string): string {
    return `%${escapeLikePattern(query)}%`;
}

/**
 * Minimum query length for the substring (ILIKE '%…%') and similarity (`%`)
 * arms. pg_trgm degenerates below 3 characters: a 2-char pattern yields only
 * boundary trigrams that match enormous swaths of the index (measured on prod:
 * '%aa%' touched 2.09M of 2.08M media_keywords index entries, the planner
 * misestimated 417k rows — breaking the hashed-subplan strategy into a
 * 45k-loop materialize probe — and media_people/media_titles fell back to
 * parallel seq scans; the episode search branch took 3-4.6s). Semantically a
 * 2-char substring match against keywords/people/alias titles is noise anyway;
 * FTS prefix matching ('aa:*') remains the meaningful behavior for short
 * queries.
 */
export const MIN_SUBSTRING_QUERY_LENGTH = 3;

/**
 * True iff the query is long enough for the substring/similarity side-table
 * arms (keywords, people, localized titles) to be both meaningful and
 * index-friendly. See MIN_SUBSTRING_QUERY_LENGTH.
 */
export function searchSupportsSubstringMatch(query: string | null | undefined): boolean {
    if (!query) return false;
    return query.trim().length >= MIN_SUBSTRING_QUERY_LENGTH;
}

/**
 * True iff the query has at least one sanitized word of length >= 3 — i.e. the trigram
 * fragment will be non-empty and the caller must SET LOCAL pg_trgm.similarity_threshold.
 * (Minimum raised from 2 to 3: pg_trgm similarity on a 2-char needle is degenerate —
 * see MIN_SUBSTRING_QUERY_LENGTH.)
 */
export function searchNeedsTrigramThreshold(query: string | null | undefined): boolean {
    if (!query) return false;
    return (
        query
            .trim()
            .split(/\s+/)
            .map(sanitizeForTsquery)
            .filter((w) => w.length >= MIN_SUBSTRING_QUERY_LENGTH).length > 0
    );
}

/** FTS predicate on the stored search_vector (media_items aliased `mi`). */
export function ftsMatchFragment(
    sql: postgres.Sql,
    tsQuery: string,
): postgres.PendingQuery<postgres.Row[]> {
    return sql`mi.search_vector @@ to_tsquery('simple', immutable_unaccent(${tsQuery}))`;
}

/**
 * Keyword predicate for the row `mi`, backed by the media_keywords side table
 * (trigger-synced from provider_metadata's keywords/mdblist_keywords arrays —
 * same pattern as media_people for actors/directors). Previously this unnested
 * `pm.metadata->'…keywords'` per candidate row, which referenced the
 * provider_metadata LATERAL from the WHERE clause and forced the planner to
 * materialize the lateral for EVERY row before filtering (45k lateral probes +
 * media_items seq scan on the episode branch — the ~1s wall clock of the whole
 * search fan-out, since it was the slowest parallel branch). The IN-subquery
 * runs ONCE as a hashed subplan against idx_media_keywords_kw_trgm
 * (migration 16.128.0). Matches keywords from ALL providers, not just the
 * winning metadata provider — consistent with peopleMatchFragment.
 * `pattern` must be pre-escaped.
 */
export function keywordMatchFragment(
    sql: postgres.Sql,
    pattern: string,
): postgres.PendingQuery<postgres.Row[]> {
    // `pattern` is '%<escaped query>%' — strip the wildcards and unescape to
    // recover the needle length. Short needles degenerate on the trigram
    // index; see MIN_SUBSTRING_QUERY_LENGTH.
    const needle = pattern.slice(1, -1).replace(/\\(.)/g, '$1');
    if (needle.trim().length < MIN_SUBSTRING_QUERY_LENGTH) return sql`false`;
    return sql`mi.id IN (
        SELECT mk.media_id FROM media_keywords mk
        WHERE immutable_unaccent(mk.keyword) ILIKE immutable_unaccent(${pattern})
    )`;
}

/**
 * Match an actor/director by name for the row `mi`. Backed by the media_people
 * side table (migration 16.101.0), kept in sync with provider_metadata's
 * actors/directors arrays by a trigger. Previously this unnested
 * `pm.metadata->'actors'`/`'directors'` with EXISTS PER candidate row — ~18k
 * JSONB unnests × 2 on a broad term (~2.1s measured on prod). The IN-subquery
 * here runs ONCE as a hashed subplan against the trigram GIN index
 * (idx_media_people_name_trgm, immutable_unaccent(name)), ~7ms. ILIKE catches
 * substrings; `%` adds typo tolerance above the trigram threshold.
 */
/**
 * Graded rank contribution for a credited-person match, for use inside a rank
 * CASE. Returns NULL when the row has no credit match, so the caller can fall
 * through to its next arm.
 *
 * A FLAT score here is a bug, and shipping one is how this function came to
 * exist. `peopleMatchFragment` deliberately matches loosely — an ILIKE
 * substring arm plus a trigram arm — so for the query "lantern pitch" it also
 * returns tracks credited to "The Pitcher" (matched "pitch"), "Lantelier" and
 * "Lantern Project" (matched "lantern"). Scoring every one of those the same as a
 * genuine "Lantern Pitch" credit produced one large tie, and ties break
 * alphabetically by title, so whether the row the user actually wanted made
 * the visible page came down to its first letter. Measured on prod: the target
 * track sat at position 43 with 16 trigram-only rows tying it, most of them
 * sorting earlier by title.
 *
 * The tiers separate exactly the thing that matters — was the credit name the
 * name the user typed:
 *   exact (unaccented, case-insensitive)  0.78  30 rows for that query
 *   substring of a credit name            0.72
 *   trigram-only, i.e. merely similar     0.35  16 rows for that query
 *
 * The values are chosen against SearchService's cross-source normalization,
 * `normalizeRank('music', raw) = 3 + raw/(raw+1)`, not in isolation — that is
 * the scale the endpoint actually sorts on:
 *
 *   3.750  the artist row itself (direct FTS, raw 3.0)
 *   3.444  the artist's albums   (parent FTS, raw 0.80)
 *   3.438  exact credit          (raw 0.78)   <- tracks BY the artist
 *   3.419  substring credit      (raw 0.72)
 *   3.259  trigram-only credit   (raw 0.35)   <- "The Pitcher" for "pitch"
 *
 * So a search for an artist name returns the artist, then their albums, then
 * their tracks, then loose resemblances — and 0.35 sits below every FTS tier,
 * which is the point: a loose credit resemblance is weaker evidence than any
 * real text match.
 *
 * The property that actually decides the original bug is where these land
 * relative to TITLE fuzz, since title-only hits are what buried the wanted
 * track. Scores retained from the original production example; names below are fictional:
 *
 *   3.438  exact credit          <- the track the user wants
 *   3.381  "Lantern" (Eli Fenwick / Distant Mode / Soren Vale)
 *   3.321  "Picture Lantern"
 *   3.318  "Lanterra"
 *   3.259  trigram-only credit   <- now BELOW even the loose title hits
 *
 * Both directions matter: exact credits must clear the title fuzz, and loose
 * credit resemblances must fall beneath it.
 *
 * THESE NUMBERS ARE ORDER-SENSITIVE, NOT ARBITRARY. They look like magic
 * constants and they are not: 0.78 and 0.72 are only 0.02 apart on the raw
 * scale, and both sit within 0.026 of the album tier once normalized. Anything
 * that shifts the scale — a change to `normalizeRank`, or a new source whose
 * raw scores land in the 0.7-0.8 range — can reshuffle these tiers silently,
 * because every spelling still returns the same rows and only the ORDER moves.
 * Re-derive the table above before changing any of them, and verify against
 * the endpoint rather than raw scores: reading raw `searchMusic` values in
 * isolation is exactly what hid the flat-score bug, since the endpoint sorts
 * on the normalized value, not this one.
 */
export function creditMatchRankFragment(
    sql: postgres.Sql,
    query: string,
): postgres.PendingQuery<postgres.Row[]> {
    if (!searchSupportsSubstringMatch(query)) return sql`NULL`;
    const pattern = buildLikePattern(query);
    // The trigram arm only exists when the query qualifies for it, mirroring
    // peopleMatchFragment — otherwise a short query would score a tier that
    // the WHERE clause never let through.
    const trigramArm = searchNeedsTrigramThreshold(query)
        ? sql`WHEN EXISTS (
                SELECT 1 FROM media_people mp
                WHERE mp.media_id = mi.id
                  AND immutable_unaccent(mp.name) % immutable_unaccent(${query})
              ) THEN 0.35`
        : sql``;
    return sql`CASE
        WHEN EXISTS (
            SELECT 1 FROM media_people mp
            WHERE mp.media_id = mi.id
              -- Implied by the exact match below (same pattern as the substring
              -- arm); lets it use idx_media_people_name_trgm instead of a
              -- parallel seq scan of media_people.
              AND immutable_unaccent(mp.name) ILIKE immutable_unaccent(${pattern})
              AND immutable_unaccent(lower(btrim(mp.name))) = immutable_unaccent(lower(${query}))
        ) THEN 0.78
        WHEN EXISTS (
            SELECT 1 FROM media_people mp
            WHERE mp.media_id = mi.id
              AND immutable_unaccent(mp.name) ILIKE immutable_unaccent(${pattern})
        ) THEN 0.72
        ${trigramArm}
        ELSE NULL
    END`;
}

export function peopleMatchFragment(
    sql: postgres.Sql,
    query: string,
): postgres.PendingQuery<postgres.Row[]> {
    if (!searchSupportsSubstringMatch(query)) return sql`false`;
    const pattern = buildLikePattern(query);
    const trgm = searchNeedsTrigramThreshold(query)
        ? sql` OR immutable_unaccent(mp.name) % immutable_unaccent(${query})`
        : sql``;
    return sql`mi.id IN (
        SELECT mp.media_id FROM media_people mp
        WHERE immutable_unaccent(mp.name) ILIKE immutable_unaccent(${pattern})${trgm}
    )`;
}

/**
 * Trigram (typo-tolerant) predicate on title/original/english (media_items aliased `mi`),
 * checked under both immutable_unaccent and german_digraph_fold. Returns an empty fragment
 * when no sanitized word of length >= 3 survives (short queries degenerate on trigram
 * indexes and over-match — see MIN_SUBSTRING_QUERY_LENGTH).
 * Requires the caller to SET LOCAL pg_trgm.similarity_threshold (the `%` operator).
 */
export function trigramMatchFragment(
    sql: postgres.Sql,
    query: string,
): postgres.PendingQuery<postgres.Row[]> {
    if (!searchNeedsTrigramThreshold(query)) return sql``;
    return sql`(
        immutable_unaccent(mi.title) % immutable_unaccent(${query})
        OR german_digraph_fold(mi.title) % german_digraph_fold(${query})
        OR immutable_unaccent(mi.original_title) % immutable_unaccent(${query})
        OR german_digraph_fold(mi.original_title) % german_digraph_fold(${query})
        OR immutable_unaccent(mi.english_title) % immutable_unaccent(${query})
        OR german_digraph_fold(mi.english_title) % german_digraph_fold(${query})
    )`;
}

/**
 * Match against the media_titles side table (localized / original / alias titles) for the
 * row `mi`. media_items.search_vector is built only from the primary title, so a user
 * searching a localized title (e.g. German "Kapitäns Große Pause" for the English-primary
 * "Hafentage") — or even the word "pause" — matches nothing without this. Uses an IN-subquery
 * so the trigram GIN index on media_titles (immutable_unaccent(title) gin_trgm_ops, which
 * accelerates BOTH ILIKE '%…%' and the `%` similarity operator) finds matching titles, then
 * maps to media_ids. ILIKE catches substrings ("pause"); `%` adds typo tolerance.
 */
export function mediaTitlesMatchFragment(
    sql: postgres.Sql,
    query: string,
): postgres.PendingQuery<postgres.Row[]> {
    if (!searchSupportsSubstringMatch(query)) return sql`false`;
    const pattern = buildLikePattern(query);
    // Only the immutable_unaccent expression is GIN-indexed (idx_media_titles_title_trgm),
    // and it accelerates BOTH the ILIKE substring and the `%` similarity match. We do NOT
    // add a german_digraph_fold arm here — it has no index and would force a media_titles
    // seq scan; unaccent already folds ß→ss so German titles still match.
    const trgm = searchNeedsTrigramThreshold(query)
        ? sql` OR immutable_unaccent(mt.title) % immutable_unaccent(${query})`
        : sql``;
    return sql`mi.id IN (
        SELECT mt.media_id FROM media_titles mt
        WHERE immutable_unaccent(mt.title) ILIKE immutable_unaccent(${pattern})${trgm}
    )`;
}

/**
 * Composable match predicate shared by the admin search CTE and public searchMediaFulltext.
 * FTS always; keyword + actor/director + localized-title (media_titles) added when
 * includeKeywordPeople (default true). Returns an empty fragment when the query yields
 * no tsquery (matches the existing <2-char bail in both callers).
 *
 * Trigram is intentionally NOT part of this predicate — admin adds it direct-only in the
 * outer WHERE; public runs its separate searchMediaTrigram pass.
 */
export function buildMediaMatchPredicate(
    sql: postgres.Sql,
    query: string | null | undefined,
    opts?: { includeKeywordPeople?: boolean; includePeople?: boolean },
): postgres.PendingQuery<postgres.Row[]> {
    if (!query) return sql``;
    const tsQuery = buildTsQueryFromText(query);
    if (!tsQuery) return sql``;
    const includeKeywordPeople = opts?.includeKeywordPeople ?? true;
    const fts = ftsMatchFragment(sql, tsQuery);
    // Music (includeKeywordPeople=false) keeps its titles in search_vector and has no
    // media_titles rows, so skip the extra branch there.
    //
    // `includePeople` re-adds the people arm ALONE for music. It exists instead
    // of just flipping includeKeywordPeople because the full branch also drags
    // in the keyword and media_titles arms, and music has rows for neither --
    // that would pay for two always-empty subqueries on every music search.
    //
    // Music credits reach media_people as `source = 'local'` rows via
    // music_people_project() (migration 16.237.0). Before that projection
    // existed a track was findable by artist name only through its
    // track -> album -> album-artist chain, i.e. the PRIMARY artist only, so
    // featured artists were unsearchable.
    if (!includeKeywordPeople) {
        return opts?.includePeople
            ? sql`(${fts} OR ${peopleMatchFragment(sql, query)})`
            : sql`(${fts})`;
    }
    const pattern = buildLikePattern(query);
    return sql`(${fts} OR ${keywordMatchFragment(sql, pattern)} OR ${peopleMatchFragment(sql, query)} OR ${mediaTitlesMatchFragment(sql, query)})`;
}

/**
 * Result from buildSearchFilter — a composable CTE + WHERE pair.
 *
 * Usage in a query:
 * ```sql
 * ${filter.cte}
 * SELECT ... FROM media_items mi
 * WHERE mi.status = 'active'
 * ${filter.where}
 * ```
 */
export interface SearchFilterResult {
    /** CTE fragment: empty for simple mode; WITH _search_hits + _candidates (UNION of direct/parent/grandparent/trigram branches) for ancestor mode */
    cte: postgres.PendingQuery<postgres.Row[]>;
    /** WHERE fragment: AND mi.search_vector @@ ... (simple) or AND mi.id IN (SELECT id FROM _candidates) (ancestor) */
    where: postgres.PendingQuery<postgres.Row[]>;
    /** True when a trigram fragment is present — caller must SET LOCAL pg_trgm.similarity_threshold. */
    needsTrigramThreshold: boolean;
}

export interface SearchFilterOptions {
    /** Add the indexed canonical music-title branch before ancestor expansion. */
    normalizeMusicTitles?: boolean;
    /** Search parent items (e.g. season → series, album → artist) */
    searchParent?: boolean;
    /** Search grandparent items (e.g. episode → series via season) */
    searchGrandparent?: boolean;
    /**
     * Include keyword/people/localized-title matching via the media_keywords /
     * media_people / media_titles side tables (default true).
     * Music sets false — its metadata is already in search_vector, so the extra
     * subqueries are wasted work. Applies only in ancestor mode.
     */
    includeMetadataMatch?: boolean;
    /**
     * Add the media_people arm on its own, without the keyword/media_titles
     * arms that `includeMetadataMatch` also enables. Music uses this: it has no
     * media_keywords or media_titles rows (those subqueries would always be
     * empty) but it DOES have artist credits projected into media_people as
     * `source = 'local'` rows by migration 16.237.0.
     *
     * Without it a music track is findable by artist name only through its
     * track -> album -> album-artist chain, which carries the primary artist
     * alone -- so featured/secondary artists are unsearchable. Applies only in
     * ancestor mode, and only when `includeMetadataMatch` is false.
     */
    includePeopleMatch?: boolean;
    /**
     * Optional media_type scope baked into the hit/candidate CTEs so candidate
     * discovery never leaves the caller's domain (e.g. music passes
     * ['artist','album','track'] and a movie matching the FTS no longer
     * pollutes the hit set). Purely an optimization — callers still apply
     * their own outer filters, so omitting it is always correct.
     * ⚠️ When set together with searchParent/searchGrandparent, the list must
     * be CLOSED under the parent chain (track→album→artist is; episode alone
     * is NOT — its parents are seasons), otherwise ancestor hits get scoped
     * away. Applies only in ancestor mode.
     */
    mediaTypes?: string[];
}

/**
 * Build a composable search filter for media_items queries.
 *
 * **Simple mode** (no ancestors): Returns a WHERE fragment using the GIN index directly.
 * **Ancestor mode** (searchParent/searchGrandparent): Returns a CTE MATERIALIZED that
 * finds matching IDs via GIN index, then a WHERE fragment that expands to children/grandchildren
 * via PK lookups. Benchmarked at 32ms vs 65ms for ILIKE x5 on 180k rows.
 *
 * Note: The CTE restricts ancestor matching to `status = 'active'` items —
 * inactive parents do not propagate matches to their children. This means
 * episodes of an inactive series won't surface via series-title search.
 *
 * @param sql - postgres.Sql instance
 * @param query - User search text (will be sanitized)
 * @param opts - Whether to search parent/grandparent chains
 * @returns { cte, where } to splice into a query
 */
export function buildSearchFilter(
    sql: postgres.Sql,
    query: string | null | undefined,
    opts?: SearchFilterOptions,
): SearchFilterResult {
    const empty: SearchFilterResult = { cte: sql``, where: sql``, needsTrigramThreshold: false };
    if (!query) return empty;

    // The music token query only feeds its own UNION branch: the stored
    // search_vector keeps "u2" / "vol.100" as single lexemes, so the classic
    // query stays on every search_vector predicate.
    const musicTsQuery = opts?.normalizeMusicTitles ? buildMusicTsQuery(query) : null;
    const tsQuery = buildTsQueryFromText(query);
    if (!tsQuery && !musicTsQuery) return empty;

    const needsAncestors = opts?.searchParent || opts?.searchGrandparent;

    if (!needsAncestors && tsQuery) {
        // Simple mode: direct GIN index scan on mi.search_vector (FTS only — no pm join in scope).
        return {
            cte: sql``,
            where: sql`AND ${ftsMatchFragment(sql, tsQuery)}`,
            needsTrigramThreshold: false,
        };
    }

    // Ancestor mode: _search_hits finds matching IDs via the SHARED predicate
    // (FTS + keyword + people), then _candidates expands to children /
    // grandchildren and adds the typo-tolerant trigram arm — each as its OWN
    // UNION branch instead of one big OR in the caller's WHERE. The OR shape
    // forced a filter over every row in the caller's scope, evaluating the
    // 6-way trigram similarity (unaccent + digraph-fold function calls) per
    // row and turning the grandparent EXISTS into a media_items seq scan
    // (~520ms for the music branch on prod). As separate branches each leg is
    // index-driven (GIN trigram BitmapOr, parent_id btree, PK joins): ~135ms
    // on the same data, identical candidate set. The caller's WHERE reduces
    // to a single hashed `IN (SELECT id FROM _candidates)`.
    //
    // No provider_metadata lateral here anymore: the keyword predicate moved to
    // the media_keywords side table (16.128.0), and people/titles were already
    // side-table subqueries — nothing in the predicate references `pm`.
    const withMeta = opts?.includeMetadataMatch ?? true;
    // A bare "3" has no classic query; only the music token branch can match it.
    const predicate = tsQuery
        ? buildMediaMatchPredicate(sql, query, {
              includeKeywordPeople: withMeta,
              includePeople: opts?.includePeopleMatch,
          })
        : sql`false`;
    const needsTrigramThreshold = searchNeedsTrigramThreshold(query);

    const typeScope = opts?.mediaTypes?.length
        ? sql`AND mi.media_type = ANY(${opts.mediaTypes})`
        : sql``;

    // Parent/grandparent expansion scan the in-scope items once, shared by both
    // branches (each used to seq-scan media_items on its own: ~43k buffer hits
    // apiece on prod). The grandparent's middle row (e.g. a season) still comes
    // from media_items unfiltered, as before: it need not be active or of a
    // searched type for its child to match.
    const needsScope = opts?.searchParent || opts?.searchGrandparent;
    const scopeCte = needsScope
        ? sql`,
        _scope AS MATERIALIZED (
            SELECT mi.id, mi.parent_id
            FROM media_items mi
            WHERE mi.status = 'active' ${typeScope}
        )`
        : sql``;

    const parentBranch = opts?.searchParent
        ? sql`UNION
            SELECT s.id
            FROM _scope s
            JOIN _search_hits h ON s.parent_id = h.id`
        : sql``;

    const grandparentBranch = opts?.searchGrandparent
        ? sql`UNION
            SELECT s.id
            FROM _scope s
            JOIN media_items mid ON mid.id = s.parent_id
            JOIN _search_hits h ON mid.parent_id = h.id`
        : sql``;

    const trigramBranch = needsTrigramThreshold
        ? sql`UNION
            SELECT mi.id
            FROM media_items mi
            WHERE mi.status = 'active' ${typeScope}
              AND ${trigramMatchFragment(sql, query)}`
        : sql``;

    const cte = sql`
        WITH _search_hits AS MATERIALIZED (
            SELECT mi.id
            FROM media_items mi
            WHERE mi.status = 'active' ${typeScope}
              AND ${predicate}
            ${
                musicTsQuery
                    ? sql`UNION
                        SELECT mi.id FROM media_items mi
                        WHERE mi.status = 'active'
                          AND mi.media_type IN ('artist', 'album', 'track')
                          AND music_title_search_vector(mi.title, mi.original_title, mi.english_title)
                              @@ to_tsquery('simple', immutable_unaccent(${musicTsQuery}))
                    `
                    : sql``
            }
        )${scopeCte},
        _candidates AS MATERIALIZED (
            SELECT h.id FROM _search_hits h
            ${parentBranch}
            ${grandparentBranch}
            ${trigramBranch}
        )
    `;

    return {
        cte,
        where: sql`AND mi.id IN (SELECT id FROM _candidates)`,
        needsTrigramThreshold,
    };
}
