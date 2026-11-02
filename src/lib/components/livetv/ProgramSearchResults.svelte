<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { GroupedProgramSearchResult } from '$lib/schemas/livetv.js';
    import { saveReturnPath } from '$lib/stores/playerNavigation';
    import { navigateTo } from '$lib/paths';
    import { highlightSearchTerms } from '$lib/utils/search/transformers';
    import { formatTemporalContext } from '$lib/utils/temporal-display.js';
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import { Icon, Radio } from 'svelte-hero-icons';
    import LiveBadge from './LiveBadge.svelte';
    import ChannelPicker from './ChannelPicker.svelte';

    interface Props {
        results: GroupedProgramSearchResult[];
        query: string;
        loading: boolean;
    }

    let { results, query, loading }: Props = $props();

    let expandedIndex = $state<number | null>(null);

    const TEMPORAL_STYLES: Record<string, { border: string; opacity: string }> = {
        live: { border: 'border-l-green-500', opacity: '' },
        upcoming_today: { border: 'border-l-blue-500', opacity: '' },
        future: { border: 'border-l-surface-500', opacity: '' },
        ended: { border: 'border-l-surface-600', opacity: 'opacity-50' },
    };

    function getTemporalStyle(status: string) {
        return TEMPORAL_STYLES[status] ?? TEMPORAL_STYLES.future;
    }

    function handleResultClick(result: GroupedProgramSearchResult, index: number) {
        if (result.temporalStatus === 'live' && result.channels.length > 0) {
            saveReturnPath();
            void navigateTo(`/watch/${result.channels[0].id}`);
            return;
        }
        if (result.channels.length === 1) {
            saveReturnPath();
            void navigateTo(`/watch/${result.channels[0].id}`);
            return;
        }
        expandedIndex = expandedIndex === index ? null : index;
    }

    function handleResultKeydown(
        event: KeyboardEvent,
        result: GroupedProgramSearchResult,
        index: number,
    ) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleResultClick(result, index);
        }
    }

    function handleChannelClick(channelId: string) {
        saveReturnPath();
        void navigateTo(`/watch/${channelId}`);
    }

    function truncate(text: string, maxLength: number): string {
        if (text.length <= maxLength) return text;
        return text.slice(0, maxLength).trimEnd() + '…';
    }

    function stripSuperscripts(name: string): string {
        return name.replace(/[¹²³⁰-⁹]/gu, '').trim();
    }

    function buildAriaLabel(
        result: GroupedProgramSearchResult,
        isLive: boolean,
        temporalText: string,
    ): string {
        const base = `${result.title} — ${isLive ? m.temporal_live_aria() : temporalText}`;
        if (result.channels.length > 1) {
            const channelNames = result.channels.map((c) => c.name).join(', ');
            return `${base}. ${m.program_available_on_channels({ count: result.channels.length, channels: channelNames })}`;
        }
        return base;
    }
</script>

{#if loading}
    <!-- Loading skeleton -->
    <div class="space-y-2">
        {#each Array(3) as _, i (i)}
            <div
                class="animate-pulse rounded-lg border-l-2 border-l-surface-700 bg-surface-800 p-3">
                <div class="flex items-center gap-2">
                    <div class="h-2.5 w-2.5 rounded-full bg-surface-700"></div>
                    <div class="h-4 w-48 rounded bg-surface-700"></div>
                </div>
                <div class="mt-2 h-3 w-72 rounded bg-surface-700/60"></div>
                <div class="mt-2 h-3 w-40 rounded bg-surface-700/40"></div>
            </div>
        {/each}
    </div>
{:else}
    <div class="space-y-1.5">
        {#each results as result, index (`${index}-${result.title}-${result.startTime}`)}
            {@const style = getTemporalStyle(result.temporalStatus)}
            {@const isExpanded = expandedIndex === index}
            {@const isLive = result.temporalStatus === 'live'}
            {@const temporalText = formatTemporalContext(
                result.temporalStatus,
                result.startTime,
                result.endTime,
                getLocale(),
            )}
            {@const hasMultipleChannels = result.channels.length > 1}
            <div
                class="cursor-pointer rounded-lg border-l-2 bg-surface-800 p-3 transition-all duration-300 hover:bg-surface-700 {style.border} {style.opacity}"
                role="button"
                tabindex="0"
                aria-expanded={!isLive && hasMultipleChannels ? isExpanded : undefined}
                aria-label={buildAriaLabel(result, isLive, temporalText)}
                onclick={() => handleResultClick(result, index)}
                onkeydown={(e) => handleResultKeydown(e, result, index)}>
                <!-- Title row -->
                <div class="flex items-center gap-2">
                    {#if isLive}
                        <LiveBadge size="sm" />
                    {:else}
                        <span
                            class="h-2.5 w-2.5 shrink-0 rounded-full {result.temporalStatus ===
                            'upcoming_today'
                                ? 'bg-blue-500'
                                : result.temporalStatus === 'ended'
                                  ? 'bg-surface-600'
                                  : 'bg-surface-500'}"></span>
                    {/if}
                    <span class="font-medium text-surface-100">
                        {@html highlightSearchTerms(result.title, query)}
                    </span>
                </div>

                <!-- Description snippet (hidden when expanded — full version shown below) -->
                {#if result.description && !isExpanded}
                    <p class="mt-1 line-clamp-2 pl-[18px] text-sm text-surface-400">
                        {@html highlightSearchTerms(truncate(result.description, 150), query)}
                    </p>
                {/if}

                <!-- Channel names + temporal context -->
                <div class="mt-1.5 flex items-center gap-1.5 pl-[18px] text-xs text-surface-500">
                    <Icon src={Radio} class="w-3.5 h-3.5 shrink-0" />
                    <span>{result.channels.map((c) => stripSuperscripts(c.name)).join(', ')}</span>
                    <span>•</span>
                    <span>{temporalText}</span>
                </div>

                <!-- Expanded view -->
                {#if isExpanded && !isLive && hasMultipleChannels}
                    <div class="mt-3 border-t border-surface-700 pt-3 pl-[18px]">
                        {#if result.description}
                            <p class="mb-3 text-sm text-surface-300">
                                {result.description}
                            </p>
                        {/if}
                        <ChannelPicker channels={result.channels} onSelect={handleChannelClick} />
                    </div>
                {/if}
            </div>
        {/each}
    </div>
{/if}
