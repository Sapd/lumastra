// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

import { withTx } from '$lib/server/database/with-tx.js';

/**
 * Replace one item's quality projection row from ALL of its files' video
 * streams. Best resolution_tier wins (4K>1080p>720p>SD); codec is taken from
 * the stream that won on resolution (ties broken by raw height). hdr_type is
 * independently the best FINE HDR class seen across ANY of the item's video
 * streams (may come from a different stream than the resolution winner) and
 * is left NULL if no stream reaches at least 'sdr'; the coarse hdr_tier is
 * derived from it. If no video stream has a resolution tier at all, the row is
 * deleted (untagged) rather than reinserted.
 *
 * Resolution ordering is still an inline CASE rank (4K>1080p>720p>SD) kept
 * identical across the item/series/rebuild paths. HDR ordering lives SOLELY in
 * the quality_hdr_rank() SQL function (dolby_vision>hdr10_plus>hdr10>hlg>sdr),
 * classification in quality_hdr_type(), and the coarse tier in
 * quality_hdr_tier_from_type() — so HDR ranking can't drift between paths.
 */
export async function refreshItemQuality(sql: postgres.Sql, mediaItemId: string): Promise<void> {
    // Atomic DELETE + INSERT: they are separate statements, so on the connection
    // pool (autocommit) a concurrent reader — e.g. refreshSeriesQuality rolling
    // this episode up into its series — can observe the row absent BETWEEN them.
    // That both re-triggers media_item_quality_pkey (775x on prod 2026-09-22..24)
    // AND strands the series rollup with no episode row, permanently losing the
    // series projection. withTx (not raw sql.begin) opens a SAVEPOINT when the
    // caller already holds a transaction — the media-probe path wraps
    // refreshQualityForFile in one, where raw sql.begin would throw.
    await withTx(sql, async (tx) => {
        await tx`DELETE FROM media_item_quality WHERE media_item_id = ${mediaItemId}`;
        await tx`
        INSERT INTO media_item_quality (
            media_item_id, resolution_tier, hdr_tier, hdr_type, codec,
            has_atmos, has_cc, has_sdh, has_ad, has_audio, has_subtitle
        )
        WITH streams AS (
            SELECT
                quality_resolution_tier(ms.height) AS resolution_tier,
                quality_hdr_type(ms.video_range_type, ms.video_range) AS hdr_type,
                quality_codec(ms.codec) AS codec,
                ms.height,
                CASE quality_resolution_tier(ms.height)
                    WHEN '4K' THEN 4 WHEN '1080p' THEN 3 WHEN '720p' THEN 2 WHEN 'SD' THEN 1 ELSE 0
                END AS res_rank,
                quality_hdr_rank(quality_hdr_type(ms.video_range_type, ms.video_range)) AS hdr_rank
            FROM media_streams ms
            JOIN media_file_items mfi ON mfi.file_id = ms.file_id
            WHERE mfi.media_item_id = ${mediaItemId}
              AND ms.stream_type = 'video'
        ),
        best_res AS (
            SELECT resolution_tier, codec
            FROM streams
            ORDER BY res_rank DESC, height DESC NULLS LAST
            LIMIT 1
        ),
        best_hdr AS (
            SELECT hdr_type
            FROM streams
            WHERE hdr_rank > 0
            ORDER BY hdr_rank DESC
            LIMIT 1
        ),
        -- Accessibility/audio flags: union across ALL of the item's streams
        -- (every stream_type), matching getMediaStreamSummary's movie
        -- semantics. bool_or over an empty set yields NULL, hence the COALESCE
        -- at the projection site.
        flags AS (
            SELECT
                bool_or(ms.stream_type = 'audio') AS has_audio,
                bool_or(ms.stream_type = 'subtitle') AS has_sub_stream,
                bool_or(ms.stream_type = 'video' AND ms.has_closed_captions) AS has_cc,
                bool_or(ms.stream_type = 'subtitle' AND ms.is_hearing_impaired) AS has_sdh_stream,
                bool_or(ms.stream_type = 'audio' AND ms.is_visual_impaired) AS has_ad,
                bool_or(
                    ms.stream_type = 'audio'
                    AND quality_is_atmos(ms.profile, ms.codec, ms.channels)
                ) AS has_atmos
            FROM media_streams ms
            JOIN media_file_items mfi ON mfi.file_id = ms.file_id
            WHERE mfi.media_item_id = ${mediaItemId}
        ),
        -- Sidecar subtitles live in external_subtitle_files keyed by file_id,
        -- NOT media_item_id. Omitting them would make the projection disagree
        -- with the detail page for any item with external .srt/.ass subs.
        sidecars AS (
            SELECT
                count(*) > 0 AS has_sidecar,
                bool_or(esf.is_sdh) AS has_sdh_sidecar
            FROM external_subtitle_files esf
            JOIN media_file_items mfi ON mfi.file_id = esf.file_id
            WHERE mfi.media_item_id = ${mediaItemId}
        )
        SELECT ${mediaItemId}::uuid, br.resolution_tier,
               quality_hdr_tier_from_type(bh.hdr_type), bh.hdr_type, br.codec,
               COALESCE(f.has_atmos, false),
               COALESCE(f.has_cc, false),
               COALESCE(f.has_sdh_stream, false) OR COALESCE(sc.has_sdh_sidecar, false),
               COALESCE(f.has_ad, false),
               COALESCE(f.has_audio, false),
               COALESCE(f.has_sub_stream, false) OR COALESCE(sc.has_sidecar, false)
        FROM best_res br
        LEFT JOIN best_hdr bh ON true
        LEFT JOIN flags f ON true
        LEFT JOIN sidecars sc ON true
        WHERE br.resolution_tier IS NOT NULL
        -- Upsert, not a bare INSERT: the DELETE above is a separate statement.
        -- Two concurrent refreshes of one item both delete, so the second INSERT
        -- hit media_item_quality_pkey (775x on prod in 48 h); the enclosing
        -- withTx keeps the delete invisible to concurrent readers so the row is
        -- never transiently lost either.
        ON CONFLICT (media_item_id) DO UPDATE SET
            resolution_tier = EXCLUDED.resolution_tier,
            hdr_tier = EXCLUDED.hdr_tier,
            hdr_type = EXCLUDED.hdr_type,
            codec = EXCLUDED.codec,
            has_atmos = EXCLUDED.has_atmos,
            has_cc = EXCLUDED.has_cc,
            has_sdh = EXCLUDED.has_sdh,
            has_ad = EXCLUDED.has_ad,
            has_audio = EXCLUDED.has_audio,
            has_subtitle = EXCLUDED.has_subtitle
    `;
    });
}

/**
 * Recompute a series' quality projection as the best tier among its
 * episodes' already-computed media_item_quality rows. An episode's series is
 * COALESCE(grandparent, parent) — direct-attached or season-nested; season
 * rows never count as episodes (mirrors refreshSeriesLanguages).
 *
 * resolution_tier = MAX tier among episodes; codec = codec of the
 * best-resolution episode; hdr_tier = best HDR tier among episodes
 * (independently of which episode won on resolution), NULL if none reach at
 * least 'sdr'. Row is deleted if no episode has a resolution tier.
 */
export async function refreshSeriesQuality(sql: postgres.Sql, seriesId: string): Promise<void> {
    // Atomic DELETE + INSERT — see refreshItemQuality. A concurrent probe of a
    // second episode rolls the SAME series up; without the transaction the
    // series row is transiently absent (pkey collision) or, if a concurrent
    // episode refresh has transiently deleted its own row, the rollup reads no
    // episodes and the series projection is permanently lost.
    await withTx(sql, async (tx) => {
        await tx`DELETE FROM media_item_quality WHERE media_item_id = ${seriesId}`;
        // System projection rollup — walks the whole episode/season tree under a
        // given series id for internal quality-projection maintenance; no
        // per-user access scoping applies (mirrors refreshSeriesLanguages).
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        await tx`
        INSERT INTO media_item_quality (
            media_item_id, resolution_tier, hdr_tier, hdr_type, codec,
            has_atmos, has_cc, has_sdh, has_ad, has_audio, has_subtitle
        )
        WITH
        -- Same set as the old COALESCE(parent.parent_id, ep.parent_id) = series,
        -- which could not use an index (two seq scans of media_items, ~450 ms
        -- per call on prod). Branch 1: episodes attached to the series itself,
        -- only when the series row has no parent (as COALESCE decided). Branch
        -- 2: episodes under a row whose parent is the series (a season).
        episodes AS (
            SELECT ep.id
            FROM media_items ep
            WHERE ep.media_type = 'episode' AND ep.parent_id = ${seriesId}::uuid
              AND NOT EXISTS (
                  SELECT 1 FROM media_items sr
                  WHERE sr.id = ${seriesId}::uuid AND sr.parent_id IS NOT NULL
              )
            UNION ALL
            SELECT ep.id
            FROM media_items ep
            JOIN media_items s ON s.id = ep.parent_id
            WHERE ep.media_type = 'episode' AND s.parent_id = ${seriesId}::uuid
        ),
        ep_quality AS (
            SELECT
                miq.resolution_tier,
                miq.hdr_type,
                miq.codec,
                miq.has_atmos, miq.has_cc, miq.has_sdh, miq.has_ad,
                miq.has_audio, miq.has_subtitle,
                CASE miq.resolution_tier
                    WHEN '4K' THEN 4 WHEN '1080p' THEN 3 WHEN '720p' THEN 2 WHEN 'SD' THEN 1 ELSE 0
                END AS res_rank,
                quality_hdr_rank(miq.hdr_type) AS hdr_rank
            FROM media_item_quality miq
            JOIN episodes e ON e.id = miq.media_item_id
        ),
        best_res AS (
            SELECT resolution_tier, codec
            FROM ep_quality
            ORDER BY res_rank DESC
            LIMIT 1
        ),
        best_hdr AS (
            SELECT hdr_type
            FROM ep_quality
            WHERE hdr_rank > 0
            ORDER BY hdr_rank DESC
            LIMIT 1
        ),
        -- KNOWN DIVERGENCE: the denominator counts episodes that HAVE a
        -- projection row, i.e. episodes whose video stream produced a
        -- resolution tier. An episode probed with an unparseable height has a
        -- video stream but no row, so rollupMajority() would count it here and
        -- we do not. Accepted deliberately: closing it would mean re-scanning
        -- media_streams from the series path, which is exactly the per-item
        -- cost this projection exists to avoid, and such an episode already
        -- contributes no resolution/HDR either.
        --
        -- STRICT MAJORITY across episodes, matching rollupMajority() in
        -- media-stream-summary.queries.ts. "Any episode" would badge a whole
        -- series SDH off a single episode. Denominators are PER KIND so an
        -- episode lacking a kind never dilutes that kind's vote: CC over
        -- episodes with video (a projection row only exists when
        -- resolution_tier IS NOT NULL, so row count IS the video denominator),
        -- SDH over episodes with a subtitle track, AD over episodes with audio.
        --
        -- has_atmos is the exception: it rolls up as BEST-AVAILABLE (bool_or),
        -- consistent with resolution_tier/hdr_tier above and with the detail
        -- page's bestAudio, which also picks the best stream rather than voting.
        ep_flags AS (
            SELECT
                count(*) AS n_rows,
                count(*) FILTER (WHERE has_audio) AS n_audio,
                count(*) FILTER (WHERE has_subtitle) AS n_sub,
                count(*) FILTER (WHERE has_cc) AS n_cc,
                count(*) FILTER (WHERE has_sdh) AS n_sdh,
                count(*) FILTER (WHERE has_ad) AS n_ad,
                bool_or(has_atmos) AS has_atmos,
                bool_or(has_audio) AS has_audio,
                bool_or(has_subtitle) AS has_subtitle
            FROM ep_quality
        )
        SELECT ${seriesId}::uuid, br.resolution_tier,
               quality_hdr_tier_from_type(bh.hdr_type), bh.hdr_type, br.codec,
               COALESCE(ef.has_atmos, false),
               COALESCE(ef.n_cc * 2 > ef.n_rows, false),
               COALESCE(ef.n_sdh * 2 > ef.n_sub, false),
               COALESCE(ef.n_ad * 2 > ef.n_audio, false),
               COALESCE(ef.has_audio, false),
               COALESCE(ef.has_subtitle, false)
        FROM best_res br
        LEFT JOIN best_hdr bh ON true
        LEFT JOIN ep_flags ef ON true
        WHERE br.resolution_tier IS NOT NULL
        -- Upsert inside withTx: concurrent probes of two episodes roll up the
        -- SAME series; the transaction keeps each delete+insert atomic so a
        -- reader never sees the series row missing (see refreshItemQuality).
        ON CONFLICT (media_item_id) DO UPDATE SET
            resolution_tier = EXCLUDED.resolution_tier,
            hdr_tier = EXCLUDED.hdr_tier,
            hdr_type = EXCLUDED.hdr_type,
            codec = EXCLUDED.codec,
            has_atmos = EXCLUDED.has_atmos,
            has_cc = EXCLUDED.has_cc,
            has_sdh = EXCLUDED.has_sdh,
            has_ad = EXCLUDED.has_ad,
            has_audio = EXCLUDED.has_audio,
            has_subtitle = EXCLUDED.has_subtitle
    `;
    });
}

/**
 * Refresh quality projection for every item linked to a physical file, then
 * roll up each affected episode's series. Called on the media-probe path
 * after replaceStreamsForFile — the only writer of media_streams.
 */
export async function refreshQualityForFile(sql: postgres.Sql, fileId: string): Promise<void> {
    // System projection rollup — resolves the media_items linked to a
    // physical file for internal quality-projection maintenance; no
    // per-user access scoping applies (mirrors refreshLanguagesForFile).
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    const items = await sql<{ media_item_id: string; media_type: string }[]>`
        SELECT mfi.media_item_id, mi.media_type
        FROM media_file_items mfi
        JOIN media_items mi ON mi.id = mfi.media_item_id
        WHERE mfi.file_id = ${fileId}
    `;
    const seriesIds = new Set<string>();
    for (const item of items) {
        await refreshItemQuality(sql, item.media_item_id);
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
        await refreshSeriesQuality(sql, seriesId);
    }
}

/**
 * Set-based rebuild of the whole projection: movie/episode rows from their
 * best video stream, then tv series rows from their episodes' best tier.
 * Idempotent — safe to run as a one-off backfill or periodic repair.
 */
export async function rebuildAllQuality(sql: postgres.Sql): Promise<void> {
    // System projection rollup — internal quality-projection maintenance
    // over all movie/episode media_items; no per-user access scoping
    // applies (mirrors rebuildAllItemLanguages). Also intentionally omits
    // a literal has_files filter — coverage is implicitly scoped to items
    // that actually have a probed video stream via the media_streams/
    // media_file_items join below, so a ghost catalog row with no files
    // can never produce a row here.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status
    await sql`
        DELETE FROM media_item_quality
        WHERE media_item_id IN (SELECT id FROM media_items WHERE media_type IN ('movie', 'episode'))
    `;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status
    await sql`
        INSERT INTO media_item_quality (
            media_item_id, resolution_tier, hdr_tier, hdr_type, codec,
            has_atmos, has_cc, has_sdh, has_ad, has_audio, has_subtitle
        )
        WITH streams AS (
            SELECT
                mfi.media_item_id,
                quality_resolution_tier(ms.height) AS resolution_tier,
                quality_hdr_type(ms.video_range_type, ms.video_range) AS hdr_type,
                quality_codec(ms.codec) AS codec,
                ms.height,
                CASE quality_resolution_tier(ms.height)
                    WHEN '4K' THEN 4 WHEN '1080p' THEN 3 WHEN '720p' THEN 2 WHEN 'SD' THEN 1 ELSE 0
                END AS res_rank,
                quality_hdr_rank(quality_hdr_type(ms.video_range_type, ms.video_range)) AS hdr_rank
            FROM media_streams ms
            JOIN media_file_items mfi ON mfi.file_id = ms.file_id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mi.media_type IN ('movie', 'episode')
              AND ms.stream_type = 'video'
        ),
        best_res AS (
            SELECT DISTINCT ON (media_item_id) media_item_id, resolution_tier, codec
            FROM streams
            ORDER BY media_item_id, res_rank DESC, height DESC NULLS LAST
        ),
        best_hdr AS (
            SELECT DISTINCT ON (media_item_id) media_item_id, hdr_type
            FROM streams
            WHERE hdr_rank > 0
            ORDER BY media_item_id, hdr_rank DESC
        ),
        -- Union across ALL stream types per item (not just video) — mirrors the
        -- flags CTE in refreshItemQuality.
        flags AS (
            SELECT
                mfi.media_item_id,
                bool_or(ms.stream_type = 'audio') AS has_audio,
                bool_or(ms.stream_type = 'subtitle') AS has_sub_stream,
                bool_or(ms.stream_type = 'video' AND ms.has_closed_captions) AS has_cc,
                bool_or(ms.stream_type = 'subtitle' AND ms.is_hearing_impaired) AS has_sdh_stream,
                bool_or(ms.stream_type = 'audio' AND ms.is_visual_impaired) AS has_ad,
                bool_or(
                    ms.stream_type = 'audio'
                    AND quality_is_atmos(ms.profile, ms.codec, ms.channels)
                ) AS has_atmos
            FROM media_streams ms
            JOIN media_file_items mfi ON mfi.file_id = ms.file_id
            JOIN media_items mi ON mi.id = mfi.media_item_id
            WHERE mi.media_type IN ('movie', 'episode')
            GROUP BY mfi.media_item_id
        ),
        sidecars AS (
            SELECT
                mfi.media_item_id,
                count(*) > 0 AS has_sidecar,
                bool_or(esf.is_sdh) AS has_sdh_sidecar
            FROM external_subtitle_files esf
            JOIN media_file_items mfi ON mfi.file_id = esf.file_id
            GROUP BY mfi.media_item_id
        )
        SELECT br.media_item_id, br.resolution_tier,
               quality_hdr_tier_from_type(bh.hdr_type), bh.hdr_type, br.codec,
               COALESCE(f.has_atmos, false),
               COALESCE(f.has_cc, false),
               COALESCE(f.has_sdh_stream, false) OR COALESCE(sc.has_sdh_sidecar, false),
               COALESCE(f.has_ad, false),
               COALESCE(f.has_audio, false),
               COALESCE(f.has_sub_stream, false) OR COALESCE(sc.has_sidecar, false)
        FROM best_res br
        LEFT JOIN best_hdr bh ON bh.media_item_id = br.media_item_id
        LEFT JOIN flags f ON f.media_item_id = br.media_item_id
        LEFT JOIN sidecars sc ON sc.media_item_id = br.media_item_id
        WHERE br.resolution_tier IS NOT NULL
        ON CONFLICT (media_item_id) DO UPDATE SET
            resolution_tier = EXCLUDED.resolution_tier,
            hdr_tier = EXCLUDED.hdr_tier,
            hdr_type = EXCLUDED.hdr_type,
            codec = EXCLUDED.codec,
            has_atmos = EXCLUDED.has_atmos,
            has_cc = EXCLUDED.has_cc,
            has_sdh = EXCLUDED.has_sdh,
            has_ad = EXCLUDED.has_ad,
            has_audio = EXCLUDED.has_audio,
            has_subtitle = EXCLUDED.has_subtitle
    `;

    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await sql`
        DELETE FROM media_item_quality
        WHERE media_item_id IN (SELECT id FROM media_items WHERE media_type = 'tv')
    `;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    await sql`
        INSERT INTO media_item_quality (
            media_item_id, resolution_tier, hdr_tier, hdr_type, codec,
            has_atmos, has_cc, has_sdh, has_ad, has_audio, has_subtitle
        )
        WITH ep_series AS (
            SELECT ep.id AS ep_id,
                   COALESCE(parent.parent_id, ep.parent_id) AS series_id
            FROM media_items ep
            LEFT JOIN media_items parent ON parent.id = ep.parent_id
            WHERE ep.media_type = 'episode'
        ),
        ep_quality AS (
            SELECT
                es.series_id,
                miq.resolution_tier,
                miq.hdr_type,
                miq.codec,
                miq.has_atmos, miq.has_cc, miq.has_sdh, miq.has_ad,
                miq.has_audio, miq.has_subtitle,
                CASE miq.resolution_tier
                    WHEN '4K' THEN 4 WHEN '1080p' THEN 3 WHEN '720p' THEN 2 WHEN 'SD' THEN 1 ELSE 0
                END AS res_rank,
                quality_hdr_rank(miq.hdr_type) AS hdr_rank
            FROM media_item_quality miq
            JOIN ep_series es ON es.ep_id = miq.media_item_id
            WHERE es.series_id IS NOT NULL
        ),
        best_res AS (
            SELECT DISTINCT ON (series_id) series_id, resolution_tier, codec
            FROM ep_quality
            ORDER BY series_id, res_rank DESC
        ),
        best_hdr AS (
            SELECT DISTINCT ON (series_id) series_id, hdr_type
            FROM ep_quality
            WHERE hdr_rank > 0
            ORDER BY series_id, hdr_rank DESC
        ),
        -- Strict majority per series, per-kind denominators. See the equivalent
        -- block in refreshSeriesQuality for the full rationale.
        ep_flags AS (
            SELECT
                series_id,
                count(*) AS n_rows,
                count(*) FILTER (WHERE has_audio) AS n_audio,
                count(*) FILTER (WHERE has_subtitle) AS n_sub,
                count(*) FILTER (WHERE has_cc) AS n_cc,
                count(*) FILTER (WHERE has_sdh) AS n_sdh,
                count(*) FILTER (WHERE has_ad) AS n_ad,
                bool_or(has_atmos) AS has_atmos,
                bool_or(has_audio) AS has_audio,
                bool_or(has_subtitle) AS has_subtitle
            FROM ep_quality
            GROUP BY series_id
        )
        SELECT br.series_id, br.resolution_tier,
               quality_hdr_tier_from_type(bh.hdr_type), bh.hdr_type, br.codec,
               COALESCE(ef.has_atmos, false),
               COALESCE(ef.n_cc * 2 > ef.n_rows, false),
               COALESCE(ef.n_sdh * 2 > ef.n_sub, false),
               COALESCE(ef.n_ad * 2 > ef.n_audio, false),
               COALESCE(ef.has_audio, false),
               COALESCE(ef.has_subtitle, false)
        FROM best_res br
        LEFT JOIN best_hdr bh ON bh.series_id = br.series_id
        LEFT JOIN ep_flags ef ON ef.series_id = br.series_id
        JOIN media_items s ON s.id = br.series_id AND s.media_type = 'tv'
        WHERE br.resolution_tier IS NOT NULL
        ON CONFLICT (media_item_id) DO UPDATE SET
            resolution_tier = EXCLUDED.resolution_tier,
            hdr_tier = EXCLUDED.hdr_tier,
            hdr_type = EXCLUDED.hdr_type,
            codec = EXCLUDED.codec,
            has_atmos = EXCLUDED.has_atmos,
            has_cc = EXCLUDED.has_cc,
            has_sdh = EXCLUDED.has_sdh,
            has_ad = EXCLUDED.has_ad,
            has_audio = EXCLUDED.has_audio,
            has_subtitle = EXCLUDED.has_subtitle
    `;
}
