// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unavailable-media retention: remove catalog rows whose local media has been
 * continuously gone for the configured window (30 days by default).
 *
 * A retention UNIT is a root plus every row the root owns:
 *   - track      — the track alone (leaf; no children allowed)
 *   - album      — the album alone (leaf; deleted once it is childless)
 *   - movie      — the movie and its extras
 *   - series     — the series with its seasons, episodes and extras
 *   - audiobook  — the book alone (leaf)
 *
 * Every member must be provably file-less and unreferenced; one protected
 * member keeps the whole unit. Admin-only maintenance: these queries consider
 * every library and never serve user browse results.
 */

import type postgres from 'postgres';
import { UNAVAILABLE_MEDIA_RETENTION_DAYS } from '$lib/server/config.js';

export { UNAVAILABLE_MEDIA_RETENTION_DAYS as MEDIA_RETENTION_DAYS } from '$lib/server/config.js';
export const RETENTION_SCAN_MAX_AGE_DAYS = 7;
export const RETENTION_UNIT_MAX_ROWS = 5000;
const RETENTION_MAX_DEPTH = 64;

export const RETENTION_KINDS = ['track', 'album', 'movie', 'series', 'audiobook'] as const;
export type RetentionKind = (typeof RETENTION_KINDS)[number];

/** `library_paths.media_type` values whose paths may own a unit of each filesystem kind. */
export const RETENTION_PATH_MEDIA_TYPES: Record<Exclude<RetentionKind, 'audiobook'>, string[]> = {
    track: ['music'],
    album: ['music'],
    movie: ['movie', 'anime'],
    series: ['tv', 'anime'],
};

/** Group keys per kind: library_group_id for filesystem kinds, library_paths.id for audiobooks. */
export type RetentionGroupKeys = Partial<Record<RetentionKind, string[]>>;

/** Media types covered by this policy, including unit members that are never roots. */
export const RETENTION_COVERED_MEDIA_TYPES = [
    'track',
    'album',
    'movie',
    'tv',
    'season',
    'episode',
    'extra',
    'audiobook',
] as const;

type Fragment = postgres.PendingQuery<postgres.Row[]>;

function retentionCutoff(sql: postgres.Sql): Fragment {
    return sql`(NOW() - make_interval(days => ${UNAVAILABLE_MEDIA_RETENTION_DAYS}::int))`;
}

/**
 * Rows of `alias` that once had local media: a loss clock, a first-add stamp,
 * or the content hash a scanner dismissal records. Never-owned discovery and
 * skeleton rows carry none of these.
 */
export function formerlyAvailableSql(sql: postgres.Sql, alias: string): Fragment {
    return sql`(${sql(alias)}.files_lost_at IS NOT NULL
        OR ${sql(alias)}.library_added_at IS NOT NULL
        OR ${sql(alias)}.dismissed_content_hash IS NOT NULL)`;
}

/**
 * No user, history, curation or delivery row references `alias`.id. FK and
 * no-FK references alike: deleting would cascade, null or orphan them.
 * Polymorphic text targets compare dashless and case-folded so legacy UUID
 * spellings still count.
 */
export function mediaReferenceGuard(sql: postgres.Sql, alias: string): Fragment {
    const a = sql(alias);
    return sql`(
        NOT EXISTS (SELECT 1 FROM user_ratings r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM user_suggestions r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM training_assignments r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM course_modules r WHERE r.media_item_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM courses r WHERE r.cover_media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM upload_sessions r WHERE r.media_item_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM playback_incident_events r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM transcode_failure_events r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM media_artwork_suppressions r WHERE r.media_item_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM music_edit_receipts r WHERE r.target_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM music_edit_receipts r WHERE r.undone_at IS NULL AND r.reference_ids @> ARRAY[${a}.id])
        AND NOT EXISTS (SELECT 1 FROM personal_media_dispositions r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM playlist_items r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM user_media_state r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM user_media_events r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM user_media_events_archive r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM user_rate_skips r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM user_taste_dampers r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM user_media_share_opt_out r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM media_annotations r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM watch_history r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM watch_state_pending_resolution r WHERE r.internal_media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM watchlist_activities r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM play_sessions r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM watch_state_sync_log r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM watch_sync_activity r WHERE r.media_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM user_music_state r WHERE r.track_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM music_listen_events r WHERE r.track_id = ${a}.id)
        AND NOT EXISTS (SELECT 1 FROM library_availability r WHERE r.media_id = ${a}.id AND r.available = true)
        AND NOT EXISTS (SELECT 1 FROM series_episode_ordering r WHERE r.media_id = ${a}.id AND COALESCE(r.ordering_source, 'manual') <> 'auto')
        AND NOT EXISTS (SELECT 1 FROM interactions r WHERE r.target_type = 'media' AND lower(replace(r.target_id, '-', '')) = replace(${a}.id::text, '-', ''))
        AND NOT EXISTS (SELECT 1 FROM interaction_reactions r WHERE r.target_type = 'media' AND lower(replace(r.target_id, '-', '')) = replace(${a}.id::text, '-', ''))
        AND NOT EXISTS (SELECT 1 FROM user_media_flags r WHERE lower(replace(r.target_id, '-', '')) = replace(${a}.id::text, '-', ''))
    )`;
}

/**
 * `alias` carries no operator curation: unlocked metadata, no admin-picked
 * artwork, and no custom image URL other than the automatic local-art mirror
 * (those are derived; a direct custom URL is user-owned). Deleting such a row
 * would destroy the operator's work, so retention and album merges keep it.
 */
export function noOperatorCurationSql(sql: postgres.Sql, alias: string): Fragment {
    const a = sql(alias);
    return sql`(
        ${a}.metadata_locked = false
        AND (${a}.custom_poster_url IS NULL OR ${a}.custom_poster_url = '/api/image/custom/' || ${a}.id::text || '/poster')
        AND (${a}.custom_backdrop_url IS NULL OR ${a}.custom_backdrop_url = '/api/image/custom/' || ${a}.id::text || '/backdrop')
        AND (${a}.custom_logo_url IS NULL OR ${a}.custom_logo_url = '/api/image/custom/' || ${a}.id::text || '/logo')
        AND (${a}.custom_thumb_url IS NULL OR ${a}.custom_thumb_url = '/api/image/custom/' || ${a}.id::text || '/thumb')
        AND NOT EXISTS (SELECT 1 FROM image_candidates aw WHERE aw.media_item_id = ${a}.id AND (aw.remote_url LIKE 'admin:%' OR aw.chosen_by <> 'auto'))
    )`;
}

/**
 * Per-member proof for a retention unit: file-less, loss clock (if any) at
 * least the configured retention age, no operator curation, no inbound alias and no reference.
 * Scanner/ABS dismissals carry `dismissed_at`; an operator dismissal does not
 * and protects the row.
 */
function retentionMemberOk(sql: postgres.Sql, classifiedReferences: Fragment): Fragment {
    // Admin-only maintenance predicate; never serves user browse results.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql`
        m.status IN ('active', 'deleted')
        AND m.has_files = false
        AND NOT (m.is_dismissed AND m.dismissed_at IS NULL)
        AND (m.files_lost_at IS NULL OR m.files_lost_at <= ${retentionCutoff(sql)})
        AND ${noOperatorCurationSql(sql, 'm')}
        AND NOT EXISTS (
            SELECT 1 FROM media_file_items f
            JOIN media_files mf ON mf.id = f.file_id
            WHERE f.media_item_id = m.id
              AND (m.media_type <> 'track' OR NOT mf.is_missing)
        )
        AND NOT EXISTS (SELECT 1 FROM media_items alias WHERE alias.canonical_id = m.id)
        AND ${mediaReferenceGuard(sql, 'm')}
        AND ${classifiedReferences}
    `;
}

/**
 * Root clock for filesystem kinds: lost for the configured window, or an unknown loss age
 * with removal evidence on a row older than the creation grace window.
 */
function filesystemRootClock(sql: postgres.Sql): Fragment {
    return sql`
        mi.status IN ('active', 'deleted')
        AND mi.has_files = false
        AND (
            mi.files_lost_at <= ${retentionCutoff(sql)}
            OR (
                mi.files_lost_at IS NULL
                AND (mi.library_added_at IS NOT NULL OR mi.dismissed_content_hash IS NOT NULL)
                AND mi.created_at < NOW() - INTERVAL '30 minutes'
            )
        )
    `;
}

export type RetentionClockMode = 'any' | 'eligible' | 'unknown';

interface RootFilter {
    keys?: string[] | null;
    rootId?: string;
    mode?: RetentionClockMode;
}

function rootFilter(sql: postgres.Sql, group: Fragment, filter: RootFilter): Fragment {
    const keys = filter.keys ? sql`AND ${group} = ANY(${filter.keys}::text[])` : sql``;
    const root = filter.rootId ? sql`AND mi.id = ${filter.rootId}::uuid` : sql``;
    return sql`${keys} ${root}`;
}

/** Root rows of one kind as (id, kind, group_key, clock). Admin-only maintenance selection. */
function kindRootsSql(sql: postgres.Sql, kind: RetentionKind, filter: RootFilter): Fragment {
    const mode = filter.mode ?? 'any';
    if (kind === 'audiobook') {
        // ABS rows: the sweep's absent-upstream dismissal time is the loss clock.
        const group = sql`NULLIF(mi.custom_metadata #>> '{audiobookshelf,libraryPathId}', '')`;
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        return sql`
            SELECT mi.id, 'audiobook'::text AS kind, ${group} AS group_key, mi.dismissed_at AS clock
            FROM media_items mi
            WHERE mi.media_type = 'audiobook'
              AND mi.status IN ('active', 'deleted')
              AND mi.has_files = false
              AND mi.is_dismissed = true
              AND mi.dismissed_at <= ${retentionCutoff(sql)}
              ${rootFilter(sql, group, filter)}
        `;
    }
    const clockMode =
        mode === 'eligible'
            ? sql`AND mi.files_lost_at IS NOT NULL`
            : mode === 'unknown'
              ? sql`AND mi.files_lost_at IS NULL`
              : sql``;
    if (kind === 'track') {
        const group = sql`COALESCE(mi.library_group_id, album.library_group_id)::text`;
        // eslint-disable-next-line callback-safety/no-unscoped-media-items
        return sql`
            SELECT mi.id, 'track'::text AS kind, ${group} AS group_key, mi.files_lost_at AS clock
            FROM media_items mi
            LEFT JOIN media_items album ON album.id = mi.parent_id AND album.media_type = 'album'
            WHERE mi.media_type = 'track'
              AND ${filesystemRootClock(sql)}
              ${clockMode}
              ${rootFilter(sql, group, filter)}
        `;
    }
    const mediaType = kind === 'series' ? 'tv' : kind;
    const group = sql`mi.library_group_id::text`;
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql`
        SELECT mi.id, ${kind}::text AS kind, ${group} AS group_key, mi.files_lost_at AS clock
        FROM media_items mi
        WHERE mi.media_type = ${mediaType}
          AND ${filesystemRootClock(sql)}
          ${clockMode}
          ${rootFilter(sql, group, filter)}
    `;
}

function rootsUnionSql(
    sql: postgres.Sql,
    kinds: { kind: RetentionKind; keys: string[] | null }[],
    filter: Omit<RootFilter, 'keys'>,
): Fragment {
    return kinds
        .map(({ kind, keys }) => kindRootsSql(sql, kind, { ...filter, keys }))
        .reduce((acc, part) => sql`${acc} UNION ALL ${part}`);
}

export interface RetentionRootGroup {
    kind: RetentionKind;
    group_key: string | null;
    roots: number;
}

/**
 * Root-level potential candidates grouped by provenance, before any health or
 * reference evaluation. Tells the caller which library groups need a health
 * check and how many roots lack provenance.
 */
export async function findRetentionRootGroups(sql: postgres.Sql): Promise<RetentionRootGroup[]> {
    const roots = rootsUnionSql(
        sql,
        RETENTION_KINDS.map((kind) => ({ kind, keys: null })),
        {},
    );
    return sql<RetentionRootGroup[]>`
        SELECT r.kind, r.group_key, COUNT(*)::int AS roots
        FROM (${roots}) r
        GROUP BY r.kind, r.group_key
        ORDER BY r.kind, r.group_key NULLS FIRST
    `;
}

export interface RetentionUnitCandidate {
    id: string;
    kind: RetentionKind;
    group_key: string;
    /** Loss clock: files_lost_at, or dismissed_at for audiobooks. NULL = unknown age. */
    files_lost_at: Date | null;
}

export interface RetentionKindSummary {
    kind: RetentionKind;
    /** Within-cap units that pass every member and shape guard. */
    ready: number;
    /** Leaf roots that still have children, or roots owning unexpected member types. */
    shape_blocked: number;
    /** Within-cap units with at least one referenced, curated, file-backed or too-recent member. */
    protected: number;
    /** Shape-valid units above the cap; member eligibility and references are unassessed. */
    oversized: number;
}

export interface RetentionUnitEvaluation {
    candidates: RetentionUnitCandidate[];
    summary: RetentionKindSummary[];
}

/**
 * Evaluate retention units whose root belongs to a healthy group and return
 * the first `limit` deletable/initializable roots (known clocks first) plus
 * per-kind counts. The full unit is walked over parent_id and checked for
 * shape. Member eligibility is assessed only when the complete unit fits the
 * row cap; an oversized unit is reported without calling it clean or protected.
 */
export async function evaluateRetentionUnits(
    sql: postgres.Sql,
    healthy: RetentionGroupKeys,
    limit: number,
    opts: { rootId?: string; mode?: RetentionClockMode; signal?: AbortSignal } = {},
): Promise<RetentionUnitEvaluation> {
    // Audiobook clocks are never unknown: a dismissal without a time is an operator's.
    const kinds = RETENTION_KINDS.filter(
        (k) => (healthy[k]?.length ?? 0) > 0 && !(k === 'audiobook' && opts.mode === 'unknown'),
    ).map((kind) => ({
        kind,
        keys: healthy[kind] ?? [],
    }));
    if (kinds.length === 0) return { candidates: [], summary: [] };
    const roots = rootsUnionSql(sql, kinds, { rootId: opts.rootId, mode: opts.mode });
    // Every kind uses the FK classification: a new protected reference must
    // protect video and audiobooks as well as music. The classifier also imports
    // the common retention guards. Resolve it at
    // call time, after module initialization, to avoid an initialization cycle.
    const { classifiedMediaReferenceGuard } = await import('./never-owned-media-gc.queries.js');
    const classifiedReferences = classifiedMediaReferenceGuard(sql, 'm', {
        missingTrackFiles: true,
    });
    // Admin-only maintenance over all libraries; file-less rows are the point.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items, callback-safety/require-has-files-with-active-status
    const query = sql<
        {
            row_type: 'candidate' | 'summary';
            id: string | null;
            kind: RetentionKind;
            group_key: string | null;
            clock: Date | null;
            ready: number | null;
            shape_blocked: number | null;
            protected: number | null;
            oversized: number | null;
        }[]
    >`
        WITH RECURSIVE roots AS MATERIALIZED (${roots}),
        -- The visited path makes a parent_id cycle terminate without repeating a member.
        unit(root_id, id, depth, path) AS (
            SELECT r.id, r.id, 0, ARRAY[r.id] FROM roots r
            UNION ALL
            SELECT u.root_id, c.id, u.depth + 1, u.path || c.id
            FROM unit u JOIN media_items c ON c.parent_id = u.id
            WHERE u.depth < ${RETENTION_MAX_DEPTH} AND c.id <> ALL(u.path)
        ),
        shape AS (
            SELECT u.root_id, COUNT(*)::int AS members,
                   bool_and(
                       (
                           u.depth = 0
                           OR (r.kind = 'movie' AND m.media_type = 'extra')
                           OR (r.kind = 'series' AND m.media_type IN ('season', 'episode', 'extra'))
                       )
                       -- A walk cut off at the depth cap with rows below it is never a
                       -- complete unit, so it can never be (partially) deleted.
                       AND CASE WHEN u.depth >= ${RETENTION_MAX_DEPTH}
                                THEN NOT EXISTS (SELECT 1 FROM media_items deeper
                                                 WHERE deeper.parent_id = u.id
                                                   AND deeper.id <> ALL(u.path))
                                ELSE true END
                   ) AS shape_ok
            FROM unit u
            JOIN roots r ON r.id = u.root_id
            JOIN media_items m ON m.id = u.id
            GROUP BY u.root_id
        ),
        clean AS (
            SELECT u.root_id,
                   COUNT(*) FILTER (WHERE CASE
                       WHEN s.shape_ok AND s.members <= ${RETENTION_UNIT_MAX_ROWS}
                       THEN ${retentionMemberOk(sql, classifiedReferences)}
                       ELSE false END)::int AS clean_members
            FROM unit u
            JOIN shape s ON s.root_id = u.root_id
            JOIN media_items m ON m.id = u.id
            GROUP BY u.root_id
        ),
        evaluated AS MATERIALIZED (
            SELECT r.id, r.kind, r.group_key, r.clock, s.members, s.shape_ok,
                   CASE WHEN s.members <= ${RETENTION_UNIT_MAX_ROWS}
                        THEN COALESCE(c.clean_members, 0) = s.members
                        ELSE NULL END AS clean
            FROM roots r
            JOIN shape s ON s.root_id = r.id
            LEFT JOIN clean c ON c.root_id = r.id
        )
        SELECT * FROM (
            SELECT 'candidate'::text AS row_type, e.id::text AS id, e.kind, e.group_key, e.clock,
                   NULL::int AS ready, NULL::int AS shape_blocked, NULL::int AS protected, NULL::int AS oversized
            FROM evaluated e
            WHERE e.shape_ok AND e.clean IS TRUE AND e.members <= ${RETENTION_UNIT_MAX_ROWS}
            ORDER BY e.clock NULLS LAST, e.id
            LIMIT ${limit}
        ) candidates
        UNION ALL
        SELECT 'summary'::text, NULL, e.kind, NULL, NULL,
               COUNT(*) FILTER (WHERE e.shape_ok AND e.clean IS TRUE AND e.members <= ${RETENTION_UNIT_MAX_ROWS})::int,
               COUNT(*) FILTER (WHERE NOT e.shape_ok)::int,
               COUNT(*) FILTER (WHERE e.shape_ok AND e.members <= ${RETENTION_UNIT_MAX_ROWS} AND e.clean IS FALSE)::int,
               COUNT(*) FILTER (WHERE e.shape_ok AND e.members > ${RETENTION_UNIT_MAX_ROWS})::int
        FROM evaluated e
        GROUP BY e.kind
    `;
    const cancel = (): void => {
        if (typeof query.cancel === 'function') query.cancel();
    };
    opts.signal?.throwIfAborted();
    opts.signal?.addEventListener('abort', cancel, { once: true });
    try {
        const rows = await query;
        opts.signal?.throwIfAborted();
        const candidates: RetentionUnitCandidate[] = [];
        const summary: RetentionKindSummary[] = [];
        for (const row of rows) {
            if (row.row_type === 'candidate' && row.id && row.group_key)
                candidates.push({
                    id: row.id,
                    kind: row.kind,
                    group_key: row.group_key,
                    files_lost_at: row.clock,
                });
            else if (row.row_type === 'summary')
                summary.push({
                    kind: row.kind,
                    ready: row.ready ?? 0,
                    shape_blocked: row.shape_blocked ?? 0,
                    protected: row.protected ?? 0,
                    oversized: row.oversized ?? 0,
                });
        }
        return { candidates, summary };
    } finally {
        opts.signal?.removeEventListener('abort', cancel);
    }
}

export interface RetentionUnitMember {
    id: string;
    depth: number;
    parent_id: string | null;
    /** The walk stopped at the depth cap while this row still has children. */
    truncated: boolean;
}

/** Current unit membership of a root (root at depth 0), bounded just past the size cap. */
export async function deriveRetentionUnit(
    sql: postgres.Sql,
    rootId: string,
): Promise<RetentionUnitMember[]> {
    // Admin-only retention maintenance; membership of one root.
    // eslint-disable-next-line callback-safety/no-unscoped-media-items
    return sql<RetentionUnitMember[]>`
        -- The visited path makes a parent_id cycle terminate without repeating a member.
        WITH RECURSIVE unit(id, depth, parent_id, path) AS (
            SELECT id, 0, parent_id, ARRAY[id] FROM media_items WHERE id = ${rootId}::uuid
            UNION ALL
            SELECT c.id, u.depth + 1, c.parent_id, u.path || c.id
            FROM unit u JOIN media_items c ON c.parent_id = u.id
            WHERE u.depth < ${RETENTION_MAX_DEPTH} AND c.id <> ALL(u.path)
        )
        SELECT u.id::text AS id, u.depth, u.parent_id::text AS parent_id,
               (u.depth >= ${RETENTION_MAX_DEPTH} AND EXISTS (
                   SELECT 1 FROM media_items deeper
                   WHERE deeper.parent_id = u.id AND deeper.id <> ALL(u.path)
               )) AS truncated
        FROM unit u
        LIMIT ${RETENTION_UNIT_MAX_ROWS + 1}
    `;
}

/** Start the grace period of an unknown-age root at NOW(); never backdated. */
export async function initializeRetentionClock(
    sql: postgres.Sql,
    rootId: string,
): Promise<boolean> {
    // Admin-only loss-age observation, under the retention service locks.
    const rows = await sql`
        UPDATE media_items SET files_lost_at = NOW()
        WHERE id = ${rootId}::uuid AND files_lost_at IS NULL AND has_files = false
        RETURNING id
    `;
    return rows.count === 1;
}

export interface LibraryPathScanEvidence {
    group_key: string;
    id: string;
    path: string;
    enabled: boolean;
    provider: string;
    media_type: string;
    state: string | null;
    completed_at: Date | null;
    started_at: Date | null;
    configured_at: Date;
    /** Unwrapped scan counters; NULL unless the stored envelope reports `success: true`. */
    result: unknown;
}

/**
 * Every path of the given library groups with its latest per-path
 * `file-library-scan` evidence. Any in-flight path/global scan fences
 * the affected library; otherwise use its latest terminal per-path result.
 * No-path inputs (including libraryGroupId-only) fan out globally. Open
 * scanner registrations also fence direct scans outside the task runner.
 * A completed global fan-out proves nothing about an individual path.
 */
export async function getLibraryGroupScanEvidence(
    sql: postgres.Sql,
    groupKeys: string[],
): Promise<LibraryPathScanEvidence[]> {
    if (groupKeys.length === 0) return [];
    return sql<LibraryPathScanEvidence[]>`
        SELECT p.library_group_id::text AS group_key, p.id::text AS id, p.path, p.enabled,
               p.provider, p.media_type, p.updated_at AS configured_at,
               CASE WHEN EXISTS (
                   SELECT 1 FROM file_scanner_runs r
                   WHERE r.completed_at IS NULL
                     AND (r.library_path_id IS NULL OR r.library_path_id = p.id)
               ) THEN 'active' ELSE h.state END AS state,
               h.started_at, h.completed_at, h.result
        FROM library_paths p
        LEFT JOIN LATERAL (
            -- The runner persists the FULL TaskResult envelope, not only plugin counts.
            -- Completed state alone is insufficient: unsuccessful/malformed envelopes fail closed.
            SELECT state, started_at, completed_at,
                   CASE WHEN result->'success' = 'true'::jsonb THEN result->'result' ELSE NULL END AS result
            FROM task_history
            WHERE task_id = 'file-library-scan' AND (
                input->>'libraryPathId' = p.id::text
                OR (state NOT IN ('completed', 'failed', 'cancelled')
                    AND COALESCE(input->>'libraryPathId', '') = '')
            )
            -- Any in-flight scan fences retention, even if another run finished later.
            ORDER BY (state NOT IN ('completed', 'failed', 'cancelled')) DESC,
                     started_at DESC, id DESC LIMIT 1
        ) h ON true
        WHERE p.library_group_id::text = ANY(${groupKeys}::text[])
        ORDER BY p.library_group_id, p.id
    `;
}

export interface AudiobookshelfSyncEvidence {
    id: string;
    enabled: boolean;
    provider: string;
    media_type: string;
    configured_at: Date;
    state: string | null;
    completed_at: Date | null;
    started_at: Date | null;
    /** Unwrapped sync counters; NULL unless the stored envelope reports `success: true`. */
    result: unknown;
}

/**
 * The named ABS library paths, each with its latest `audiobookshelf-sync` run
 * that covered it: a global run (no `libraryPathId`) or one scoped to that
 * path. An in-flight sync fences the path. A run scoped to another path proves
 * nothing about this one.
 */
export async function getAudiobookshelfSyncEvidence(
    sql: postgres.Sql,
    pathKeys: string[],
): Promise<AudiobookshelfSyncEvidence[]> {
    if (pathKeys.length === 0) return [];
    return sql<AudiobookshelfSyncEvidence[]>`
        SELECT p.id::text AS id, p.enabled, p.provider, p.media_type, p.updated_at AS configured_at,
               h.state, h.started_at, h.completed_at, h.result
        FROM library_paths p
        LEFT JOIN LATERAL (
            SELECT state, started_at, completed_at,
                   CASE WHEN result->'success' = 'true'::jsonb THEN result->'result' ELSE NULL END AS result
            FROM task_history
            WHERE task_id = 'audiobookshelf-sync'
              AND COALESCE(input->>'libraryPathId', '') IN ('', p.id::text)
            ORDER BY (state NOT IN ('completed', 'failed', 'cancelled')) DESC,
                     started_at DESC, id DESC LIMIT 1
        ) h ON true
        WHERE p.id::text = ANY(${pathKeys}::text[])
        ORDER BY p.id
    `;
}
