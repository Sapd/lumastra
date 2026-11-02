// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Admin IA redesign (spec §3.3, §8): "one-sentence description for every
 * task" — content work tracked separately as plan step `task-descriptions`.
 * This module is the wiring the catalog page and TaskDetail call —
 * `taskDescription(taskId, sdkDescription)` — mapping every builtin,
 * non-demo task id to a curated, operator-language, en+de Paraglide
 * message. A curated entry here always wins over the SDK author's own
 * `TaskDefinition.description`; that raw field remains the fallback for
 * external-plugin tasks (no message here) and never disappears from the
 * type, so an unclassified/third-party task still shows *something*.
 *
 * Naming: one message per task id, `admin_task_desc_<id_with_underscores>`
 * (e.g. task id `file-library-scan` → `admin_task_desc_file_library_scan`).
 * Paraglide can't look up a message by a dynamically-built string, so this
 * map is the (small, hand-written) bridge from a runtime task id to the
 * matching statically-imported message function.
 */

import * as m from '$lib/paraglide/messages.js';

type TaskDescriptionMessage = () => string;

// Curated one-sentence operator descriptions, keyed by task id. Every
// registered non-demo builtin task (~58)
// has an entry. External-plugin tasks fall back to their own SDK
// `description` via `taskDescription()` below.
const TASK_DESCRIPTIONS: Partial<Record<string, TaskDescriptionMessage>> = {
    // Library pipeline
    'file-library-scan': m.admin_task_desc_file_library_scan,
    'file-delta-ingest': m.admin_task_desc_file_delta_ingest,
    'file-reconcile': m.admin_task_desc_file_reconcile,
    'media-probe': m.admin_task_desc_media_probe,
    'tmdb-metadata-sync': m.admin_task_desc_tmdb_metadata_sync,
    'metadata-sync': m.admin_task_desc_metadata_sync,
    'metadata-update': m.admin_task_desc_metadata_update,
    'metadata-cast-backfill': m.admin_task_desc_metadata_cast_backfill,
    'age-rating-backfill': m.admin_task_desc_age_rating_backfill,
    'metadata-aggregation-backfill': m.admin_task_desc_metadata_aggregation_backfill,
    'metadata-translations-sync': m.admin_task_desc_metadata_translations_sync,
    'metadata-translations-seed': m.admin_task_desc_metadata_translations_seed,
    'mdblist-sync': m.admin_task_desc_mdblist_sync,
    'curated-lists-sync': m.admin_task_desc_curated_lists_sync,
    'fribb-anime-sync': m.admin_task_desc_fribb_anime_sync,
    'mal-anime-id-enrichment': m.admin_task_desc_mal_anime_id_enrichment,
    'release-calendar-sync': m.admin_task_desc_release_calendar_sync,
    'airing-series-refresh': m.admin_task_desc_airing_series_refresh,
    'image-sync': m.admin_task_desc_image_sync,
    'provider-artwork-poster': m.admin_task_desc_provider_artwork_poster,
    'provider-artwork-backdrop': m.admin_task_desc_provider_artwork_backdrop,
    'provider-artwork-logo': m.admin_task_desc_provider_artwork_logo,
    'provider-artwork-thumb': m.admin_task_desc_provider_artwork_thumb,
    'provider-artwork-season-poster': m.admin_task_desc_provider_artwork_season_poster,
    'provider-artwork-report': m.admin_task_desc_provider_artwork_report,
    'series-sync': m.admin_task_desc_series_sync,
    // Enqueued by the media browser's bulk action bar, not by the scheduler.
    'bulk-media-sync': m.admin_task_desc_bulk_media_sync,
    // Started when a library folder is deleted.
    'library-folder-detach': m.admin_task_desc_library_folder_detach,
    'chapter-sync': m.admin_task_desc_chapter_sync,
    'trickplay-generation': m.admin_task_desc_trickplay_generation,
    'auto-identify-personal-media': m.admin_task_desc_auto_identify_personal_media,
    'episode-thumbnail-backfill': m.admin_task_desc_episode_thumbnail_backfill,
    'integrity-scanner': m.admin_task_desc_integrity_scanner,
    'lumastra-intro-analyzer': m.admin_task_desc_lumastra_intro_analyzer,
    'lumastra-intro-analyzer-continuation': m.admin_task_desc_lumastra_intro_analyzer_continuation,
    'trickplay-params-sync': m.admin_task_desc_trickplay_params_sync,

    // Music & AI
    'album-enrichment': m.admin_task_desc_album_enrichment,
    'artist-enrichment': m.admin_task_desc_artist_enrichment,
    'discovery-embeddings': m.admin_task_desc_discovery_embeddings,
    'library-embeddings': m.admin_task_desc_library_embeddings,
    'lyrics-ingestion-backfill': m.admin_task_desc_lyrics_ingestion_backfill,
    'lyrics-lrclib-fetch': m.admin_task_desc_lyrics_lrclib_fetch,
    'mood-vector-generation': m.admin_task_desc_mood_vector_generation,
    'music-embedding-generation': m.admin_task_desc_music_embedding_generation,
    'acoustid-fingerprint': m.admin_task_desc_acoustid_fingerprint,
    'music-popularity': m.admin_task_desc_music_popularity,
    'profile-backfill': m.admin_task_desc_profile_backfill,
    'sonic-clustering': m.admin_task_desc_sonic_clustering,
    'music-genre-centroids': m.admin_task_desc_music_genre_centroids,
    'sonic-embedding-backfill': m.admin_task_desc_sonic_embedding_backfill,
    'sonic-map-projection': m.admin_task_desc_sonic_map_projection,
    'music-embedding-projection-fit': m.admin_task_desc_music_embedding_projection_fit,
    'music-embedding-projection-backfill': m.admin_task_desc_music_embedding_projection_backfill,
    'music-analysis': m.admin_task_desc_music_analysis,

    // Live TV
    'import-m3u': m.admin_task_desc_import_m3u,
    'import-epg': m.admin_task_desc_import_epg,
    'refresh-m3u': m.admin_task_desc_refresh_m3u,
    'refresh-epg': m.admin_task_desc_refresh_epg,

    // Watch sync — the scheduler-level tasks vs the per-provider engine's
    // registry-only stubs (see each message: they describe the difference
    // explicitly so the near-duplicate names don't read as accidental dupes).
    'watch-sync-manual': m.admin_task_desc_watch_sync_manual,
    'watch-sync-pull': m.admin_task_desc_watch_sync_pull,
    'watch-sync-push': m.admin_task_desc_watch_sync_push,
    'jellyfin-watch-sync-push': m.admin_task_desc_jellyfin_watch_sync_push,
    'jellyfin-file-inventory': m.admin_task_desc_jellyfin_file_inventory,
    'jellyfin-watch-sync-pull': m.admin_task_desc_jellyfin_watch_sync_pull,
    'audiobookshelf-watch-sync-push': m.admin_task_desc_audiobookshelf_watch_sync_push,
    'audiobookshelf-watch-sync-pull': m.admin_task_desc_audiobookshelf_watch_sync_pull,
    'audiobookshelf-sync': m.admin_task_desc_audiobookshelf_sync,

    // Maintenance
    'cache-cleanup': m.admin_task_desc_cache_cleanup,
    'database-cleanup': m.admin_task_desc_database_cleanup,
    'library-storage-snapshot': m.admin_task_desc_library_storage_snapshot,
    'health-invariants': m.admin_task_desc_health_invariants,
    'problem-derive': m.admin_task_desc_problem_derive,
    'pause-reconcile': m.admin_task_desc_pause_reconcile,
    'oauth-cleanup': m.admin_task_desc_oauth_cleanup,
    'play-session-cleanup': m.admin_task_desc_play_session_cleanup,
    'task-history-retention': m.admin_task_desc_task_history_retention,
    'telemetry-cleanup': m.admin_task_desc_telemetry_cleanup,
    'plugin-update-check': m.admin_task_desc_plugin_update_check,
    'lumastra-update-check': m.admin_task_desc_lumastra_update_check,
    'music-transcode-cache-reaper': m.admin_task_desc_music_transcode_cache_reaper,
    'valkey-memory-monitor': m.admin_task_desc_valkey_memory_monitor,
    'watch-history-retention': m.admin_task_desc_watch_history_retention,
    'unavailable-media-retention': m.admin_task_desc_unavailable_media_retention,
    'never-owned-media-gc': m.admin_task_desc_never_owned_media_gc,
    'artwork-reaper': m.admin_task_desc_artwork_reaper,
    'stage-sweep': m.admin_task_desc_stage_sweep,

    // Repair tools
    'embedding-reset': m.admin_task_desc_embedding_reset,
    'episode-thumbnail-generate': m.admin_task_desc_episode_thumbnail_generate,
    'episode-thumbnail-extract': m.admin_task_desc_episode_thumbnail_extract,
    'reconciliation-backfill': m.admin_task_desc_reconciliation_backfill,
};

/**
 * Curated (Paraglide, en+de) description for `taskId` if one exists, else
 * the SDK author's own `sdkDescription` (may be `undefined` — external
 * plugins aren't required to set one).
 */
export function taskDescription(taskId: string, sdkDescription?: string): string | undefined {
    const curated = TASK_DESCRIPTIONS[taskId];
    if (curated) return curated();
    return sdkDescription;
}

/** True when `taskId` has a curated entry — used by the coverage test. */
export function hasCuratedDescription(taskId: string): boolean {
    return taskId in TASK_DESCRIPTIONS;
}

// Curated "if this stops, you'd notice" line per task id: the concrete,
// user-visible consequence of that task not running. Not every task has one —
// four watch-sync ids are registry plumbing for the per-provider sync engine
// (it drives them directly; they can't run on their own, so there's nothing
// user-visible to describe) and are intentionally omitted here.
const TASK_IMPACTS: Partial<Record<string, TaskDescriptionMessage>> = {
    // Library pipeline
    'file-library-scan': m.admin_task_impact_file_library_scan,
    'file-delta-ingest': m.admin_task_impact_file_delta_ingest,
    'file-reconcile': m.admin_task_impact_file_reconcile,
    'media-probe': m.admin_task_impact_media_probe,
    'tmdb-metadata-sync': m.admin_task_impact_tmdb_metadata_sync,
    'metadata-sync': m.admin_task_impact_metadata_sync,
    'bulk-media-sync': m.admin_task_impact_bulk_media_sync,
    'library-folder-detach': m.admin_task_impact_library_folder_detach,
    'metadata-update': m.admin_task_impact_metadata_update,
    'metadata-cast-backfill': m.admin_task_impact_metadata_cast_backfill,
    'age-rating-backfill': m.admin_task_impact_age_rating_backfill,
    'metadata-aggregation-backfill': m.admin_task_impact_metadata_aggregation_backfill,
    'metadata-translations-sync': m.admin_task_impact_metadata_translations_sync,
    'metadata-translations-seed': m.admin_task_impact_metadata_translations_seed,
    'mdblist-sync': m.admin_task_impact_mdblist_sync,
    'curated-lists-sync': m.admin_task_impact_curated_lists_sync,
    'fribb-anime-sync': m.admin_task_impact_fribb_anime_sync,
    'mal-anime-id-enrichment': m.admin_task_impact_mal_anime_id_enrichment,
    'release-calendar-sync': m.admin_task_impact_release_calendar_sync,
    'airing-series-refresh': m.admin_task_impact_airing_series_refresh,
    'image-sync': m.admin_task_impact_image_sync,
    'provider-artwork-poster': m.admin_task_impact_provider_artwork_poster,
    'provider-artwork-backdrop': m.admin_task_impact_provider_artwork_backdrop,
    'provider-artwork-logo': m.admin_task_impact_provider_artwork_logo,
    'provider-artwork-thumb': m.admin_task_impact_provider_artwork_thumb,
    'provider-artwork-season-poster': m.admin_task_impact_provider_artwork_season_poster,
    'provider-artwork-report': m.admin_task_impact_provider_artwork_report,
    'series-sync': m.admin_task_impact_series_sync,
    'chapter-sync': m.admin_task_impact_chapter_sync,
    'trickplay-generation': m.admin_task_impact_trickplay_generation,
    'auto-identify-personal-media': m.admin_task_impact_auto_identify_personal_media,
    'episode-thumbnail-backfill': m.admin_task_impact_episode_thumbnail_backfill,
    'integrity-scanner': m.admin_task_impact_integrity_scanner,
    'lumastra-intro-analyzer': m.admin_task_impact_lumastra_intro_analyzer,
    'trickplay-params-sync': m.admin_task_impact_trickplay_params_sync,

    // Music & AI
    'album-enrichment': m.admin_task_impact_album_enrichment,
    'artist-enrichment': m.admin_task_impact_artist_enrichment,
    'discovery-embeddings': m.admin_task_impact_discovery_embeddings,
    'library-embeddings': m.admin_task_impact_library_embeddings,
    'lyrics-ingestion-backfill': m.admin_task_impact_lyrics_ingestion_backfill,
    'lyrics-lrclib-fetch': m.admin_task_impact_lyrics_lrclib_fetch,
    'mood-vector-generation': m.admin_task_impact_mood_vector_generation,
    'music-embedding-generation': m.admin_task_impact_music_embedding_generation,
    'acoustid-fingerprint': m.admin_task_impact_acoustid_fingerprint,
    'music-popularity': m.admin_task_impact_music_popularity,
    'profile-backfill': m.admin_task_impact_profile_backfill,
    'sonic-clustering': m.admin_task_impact_sonic_clustering,
    'music-genre-centroids': m.admin_task_impact_music_genre_centroids,
    'sonic-embedding-backfill': m.admin_task_impact_sonic_embedding_backfill,
    'sonic-map-projection': m.admin_task_impact_sonic_map_projection,
    'music-embedding-projection-fit': m.admin_task_impact_music_embedding_projection_fit,
    'music-embedding-projection-backfill': m.admin_task_impact_music_embedding_projection_backfill,
    'music-analysis': m.admin_task_impact_music_analysis,

    // Live TV
    'import-m3u': m.admin_task_impact_import_m3u,
    'import-epg': m.admin_task_impact_import_epg,
    'refresh-m3u': m.admin_task_impact_refresh_m3u,
    'refresh-epg': m.admin_task_impact_refresh_epg,

    // Watch sync — the scheduler-level tasks have a real user-visible impact;
    // the four per-provider engine registry stubs (jellyfin-watch-sync-*,
    // audiobookshelf-watch-sync-*) are intentionally omitted, see comment above.
    'watch-sync-manual': m.admin_task_impact_watch_sync_manual,
    'watch-sync-pull': m.admin_task_impact_watch_sync_pull,
    'watch-sync-push': m.admin_task_impact_watch_sync_push,
    'audiobookshelf-sync': m.admin_task_impact_audiobookshelf_sync,

    // Maintenance
    'cache-cleanup': m.admin_task_impact_cache_cleanup,
    'database-cleanup': m.admin_task_impact_database_cleanup,
    'library-storage-snapshot': m.admin_task_impact_library_storage_snapshot,
    'health-invariants': m.admin_task_impact_health_invariants,
    'problem-derive': m.admin_task_impact_problem_derive,
    'pause-reconcile': m.admin_task_impact_pause_reconcile,
    'oauth-cleanup': m.admin_task_impact_oauth_cleanup,
    'play-session-cleanup': m.admin_task_impact_play_session_cleanup,
    'task-history-retention': m.admin_task_impact_task_history_retention,
    'telemetry-cleanup': m.admin_task_impact_telemetry_cleanup,
    'plugin-update-check': m.admin_task_impact_plugin_update_check,
    'lumastra-update-check': m.admin_task_impact_lumastra_update_check,
    'music-transcode-cache-reaper': m.admin_task_impact_music_transcode_cache_reaper,
    'valkey-memory-monitor': m.admin_task_impact_valkey_memory_monitor,
    'watch-history-retention': m.admin_task_impact_watch_history_retention,
    'unavailable-media-retention': m.admin_task_impact_unavailable_media_retention,
    'never-owned-media-gc': m.admin_task_impact_never_owned_media_gc,
    'artwork-reaper': m.admin_task_impact_artwork_reaper,
    'stage-sweep': m.admin_task_impact_stage_sweep,

    // Repair tools
    'embedding-reset': m.admin_task_impact_embedding_reset,
    'episode-thumbnail-generate': m.admin_task_impact_episode_thumbnail_generate,
    'episode-thumbnail-extract': m.admin_task_impact_episode_thumbnail_extract,
    'reconciliation-backfill': m.admin_task_impact_reconciliation_backfill,
};

/**
 * Curated (Paraglide, en+de) "if this stops, you'd notice" line for `taskId`,
 * or `undefined` when no impact line is curated for it (external-plugin
 * tasks, and the four watch-sync registry stubs described above).
 */
export function taskImpact(taskId: string): string | undefined {
    const curated = TASK_IMPACTS[taskId];
    return curated?.();
}
