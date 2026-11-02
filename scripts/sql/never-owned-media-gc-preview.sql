-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
-- SPDX-License-Identifier: AGPL-3.0-only
--
-- Read-only preview of the never-owned media GC (task `never-owned-media-gc`):
-- how many movies/series units it would delete right now and why the rest are
-- kept. Same rules as src/lib/server/database/queries/never-owned-media-gc.queries.ts;
-- never-owned-media-gc.queries.integration.test.ts runs this file against the
-- same fixtures as the task and requires identical counts, so a rule changed
-- in one place and not the other fails CI.
--
-- One statement, no psql meta-commands. Minimum age: the 30 in `params` (the task never
-- uses less than 7). Discovery look-back: GREATEST(minimum age, 2 x the sweep's 14-day
-- re-stamp period), the 28 next to it.
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c 'SET default_transaction_read_only = on' \
--        -c 'SET statement_timeout = ''5min''' -f scripts/sql/never-owned-media-gc-preview.sql
--
-- Output rows:
--   kind      movie|series: n_units = eligible units, n_rows = rows in them,
--             n_seasons/n_episodes/n_extras, n_roots = never-owned roots old enough,
--             n_young = never-owned roots younger than the minimum age,
--             n_kept = evaluated units kept by at least one rule
--   rule      kept units per rule (a unit counts under every rule that holds it)
--   category  kept units per category

WITH RECURSIVE params AS (
    SELECT (NOW() - make_interval(days => 30)) AS cutoff,
           (NOW() - make_interval(days => GREATEST(30, 28))) AS discovery_cutoff
),
all_roots AS MATERIALIZED (
    SELECT mi.id,
           CASE WHEN mi.media_type = 'tv' THEN 'series' ELSE 'movie' END AS kind,
           mi.created_at,
           mi.created_at >= (SELECT cutoff FROM params) AS young
    FROM media_items mi
    WHERE mi.media_type IN ('movie', 'tv')
      AND mi.parent_id IS NULL
      AND mi.status = 'active'
      AND mi.has_files = false
      AND NOT (mi.files_lost_at IS NOT NULL
               OR mi.library_added_at IS NOT NULL
               OR mi.dismissed_content_hash IS NOT NULL)
),
roots AS MATERIALIZED (SELECT * FROM all_roots WHERE NOT young),
unit(root_id, id, depth, path) AS (
    SELECT r.id, r.id, 0, ARRAY[r.id] FROM roots r
    UNION ALL
    SELECT u.root_id, c.id, u.depth + 1, u.path || c.id
    FROM unit u JOIN media_items c ON c.parent_id = u.id
    WHERE u.depth < 64 AND c.id <> ALL(u.path)
),
members AS MATERIALIZED (
    SELECT u.root_id, u.id, u.depth, mi.media_type,
           (u.depth = 0
            OR (r.kind = 'movie' AND mi.media_type = 'extra')
            OR (r.kind = 'series' AND mi.media_type IN ('season', 'episode', 'extra'))) AS type_ok,
           CASE WHEN u.depth >= 64
                THEN EXISTS (SELECT 1 FROM media_items deeper
                             WHERE deeper.parent_id = u.id AND deeper.id <> ALL(u.path))
                ELSE false END AS truncated
    FROM unit u
    JOIN roots r ON r.id = u.root_id
    JOIN media_items mi ON mi.id = u.id
),
hits AS MATERIALIZED (
    -- Row state of the member itself.
    SELECT 'not-active'::text AS rule, 'catalog-state'::text AS category, mb.root_id
    FROM members mb JOIN media_items m ON m.id = mb.id WHERE m.status <> 'active'
    UNION ALL SELECT 'has-files', 'files', mb.root_id
    FROM members mb JOIN media_items m ON m.id = mb.id WHERE m.has_files
    UNION ALL SELECT 'formerly-owned', 'files', mb.root_id
    FROM members mb JOIN media_items m ON m.id = mb.id
    WHERE (m.files_lost_at IS NOT NULL OR m.library_added_at IS NOT NULL OR m.dismissed_content_hash IS NOT NULL)
    UNION ALL SELECT 'dismissed', 'curation', mb.root_id
    FROM members mb JOIN media_items m ON m.id = mb.id WHERE m.is_dismissed
    UNION ALL SELECT 'alias-row', 'catalog-state', mb.root_id
    FROM members mb JOIN media_items m ON m.id = mb.id WHERE m.canonical_id IS NOT NULL
    UNION ALL SELECT 'operator-curation', 'curation', mb.root_id
    FROM members mb JOIN media_items m ON m.id = mb.id
    WHERE NOT (
        m.metadata_locked = false
        AND (m.custom_poster_url IS NULL OR m.custom_poster_url = '/api/image/custom/' || m.id::text || '/poster')
        AND (m.custom_backdrop_url IS NULL OR m.custom_backdrop_url = '/api/image/custom/' || m.id::text || '/backdrop')
        AND (m.custom_logo_url IS NULL OR m.custom_logo_url = '/api/image/custom/' || m.id::text || '/logo')
        AND (m.custom_thumb_url IS NULL OR m.custom_thumb_url = '/api/image/custom/' || m.id::text || '/thumb')
        AND NOT EXISTS (SELECT 1 FROM image_candidates aw WHERE aw.media_item_id = m.id
                        AND (aw.remote_url LIKE 'admin:%' OR aw.chosen_by <> 'auto'))
    )
    UNION ALL SELECT 'young-member', 'catalog-state', mb.root_id
    FROM members mb JOIN media_items m ON m.id = mb.id WHERE m.created_at >= (SELECT cutoff FROM params)
    -- Still on the TMDB discovery lists: the sweep re-stamps listed titles every 14 days and
    -- would re-create a deleted one under a new UUID.
    UNION ALL SELECT 'recently-seen-by-discovery', 'discovery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM provider_metadata pm
                  WHERE pm.media_id = mb.id
                    AND CASE WHEN pm.metadata->>'discovery_detail_synced_at' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(Z|[+-][0-9:]+)$'
                             THEN (pm.metadata->>'discovery_detail_synced_at')::timestamptz >= (SELECT discovery_cutoff FROM params)
                             ELSE false END)
    -- Foreign keys classified `protect` (MEDIA_ITEM_FK_CLASSIFICATION).
    UNION ALL SELECT 'user_ratings.media_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM user_ratings r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'user_media_state.media_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM user_media_state r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'user_media_events.media_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM user_media_events r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'user_music_state.track_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM user_music_state r WHERE r.track_id = mb.id)
    UNION ALL SELECT 'music_listen_events.track_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM music_listen_events r WHERE r.track_id = mb.id)
    UNION ALL SELECT 'user_rate_skips.media_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM user_rate_skips r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'user_taste_dampers.media_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM user_taste_dampers r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'user_media_share_opt_out.media_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM user_media_share_opt_out r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'user_suggestions.media_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM user_suggestions r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'media_annotations.media_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM media_annotations r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'playlist_items.media_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM playlist_items r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'watchlist_activities.media_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM watchlist_activities r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'watch_history.media_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM watch_history r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'watch_state_sync_log.media_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM watch_state_sync_log r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'play_sessions.media_id', 'delivery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM play_sessions r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'playback_incident_events.media_id', 'delivery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM playback_incident_events r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'transcode_failure_events.media_id', 'delivery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM transcode_failure_events r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'download_renditions.media_item_id', 'delivery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM download_renditions r WHERE r.media_item_id = mb.id)
    UNION ALL SELECT 'hls_playback_tokens.catalog_media_item_id', 'delivery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM hls_playback_tokens r WHERE r.catalog_media_item_id = mb.id)
    UNION ALL SELECT 'media_added_pending.media_item_id', 'delivery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM media_added_pending r WHERE r.media_item_id = mb.id)
    UNION ALL SELECT 'upload_sessions.media_item_id', 'delivery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM upload_sessions r WHERE r.media_item_id = mb.id)
    UNION ALL SELECT 'training_assignments.media_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM training_assignments r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'course_modules.media_item_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM course_modules r WHERE r.media_item_id = mb.id)
    UNION ALL SELECT 'courses.cover_media_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM courses r WHERE r.cover_media_id = mb.id)
    UNION ALL SELECT 'sync_quarantine.expected_series_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM sync_quarantine r WHERE r.expected_series_id = mb.id)
    UNION ALL SELECT 'episode_reconciliation_moves.episode_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM episode_reconciliation_moves r WHERE r.episode_id = mb.id)
    UNION ALL SELECT 'library_availability.media_id', 'files', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM library_availability r WHERE r.media_id = mb.id AND r.available = true)
    UNION ALL SELECT 'series_episode_ordering.media_id', 'curation', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM series_episode_ordering r WHERE r.media_id = mb.id
                  AND COALESCE(r.ordering_source, 'manual') <> 'auto')
    UNION ALL SELECT 'admin_media_change_receipts.before_state', 'curation', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM admin_media_change_receipts r WHERE r.undone_at IS NULL
        AND r.kind LIKE 'file-mapping:%' AND (r.before_state->'ids') ? mb.id::text)
    UNION ALL SELECT 'admin_media_change_receipts.media_item_id', 'curation', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM admin_media_change_receipts r WHERE r.media_item_id = mb.id)
    UNION ALL SELECT 'media_artwork_suppressions.media_item_id', 'curation', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM media_artwork_suppressions r WHERE r.media_item_id = mb.id)
    UNION ALL SELECT 'music_edit_receipts.reference_ids', 'curation', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM music_edit_receipts r WHERE r.undone_at IS NULL AND r.reference_ids @> ARRAY[mb.id])
    UNION ALL SELECT 'music_edit_receipts.target_id', 'curation', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM music_edit_receipts r WHERE r.target_id = mb.id)
    UNION ALL SELECT 'personal_media_dispositions.media_id', 'curation', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM personal_media_dispositions r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'media_artwork.media_item_id', 'curation', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM media_artwork r WHERE r.media_item_id = mb.id AND r.remote_url LIKE 'admin:%')
    UNION ALL SELECT 'image_candidates.media_item_id', 'curation', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM image_candidates r WHERE r.media_item_id = mb.id
                  AND (r.chosen_by <> 'auto' OR r.remote_url LIKE 'admin:%'))
    UNION ALL SELECT 'media_file_items.media_item_id', 'files', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM media_file_items r WHERE r.media_item_id = mb.id)
    UNION ALL SELECT 'media_items.canonical_id', 'catalog-state', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM media_items r WHERE r.canonical_id = mb.id)
    UNION ALL SELECT 'livetv_channels.id', 'live-tv', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM livetv_channels r WHERE r.id = mb.id)
    UNION ALL SELECT 'cached_list_items.media_id', 'discovery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM cached_list_items r WHERE r.media_id = mb.id)
    -- Media ids without a foreign key (NO_FK_MEDIA_REFERENCES).
    UNION ALL SELECT 'interactions.target_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM interactions r WHERE r.target_type = 'media'
                  AND lower(replace(r.target_id, '-', '')) = replace(mb.id::text, '-', ''))
    UNION ALL SELECT 'interaction_reactions.target_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM interaction_reactions r WHERE r.target_type = 'media'
                  AND lower(replace(r.target_id, '-', '')) = replace(mb.id::text, '-', ''))
    UNION ALL SELECT 'user_media_flags.target_id', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM user_media_flags r
                  WHERE lower(replace(r.target_id, '-', '')) = replace(mb.id::text, '-', ''))
    UNION ALL SELECT 'watch_state_pending_resolution.internal_media_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM watch_state_pending_resolution r WHERE r.internal_media_id = mb.id)
    UNION ALL SELECT 'watch_sync_activity.media_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM watch_sync_activity r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'user_media_events_archive.media_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM user_media_events_archive r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'assistant_messages.context_media_ids', 'user-data', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM (SELECT unnest(r.context_media_ids) AS id FROM assistant_messages r) x
                  WHERE x.id = mb.id)
    UNION ALL SELECT 'client_diagnostics.media_id', 'delivery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM client_diagnostics r WHERE r.media_id = mb.id)
    UNION ALL SELECT 'active_transcode_jobs.item_id', 'delivery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM active_transcode_jobs r
                  WHERE lower(replace(r.item_id, '-', '')) = replace(mb.id::text, '-', ''))
    UNION ALL SELECT 'hls_playback_tokens.media_item_id', 'delivery', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM hls_playback_tokens r WHERE r.media_item_id = mb.id)
    UNION ALL SELECT 'episode_reconciliation_moves.series_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM episode_reconciliation_moves r WHERE r.series_id = mb.id)
    UNION ALL SELECT 'episode_reconciliation_moves.from_parent_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM episode_reconciliation_moves r WHERE r.from_parent_id = mb.id)
    UNION ALL SELECT 'episode_reconciliation_moves.to_parent_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM episode_reconciliation_moves r WHERE r.to_parent_id = mb.id)
    UNION ALL SELECT 'episode_reconciliation_moves.ghost_id', 'history', mb.root_id FROM members mb
    WHERE EXISTS (SELECT 1 FROM episode_reconciliation_moves r WHERE r.ghost_id = mb.id)
    -- Unit shape.
    UNION ALL SELECT 'unexpected-member-type', 'shape', mb.root_id FROM members mb WHERE NOT mb.type_ok
    UNION ALL SELECT 'too-deep', 'shape', mb.root_id FROM members mb WHERE mb.truncated
),
evaluated AS MATERIALIZED (
    SELECT r.id, r.kind,
           COUNT(*)::int AS members,
           COUNT(*) FILTER (WHERE mb.media_type = 'season')::int AS seasons,
           COUNT(*) FILTER (WHERE mb.media_type = 'episode')::int AS episodes,
           COUNT(*) FILTER (WHERE mb.media_type = 'extra')::int AS extras,
           NOT EXISTS (SELECT 1 FROM hits h WHERE h.root_id = r.id) AS no_hits,
           -- The task also applies the retention guard (mediaReferenceGuard). Every table in it
           -- is a rule above with the same predicate, so a unit fails it exactly when one of
           -- these rules holds it.
           EXISTS (SELECT 1 FROM hits h WHERE h.root_id = r.id AND h.rule IN (
               'user_ratings.media_id', 'user_suggestions.media_id', 'training_assignments.media_id',
               'course_modules.media_item_id', 'courses.cover_media_id', 'upload_sessions.media_item_id',
               'playback_incident_events.media_id', 'transcode_failure_events.media_id',
               'admin_media_change_receipts.media_item_id',
               'admin_media_change_receipts.before_state',
               'media_artwork_suppressions.media_item_id', 'playlist_items.media_id',
               'user_media_state.media_id', 'user_media_events.media_id',
               'user_media_events_archive.media_id', 'user_rate_skips.media_id',
               'user_taste_dampers.media_id', 'user_media_share_opt_out.media_id',
               'media_annotations.media_id', 'music_edit_receipts.target_id', 'music_edit_receipts.reference_ids', 'personal_media_dispositions.media_id', 'watch_history.media_id',
               'watch_state_pending_resolution.internal_media_id', 'watchlist_activities.media_id',
               'play_sessions.media_id', 'watch_state_sync_log.media_id', 'watch_sync_activity.media_id',
               'user_music_state.track_id', 'music_listen_events.track_id',
               'library_availability.media_id', 'series_episode_ordering.media_id',
               'interactions.target_id', 'interaction_reactions.target_id', 'user_media_flags.target_id'
           )) AS guard_fail
    FROM roots r
    JOIN members mb ON mb.root_id = r.id
    GROUP BY r.id, r.kind
),
judged AS MATERIALIZED (
    SELECT e.*, e.members <= 5000 AS size_ok,
           (e.no_hits AND NOT e.guard_fail AND e.members <= 5000) AS ok
    FROM evaluated e
),
unit_rules AS (
    SELECT h.rule, h.category, h.root_id FROM hits h
    UNION ALL SELECT 'retention-reference-guard', 'user-data', j.id FROM judged j WHERE j.guard_fail
    UNION ALL SELECT 'oversized', 'shape', j.id FROM judged j WHERE NOT j.size_ok
)
SELECT 'kind'::text AS row_type, k.kind AS name,
       (SELECT COUNT(*) FROM judged j WHERE j.kind = k.kind AND j.ok)::int AS n_units,
       (SELECT COUNT(*) FROM all_roots a WHERE a.kind = k.kind AND NOT a.young)::int AS n_roots,
       (SELECT COUNT(*) FROM all_roots a WHERE a.kind = k.kind AND a.young)::int AS n_young,
       (SELECT COALESCE(SUM(j.members), 0) FROM judged j WHERE j.kind = k.kind AND j.ok)::int AS n_rows,
       (SELECT COALESCE(SUM(j.seasons), 0) FROM judged j WHERE j.kind = k.kind AND j.ok)::int AS n_seasons,
       (SELECT COALESCE(SUM(j.episodes), 0) FROM judged j WHERE j.kind = k.kind AND j.ok)::int AS n_episodes,
       (SELECT COALESCE(SUM(j.extras), 0) FROM judged j WHERE j.kind = k.kind AND j.ok)::int AS n_extras,
       (SELECT COUNT(*) FROM judged j WHERE j.kind = k.kind AND NOT j.ok)::int AS n_kept
FROM (VALUES ('movie'), ('series')) k(kind)
UNION ALL
SELECT 'rule', ur.rule, COUNT(DISTINCT ur.root_id)::int, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM unit_rules ur GROUP BY ur.rule
UNION ALL
SELECT 'category', ur.category, COUNT(DISTINCT ur.root_id)::int, NULL, NULL, NULL, NULL, NULL, NULL, NULL
FROM unit_rules ur GROUP BY ur.category
ORDER BY 1, 3 DESC, 2;
