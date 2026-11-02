<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  The channels of a numbered family ("StreamTV Live Event 1..10") in a dialog:
  a guide of just those channels (what runs on which, the reason to pick one)
  and a card list. The grid used to expand families inline, which pushed every
  card below the family down the page.
-->
<script lang="ts">
    import { setContext } from 'svelte';
    import type { LiveTvStation } from '$lib/schemas/livetv.js';
    import type { LiveTvAvailability } from '$lib/schemas/livetv-availability.js';
    import { LIVE_TV_AVAILABILITY_CONTEXT } from '$lib/shared/livetv-availability-context.js';
    import * as m from '$lib/paraglide/messages.js';
    import ChannelCard from './ChannelCard.svelte';
    import ProgramGuide from './ProgramGuide.svelte';

    interface Props {
        label: string;
        channels: LiveTvStation[];
        now: number;
        onPick: (channel: LiveTvStation) => void;
        onClose: () => void;
        favoriteChannelIds?: Set<string> | ReadonlySet<string>;
        onToggleFavorite?: (channel: LiveTvStation) => void;
        /** The grid's availability getter: a modal renders outside its context. */
        getAvailability?: () => LiveTvAvailability | undefined;
    }

    let {
        label,
        channels,
        now,
        onPick,
        onClose,
        favoriteChannelIds,
        onToggleFavorite,
        getAvailability,
    }: Props = $props();

    // svelte-ignore state_referenced_locally
    if (getAvailability) setContext(LIVE_TV_AVAILABILITY_CONTEXT, getAvailability);

    // The guide is the reason to open a family, but only when it has something
    // to show: event placeholders ("Live Event 1..20") usually carry no
    // programmes, and an empty guide is a dead end.
    // svelte-ignore state_referenced_locally
    let view = $state<'guide' | 'channels'>(
        channels.some((ch) => ch.nowNext.current) ? 'guide' : 'channels',
    );
    const titleId = `channel-family-${Math.random().toString(36).slice(2, 9)}`;
</script>

<div
    class="bg-surface-800 flex max-h-[90vh] w-full max-w-5xl flex-col rounded-xl shadow-xl"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}>
    <div class="flex items-center justify-between gap-3 border-b border-surface-700 p-4">
        <div class="min-w-0">
            <h2 id={titleId} class="truncate text-lg font-semibold text-white">{label}</h2>
            <p class="text-sm text-surface-400">
                {m.livetv_channels_count({ count: channels.length })}
            </p>
        </div>
        <div class="flex shrink-0 items-center gap-2">
            <div class="flex rounded-lg bg-surface-900 p-0.5" role="group">
                <button
                    type="button"
                    aria-pressed={view === 'guide'}
                    class="min-h-9 rounded-md px-3 text-sm {view === 'guide'
                        ? 'bg-primary-600 text-white'
                        : 'text-surface-300'}"
                    onclick={() => (view = 'guide')}>{m.livetv_view_guide()}</button>
                <button
                    type="button"
                    aria-pressed={view === 'channels'}
                    class="min-h-9 rounded-md px-3 text-sm {view === 'channels'
                        ? 'bg-primary-600 text-white'
                        : 'text-surface-300'}"
                    onclick={() => (view = 'channels')}>{m.livetv_view_grid()}</button>
            </div>
            <button type="button" class="btn variant-ghost-surface" onclick={onClose}>
                {m.close()}
            </button>
        </div>
    </div>
    {#if view === 'guide'}
        <div class="overflow-hidden rounded-b-xl">
            <ProgramGuide
                {channels}
                categories={[]}
                onChannelClick={onPick}
                scoped
                sharedPrefix={label}
                height="min(60vh, {Math.max(channels.length * 56 + 48, 200)}px)" />
        </div>
    {:else}
        <div class="overflow-y-auto p-4">
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
                {#each channels as channel (channel.id)}
                    <ChannelCard
                        {channel}
                        {now}
                        onclick={onPick}
                        favorite={favoriteChannelIds?.has(channel.id)}
                        {onToggleFavorite} />
                {/each}
            </div>
        </div>
    {/if}
</div>
