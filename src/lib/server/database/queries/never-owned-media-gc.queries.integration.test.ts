// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { withTx } from '$lib/server/database/with-tx.js';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    DISCOVERY_DETAIL_REFRESH_DAYS,
    evaluateNeverOwnedUnits,
    MEDIA_ITEM_FK_CLASSIFICATION,
    NEVER_OWNED_KEEP_RULES,
    NEVER_OWNED_UNIT_RULES,
    NO_FK_MEDIA_REFERENCES,
    DISCOVERY_SEEN_KEY,
    type NeverOwnedGcEvaluation,
} from './never-owned-media-gc.queries.js';
import { DISCOVERY_DETAIL_SYNCED_AT_KEY } from './ai-sync.queries.js';
import { DISCOVERY_DETAIL_REFRESH_DAYS as SWEEP_REFRESH_DAYS } from '$lib/server/ai/tmdb-metadata-sync.js';

vi.mock('$lib/server/services/media-lifecycle.service.js', () => ({
    MediaLifecycleService: { afterDeletedBatch: vi.fn(), afterDismissed: vi.fn() },
}));
import {
    deleteNeverOwnedUnit,
    evaluateNeverOwnedCatalog,
    runNeverOwnedMediaGc,
    type NeverOwnedGcResult,
} from '$lib/server/services/never-owned-media-gc.service.js';

const MIN_AGE = 30;
const rollback = new Error('rollback test fixtures');
let db: postgres.Sql;

interface Fx {
    sql: postgres.Sql;
    user: string;
}

async function inFixture(fn: (fx: Fx) => Promise<void>): Promise<void> {
    try {
        await db.begin(async (raw) => {
            const sql = raw as unknown as postgres.Sql;
            const user = crypto.randomUUID();
            await sql`INSERT INTO users (id, username) VALUES (${user}, ${user})`;
            await sql`INSERT INTO user_profiles (user_id) VALUES (${user})`;
            await fn({ sql, user });
            throw rollback;
        });
    } catch (error) {
        if (error !== rollback) throw error;
    }
}

interface ItemOpts {
    type: string;
    parent?: string | null;
    /** Age of created_at in days; default 40 (older than the 30-day minimum). */
    ageDays?: number;
    season?: number;
    episode?: number;
    extraType?: string;
    libraryGroup?: string | null;
}

async function item(sql: postgres.Sql, o: ItemOpts): Promise<string> {
    const id = crypto.randomUUID();
    await sql`
        INSERT INTO media_items (id, title, media_type, status, has_files, parent_id,
            season_number, episode_number, extra_type, library_group_id, created_at)
        VALUES (${id}, ${`${o.type} ${id}`}, ${o.type}, 'active', false, ${o.parent ?? null},
            ${o.season ?? null}, ${o.episode ?? null}, ${o.extraType ?? null},
            ${o.libraryGroup ?? null},
            NOW() - make_interval(days => ${o.ageDays ?? 40}::int))
    `;
    return id;
}

interface SeriesFx {
    root: string;
    seasons: string[];
    episodes: string[];
    extra: string;
}

async function series(sql: postgres.Sql, ageDays = 40): Promise<SeriesFx> {
    const root = await item(sql, { type: 'tv', ageDays });
    const seasons = [
        await item(sql, { type: 'season', parent: root, season: 1 }),
        await item(sql, { type: 'season', parent: root, season: 2 }),
    ];
    const episodes = [
        await item(sql, { type: 'episode', parent: seasons[0], season: 1, episode: 1 }),
        await item(sql, { type: 'episode', parent: seasons[0], season: 1, episode: 2 }),
        await item(sql, { type: 'episode', parent: seasons[1], season: 2, episode: 1 }),
    ];
    const extra = await item(sql, { type: 'extra', parent: root, extraType: 'featurette' });
    return { root, seasons, episodes, extra };
}

async function movie(sql: postgres.Sql, ageDays = 40): Promise<{ root: string; extra: string }> {
    const root = await item(sql, { type: 'movie', ageDays });
    const extra = await item(sql, { type: 'extra', parent: root, extraType: 'trailer' });
    return { root, extra };
}

async function exists(sql: postgres.Sql, ids: string[]): Promise<string[]> {
    const rows = await sql<{ id: string }[]>`
        SELECT id::text AS id FROM media_items WHERE id = ANY(${ids}::uuid[]) ORDER BY id
    `;
    return rows.map((r) => r.id);
}

const signal = (): AbortSignal => new AbortController().signal;

const gc = (
    sql: postgres.Sql,
    o: { dryRun?: boolean; enabled?: boolean; batchLimit?: number } = {},
): Promise<NeverOwnedGcResult> =>
    runNeverOwnedMediaGc(
        sql,
        { dryRun: o.dryRun ?? false, batchLimit: o.batchLimit ?? 1000 },
        { enabled: o.enabled ?? true, minAgeDays: MIN_AGE },
        signal(),
    );

const evaluateRoot = (sql: postgres.Sql, rootId: string): Promise<NeverOwnedGcEvaluation> =>
    evaluateNeverOwnedUnits(sql, { limit: 10, minAgeDays: MIN_AGE, rootId });

// -------------------------------------------------------------------------
// One fixture per keep rule. Each attaches its reference to the deepest
// member (an episode) of a never-owned series, so the case also proves that
// one protected member keeps the whole unit.
// -------------------------------------------------------------------------

interface CaseCtx {
    sql: postgres.Sql;
    user: string;
    s: SeriesFx;
    /** The episode the reference is attached to. */
    id: string;
}

const newFile = async (sql: postgres.Sql): Promise<string> => {
    const [f] = await sql<{ id: string }[]>`
        INSERT INTO media_files (file_path) VALUES (${`/gc-test/${crypto.randomUUID()}.mkv`})
        RETURNING id::text AS id
    `;
    return f.id;
};

/** Provider row as the TMDB discovery sweep writes it, stamped `daysAgo` days ago. */
const stampDiscovery = (sql: postgres.Sql, id: string, daysAgo: number): Promise<unknown> =>
    sql`INSERT INTO provider_metadata (media_id, provider, metadata)
        VALUES (${id}, 'tmdb', jsonb_build_object(${DISCOVERY_SEEN_KEY}::text,
            to_char((NOW() - make_interval(days => ${daysAgo}::int)) AT TIME ZONE 'UTC',
                'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')))`;

const KEEP_CASES: Record<string, (c: CaseCtx) => Promise<unknown>> = {
    // Row state.
    'not-active': ({ sql, id }) => sql`UPDATE media_items SET status = 'deleted' WHERE id = ${id}`,
    'has-files': ({ sql, id }) => sql`UPDATE media_items SET has_files = true WHERE id = ${id}`,
    'formerly-owned': ({ sql, id }) =>
        sql`UPDATE media_items SET library_added_at = NOW() - INTERVAL '90 days' WHERE id = ${id}`,
    dismissed: ({ sql, id }) => sql`UPDATE media_items SET is_dismissed = true WHERE id = ${id}`,
    'alias-row': async ({ sql, id }) => {
        // A young target, so the target itself is no candidate.
        const target = await item(sql, { type: 'movie', ageDays: 0 });
        await sql`UPDATE media_items SET canonical_id = ${target} WHERE id = ${id}`;
    },
    'recently-seen-by-discovery': ({ sql, id }) => stampDiscovery(sql, id, 10),
    'operator-curation': ({ sql, id }) =>
        sql`UPDATE media_items SET metadata_locked = true WHERE id = ${id}`,
    'media_artwork.media_item_id': ({ sql, id }) =>
        sql`INSERT INTO media_artwork (media_item_id, artwork_type, source, remote_url, file_path)
            VALUES (${id}, 'poster', 'local', 'admin:file', '/gc-test/upload.jpg')`,
    'admin_media_change_receipts.before_state': async ({ sql, id }) => {
        const owner = await item(sql, { type: 'movie' });
        await sql`INSERT INTO admin_media_change_receipts (owner,media_item_id,kind,before_state,after_state,actor)
            VALUES (${owner},${owner},'file-mapping:original-file',jsonb_build_object('ids',jsonb_build_array(${id}::text)),'{}','test')`;
    },
    'admin_media_change_receipts.media_item_id': ({ sql, id }) =>
        sql`INSERT INTO admin_media_change_receipts (owner,media_item_id,kind,before_state,after_state,actor)
            VALUES (${id},${id},'artwork','{}','{}','test')`,
    'image_candidates.media_item_id': ({ sql, id }) =>
        sql`INSERT INTO image_candidates (media_item_id, artwork_type, provider, provider_ref, remote_url, chosen_by)
            VALUES (${id}, 'poster', 'tmdb', '/chosen.jpg', 'https://image.tmdb.org/t/p/original/chosen.jpg', 'user')`,

    // Foreign keys.
    'user_ratings.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO user_ratings (media_id, user_id, rating) VALUES (${id}, ${user}, 5)`,
    'user_media_state.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO user_media_state (media_id, user_id, is_favorite) VALUES (${id}, ${user}, true)`,
    'user_media_events.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO user_media_events (media_id, user_id, event_type, source, occurred_at)
            VALUES (${id}, ${user}, 'progress', 'lumastra-player', NOW())`,
    'user_music_state.track_id': ({ sql, id, user }) =>
        sql`INSERT INTO user_music_state (track_id, user_id) VALUES (${id}, ${user})`,
    'music_listen_events.track_id': ({ sql, id, user }) =>
        sql`INSERT INTO music_listen_events (track_id, user_id) VALUES (${id}, ${user})`,
    'user_rate_skips.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO user_rate_skips (media_id, user_id) VALUES (${id}, ${user})`,
    'user_taste_dampers.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO user_taste_dampers (media_id, user_id, media_type, expires_at)
            VALUES (${id}, ${user}, 'movie', NOW() + INTERVAL '1 day')`,
    'user_media_share_opt_out.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO user_media_share_opt_out (media_id, user_id) VALUES (${id}, ${user})`,
    'user_suggestions.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO user_suggestions (media_id, user_id) VALUES (${id}, ${user})`,
    'media_annotations.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO media_annotations (media_id, user_id, type, content) VALUES (${id}, ${user}, 'pin', 'keep')`,
    'music_edit_receipts.reference_ids': async ({ sql, id }) => {
        const target = await item(sql, { type: 'artist' });
        await sql`INSERT INTO music_edit_receipts(target_id,kind,actor,before_state,after_state,reference_ids)
            VALUES (${target},'credits','test','[]','[]',ARRAY[${id}]::uuid[])`;
    },
    'music_edit_receipts.target_id': ({ sql, id }) =>
        sql`INSERT INTO music_edit_receipts (target_id,kind,actor,before_state,after_state)
            VALUES (${id},'credits','test','[]','[]')`,
    'personal_media_dispositions.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO personal_media_dispositions (media_id, disposition, decided_by)
            VALUES (${id}, 'kept', ${user})`,
    'playlist_items.media_id': async ({ sql, id, user }) => {
        const [p] = await sql<{ id: number }[]>`
            INSERT INTO playlists (user_id, name) VALUES (${user}, ${'gc ' + id}) RETURNING id
        `;
        await sql`INSERT INTO playlist_items (playlist_id, media_id, title, position) VALUES (${p.id}, ${id}, 'keep', 0)`;
    },
    'watchlist_activities.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO watchlist_activities (media_id, user_id, activity_type, tmdb_id, media_type, title)
            VALUES (${id}, ${user}, 'add', 1, 'movie', 'keep')`,
    'watch_history.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO watch_history (media_id, user_id, media_type, session_start_time)
            VALUES (${id}, ${user}, 'episode', NOW())`,
    'watch_state_sync_log.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO watch_state_sync_log (media_id, user_id, provider) VALUES (${id}, ${user}, 'jellyfin')`,
    'play_sessions.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO play_sessions (media_id, user_id, device_id, ip_address, play_method)
            VALUES (${id}, ${user}, 'test', '127.0.0.1', 'audio_only')`,
    'playback_incident_events.media_id': ({ sql, id }) =>
        sql`INSERT INTO playback_incident_events (media_id, attempt_id, play_session_id, incident_at, trigger_type)
            VALUES (${id}, 'attempt', 'session', NOW(), 'gc-test')`,
    'transcode_failure_events.media_id': ({ sql, id }) =>
        sql`INSERT INTO transcode_failure_events (media_id, job_id, play_session_id, outcome, category)
            VALUES (${id}, 'job', 'session', 'failed', 'gc-test')`,
    'download_renditions.media_item_id': async ({ sql, id }) => {
        const file = await newFile(sql);
        await sql`INSERT INTO download_renditions (file_id, media_item_id, rung_id) VALUES (${file}, ${id}, 'r1')`;
    },
    'hls_playback_tokens.catalog_media_item_id': ({ sql, id, user }) =>
        sql`INSERT INTO hls_playback_tokens (token_hash, username, user_id, client_ip, expires_at, media_item_id, grant_kind)
            VALUES (${crypto.randomUUID()}, 'gc', ${user}, '127.0.0.1', NOW() + INTERVAL '1 hour', ${id}, 'video')`,
    'media_added_pending.media_item_id': async ({ sql, id }) => {
        const [hook] = await sql<{ id: string }[]>`
            INSERT INTO task_webhook_hooks (url, secret_encrypted, event_filter, created_by)
            VALUES ('https://example.invalid/hook', '\\x00'::bytea, '{}'::jsonb, 'gc-test')
            RETURNING id::text AS id
        `;
        await sql`INSERT INTO media_added_pending (hook_id, media_item_id, payload) VALUES (${hook.id}, ${id}, '{}'::jsonb)`;
    },
    'upload_sessions.media_item_id': async ({ sql, id }) => {
        const group = crypto.randomUUID();
        await sql`INSERT INTO library_groups (id, name) VALUES (${group}, ${group})`;
        const [path] = await sql<{ id: string }[]>`
            INSERT INTO library_paths (path, media_type, library_group_id)
            VALUES (${`/gc-up/${crypto.randomUUID()}`}, 'tv', ${group})
            RETURNING id::text AS id
        `;
        await sql`INSERT INTO upload_sessions (library_path_id, uploader_user, filename, mime_type, total_size,
                total_chunks, staging_dir, media_item_id)
            VALUES (${path.id}, 'gc', 'x.mkv', 'video/x-matroska', 1, 1, '/tmp/gc', ${id})`;
    },
    'training_assignments.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO training_assignments (title, item_kind, media_id, target_kind, target_user_id, assigned_by)
            VALUES ('gc', 'media', ${id}, 'user', ${user}, ${user})`,
    'course_modules.media_item_id': async ({ sql, id, user }) => {
        const [course] = await sql<{ id: string }[]>`
            INSERT INTO courses (title, slug, created_by) VALUES ('gc', ${`gc-${crypto.randomUUID()}`}, ${user})
            RETURNING id::text AS id
        `;
        await sql`INSERT INTO course_modules (course_id, kind, title, media_item_id) VALUES (${course.id}, 'video', 'gc', ${id})`;
    },
    'courses.cover_media_id': ({ sql, id, user }) =>
        sql`INSERT INTO courses (title, slug, created_by, cover_media_id)
            VALUES ('gc', ${`gc-${crypto.randomUUID()}`}, ${user}, ${id})`,
    'sync_quarantine.expected_series_id': ({ sql, id }) =>
        sql`INSERT INTO sync_quarantine (provider, external_id, media_type, payload, reason, source, expected_series_id)
            VALUES ('jellyfin', 'x', 'episode', '{}'::jsonb, 'gc-test', 'gc-test', ${id})`,
    'episode_reconciliation_moves.episode_id': ({ sql, id, s }) =>
        sql`INSERT INTO episode_reconciliation_moves (series_id, episode_id, service, tmdb_episode_id,
                from_season, from_episode, to_season, to_episode)
            VALUES (${s.root}, ${id}, 'absolute-numbering', '1', 1, 1, 1, 2)`,
    'library_availability.media_id': ({ sql, id }) =>
        sql`INSERT INTO library_availability (media_id, library, library_item_id, available)
            VALUES (${id}, 'jellyfin', 'x', true)`,
    'series_episode_ordering.media_id': ({ sql, id }) =>
        sql`INSERT INTO series_episode_ordering (media_id, ordering_type, ordering_source) VALUES (${id}, 'dvd', 'manual')`,
    'media_artwork_suppressions.media_item_id': ({ sql, id }) =>
        sql`INSERT INTO media_artwork_suppressions (media_item_id, artwork_type, file_path)
            VALUES (${id}, 'poster', '/gc-test/hidden.jpg')`,
    'media_file_items.media_item_id': async ({ sql, id }) => {
        const file = await newFile(sql);
        await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file}, ${id}, true)`;
    },
    'media_items.canonical_id': async ({ sql, id }) => {
        const alias = await item(sql, { type: 'movie', ageDays: 0 });
        await sql`UPDATE media_items SET status = 'merged', canonical_id = ${id} WHERE id = ${alias}`;
    },
    'cached_list_items.media_id': async ({ sql, id }) => {
        const list = `gc-${crypto.randomUUID()}`;
        await sql`INSERT INTO cached_lists (list_id, name, list_path) VALUES (${list}, 'gc', ${list})`;
        await sql`INSERT INTO cached_list_items (list_id, media_id, rank) VALUES (${list}, ${id}, 1)`;
    },
    'young-member': ({ sql, id }) =>
        sql`UPDATE media_items SET created_at = NOW() - INTERVAL '2 days' WHERE id = ${id}`,
    'episode_reconciliation_moves.series_id': ({ sql, id }) =>
        sql`INSERT INTO episode_reconciliation_moves (series_id, service, tmdb_episode_id,
                from_season, from_episode, to_season, to_episode)
            VALUES (${id}, 'absolute-numbering', '1', 1, 1, 1, 2)`,
    'episode_reconciliation_moves.from_parent_id': ({ sql, id }) =>
        sql`INSERT INTO episode_reconciliation_moves (series_id, from_parent_id, service, tmdb_episode_id,
                from_season, from_episode, to_season, to_episode)
            VALUES (${crypto.randomUUID()}, ${id}, 'absolute-numbering', '1', 1, 1, 1, 2)`,
    'episode_reconciliation_moves.to_parent_id': ({ sql, id }) =>
        sql`INSERT INTO episode_reconciliation_moves (series_id, to_parent_id, service, tmdb_episode_id,
                from_season, from_episode, to_season, to_episode)
            VALUES (${crypto.randomUUID()}, ${id}, 'absolute-numbering', '1', 1, 1, 1, 2)`,
    'episode_reconciliation_moves.ghost_id': ({ sql, id }) =>
        sql`INSERT INTO episode_reconciliation_moves (series_id, ghost_id, service, tmdb_episode_id,
                from_season, from_episode, to_season, to_episode)
            VALUES (${crypto.randomUUID()}, ${id}, 'absolute-numbering', '1', 1, 1, 1, 2)`,
    'livetv_channels.id': ({ sql, id }) =>
        sql`INSERT INTO livetv_channels (id, m3u_url) VALUES (${id}, 'http://example.invalid/live.m3u8')`,

    // No-FK references; text ids in a legacy spelling where the column is text.
    'interactions.target_id': ({ sql, id, user }) =>
        sql`INSERT INTO interactions (target_type, target_id, user_id, body)
            VALUES ('media', ${id.toUpperCase()}, ${user}, 'keep')`,
    'interaction_reactions.target_id': ({ sql, id, user }) =>
        sql`INSERT INTO interaction_reactions (target_type, target_id, user_id, emoji)
            VALUES ('media', ${id.replace(/-/g, '')}, ${user}, 'heart')`,
    // A mute by catalog UUID.
    'user_media_flags.target_id': ({ sql, id, user }) =>
        sql`INSERT INTO user_media_flags (target_type, target_id, user_id, flag_type)
            VALUES ('series', ${id}, ${user}, 'series_excluded')`,
    'watch_state_pending_resolution.internal_media_id': ({ sql, id, user }) =>
        sql`INSERT INTO watch_state_pending_resolution (internal_media_id, user_id, provider, media_type, provider_id)
            VALUES (${id}, ${user}, 'jellyfin', 'episode', ${id})`,
    'watch_sync_activity.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO watch_sync_activity (media_id, user_id, provider, direction, outcome)
            VALUES (${id}, ${user}, 'jellyfin', 'pull', 'success')`,
    'user_media_events_archive.media_id': ({ sql, id, user }) =>
        sql`INSERT INTO user_media_events_archive (id, media_id, user_id, event_type, source, occurred_at, recorded_at)
            VALUES (${crypto.randomUUID()}, ${id}, ${user}, 'progress', 'lumastra-player', NOW(), NOW())`,
    'assistant_messages.context_media_ids': ({ sql, id, user }) =>
        sql`INSERT INTO assistant_messages (user_id, role, content, context_media_ids)
            VALUES (${user}, 'assistant', 'keep', ${[id]}::uuid[])`,
    'client_diagnostics.media_id': ({ sql, id }) =>
        sql`INSERT INTO client_diagnostics (event_id, kind, platform, occurred_at, media_id)
            VALUES (${crypto.randomUUID()}, 'playback_incident', 'web', NOW(), ${id})`,
    'active_transcode_jobs.item_id': ({ sql, id, user }) =>
        sql`INSERT INTO active_transcode_jobs (play_session_id, job_id, item_id, user_id, device_id, config,
                output_dir, status, mode)
            VALUES (${crypto.randomUUID()}, 'job', ${id.replace(/-/g, '')}, ${user}, 'dev', '{}'::jsonb,
                '/tmp/gc', 'running', 'full')`,
    // A live grant: the FK column is NULL, only the plain id column names the row.
    'hls_playback_tokens.media_item_id': ({ sql, id, user }) =>
        sql`INSERT INTO hls_playback_tokens (token_hash, username, user_id, client_ip, expires_at, media_item_id, grant_kind)
            VALUES (${crypto.randomUUID()}, 'gc', ${user}, '127.0.0.1', NOW() + INTERVAL '1 hour', ${id}, 'live')`,

    // Unit shape.
    'unexpected-member-type': async ({ sql, s }) => {
        await item(sql, { type: 'track', parent: s.seasons[0] });
    },
    oversized: ({ sql, s }) =>
        sql`INSERT INTO media_items (title, media_type, parent_id, season_number, episode_number, has_files, created_at)
            SELECT 'gc ep ' || n, 'episode', ${s.seasons[0]}, 1, n, false, NOW() - INTERVAL '40 days'
            FROM generate_series(100, 5099) n`,
};

/** Rule keys whose tables `mediaReferenceGuard` (the retention guard) also covers. */
const RETENTION_GUARD_KEYS = new Set([
    'user_ratings.media_id',
    'user_suggestions.media_id',
    'training_assignments.media_id',
    'course_modules.media_item_id',
    'courses.cover_media_id',
    'upload_sessions.media_item_id',
    'playback_incident_events.media_id',
    'transcode_failure_events.media_id',
    'media_artwork_suppressions.media_item_id',
    'playlist_items.media_id',
    'user_media_state.media_id',
    'user_media_events.media_id',
    'user_media_events_archive.media_id',
    'user_rate_skips.media_id',
    'user_taste_dampers.media_id',
    'user_media_share_opt_out.media_id',
    'media_annotations.media_id',
    'personal_media_dispositions.media_id',
    'watch_history.media_id',
    'watch_state_pending_resolution.internal_media_id',
    'watchlist_activities.media_id',
    'play_sessions.media_id',
    'watch_state_sync_log.media_id',
    'watch_sync_activity.media_id',
    'user_music_state.track_id',
    'music_listen_events.track_id',
    'library_availability.media_id',
    'series_episode_ordering.media_id',
    'interactions.target_id',
    'interaction_reactions.target_id',
    'user_media_flags.target_id',
]);

/** The rule a case is expected to trip (coveredBy references name their covering rule). */
function expectedRule(key: string): string {
    const fk = MEDIA_ITEM_FK_CLASSIFICATION[key];
    return fk?.class === 'protect' && fk.coveredBy ? fk.coveredBy : key;
}

describe('never-owned media GC', () => {
    beforeAll(() => {
        db = getTestDb();
    });
    // The last describe below closes the pool.

    // ---------------------------------------------------------------------
    // Classification coverage
    // ---------------------------------------------------------------------

    it('classifies every foreign key to media_items, and nothing that is not one', async () => {
        const rows = await getTestDb()<{ key: string }[]>`
            SELECT DISTINCT c.conrelid::regclass::text || '.' || a.attname AS key
            FROM pg_constraint c
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
            WHERE c.contype = 'f' AND c.confrelid = 'media_items'::regclass
            ORDER BY 1
        `;
        const fks = rows.map((r) => r.key);
        expect(fks.filter((k) => !MEDIA_ITEM_FK_CLASSIFICATION[k])).toEqual([]);
        expect(Object.keys(MEDIA_ITEM_FK_CLASSIFICATION).filter((k) => !fks.includes(k))).toEqual(
            [],
        );
        // A no-FK entry must name a real column that really has no FK to media_items.
        for (const key of Object.keys(NO_FK_MEDIA_REFERENCES)) {
            const [table, column] = key.split('.');
            const [col] = await getTestDb()<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM pg_attribute
                WHERE attrelid = to_regclass(${table}) AND attname = ${column} AND NOT attisdropped
            `;
            expect(col.n, key).toBe(1);
            expect(fks, key).not.toContain(key);
        }
    });

    it('has a fixture for every keep rule', () => {
        const rules = new Set<string>([
            ...NEVER_OWNED_KEEP_RULES.map((r) => r.key),
            ...Object.entries(MEDIA_ITEM_FK_CLASSIFICATION)
                .filter(([, c]) => c.class === 'protect' && c.coveredBy)
                .map(([k]) => k),
            ...Object.keys(NEVER_OWNED_UNIT_RULES),
        ]);
        // Not reachable with a realistic fixture: a 64-level parent chain, and the retention
        // guard, which every RETENTION_GUARD_KEYS case asserts on.
        rules.delete('too-deep');
        rules.delete('retention-reference-guard');
        expect([...rules].filter((k) => !KEEP_CASES[k]).sort()).toEqual([]);
        expect(Object.keys(KEEP_CASES).filter((k) => !rules.has(k))).toEqual([]);
    });

    // ---------------------------------------------------------------------
    // Keep rules
    // ---------------------------------------------------------------------

    it.each(Object.keys(KEEP_CASES))(
        '%s on one episode keeps the whole series',
        async (key) => {
            await inFixture(async ({ sql, user }) => {
                const s = await series(sql);
                const id = s.episodes[2];
                const before = await evaluateRoot(sql, s.root);
                expect(before.candidates.map((c) => c.id)).toEqual([s.root]);

                await KEEP_CASES[key]({ sql, user, s, id });

                const after = await evaluateRoot(sql, s.root);
                expect(after.candidates).toEqual([]);
                expect(after.keptByRule[expectedRule(key)], JSON.stringify(after.keptByRule)).toBe(
                    1,
                );
                if (RETENTION_GUARD_KEYS.has(key))
                    expect(after.keptByRule['retention-reference-guard']).toBe(1);

                const result = await gc(sql);
                expect(result.sampleIds).not.toContain(s.root);
                expect(
                    await exists(sql, [s.root, ...s.seasons, ...s.episodes, s.extra]),
                ).toHaveLength(7);
            });
            // The oversized case inserts 5,000 rows through the capture triggers.
        },
        180_000,
    );

    it('automatic image candidates and analyzer evidence remain derived and cascade with a never-owned unit', async () => {
        await inFixture(async ({ sql }) => {
            const s = await series(sql);
            await sql`INSERT INTO image_candidates (media_item_id,artwork_type,provider,provider_ref,remote_url)
                VALUES (${s.episodes[0]},'poster','tmdb','/automatic.jpg','https://image.tmdb.org/t/p/original/automatic.jpg')`;
            await sql`INSERT INTO media_segment_analysis_passes
                (media_id, file_id, input_identity, stage_id, segment_types, segments_count, processing_version, coverage_complete)
                VALUES (${s.episodes[0]}, ${crypto.randomUUID()}, 'retained-input-proof', 'intro', ARRAY['intro'], 0, 1, true)`;
            expect((await evaluateRoot(sql, s.root)).candidates.map((c) => c.id)).toEqual([s.root]);
            const result = await deleteNeverOwnedUnit(
                sql,
                { id: s.root, kind: 'series' },
                { minAgeDays: MIN_AGE },
            );
            expect(result.deleted).toBe(true);
            expect(
                await sql`SELECT 1 FROM image_candidates WHERE media_item_id=${s.episodes[0]}`,
            ).toHaveLength(0);
            expect(
                await sql`SELECT 1 FROM media_segment_analysis_passes WHERE media_id=${s.episodes[0]}`,
            ).toHaveLength(0);
        });
    });

    it('cleans derived season mapping proofs only on deletion, preserving protected proofs and files', async () => {
        await inFixture(async ({ sql, user }) => {
            const doomed = await series(sql);
            const kept = await series(sql);
            const staleProof = async (
                seasonId: string,
                dedicatedId: string = crypto.randomUUID(),
            ): Promise<string[]> => {
                const fileIds = [crypto.randomUUID(), dedicatedId];
                for (const id of fileIds) {
                    await sql`INSERT INTO media_files (id, file_path, health_issues)
                        VALUES (${id}, ${'/fictional/gc-proof-' + id + '.mkv'},
                            '[{"type":"range_superseded","detected_at":"2026-10-25T00:00:00Z"}]'::jsonb)`;
                }
                // Deliberately stale derived data: no current links/graph, never positive proof.
                await sql`INSERT INTO file_range_mapping_proofs
                    (file_id, season_id, first_episode, last_episode, dedicated_ids, graph, proof)
                    VALUES (${fileIds[0]}, ${seasonId}, 1, 1, ${[fileIds[1]]}::uuid[], '{}'::jsonb, '{}'::jsonb)`;
                return fileIds;
            };
            const doomedFiles = await staleProof(doomed.seasons[0]);
            // Separate UUID namespaces can coincide: this participant file must survive
            // deleting the media row with the same ID, together with its unrelated proof.
            const keptFiles = await staleProof(kept.seasons[0], doomed.seasons[1]);
            await sql`INSERT INTO user_ratings (media_id, user_id, rating)
                VALUES (${kept.episodes[0]}, ${user}, 7)`;
            expect((await evaluateRoot(sql, doomed.root)).candidates.map((row) => row.id)).toEqual([
                doomed.root,
            ]);
            await gc(sql, { dryRun: true });
            expect(
                await sql`SELECT 1 FROM file_range_mapping_proofs WHERE file_id = ANY(${[doomedFiles[0], keptFiles[0]]}::uuid[])`,
            ).toHaveLength(2);
            expect(
                await deleteNeverOwnedUnit(
                    sql,
                    { id: kept.root, kind: 'series' },
                    { minAgeDays: MIN_AGE },
                ),
            ).toEqual({ deleted: false, skipReason: 'eligibility-changed' });
            expect(
                (
                    await deleteNeverOwnedUnit(
                        sql,
                        { id: doomed.root, kind: 'series' },
                        { minAgeDays: MIN_AGE },
                    )
                ).deleted,
            ).toBe(true);
            expect(
                await exists(sql, [
                    doomed.root,
                    ...doomed.seasons,
                    ...doomed.episodes,
                    doomed.extra,
                ]),
            ).toEqual([]);
            expect(
                await exists(sql, [kept.root, ...kept.seasons, ...kept.episodes, kept.extra]),
            ).toHaveLength(7);
            expect(
                await sql`SELECT 1 FROM file_range_mapping_proofs WHERE file_id = ${doomedFiles[0]}`,
            ).toHaveLength(0);
            expect(
                await sql`SELECT 1 FROM file_range_mapping_proofs WHERE file_id = ${keptFiles[0]}`,
            ).toHaveLength(1);
            const files = await sql<
                { id: string; health_issues: unknown }[]
            >`SELECT id::text AS id, health_issues FROM media_files
                WHERE id = ANY(${[...doomedFiles, ...keptFiles]}::uuid[])`;
            expect(files).toHaveLength(4);
            for (const file of files)
                expect(file.health_issues).toEqual([
                    { type: 'range_superseded', detected_at: '2026-10-25T00:00:00Z' },
                ]);
        });
    });

    it('rolls back derived mapping-proof cleanup together with a catalog deletion', async () => {
        await inFixture(async ({ sql }) => {
            const s = await series(sql);
            const fileId = crypto.randomUUID();
            await sql`INSERT INTO media_files (id, file_path) VALUES (${fileId}, ${'/fictional/gc-rollback-' + fileId + '.mkv'})`;
            await sql`INSERT INTO file_range_mapping_proofs
                (file_id, season_id, first_episode, last_episode, dedicated_ids, graph, proof)
                VALUES (${fileId}, ${s.seasons[0]}, 1, 1, '{}'::uuid[], '{}'::jsonb, '{}'::jsonb)`;
            const abort = new Error('rollback deletion and derived cleanup');
            await expect(
                withTx(sql, async (tx) => {
                    expect(
                        (
                            await deleteNeverOwnedUnit(
                                tx,
                                { id: s.root, kind: 'series' },
                                { minAgeDays: MIN_AGE },
                            )
                        ).deleted,
                    ).toBe(true);
                    expect(
                        await tx`SELECT 1 FROM file_range_mapping_proofs WHERE file_id = ${fileId}`,
                    ).toHaveLength(0);
                    throw abort;
                }),
            ).rejects.toBe(abort);
            expect(await exists(sql, [s.root, ...s.seasons, ...s.episodes, s.extra])).toHaveLength(
                7,
            );
            expect(
                await sql`SELECT 1 FROM file_range_mapping_proofs WHERE file_id = ${fileId}`,
            ).toHaveLength(1);
            expect(await sql`SELECT 1 FROM media_files WHERE id = ${fileId}`).toHaveLength(1);
        });
    });

    it('a referenced movie extra keeps the movie', async () => {
        await inFixture(async ({ sql, user }) => {
            const m = await movie(sql);
            await sql`INSERT INTO user_ratings (media_id, user_id, rating) VALUES (${m.extra}, ${user}, 7)`;
            const result = await gc(sql);
            expect(result.sampleIds).not.toContain(m.root);
            expect(await exists(sql, [m.root, m.extra])).toHaveLength(2);
        });
    });

    it('leaves formerly-owned roots alone: they are not even candidates', async () => {
        await inFixture(async ({ sql }) => {
            const lost = await item(sql, { type: 'movie' });
            await sql`UPDATE media_items SET files_lost_at = NOW() - INTERVAL '400 days' WHERE id = ${lost}`;
            const added = await item(sql, { type: 'tv' });
            await sql`UPDATE media_items SET library_added_at = NOW() - INTERVAL '400 days' WHERE id = ${added}`;
            const hashed = await item(sql, { type: 'movie' });
            await sql`UPDATE media_items SET dismissed_content_hash = 'abc' WHERE id = ${hashed}`;
            for (const id of [lost, added, hashed]) {
                const evaluation = await evaluateRoot(sql, id);
                expect(evaluation.summary.movie.roots + evaluation.summary.series.roots).toBe(0);
            }
            await gc(sql);
            expect(await exists(sql, [lost, added, hashed])).toHaveLength(3);
        });
    });

    it('keeps never-owned rows younger than the minimum age and counts them', async () => {
        await inFixture(async ({ sql }) => {
            const before = await gc(sql, { dryRun: true });
            const young = await movie(sql, 5);
            const youngSeries = await series(sql, 29);
            const result = await gc(sql);
            expect(result.tooYoung.movie - before.tooYoung.movie).toBe(1);
            expect(result.tooYoung.series - before.tooYoung.series).toBe(1);
            expect(
                await exists(sql, [
                    young.root,
                    young.extra,
                    youngSeries.root,
                    ...youngSeries.episodes,
                ]),
            ).toHaveLength(6);
        });
    });

    it('keeps a series one of whose episodes has a file', async () => {
        await inFixture(async ({ sql }) => {
            const s = await series(sql);
            const file = await newFile(sql);
            await sql`INSERT INTO media_file_items (file_id, media_item_id, is_default) VALUES (${file}, ${s.episodes[0]}, true)`;
            await sql`UPDATE media_items SET has_files = true WHERE id = ${s.episodes[0]}`;
            const result = await gc(sql);
            expect(result.sampleIds).not.toContain(s.root);
            expect(await exists(sql, [s.root, ...s.seasons, ...s.episodes, s.extra])).toHaveLength(
                7,
            );
        });
    });

    // ---------------------------------------------------------------------
    // Deletion
    // ---------------------------------------------------------------------

    it('deletes a series with every season, episode and extra, leaving no orphans', async () => {
        await inFixture(async ({ sql }) => {
            const s = await series(sql);
            const m = await movie(sql);
            const ids = [s.root, ...s.seasons, ...s.episodes, s.extra, m.root, m.extra];
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${s.root}, 'tmdb', ${String(900000 + Math.floor(Math.random() * 99999))}, 'tv')`;
            const result = await gc(sql);
            expect(result.dryRun).toBe(false);
            expect(result.deleted.seriesUnits).toBeGreaterThanOrEqual(1);
            expect(result.deleted.movieUnits).toBeGreaterThanOrEqual(1);
            expect(result.deleted.seasons).toBeGreaterThanOrEqual(2);
            expect(result.deleted.episodes).toBeGreaterThanOrEqual(3);
            expect(result.deleted.extras).toBeGreaterThanOrEqual(2);
            expect(await exists(sql, ids)).toEqual([]);
            const [orphans] = await sql<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM media_items WHERE parent_id = ANY(${ids}::uuid[])
            `;
            expect(orphans.n).toBe(0);
            const [extIds] = await sql<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM external_ids WHERE media_id = ANY(${ids}::uuid[])
            `;
            expect(extIds.n).toBe(0);
        });
    });

    it('deleteNeverOwnedUnit removes leaves first and reports the unit shape', async () => {
        await inFixture(async ({ sql }) => {
            const s = await series(sql);
            const outcome = await deleteNeverOwnedUnit(
                sql,
                { id: s.root, kind: 'series' },
                { minAgeDays: MIN_AGE },
            );
            expect(outcome.deleted).toBe(true);
            if (!outcome.deleted) return;
            expect(outcome.unit).toMatchObject({ members: 7, seasons: 2, episodes: 3, extras: 1 });
            expect(outcome.deletedIds.at(-1)).toBe(s.root);
            expect(outcome.deletedIds.slice(0, 3).sort()).toEqual([...s.episodes].sort());
        });
    });

    it('a dry run deletes nothing and reports the same counts', async () => {
        await inFixture(async ({ sql }) => {
            const before = await gc(sql, { dryRun: true });
            const s = await series(sql);
            const m = await movie(sql);
            const result = await gc(sql, { dryRun: true });
            expect(result.dryRun).toBe(true);
            expect(result.forcedDryRun).toBe(false);
            expect(result.eligible.movieUnits - before.eligible.movieUnits).toBe(1);
            expect(result.eligible.seriesUnits - before.eligible.seriesUnits).toBe(1);
            expect(result.eligible.seasons - before.eligible.seasons).toBe(2);
            expect(result.eligible.episodes - before.eligible.episodes).toBe(3);
            expect(result.eligible.extras - before.eligible.extras).toBe(2);
            expect(result.eligible.totalRows - before.eligible.totalRows).toBe(9);
            expect(result.deleted).toEqual({
                movieUnits: 0,
                seriesUnits: 0,
                seasons: 0,
                episodes: 0,
                extras: 0,
                totalRows: 0,
            });
            expect(result.summary).toMatch(/^Preview: would delete/);
            expect(
                await exists(sql, [s.root, ...s.seasons, ...s.episodes, s.extra, m.root, m.extra]),
            ).toHaveLength(9);
        });
    });

    it('turns a deleting run into a preview while the setting is off', async () => {
        await inFixture(async ({ sql }) => {
            const s = await series(sql);
            const result = await gc(sql, { dryRun: false, enabled: false });
            expect(result.dryRun).toBe(true);
            expect(result.forcedDryRun).toBe(true);
            expect(result.enabled).toBe(false);
            expect(result.deleted.totalRows).toBe(0);
            expect(result.summary).toMatch(/^Preview only \(cleanup is off in Settings\)/);
            expect(await exists(sql, [s.root, ...s.episodes])).toHaveLength(4);
        });
    });

    it.each([
        {
            name: 'rating',
            write: (sql: postgres.Sql, id: string, user: string) =>
                sql`INSERT INTO user_ratings (media_id, user_id, rating) VALUES (${id}, ${user}, 5)`,
        },
        {
            name: 'comment (no FK)',
            write: (sql: postgres.Sql, id: string, user: string) =>
                sql`INSERT INTO interactions (target_type, target_id, user_id, body) VALUES ('media', ${id}, ${user}, 'late')`,
        },
    ])(
        'a $name written after selection keeps the unit (re-checked under locks)',
        async ({ write }) => {
            await inFixture(async ({ sql, user }) => {
                const s = await series(sql);
                const selected = await evaluateRoot(sql, s.root);
                expect(selected.candidates.map((c) => c.id)).toEqual([s.root]);
                await write(sql, s.episodes[1], user);
                const outcome = await deleteNeverOwnedUnit(
                    sql,
                    { id: s.root, kind: 'series' },
                    { minAgeDays: MIN_AGE },
                );
                expect(outcome).toEqual({ deleted: false, skipReason: 'eligibility-changed' });
                expect(
                    await exists(sql, [s.root, ...s.seasons, ...s.episodes, s.extra]),
                ).toHaveLength(7);
            });
        },
    );

    it('a GC delete leaves no library sync entries for never-owned movies and series', async () => {
        await inFixture(async ({ sql }) => {
            const m = await movie(sql);
            const s = await series(sql);
            const ids = [m.root, m.extra, s.root, ...s.seasons, ...s.episodes, s.extra];
            // Provider rows the delete removes explicitly before the media rows.
            await sql`INSERT INTO external_ids (media_id, provider, external_id, media_type)
                VALUES (${m.root}, 'tmdb', ${String(800000 + Math.floor(Math.random() * 99999))}, 'movie')`;
            await sql`INSERT INTO provider_metadata (media_id, provider, metadata)
                VALUES (${m.root}, 'tmdb', '{"title":"gc"}'::jsonb), (${s.root}, 'tmdb', '{"title":"gc"}'::jsonb)`;
            // Drop the fixture's own insert entries; only the delete's entries are under test.
            await sql`DELETE FROM sync_changes WHERE xid = pg_current_xact_id() AND entity_id = ANY(${ids})`;
            const result = await gc(sql);
            expect(await exists(sql, ids)).toEqual([]);
            expect(result.deleted.movieUnits).toBeGreaterThanOrEqual(1);
            expect(result.deleted.seriesUnits).toBeGreaterThanOrEqual(1);
            const logged =
                await sql`SELECT entity_id, kind FROM sync_changes WHERE entity_id = ANY(${ids})`;
            expect(logged).toEqual([]);
        });
    });

    it('a statement timeout in the evaluation reports a partial run instead of failing', async () => {
        await inFixture(async ({ sql }) => {
            const m = await movie(sql);
            const result = await runNeverOwnedMediaGc(
                sql,
                { dryRun: false, batchLimit: 1000 },
                { enabled: true, minAgeDays: MIN_AGE },
                signal(),
                { evaluationStatementTimeoutMs: 1 },
            );
            expect(result.evaluationComplete).toBe(false);
            expect(result.skipReasons['evaluation-statement-timeout']).toBe(1);
            expect(result.hasMore).toBe(true);
            expect(result.summary).toMatch(/evaluation stopped early/);
            expect(await exists(sql, [m.root, m.extra])).toHaveLength(2);
        });
    });

    it('the discovery look-back covers two sweep re-stamp periods', () => {
        expect(DISCOVERY_DETAIL_REFRESH_DAYS).toBe(SWEEP_REFRESH_DAYS);
    });

    it('counts a root once when several members hit several protection rules', async () => {
        await inFixture(async ({ sql, user }) => {
            const s = await series(sql);
            for (const id of s.episodes.slice(0, 2)) {
                await stampDiscovery(sql, id, 10);
                await KEEP_CASES['user_ratings.media_id']({ sql, user, s, id });
            }
            const evaluation = await evaluateRoot(sql, s.root);
            expect(evaluation.candidates).toEqual([]);
            expect(evaluation.summary.series).toMatchObject({
                roots: 1,
                eligible: 0,
                kept: 1,
            });
            expect(evaluation.keptByRule['recently-seen-by-discovery']).toBe(1);
            expect(evaluation.keptByRule['user_ratings.media_id']).toBe(1);
            expect(evaluation.keptByRule['retention-reference-guard']).toBe(1);
            expect(evaluation.keptByCategory.discovery).toBe(1);
            expect(evaluation.keptByCategory['user-data']).toBe(1);
        });
    });

    it('keeps a title the discovery sweep still refreshes; deletes one it dropped', async () => {
        await inFixture(async ({ sql }) => {
            expect(DISCOVERY_SEEN_KEY).toBe(DISCOVERY_DETAIL_SYNCED_AT_KEY);
            const before = await gc(sql, { dryRun: true });
            const listed = await movie(sql);
            await stampDiscovery(sql, listed.root, 10);
            const dropped = await series(sql);
            await stampDiscovery(sql, dropped.root, 45);
            const result = await gc(sql);
            expect(result.kept.recentlySeenByDiscovery - before.kept.recentlySeenByDiscovery).toBe(
                1,
            );
            expect(result.summary).toMatch(/still listed by discovery/);
            expect(await exists(sql, [listed.root, listed.extra])).toHaveLength(2);
            expect(await exists(sql, [dropped.root, ...dropped.episodes])).toEqual([]);
        });
    });

    // ---------------------------------------------------------------------
    // Preview SQL parity
    // ---------------------------------------------------------------------

    it('scripts/sql/never-owned-media-gc-preview.sql computes the same counts as the task', async () => {
        const previewSql = readFileSync(
            new URL('../../../../../scripts/sql/never-owned-media-gc-preview.sql', import.meta.url),
            'utf8',
        );
        await inFixture(async ({ sql, user }) => {
            // A mix: eligible units, units kept by several rules, a young one.
            await series(sql);
            await movie(sql);
            await movie(sql, 3);
            for (const key of [
                'user_ratings.media_id',
                'personal_media_dispositions.media_id',
                'interactions.target_id',
                'operator-curation',
                'media_artwork.media_item_id',
                'image_candidates.media_item_id',
                'media_items.canonical_id',
                'livetv_channels.id',
                'unexpected-member-type',
                'assistant_messages.context_media_ids',
                'recently-seen-by-discovery',
                'cached_list_items.media_id',
                'young-member',
            ]) {
                const s = await series(sql);
                await KEEP_CASES[key]({ sql, user, s, id: s.episodes[0] });
            }
            const evaluation = await evaluateNeverOwnedUnits(sql, {
                limit: 1,
                minAgeDays: MIN_AGE,
            });
            // Keyset batches of 2 roots add up to the single-statement evaluation.
            const batched = await evaluateNeverOwnedCatalog(sql, {
                limit: 1,
                minAgeDays: MIN_AGE,
                batchSize: 2,
            });
            expect(batched.complete).toBe(true);
            expect(batched.evaluation.summary).toEqual(evaluation.summary);
            expect(batched.evaluation.keptByRule).toEqual(evaluation.keptByRule);
            expect(batched.evaluation.keptByCategory).toEqual(evaluation.keptByCategory);
            // The preview is static read-only SQL shipped for psql; no parameters to bind.
            const rows = await sql.unsafe<
                {
                    row_type: string;
                    name: string;
                    n_units: number;
                    n_roots: number | null;
                    n_young: number | null;
                    n_rows: number | null;
                    n_seasons: number | null;
                    n_episodes: number | null;
                    n_extras: number | null;
                    n_kept: number | null;
                }[]
            >(previewSql);
            for (const kind of ['movie', 'series'] as const) {
                const row = rows.find((r) => r.row_type === 'kind' && r.name === kind);
                const s = evaluation.summary[kind];
                expect(row, kind).toMatchObject({
                    n_units: s.eligible,
                    n_roots: s.roots,
                    n_young: s.tooYoung,
                    n_rows: s.eligibleRows,
                    n_seasons: s.eligibleSeasons,
                    n_episodes: s.eligibleEpisodes,
                    n_extras: s.eligibleExtras,
                    n_kept: s.kept,
                });
            }
            const byName = (type: string): Record<string, number> =>
                Object.fromEntries(
                    rows.filter((r) => r.row_type === type).map((r) => [r.name, r.n_units]),
                );
            expect(byName('rule')).toEqual(evaluation.keptByRule);
            expect(byName('category')).toEqual(evaluation.keptByCategory);
            // Every rule the task applies is spelled out in the preview.
            for (const key of [
                ...NEVER_OWNED_KEEP_RULES.map((r) => r.key),
                ...Object.keys(NEVER_OWNED_UNIT_RULES),
            ])
                expect(previewSql, key).toContain(`'${key}'`);
        });
    });
});

/**
 * Columns that look like media ids (any uuid / uuid[] column, and text columns named like
 * one) but hold something else. Every such column must be an FK (classified above), a
 * no-FK media reference, or listed here with the reason it is not a media_items id.
 */
const NOT_MEDIA_ID_COLUMNS: Record<string, string> = {
    'oauth_device_codes.approved_by_device_session_id':
        'Approving OAuth session, not a media identity.',
    'oauth_device_codes.created_by_device_session_id':
        'Requesting OAuth session, not a media identity.',
    'oauth_refresh_tokens.approved_by_device_session_id':
        'Parent OAuth session; retained through token GC, not a media identity.',
    'admin_media_change_receipts.after_state':
        'Exact after-state comparison guard for Undo, never a catalog identity.',
    'jellyfin_file_inventory.generation': 'Claim fencing token, not a media identity.',
    // jellyfin_file_inventory.candidates JSON holds observations, never ownership or restore authority.
    'quarantine_dispositions.previous_warning':
        'Forensic warning row snapshot: media/file IDs inside its JSON are observations, never live ownership or catalog restore authority.',
    'quarantine_dispositions.batch_id':
        'Warning disposition batch token; never a media/file identity.',
    'media_file_health_reviews.file_id':
        'Forensic physical-file identity; retained even when a media_files row is deleted.',
    'media_file_health_rechecks.file_id':
        'Physical-file identity for a pending health recheck; keyed by media_files, never a media_items id.',
    'file_range_mapping_proofs.dedicated_ids':
        'Participant media_files UUIDs, not media_items identities; the season reference is classified separately.',
    'media_items.media_segment_generation':
        'Analysis input generation token, not a media identity.',
    'media_segment_analysis_passes.file_id':
        'Physical source file identity retained with analyzer evidence.',
    'plugin_failure_events.file_id':
        'Physical source file identity retained with failure evidence.',
    'unavailable_media_retention_grace_progress.last_id':
        'Grace migration cursor; a stale id only resumes the batch walk.',
    'album_merge_receipts.pair_ids':
        'Merge idempotency receipt; replays only, a stale id is harmless.',
    'album_split_health_cursor.after_id':
        'Health-check scan cursor; a stale id only resumes the scan.',
    'active_transcode_jobs.play_session_id': 'Playback session id.',
    'client_diagnostics.event_id': 'Client-generated event id.',
    'episode_orderings.provider_episode_id': 'Provider (TMDB/TVDB) episode id.',
    'episode_reconciliation_moves.tmdb_episode_id': 'TMDB episode id.',
    'episode_reconciliation_moves.prev_tmdb_episode_id': 'TMDB episode id restored by undo.',
    'episode_reconciliation_moves.group_id':
        'Fresh UUID grouping connected identity changes for atomic undo; not a media identity.',
    'library_availability.library_item_id': 'Item id in the external library (Jellyfin).',
    'library_size_snapshots.library_group_id': 'Library group whose storage was measured.',
    'library_volume_snapshots.library_path_id': 'Library path whose filesystem was measured.',
    'license_install.install_uuid': 'Install identity.',
    'music_listen_events.event_id': 'Client event id (dedup).',
    'music_play_starts.event_id': 'Client event id (dedup claim).',
    'play_sessions.plan_id': 'Playback plan id.',
    'task_history.tenant_id': 'Task tenant.',
    'task_history_archive.tenant_id': 'Task tenant.',
    'sync_changes.prev_library_ids': 'Library group ids.',
    'sync_changes.user_id': 'User the entry is for.',
    'sync_state.instance_id': 'Database instance identity.',
    'task_quota_usage.tenant_id': 'Task tenant.',
    'task_runtime_authorities.owner_id': 'Task runtime owner.',
    'task_runtime_commands.command_id': 'Task runtime command.',
    'task_runtime_commands.owner_id': 'Task runtime owner.',
    'task_runtime_executions.dispatch_id': 'Task dispatch.',
    'task_runtime_executions.invocation_id': 'Task invocation.',
    'task_runtime_executions.owner_id': 'Task runtime owner.',
    'task_runtime_handovers.handover_id': 'Task runtime handover.',
    'task_runtime_handovers.next_owner_id': 'Task runtime owner.',
    'task_runtime_handovers.source_owner_id': 'Task runtime owner.',
    'task_runtime_queue_operations.owner_id': 'Task runtime owner.',
    'user_access_groups.assigned_by': 'User who assigned the group.',
};

describe('never-owned media GC: schema scan', () => {
    it('indexes the derived season reference used by mapping-proof cleanup', async () => {
        const rows = await getTestDb()<{ valid: boolean; ready: boolean; definition: string }[]>`
            SELECT i.indisvalid AS valid, i.indisready AS ready, pg_get_indexdef(i.indexrelid) AS definition
            FROM pg_index i
            WHERE i.indexrelid = to_regclass('public.file_range_mapping_season')
              AND i.indrelid = 'public.file_range_mapping_proofs'::regclass`;
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ valid: true, ready: true });
        expect(rows[0].definition).toContain('USING btree (season_id)');
    });

    it('classifies every column that could hold a media_items id', async () => {
        const rows = await getTestDb()<{ key: string }[]>`
            SELECT c.table_name || '.' || c.column_name AS key
            FROM information_schema.columns c
            JOIN pg_class rel ON rel.relname = c.table_name
                AND rel.relnamespace = 'public'::regnamespace
                AND rel.relkind IN ('r', 'p') AND NOT rel.relispartition
            WHERE c.table_schema = 'public'
              AND ((c.table_name = 'admin_media_change_receipts' AND c.column_name IN ('before_state','after_state','owner'))
                   OR (c.table_name = 'quarantine_dispositions' AND c.column_name = 'previous_warning')
                   OR c.udt_name IN ('uuid', '_uuid')
                   OR (c.data_type IN ('text', 'character varying')
                       AND (c.column_name ~ '(media_id|item_id|series_id|episode_id)$'
                            OR c.column_name = 'target_id')))
              -- A foreign key names its target; a single-column primary key is the row's own id.
              AND NOT EXISTS (
                  SELECT 1 FROM pg_constraint k
                  JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = ANY(k.conkey)
                  WHERE k.conrelid = rel.oid AND a.attname = c.column_name
                    AND (k.contype = 'f' OR (k.contype = 'p' AND cardinality(k.conkey) = 1))
              )
            ORDER BY 1
        `;
        const keys = rows.map((r) => r.key);
        const unclassified = keys.filter(
            (k) =>
                !MEDIA_ITEM_FK_CLASSIFICATION[k] &&
                !NO_FK_MEDIA_REFERENCES[k] &&
                !NOT_MEDIA_ID_COLUMNS[k],
        );
        expect(unclassified).toEqual([]);
        expect(Object.keys(NOT_MEDIA_ID_COLUMNS).filter((k) => !keys.includes(k))).toEqual([]);
    });
});

// -------------------------------------------------------------------------
// Two real connections: a writer racing the delete. Fixtures are committed
// (a second connection cannot see an uncommitted outer transaction) and
// removed afterwards.
// -------------------------------------------------------------------------

describe('never-owned media GC: concurrent writers', () => {
    let owner: string;
    const created: string[] = [];

    beforeAll(async () => {
        db = getTestDb();
        owner = crypto.randomUUID();
        await db`INSERT INTO users (id, username) VALUES (${owner}, ${owner})`;
        await db`INSERT INTO user_profiles (user_id) VALUES (${owner})`;
    });
    afterAll(async () => {
        // Leaves first; the cascade removes ratings and playlist entries.
        const rows = await db<{ id: string; depth: number }[]>`
            WITH RECURSIVE t(id, depth) AS (
                SELECT id, 0 FROM media_items WHERE id = ANY(${created}::uuid[])
                UNION SELECT c.id, t.depth + 1 FROM media_items c JOIN t ON c.parent_id = t.id
            ) SELECT id::text AS id, MAX(depth)::int AS depth FROM t GROUP BY id ORDER BY 2 DESC
        `;
        for (const r of rows) await db`DELETE FROM media_items WHERE id = ${r.id}`;
        await db`DELETE FROM users WHERE id = ${owner}`;
        await closeTestDb();
    });

    async function committedSeries(): Promise<SeriesFx> {
        const s = await series(db);
        created.push(s.root);
        return s;
    }

    const writers: {
        name: string;
        write: (sql: postgres.Sql, id: string, user: string) => Promise<unknown>;
    }[] = [
        {
            name: 'rating',
            write: (sql, id, user) =>
                sql`INSERT INTO user_ratings (media_id, user_id, rating) VALUES (${id}, ${user}, 6)`,
        },
        {
            name: 'playlist entry',
            write: async (sql, id, user) => {
                const [p] = await sql<{ id: number }[]>`
                    INSERT INTO playlists (user_id, name) VALUES (${user}, ${'race ' + id}) RETURNING id
                `;
                await sql`INSERT INTO playlist_items (playlist_id, media_id, title, position) VALUES (${p.id}, ${id}, 'race', 0)`;
            },
        },
    ];

    it.each(writers)(
        'an uncommitted $name on a member makes the delete wait out and skip',
        async ({ write }) => {
            const s = await committedSeries();
            const a = await db.reserve();
            const b = await db.reserve();
            try {
                const selected = await evaluateRoot(b as unknown as postgres.Sql, s.root);
                expect(selected.candidates.map((c) => c.id)).toEqual([s.root]);
                await a`BEGIN`;
                await write(a as unknown as postgres.Sql, s.episodes[1], owner);
                const outcome = await deleteNeverOwnedUnit(
                    b as unknown as postgres.Sql,
                    { id: s.root, kind: 'series' },
                    { minAgeDays: MIN_AGE },
                );
                expect(outcome).toEqual({
                    deleted: false,
                    skipReason: 'concurrent-reference-or-library-write',
                });
                await a`COMMIT`;
                // Now committed: the next attempt sees the reference and keeps the unit.
                expect(
                    await deleteNeverOwnedUnit(
                        b as unknown as postgres.Sql,
                        { id: s.root, kind: 'series' },
                        { minAgeDays: MIN_AGE },
                    ),
                ).toEqual({ deleted: false, skipReason: 'eligibility-changed' });
                expect(
                    await exists(db, [s.root, ...s.seasons, ...s.episodes, s.extra]),
                ).toHaveLength(7);
            } finally {
                await a`ROLLBACK`.catch(() => undefined);
                a.release();
                b.release();
            }
        },
        30_000,
    );

    it('a delete count mismatch rolls the whole unit back', async () => {
        const m = await movie(db);
        created.push(m.root);
        await db`INSERT INTO provider_metadata (media_id, provider, metadata)
            VALUES (${m.root}, 'tmdb', '{"title":"rollback"}'::jsonb)`;
        // A trigger that silently keeps one member makes the level delete return fewer rows.
        if (!/^[0-9a-f-]{36}$/.test(m.extra)) throw new Error('unexpected id');
        await db.unsafe(`CREATE FUNCTION gc_test_keep_row() RETURNS trigger LANGUAGE plpgsql AS
            $fn$ BEGIN RETURN NULL; END $fn$`);
        await db.unsafe(`CREATE TRIGGER gc_test_keep_row BEFORE DELETE ON media_items FOR EACH ROW
            WHEN (OLD.id = '${m.extra}'::uuid) EXECUTE FUNCTION gc_test_keep_row()`);
        try {
            const outcome = await deleteNeverOwnedUnit(
                db,
                { id: m.root, kind: 'movie' },
                { minAgeDays: MIN_AGE },
            );
            expect(outcome).toEqual({ deleted: false, skipReason: 'unit-changed' });
            expect(await exists(db, [m.root, m.extra])).toHaveLength(2);
            const [pm] = await db<{ n: number }[]>`
                SELECT COUNT(*)::int AS n FROM provider_metadata WHERE media_id = ${m.root}
            `;
            expect(pm.n).toBe(1);
        } finally {
            await db.unsafe('DROP TRIGGER IF EXISTS gc_test_keep_row ON media_items');
            await db.unsafe('DROP FUNCTION IF EXISTS gc_test_keep_row()');
        }
    });
});
