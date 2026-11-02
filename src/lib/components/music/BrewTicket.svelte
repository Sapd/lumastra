<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  BrewTicket — the hero output element of the Mixing Desk.

  Full-page mix results flow with the document. The Home dock explicitly
  opts into a compact, bounded list. Playback remains a deliberate action.
-->

<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    import { pickVariant } from '$lib/utils/image-utils';
    import { formatDuration, formatDurationHoursMinutes } from '$lib/utils/time-formatting';
    import type { MoodIslandAnchor } from '$lib/schemas/music-alchemy';
    import { resolve } from '$lib/paths';
    import { toasts } from '$lib/stores/toast.store';
    import { shuffledTracks } from '$lib/utils/music-mix';
    import type { MusicTrack } from '$lib/schemas/music';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        /** Brewed tracks from the last successful brew */
        tracks: MusicTrack[];
        /** Bound the list only in the Home dock. */
        compact?: boolean;
        /** Mood descriptors from the candidate pool explored for the completed brew. */
        moodAnchors?: MoodIslandAnchor[];
        /** Total duration in milliseconds (null when any track lacks duration data) */
        totalDurationMs?: number | null;
        /** Whether a brew is currently in progress */
        loading?: boolean;
        /** Whether the BREW button has ever been pressed */
        hasBrewed?: boolean;
        /**
         * Number of seed tracks currently loaded. Drives the honest pre-brew
         * hero text: with no seeds the user must add some before brewing is
         * possible, so "Ready to brew" would be a lie.
         */
        seedCount?: number;
        /** When set, a "Clear" button appears that clears the suggestions. */
        onclear?: () => void;
        /** When set, an "Open full desk →" link appears beside the actions. */
        fullDeskHref?: string;
    }

    let {
        tracks,
        compact = false,
        moodAnchors,
        totalDurationMs = null,
        loading = false,
        hasBrewed = false,
        seedCount,
        onclear,
        fullDeskHref,
    }: Props = $props();

    // Match enqueueFromBrew: the first occurrence of each ID is the playable mix.
    const mixTracks = $derived.by(() => {
        const seen = new SvelteSet<string>();
        return tracks.filter((track) => {
            if (seen.has(track.id)) return false;
            seen.add(track.id);
            return true;
        });
    });
    const trackCount = $derived(mixTracks.length);
    const mixDurationMs = $derived.by(() => {
        if (mixTracks.length === tracks.length) return totalDurationMs;
        if (!mixTracks.every((track) => track.durationMs != null && track.durationMs > 0)) {
            return null;
        }
        return mixTracks.reduce((total, track) => total + (track.durationMs ?? 0), 0);
    });

    const durationLabel = $derived(
        mixDurationMs != null && mixDurationMs > 0
            ? formatDurationHoursMinutes(mixDurationMs / 1000)
            : null,
    );

    const ticketText = $derived.by(() => {
        if (loading) return m.music_alchemy_brewing();
        if (!hasBrewed) {
            if (seedCount === 0) return m.music_alchemy_ticket_add_seeds();
            return m.music_alchemy_result_ready();
        }
        if (trackCount === 0) return m.music_alchemy_result_empty();
        const count = m.music_alchemy_result_count({ count: trackCount });
        return durationLabel
            ? m.music_alchemy_result_total({ count, duration: durationLabel })
            : count;
    });

    function moodLabel(label: string): string {
        const labels: Record<string, () => string> = {
            happy: m.music_mood_happy,
            party: m.music_mood_party,
            chill: m.music_mood_chill,
            workout: m.music_mood_workout,
            focus: m.music_mood_focus,
            energetic: m.music_mood_energetic,
            sad: m.music_mood_sad,
            romantic: m.music_mood_romantic,
            calm: m.music_alchemy_calm,
        };
        const key = label.trim().toLowerCase();
        return Object.hasOwn(labels, key) ? labels[key]() : label;
    }

    let playingBrew = $state(false);
    async function playBrew(ordered = mixTracks): Promise<void> {
        if (!ordered.length || playingBrew) return;
        playingBrew = true;
        try {
            await musicPlayerStore.enqueueFromBrew(ordered, true);
            musicPlayerStore.setPlaybackContext({
                type: 'mix',
                name: m.music_feature_mixing_desk_label(),
                trackCount: ordered.length,
                href: resolve('/music/alchemy'),
            });
        } finally {
            playingBrew = false;
        }
    }

    async function enqueueBrew(): Promise<void> {
        if (mixTracks.length === 0) return;
        await musicPlayerStore.enqueueFromBrew(mixTracks, false);
        toasts.success(m.music_alchemy_queue_updated());
    }
</script>

<section class={['ticket-wrap', { compact }]} aria-label={m.music_alchemy_result_aria()}>
    <header class="ticket-header">
        <h2>{m.music_alchemy_result_title()}</h2>
        <output class="ticket-hero" aria-live="polite">{ticketText}</output>
    </header>

    {#if hasBrewed && !loading && moodAnchors !== undefined}
        <div class="mood-summary" role="group" aria-label={m.music_alchemy_result_moods()}>
            <span class="mood-label">{m.music_alchemy_result_moods()}</span>
            {#if moodAnchors.length > 0}
                <ul class="mood-list">
                    {#each moodAnchors as anchor, i (`${anchor.label}:${i}`)}
                        <li>{moodLabel(anchor.label)}</li>
                    {/each}
                </ul>
            {:else}
                <span>{m.music_alchemy_islands_no_mood()}</span>
            {/if}
        </div>
    {/if}

    {#if !loading && (mixTracks.length > 0 || hasBrewed || fullDeskHref)}
        <div class="ticket-actions">
            {#if mixTracks.length > 0}
                <button class="btn-play" disabled={playingBrew} onclick={() => playBrew()}>
                    <svg viewBox="0 0 16 16" aria-hidden="true" class="play-icon">
                        <polygon points="3,1 14,8 3,15" fill="currentColor" />
                    </svg>
                    {m.music_mix_play()}
                </button>
                <button
                    class="btn-enqueue"
                    disabled={playingBrew}
                    onclick={() => playBrew(shuffledTracks(mixTracks))}>{m.album_shuffle()}</button>
                <button class="btn-enqueue" onclick={enqueueBrew}
                    >{m.card_music_add_to_queue()}</button>
            {/if}
            {#if onclear && (hasBrewed || mixTracks.length > 0)}
                <button class="btn-clear" onclick={() => onclear?.()}
                    >{m.music_alchemy_clear()}</button>
            {/if}
            {#if fullDeskHref}
                <a class="btn-fulldesk" href={fullDeskHref}>{m.music_alchemy_dock_open_full()} →</a>
            {/if}
        </div>
    {/if}

    {#if mixTracks.length > 0 && !loading}
        <ol class="track-list" aria-label={m.music_alchemy_result_tracks()}>
            {#each mixTracks as track, i (track.id)}
                {@const artwork = pickVariant(track.images.primary, 'thumb')}
                <li class="track-row">
                    <button
                        class="track-num"
                        disabled={playingBrew}
                        aria-label={m.music_mix_play_aria({ title: track.title })}
                        onclick={() => playBrew([...mixTracks.slice(i), ...mixTracks.slice(0, i)])}>
                        <span class="row-number" aria-hidden="true">{i + 1}</span>
                        <span class="row-play" aria-hidden="true">▶</span>
                    </button>
                    {#if artwork}
                        <img src={artwork} alt="" class="track-art" loading="lazy" />
                    {:else}
                        <div class="track-art" aria-hidden="true"></div>
                    {/if}
                    <div class="track-meta">
                        <span class="track-title">{track.title}</span>
                        {#if track.artists.length > 0}
                            <span class="track-artist"
                                >{track.artists.map((a) => a.title).join(', ')}</span>
                        {/if}
                    </div>
                    {#if track.durationMs != null && track.durationMs > 0}
                        <span class="track-duration"
                            >{formatDuration(track.durationMs / 1000)}</span>
                    {/if}
                </li>
            {/each}
        </ol>
    {/if}
</section>

<style>
    .ticket-wrap {
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: 1rem;
        border: 1px solid rgb(51 65 85);
        border-radius: 1rem;
        background: rgb(15 23 42 / 0.7);
        padding: 1.25rem;
    }
    .ticket-header {
        display: flex;
        flex-direction: column;
        gap: 0.35rem;
    }
    h2 {
        margin: 0;
        color: rgb(241 245 249);
        font-size: 1.35rem;
        font-weight: 700;
    }
    .ticket-hero {
        color: rgb(203 213 225);
        font-size: 0.95rem;
        line-height: 1.5;
    }
    .ticket-actions {
        display: flex;
        gap: 0.5rem;
        flex-wrap: wrap;
    }
    .ticket-actions button,
    .btn-fulldesk {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        min-height: 44px;
        min-width: 44px;
        max-width: 100%;
        border-radius: 0.5rem;
        padding: 0.6rem 1rem;
        font-size: 0.875rem;
        font-weight: 600;
        line-height: 1.4;
        overflow-wrap: anywhere;
        cursor: pointer;
    }
    .btn-play {
        background: rgb(124 58 237);
        color: white;
    }
    .btn-play:hover {
        background: rgb(109 40 217);
    }
    .btn-enqueue {
        background: rgb(51 65 85);
        color: rgb(226 232 240);
    }
    .btn-enqueue:hover,
    .btn-clear:hover {
        background: rgb(71 85 105);
    }
    .btn-clear {
        border: 1px solid rgb(71 85 105);
        color: rgb(203 213 225);
    }
    .btn-fulldesk {
        color: rgb(196 181 253);
        text-decoration: none;
    }
    .btn-fulldesk:hover {
        text-decoration: underline;
    }
    button:disabled {
        opacity: 0.5;
        cursor: wait;
    }
    button:focus-visible,
    a:focus-visible {
        outline: 2px solid #c4b5fd;
        outline-offset: 3px;
    }
    .play-icon {
        width: 0.875rem;
        height: 0.875rem;
        flex-shrink: 0;
    }
    .mood-summary {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        gap: 0.5rem 0.75rem;
        color: rgb(203 213 225);
        font-size: 0.875rem;
        overflow-wrap: anywhere;
    }
    .mood-label {
        font-weight: 600;
    }
    .mood-list {
        display: flex;
        flex-wrap: wrap;
        gap: 0.4rem;
        list-style: none;
        padding: 0;
        margin: 0;
        min-width: 0;
    }
    .mood-list li {
        padding: 0.25rem 0.65rem;
        border-radius: 999px;
        background: rgb(124 58 237 / 0.18);
        color: rgb(221 214 254);
        max-width: 100%;
    }
    .track-list {
        list-style: none;
        padding: 0;
        margin: 0;
        display: flex;
        flex-direction: column;
    }
    .track-row {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.75rem 0;
        min-width: 0;
        border-top: 1px solid rgb(51 65 85 / 0.6);
    }
    .track-row:hover {
        background: rgb(30 41 59 / 0.5);
    }
    .track-num {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 44px;
        min-height: 44px;
        color: rgb(203 213 225);
        border-radius: 0.5rem;
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }
    .row-play {
        display: none;
    }
    .track-num:hover .row-number,
    .track-num:focus-visible .row-number {
        display: none;
    }
    .track-num:hover .row-play,
    .track-num:focus-visible .row-play {
        display: inline;
    }
    .track-art {
        background: rgb(30 41 59);
        width: 3rem;
        height: 3rem;
        border-radius: 0.35rem;
        object-fit: cover;
        flex-shrink: 0;
    }
    .track-meta {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
        min-width: 0;
        flex: 1;
        overflow-wrap: anywhere;
    }
    .track-title {
        font-size: 1rem;
        color: rgb(241 245 249);
        line-height: 1.4;
        font-weight: 500;
    }
    .track-artist {
        font-size: 0.875rem;
        color: rgb(148 163 184);
        line-height: 1.4;
    }
    .track-duration {
        font-size: 0.875rem;
        color: rgb(203 213 225);
        font-variant-numeric: tabular-nums;
        flex-shrink: 0;
    }
    .compact {
        padding: 0.75rem;
        gap: 0.75rem;
    }
    .compact h2 {
        font-size: 1rem;
    }
    .compact .track-list {
        max-height: 16rem;
        overflow-y: auto;
    }
    .compact .track-row {
        padding: 0.4rem 0;
        gap: 0.5rem;
    }
    .compact .track-art {
        width: 2.25rem;
        height: 2.25rem;
    }
    .compact .track-title {
        font-size: 0.875rem;
    }
    .compact .track-artist {
        font-size: 0.8rem;
    }
    @media (max-width: 480px) {
        .ticket-wrap {
            padding: 0.75rem;
        }
        .track-row {
            flex-wrap: wrap;
            gap: 0.5rem;
        }
        .track-art {
            width: 2.5rem;
            height: 2.5rem;
        }
        .track-meta {
            flex-basis: calc(100% - 6.25rem);
        }
        .track-duration {
            margin-left: 6.25rem;
        }
    }
</style>
