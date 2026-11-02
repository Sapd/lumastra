// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stage id → friendly step name (admin IA redesign, spec §3.3 Pipeline row:
 * "friendly step names everywhere ... raw ids only in dev mode").
 *
 * `media_item_stage_state.stage_id` values (`tp-gen`, `media-probe-a`, …) are
 * internal plugin/registry identifiers. Every operator-facing surface that
 * lists pipeline steps (the Completion grid's column headers, the Flow map's
 * diagnostics panels, error groups, …) must show a human name instead —
 * this module is the single place that mapping lives, so every consumer
 * agrees (spec §5 "one source of truth" applied to vocabulary, not just
 * numbers).
 *
 * The known-id list mirrors `STAGE_APPLIES_TO` in `ingest-map.constants.ts`
 * (same "mirror of the task registry, browser can't import server code"
 * constraint documented there) — kept as a separate export here rather than
 * re-exported from that file so `pipeline-step-names.ts` has no dependency
 * on the metro-map-specific module and can be imported standalone by
 * anything that just wants a name (Completion grid, Fix-matches, sweep).
 */

import * as m from '$lib/paraglide/messages.js';

/**
 * Every stage id this app knows a name for. Keep in sync with the task
 * registry's `coversStages` declarations — see the module doc above.
 *
 * One vocabulary (spec 2026-09-27 §1.5): a step that exactly one task covers
 * IS that task, so it uses the task's own name message (`task-names.ts`) —
 * the pipeline page, the task list and notifications can no longer call the
 * same work "Quick scan" in one place and "Media File Probe" in another. Only
 * a task that covers several steps names them separately, as "<task> (part)".
 */
const STEP_NAME: Record<string, () => string> = {
    // A task covering several steps: "<task name> (part)".
    'media-probe-a': m.admin_pipeline_step_media_probe_a,
    'media-probe-b': m.admin_pipeline_step_media_probe_b,
    'lumastra-intro-analyzer:visual': m.admin_pipeline_step_lumastra_intro_analyzer,
    // 🔴 `:acoustic` needs a NAME here (its rows really do surface in the
    // Completion grid, where it was leaking as the raw column header
    // `Lumastra Intro Analyzer:acoustic`) but it must NEVER be added to
    // `STAGE_APPLIES_TO` / `coversStages`. It is deliberately un-swept:
    // season-scoped work owned by the analyzer's own drain loop, whose
    // eligibility comes from row ABSENCE in `getUnanalyzedSeasons`, not from
    // seeded pending rows. Declaring it would hand stage-sweep a backlog that
    // can never shrink, which re-enqueues global runs on the backoff ladder
    // forever — see the comment on `coversStages` in
    // `src/lib/server/tasks/builtin/native/lumastra-intro-analyzer.ts`, which
    // records that exact regression. Naming a stage and sweeping it are
    // independent concerns; this map only does the former.
    'lumastra-intro-analyzer:acoustic': m.admin_pipeline_step_lumastra_intro_analyzer_acoustic,
    // Stage id differs from the task that covers it.
    'integrity-file-present': m.admin_task_name_integrity_scanner,
    // One task, one step: the step is the task.
    'tmdb-metadata-sync': m.admin_task_name_tmdb_metadata_sync,
    'series-sync': m.admin_task_name_series_sync,
    'library-embeddings': m.admin_task_name_library_embeddings,
    'discovery-embeddings': m.admin_task_name_discovery_embeddings,
    'image-sync': m.admin_task_name_image_sync,
    'trickplay-params-sync': m.admin_task_name_trickplay_params_sync,
    'trickplay-generation': m.admin_task_name_trickplay_generation,
    'mdblist-sync': m.admin_task_name_mdblist_sync,
    'music-analysis': m.admin_task_name_music_analysis,
    'album-enrichment': m.admin_task_name_album_enrichment,
    'artist-enrichment': m.admin_task_name_artist_enrichment,
    'music-embedding-generation': m.admin_task_name_music_embedding_generation,
    'acoustid-fingerprint': m.admin_task_name_acoustid_fingerprint,
    'sonic-embedding-backfill': m.admin_task_name_sonic_embedding_backfill,
    'music-popularity': m.admin_task_name_music_popularity,
    'chapter-sync': m.admin_task_name_chapter_sync,
    'fribb-anime-sync': m.admin_task_name_fribb_anime_sync,
    'mal-anime-id-enrichment': m.admin_task_name_mal_anime_id_enrichment,
    'metadata-update': m.admin_task_name_metadata_update,
    'metadata-translations-sync': m.admin_task_name_metadata_translations_sync,
    'provider-artwork-poster': m.admin_task_name_provider_artwork_poster,
    'provider-artwork-backdrop': m.admin_task_name_provider_artwork_backdrop,
    'provider-artwork-logo': m.admin_task_name_provider_artwork_logo,
    'provider-artwork-thumb': m.admin_task_name_provider_artwork_thumb,
    'provider-artwork-season-poster': m.admin_task_name_provider_artwork_season_poster,
};

/**
 * Turn an unmapped stage id into a readable fallback: `tp-gen` → `Tp gen`,
 * `some-plugin-stage` → `Some plugin stage`. Not localized on purpose — it's
 * a best-effort fallback for ids this build doesn't know about yet (a
 * newly-installed plugin's stage before this map is updated), not real
 * content. Exported for reuse/testing.
 */
export function humanizeStageId(stageId: string): string {
    const words = stageId
        .split(/[-_]+/)
        .filter((w) => w.length > 0)
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
    return words.length > 0 ? words.join(' ') : stageId;
}

/**
 * Short station labels for the Flow metro map (admin IA redesign, spec
 * §3.3: station circles must never show the raw stage id — but the full
 * friendly name from `STEP_NAME` above is too wide for a metro-map station
 * label without colliding with its neighbours). Curated abbreviations of
 * the friendly name, not the developer slug — "TMDB", not "tmdb-metadata-sync".
 * The full friendly name (plus, in dev mode, the raw id) still shows in the
 * station's hover tooltip; this map only feeds the compact on-map text.
 */
const STEP_SHORT_NAME: Record<string, () => string> = {
    'media-probe-a': m.admin_pipeline_step_short_media_probe_a,
    'media-probe-b': m.admin_pipeline_step_short_media_probe_b,
    'tmdb-metadata-sync': m.admin_pipeline_step_short_tmdb_metadata_sync,
    'series-sync': m.admin_pipeline_step_short_series_sync,
    'library-embeddings': m.admin_pipeline_step_short_library_embeddings,
    'discovery-embeddings': m.admin_pipeline_step_short_discovery_embeddings,
    'image-sync': m.admin_pipeline_step_short_image_sync,
    'trickplay-params-sync': m.admin_pipeline_step_short_trickplay_params_sync,
    'trickplay-generation': m.admin_pipeline_step_short_trickplay_generation,
    'mdblist-sync': m.admin_pipeline_step_short_mdblist_sync,
    'metadata-translations-sync': m.admin_pipeline_step_short_metadata_translations_sync,
    'lumastra-intro-analyzer:visual': m.admin_pipeline_step_short_lumastra_intro_analyzer,
    'lumastra-intro-analyzer:acoustic':
        m.admin_pipeline_step_short_lumastra_intro_analyzer_acoustic,
    'music-analysis': m.admin_pipeline_step_short_music_analysis,
    'album-enrichment': m.admin_pipeline_step_short_album_enrichment,
    'artist-enrichment': m.admin_pipeline_step_short_artist_enrichment,
    'music-embedding-generation': m.admin_pipeline_step_short_music_embedding_generation,
    'acoustid-fingerprint': m.admin_pipeline_step_short_acoustid_fingerprint,
    'sonic-embedding-backfill': m.admin_pipeline_step_short_sonic_embedding_backfill,
    'music-popularity': m.admin_pipeline_step_short_music_popularity,
    'chapter-sync': m.admin_pipeline_step_short_chapter_sync,
    'fribb-anime-sync': m.admin_pipeline_step_short_fribb_anime_sync,
    'mal-anime-id-enrichment': m.admin_pipeline_step_short_mal_anime_id_enrichment,
    'metadata-update': m.admin_pipeline_step_short_metadata_update,
    'integrity-file-present': m.admin_pipeline_step_short_integrity_file_present,
    'provider-artwork-poster': m.admin_pipeline_step_short_provider_artwork_poster,
    'provider-artwork-backdrop': m.admin_pipeline_step_short_provider_artwork_backdrop,
    'provider-artwork-logo': m.admin_pipeline_step_short_provider_artwork_logo,
    'provider-artwork-thumb': m.admin_pipeline_step_short_provider_artwork_thumb,
    'provider-artwork-season-poster': m.admin_pipeline_step_short_provider_artwork_season_poster,
};

/** Station-label budget in characters before the generic fallback truncates. */
const SHORT_LABEL_MAX_CHARS = 14;

/**
 * Short display label for a pipeline stage id, for space-constrained UI
 * (metro-map station labels). Known ids resolve through the curated
 * `STEP_SHORT_NAME` table (en+de); unknown ids fall back to the full
 * friendly/humanized name truncated to fit — never the raw id.
 */
export function pipelineStepShortName(stageId: string): string {
    const known = STEP_SHORT_NAME[stageId];
    if (known) return known();
    const full = pipelineStepName(stageId);
    if (full.length <= SHORT_LABEL_MAX_CHARS) return full;
    return `${full.slice(0, SHORT_LABEL_MAX_CHARS - 1).trimEnd()}…`;
}

/**
 * Friendly display name for a pipeline stage id. Always returns SOMETHING
 * human-readable — known ids resolve through Paraglide (en+de), unknown ids
 * (third-party plugin stages) fall back to a humanized form of the id
 * rather than ever surfacing the raw kebab-case string as primary text.
 *
 * Never returns the raw id itself — callers that also want to expose the
 * raw id (e.g. a dev-mode tooltip) read `stageId` directly alongside this.
 */
export function pipelineStepName(stageId: string): string {
    const known = STEP_NAME[stageId];
    return known ? known() : humanizeStageId(stageId);
}

/** Every stage id this build has a curated Paraglide name for. */
export const KNOWN_PIPELINE_STEP_IDS: readonly string[] = Object.keys(STEP_NAME);
