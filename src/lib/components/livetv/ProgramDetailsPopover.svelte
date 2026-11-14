<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * Programme detail panel of the Live TV guide, opened through the modal
     * store (ModalContainer supplies role="dialog", the focus trap, Esc and
     * backdrop close, and labels the dialog from the h2 below).
     *
     * Shows what the guide payload carries for an airing: title, channel,
     * time slot, live progress, description, genres and age rating. "Watch
     * now" only while the programme is on air — there is no DVR, so an
     * upcoming or past programme is information only.
     */
    import { onDestroy } from 'svelte';
    import { Icon, Play, XMark } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import type { LiveTvAiring } from '$lib/schemas/livetv.js';
    import LiveBadge from './LiveBadge.svelte';

    interface Props {
        program: LiveTvAiring;
        channelName: string;
        channelLogoUrl?: string;
        channelNumber?: number;
        channelCategory?: string;
        onWatchChannel: () => void;
        onClose: () => void;
    }

    let {
        program,
        channelName,
        channelLogoUrl,
        channelNumber,
        channelCategory,
        onWatchChannel,
        onClose,
    }: Props = $props();

    let logoFailed = $state(false);

    // Live state moves while the panel is open: re-evaluate every 30 s.
    let nowMs = $state(Date.now());
    const clock = setInterval(() => (nowMs = Date.now()), 30_000);
    onDestroy(() => clearInterval(clock));

    let startMs = $derived(new Date(program.startTime).getTime());
    let endMs = $derived(new Date(program.endTime).getTime());
    let durationMin = $derived(Math.max(0, Math.round((endMs - startMs) / 60_000)));
    let status = $derived<'live' | 'upcoming' | 'ended'>(
        nowMs < startMs ? 'upcoming' : nowMs >= endMs ? 'ended' : 'live',
    );
    let progress = $derived(
        endMs > startMs
            ? Math.round(Math.max(0, Math.min(100, ((nowMs - startMs) / (endMs - startMs)) * 100)))
            : 0,
    );
    let minutesLeft = $derived(Math.max(1, Math.ceil((endMs - nowMs) / 60_000)));
    let minutesUntil = $derived(Math.max(1, Math.ceil((startMs - nowMs) / 60_000)));

    function dayKey(d: Date): number {
        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    }

    // "Today" / "Tomorrow", else the weekday and date: a bare time range is
    // ambiguous once the guide window crosses midnight.
    let dayLabel = $derived.by(() => {
        const start = new Date(startMs);
        const days = Math.round((dayKey(start) - dayKey(new Date(nowMs))) / 86_400_000);
        if (days === 0) return m.program_details_today();
        if (days === 1) return m.program_details_tomorrow();
        return start.toLocaleDateString(getLocale(), {
            weekday: 'long',
            day: 'numeric',
            month: 'short',
        });
    });

    let timeRange = $derived.by(() => {
        const fmt: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit' };
        const start = new Date(startMs).toLocaleTimeString(getLocale(), fmt);
        const end = new Date(endMs).toLocaleTimeString(getLocale(), fmt);
        return `${start} – ${end}`;
    });

    let channelLine = $derived(
        [channelNumber != null ? String(channelNumber) : undefined, channelName, channelCategory]
            .filter(Boolean)
            .join(' · '),
    );
    let genres = $derived((program.genres ?? []).filter((g) => g.trim()));
</script>

<div
    class="bg-surface-800 relative flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-xl border border-surface-600/60 shadow-xl"
    data-testid="program-details">
    <button
        type="button"
        class="absolute right-3 top-3 z-10 flex h-9 w-9 items-center justify-center rounded-full bg-surface-900/70 text-surface-200 transition-colors hover:bg-surface-700 hover:text-white"
        aria-label={m.program_details_close_aria()}
        onclick={onClose}>
        <Icon src={XMark} size="20" />
    </button>

    <div class="overflow-y-auto p-5 sm:p-6">
        <div class="flex items-center gap-3 pr-10">
            {#if channelLogoUrl && !logoFailed}
                <img
                    src={channelLogoUrl}
                    alt=""
                    class="h-10 w-10 shrink-0 rounded bg-surface-900 object-contain p-1"
                    loading="lazy"
                    onerror={() => (logoFailed = true)} />
            {:else}
                <div
                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-700 text-sm font-bold text-white"
                    aria-hidden="true">
                    {channelName.charAt(0).toUpperCase()}
                </div>
            {/if}
            <p class="min-w-0 truncate text-sm text-surface-300">{channelLine}</p>
        </div>

        <h2 class="mt-4 text-xl font-semibold leading-snug text-white sm:text-2xl">
            {program.title}
        </h2>

        <p class="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-surface-400">
            {#if status === 'live'}<LiveBadge size="md" />{/if}
            <span>{dayLabel} · {timeRange} · {m.program_details_duration({ n: durationMin })}</span>
            {#if program.officialRating}
                <span
                    class="rounded border border-surface-500 px-1.5 py-0.5 text-xs font-medium text-surface-200"
                    aria-label={m.program_details_rating_aria({ rating: program.officialRating })}
                    >{program.officialRating}</span>
            {/if}
        </p>

        {#if status === 'live'}
            <div class="mt-3 flex items-center gap-3">
                <div
                    class="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-600/60"
                    role="progressbar"
                    aria-label={m.program_details_progress_aria()}
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={progress}>
                    <div class="h-full bg-primary-500" style="width: {progress}%"></div>
                </div>
                <span class="shrink-0 text-xs text-surface-300"
                    >{m.hero_minutes_left({ n: minutesLeft })}</span>
            </div>
        {:else if status === 'upcoming'}
            <p class="mt-3 text-sm text-surface-300">
                {m.program_details_starts_in({ n: minutesUntil })}
            </p>
        {:else}
            <p class="mt-3 text-sm text-surface-300">{m.program_details_ended()}</p>
        {/if}

        {#if program.description}
            <p class="mt-4 whitespace-pre-line text-sm leading-relaxed text-surface-200">
                {program.description}
            </p>
        {/if}

        {#if genres.length > 0}
            <ul class="mt-4 flex flex-wrap gap-1.5" aria-label={m.program_details_genres_aria()}>
                {#each genres as genre (genre)}
                    <li class="rounded bg-surface-700 px-2 py-1 text-xs text-surface-200">
                        {genre}
                    </li>
                {/each}
            </ul>
        {/if}

        <div class="mt-6 flex flex-wrap justify-end gap-3">
            <button type="button" class="btn variant-ghost-surface" onclick={onClose}>
                {m.close()}
            </button>
            {#if status === 'live'}
                <button
                    type="button"
                    class="btn variant-filled-primary flex items-center gap-2"
                    onclick={onWatchChannel}>
                    <Icon src={Play} solid size="18" />
                    {m.program_details_watch_now()}
                </button>
            {/if}
        </div>
    </div>
</div>
