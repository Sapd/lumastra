<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { validBeatGrid, playheadBeatStrength } from '$lib/utils/playhead-beat';

    interface Props {
        progress: number;
        large?: boolean;
        seeking?: boolean;
    }
    let { progress, large = false, seeking = false }: Props = $props();
    const timingGrid = $derived($musicPlayerStore.currentTrack?.audioFeatures?.beatGrid);
    const grid = $derived(validBeatGrid(timingGrid));
    const enabled = $derived($musicPlayerStore.alwaysShowBeatPulse);
    // Each tick uses actual playback position. No independent animation clock
    // survives pause, seeking, track promotion, preference disable or unmount.
    const strength = $derived(
        enabled && $musicPlayerStore.isPlaying && !$musicPlayerStore.isLoadingTrack && !seeking
            ? playheadBeatStrength(
                  $musicPlayerStore.currentTimeMs,
                  grid,
                  $musicPlayerStore.currentTrack?.audioFeatures?.bpm,
              )
            : 0,
    );
</script>

<div
    aria-hidden="true"
    class="playhead pointer-events-none absolute"
    class:large
    class:visible={large || enabled || seeking}
    class:seeking
    style="left: {progress * 100}%;">
    <div class="playhead-circle" class:pulsing={strength > 0} style="--beat-strength: {strength};">
    </div>
</div>

<style>
    .playhead {
        top: 0;
        transform: translate(-50%, -25%);
        opacity: 0;
        transition: opacity 150ms;
    }
    .playhead.visible,
    :global(.group:hover) .playhead {
        opacity: 1;
    }
    .playhead-circle {
        width: 0.625rem;
        height: 0.625rem;
        border-radius: 50%;
        background: rgb(var(--color-primary-400-rgb));
        transform: scale(calc(1 + var(--beat-strength) * 0.35));
        filter: brightness(calc(1 + var(--beat-strength) * 0.3));
    }
    .playhead.large {
        top: 50%;
        transform: translate(-50%, -50%);
    }
    .large .playhead-circle {
        width: 1rem;
        height: 1rem;
        background: white;
        box-shadow:
            0 4px 6px -1px rgb(0 0 0 / 0.1),
            0 2px 4px -2px rgb(0 0 0 / 0.1);
    }
    .seeking:not(.large) .playhead-circle {
        transform: scale(1.25);
    }
    @media (prefers-reduced-motion: reduce) {
        .playhead-circle {
            transform: none;
            filter: none;
        }
    }
</style>
