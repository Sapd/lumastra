<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * DebugPanel - Admin debug overlay for media information
     *
     * Shows comprehensive media metadata including:
     * - Internal IDs (UUID, TMDB, IMDB, etc.)
     * - Service links (Jellyfin, Sonarr/Radarr, Jellyseerr)
     * - Metadata (type, year, genres, availability)
     * - Technical info (quality, languages, air date)
     */
    import { tryJoinUpstreamUrl } from '$lib/shared/upstream-url.js';
    import { Z } from '$lib/utils/z-index';
    import type { ExternalIds } from '$lib/types/api-common';
    import { Icon, XMark, ArrowTopRightOnSquare, ClipboardDocument } from 'svelte-hero-icons';
    import { toasts } from '$lib/stores/toast.store';
    import * as m from '$lib/paraglide/messages';
    import { getExternalIdFor } from '$lib/utils/external-ids';
    import { isMovie, isSeries } from '$lib/shared/media-types';
    import { toTmdbMediaType as toTmdbType } from '$lib/shared/media-type-domain';
    import * as adminApi from '$lib/api/admin';
    import { bodyPortal } from '$lib/utils/body-portal';

    interface Props {
        // IDs
        externalIds?: ExternalIds;
        jellyfinId?: string;
        sonarrSeriesId?: number;

        // Metadata
        mediaType: string;
        title: string;
        year?: string | number;
        genres?: string[];
        isAvailable?: boolean;
        canRequest?: boolean;
        sonarrHasFile?: boolean;
        sonarrQuality?: string;
        sonarrNetwork?: string;
        sonarrAirDate?: string;

        // Service URLs
        jellyfinUrl: string;
        sonarrUrl: string;
        radarrUrl: string;
        jellyseerrUrl: string;

        // Callback
        onclose: () => void;
    }

    let {
        externalIds = undefined,
        jellyfinId = undefined,
        sonarrSeriesId = undefined,
        mediaType,
        title,
        year = undefined,
        genres = undefined,
        isAvailable = false,
        canRequest = false,
        sonarrHasFile = false,
        sonarrQuality = undefined,
        sonarrNetwork = undefined,
        sonarrAirDate = undefined,
        jellyfinUrl,
        sonarrUrl,
        radarrUrl,
        jellyseerrUrl,
        onclose,
    }: Props = $props();

    // Handle ESC key
    function handleKeydown(e: KeyboardEvent) {
        if (e.key === 'Escape') {
            onclose();
        }
    }

    // Handle backdrop click (only close if clicking the backdrop itself, not child elements)
    function handleBackdropClick(e: MouseEvent) {
        if (e.target === e.currentTarget) {
            onclose();
        }
    }

    // Copy to clipboard
    async function copyToClipboard(text: string, label: string) {
        try {
            await navigator.clipboard.writeText(text);
            toasts.success(m.toast_copied_to_clipboard({ label }));
        } catch (err) {
            toasts.error(m.toast_failed_copy_clipboard());
        }
    }

    // Build service links
    function getJellyfinLink(): string | null {
        const itemId = jellyfinId;
        if (!jellyfinUrl || !itemId) return null;
        return tryJoinUpstreamUrl(
            jellyfinUrl,
            `/web/index.html#!/details?id=${encodeURIComponent(itemId)}`,
        );
    }

    function getSonarrLink(): string | null {
        if (!sonarrUrl || !isTvContent) return null;
        // Prefer titleSlug, fallback to numeric ID
        const slug = sonarrData.titleSlug;
        if (slug) {
            return `${sonarrUrl}/series/${slug}`;
        }
        // Fallback to numeric ID if no slug
        const seriesId = sonarrData.seriesId || sonarrSeriesId;
        if (!seriesId) return null;
        return `${sonarrUrl}/series/${seriesId}`;
    }

    function getRadarrLink(): string | null {
        if (!radarrUrl || isTvContent) return null;
        // Prefer titleSlug, fallback to numeric ID
        const slug = radarrData.titleSlug;
        if (slug) {
            return `${radarrUrl}/movie/${slug}`;
        }
        // Fallback to numeric ID if no slug
        const movieId = radarrData.movieId;
        if (!movieId) return null;
        return `${radarrUrl}/movie/${movieId}`;
    }

    function getJellyseerrLink(): string | null {
        const tmdbId = getExternalIdFor(externalIds, 'tmdb');
        if (!jellyseerrUrl || !tmdbId) return null;
        // Jellyseerr only has /movie/ and /tv/ routes. A null here means the item
        // has no TMDB namespace at all, so there is no page to link to — return
        // null (no link) instead of interpolating it into the URL. The old total
        // toTmdbType() never returned null, but it answered 'movie' for
        // audiobooks and tracks, producing a link to an unrelated Jellyseerr page.
        const type = toTmdbType(mediaType);
        if (!type) return null;
        return `${jellyseerrUrl}/${type}/${tmdbId}`;
    }

    // Format values
    function formatValue(value: unknown): string {
        if (value === undefined || value === null || value === '') return m.debug_value_na();
        if (Array.isArray(value)) {
            return value.length > 0 ? value.join(', ') : m.debug_value_none();
        }
        return String(value);
    }

    // Check if this is TV content (Sonarr manages TV shows)
    let isTvContent = $derived(isSeries(mediaType));

    // Jellyseerr data (fetched dynamically)
    let jellyseerrData = $state<{
        tvdbId: number | null;
        loading: boolean;
    }>({ tvdbId: null, loading: false });

    // Sonarr data (fetched dynamically for TV shows)
    let sonarrData = $state<{
        seriesId: number | null;
        titleSlug: string | null;
        loading: boolean;
    }>({ seriesId: null, titleSlug: null, loading: false });

    // Radarr data (fetched dynamically for movies)
    let radarrData = $state<{
        movieId: number | null;
        titleSlug: string | null;
        loading: boolean;
    }>({ movieId: null, titleSlug: null, loading: false });

    // Fetch Jellyseerr data when panel opens (only for TV content - movies don't have TVDB IDs)
    $effect(() => {
        const tmdbId = getExternalIdFor(externalIds, 'tmdb');

        // Only fetch for TV content (movies don't have TVDB IDs)
        if (!tmdbId || !isSeries(mediaType)) {
            jellyseerrData = { tvdbId: null, loading: false };
            return;
        }

        jellyseerrData = { tvdbId: null, loading: true };

        const controller = new AbortController();

        adminApi
            .debugJellyseerr(tmdbId, 'tv')
            .then(({ data, error: debugError }) => {
                if (controller.signal.aborted) return;
                if (debugError) {
                    throw new Error(debugError);
                }
                const typedData = (data ?? {}) as {
                    tvdbId: number | null | undefined;
                };
                // Explicitly convert undefined to null
                jellyseerrData = {
                    tvdbId: typedData?.tvdbId ?? null,
                    loading: false,
                };
            })
            .catch((err: unknown) => {
                if (controller.signal.aborted) return;
                console.error('Failed to fetch Seerr data:', err);
                jellyseerrData = { tvdbId: null, loading: false };
            });

        return () => {
            controller.abort();
        };
    });

    // Fetch Sonarr data when we have TVDB ID (for TV shows)
    $effect(() => {
        // Wait for TVDB ID to be available (from Jellyseerr or database)
        const tvdbId = jellyseerrData.tvdbId || getExternalIdFor(externalIds, 'tvdb');

        if (!tvdbId || !isSeries(mediaType) || !sonarrUrl) {
            sonarrData = { seriesId: null, titleSlug: null, loading: false };
            return;
        }

        sonarrData = { seriesId: null, titleSlug: null, loading: true };

        const controller = new AbortController();

        adminApi
            .debugSonarrLookup(tvdbId)
            .then(({ data, error: sonarrError }) => {
                if (controller.signal.aborted) return;
                if (sonarrError) throw new Error(sonarrError);
                const typedData = (data ?? {}) as {
                    seriesId: number | null;
                    titleSlug: string | null;
                };
                sonarrData = {
                    seriesId: typedData?.seriesId ?? null,
                    titleSlug: typedData?.titleSlug ?? null,
                    loading: false,
                };
            })
            .catch((err: unknown) => {
                if (controller.signal.aborted) return;
                console.error('Failed to fetch Sonarr data:', err);
                sonarrData = {
                    seriesId: null,
                    titleSlug: null,
                    loading: false,
                };
            });

        return () => {
            controller.abort();
        };
    });

    // Fetch Radarr data for movies
    $effect(() => {
        const tmdbId = getExternalIdFor(externalIds, 'tmdb');

        if (!tmdbId || isSeries(mediaType) || !radarrUrl) {
            radarrData = { movieId: null, titleSlug: null, loading: false };
            return;
        }

        radarrData = { movieId: null, titleSlug: null, loading: true };

        const controller = new AbortController();

        adminApi
            .debugRadarrLookup(tmdbId)
            .then(({ data, error: radarrError }) => {
                if (controller.signal.aborted) return;
                if (radarrError) throw new Error(radarrError);
                const typedData = (data ?? {}) as {
                    movieId: number | null;
                    titleSlug: string | null;
                };
                radarrData = {
                    movieId: typedData?.movieId ?? null,
                    titleSlug: typedData?.titleSlug ?? null,
                    loading: false,
                };
            })
            .catch((err: unknown) => {
                if (controller.signal.aborted) return;
                console.error('Failed to fetch Radarr data:', err);
                radarrData = { movieId: null, titleSlug: null, loading: false };
            });

        return () => {
            controller.abort();
        };
    });
</script>

<svelte:window onkeydown={handleKeydown} />

<!-- Backdrop overlay — portaled to document.body so `position: fixed` resolves
     against the viewport instead of being trapped by the modal's own
     ancestor stacking context (same issue ActionPopover works around). -->
<div
    use:bodyPortal
    class="fixed inset-0 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4"
    style="z-index: {Z.TOOLTIP}"
    onclick={handleBackdropClick}
    role="presentation">
    <!-- Panel -->
    <div
        class="bg-surface-800 rounded-lg shadow-2xl p-6 w-[90vw] max-w-3xl max-h-[90vh] overflow-y-auto"
        role="dialog"
        tabindex="-1"
        aria-labelledby="debug-panel-title"
        aria-modal="true">
        <!-- Header -->
        <div class="flex items-start justify-between mb-6">
            <div>
                <h2 id="debug-panel-title" class="text-xl font-bold">
                    {m.modal_admin_debug_info_title()}
                </h2>
                <p class="text-sm text-surface-400 mt-1">{title}</p>
            </div>
            <button
                class="btn-icon variant-ghost-surface"
                onclick={onclose}
                aria-label={m.modal_close_debug_panel()}>
                <Icon src={XMark} class="w-5 h-5" />
            </button>
        </div>

        <!-- Section 1: Internal IDs -->
        <div class="mb-6">
            <h3 class="text-lg font-semibold mb-3">Internal IDs</h3>
            <div class="space-y-2">
                {#each [{ label: 'TMDB ID', value: getExternalIdFor(externalIds, 'tmdb') }, { label: 'IMDB ID', value: getExternalIdFor(externalIds, 'imdb') }, { label: 'TVDB ID', value: jellyseerrData.loading ? m.debug_loading() : getExternalIdFor(externalIds, 'tvdb') || jellyseerrData.tvdbId }, { label: 'Jellyfin ID', value: jellyfinId }] as id (id.label)}
                    <div class="flex items-center justify-between bg-surface-700 rounded p-2">
                        <div class="flex-1">
                            <span class="text-surface-300 text-sm">{id.label}:</span>
                            <span class="font-mono text-sm ml-2">{formatValue(id.value)}</span>
                        </div>
                        {#if id.value}
                            <button
                                class="btn-icon btn-icon-sm variant-ghost-surface ml-2"
                                onclick={() => copyToClipboard(String(id.value), id.label)}
                                title={m.modal_copy_to_clipboard()}>
                                <Icon src={ClipboardDocument} class="w-4 h-4" />
                            </button>
                        {/if}
                    </div>
                {/each}
            </div>
        </div>

        <!-- Section 2: Service Links -->
        {#if getJellyfinLink() || getSonarrLink() || getRadarrLink() || getJellyseerrLink()}
            <div class="mb-6">
                <h3 class="text-lg font-semibold mb-3">Service Links</h3>
                <div class="space-y-2">
                    {#if getJellyfinLink()}
                        <a
                            href={getJellyfinLink()}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="flex items-center gap-2 bg-surface-700 rounded p-2 hover:bg-surface-600 transition-colors">
                            <span class="text-sm">Jellyfin</span>
                            <Icon src={ArrowTopRightOnSquare} class="w-4 h-4" />
                        </a>
                    {/if}
                    {#if getSonarrLink()}
                        <a
                            href={getSonarrLink()}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="flex items-center gap-2 bg-surface-700 rounded p-2 hover:bg-surface-600 transition-colors">
                            <span class="text-sm">Sonarr</span>
                            <Icon src={ArrowTopRightOnSquare} class="w-4 h-4" />
                        </a>
                    {/if}
                    {#if getRadarrLink()}
                        <a
                            href={getRadarrLink()}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="flex items-center gap-2 bg-surface-700 rounded p-2 hover:bg-surface-600 transition-colors">
                            <span class="text-sm">Radarr</span>
                            <Icon src={ArrowTopRightOnSquare} class="w-4 h-4" />
                        </a>
                    {/if}
                    {#if getJellyseerrLink()}
                        <a
                            href={getJellyseerrLink()}
                            target="_blank"
                            rel="noopener noreferrer"
                            class="flex items-center gap-2 bg-surface-700 rounded p-2 hover:bg-surface-600 transition-colors">
                            <span class="text-sm">Seerr</span>
                            <Icon src={ArrowTopRightOnSquare} class="w-4 h-4" />
                        </a>
                    {/if}
                </div>
            </div>
        {/if}

        <!-- Section 3: Metadata -->
        <div class="mb-6">
            <h3 class="text-lg font-semibold mb-3">Metadata</h3>
            <div class="space-y-2">
                <div class="bg-surface-700 rounded p-2">
                    <span class="text-surface-300 text-sm">Media Type:</span>
                    <span class="ml-2">{mediaType}</span>
                </div>
                <div class="bg-surface-700 rounded p-2">
                    <span class="text-surface-300 text-sm">Year:</span>
                    <span class="ml-2">{formatValue(year)}</span>
                </div>
                <div class="bg-surface-700 rounded p-2">
                    <span class="text-surface-300 text-sm">Genres:</span>
                    <span class="ml-2">{formatValue(genres)}</span>
                </div>
                <div class="bg-surface-700 rounded p-2">
                    <span class="text-surface-300 text-sm">Available in Jellyfin:</span>
                    <span class="ml-2">{isAvailable ? 'Yes' : 'No'}</span>
                </div>
                <div class="bg-surface-700 rounded p-2">
                    <span class="text-surface-300 text-sm">Can Request:</span>
                    <span class="ml-2">{canRequest ? 'Yes' : 'No'}</span>
                </div>
                {#if isTvContent}
                    <div class="bg-surface-700 rounded p-2">
                        <span class="text-surface-300 text-sm">Has File (Sonarr):</span>
                        <span class="ml-2">{sonarrHasFile ? 'Yes' : 'No'}</span>
                    </div>
                {/if}
            </div>
        </div>

        <!-- Section 4: TV Show Info (Sonarr) - Only for TV content -->
        {#if isTvContent && (sonarrQuality || sonarrNetwork || sonarrAirDate)}
            <div>
                <h3 class="text-lg font-semibold mb-3">TV Show Info (Sonarr)</h3>
                <div class="space-y-2">
                    {#if sonarrQuality}
                        <div class="bg-surface-700 rounded p-2">
                            <span class="text-surface-300 text-sm">Quality Profile:</span>
                            <span class="ml-2">{formatValue(sonarrQuality)}</span>
                        </div>
                    {/if}
                    {#if sonarrNetwork}
                        <div class="bg-surface-700 rounded p-2">
                            <span class="text-surface-300 text-sm">Network:</span>
                            <span class="ml-2">{formatValue(sonarrNetwork)}</span>
                        </div>
                    {/if}
                    {#if sonarrAirDate}
                        <div class="bg-surface-700 rounded p-2">
                            <span class="text-surface-300 text-sm">Air Date:</span>
                            <span class="ml-2">{formatValue(sonarrAirDate)}</span>
                        </div>
                    {/if}
                </div>
            </div>
        {/if}
    </div>
</div>

<style>
    /* Smooth scrolling for long content */
    .overflow-y-auto {
        scrollbar-width: thin;
        scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
    }

    .overflow-y-auto::-webkit-scrollbar {
        width: 8px;
    }

    .overflow-y-auto::-webkit-scrollbar-track {
        background: transparent;
    }

    .overflow-y-auto::-webkit-scrollbar-thumb {
        background-color: rgba(255, 255, 255, 0.2);
        border-radius: 4px;
    }

    .overflow-y-auto::-webkit-scrollbar-thumb:hover {
        background-color: rgba(255, 255, 255, 0.3);
    }
</style>
