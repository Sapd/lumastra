<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import type { TrackAudioFeatures as AudioFeatures } from '$lib/schemas/api-music-dto';

    interface Props {
        /**
         * Audio analysis data containing BPM, key, energy, danceability.
         * All fields are optional; absent fields are simply not rendered.
         */
        audioFeatures: AudioFeatures | undefined;
        /**
         * Whether to show text labels next to the values.
         * Defaults to true. Set false for compact icon-only display.
         */
        showLabels?: boolean;
        /**
         * Additional CSS classes to apply to the container.
         */
        class?: string;
    }

    let { audioFeatures, showLabels = true, class: className = '' }: Props = $props();

    /**
     * Format BPM as an integer.
     */
    function formatBpm(bpm: number | undefined): string {
        if (bpm === undefined) return '';
        return Math.round(bpm).toString();
    }

    /**
     * Format energy as a percentage (0–100).
     */
    function formatEnergy(energy: number | undefined): string {
        if (energy === undefined) return '';
        return Math.round(energy * 100).toString();
    }

    /**
     * Format danceability. Essentia scale is typically 0–2+, so we cap at 10.0
     * and show one decimal place for readability.
     */
    function formatDanceability(danceability: number | undefined): string {
        if (danceability === undefined) return '';
        return Math.min(danceability, 10).toFixed(1);
    }

    // Derived: which stats are available and can be rendered
    let hasStats = $derived.by(() => {
        return !!(
            audioFeatures?.bpm ||
            audioFeatures?.key ||
            audioFeatures?.energy !== undefined ||
            audioFeatures?.danceability
        );
    });

    let bpmDisplay = $derived(formatBpm(audioFeatures?.bpm));
    let energyDisplay = $derived(formatEnergy(audioFeatures?.energy));
    let danceabilityDisplay = $derived(formatDanceability(audioFeatures?.danceability));
</script>

{#if hasStats}
    <div class={`flex items-center gap-2 flex-wrap ${className}`}>
        {#if audioFeatures?.bpm}
            <Tooltip text="Beats per minute">
                <div
                    class="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-800/80 text-xs text-surface-300 border border-surface-700/50 hover:border-surface-600/50 transition-colors cursor-help">
                    <!-- Music note icon -->
                    <svg
                        class="w-3.5 h-3.5 text-amber-400 flex-shrink-0"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        aria-hidden="true">
                        <path
                            d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.414l4 4A2 2 0 0114.586 8H12v4a2 2 0 01-2 2H8a2 2 0 01-2-2V6H4a2 2 0 01-2-2zm8 0h2v2h-2V4z" />
                    </svg>
                    {#if showLabels}
                        <span class="font-medium">{bpmDisplay} BPM</span>
                    {:else}
                        <span class="font-medium">{bpmDisplay}</span>
                    {/if}
                </div>
            </Tooltip>
        {/if}

        {#if audioFeatures?.key}
            <Tooltip text="Musical key">
                <div
                    class="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-800/80 text-xs text-surface-300 border border-surface-700/50 hover:border-surface-600/50 transition-colors cursor-help">
                    <!-- Key/treble clef symbol -->
                    <svg
                        class="w-3.5 h-3.5 text-purple-400 flex-shrink-0"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                        viewBox="0 0 24 24"
                        aria-hidden="true">
                        <path d="M9 3l6 6M3 12c0 1.657 1.343 3 3 3h6c1.657 0 3-1.343 3-3M9 12v6" />
                    </svg>
                    {#if showLabels}
                        <span class="font-medium">{audioFeatures.key}</span>
                    {:else}
                        <span class="font-medium text-[11px]">{audioFeatures.key.slice(0, 2)}</span>
                    {/if}
                </div>
            </Tooltip>
        {/if}

        {#if audioFeatures?.energy !== undefined}
            <Tooltip text="Energy level (0–100%)">
                <div
                    class="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-800/80 text-xs text-surface-300 border border-surface-700/50 hover:border-surface-600/50 transition-colors cursor-help">
                    <!-- Lightning bolt icon -->
                    <svg
                        class="w-3.5 h-3.5 text-orange-400 flex-shrink-0"
                        fill="currentColor"
                        viewBox="0 0 20 20"
                        aria-hidden="true">
                        <path
                            fill-rule="evenodd"
                            d="M13.404 2.471a.75.75 0 00-1.179.858c1.251 1.658.907 4.197-.571 5.675a4.5 4.5 0 10-6.364 6.364 1.5 1.5 0 002.121-2.121 3 3 0 104.242-4.242c1.478-1.478 4.017-1.822 5.675-.571.858.628 1.487-.29.858-1.179zM4.342 7.657a3 3 0 104.242-4.242 1.5 1.5 0 10-2.121 2.121 3 3 0 00-2.121 2.121z"
                            clip-rule="evenodd" />
                    </svg>
                    {#if showLabels}
                        <span class="font-medium">{energyDisplay}%</span>
                    {:else}
                        <span class="font-medium text-[11px]">{energyDisplay}</span>
                    {/if}
                </div>
            </Tooltip>
        {/if}

        {#if audioFeatures?.danceability}
            <Tooltip text="Danceability (Essentia scale)">
                <div
                    class="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-surface-800/80 text-xs text-surface-300 border border-surface-700/50 hover:border-surface-600/50 transition-colors cursor-help">
                    <!-- Dancing figure icon -->
                    <svg
                        class="w-3.5 h-3.5 text-pink-400 flex-shrink-0"
                        fill="currentColor"
                        viewBox="0 0 24 24"
                        aria-hidden="true">
                        <path
                            d="M12 2a2 2 0 110 4 2 2 0 010-4zM9 8h6l-1.5 6h-3L9 8zm-3 0v8l2-2v2h8v-2l2 2V8h3v10H4V8h2zm11 11v3h-2v-3h2zM7 19v3H5v-3h2z" />
                    </svg>
                    {#if showLabels}
                        <span class="font-medium">{danceabilityDisplay}</span>
                    {:else}
                        <span class="font-medium text-[11px]">{danceabilityDisplay}</span>
                    {/if}
                </div>
            </Tooltip>
        {/if}
    </div>
{/if}
