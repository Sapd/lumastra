<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import type { MusicTrack } from '$lib/schemas/music';
    import QueueSimpleTrackRow from './QueueSimpleTrackRow.svelte';
    import { Icon, ChevronRight } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    let expanded = $state(false);
    let listRef: HTMLDivElement | undefined = $state();

    // Radio-station pseudo-tracks land in history when the user switches from
    // a station to a regular track; they have no duration/audioFeatures and
    // must not re-enter playback through the generic queue path.
    const playableHistory = $derived($musicPlayerStore.history.filter((t) => !t.isRadio));

    // `history` is newest-first (capped at 50). Reverse so the list reads
    // oldest → most-recently-played, with the newest entry sitting directly
    // above the Now Playing block that follows this section.
    const reversedHistory = $derived([...playableHistory].reverse());

    // The list reads oldest → newest with a capped height, so on expand — and
    // whenever a new entry arrives while expanded — the most recently played
    // tracks would be hidden below the fold. Keep it pinned to the bottom.
    $effect(() => {
        void reversedHistory.length;
        if (expanded && listRef) {
            listRef.scrollTop = listRef.scrollHeight;
        }
    });

    function playFromHistory(track: MusicTrack): void {
        // Play now without wiping the rest of the queue.
        musicPlayerStore.addToQueueFront(track);
        void musicPlayerStore.skip();
    }

    /** Enqueue, reporting whether it was a real add (store dedupes silently). */
    function enqueue(track: MusicTrack): boolean {
        const isDuplicate = $musicPlayerStore.queue.some((q) => q.id === track.id);
        musicPlayerStore.addToQueue(track);
        return !isDuplicate;
    }
</script>

{#if playableHistory.length > 0}
    <div class="mb-4">
        <button
            type="button"
            class="flex min-h-[44px] w-full items-center justify-between rounded-md px-1 text-xs uppercase text-surface-400 transition-colors hover:text-surface-200"
            aria-expanded={expanded}
            onclick={() => (expanded = !expanded)}>
            <span>{m.music_history_label()} ({playableHistory.length})</span>
            <Icon
                src={ChevronRight}
                class="h-3.5 w-3.5 shrink-0 transition-transform {expanded ? 'rotate-90' : ''}" />
        </button>

        {#if expanded}
            <div bind:this={listRef} class="mt-1 max-h-48 space-y-0.5 overflow-y-auto">
                {#each reversedHistory as track, i (`${track.id}-${i}`)}
                    <QueueSimpleTrackRow
                        {track}
                        activateLabel={m.music_queue_play_now()}
                        onactivate={() => playFromHistory(track)}
                        onadd={() => enqueue(track)} />
                {/each}
            </div>
        {/if}
    </div>
{/if}
