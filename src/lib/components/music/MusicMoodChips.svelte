<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  MusicMoodChips — the hardcoded mood-radio launch chips. Shown on /music/explore
  at all breakpoints; on the /music home it is desktop-only (mobile uses Explore).
-->

<script lang="ts">
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import * as m from '$lib/paraglide/messages.js';

    interface MoodChip {
        genre: string;
        label: string;
        emoji?: string;
    }

    interface Props {
        /** `readonly` so a `... as const` list from a loader can be passed
         *  without copying — this component only reads the array. */
        moodChips: readonly MoodChip[];
    }

    let { moodChips }: Props = $props();

    let startingMood = $state<string | null>(null);

    function getMoodLabel(genre: string, fallback: string): string {
        const labels: Record<string, string> = {
            chill: m.music_mood_chill(),
            workout: m.music_mood_workout(),
            focus: m.music_mood_focus(),
            party: m.music_mood_party(),
            energetic: m.music_mood_energetic(),
            sad: m.music_mood_sad(),
            happy: m.music_mood_happy(),
            romantic: m.music_mood_romantic(),
        };
        return labels[genre] ?? fallback;
    }

    async function startMoodChannel(chip: MoodChip): Promise<void> {
        startingMood = chip.genre;
        try {
            await musicPlayerStore.seedAutoplay({
                type: 'mood',
                mood: chip.genre,
                label: getMoodLabel(chip.genre, chip.label),
                emoji: chip.emoji ?? '🎵',
            });
        } finally {
            startingMood = null;
        }
    }
</script>

<div>
    <h3 class="mb-2 text-xs font-semibold uppercase tracking-wider text-surface-400">
        {m.route_music_moods()}
    </h3>
    <div class="flex gap-2 overflow-x-auto pb-1">
        {#each moodChips as chip, chipIdx (chip.genre + '-' + chipIdx)}
            {@const isMoodActive =
                $musicPlayerStore.autoplaySeed?.type === 'mood' &&
                $musicPlayerStore.autoplaySeed.mood === chip.genre}
            <button
                class="flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-medium transition-all {isMoodActive
                    ? 'border-primary-400 bg-primary-500/25 text-surface-50 shadow-lg shadow-primary-500/25'
                    : 'border-surface-700/50 bg-surface-800 text-surface-300 hover:border-surface-600 hover:bg-surface-700 hover:text-surface-50'}"
                disabled={startingMood !== null}
                onclick={() => startMoodChannel(chip)}>
                <span>{chip.emoji}</span>
                <span>{getMoodLabel(chip.genre, chip.label)}</span>
                {#if startingMood === chip.genre}
                    <div
                        class="ml-1 h-3 w-3 animate-spin rounded-full border-2 border-surface-50/30 border-t-surface-50">
                    </div>
                {:else if isMoodActive}
                    <span class="ml-0.5">&#9654;</span>
                {/if}
            </button>
        {/each}
    </div>
</div>
