<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import type { LiveTvAiring } from '$lib/schemas/livetv.js';

    interface Props {
        program: LiveTvAiring;
        channelName: string;
        channelLogoUrl?: string;
        onWatchChannel: () => void;
        onClose: () => void;
        modalId?: string;
    }

    const fallbackId = `program-details-${Math.random().toString(36).slice(2, 9)}`;

    let {
        program,
        channelName,
        channelLogoUrl,
        onWatchChannel,
        onClose,
        modalId = fallbackId,
    }: Props = $props();

    let logoFailed = $state(false);

    let startDate = $derived(new Date(program.startTime));
    let endDate = $derived(new Date(program.endTime));

    // Only show weekday/date once the program isn't today — a bare time range
    // is ambiguous once the guide window crosses a midnight boundary.
    let isToday = $derived.by(() => {
        const now = new Date();
        return (
            startDate.getFullYear() === now.getFullYear() &&
            startDate.getMonth() === now.getMonth() &&
            startDate.getDate() === now.getDate()
        );
    });

    let timeRangeLabel = $derived.by(() => {
        const timeFmt: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
        const start = startDate.toLocaleTimeString(getLocale(), timeFmt);
        const end = endDate.toLocaleTimeString(getLocale(), timeFmt);
        if (isToday) return `${start} – ${end}`;
        const dateLabel = startDate.toLocaleDateString(getLocale(), {
            weekday: 'long',
            day: 'numeric',
            month: 'short',
        });
        return `${dateLabel} · ${start} – ${end}`;
    });
</script>

<div
    class="bg-surface-800 w-full max-w-md rounded-xl p-6 shadow-xl"
    role="alertdialog"
    aria-labelledby="{modalId}-title"
    aria-describedby="{modalId}-desc">
    <div class="mb-4 flex items-center gap-3">
        {#if channelLogoUrl && !logoFailed}
            <img
                src={channelLogoUrl}
                alt={channelName}
                class="h-10 w-10 shrink-0 rounded bg-surface-900 object-contain"
                loading="lazy"
                onerror={() => (logoFailed = true)} />
        {:else}
            <div
                class="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-700 text-sm font-bold text-white">
                {channelName.charAt(0).toUpperCase()}
            </div>
        {/if}
        <div class="min-w-0">
            <h2 id="{modalId}-title" class="truncate text-lg font-semibold text-white">
                {program.title}
            </h2>
            <p id="{modalId}-desc" class="text-sm text-surface-400">
                {channelName} · {timeRangeLabel}
            </p>
        </div>
    </div>

    {#if program.description}
        <p class="mb-5 line-clamp-4 text-sm text-surface-300">
            {program.description}
        </p>
    {/if}

    <div class="flex justify-end gap-3">
        <button class="btn variant-ghost-surface" onclick={onClose}>
            {m.livetv_stream_limit_close()}
        </button>
        <button class="btn variant-filled-primary" onclick={onWatchChannel}>
            {m.program_guide_watch_channel()}
        </button>
    </div>
</div>
