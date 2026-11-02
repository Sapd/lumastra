<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  SeedAvoidPad — a drop-zone pad for seed or avoid tracks.

  Tracks can be dropped onto this component by dragging from elsewhere.
  A chip is shown per track; clicking the × on a chip removes it.
-->

<script lang="ts">
    import { pickVariant } from '$lib/utils/image-utils';
    import type { MusicTrack } from '$lib/schemas/music';
    import { MusicTrackSchema } from '$lib/schemas/music';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        /** Tracks currently in the pad */
        tracks: MusicTrack[];
        /** Pad type determines label + color accent */
        type: 'seed' | 'avoid';
        /** Maximum number of tracks allowed (default 20 for seed, 200 for avoid) */
        maxTracks?: number;
        /** Called when a track is removed */
        onremove?: (track: MusicTrack) => void;
        /** Called when tracks are dropped onto the pad (from external sources) */
        ondrop?: (tracks: MusicTrack[]) => void;
    }

    let {
        tracks,
        type,
        maxTracks = type === 'seed' ? 20 : 200,
        onremove,
        ondrop,
    }: Props = $props();

    let isDragOver = $state(false);

    const label = $derived(type === 'seed' ? m.music_alchemy_seeds() : m.music_alchemy_avoid());
    const emptyHint = $derived(
        type === 'seed' ? m.music_alchemy_seed_hint() : m.music_alchemy_avoid_hint(),
    );
    const accentClass = $derived(type === 'seed' ? 'accent-seed' : 'accent-avoid');

    function handleDragOver(e: DragEvent): void {
        e.preventDefault();
        if ((tracks.length ?? 0) < maxTracks) {
            isDragOver = true;
        }
    }

    function handleDragLeave(): void {
        isDragOver = false;
    }

    function handleDrop(e: DragEvent): void {
        e.preventDefault();
        isDragOver = false;
        const raw = e.dataTransfer?.getData('application/lumastra-music-track');
        if (!raw) return;
        try {
            const parsed: unknown = JSON.parse(raw);
            const items: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
            const valid: MusicTrack[] = items
                .map((item) => MusicTrackSchema.safeParse(item))
                .filter(
                    (r): r is { success: true; data: MusicTrack } =>
                        r.success && typeof r.data.id === 'string',
                )
                .map((r) => r.data);
            if (valid.length === 0) return;
            ondrop?.(valid.slice(0, Math.max(0, maxTracks - tracks.length)));
        } catch {
            // ignore malformed drag data
        }
    }

    function removeTrack(track: MusicTrack): void {
        onremove?.(track);
    }
</script>

<div
    class={['pad', accentClass, { 'drag-over': isDragOver }]}
    role="region"
    aria-label={label}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondrop={handleDrop}>
    <div class="pad-header">
        <span class="pad-title">{label}</span>
        <span class="pad-count">{tracks.length} / {maxTracks}</span>
    </div>

    {#if tracks.length === 0}
        <p class="empty-hint">{emptyHint}</p>
    {:else}
        <div class="chips">
            {#each tracks as track (track.id)}
                {@const artwork = pickVariant(track.images.primary, 'thumb')}
                <div
                    class="chip"
                    draggable="true"
                    title="{track.title} — {track.artists.map((a) => a.title).join(', ') ?? ''}">
                    {#if artwork}
                        <img src={artwork} alt="" class="chip-art" />
                    {:else}
                        <div class="chip-art" aria-hidden="true"></div>
                    {/if}
                    <span class="chip-label">{track.title}</span>
                    <button
                        class="chip-remove"
                        aria-label={m.music_alchemy_remove_track({ title: track.title })}
                        onclick={() => removeTrack(track)}>×</button>
                </div>
            {/each}
        </div>
    {/if}
</div>

<style>
    .pad {
        border: 1.5px dashed transparent;
        border-radius: 0.75rem;
        padding: 0.75rem;
        min-height: 7rem;
        min-width: 0;
        background: rgb(15 23 42 / 0.6); /* slate-950 translucent */
        transition:
            border-color 0.15s,
            background 0.15s;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
    }

    .pad.drag-over {
        background: rgb(30 41 59 / 0.8);
    }

    .accent-seed {
        border-color: rgb(124 58 237 / 0.5); /* violet */
    }
    .accent-seed.drag-over {
        border-color: rgb(124 58 237);
    }

    .accent-avoid {
        border-color: rgb(239 68 68 / 0.4); /* red */
    }
    .accent-avoid.drag-over {
        border-color: rgb(239 68 68);
    }

    .pad-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }

    .pad-title {
        font-size: 0.8rem;
        font-weight: 700;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: rgb(226 232 240); /* slate-200 */
    }

    .pad-count {
        font-size: 0.75rem;
        color: rgb(203 213 225); /* slate-300 */
    }

    .empty-hint {
        font-size: 0.875rem;
        color: rgb(203 213 225); /* slate-300 */
        text-align: center;
        margin: auto 0;
        line-height: 1.5;
        padding: 0.5rem 0;
    }

    .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 0.35rem;
    }

    .chip {
        display: flex;
        align-items: center;
        gap: 0.3rem;
        background: rgb(30 41 59); /* slate-800 */
        border-radius: 999px;
        padding: 0 0 0 0.5rem;
        max-width: 100%;
        min-width: 0;
        cursor: default;
    }

    .chip-art {
        background: rgb(30 41 59);
        width: 1.25rem;
        height: 1.25rem;
        border-radius: 50%;
        object-fit: cover;
        flex-shrink: 0;
    }

    .chip-label {
        font-size: 0.8rem;
        color: rgb(203 213 225); /* slate-300 */
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        flex: 1;
        min-width: 0;
    }

    .chip-remove {
        background: none;
        border: none;
        color: rgb(203 213 225); /* slate-300 */
        cursor: pointer;
        font-size: 1.1rem;
        line-height: 1;
        padding: 0;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        flex-shrink: 0;
        transition: color 0.1s;
    }

    .chip-remove:hover {
        color: rgb(248 113 113); /* red-400 */
    }

    .chip-remove:focus-visible {
        outline: 2px solid #c4b5fd;
        outline-offset: 2px;
    }
</style>
