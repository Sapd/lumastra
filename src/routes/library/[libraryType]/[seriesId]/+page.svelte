<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { goto } from '$app/navigation';
    import { renderSubtitleTemplate } from '$lib/shared/library-type-templates';
    import { getCatalogPosterUrl, getCatalogThumbUrl } from '$lib/utils/image-utils';
    import LibraryMetadataPanel from '$lib/components/library/LibraryMetadataPanel.svelte';
    import type { PageData } from './$types';
    import { appPath } from '$lib/shared/api-urls.js';
    import { resolve } from '$lib/paths';

    let { data }: { data: PageData } = $props();

    const { series, episodes, libraryType, template, completedCount, continueEpisodeId } =
        $derived(data);

    const totalRuntimeSeconds = $derived(
        episodes.reduce((sum, ep) => sum + (ep.runtime_seconds ?? 0), 0),
    );

    function formatDuration(seconds: number): string {
        if (seconds < 60) return `${seconds}s`;
        const m = Math.floor(seconds / 60);
        if (m < 60) return `${m}m`;
        const h = Math.floor(m / 60);
        const rem = m % 60;
        return rem > 0 ? `${h}h ${rem}m` : `${h}h`;
    }

    /** Convert SxxEyy titles or raw filenames to readable display titles. */
    function getDisplayTitle(title: string, fileName: string | null): string {
        if (/^S\d{2}E\d{2}$/.test(title) && fileName) {
            const name = fileName.replace(/\.[^.]+$/, '');
            return name.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
        }
        return title;
    }

    const progressPct = $derived(
        episodes.length > 0 ? Math.round((completedCount / episodes.length) * 100) : 0,
    );
</script>

<svelte:head>
    <title>{series.title}</title>
</svelte:head>

<div class="max-w-4xl mx-auto px-4 pt-4 lg:pt-20 pb-8">
    <!-- Back navigation -->
    <a
        href={resolve(`/library/${libraryType}`)}
        class="inline-flex items-center gap-1.5 text-sm text-surface-400 hover:text-white mb-6 transition-colors">
        <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
                stroke-linecap="round"
                stroke-linejoin="round"
                stroke-width="2"
                d="M15 19l-7-7 7-7" />
        </svg>
        {m.library_back_to({ label: template.label })}
    </a>

    <!-- Series header -->
    <div class="flex gap-6 mb-8">
        <!-- Poster -->
        <div class="w-36 flex-shrink-0">
            <div class="aspect-video rounded-lg overflow-hidden bg-surface-700">
                <img
                    src={getCatalogPosterUrl(series.id, { size: 'card' })}
                    alt={series.title}
                    class="w-full h-full object-cover"
                    onerror={(e) => {
                        (e.currentTarget as HTMLImageElement).style.display = 'none';
                    }} />
            </div>
        </div>

        <!-- Info -->
        <div class="flex-1 min-w-0">
            <h1 class="text-2xl font-bold text-white mb-1">{series.title}</h1>

            {#if template}
                {@const subtitle = renderSubtitleTemplate(
                    template.cardConfig.subtitleTemplate,
                    series.custom_metadata,
                )}
                {#if subtitle}
                    <p class="text-sm text-surface-400 mb-2">{subtitle}</p>
                {/if}
            {/if}

            <p class="text-sm text-surface-500 mb-3">
                {episodes.length}
                {episodes.length === 1
                    ? template.cardConfig.clipLabel.slice(0, -1).toLowerCase()
                    : template.cardConfig.clipLabel.toLowerCase()}
                {#if totalRuntimeSeconds > 0}
                    &middot; {m.library_total_runtime({
                        duration: formatDuration(totalRuntimeSeconds),
                    })}
                {/if}
            </p>

            {#if series.overview}
                <p class="text-sm text-surface-300 mb-4 line-clamp-3">
                    {series.overview}
                </p>
            {/if}

            <LibraryMetadataPanel
                fields={template.metadataFields}
                metadata={series.custom_metadata} />

            <!-- Progress -->
            {#if episodes.length > 1}
                <div class="mb-4">
                    <div class="flex items-center justify-between text-xs text-surface-500 mb-1">
                        <span
                            >{m.library_completed_of({
                                completed: String(completedCount),
                                total: String(episodes.length),
                            })}</span>
                        <span>{progressPct}%</span>
                    </div>
                    <div class="h-1.5 bg-surface-700 rounded-full overflow-hidden">
                        <div
                            class="h-full bg-primary-500 rounded-full transition-all"
                            style="width: {progressPct}%">
                        </div>
                    </div>
                </div>
            {/if}

            <!-- Actions -->
            <div class="flex gap-3">
                {#if continueEpisodeId}
                    <button
                        class="px-5 py-2 bg-primary-600 hover:bg-primary-500 text-white rounded-lg text-sm font-medium transition-colors"
                        onclick={() => goto(appPath(`/watch/${continueEpisodeId}`))}>
                        {#if completedCount > 0 && completedCount < episodes.length}
                            ▶ {m.library_continue()}
                        {:else}
                            ▶ {m.play()}
                        {/if}
                    </button>
                {/if}
                {#if episodes.length > 1 && completedCount > 0}
                    <button
                        class="px-5 py-2 bg-surface-700 hover:bg-surface-600 text-white rounded-lg text-sm font-medium transition-colors"
                        onclick={() => goto(appPath(`/watch/${episodes[0].id}`))}>
                        {m.library_play_from_start()}
                    </button>
                {/if}
            </div>
        </div>
    </div>

    <!-- Episode list -->
    <div class="space-y-2">
        <h2 class="text-sm font-semibold text-surface-400 uppercase tracking-wider mb-3">
            {template.cardConfig.clipLabel}
        </h2>
        {#each episodes as ep, i (ep.id)}
            <button
                class="w-full flex items-center gap-4 p-3 rounded-lg bg-surface-800/50 hover:bg-surface-700/70 transition-colors text-left group"
                onclick={() => goto(appPath(`/watch/${ep.id}`))}>
                <!-- Episode number + status -->
                <div class="w-8 flex-shrink-0 text-center">
                    {#if ep.is_watched}
                        <span class="text-primary-500 text-lg" title={m.status_completed()}>✓</span>
                    {:else if ep.resume_position_ms > 0}
                        <span class="text-surface-400 text-lg" title={m.status_in_progress()}
                            >◐</span>
                    {:else}
                        <span class="text-surface-600 text-sm font-medium">{i + 1}</span>
                    {/if}
                </div>

                <!-- Thumbnail -->
                <div class="w-20 flex-shrink-0">
                    <div class="aspect-video rounded overflow-hidden bg-surface-700">
                        <img
                            src={getCatalogThumbUrl(ep.id, { size: 'thumb' })}
                            alt={getDisplayTitle(ep.title, ep.file_name)}
                            class="w-full h-full object-cover group-hover:scale-105 transition-transform"
                            onerror={(e) => {
                                (e.currentTarget as HTMLImageElement).style.display = 'none';
                            }} />
                    </div>
                </div>

                <!-- Title + overview -->
                <div class="flex-1 min-w-0">
                    <p class="text-sm font-medium text-white truncate">
                        {getDisplayTitle(ep.title, ep.file_name)}
                    </p>
                    {#if ep.overview}
                        <p class="text-xs text-surface-400 truncate mt-0.5">
                            {ep.overview}
                        </p>
                    {/if}
                    {#if ep.resume_position_ms > 0 && !ep.is_watched}
                        <div class="mt-1.5 h-0.5 bg-surface-700 rounded-full overflow-hidden w-24">
                            <div
                                class="h-full bg-primary-500 rounded-full"
                                style="width: {ep.runtime_seconds
                                    ? Math.min(
                                          100,
                                          Math.round(
                                              (ep.resume_position_ms / 1000 / ep.runtime_seconds) *
                                                  100,
                                          ),
                                      )
                                    : 0}%">
                            </div>
                        </div>
                    {/if}
                </div>

                <!-- Duration -->
                {#if ep.runtime_seconds}
                    <span class="text-xs text-surface-500 flex-shrink-0">
                        {formatDuration(ep.runtime_seconds)}
                    </span>
                {/if}

                <!-- Play arrow -->
                <svg
                    class="w-4 h-4 text-surface-600 group-hover:text-surface-300 flex-shrink-0 transition-colors"
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24">
                    <path
                        stroke-linecap="round"
                        stroke-linejoin="round"
                        stroke-width="2"
                        d="M9 5l7 7-7 7" />
                </svg>
            </button>
        {/each}
    </div>
</div>
