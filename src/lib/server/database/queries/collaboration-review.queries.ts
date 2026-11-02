// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';

export interface CollaborationArtistRow {
    id: string;
    version: string;
    title: string;
    library_group_id: string | null;
    custom_metadata: Record<string, unknown>;
    metadata_locked: boolean;
    is_dismissed: boolean;
    status: string;
    canonical_id: string | null;
    has_mbid: boolean;
}

export interface CollaborationTrackRow {
    id: string;
    title: string | null;
    album_id: string | null;
    album_title: string | null;
    album_artist_id: string | null;
    album_artist_title: string | null;
    metadata_locked: boolean;
    is_dismissed: boolean;
    custom_metadata: Record<string, unknown>;
    file_count: number;
}

function collaborationTrackReferencePredicate(
    sql: postgres.Sql,
    trackAlias: string,
    artistExpr: postgres.PendingQuery<postgres.Row[]>,
): postgres.PendingQuery<postgres.Row[]> {
    const t = sql(trackAlias);
    return sql`(
        ${t}.custom_metadata->'additional_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'file_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'album_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'remixer_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'title_remixer_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'independent_remixer_artist_ids' @> jsonb_build_array(${artistExpr}::text)
        OR ${t}.custom_metadata->'track_artist_credits' @> jsonb_build_array(jsonb_build_object('id', ${artistExpr}::text))
        OR ${t}.custom_metadata->'track_remixer_credits' @> jsonb_build_array(jsonb_build_object('id', ${artistExpr}::text))
    )`;
}

/** A review reads one artist and at most 200 candidate canonical tracks. */
export async function getCollaborationArtist(
    sql: postgres.Sql,
    artistId: string,
): Promise<CollaborationArtistRow | undefined> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin review selects an exact UUID
    const [row] = await sql<CollaborationArtistRow[]>`
        SELECT id,xmin::text AS version,title,library_group_id,COALESCE(custom_metadata,'{}'::jsonb) AS custom_metadata,
            metadata_locked,is_dismissed,status,canonical_id,
            EXISTS (SELECT 1 FROM external_ids ei WHERE ei.media_id=media_items.id
                AND ei.provider='musicbrainz' AND ei.external_id<>'') AS has_mbid
        FROM media_items WHERE id=${artistId} AND media_type='artist' AND parent_id IS NULL`;
    return row;
}

export async function listCollaborationTracks(
    sql: postgres.Sql,
    artistId: string,
): Promise<{ tracks: CollaborationTrackRow[]; overflow: boolean }> {
    const trackReference = collaborationTrackReferencePredicate(sql, 't', sql`${artistId}`);
    // Both the album-owner path and the explicit credit path matter. A track
    // beyond the bound is reported as overflow, never silently ignored.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact admin-selected artist and bounded result
    const rows = await sql<CollaborationTrackRow[]>`
        SELECT t.id,t.title,a.id AS album_id,a.title AS album_title,
            owner.id AS album_artist_id,owner.title AS album_artist_title,
            t.metadata_locked,t.is_dismissed,COALESCE(t.custom_metadata,'{}'::jsonb) AS custom_metadata,
            (SELECT COUNT(*)::int FROM media_file_items mfi WHERE mfi.media_item_id=t.id) AS file_count
        FROM media_items t
        LEFT JOIN media_items a ON a.id=t.parent_id AND a.media_type='album'
        LEFT JOIN media_items owner ON owner.id=a.parent_id AND owner.media_type='artist'
        WHERE t.media_type='track' AND t.status='active' AND t.canonical_id IS NULL
          AND (a.parent_id=${artistId} OR ${trackReference})
        ORDER BY a.title NULLS LAST,t.title NULLS LAST,t.id
        LIMIT 201`;
    return { tracks: rows.slice(0, 200), overflow: rows.length > 200 };
}

/** Exact source tags used as independent witnesses, ordered for stable previews. */
export async function listCollaborationWitnessTags(sql: postgres.Sql): Promise<string[]> {
    // Match the resolver's scalar and array source-tag universe. The CASE
    // protects malformed legacy JSON from the set-returning function.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only evidence read
    const rows = await sql<{ tag: string }[]>`
        SELECT DISTINCT tag FROM (
            SELECT custom_metadata->>'artist' AS tag FROM media_items
                WHERE media_type='track' AND status='active'
            UNION ALL
            SELECT custom_metadata->>'album_artist' FROM media_items
                WHERE media_type='track' AND status='active'
            UNION ALL
            SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(custom_metadata->'artists')='array'
                THEN custom_metadata->'artists' ELSE '[]'::jsonb END) FROM media_items
                WHERE media_type='track' AND status='active'
            UNION ALL
            SELECT jsonb_array_elements_text(CASE WHEN jsonb_typeof(custom_metadata->'album_artists')='array'
                THEN custom_metadata->'album_artists' ELSE '[]'::jsonb END) FROM media_items
                WHERE media_type='track' AND status='active'
        ) sources WHERE tag IS NOT NULL AND tag<>'' ORDER BY tag`;
    return rows.map((row) => row.tag);
}

/**
 * Exact fingerprints for a set of artists. Membership is a UNION: an owned and
 * explicitly credited track contributes once. Only credit/tag input, membership and protection reopen optional cleanup.
 * Unrelated artwork, title, enrichment and probe writes do not invalidate it.
 */
export function collaborationFingerprintsSql(
    sql: postgres.Sql,
    artists: postgres.PendingQuery<postgres.Row[]>,
    singleArtist: boolean = false,
    legacyRevisions: boolean = false,
): postgres.PendingQuery<postgres.Row[]> {
    const reference = collaborationTrackReferencePredicate(sql, 't', sql`a.id`);
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin-only fingerprint of the exact artist supplied by the review caller
    const singleArtistSource = sql`artists a JOIN media_items t
        ON t.custom_metadata <> '{}'::jsonb
        AND t.custom_metadata @? ('strict $.** ? (@ == "' || a.id::text || '")')::jsonpath`;
    // Legacy projection is used only to carry forward still-current reviewed dispositions on upgrade.
    const fileValue = legacyRevisions
        ? sql`mfi.file_id::text || ':' || mfi.xmin::text || ':' || mf.xmin::text`
        : sql`jsonb_build_array(mfi.file_id,mf.file_mtime,mf.file_size_bytes,mf.file_hash_head)::text`;
    const trackValue = legacyRevisions
        ? sql`t.xmin::text`
        : sql`jsonb_build_array(t.parent_id,t.metadata_locked,t.is_dismissed,
        (SELECT jsonb_object_agg(key,value) FROM jsonb_each(CASE WHEN jsonb_typeof(t.custom_metadata)='object'
            THEN t.custom_metadata ELSE '{}'::jsonb END)
         WHERE key IN ('artist','artists','album_artist','album_artists','raw_artist_tags','remixer',
            'musicbrainz_artist_ids','artist_credit_source','track_artist_credits','track_remixer_credits',
            'additional_artist_ids','file_artist_ids','album_artist_ids','remixer_artist_ids',
            'title_remixer_artist_ids','independent_remixer_artist_ids')))::text`;
    const albumValue = legacyRevisions
        ? sql`album.id::text || ':' || album.xmin::text`
        : sql`album.id::text`;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin/scanner fingerprint; artist scope is supplied by the caller
    return sql`
        WITH artists AS MATERIALIZED (${artists}),
        credit_tracks AS ${singleArtist ? sql`MATERIALIZED` : sql`NOT MATERIALIZED`} (
            -- Fence the single-artist predicate before expanding any JSON. The
            -- batch path stays inline so it keeps its one library-wide scan.
            -- The indexed recursive string lookup is a superset; the original
            -- containment predicate still decides exact credit membership.
            SELECT t.id, t.custom_metadata
            FROM ${singleArtist ? singleArtistSource : sql`media_items t`}
            WHERE t.media_type='track' AND t.status='active' AND t.canonical_id IS NULL
              AND ${singleArtist ? reference : sql`TRUE`}
        ),
        credit_ids AS MATERIALIZED (
            -- Expand track JSON once for the whole batch. Recursive strings are
            -- a superset of containment (including malformed nested arrays);
            -- the original predicate below verifies every possible membership.
            SELECT DISTINCT t.id AS track_id, value #>> '{}' AS artist_id
            FROM credit_tracks t
            CROSS JOIN LATERAL jsonb_each(
                CASE WHEN jsonb_typeof(t.custom_metadata)='object'
                     THEN t.custom_metadata ELSE '{}'::jsonb END
            ) credit(key, metadata)
            CROSS JOIN LATERAL jsonb_path_query(credit.metadata,
                'strict $.** ? (@.type() == "string")') value
            WHERE credit.key IN ('additional_artist_ids','file_artist_ids','album_artist_ids',
                'remixer_artist_ids','title_remixer_artist_ids','independent_remixer_artist_ids',
                'track_artist_credits','track_remixer_credits')
        ),
        membership AS MATERIALIZED (
            SELECT a.id AS artist_id, t.id AS track_id
            FROM artists a
            JOIN media_items album ON album.parent_id=a.id AND album.media_type='album'
            JOIN media_items t ON t.parent_id=album.id
            WHERE t.media_type='track' AND t.status='active' AND t.canonical_id IS NULL
            UNION
            SELECT a.id, t.id
            FROM artists a JOIN credit_ids credit ON credit.artist_id=a.id::text
            JOIN media_items t ON t.id=credit.track_id
            WHERE ${reference}
        ),
        files AS MATERIALIZED (
            SELECT mfi.media_item_id,
                string_agg(${fileValue},
                    ',' ORDER BY mfi.file_id) AS value
            FROM (SELECT DISTINCT track_id FROM membership) tracks
            JOIN media_file_items mfi ON mfi.media_item_id=tracks.track_id
            JOIN media_files mf ON mf.id=mfi.file_id
            GROUP BY mfi.media_item_id
        ),
        tracks AS (
            SELECT m.artist_id, string_agg(
                t.id::text || ':' || ${trackValue} || ':' || COALESCE(owner.id::text,'') || ':' ||
                COALESCE(files.value,''), '|' ORDER BY t.id) AS value
            FROM membership m JOIN media_items t ON t.id=m.track_id
            LEFT JOIN media_items album ON album.id=t.parent_id AND album.media_type='album'
            LEFT JOIN media_items owner ON owner.id=album.parent_id AND owner.media_type='artist'
            LEFT JOIN files ON files.media_item_id=t.id
            GROUP BY m.artist_id
        ),
        albums AS (
            SELECT album.parent_id AS artist_id,
                string_agg(${albumValue}, '|' ORDER BY album.id) AS value
            FROM artists a JOIN media_items album ON album.parent_id=a.id AND album.media_type='album'
            GROUP BY album.parent_id
        ),
        ids AS (
            SELECT ei.media_id AS artist_id,
                string_agg(ei.provider || ':' || ei.external_id, '|' ORDER BY ei.provider,ei.external_id) AS value
            FROM artists a JOIN external_ids ei ON ei.media_id=a.id GROUP BY ei.media_id
        )
        SELECT a.id, a.custom_metadata->>'collaboration_reviewed' AS reviewed,
            md5(COALESCE(a.title,'') || ':' ||
                COALESCE(a.custom_metadata->>'no_split','') || ':' ||
                COALESCE(a.custom_metadata->>'musicbrainz_artist_id','') || ':' ||
                COALESCE(ids.value,'') || ':' || COALESCE(albums.value,'') || ':' ||
                COALESCE(tracks.value,'')) AS fingerprint
        FROM artists a
        LEFT JOIN ids ON ids.artist_id=a.id
        LEFT JOIN albums ON albums.artist_id=a.id
        LEFT JOIN tracks ON tracks.artist_id=a.id
    `;
}

/** Fresh single-artist validation is also used inside the approval transaction. */
export function collaborationFingerprintSql(
    sql: postgres.Sql,
    alias: string,
): postgres.PendingQuery<postgres.Row[]> {
    const a = sql(alias);
    return sql`(SELECT fingerprint FROM (${collaborationFingerprintsSql(
        sql,
        sql`SELECT ${a}.id, ${a}.title, ${a}.custom_metadata`,
        true,
    )}) fingerprints)`;
}

/** Unreviewed artists need no fingerprint; reviewed queue rows share one batch. */
export function collaborationNeedsReviewSql(
    sql: postgres.Sql,
    alias: string,
): postgres.PendingQuery<postgres.Row[]> {
    const a = sql(alias);
    // Keep this set independent of the outer row: IN becomes one hashed
    // subplan, rather than repeating the library scan for each artist.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- admin/scanner reviewed-artist queue, no user-facing catalog rows
    const artists = sql`SELECT id,title,custom_metadata FROM media_items
        WHERE media_type='artist'
          AND COALESCE(custom_metadata->>'collaboration_reviewed','') <> ''`;
    return sql`CASE
        WHEN COALESCE(${a}.custom_metadata->>'collaboration_reviewed', '') = '' THEN TRUE
        ELSE ${a}.id IN (
            SELECT id FROM (${collaborationFingerprintsSql(sql, artists)}) fingerprints
            WHERE reviewed <> fingerprint
        )
    END`;
}

export async function getCollaborationFingerprint(
    sql: postgres.Sql,
    artistId: string,
): Promise<string | undefined> {
    const fingerprint = collaborationFingerprintSql(sql, 'mi');
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- exact admin-selected artist UUID
    const [row] = await sql<{ fingerprint: string }[]>`
        SELECT ${fingerprint} AS fingerprint FROM media_items mi
        WHERE mi.id=${artistId} AND mi.media_type='artist' AND mi.status='active'`;
    return row?.fingerprint;
}

export async function setCollaborationReviewed(
    sql: postgres.Sql,
    artistId: string,
    fingerprint: string | null,
): Promise<boolean> {
    const result = fingerprint
        ? await sql`
            UPDATE media_items SET custom_metadata=COALESCE(custom_metadata,'{}'::jsonb)
                || ${sql.json({ collaboration_reviewed: fingerprint })}
            WHERE id=${artistId} AND media_type='artist' AND status='active'`
        : await sql`
            UPDATE media_items SET custom_metadata=COALESCE(custom_metadata,'{}'::jsonb)
                - 'collaboration_reviewed'
            WHERE id=${artistId} AND media_type='artist' AND status='active'`;
    return result.count > 0;
}

/** Carry forward exactly current old fingerprints. Stale/unknown dispositions are never certified. */
export async function upgradeReviewedCollaborationFingerprints(sql: postgres.Sql): Promise<void> {
    // eslint-disable-next-line callback-safety/no-unscoped-media-items -- migration of existing dispositions only; no artist or track metadata is reviewed or changed
    const artists = sql`SELECT id,title,custom_metadata FROM media_items WHERE media_type='artist'
        AND COALESCE(custom_metadata->>'collaboration_reviewed','')<>''`;
    const legacy = collaborationFingerprintsSql(sql, artists, false, true);
    const current = collaborationFingerprintsSql(sql, artists);
    await sql`WITH legacy AS MATERIALIZED (${legacy}),current AS MATERIALIZED (${current})
        UPDATE media_items a SET custom_metadata=a.custom_metadata || jsonb_build_object('collaboration_reviewed',current.fingerprint)
        FROM legacy JOIN current USING(id) WHERE a.id=legacy.id AND legacy.reviewed=legacy.fingerprint
            AND a.custom_metadata->>'collaboration_reviewed'=legacy.reviewed`;
}
