// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

/**
 * A finer-grained twin of this projection's strict-majority rollup lives at
 * `media-stream-summary.queries.ts` — it powers the media detail modal's
 * real-language display (no de/en/ja/ko/'other' bucketing).
 */

/**
 * Converge one item's audio/subtitle language projection rows onto its streams.
 *
 * Sources: media_streams (audio + subtitle) joined via media_file_items, plus
 * external_subtitle_files sidecars (subtitle kind). Codes are normalized by the
 * SQL normalize_track_language() function; NULL results (und/unknown) contribute
 * no row.
 *
 * DELTA, not delete-then-insert. This is called once per linked item per probe
 * AND once per external subtitle per library-scan cycle, and the unconditional
 * form rewrote every row every time: production logged 24.8M inserts and 24.8M
 * deletes against a 37,620-row table, with 23,924 rows (64% of it) rewritten in
 * a single scan cycle's transaction window. In the steady state the desired set
 * equals the stored set and this now writes nothing at all.
 *
 * The post-state is IDENTICAL to the old form for any stored set S and desired
 * set D: the delete removes S\D, the insert adds D, leaving (S ∩ D) ∪ D = D —
 * which is exactly what delete-everything-then-insert-D produced. That holds for
 * arbitrary drift in S, which is the healing property this must not lose. The
 * primary key (media_item_id, kind, language) is what makes it exact: S cannot
 * contain duplicates for the intersection to preserve.
 *
 * One statement, so `desired` is written ONCE and the delete predicate cannot
 * drift away from the insert's source. The two sub-statements are disjoint by
 * construction — the delete only touches keys NOT in `desired`, the insert only
 * keys IN it — so they never contend for the same key inside the one command.
 */
export async function refreshItemLanguages(sql: postgres.Sql, mediaItemId: string): Promise<void> {
    await sql`
        WITH desired AS (
            SELECT DISTINCT kind, language
            FROM (
                SELECT ms.stream_type AS kind, normalize_track_language(ms.language) AS language
                FROM media_streams ms
                JOIN media_file_items mfi ON mfi.file_id = ms.file_id
                WHERE mfi.media_item_id = ${mediaItemId}
                  AND ms.stream_type IN ('audio', 'subtitle')
                UNION ALL
                SELECT 'subtitle' AS kind, normalize_track_language(esf.language) AS language
                FROM external_subtitle_files esf
                JOIN media_file_items mfi2 ON mfi2.file_id = esf.file_id
                WHERE mfi2.media_item_id = ${mediaItemId}
            ) src
            WHERE src.language IS NOT NULL
        ),
        stale AS (
            -- Scope deliberately unchanged from the old unconditional DELETE:
            -- every kind for this item, not just the two the source produces.
            -- A CHECK constraint pins kind to ('audio','subtitle') anyway, so
            -- the two scopes are the same set — but narrowing it here would be
            -- a silent behaviour change if that constraint is ever relaxed.
            --
            -- Plain equality in the correlation is safe: the table's language
            -- column is NOT NULL and the desired set drops NULLs above, so
            -- neither side can be NULL. (NOT IN over the same subquery would
            -- NOT be safe — it goes UNKNOWN the moment a NULL appears and
            -- deletes nothing at all.)
            DELETE FROM media_item_languages mil
            WHERE mil.media_item_id = ${mediaItemId}
              AND NOT EXISTS (
                  SELECT 1 FROM desired d
                  WHERE d.kind = mil.kind AND d.language = mil.language
              )
        )
        INSERT INTO media_item_languages (media_item_id, kind, language)
        SELECT ${mediaItemId}::uuid, kind, language FROM desired
        ON CONFLICT DO NOTHING
    `;
}

/**
 * Recompute a series' language projection as the strict-majority languages of
 * its episodes, per kind. An episode's series is COALESCE(grandparent, parent)
 * — direct-attached or season-nested; season rows never count as episodes.
 *
 * For each kind, the denominator is the number of episodes that have at least
 * one projection row of that kind (episodes with no data don't dilute). A
 * language qualifies when it appears in a strict majority: cnt * 2 > denom.
 */
export async function refreshSeriesLanguages(sql: postgres.Sql, seriesId: string): Promise<void> {
    // System projection rollup — walks the whole episode/season tree under a
    // given series id for internal language-projection maintenance; no
    // per-user access scoping applies.
    //
    // DELTA, for the reasons on refreshItemLanguages above, and this is the
    // expensive one: refreshLanguagesForFile calls it once per external subtitle
    // whose file belongs to a series, so /data/series alone drove roughly 5,781
    // whole-series rebuilds per scan cycle — each one re-deriving the majority
    // vote across every episode of the series and rewriting the answer even when
    // it had not moved.
    //
    // `ep_langs` READS media_item_languages while `stale` DELETEs from it. That
    // is safe: every sub-statement of a data-modifying WITH sees the same
    // snapshot, so the read cannot observe the delete — and the two touch
    // disjoint rows anyway, since `stale` is scoped to the series id and
    // `episodes` only ever yields media_type='episode' rows. The old two-
    // statement form had the delete land BEFORE the read, and the series' own
    // rows never fed its own majority vote in either form.
    //
    // `episodes` used to find its rows by scanning EVERY media_items row
    // twice (once as `ep`, once again via an unfiltered LEFT JOIN as
    // `parent`) and testing `COALESCE(parent.parent_id, ep.parent_id) =
    // seriesId` per row — the only way to express "grandparent-or-parent" as
    // a row-by-row predicate with no index to drive it (prod slow-query log,
    // 2026-09-26: 22 calls/4.3h, p50 269ms, up to 244ms in a prod EXPLAIN).
    // `seasons_and_series` computes the small set this predicate is actually
    // testing membership against — every season under the series via
    // `idx_media_items_parent_id`, plus the series id itself for a flat
    // (season-less) hierarchy — and `episodes` becomes a direct indexed
    // lookup (`idx_media_items_episode_order`) of each season's/the series'
    // own episodes: 2ms in the same prod EXPLAIN (~116x), 0 mismatches
    // verified against the old predicate across 300 sampled series on prod.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await sql`
        WITH seasons_and_series AS (
            SELECT id FROM media_items WHERE parent_id = ${seriesId}::uuid
            UNION ALL
            SELECT ${seriesId}::uuid
        ),
        episodes AS (
            SELECT ep.id
            FROM media_items ep
            JOIN seasons_and_series ss ON ss.id = ep.parent_id
            WHERE ep.media_type = 'episode'
        ),
        ep_langs AS (
            SELECT mil.kind, mil.language, mil.media_item_id AS ep_id
            FROM media_item_languages mil
            JOIN episodes e ON e.id = mil.media_item_id
        ),
        denom AS (
            SELECT kind, COUNT(DISTINCT ep_id) AS total
            FROM ep_langs GROUP BY kind
        ),
        lang_counts AS (
            SELECT kind, language, COUNT(DISTINCT ep_id) AS cnt
            FROM ep_langs GROUP BY kind, language
        ),
        desired AS (
            SELECT lc.kind, lc.language
            FROM lang_counts lc
            JOIN denom d ON d.kind = lc.kind
            WHERE lc.cnt * 2 > d.total
        ),
        stale AS (
            -- Scope unchanged from the old unconditional DELETE.
            DELETE FROM media_item_languages mil
            WHERE mil.media_item_id = ${seriesId}
              AND mil.kind IN ('audio', 'subtitle')
              AND NOT EXISTS (
                  SELECT 1 FROM desired d
                  WHERE d.kind = mil.kind AND d.language = mil.language
              )
        )
        INSERT INTO media_item_languages (media_item_id, kind, language)
        SELECT ${seriesId}::uuid, kind, language FROM desired
        ON CONFLICT DO NOTHING
    `;
}

/**
 * Refresh language projection for every item linked to a physical file, then
 * roll up each affected episode's series. Called on the media-probe path after
 * replaceStreamsForFile — the only writer of media_streams.
 */
export async function refreshLanguagesForFile(sql: postgres.Sql, fileId: string): Promise<void> {
    // System projection rollup — resolves the media_items linked to a physical
    // file for internal language-projection maintenance; no per-user access
    // scoping applies (mirrors refreshSeriesLanguages above).
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const items = await sql<{ media_item_id: string; media_type: string }[]>`
        SELECT mfi.media_item_id, mi.media_type
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mfi.file_id = ${fileId}
    `;
    const seriesIds = new Set<string>();
    for (const item of items) {
        await refreshItemLanguages(sql, item.media_item_id);
        if (item.media_type === 'episode') {
            // eslint-disable-next-line callback-safety/no-unscoped-media-items
            const [row] = await sql<{ series_id: string | null }[]>`
                SELECT COALESCE(parent.parent_id, ep.parent_id) AS series_id
                FROM media_items ep
                LEFT JOIN media_items parent ON parent.id = ep.parent_id
                WHERE ep.id = ${item.media_item_id}
            `;
            if (row?.series_id) seriesIds.add(row.series_id);
        }
    }
    for (const seriesId of seriesIds) {
        await refreshSeriesLanguages(sql, seriesId);
    }
}

/**
 * Set-based {@link refreshLanguagesForFile} for one library scan's sidecar pass:
 * converges every item linked to a file that has a sidecar under `pathPrefix`
 * (plus `extraFileIds` — files a sidecar was re-paired AWAY from, which no
 * longer own one), then rebuilds each affected series ONCE.
 *
 * Same post-state as calling refreshLanguagesForFile for every sidecar, which
 * the scanner used to do: ~8 serial round trips and a whole-series rebuild per
 * sidecar, i.e. a 40-episode show with two languages rebuilt 80 times a scan.
 * Converging every sidecar-owning item (not just changed ones) keeps the
 * back-fill for a sidecar registered before its video was linked to an item —
 * that row never changes again, so only an unconditional pass reaches it.
 *
 * Same single-statement delta shape as refreshItemLanguages: the delete only
 * touches keys NOT in `desired`, the insert only keys IN it.
 */
export async function convergeSidecarLanguagesByPrefix(
    sql: postgres.Sql,
    pathPrefix: string,
    extraFileIds: readonly string[] = [],
): Promise<{ items: number; series: number }> {
    const escaped = pathPrefix.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const prefix = escaped.endsWith('/') ? escaped : escaped + '/';
    const fileIds = [...extraFileIds];
    // System projection rollup — internal language-projection maintenance for a
    // scan's sidecars; no per-user access scoping applies (mirrors
    // refreshLanguagesForFile above).
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const items = await sql<{ id: string; media_type: string; series_id: string | null }[]>`
        SELECT DISTINCT mi.id, mi.media_type,
               CASE WHEN mi.media_type = 'episode'
                    THEN COALESCE(parent.parent_id, mi.parent_id) END AS series_id
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        LEFT JOIN media_items parent ON parent.id = mi.parent_id
        WHERE mfi.file_id IN (
                  SELECT esf.file_id FROM external_subtitle_files esf
                  WHERE esf.subtitle_path LIKE ${prefix + '%'} ESCAPE '\\'
              )
           OR mfi.file_id = ANY(${fileIds}::uuid[])
    `;
    if (items.length === 0) return { items: 0, series: 0 };
    const itemIds = items.map((i) => i.id);
    await sql`
        WITH scope AS (SELECT unnest(${itemIds}::uuid[]) AS id),
        desired AS (
            SELECT DISTINCT src.media_item_id, src.kind, src.language
            FROM (
                SELECT mfi.media_item_id, ms.stream_type AS kind,
                       normalize_track_language(ms.language) AS language
                FROM media_streams ms
                JOIN media_file_items mfi ON mfi.file_id = ms.file_id
                JOIN scope ON scope.id = mfi.media_item_id
                WHERE ms.stream_type IN ('audio', 'subtitle')
                UNION ALL
                SELECT mfi2.media_item_id, 'subtitle' AS kind,
                       normalize_track_language(esf.language) AS language
                FROM external_subtitle_files esf
                JOIN media_file_items mfi2 ON mfi2.file_id = esf.file_id
                JOIN scope ON scope.id = mfi2.media_item_id
            ) src
            WHERE src.language IS NOT NULL
        ),
        stale AS (
            DELETE FROM media_item_languages mil
            USING scope
            WHERE mil.media_item_id = scope.id
              AND NOT EXISTS (
                  SELECT 1 FROM desired d
                  WHERE d.media_item_id = mil.media_item_id
                    AND d.kind = mil.kind AND d.language = mil.language
              )
        )
        INSERT INTO media_item_languages (media_item_id, kind, language)
        SELECT media_item_id, kind, language FROM desired
        ON CONFLICT DO NOTHING
    `;
    const seriesIds = new Set<string>();
    for (const item of items) if (item.series_id) seriesIds.add(item.series_id);
    for (const seriesId of seriesIds) await refreshSeriesLanguages(sql, seriesId);
    return { items: items.length, series: seriesIds.size };
}

/** Set-based rebuild of movie/episode own-language rows for the whole library. */
export async function rebuildAllItemLanguages(sql: postgres.Sql): Promise<void> {
    // System projection rollup — internal language-projection maintenance over
    // all movie/episode media_items; no per-user access scoping applies
    // (mirrors refreshSeriesLanguages above). Also intentionally omits
    // has_files — the projection must cover every row so it stays accurate
    // if a ghost item later gains files; this maintenance query never
    // surfaces rows to users directly (mirrors embeddings/admin exemptions).
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status
    await sql`
        DELETE FROM media_item_languages
        WHERE media_item_id IN (SELECT id FROM media_items WHERE media_type IN ('movie', 'episode'))
    `;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status
    await sql`
        INSERT INTO media_item_languages (media_item_id, kind, language)
        SELECT DISTINCT mfi.media_item_id, ms.stream_type, normalize_track_language(ms.language)
        FROM media_streams ms
        JOIN media_file_items mfi ON mfi.file_id = ms.file_id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mi.media_type IN ('movie', 'episode')
          AND ms.stream_type IN ('audio', 'subtitle')
          AND normalize_track_language(ms.language) IS NOT NULL
        ON CONFLICT DO NOTHING
    `;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status
    await sql`
        INSERT INTO media_item_languages (media_item_id, kind, language)
        SELECT DISTINCT mfi.media_item_id, 'subtitle', normalize_track_language(esf.language)
        FROM external_subtitle_files esf
        JOIN media_file_items mfi ON mfi.file_id = esf.file_id
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mi.media_type IN ('movie', 'episode')
          AND normalize_track_language(esf.language) IS NOT NULL
        ON CONFLICT DO NOTHING
    `;
}

/** Set-based rebuild of series strict-majority rows from episode rows. */
export async function rebuildAllSeriesLanguages(sql: postgres.Sql): Promise<void> {
    // System projection rollup — internal language-projection maintenance over
    // all series media_items; no per-user access scoping applies (mirrors
    // refreshSeriesLanguages above).
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await sql`
        DELETE FROM media_item_languages
        WHERE media_item_id IN (SELECT id FROM media_items WHERE media_type = 'tv')
    `;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await sql`
        INSERT INTO media_item_languages (media_item_id, kind, language)
        WITH ep_series AS (
            SELECT ep.id AS ep_id,
                   COALESCE(parent.parent_id, ep.parent_id) AS series_id
            FROM media_items ep
            LEFT JOIN media_items parent ON parent.id = ep.parent_id
            WHERE ep.media_type = 'episode'
        ),
        ep_langs AS (
            SELECT es.series_id, mil.kind, mil.language, mil.media_item_id AS ep_id
            FROM media_item_languages mil
            JOIN ep_series es ON es.ep_id = mil.media_item_id
            WHERE es.series_id IS NOT NULL
        ),
        denom AS (
            SELECT series_id, kind, COUNT(DISTINCT ep_id) AS total
            FROM ep_langs GROUP BY series_id, kind
        ),
        lang_counts AS (
            SELECT series_id, kind, language, COUNT(DISTINCT ep_id) AS cnt
            FROM ep_langs GROUP BY series_id, kind, language
        )
        SELECT lc.series_id, lc.kind, lc.language
        FROM lang_counts lc
        JOIN denom d ON d.series_id = lc.series_id AND d.kind = lc.kind
        JOIN media_items s ON s.id = lc.series_id AND s.media_type = 'tv'
        WHERE lc.cnt * 2 > d.total
        ON CONFLICT DO NOTHING
    `;
}

/** Full rebuild: items first, then series (which read item rows). Idempotent. */
export async function rebuildAllLanguages(sql: postgres.Sql): Promise<void> {
    await rebuildAllItemLanguages(sql);
    await rebuildAllSeriesLanguages(sql);
}
