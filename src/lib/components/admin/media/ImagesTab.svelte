<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import { browser } from '$app/environment';
    import { createSubjectRunsTracker, type SubjectRunsTracker } from '$lib/stores/subject-runs.js';
    import { runSSEBus } from '$lib/stores/run-sse-bus.js';
    import SeasonThumbnailAction from './SeasonThumbnailAction.svelte';
    import type { DiscogsAttribution } from '$lib/schemas/api-music-dto';
    import * as m from '$lib/paraglide/messages';
    import ImageCandidates from './ImageCandidates.svelte';
    import SharedEpisodeThumbnailReview from './SharedEpisodeThumbnailReview.svelte';
    import ImageDropZone from '$lib/components/modal/ImageDropZone.svelte';
    import ProviderImagePicker from '$lib/components/modal/ProviderImagePicker.svelte';
    import { syncMediaImages, extractPosterFromVideo, getMediaImages } from '$lib/api/admin';
    import { toasts } from '$lib/stores/toast.store';
    import type { ExternalIds } from '$lib/types/api-common';
    import type { ArtworkItem } from '$lib/schemas/media-image-upload';
    import { Icon, ArrowPath, Film } from 'svelte-hero-icons';
    import {
        isMusicType,
        isAudiobook,
        isMovie as checkIsMovie,
        isSeries as checkIsSeries,
        isSeason as checkIsSeason,
        isEpisode as checkIsEpisode,
    } from '$lib/shared/media-types';

    interface Props {
        discogsAttribution?: DiscogsAttribution;
        mediaId: string;
        externalIds?: ExternalIds;
        mediaType?: string;
        currentPosterUrl?: string;
        currentBackdropUrl?: string;
        currentLogoUrl?: string;
        currentThumbUrl?: string;
        maxImageUploadMb?: number;
        onsaved?: () => void;
    }

    let {
        discogsAttribution,
        mediaId,
        externalIds,
        mediaType,
        currentPosterUrl,
        currentBackdropUrl,
        currentLogoUrl,
        currentThumbUrl,
        maxImageUploadMb,
        onsaved,
    }: Props = $props();

    let browsingType = $state<'poster' | 'backdrop' | 'logo' | null>(null);
    let hasProvider = $derived(!!externalIds?.tmdb);
    let isSeries = $derived(checkIsSeries(mediaType));
    let isSeason = $derived(checkIsSeason(mediaType));
    let isEpisodeType = $derived(checkIsEpisode(mediaType));
    let canExtractVideo = $derived(!isMusicType(mediaType ?? '') && !isAudiobook(mediaType ?? ''));
    const syncScope = $derived(
        checkIsMovie(mediaType)
            ? 'movie'
            : checkIsEpisode(mediaType)
              ? 'episode'
              : checkIsSeason(mediaType)
                ? 'season'
                : 'series',
    );
    let isSyncing = $state(false);
    let tracker = $state.raw<SubjectRunsTracker | null>(null);
    let runsVersion = $state(0);
    let syncStatus = $state('');
    const syncBusy = $derived.by(() => {
        runsVersion;
        return isSyncing || !!tracker?.isActive('image-sync');
    });
    $effect(() =>
        runSSEBus.onAnyChange(() => {
            runsVersion += 1;
        }),
    );
    $effect(() => {
        const id = mediaId;
        if (!browser) return;
        const current = createSubjectRunsTracker(id, [], ['image-sync']);
        untrack(() => {
            tracker = current;
            isSyncing = false;
            isExtracting = null;
            syncStatus = '';
            lastRunId = null;
        });
        const off = current.onSettled((run) => {
            if (run.taskId !== 'image-sync') return;
            const result = run.result;
            syncStatus =
                run.state === 'cancelled'
                    ? m.media_p5_artwork_cancelled()
                    : run.state === 'completed' &&
                        result &&
                        typeof result === 'object' &&
                        'success' in result &&
                        result.success === true
                      ? m.media_p5_artwork_finished()
                      : m.media_p5_artwork_uncertain();
            handleSaved();
        });
        return () => {
            off();
            current.destroy();
        };
    });

    let lastRunId = $state<string | null>(null);

    // Enriched artwork data from the inheritance-aware GET endpoint
    let artworkData = $state<ArtworkItem[]>([]);
    let artworkLoaded = $state(false);
    // `artworkLoaded` means the fetch *attempt* finished; `artworkKnown` means it
    // actually returned data. They differ when the GET fails (network/500): we
    // must NOT then treat every slot as "no local artwork" (which would hide the
    // Remove button for items that genuinely own artwork). While unknown — during
    // the initial round-trip or after a failed fetch — hasLocalArtwork falls back
    // to permissive (see the props below); a stray Remove click is still honest
    // because handleDelete checks `data.deleted`.
    let artworkKnown = $state(false);
    let artworkLoadError = $state(false);
    let artworkLoadGeneration = 0;

    function getArtworkInfo(
        type: 'poster' | 'backdrop' | 'logo' | 'thumb',
    ): ArtworkItem | undefined {
        return artworkData.find((a) => a.artworkType === type);
    }

    let posterInfo = $derived(getArtworkInfo('poster'));
    let backdropInfo = $derived(getArtworkInfo('backdrop'));
    let logoInfo = $derived(getArtworkInfo('logo'));
    let thumbInfo = $derived(getArtworkInfo('thumb'));

    // Incremented on every save to bust the browser's in-memory image cache
    // for the uploading user (appended as ?v=N to self-owned artwork URLs).
    let saveBust = $state(0);

    // Resolve effective image URLs:
    // - Inherited LOCAL artwork → use the API-provided URL (ancestor's catalog endpoint)
    // - Otherwise → page-level URL (item's own catalog endpoint). This covers
    //   self local artwork AND provider-sourced images (TMDB/Jellyfin URL served
    //   by the catalog endpoint) that have no `media_artwork` local row. The GET
    //   artwork API only reports `source='local'` rows, so a provider poster would
    //   otherwise resolve to `undefined` and the visible image would flash away
    //   into the drop-zone placeholder. ImageDropZone's <img> onerror falls back
    //   to the placeholder if the catalog URL genuinely has no image to serve.
    // - Not yet loaded → page-level URL (optimistic, avoids flash)
    function resolveUrl(
        info: ArtworkItem | undefined,
        pageUrl: string | undefined,
    ): string | undefined {
        if (!artworkLoaded) return pageUrl;
        if (info && info.source !== 'self') return info.url;
        if (!pageUrl) return undefined;
        if (saveBust > 0) {
            const sep = pageUrl.includes('?') ? '&' : '?';
            return `${pageUrl}${sep}v=${saveBust}`;
        }
        return pageUrl;
    }
    let effectivePosterUrl = $derived(resolveUrl(posterInfo, currentPosterUrl));
    let effectiveBackdropUrl = $derived(resolveUrl(backdropInfo, currentBackdropUrl));
    let effectiveLogoUrl = $derived(resolveUrl(logoInfo, currentLogoUrl));
    let effectiveThumbUrl = $derived.by(() => {
        const base = thumbInfo?.url ?? currentThumbUrl;
        if (!base || saveBust === 0) return base;
        const sep = base.includes('?') ? '&' : '?';
        return `${base}${sep}v=${saveBust}`;
    });

    async function loadArtworkData(id = mediaId): Promise<void> {
        const generation = ++artworkLoadGeneration;
        try {
            const { data } = await getMediaImages(id);
            if (id !== mediaId || generation !== artworkLoadGeneration) return;
            if (data) {
                artworkData = data;
                artworkKnown = true;
                artworkLoadError = false;
            } else {
                artworkKnown = false;
                artworkLoadError = true;
            }
        } catch {
            if (id === mediaId && generation === artworkLoadGeneration) {
                artworkKnown = false;
                artworkLoadError = true;
            }
        } finally {
            if (id === mediaId && generation === artworkLoadGeneration) artworkLoaded = true;
        }
    }

    $effect(() => {
        const id = mediaId;
        untrack(() => {
            artworkData = [];
            artworkLoaded = false;
            artworkKnown = false;
            void loadArtworkData(id);
        });
        return () => {
            artworkLoadGeneration += 1;
        };
    });

    function handleSaved(): void {
        saveBust += 1;
        onsaved?.();
        void loadArtworkData();
    }

    function handleBrowseSelected(): void {
        browsingType = null;
        handleSaved();
    }

    let isExtracting = $state<'poster' | 'backdrop' | 'thumb' | null>(null);

    async function handleExtract(artworkType: 'poster' | 'backdrop' | 'thumb'): Promise<void> {
        const subjectId = mediaId;
        const owner = tracker;
        if (isExtracting) return;
        isExtracting = artworkType;
        try {
            const { data, error } = await extractPosterFromVideo(subjectId, {
                artworkType,
                force: true,
            });
            if (subjectId !== mediaId || owner !== tracker) return;
            if (error) {
                toasts.error(error);
                return;
            }
            if (data?.extracted) {
                toasts.success(
                    artworkType === 'poster'
                        ? m.media_images_poster_extracted()
                        : m.media_images_backdrop_extracted(),
                );
                handleSaved();
            } else {
                toasts.warning(
                    data?.reason === 'already_exists'
                        ? m.media_images_artwork_already_exists({ type: artworkType })
                        : data?.reason === 'no_video_file'
                          ? m.media_images_no_video_file()
                          : data?.reason === 'stale_input'
                            ? m.media_thumb_review_stale()
                            : m.media_images_extraction_failed(),
                );
            }
        } catch (err) {
            if (subjectId !== mediaId || owner !== tracker) return;
            toasts.error(err instanceof Error ? err.message : m.media_images_extraction_failed());
        } finally {
            if (owner === tracker) isExtracting = null;
        }
    }

    async function handleSync(): Promise<void> {
        const subjectId = mediaId;
        const owner = tracker;
        if (syncBusy) return;
        isSyncing = true;
        try {
            const { data, error } = await syncMediaImages(subjectId, {
                mode: 'execute',
                scope: syncScope,
                extractVideo: false,
            });
            if (subjectId !== mediaId || owner !== tracker) return;
            if (error) {
                toasts.error(error);
                return;
            }
            if (data) {
                lastRunId = data.runId;
                tracker?.observeRun?.(data.runId);
                syncStatus = m.media_p5_artwork_queued();
                if (!data.deduped) toasts.info(m.media_p5_artwork_queued());
            }
        } catch (err) {
            if (subjectId !== mediaId || owner !== tracker) return;
            toasts.error(err instanceof Error ? err.message : m.media_images_sync_failed());
        } finally {
            if (owner === tracker) isSyncing = false;
        }
    }
</script>

<div class="space-y-6">
    <div class="flex items-center justify-between">
        <div>
            <h3 class="text-lg font-semibold text-white">{m.media_images_heading()}</h3>
            <p class="text-sm text-surface-400 mt-1">
                {m.media_images_description()}
            </p>
        </div>
        <div class="flex items-center gap-2">
            {#if canExtractVideo}
                <button
                    onclick={handleSync}
                    disabled={syncBusy}
                    class="inline-flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-surface-600 text-white text-sm font-medium rounded transition-colors">
                    <Icon src={ArrowPath} class="w-4 h-4 {isSyncing ? 'animate-spin' : ''}" />
                    {isSyncing ? m.media_images_queuing() : m.media_p5_refresh_artwork()}
                </button>
            {/if}
        </div>
    </div>

    {#if artworkLoadError}<p role="alert" class="text-sm text-amber-300">
            {m.media_p5_artwork_load_failed()}
        </p>{/if}
    {#if syncStatus}<p role="status" class="text-sm text-surface-300">{syncStatus}</p>{/if}
    {#if lastRunId}<details class="text-xs text-surface-400">
            <summary>{m.media_p5_details()}</summary>
            <a
                href={`/admin/tasks/runs?run=${encodeURIComponent(lastRunId)}`}
                class="text-primary-400">{m.media_plain_open_progress()}</a>
        </details>{/if}
    {#if isSeries || isSeason}<SeasonThumbnailAction
            seasonId={mediaId}
            scope={isSeries ? 'series' : 'season'}
            onsaved={handleSaved} />{/if}

    {#if browsingType}
        <ProviderImagePicker
            {mediaId}
            artworkType={browsingType}
            onselected={handleBrowseSelected}
            onclose={() => (browsingType = null)} />
    {:else}
        <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
            {#if !isEpisodeType}
                <div class="space-y-2">
                    <ImageDropZone
                        artworkType="poster"
                        discogsUrl={posterInfo ? posterInfo.discogsUrl : discogsAttribution?.poster}
                        currentUrl={effectivePosterUrl}
                        {mediaId}
                        onsaved={handleSaved}
                        {hasProvider}
                        onbrowse={() => (browsingType = 'poster')}
                        isInherited={posterInfo !== undefined && posterInfo.source !== 'self'}
                        sourceName={posterInfo?.sourceName}
                        sourceId={posterInfo?.sourceId}
                        sourceLevel={posterInfo?.source !== 'self'
                            ? (posterInfo?.source as 'season' | 'series' | 'album' | 'artist')
                            : undefined}
                        hasLocalArtwork={!artworkKnown || posterInfo?.source === 'self'}
                        {mediaType}
                        {maxImageUploadMb} />
                    {#if canExtractVideo}
                        <button
                            onclick={() => handleExtract('poster')}
                            disabled={isExtracting !== null}
                            class="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-surface-700 hover:bg-surface-600 disabled:bg-surface-800 disabled:text-surface-500 text-white text-xs font-medium rounded transition-colors">
                            <Icon
                                src={Film}
                                class="w-3.5 h-3.5 {isExtracting === 'poster'
                                    ? 'animate-pulse'
                                    : ''}" />
                            {isExtracting === 'poster'
                                ? m.media_images_extracting()
                                : m.media_images_extract_from_video()}
                        </button>
                    {/if}
                </div>
            {/if}
            <div class="space-y-2">
                <ImageDropZone
                    artworkType="backdrop"
                    discogsUrl={backdropInfo
                        ? backdropInfo.discogsUrl
                        : discogsAttribution?.backdrop}
                    currentUrl={effectiveBackdropUrl}
                    {mediaId}
                    onsaved={handleSaved}
                    {hasProvider}
                    onbrowse={() => (browsingType = 'backdrop')}
                    isInherited={backdropInfo !== undefined
                        ? backdropInfo.source !== 'self'
                        : isEpisodeType && !!effectiveBackdropUrl}
                    sourceName={backdropInfo?.sourceName}
                    sourceId={backdropInfo?.sourceId}
                    sourceLevel={backdropInfo !== undefined
                        ? backdropInfo.source !== 'self'
                            ? (backdropInfo.source as 'season' | 'series' | 'album' | 'artist')
                            : undefined
                        : isEpisodeType && !!effectiveBackdropUrl
                          ? 'series'
                          : undefined}
                    hasLocalArtwork={!artworkKnown || backdropInfo?.source === 'self'}
                    {mediaType}
                    {maxImageUploadMb} />
                {#if canExtractVideo}
                    <button
                        onclick={() => handleExtract('backdrop')}
                        disabled={isExtracting !== null}
                        class="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-surface-700 hover:bg-surface-600 disabled:bg-surface-800 disabled:text-surface-500 text-white text-xs font-medium rounded transition-colors">
                        <Icon
                            src={Film}
                            class="w-3.5 h-3.5 {isExtracting === 'backdrop'
                                ? 'animate-pulse'
                                : ''}" />
                        {isExtracting === 'backdrop'
                            ? m.media_images_extracting()
                            : m.media_images_extract_from_video()}
                    </button>
                {/if}
            </div>
            <ImageDropZone
                artworkType="logo"
                discogsUrl={logoInfo ? logoInfo.discogsUrl : discogsAttribution?.logo}
                currentUrl={effectiveLogoUrl}
                {mediaId}
                onsaved={handleSaved}
                {hasProvider}
                onbrowse={() => (browsingType = 'logo')}
                isInherited={logoInfo !== undefined
                    ? logoInfo.source !== 'self'
                    : isEpisodeType && !!effectiveLogoUrl}
                sourceName={logoInfo?.sourceName}
                sourceId={logoInfo?.sourceId}
                sourceLevel={logoInfo !== undefined
                    ? logoInfo.source !== 'self'
                        ? (logoInfo.source as 'season' | 'series' | 'album' | 'artist')
                        : undefined
                    : isEpisodeType && !!effectiveLogoUrl
                      ? 'series'
                      : undefined}
                hasLocalArtwork={!artworkKnown || logoInfo?.source === 'self'}
                {mediaType}
                {maxImageUploadMb} />
            <div class="space-y-2">
                <ImageDropZone
                    artworkType="thumb"
                    currentUrl={effectiveThumbUrl}
                    {mediaId}
                    onsaved={handleSaved}
                    isInherited={thumbInfo !== undefined && thumbInfo.source !== 'self'}
                    sourceName={thumbInfo?.sourceName}
                    sourceId={thumbInfo?.sourceId}
                    sourceLevel={thumbInfo?.source !== 'self'
                        ? (thumbInfo?.source as 'season' | 'series' | 'album' | 'artist')
                        : undefined}
                    hasLocalArtwork={!artworkKnown || thumbInfo?.source === 'self'}
                    {mediaType}
                    {maxImageUploadMb} />
                {#if isEpisodeType}
                    <button
                        onclick={() => handleExtract('thumb')}
                        disabled={isExtracting !== null}
                        class="w-full inline-flex items-center justify-center gap-1.5 px-3 py-1.5 bg-surface-700 hover:bg-surface-600 disabled:bg-surface-800 disabled:text-surface-500 text-white text-xs font-medium rounded transition-colors">
                        <Icon
                            src={Film}
                            class="w-3.5 h-3.5 {isExtracting === 'thumb' ? 'animate-pulse' : ''}" />
                        {isExtracting === 'thumb'
                            ? m.media_images_extracting()
                            : m.media_images_extract_from_video()}
                    </button>
                {/if}
            </div>
        </div>
    {/if}
    <ImageCandidates {mediaId} revision={saveBust} onsaved={handleSaved} />
    {#if isSeries || isSeason}
        <SharedEpisodeThumbnailReview {mediaId} revision={saveBust} onsaved={handleSaved} />
    {/if}
</div>
