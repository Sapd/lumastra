// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One operator name per task (spec 2026-09-27 §1.5 "one vocabulary").
 *
 * A builtin task used to have up to four names: its SDK `name` ("Media File
 * Probe"), the pipeline step name ("Quick scan" / "Deep scan"), the attention
 * board's lowercase stage label ("media analysis"), and a raw id wherever a
 * surface had nothing better. All of them now read from this map — the task
 * list, task page, runs, notifications, the pipeline page (a step owned by one
 * task IS that task, see `pipeline-step-names.ts`) — so the same work is
 * called the same thing everywhere, in the viewer's language.
 *
 * Same shape as `task-descriptions.ts`: curated en+de Paraglide message per
 * builtin id, the SDK `name` as the fallback for external-plugin tasks.
 * `task-descriptions-coverage.test.ts` fails CI when a builtin has no entry.
 *
 * Client-safe: no server imports. Server code calls it inside a request (the
 * Paraglide middleware sets the viewer's locale) or, in background jobs,
 * gets the base locale.
 */

import * as m from '$lib/paraglide/messages.js';

type TaskNameMessage = () => string;

const TASK_NAMES: Partial<Record<string, TaskNameMessage>> = {
    'auto-identify-personal-media': m.admin_task_name_auto_identify_personal_media,
    'bulk-media-sync': m.admin_task_name_bulk_media_sync,
    'library-folder-detach': m.admin_task_name_library_folder_detach,
    'chapter-sync': m.admin_task_name_chapter_sync,
    'curated-lists-sync': m.admin_task_name_curated_lists_sync,
    'mdblist-sync': m.admin_task_name_mdblist_sync,
    'episode-thumbnail-backfill': m.admin_task_name_episode_thumbnail_backfill,
    'file-delta-ingest': m.admin_task_name_file_delta_ingest,
    'file-library-scan': m.admin_task_name_file_library_scan,
    'file-reconcile': m.admin_task_name_file_reconcile,
    'metadata-sync': m.admin_task_name_metadata_sync,
    'fribb-anime-sync': m.admin_task_name_fribb_anime_sync,
    'series-sync': m.admin_task_name_series_sync,
    'image-sync': m.admin_task_name_image_sync,
    'tmdb-metadata-sync': m.admin_task_name_tmdb_metadata_sync,
    'integrity-scanner': m.admin_task_name_integrity_scanner,
    'lumastra-intro-analyzer': m.admin_task_name_lumastra_intro_analyzer,
    'lumastra-intro-analyzer-continuation': m.admin_task_name_lumastra_intro_analyzer_continuation,
    'mal-anime-id-enrichment': m.admin_task_name_mal_anime_id_enrichment,
    'media-probe': m.admin_task_name_media_probe,
    'metadata-aggregation-backfill': m.admin_task_name_metadata_aggregation_backfill,
    'metadata-cast-backfill': m.admin_task_name_metadata_cast_backfill,
    'age-rating-backfill': m.admin_task_name_age_rating_backfill,
    'metadata-translations-seed': m.admin_task_name_metadata_translations_seed,
    'metadata-translations-sync': m.admin_task_name_metadata_translations_sync,
    'provider-artwork-backdrop': m.admin_task_name_provider_artwork_backdrop,
    'provider-artwork-report': m.admin_task_name_provider_artwork_report,
    'provider-artwork-thumb': m.admin_task_name_provider_artwork_thumb,
    'provider-artwork-logo': m.admin_task_name_provider_artwork_logo,
    'provider-artwork-poster': m.admin_task_name_provider_artwork_poster,
    'provider-artwork-season-poster': m.admin_task_name_provider_artwork_season_poster,
    'release-calendar-sync': m.admin_task_name_release_calendar_sync,
    'airing-series-refresh': m.admin_task_name_airing_series_refresh,
    'trickplay-generation': m.admin_task_name_trickplay_generation,
    'trickplay-params-sync': m.admin_task_name_trickplay_params_sync,
    'metadata-update': m.admin_task_name_metadata_update,
    'import-epg': m.admin_task_name_import_epg,
    'import-m3u': m.admin_task_name_import_m3u,
    'refresh-epg': m.admin_task_name_refresh_epg,
    'refresh-m3u': m.admin_task_name_refresh_m3u,
    'artwork-reaper': m.admin_task_name_artwork_reaper,
    'problem-derive': m.admin_task_name_problem_derive,
    'cache-cleanup': m.admin_task_name_cache_cleanup,
    'database-cleanup': m.admin_task_name_database_cleanup,
    'library-storage-snapshot': m.admin_task_name_library_storage_snapshot,
    'health-invariants': m.admin_task_name_health_invariants,
    'music-transcode-cache-reaper': m.admin_task_name_music_transcode_cache_reaper,
    'oauth-cleanup': m.admin_task_name_oauth_cleanup,
    'pause-reconcile': m.admin_task_name_pause_reconcile,
    'play-session-cleanup': m.admin_task_name_play_session_cleanup,
    'plugin-update-check': m.admin_task_name_plugin_update_check,
    'lumastra-update-check': m.admin_task_name_lumastra_update_check,
    'stage-sweep': m.admin_task_name_stage_sweep,
    'task-history-retention': m.admin_task_name_task_history_retention,
    'telemetry-cleanup': m.admin_task_name_telemetry_cleanup,
    'valkey-memory-monitor': m.admin_task_name_valkey_memory_monitor,
    'watch-history-retention': m.admin_task_name_watch_history_retention,
    'unavailable-media-retention': m.admin_task_name_unavailable_media_retention,
    'never-owned-media-gc': m.admin_task_name_never_owned_media_gc,
    'album-enrichment': m.admin_task_name_album_enrichment,
    'artist-enrichment': m.admin_task_name_artist_enrichment,
    'discovery-embeddings': m.admin_task_name_discovery_embeddings,
    'library-embeddings': m.admin_task_name_library_embeddings,
    'music-embedding-generation': m.admin_task_name_music_embedding_generation,
    'acoustid-fingerprint': m.admin_task_name_acoustid_fingerprint,
    'lyrics-ingestion-backfill': m.admin_task_name_lyrics_ingestion_backfill,
    'lyrics-lrclib-fetch': m.admin_task_name_lyrics_lrclib_fetch,
    'mood-vector-generation': m.admin_task_name_mood_vector_generation,
    'music-analysis': m.admin_task_name_music_analysis,
    'music-embedding-projection-backfill': m.admin_task_name_music_embedding_projection_backfill,
    'music-embedding-projection-fit': m.admin_task_name_music_embedding_projection_fit,
    'music-genre-centroids': m.admin_task_name_music_genre_centroids,
    'sonic-map-projection': m.admin_task_name_sonic_map_projection,
    'music-popularity': m.admin_task_name_music_popularity,
    'sonic-clustering': m.admin_task_name_sonic_clustering,
    'sonic-embedding-backfill': m.admin_task_name_sonic_embedding_backfill,
    'profile-backfill': m.admin_task_name_profile_backfill,
    'embedding-reset': m.admin_task_name_embedding_reset,
    'reconciliation-backfill': m.admin_task_name_reconciliation_backfill,
    'episode-thumbnail-generate': m.admin_task_name_episode_thumbnail_generate,
    'episode-thumbnail-extract': m.admin_task_name_episode_thumbnail_extract,
    'watch-sync-manual': m.admin_task_name_watch_sync_manual,
    'watch-sync-pull': m.admin_task_name_watch_sync_pull,
    'watch-sync-push': m.admin_task_name_watch_sync_push,
    'jellyfin-watch-sync-pull': m.admin_task_name_jellyfin_watch_sync_pull,
    'jellyfin-watch-sync-push': m.admin_task_name_jellyfin_watch_sync_push,
    'jellyfin-file-inventory': m.admin_task_name_jellyfin_file_inventory,
    'audiobookshelf-watch-sync-pull': m.admin_task_name_audiobookshelf_watch_sync_pull,
    'audiobookshelf-watch-sync-push': m.admin_task_name_audiobookshelf_watch_sync_push,
    'audiobookshelf-sync': m.admin_task_name_audiobookshelf_sync,
};

/**
 * Operator name for a task: the curated name when this build has one, else
 * the SDK author's `fallback` (external plugins), else the raw id.
 */
export function taskDisplayName(taskId: string, fallback?: string | null): string {
    const curated = TASK_NAMES[taskId];
    if (curated) return curated();
    return fallback || taskId;
}

/** True when `taskId` has a curated name — used by the coverage test. */
export function hasCuratedName(taskId: string): boolean {
    return taskId in TASK_NAMES;
}
