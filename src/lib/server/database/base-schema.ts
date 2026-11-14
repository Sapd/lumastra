// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Base Schema — full squashed schema snapshot for fresh installations.
// Source: schema-only pg_dump of a fresh DB migrated through the FULL pipeline (former base
// 16.302.0 + migrations 16.303.0..16.467.0), captured 2026-11-01 and encoded as a string in
// base-schema-sql.ts. So this snapshot equals the schema at migration 16.467.0 (the
// BASE_SCHEMA_VERSION). Every historical migration through 16.467.0 was squashed into this
// snapshot (their migration files were removed — see git history for
// original content); everything <= BASE_SCHEMA_VERSION is treated as already applied via
// the version watermark, with no enumerated list. On an existing database this
// base schema is skipped entirely; only migrations newer than BASE_SCHEMA_VERSION run, and
// an existing database whose watermark is BELOW BASE_SCHEMA_VERSION refuses to boot
// (migration-system.ts): the folded migrations no longer exist to bring it up.
// Equivalence was verified: a fresh DB built from this base alone == a fresh DB built from
// the old base 16.302.0 + all 91 migrations 16.303.0..16.467.0 (schema-only pg_dump diff empty).
//
// Embedding vector widths: the configurable text-embedding columns carry an
// __EMBEDDING_DIM__ placeholder rewritten to the configured dimension at apply time
// (baseSchemaUp); the fixed CLAP/MSCLAP columns stay vector(1024).
//
// Seed rows: --schema-only drops table data, so the rows a fresh install cannot boot
// without are re-appended to the end of BASE_SCHEMA_SQL as idempotent statements — the
// system access_groups 'admins' cohort, the six onboarding_state checklist steps, the
// canonical "Various Artists" artist row, and the singleton sync_state,
// album_split_health_cursor and image_selection_policy rows. Any future migration that seeds a row must have
// that row folded in here at the next squash; the check is "which tables are non-empty on a
// freshly-migrated DB", not "which migrations look like seeds".

/*
 * Example names are fictional; production shapes and measurements are retained.
 * BASE SCHEMA RATIONALE — why the schema is shaped this way.
 * Curated design notes (not a changelog). Versions cited only where they add context.
 *
 * ============================================================================
 * MEDIA HIERARCHY & ITEMS
 * ============================================================================
 * - Hierarchy is series → season → episode. An episode's parent_id is the
 *   SEASON, so resolving series identity needs TWO hops (episode→season→series);
 *   a single-level join wrongly yields season titles like "Staffel 3".
 * - media_type column stores LOWERCASE ('movie','tv','episode','season',
 *   'artist','album','track','tvchannel'). External IDs (TMDB/IMDB) are NOT
 *   unique across types, so external_ids uniqueness is (media_id, provider,
 *   media_type) and lookups MUST include media_type.
 * - Music uses explicit artist/album/track types, never an overloaded
 *   'music'/'audio'. The cutover purged old rows via FK CASCADE.
 * - Runtime dedup constraints for the scanner: partial UNIQUE
 *   (parent_id, season_number) and (parent_id, season_number, episode_number),
 *   WHERE media_type matches + keys NOT NULL. The partial WHERE MUST match the
 *   ON CONFLICT clause exactly or upserts won't use the index. Music adds
 *   partial UNIQUE on normalized artist name and (album parent, lower title) so
 *   find-or-create ON CONFLICT has a real arbiter (without it concurrent scan
 *   workers race-created 9 "David Vale" rows in 8ms). All partial on
 *   status='active' to ignore soft-deletes.
 * - canonical_id self-FK is ON DELETE SET NULL (don't block deletes; dependents
 *   just lose the pointer).
 * - title is NULLABLE: edition-sibling rows were once thin (title/year NULLed
 *   when equal to primary, read queries COALESCE through to primary). Edition
 *   modeling has since collapsed onto media_file_items.label — do NOT
 *   reintroduce per-edition media_items rows or edition_of.
 * - is_dismissed persists unmatched-file rejections across re-scans.
 *   dismissed_content_hash snapshots the last head-hash on the item (media_files
 *   cascades away before the rename 'add' event fires, so this is the only
 *   surviving fingerprint); dismissed_at bounds the reclaim window so a chance
 *   64KB head-hash collision can't resurrect an old dismissal.
 * - age_rating is a cached numeric derived from certification (numeric provider
 *   data beats string certs), used by the per-user age gate.
 * - title_binding ('position'|'identity', CHECK) records HOW an episode title
 *   was bound — positional S/E vs content-matched external_id — so downstream
 *   code can trust identity over fragile positional titles.
 * - library_added_at is separate from created_at/updated_at so "recently added"
 *   tracks file add/replace, not metadata refreshes (index COALESCEs to
 *   created_at, partial: active + top-level + has_files).
 * - library_group_id denormalized from the EARLIEST media_file (deterministic
 *   for multi-file items); nullable FK ON DELETE SET NULL.
 * - sort_title is a normalized A-Z key (Hangul romanization, diacritic folding,
 *   article stripping) so CJK/Korean titles stop sorting after 'Z' under
 *   en_US.utf8; index uses text_pattern_ops to match ORDER BY COLLATE "C". App
 *   is the sole writer (no trigger).
 *
 * SEARCH (search_vector + expression indexes)
 * - FTS config is 'simple', NOT 'english': matches query tokenization and
 *   avoids stemming/discarding non-English (Korean/Japanese) tokens. Indexes
 *   title + english_title + original_title at weight A; folds custom_metadata
 *   JSONB values at weight D (makes non-entertainment library types
 *   searchable). Trigger fires on custom_metadata changes and MUST guard
 *   jsonb_each_text with jsonb_typeof()='object' (a scalar/array value else
 *   raises and breaks any insert/update of the row).
 * - Accent-insensitive search uses immutable_unaccent(): raw unaccent() is only
 *   STABLE (search_path-dependent) so the two-arg pinned-dict form is required
 *   to be IMMUTABLE in index exprs. Query side must unaccent too.
 * - german_digraph_fold() indexes titles under BOTH unaccent (ü→u) and digraph
 *   (ü→ue) forms so Müller/Muller/Mueller collapse; ASCII yields one form to
 *   avoid English false positives. Umlaut expansion precedes unaccent.
 * - Episode/series % (trigram) search uses partial GIN indexes that bake
 *   media_type='episode'/'tv' into the index — full-corpus indexes forced
 *   BitmapOr + lossy recheck before the type filter. Expressions are
 *   byte-identical to the search_vector exprs so the planner reuses them.
 * - idx_media_items_browse: functional index on LOWER(title), partial
 *   (status='active', has_files=true) for the A-Z browse hot path.
 * - media_files.absolute_episode is the absolute episode number parsed from the
 *   file NAME (NULL when the name has none). Absolute-numbering reconciliation
 *   treats it as strong evidence for which provider episode a file is. The
 *   bulk scan skips unchanged files, so the scanner keeps it current only for
 *   files it re-reads; the column is nullable with no default.
 * - media_items.title_source records WHERE a track title came from ('tag' |
 *   'filename'; NULL = not recorded, non-track, or an admin-typed title, which
 *   a rename clears). The music-hygiene "title from file name" finding used to
 *   re-derive four filename shapes per track with regexps (unindexable, and
 *   false-positive prone because nothing in the row said which branch ran); it
 *   now reads this column through a partial index
 *   (idx_media_items_track_title_from_filename, WHERE title_source='filename').
 * - natural_sort collation (ICU und-u-kn, numeric ordering): the admin media
 *   browser sorts titles with `COLLATE natural_sort` so "2" < "9" < "10" < "28"
 *   instead of the default digit-by-digit order. Deterministic, so equality
 *   semantics are unchanged; no index involved (it is a top-N in-memory sort).
 *   Needs an ICU-enabled Postgres.
 * - media_files "newest first" and NFC-path indexes: the /j Latest listing reads
 *   the N-th newest file without sorting all of media_files, and
 *   idx_media_files_file_path_nfc is an EXPRESSION index on
 *   normalize(file_path, NFC) so an NFD on-disk path (macOS) finds its NFC row;
 *   the query must use that exact expression. idx_media_items_top_level_live
 *   is partial over unmatched top-level items for the attention derive count.
 * - media_artwork.updated_at is "when the row last pointed at NEW bytes".
 *   Uploads write a fixed per-type file name, so file_path and created_at do
 *   not change on replacement; /j image tags hash the source and clients cache
 *   a tagged image for a year, so without a revision column a re-upload would
 *   keep its old tag. NULL on old rows (readers fall back to created_at) so no
 *   tag changes at deploy.
 * - user_media_flags muted/excluded series are keyed by catalog id
 *   (target_type='series'), not by name ('series_name'): title matching mutes
 *   the wrong same-titled show or none at all, and a name with a trailing year
 *   is the one substring-style match that identifies a single show.
 *
 * ============================================================================
 * MEDIA FILES, STREAMS, VERSIONS
 * ============================================================================
 * - media_files / media_file_items is M:N (not a file_path column): one file
 *   can hold many episodes and one episode can span many files (split rips).
 * - media_item_versions was MERGED into media_file_items (is_default/sort_order/
 *   label live there). Partial UNIQUE (media_item_id) WHERE is_default=true →
 *   at most one default; a DEFERRABLE INITIALLY DEFERRED constraint trigger
 *   blocks the ">=1 file but 0 defaults" case the index can't (deferred so
 *   multi-statement default-moves are OK at COMMIT).
 * - media_streams & episode_chapters are scoped to file_id (NOT NULL), so
 *   multi-version playback resolves audio/sub/video/chapters per physical file.
 *   media_streams uses replace-semantics (DELETE+INSERT on rescan) so it has NO
 *   updated_at. DV columns (dv_profile/level/bl_signal_compatibility_id) exist
 *   to emit correct HLS SUPPLEMENTAL-CODECS.
 * - All probe/stream metadata stored locally specifically to eliminate
 *   playback-time Jellyfin API calls (also trickplay_params, media_streams).
 * - file_hash_head = SHA-256 of first 64KB only; container headers change on any
 *   re-encode, so head-only hashing detects replacement even when mtime is
 *   unreliable (NFS).
 * - Probe/keyframe partial indexes (WHERE probed_at IS NULL etc.) order columns
 *   to match BOTH predicate and ORDER BY (created_at,id) so slice fetches are
 *   index-ordered scans with no Sort node / heap recheck.
 * - file_path needs a text_pattern_ops index: plain btree can't accelerate
 *   LIKE 'prefix/%' under non-C locale (en_US.UTF-8) — scanner prefix queries
 *   else seq-scan a 400k-row table.
 * - health_issues GIN is partial (WHERE NOT NULL) so the healthy majority stays
 *   out of the index.
 * - trickplay_params PK is (media_item_id, file_id, width): one tile-set per
 *   resolution per file (was item-scoped, so multi-version items shared a row).
 *   Stale source='jellyfin'/'local' rows (metadata without thumbnail files) made
 *   items look analyzed and skipped local regeneration.
 *
 * ============================================================================
 * EMBEDDINGS / AI
 * ============================================================================
 * - media_embeddings.source ∈ {'library','discovery','music'} (renamed from
 *   legacy 'jellyfin'/'jellyseerr'). Per-source partial HNSW indexes
 *   (m=16/ef_construction=100); music index added because rec queries
 *   seq-scanned the whole music set. HNSW updates incrementally on DELETE — no
 *   REINDEX needed.
 * - Library-source vectors are movies+TV only: episode/season vectors were
 *   dropped (49k+3k) since every consumer filters media_type IN('movie','tv');
 *   they only bloated the index.
 * - media_audio_embeddings / media_lyrics_embeddings: HNSW vector_cosine_ops.
 *   Embedding dimension is RESOLVED AT MIGRATION TIME from the configured text
 *   model (Voyage 1024 / OpenAI 1536) via resolveEffectiveEmbedding +
 *   sql.unsafe (DDL type exprs can't be parameterized) — not hard-coded. PK
 *   (media_id, model_id) = one vector per track per model version.
 * - media_audio_clusters PK (media_id, model_id) mirrors the embeddings PK
 *   (embeddings are source of truth; cluster row is just a label).
 * - media_audio_map_coords: 2D UMAP coords for the /music/map starfield.
 * - mood_vectors keyed UNIQUE(mood_key, model_id) so one mood carries vectors in
 *   two spaces (text=OpenAI for mood-recs, msclap=audio for sonic queue).
 * - media_external_groupings exists because external_ids' uniqueness can't
 *   express many episodes → one external entry (multi-cour anime: one MAL entry
 *   spans many episodes).
 *
 * ============================================================================
 * TASKS / PIPELINE / EVENTS
 * ============================================================================
 * - task_history UNIQUE(task_id) is load-bearing: insertTaskHistory's
 *   ON CONFLICT(task_id) upsert silently inserts a duplicate run per call
 *   without it. task_history_idempotency_key_unique is similarly load-bearing —
 *   the orchestrator catches 23505 by err.constraint_name === that exact string
 *   for TOCTOU dedup; the index is scoped to NON-TERMINAL states
 *   (pending/active/cancelling) so an old terminal row can't block re-enqueue
 *   forever. (Migration system keys on version only, so an index rename needs
 *   its own migration — bumping a checksum won't re-run.)
 * - cancel_requested_at lets the reconciler force-finalize runs wedged in
 *   'cancelling' INDEPENDENT of heartbeat: a lock-loss zombie keeps its
 *   heartbeat setInterval beating, defeating stale-heartbeat reclaim.
 * - task_history_dead_letter captures BullMQ audit events whose task_history
 *   write failed after retries (else a job shows 'running' forever); NO FK on
 *   task_id (target row may not exist yet). DLQ rows are ARCHIVED not deleted
 *   after 10 replays + 30d — payloads are forensic evidence; cleanup never
 *   auto-purges the archive.
 * - task_webhook_outbox UNIQUE is (hook_id, event_id) NOT (event_id) so one
 *   event fans out to multiple subscribers (an early build shipped the wrong
 *   single-column key and blocked multi-hook delivery).
 * - media_item_stage_state: canonical per-item × per-stage coverage (PK
 *   media_item_id + stage_id); stage_version_state holds observed
 *   processingVersion for boot-time version-bump invalidation. in-flight partial
 *   index MUST include ALL FIVE statuses (running/pending/failed_transient/
 *   failed_permanent/obsolete) or the planner seq-scans the EXISTS-IN(5).
 *   invalidateByEvent skips running rows, so invalidated_at is stamped to let
 *   the terminal writer demote a mid-run change to sweepable 'obsolete'.
 * - WARNING: bulk-INSERTing >5000 'pending' stage rows makes the sweep translate
 *   them into BullMQ enqueues, ramping queue depth + Valkey memory. Prefer a
 *   paced one-shot background task over bulk INSERT.
 * - Transactional outbox (event_outbox + triggers): triggers INSERT events in
 *   the same tx as the change; dispatcher drains via LISTEN/NOTIFY +
 *   FOR UPDATE SKIP LOCKED (drain index partial WHERE consumed_at IS NULL AND
 *   NOT dead_letter). The whole system is gated by the feature_flags row
 *   (DB triggers can't read Node env, so emit_pipeline_event short-circuits on
 *   the flag → inert until flipped). auto_requeue_count bounds auto-recovery of
 *   dead-lettered events from transient infra blips; manual Requeue resets it.
 * - media_items triggers emit item.created (ANY insert, excl. is_dismissed),
 *   item.dismissed (false→true edge only), metadata.changed, and
 *   became_playable (has_files non-true→true). These exist because scanner paths
 *   bypassed the app-layer hooks (afterCreated/afterDismissed), leaving items
 *   with no stage coverage / lingering coverage. metadata.changed on
 *   media_items only watches title/overview/runtime/year; genres/keywords live
 *   in provider_metadata, whose own trigger (provider='aggregated') gates emit
 *   on ONLY the JSONB fields createEmbeddingText consumes — a naive
 *   emit-on-write would re-embed the whole library (OpenAI $) each aggregate
 *   cycle. Cascade-delete from media_items SELECT-EXISTS the parent first so
 *   child triggers don't queue one no-op event per row (588k events → ~50h
 *   drain); live single-row deletes still see the parent and emit.
 * - FK cascade indexes: canonical_id (self SET NULL), user_media_events.media_id,
 *   provider_metadata.media_id needed leading-key indexes or each media_items
 *   DELETE seq-scanned the child per RI trigger (a 5000-row delete took >10min).
 * - skip_fileless_stages backfill: is_missing files count as "no usable file"
 *   (else has_file=true via EXISTS but the handler skips → stage pending forever).
 * - Durable task history (boot_recovery_log, audit_log,
 *   task_metrics_snapshot) lives in Postgres; liveness/heartbeats/leaders stay
 *   ephemeral in Valkey TTL keys. audit_log (source='subsystem') is coarse subsystem actions only
 *   (never per-job); metrics_snapshot is leader-gated trend samples (~5min, one
 *   row/interval/instance) so an OSS self-hoster without Prometheus still gets
 *   trend lines. All pruned to 30 days.
 * - integrity_violations (W6 scanner, surfaced at /api/admin/integrity): unique
 *   partial on (rule, COALESCE(media_id::text,'')) WHERE resolved_at IS NULL so
 *   re-runs upsert open findings instead of duplicating (COALESCE folds global
 *   NULL media_id to '').
 * - sync_quarantine captures inbound sync payloads refused for series-identity
 *   violations (episode's Jellyfin SeriesId resolves to a series whose TMDB id
 *   disagrees with its declared parent); UNIQUE(provider,external_id,media_type)
 *   so re-presented keys upsert.
 * - task_triggers: operator-set schedule rows per task (interval / daily /
 *   weekly / startup). No rows = the task keeps its declared schedule; with
 *   rows, next_fire_at is the earliest upcoming instant over them. The CHECKs
 *   are TWO-WAY on purpose (kind='interval' <=> every NOT NULL, daily/weekly
 *   <=> at NOT NULL, weekly <=> weekday NOT NULL) plus format checks on
 *   `at` (HH:MM) and `every` (duration string): a row the scheduler cannot
 *   interpret must fail loudly at write time, not make a task silently never
 *   fire. Replaces the old per-task cadence override that lived in
 *   plugin_settings.
 * - media_item_stage_state skipped-heal index (16.297.0): the stage-disposition
 *   heals select `stage_id = $1 AND status = 'skipped_permanent' AND
 *   skipped_reason = ANY($2) ORDER BY updated_at, media_item_id LIMIT n`, and
 *   nothing covered skipped_reason, so every call seq-scanned the table even
 *   for gate variants matching zero rows. Key order (stage_id, skipped_reason,
 *   updated_at, media_item_id) is query-shaped: reason second so a no-match
 *   probe is one index hit; media_item_id last as the ORDER BY tiebreak so the
 *   inner SELECT can be index-only; status is pinned by the partial predicate,
 *   so it is not a key column. The WHERE must keep matching those queries.
 * - media_item_stage_state queue-position index (16.230.0): the sweep claims
 *   ORDER BY next_eligible_at ASC NULLS FIRST, updated_at ASC, and the Item
 *   Health "N items ahead" count is a row-comparison range over the same
 *   pair. The index mirrors that order column-for-column with NULLS FIRST
 *   spelled out (a plain btree is NULLS LAST and would defeat the range
 *   scan); status is again pinned by the partial predicate, not a key.
 * - media_item_stage_state.declines / declines_since count decline streaks: a
 *   per-item task declining to run is reset to 'pending' with `attempt`
 *   UNCHANGED, so neither the attempt cap nor the wedge guard can see a
 *   60-second retry loop. `declines` is INTEGER, not smallint like `attempt`:
 *   a permanently rate-capped item declines forever by design, and a smallint
 *   would overflow on the hot write path.
 * - media_audio_embedding_state.attempts: a failed-attempt counter instead of
 *   a 'failed_permanent' status, so the write-off threshold stays a policy
 *   knob in the task and a track the decoder can never read stops being
 *   retried every sweep forever.
 * - episode_reconciliation_moves: the undo record for the absolute-numbering
 *   and season-structure reconciliation services, one row per episode moved,
 *   holding where it sat before/after and the title/overview/still it held.
 *   ghost_id, from_parent_id and to_parent_id carry NO FK: the ghost row is
 *   merged away by the apply and a season can be deleted later (undo checks
 *   the season still exists first). series_id is denormalised so the
 *   per-series list does not walk the parent chain of a row that has moved.
 *   episode_id is ON DELETE SET NULL, not CASCADE (16.300.0): the audit row
 *   must outlive the episode, and undoing such a row answers 'episode-gone'.
 *
 * ============================================================================
 * WATCH STATE & PLAY SESSIONS
 * ============================================================================
 * - Mutable user_watch_state was REPLACED by an append-only event log
 *   (user_media_events) + derived read model (user_media_state). Do NOT
 *   reintroduce user_watch_history or user_series_progress — watched status is
 *   user_media_state, series progress is computed at read time from the
 *   season/episode hierarchy. Backfill drops rows with no user intent
 *   (is_watched=false, resume=0, no first_watched_at).
 * - Stale-write protection: monotonic last_event_seq rejects out-of-order/retry
 *   writes; last_session_started_at is the cross-session tiebreaker so an OLDER
 *   tab/device can't overwrite a NEWER session's resume (NULL = accept any).
 *   idx_ume_lumastra_progress (partial: source=lumastra-player, progress, not
 *   repudiated) serves this hot path on every progress write.
 * - state_snapshot events + snapshot_state JSONB give the rebuilder a base case
 *   so it can skip walking full history (bounds rebuild cost as the log grows).
 * - session_elapsed_ms / highest_session_elapsed_ms track REAL playing time —
 *   distinct from resume_position (seek-to-50%-then-quit falsely passed the
 *   percent Continue-Watching gate). NULL falls back to the legacy
 *   position+percent heuristic; Jellyfin/migration rows backfilled with
 *   MAX(position_ms) as a coarse engagement floor.
 * - Near-end backfill: external clients (Infuse→Jellyfin) sometimes never send
 *   'played', leaving near-end resume with is_watched=false polluting Continue
 *   Watching forever; runtime-tiered thresholds heal it, falling back to
 *   updated_at (not NOW) so feeds don't show old completions as "just watched".
 * - pushed_to_providers text[] (replaces a synced_from dirty flag) with a
 *   partial GIN index for the "provider not yet in array" push scanner (a btree
 *   on the array would be useless).
 * - watch_state_sync_log is provider-agnostic, keyed (user,media,provider,
 *   direction), so multi-provider write-back is data not schema. Inbound pulls
 *   get their OWN tables: watch_state_pull_log (one cursor per user/provider,
 *   last_played_cursor short-circuits DESC pagination → O(new activity), NULL =
 *   full pull) and watch_state_pending_resolution (buffers items not yet
 *   resolvable to a UUID — before it, items were dropped AND the cursor advanced
 *   past them, losing history permanently).
 * - play_sessions: unified ephemeral session store for all sources.
 *   source_session_id is NULL for Lumastra (uses own id); partial UNIQUE
 *   (source, source_session_id) WHERE NOT NULL lets external pollers upsert
 *   without colliding. last_seen_at (distinct from last_heartbeat_at) drives the
 *   external-source reaper; Lumastra rows live/die by their own heartbeat.
 *   play_method CHECK is the 4-value enum (audio_transcode/full_transcode/...);
 *   legacy 'transcode' rows backfilled before the ALTER (and stream policies
 *   expanded to both transcode kinds). source CHECK now writes 'lumastra' (was
 *   'stellar'); retired sources 'abs'/'hybrid' dropped. file_id FK is
 *   ON DELETE SET NULL (not CASCADE) — sessions are user audit data worth
 *   keeping; NO ACTION was aborting file-scan cleanup batches.
 * - watch_history: media_id is canonical (provider_item_id dropped) but NULLABLE
 *   (the FK is ON DELETE SET NULL — NOT NULL contradicted it and broke M3U
 *   tvchannel re-import). title/source_service/series_name are nullable
 *   denormalized copies (series_name needs the two-hop episode→season→series
 *   resolve). bitrate_bps is bps not kbps; video_codec is video only. Trending
 *   index partial WHERE actual_watch_time_seconds>=300; stats/recent-activity
 *   covering indexes use the 60s floor and lead with user_id, while the
 *   cross-user admin-stats index leads with session_start_time DESC.
 * - source_play_session_id UNIQUE partial prevents duplicate rows from
 *   concurrent stop signals (doubles as the session lookup index).
 * - Telemetry FKs (playback_telemetry, playback_session_quality,
 *   active_transcode_jobs) are ON DELETE CASCADE off play_sessions.
 *   playback_session_quality unique on play_session_id is PARTIAL
 *   (WHERE NOT NULL) so the upsert resolves past legacy NULL rows. Per-session
 *   delivery percentiles feed only the per-session score; FLEET percentiles MUST
 *   be percentile_cont over raw telemetry (averaging per-session percentiles is
 *   invalid). scoring_model_version stamps the formula so queries never mix
 *   incomparable health scores. Rollups store sum_health_score + total_sessions
 *   so multi-day means are session-weighted SUM/SUM, not average-of-averages.
 *   active_transcode_jobs mode CHECK tightened to 'full' ('hybrid' retired).
 * - play_sessions.source answers "which system OWNS this playback" and gates
 *   behaviour (reaper thresholds, stream-limit exemption, /j freshness), so it
 *   only gets values that change behaviour: 'local' (bytes already on the
 *   device, exempt from the stream limit so a phone playing its own file does
 *   not use a family slot). Access surface (native vs /j vs Subsonic) is a
 *   SEPARATE column: adding a surface value to source would silently flip
 *   metering and freshness for every /j stream. play_method is likewise about
 *   delivery, and local playback delivers nothing.
 * - play_sessions.client_features is text[] (reads are membership tests), NULL
 *   vs '{}' load-bearing: NULL = the client never announced a list (every older
 *   build), '{}' = announced and supports none. It is a column, not a key in
 *   device_capabilities, because that blob is the planner's codec contract.
 * - active_transcode_jobs.play_session_id has NO FK to play_sessions: /j keys
 *   transcodes by the client's PlaySessionId, which is not a play_sessions.id.
 *   With the FK a /j job needed a stub play_sessions row (a second ACTIVE
 *   session counted against the stream limit), and without a row it could not
 *   be stopped, reaped or restored cross-pod. Row removal is by expiry and the
 *   users FK.
 *
 * ============================================================================
 * MUSIC / SONIC (state)
 * ============================================================================
 * - Music tracking is split out of user_watch_state: user_music_state
 *   (aggregated, fast read) + music_listen_events (append-only). Music rows had
 *   been leaking into user_watch_state and were purged.
 * - media_popularity: row presence = "fetched", absence = "never fetched" —
 *   drives tri-state smart-queue ranking (matched=real score, fetched-not-top=
 *   floor, unfetched=neutral 1.0). normalized_score meaning depends on
 *   score_context.
 * - Essentia analyzer outputs nest under custom_metadata->essentia (one JSON key
 *   to drop on "re-analyze everything" vs 16); the || merge guards
 *   jsonb_typeof='object'. Partial index on
 *   custom_metadata->essentia->>bpm makes the analyzed-track COUNT index-only.
 * - music_genre_tags: IMMUTABLE jsonb→text[] extractor + partial GIN
 *   (WHERE track) for @> containment; must replicate the old inline CASE
 *   byte-for-byte so the index matches query exprs (1108ms→28ms).
 *
 * ============================================================================
 * LIVE TV
 * ============================================================================
 * - A channel IS a tvchannel media_item: livetv_channels.id is the SAME UUID as
 *   media_items.id (PK is also FK ON DELETE CASCADE). Deleting the media_item
 *   drops the channel.
 * - Circular FK channels↔backup_groups resolved by adding
 *   backup_groups.primary_channel_id FK after both tables exist (deferred ALTER,
 *   guarded against duplicate_object).
 * - playlist_index is the IMMUTABLE source M3U position, split out of overloaded
 *   sort_order (which held import order AND wizard/display order); the wizard now
 *   derives sort_order from playlist_index and never mutates it, so "reset to
 *   source order" is always recoverable.
 * - livetv_categories.name is UNIQUE (channels reassigned to oldest category on
 *   duplicate name before the constraint).
 * - livetv_programs window index is (start_time, end_time): leading with
 *   end_time was non-selective in a future-heavy EPG, forcing seq scans for
 *   all-channel current/guide reads (13.9ms→0.56ms).
 *
 * ============================================================================
 * USERS / AUTH / IDENTITY
 * ============================================================================
 * - User-data tables key user_id on users.id (UUID), NOT the mutable username,
 *   so a username change can't orphan ratings/watch-state; username stays UNIQUE
 *   for login but is not an FK target. Intentional TEXT exceptions: sentinel
 *   rows (e.g. user_stream_policies '__default__', which therefore has NO FK),
 *   ephemeral hls tokens, attribution/actor columns.
 * - users.admin_pinned / max_age_rating use OIDC-authoritative-with-override:
 *   pinned=false re-syncs from OIDC every request; pinned=true freezes the
 *   manual value.
 * - user_identities keys federated login on stable (provider, subject) not
 *   username; OIDC provider is issuer-scoped 'oidc:sha256(issuer)' so two IdPs
 *   can't collide on sub. email_verified gates account-linking (never link on
 *   unverified email — admin-takeover vector). UNIQUE(provider, user_id) = one
 *   link per provider.
 * - jellyfin_username NULL = use the Lumastra username (zero-config same-name);
 *   needed now that native+OIDC decouple the two usernames. jellyfin_user_id is
 *   a durable cross-replica UUID cache cleared when the override name changes.
 * - users.deleted_at soft-delete (PAT validation rejects tokens of deleted
 *   owners); disabled_at is a hard kill-switch blocking ALL auth incl.
 *   forward-auth (the per-request forward-auth upsert must NOT resurrect it).
 *   Both have partial WHERE-NOT-NULL indexes.
 * - password_updated_at revokes sessions older than the last password change.
 *   user_sessions store SHA-256-hashed opaque tokens, replica-shared (no sticky
 *   sessions); oidc_iss/sub/sid are NULL for native sessions (partial indexes
 *   WHERE NOT NULL back Back-Channel Logout lookup). Native login is AGPL-core
 *   and never cross-reads the /j password store.
 * - service_tokens.act_as_user FK is ON DELETE CASCADE (not SET NULL): NULL
 *   act_as_user means full-admin, so orphaning on user delete = silent privesc.
 *   force_non_admin pins isAdmin=false even if the impersonated user is later
 *   promoted.
 * - personal_access_tokens.allowed_ips / service_tokens IP gate: text[], NULL =
 *   any IP; enforcement lives in the service layer, not the DB.
 * - oauth_refresh_tokens.token→token_hash signals SHA-256-at-rest.
 *   jellyfin_client_passwords.password_hash widened VARCHAR(64)→TEXT for
 *   self-describing scrypt hashes (old SHA-256 hashes stop verifying; clients
 *   re-pair). hls_playback_tokens link parent_token_hash to the issuing PAT so
 *   revocation cascades (partial WHERE NOT NULL); is_wildcard boolean replaces
 *   the old 'music:*' sentinel.
 * - license_install is a singleton (BOOLEAN PK + CHECK) per-DEPLOYMENT install
 *   UUID shared across replicas (not per-INSTANCE_ID) — one install per deploy
 *   to the license server. Identity only; enforcement is in optional modules.
 * - setup_lock is a single-row table (id = 1 CHECK) recording that first-run
 *   setup completed, so adminExists() keeps answering "done" even when no admin
 *   can be found (an IdP-side demotion or group rename must not reopen the
 *   public setup endpoints). Written by every admin-bootstrap path, removed
 *   only by the operator's SETUP_UNLOCK recovery. completed_by is ON DELETE SET
 *   NULL, never CASCADE: erasing that account must not unlock setup.
 * - personal_access_tokens/service_tokens.force_non_admin is the demotion
 *   kill-switch. force_non_admin_narrowed_at (NULL = "not narrowed by
 *   demotion") tells a flag OUR demotion handling set apart from one an
 *   operator chose at mint time, so promotion never un-sandboxes a token an
 *   operator deliberately locked down. service_tokens also carries
 *   force_non_admin_narrowed_by_target / _by_creator: one token can be
 *   narrowed for two independent reasons (impersonation target demoted,
 *   creator demoted), and the restore must clear only the reason matching the
 *   party being re-promoted, flipping force_non_admin back only when BOTH are
 *   clear. These two are plain NOT NULL booleans, unlike the nullable stamp.
 * - service_tokens.created_via_token_id records which service token minted a
 *   token (audit). created_by of a minted token is the minter's OWNER, never
 *   the caller's `service:<name>` principal, which is no user and would fail
 *   the creator-active check on every request.
 * - audit_log.principal_kind / credential_id attribute an action to the exact
 *   credential (PAT id, service-token id, session id, ...) rather than only the
 *   username it authenticated as. principal_kind is plain text, not a SQL enum,
 *   so it cannot drift from the PrincipalKind union. Nullable: legacy rows and
 *   the bare-string auditLog() form have neither.
 * - hls_playback_tokens' valid_ended_reason CHECK must list every reason the
 *   service writes, including 'parent_pat_revoked' and
 *   'parent_pat_revoked_sweep'; an unlisted reason fails the UPDATE and a PAT
 *   revoke would leave its stream tokens valid.
 * - hls_playback_tokens.minted_by_admin records whether the MINTING principal
 *   had real admin capability; it is honoured on use only while the owner is
 *   still an admin. Stream tokens carry no admin grant of their own (the
 *   owner's flag must not leak into a scoped credential), which left an admin
 *   outside a restricted library group able to open an item but not stream it.
 *   Default false: tokens minted before the column existed stay non-admin, and
 *   a refresh copies the flag rather than re-deriving it.
 * - users.notification_forwarding is the user's CONSENT for forwarding their
 *   notifications to operator webhooks; default false, since an operator
 *   subscribing a hook is not consent from the people it would receive.
 * - users.idp_avatar* is stored apart from the uploaded avatar_data (the sync
 *   runs on every OIDC sign-in and must not overwrite an upload); serve chain
 *   is upload, IdP, Jellyfin, Gravatar. idp_avatar_source is a sha256 of the
 *   claim, also set when the picture was rejected so it is not refetched on
 *   every sign-in.
 *
 * ============================================================================
 * LIBRARIES & PERMISSIONS
 * ============================================================================
 * - library_paths.library_group_id groups multiple paths into one logical
 *   library; edition_label auto-tags files from a path. media_files.
 *   library_group_id is denormalized from longest-prefix match of file_path
 *   against library_paths.path for efficient permission JOINs.
 * - library_group_permissions: no row OR empty allowed_groups both mean
 *   unrestricted. library_groups FK actions are deliberately MIXED:
 *   library_paths=RESTRICT (don't lose a configured path), permissions=CASCADE,
 *   media_files=SET NULL (orphaned media survives group deletion).
 * - Library-access EXISTS subquery is made index-only on BOTH sides:
 *   media_file_items (media_item_id) INCLUDE (file_id) + media_files (id)
 *   INCLUDE (library_group_id). Unrestricted users get an empty filter fragment.
 *
 * ============================================================================
 * USER SIGNALS / RECS / MISC
 * ============================================================================
 * - episode_orderings is the authoritative store of standard numbering
 *   (original_season/episode_number) written by metadata sync; the old
 *   mutation-based "apply ordering" overwrote media_items numbers and was
 *   reverted from it. order_episode_number..._end renders merged multi-episode
 *   files ("E1-E2"), detected via the ' / ' title pattern.
 * - episode_chapters scoped to file_id (markers follow the selected version);
 *   legacy item-scoped fallback supported via a second partial-unique index
 *   WHERE file_id IS NULL.
 * - media_artwork uniqueness keys on COALESCE(language,'') so multi-language
 *   artwork coexists while NULL languages collide as one slot.
 * - user_suggestions library/discovery_similarity_score (renamed from
 *   jellyfin/jellyseerr) hold cosine sim from library vs discovery embeddings.
 *   index folds expires_at in so the expiry filter is index-only.
 * - user_ratings (user_id, rating) serves both rating<=4 and >=7 ranges;
 *   user_music_state partial (user_id, last_played_at DESC) WHERE
 *   complete_count>0 also satisfies the For-You ORDER BY.
 * - user_media_flags: expires_at NULL=permanent, non-NULL=TTL (filtered as a
 *   cheap residual since now() is volatile and disallowed in index predicates).
 *   Replaces per-device localStorage trackers so dedup spans devices.
 *   idx_umf_dismissed_cw (user_id, target_id) makes the CW/NU NOT EXISTS probe
 *   index-only (the generic active-lookup index lacks target_id).
 * - user_section_feedback counters are per-section-TYPE not per-item by design
 *   (signal = does the user engage with a category); telemetry-only so far.
 * - user_playback_preferences: subtitle_track_hint stores {language,isForced,
 *   codec} because a language code alone is ambiguous (SRT vs forced PGS).
 *   Audio is two-tier: audio_language is explicit Tier-1 (always wins);
 *   last_audio_language is Tier-2 learned (player writes here so it can't
 *   clobber the explicit setting).
 * - plugin_user_credentials: one generic table for per-user OAuth across all
 *   plugins, UNIQUE(user_id, plugin_id) — avoids a table per provider.
 *   plugin_analysis_log tracks per-plugin per-media analysis regardless of
 *   output so backlog plugins don't reselect the same empty episodes;
 *   processing_version bump invalidates prior analyses.
 * - onboarding_state is system-wide (no user column), keyed by step_key.
 * - user_notification_dismissals keyed by composite_key (tmdb:id:type) with NO
 *   media_items FK so request-popup dismissals persist for items not yet in the
 *   catalog, cross-browser.
 * - cluster_node_events stores only online/offline transitions (live state is
 *   in Valkey TTL keys; this is the historical timeline).
 * - admin_attention_alerts: stable id + separate fingerprint so an operator ack
 *   only sticks while the incident is unchanged. count/acked_count implement
 *   watermark acks (count-bearing alerts re-surface only when count grows past
 *   the acked level; scalar alerts use fingerprint ack). snoozed_until is
 *   time-boxed suppression distinct from ack; the resolved_at partial index
 *   serves both history ORDER BY and the retention sweep.
 * - assistant_rate_limits: daily limit is a TOKEN budget (tokens_used), not
 *   message_count — one tool-calling message costs 5-8x a simple one, so a flat
 *   counter under/over-limits. message_count kept informational.
 * - the watchlist is a SYSTEM PLAYLIST (playlists.playlist_type='watchlist',
 *   is_system=true, one per user via the partial unique index
 *   playlists_one_watchlist_per_user), replacing the user_watchlist table
 *   (dropped 16.260.0). Watchlist rows hold the series row itself with NULL
 *   season/episode, because a non-NULL season would let one media_id occupy two
 *   rows under the playlist_items unique-media index and fan out /j IsFavorite
 *   joins. The partial index's predicate must be repeated verbatim in
 *   ensureWatchlistPlaylist's ON CONFLICT clause or inference fails.
 * - playlists.created_by_plugin records which plugin created a playlist (NULL =
 *   a person made it). replaceItems is a transactional delete+refill with no
 *   undo, so provenance is what lets it refuse a plugin holding a stale id
 *   against a user's hand-curated list.
 *
 * ============================================================================
 * METADATA PROJECTIONS (media_genres / media_scalars / media_keywords)
 * ============================================================================
 * - Genres, typed scalars (ratings/runtime/dates/etc.) and keywords all live
 *   inside provider_metadata.metadata — a multi-KB, heavily-TOASTed JSONB. Every
 *   genre/scalar/keyword-driven query (browse, ForYou, stats) had to detoast that
 *   blob per row to read a tiny field. These three tables project those fields
 *   into small, natively-typed, directly-indexable tables. They mirror the proven
 *   media_people projection: rows are PER PROVIDER (source), so the READ query
 *   keeps owning the provider-priority pick (no env-vs-DB split-brain). Each is
 *   kept correct in real time by AFTER INSERT/UPDATE(metadata,provider) + AFTER
 *   DELETE triggers on provider_metadata that DELETE the (media_id, source) slice
 *   and re-INSERT from the new metadata — whichever of the 8+ writers did the
 *   write. Population is task-system-agnostic: the initial state was backfilled
 *   inside the migration, so the table is never observed empty.
 * - media_genres: genre_id is the universal PK key because genres appear in BOTH
 *   encodings — object [{"id":35,"name":"Comedy"}] (native tmdb) and scalar [35]
 *   (metadata-sync). genre_name is the localized display name (present for object
 *   rows, NULL for scalar); name carousels read genre_name IS NOT NULL, ForYou/
 *   stats read genre_id. Scalar ids are deliberately NOT resolved to names (names
 *   are provider-localized). DISTINCT ON (genre_id) collapses repeats so a single
 *   array can't hit ON CONFLICT twice in one command.
 * - media_scalars: ONE row per (media_id, source). Casts are regex-guarded and
 *   write typed NULL for malformed values so a ''/'N/A' can neither abort a btree
 *   build nor error the trigger (which would break ingestion); the numeric guard
 *   uses a [.] class (never \\.) so it survives JS-template + SQL-string escaping.
 *   media_scalars_safe_date swallows calendar-invalid-but-format-valid dates
 *   (e.g. '1994-99-99') to NULL rather than aborting the write.
 * - media_keywords: both keyword arrays projected as lowercased+trimmed rows
 *   (keyword_type 'mdblist'|'plain'), SELECT DISTINCT so a repeated keyword can't
 *   hit the PK twice; membership filters become an index join on
 *   (keyword_type, keyword) instead of a per-row array unnest + LOWER().
 * - upcoming_releases: a purpose-built projection of the Sonarr/Radarr calendar,
 *   NOT part of the catalog — it holds no UUIDs, is never joined into browse /
 *   search / For-You / embeddings, and carries no user data. release-calendar-sync
 *   upserts the calendar window every 6h; the DB-backed calendar reads catalog
 *   rows as before and gap-fills from this table for monitored-but-not-yet-owned
 *   titles (which the phantom-series gate forbids materializing into media_items).
 *   When a title is later ingested, the catalog side starts matching it and the
 *   gap-fill row is naturally superseded — self-reconciling, no cleanup.
 *   (source, source_item_id) is the upsert idempotency key.
 * - media_keywords_sync / media_genres_sync compute the DESIRED set and only
 *   delete rows that left it and insert rows that joined it. The old
 *   DELETE-all + re-INSERT rewrote every row on every metadata write even when
 *   nothing changed; with hundreds of keywords per title that left a steady
 *   dead-tuple stream, kept the visibility map incomplete and turned
 *   index-only scans (browse keyword counts) into heap fetches. Resulting
 *   contents are identical, including repair of drift on the next write.
 *   media_keywords also has a tighter autovacuum scale factor (2%) for the same
 *   reason. media_credits' trigger follows the same changed-rows-only pattern.
 * - media_people carries source='local' rows for MUSIC credits (featured and
 *   secondary artists, primary included). Search could only reach a track's
 *   primary artist via the parent chain; projecting credits into the existing
 *   trigram-indexed table reuses that index instead of tsvector-ing volatile
 *   credit data (which would reindex the FTS column on every credit edit).
 *   'local' keeps these rows off the provider slices' unique key. A track whose
 *   performer exists only as a raw display-artist tag gets that string
 *   projected WHOLE, and only when nothing resolvable was found: NEVER split
 *   it on separators ("&", "x", ",", ...), none are escaped, so a split
 *   confidently inserts wrong names. "Various Artists" is excluded by exact
 *   case-insensitive match.
 * - media_credits (role actor|writer|producer|studio) is a SEPARATE table from
 *   media_people because media_people feeds global search with no role filter;
 *   extra producer/studio rows there would change search results. It holds
 *   the full structured cast (media_people only has the capped flat list),
 *   plus provider_person_id/has_profile for actors. Person and studio ids for
 *   /j are DERIVED, not stored: person_key/studio_key =
 *   md5('person:'|'studio:' || lower(btrim(name)))::uuid, as SQL functions so
 *   Postgres is the only place that lowercases/trims. They are IMMUTABLE only
 *   while the database default collation stays put; moving a cluster to a
 *   different collation/ICU version means REINDEXing the three key indexes.
 *   media_credits_desired(metadata) defines the projection once and both the
 *   trigger and the backfill call it, so they cannot drift. Names over
 *   1000 bytes are skipped: the name is in the primary key and an oversized
 *   btree key would abort the provider_metadata write that fires the trigger.
 *
 * ============================================================================
 * BROWSE PROJECTIONS (media_item_quality / media_item_languages)
 * ============================================================================
 * - Both are denormalized projections that exist so /browse's QUALITY and A-Z
 *   language filters are index scans instead of per-row detours through
 *   media_streams. Their classification logic lives in IMMUTABLE SQL functions
 *   (quality_resolution_tier/quality_hdr_tier/quality_codec,
 *   normalize_track_language) precisely so the projection and any ad-hoc query
 *   cannot drift — the function IS the single source of truth, not the table.
 * - media_item_languages: movies and episodes carry their own file's languages;
 *   a SERIES row is a strict-majority rollup of its episodes, refreshed by
 *   refreshLanguagesForFile on probe. A series is therefore not the union of its
 *   episodes — a single oddly-tagged episode must not add a language to the show.
 * - media_item_quality also carries the accessibility flags (has_atmos et al).
 *   Do NOT call the live rebuild helper from a migration: the query module it
 *   lives in tracks the CURRENT schema, so a fresh install replaying history
 *   would call it against columns that don't exist yet at that point.
 *
 * ============================================================================
 * MULTILINGUAL METADATA (media_item_translations)
 * ============================================================================
 * - Per-language title/overview/tagline overlay selected by two per-user
 *   metadata-language preferences. `source` records provenance (TMDB pipeline vs
 *   manual override). Items with media_items.metadata_locked are EXCLUDED from
 *   the read overlay so a hand-edited title is never shadowed by a provider one.
 *
 * ============================================================================
 * WATCH SYNC (watch_sync_activity / watch_sync_preferences)
 * ============================================================================
 * - watch_sync_activity is the Settings → Connections feed: one row per
 *   pushed/pulled item with outcome + reason, bounded by a per-outcome-class cap
 *   pruned in database-cleanup (it is a feed, not a ledger).
 * - watch_sync_preferences is one row per (user, provider) holding direction
 *   ('both'|'pull'|'push') plus a push watermark. ABSENCE means the default —
 *   never backfill a row to express "default", or the default stops being live.
 *
 * ============================================================================
 * DEVICES, TOKENS & PUSH
 * ============================================================================
 * - user_devices owns a device's DISPLAY name, and exists because `device_name`
 *   previously meant three incompatible things: a display label
 *   (oauth_device_codes/oauth_refresh_tokens), a Jellyfin auth credential
 *   (user_provider_device_tokens.provider_device_binding — the exact string
 *   replayed in X-Emby-Authorization, immutable), and a user agent
 *   (play_sessions.user_agent — a snapshot). Display name resolves as
 *   COALESCE(custom_name, reported_name): the user override lives in its own
 *   column so "a client report must never clobber a user-chosen name" is a
 *   property of the schema rather than a conditional some writer can forget.
 * - There is deliberately NO FK on play_sessions.device_id: /j and /subsonic
 *   mint client-supplied device ids that never pass device registration, so a
 *   strict FK would turn a first playback from Infuse/Streamyfin into a 500.
 * - user_push_tokens is UNIQUE (token, bundle_id, environment), NOT per user: an
 *   APNs token is unique per app INSTALL. A device handed to another person
 *   re-registers the same token under a different account, and a per-user key
 *   would leave both rows active — pushing one person's activity to someone else.
 *   The triple makes reassignment the only representable outcome.
 * - user_push_outbox is a separate outbox rather than a third owner on
 *   task_webhook_outbox: push posts to ONE trusted relay with a relay token, its
 *   unit of work is a token set rather than a URL, and its backoff ladder is
 *   ~21 minutes against the webhook's 24 hours. Only the claim pattern is shared,
 *   and that was cheaper to copy than to abstract.
 * - oauth_refresh_tokens_deactivate_push is a DEFERRABLE INITIALLY DEFERRED
 *   constraint trigger so a same-transaction revoke-then-reissue
 *   (RefreshTokenService.rotate()) sees its own INSERT before the live-session
 *   check runs at COMMIT. Note the hazard documented in database/CLAUDE.md: only
 *   the BODY is deferred — the WHEN clause still evaluates at the row operation.
 *
 * ============================================================================
 * NOTIFICATIONS & BROADCASTS
 * ============================================================================
 * - user_notifications carries a GENERATED coalescing-subject column with a
 *   unique index giving one row per (user, kind, subject) per UTC day. A season
 *   landing at once raises becamePlayable ten times, and the outbox dispatcher
 *   drains in parallel across replicas — so only an index can promise this;
 *   handler logic is per-process and cannot. It is a generated column rather than
 *   an expression index over `payload` because payload is the CLIENT contract:
 *   its rendering fields must stay free to change without dragging an index key.
 * - media_items.files_lost_at exists because replacing a file is a DELETE then an
 *   INSERT, and file-delta-ingest processes every remove before any upsert. That
 *   walks has_files true→false→true and would re-announce a title the user has
 *   had for months. The stamp is read on the way back up: inside the six-hour
 *   grace this is the tail of a replacement, not an arrival, and nothing is sent.
 * - user_notification_webhooks is a SEPARATE table, not a nullable user_id on the
 *   operator hooks table. Ownership as a value means three existing readers must
 *   each remember a predicate they were written without — the admin list would
 *   render every user's private endpoint URL, and operator fan-out (which has no
 *   per-user axis at all) would deliver one user's events to another's endpoint.
 *   Both failures are silent. A separate table makes ownership a type.
 * - admin_broadcasts is NOT a durable twin of the `admin` session toast: that one
 *   is perishable by design (it addresses live play sessions, 60s window). This
 *   addresses PEOPLE — someone offline at send time still gets it — and fans out
 *   one ordinary user_notifications child row per recipient pointing back here.
 *
 * ============================================================================
 * FORENSIC FAILURE EVENTS
 * ============================================================================
 * - transcode_failure_events, livetv_stream_failure_events and
 *   playback_incident_events are one family: append-only, insert-only (so no
 *   cross-replica coordination), each closing a case where the evidence used to
 *   live only in a container's stdout or in memory and vanished on restart.
 * - FKs are ON DELETE SET NULL throughout: a failure record must OUTLIVE the
 *   media, job or session it refers to, or it stops being forensic.
 * - Live TV deliberately does not mirror the transcode column set — it has no
 *   job, no play session, no media_id and no argv. A failure belongs to a CHANNEL
 *   and must outlive it, so channel_id is plain TEXT with no FK.
 * - playback_incident_events is the one that carries user_id/device_id (the
 *   question is "what happened to user X"), which is a deliberate deviation with
 *   GDPR consequences. One row per FLUSHED INCIDENT, so row count scales with
 *   failures rather than playback volume. Correlate across a reconnect via
 *   attempt_id, NOT play_session_id — the session id is renewed on restart.
 * - segment_delivery_failures is the exception to the family above: AGGREGATED,
 *   not append-only. A penalty-boxed player re-requests a missing resource in
 *   a tight loop, so one row per response would make growth scale with how
 *   badly a client is failing. The unique key (play_session_id, category,
 *   http_status, resource_kind, COALESCE(stream_variant,'')) collapses a retry
 *   storm into one row with `occurrences`; the COALESCE is needed because NULL
 *   never equals NULL in a unique index. It stores NO url or query string
 *   (segment routes carry api_key as a query parameter, so a URL column would
 *   be a credential at rest). play_session_id is TEXT: native clients send an
 *   uppercase UUID string, play_sessions.id is a lowercased uuid; the read path
 *   lowercases before a guarded cast.
 * - client_diagnostics is the single store for everything clients report
 *   (playback incidents, crashes, hangs, JS errors, API-failure counters, log
 *   bundles), superseding playback_incident_events. `occurred_at` is CLIENT
 *   time and `received_at` is server receipt time (the legacy table had the two
 *   names the other way round). The user/received indexes key on received_at
 *   because the daily byte budget, retention prune and per-user row cap are
 *   all "what arrived in the last N days" questions. UNIQUE (user_id,
 *   event_id) is the idempotency key. `payload.message` keeps the full text;
 *   `summary` is the 200-char list-row truncation. user_id is ON DELETE SET
 *   NULL (evidence outlives the account; GDPR erasure strips user text).
 * - client_diagnostic_blobs holds gzipped log-bundle bodies apart from the
 *   parent so list queries never read bytea; UNIQUE (diagnostic_id) = one body
 *   per row, cascades from the parent, no retention of its own.
 * - network_speed_tests: client-timed active download measurement (the only
 *   honest timer is the receiver; server-side timing measures a write into a
 *   socket buffer). Kept as 250 ms buckets so an interruption shows as an empty
 *   bucket. Stores no IP and no URL. playback_session_quality's p10/p50 delivery
 *   columns exist because a link that is usually fine and periodically
 *   collapses has a low p10 and a healthy p50, which no average shows.
 *
 * ============================================================================
 * MUSIC: SONIC MODEL & LISTEN EVENTS
 * ============================================================================
 * - music_genre_centroids stores centroids ALREADY CENTERED against the corpus
 *   mean, which lives in music_sonic_model_stats. Raw cosine between MSCLAP means
 *   is useless — averaging collapses every genre toward the corpus mean and
 *   everything scores 0.85–0.98, i.e. noise. Both tables are rewritten in one
 *   transaction by the music-genre-centroids task so they cannot disagree; the
 *   uncentered mean is deliberately NOT kept (a second representation nothing
 *   reads is just a staleness hazard).
 * - media_audio_embeddings.projected_vector is a max-abs-int8 64-dim projection,
 *   exactly 64 bytes (CHECK-enforced), stamped with the projection_version whose
 *   basis produced it (music_embedding_projection_basis). Per-vector scale is
 *   deliberately not stored: cosine is scale-invariant, so comparing raw int8
 *   bytes is correct — and that is what keeps it at 64 bytes with no sidecar
 *   float. Bytes are comparable ONLY against the same projection_version: a
 *   single flipped SVD sign makes two bases mutually meaningless.
 * - music_listen_events' play-end idempotency key is scoped to the TRACK, not
 *   just (user_id, event_id). event_id is minted client-side and nothing forces a
 *   fresh one per track; a client reusing one had its second track answered
 *   "duplicate" and never recorded — silently, because the endpoint genuinely had
 *   seen that event. The listen simply never reached play_count.
 * - audio_cluster_ids is the registry of every sonic-cluster id ever issued per
 *   embedding model. media_audio_clusters.cluster_id used to be the raw KMeans
 *   index, so a stored id pointed at a different sound after the next library
 *   change. Each run now matches new clusters to the previous ones by overlap
 *   and keeps the id; an unmatched cluster gets an id above everything in this
 *   table, so a retired id is never handed out again.
 * - music_popularity_rank precomputes the popular-hits ordering (track score
 *   within its artist x the artist's global score, which lives on two
 *   different media_popularity rows and so cannot be served by any index).
 *   It holds the FULL ordering, not a top-N: ranking globally and filtering
 *   per user can leave a heavy listener with a silent shortfall. has_files is
 *   NOT baked in (it changes with files, not popularity) and is filtered at
 *   read time. PK (media_id, source) so a second provider cannot overwrite
 *   the first; the index is (source, effective_score DESC, raw_playcount DESC
 *   NULLS LAST) in exactly the caller's ORDER BY so it walks in rank order and
 *   stops at LIMIT. Rebuilt per source by music_popularity_rank_rebuild() at
 *   the end of the popularity task, NOT by a row trigger (the task writes in
 *   bulk). The function's ANALYZE is load-bearing: without fresh stats the
 *   planner picked a bitmap scan, discarding index order and re-sorting.
 *
 * ============================================================================
 * SEGMENTS & THE INTRO ANALYZER
 * ============================================================================
 * - media_file_item_segments holds per-episode playback windows inside a COMBINED
 *   file (one physical file backing several episode rows, e.g. S02E24E25).
 *   Without them, selecting the second episode starts the file at 0 and replays
 *   the first. NULL offsets mean "no reliable window" and preserve whole-file
 *   behaviour — the right answer for files that only LOOK combined but are really
 *   scanner mis-links. Derivation is centralized in utils/file-segments.ts.
 * - media_segment_candidates is the evidence half of the analyzer that
 *   media_segments (the answer) cannot express: media_segments is
 *   UNIQUE (media_id, type, source) with every detector writing the same source,
 *   so a window-edge truncation and a 13-episode chromaprint consensus are
 *   indistinguishable once stored. Candidates are UNIQUE (media_id, type, method)
 *   — that is the whole point: two detectors may disagree on one boundary without
 *   clobbering each other, and one pure resolver then materializes exactly one
 *   winner into media_segments. `method` is intentionally NOT a CHECK: the method
 *   set is the subsystem's vocabulary and grows with each detector, enforced in
 *   TypeScript (DetectionMethod) so adding one stays a one-line union edit.
 * - The analyzer's completion marker is TWO stage ids, one per detector group
 *   (`lumastra-intro-analyzer:visual` / `:acoustic`), carrying each row's own
 *   processing_version forward rather than a stamped constant — stamping would
 *   either re-analyse everything or mark stale work current.
 *
 * ============================================================================
 * OFFLINE DOWNLOADS (download_renditions)
 * ============================================================================
 * - One row per cached transcoded artifact, a table rather than a Valkey key
 *   because two things must survive a TTL: the artifact is a multi-GB file, so if
 *   the record evaporates while the file remains the bytes are stranded with
 *   nothing left to reap them (the row IS the reaper's inventory); and an encode
 *   runs for minutes, so heartbeat_at + owner_pod let another replica take over a
 *   corpse instead of silently abandoning it.
 * - UNIQUE NULLS NOT DISTINCT (file_id, rung_id, audio_index) IS the election.
 *   Prod runs two web
 *   replicas over a shared transcode cache, so "who encodes this?" is a
 *   distributed question answered by the unique key rather than a lock:
 *   INSERT … ON CONFLICT DO NOTHING RETURNING id returns a row to exactly one
 *   caller cluster-wide. No lock to leak, no lease to renew on the common path.
 *   NULLS NOT DISTINCT is load-bearing, not decorative: audio_index is NULL for
 *   a video-only artifact (silent film), and Postgres's default NULL-distinct
 *   behaviour would let every concurrent request for one insert its own row and
 *   start its own encode. Widened in 16.251.0 (video-only renditions), which
 *   this snapshot already includes.
 *
 * ============================================================================
 * SOCIAL / SHARING
 * ============================================================================
 * - The sharing tier is TWO booleans, not an enum: hide_streams stays exactly as
 *   it is (already load-bearing in several visibility predicates) and
 *   users.share_listening_activity is added beside it. private = hide_streams;
 *   ambient = neither; activity rail = share_listening_activity. Converting
 *   hide_streams into a three-value enum would have put every existing reader at
 *   risk to express what an extra boolean expresses for free.
 * - user_media_share_opt_out is the per-title escape hatch so a user need not drop
 *   a whole tier to hide one book. PK (user_id, media_id) is exactly the shape of
 *   its only read — a correlated NOT EXISTS in the visibility predicate.
 *
 * ============================================================================
 * COMPAT & PLUGIN SURFACES
 * ============================================================================
 * - jellyfin_display_preferences persists what /j/DisplayPreferences clients POST,
 *   keyed by the {id} path segment AND the ?client= query param — real Jellyfin
 *   scopes preferences per client, so that axis is preserved rather than collapsed.
 *   `data` is an opaque JSONB pass-through: clients round-trip different subsets
 *   of the DTO, so the route layer deliberately does not validate field-by-field.
 * - external_plugins is the registry for remotely-installed, offline-signed
 *   plugins: name is the PK (CHECK-constrained to a slug), and the partial index
 *   on status='installed' AND enabled=true is the loadable set.
 * - plugin_repositories / plugin_catalog_entries: a repository grants ZERO
 *   trust. Adding a URL changes what is ADVERTISED, never what can run; install
 *   still passes the same signature / ABI / continuity gates against
 *   operator-configured trusted keys (which stay env-only precisely because a
 *   settings write there would become code execution). Catalog identity is
 *   (repository_id, name): two repositories offering the same plugin are two
 *   rows, each labelled with its source, with NO cross-repository merge or
 *   priority order. The catalog is a normalized cache (not one jsonb per
 *   repository) so search and update matching are SQL and one repository's
 *   failed sync cannot blank another's entries. external_plugins gains
 *   source_repository_id (nullable: a pasted install belongs to no repository;
 *   ON DELETE SET NULL) and available_* columns (1:1 with the installed row,
 *   cleared on upgrade, so columns not a table), plus a manifest metadata
 *   jsonb that is a verbatim copy of the signed catalog fields (NULL = the
 *   manifest declared none).
 *
 * ============================================================================
 * SMALL PER-USER TABLES
 * ============================================================================
 * - admin_user_ui_prefs (nav_style) is a table rather than a config setting
 *   because the choice is per admin user across browsers, not instance-wide, and
 *   is keyed by users.id so a username change keeps it.
 * - livetv_channel_favorites is a dedicated table rather than prefs JSON so the
 *   channel FK cascades when cleanup hard-deletes archived channels.
 * - user_rate_skips makes a /rate swipe skip durable: the served-set lives in
 *   Valkey per session, so a skipped title used to reappear on the next reload.
 *   Skips are intentionally NOT permanent — a row ages out of the suppression
 *   window and the title can resurface (unlike a rating).
 * - media_artwork_suppressions is the tombstone that makes "Remove" stick for
 *   library-SIDECAR artwork: deleting the row only detaches it, and the next image
 *   scan re-registers the file. Keyed by exact file_path so it suppresses only the
 *   removed file; an explicit admin upload of that path lifts its own suppression.
 *
 * ============================================================================
 * ADDED BY THE 16.303.0–16.467.0 FOLD (2026-11-01)
 * ============================================================================
 * Delta sync
 * - sync_changes / sync_state capture library and per-user changes for client delta
 *   sync. Capture is done by triggers (sync_* functions) in the same transaction as
 *   the write, so no writer can forget it. sync_state is a one-row table (CHECK
 *   id = 1): instance_id identifies this install, epoch is bumped to make every
 *   client reload (TRUNCATE capture bumps it too), pruned_* record how far the log
 *   was trimmed. The row is seeded; a fresh install starts at epoch 1.
 * - Inferred (non-explicit) user_ratings rows are not logged; never-owned rows are
 *   skipped by the triggers because the never-owned media GC deletes them anyway.
 *   Audiobook age floors (library_groups.max_age_rating) are captured BEFORE the
 *   update, because a reader needs the old effective boundary to drop cached ids.
 *
 * Task runtime ownership
 * - task_runtime_authorities / _commands / _executions / _handovers /
 *   _queue_operations record durable ownership generations, command receipts,
 *   executor drain records and resumable queue-operation barriers. task_worker_lease
 *   is a singleton lease admitting exactly one dedicated task worker.
 *
 * Artwork provenance
 * - image_candidates (media items) and person_image_owners / person image candidates
 *   store every known artwork candidate with provider, provider_ref and selection
 *   order. The legacy media_artwork / custom_*_url columns stay and are mirrored
 *   from the selected candidate by triggers. image_selection_policy is a one-row
 *   table (provider_order, generation, election cursor, episode thumbnail
 *   preference) and is seeded. image_provider_suppressions remembers admin-hidden
 *   provider artwork. image_provenance_progress only tracked the one-shot backfill.
 *
 * Music
 * - music_play_starts durably deduplicates playback starts; music_edit_receipts and
 *   album_merge_receipts keep before/after receipts so credit, ownership and album
 *   merges can be recovered; album_split_health_pairs / _cursor drive a bounded,
 *   indexed scan for split albums. Canonical artist identity keys keep Unicode and
 *   punctuation (NFC title index plus alias and MusicBrainz lookup indexes).
 *   music_search_normalize / music_title_search_vector / music_mood_search_text back
 *   punctuation-tolerant title and mood search with canonical volume tokens.
 *
 * Audiobooks
 * - audiobook_contributors / _series and their book link tables persist contributors
 *   and series (role, position, sequence) so lists do not parse ABS metadata.
 *
 * File health and analysis
 * - media_file_health_reviews keep explicit, reversible duration reviews bound to the
 *   exact file and stream evidence; media_file_health_rechecks bound retries and keep
 *   prior raw observations. media_segment_analysis_passes bind analyzer passes and
 *   retained failures to the selected content and episode window;
 *   media_segment_fingerprints hold per-window acoustic extraction so intro runs
 *   resume, and are discarded by trigger when the source file or mapping changes.
 *   file_range_mapping_proofs are private dated observations of physical range
 *   mappings, invalidated by trigger; health_tail_assessment is cleared by trigger
 *   when its source or streams change.
 * - quarantine_dispositions, personal_media_dispositions and
 *   admin_media_change_receipts hold exact revision receipts so hiding a warning,
 *   keeping an unmatched item and admin media choices are reversible.
 *
 * Live TV and devices
 * - livetv_channel_numbers (stable numbers per station card, admin pins),
 *   livetv_simple_mode (per-user simple mode), livetv_channel_health (per-feed
 *   health), livetv_sources.lineup_filter (Configure Lineup choices reapplied on
 *   re-import). device_control_grants lets an owner authorise a helper to remote-
 *   control her devices. Playback grants are opaque and bound to playback sessions.
 *
 * Misc
 * - library_size_snapshots / library_volume_snapshots: daily bytes per library and
 *   free space per path (growth sparkline, disk forecast). library_cleanup_holds:
 *   paths whose stale-file cleanup a safety guard refused. manual_file_link_sets:
 *   hand-made file-to-episode links keyed by content hash + size so they survive a
 *   rename. jellyfin_file_inventory caches Jellyfin file evidence.
 *   user_playback_preference_devices / _orders reject reordered browser preference
 *   writes. unavailable_media_retention_grace_progress only tracked the one-shot
 *   restart of loss clocks.
 * - Every foreign-key column that had no leading index got one (idx_<table>_<col>_fk,
 *   partial WHERE <col> IS NOT NULL for nullable columns) so deleting a referenced
 *   row does not seq-scan the referencing table.
 */

import type postgres from 'postgres';
import { generateMigrationChecksum, type Migration } from './migration-system';
import { BASE_SCHEMA_SQL } from './base-schema-sql.js';
import { guardExtensionComments } from './base-schema-extension-comments.js';
import { Logger } from '../utils/logger';
import { resolveEffectiveEmbedding } from '../ai/embedding-models.js';
// EMBEDDING_SOURCE constants (LIBRARY='jellyfin', DISCOVERY='jellyseerr') cannot be
// interpolated into DDL sql`` template tags — postgres.js parameterizes values as $1/$2
// which is invalid inside DDL statements (CREATE VIEW, CREATE INDEX, trigger bodies).
// Raw string literals are intentional in all DDL below.
// See: src/lib/server/utils/embedding-source.ts

const logger = Logger.for('BaseSchema');

// Resolve the vector(N) column width via the SHARED resolver so the migration
// DDL and the runtime embedder (voyage.ts) can never diverge — a divergence
// here is what produced the silent 1024-vs-1536 mismatch. Reads process.env
// directly (the migration runner runs before the config singletons are wired);
// the resolver is pure and has no config-system dependency.
function getEmbeddingDimensionForMigration(): number {
    const explicitDimension = parseInt(process.env.EMBEDDING_DIMENSIONS || '0', 10);
    return resolveEffectiveEmbedding({
        embeddingModel: process.env.EMBEDDING_MODEL,
        embeddingDimensions: explicitDimension,
        embeddingBaseUrl: process.env.EMBEDDING_BASE_URL,
        embeddingApiKey: process.env.EMBEDDING_API_KEY,
        voyageApiKey: process.env.VOYAGE_API_KEY,
        openaiApiKey: process.env.OPENAI_API_KEY,
    }).dimensions;
}

// NOTE: there is intentionally NO enumerated list of superseded migrations.
// Every historical migration version <= BASE_SCHEMA_VERSION is considered already
// applied: the base schema records BASE_SCHEMA_VERSION, and the runner skips any
// migration whose version compares <= the recorded watermark (see
// migration-system.ts runMigrationsInner + compareVersions). Only migrations newer
// than BASE_SCHEMA_VERSION run (see the MIGRATIONS array in migrate-schema.ts).

export const BASE_SCHEMA_VERSION = '16.467.0';

// Export embedding dimension helper for migrations
export { getEmbeddingDimensionForMigration };

async function baseSchemaUp(sql: postgres.TransactionSql): Promise<void> {
    const embeddingDimension = getEmbeddingDimensionForMigration();
    logger.info(
        `[BaseSchema] Applying squashed head schema (v16.467.0), embedding dimension: ${embeddingDimension}`,
    );
    // Re-parameterize ONLY the configurable text-embedding columns to the
    // configured dimension so fresh installs using a different embedding model
    // get correctly-sized vector columns. The generator (base-schema-sql.ts)
    // marks exactly those columns (media_embeddings, media_lyrics_embeddings,
    // user_profiles.catalog/request_embedding, assistant_messages.embedding_query)
    // with the __EMBEDDING_DIM__ placeholder. The fixed CLAP/MSCLAP columns
    // (media_audio_embeddings.embedding, mood_vectors.vector) are captured as a
    // literal vector(1024) and intentionally NOT rewritten — those models always
    // emit 1024-dim vectors regardless of the text embedding model. (A blanket
    // vector(\d+) rewrite would silently corrupt them when the text dim != 1024.)
    // COMMENT ON EXTENSION needs extension ownership; guard it so a non-superuser app role works
    // with extensions an operator pre-created (see base-schema-extension-comments.ts).
    const schemaSql = guardExtensionComments(
        BASE_SCHEMA_SQL.replaceAll('__EMBEDDING_DIM__', String(embeddingDimension)),
    );
    // The pg_dump preamble issues session-level SETs (notably
    // `set_config('search_path','',false)` and `check_function_bodies=false`).
    // Those are needed WHILE the dump runs (forward-referencing function bodies,
    // schema-qualified DDL), but must not leak onto the pooled connection — a
    // lingering empty search_path would break later unqualified app queries.
    // `sql.unsafe` runs the whole batch on one connection, so a trailing
    // `RESET ALL` restores it to defaults before it returns to the pool.
    await sql.unsafe(`${schemaSql}\n\nRESET ALL;\n`);
    logger.info(
        '[BaseSchema] Base schema creation completed successfully (v16.467.0 - squashed full head schema)!',
    );
}

export const BASE_SCHEMA_MIGRATION: Migration = {
    version: BASE_SCHEMA_VERSION,
    name: 'base_schema_v16_467_0',
    description:
        'Complete base schema - squashed head snapshot (pg_dump) through migration 16.467.0',
    checksum: generateMigrationChecksum(BASE_SCHEMA_SQL),
    up: baseSchemaUp,
};
