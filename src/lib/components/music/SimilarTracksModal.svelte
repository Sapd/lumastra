<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import {
        Icon,
        XMark,
        Sparkles,
        MusicalNote,
        SpeakerWave,
        PlayCircle,
        QueueList,
    } from 'svelte-hero-icons';
    import { onDestroy } from 'svelte';
    import { SvelteMap } from 'svelte/reactivity';
    import { modals } from '$lib/stores/modal.store';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import type { MusicTrack } from '$lib/schemas/music';
    import { getTrack, getSimilarTracks } from '$lib/api/music';
    import * as m from '$lib/paraglide/messages';
    import TrackVote from '$lib/components/music/TrackVote.svelte';
    import SonicStatChips from '$lib/components/music/SonicStatChips.svelte';
    import ContextMenu from '$lib/components/ui/ContextMenu.svelte';
    import type { ContextMenuEntry } from '$lib/components/ui/context-menu-types';
    import { buildMusicTrackMenu } from '$lib/components/music/music-track-menu';

    // ==========================================================================
    // Props
    // ==========================================================================

    interface Props {
        modalId: string;
        trackId: string;
        /**
         * When true the modal asks for `basis=auto` (audio-embedding neighbours
         * when the track has them) and renders a cosine-similarity "% match"
         * badge for sonic results. When false (default) it asks for
         * `basis=metadata`.
         * Gate this on $page.data?.features?.sonicEmbeddings.
         */
        sonicEnabled?: boolean;
    }

    let { modalId, trackId, sonicEnabled = false }: Props = $props();

    // ── Row context menu ─────────────────────────────────────────────────
    let trackMenu = $state<{ x: number; y: number; track: MusicTrack } | null>(null);

    let trackMenuItems: ContextMenuEntry[] = $derived(
        buildMusicTrackMenu(trackMenu?.track, { sonicEnabled }),
    );

    function openTrackMenu(e: MouseEvent, track: MusicTrack): void {
        e.preventDefault();
        e.stopPropagation();
        trackMenu = { x: e.clientX, y: e.clientY, track };
    }

    // ==========================================================================
    // State
    // ==========================================================================

    let sourceTrack = $state<MusicTrack | null>(null);
    let similarTracks = $state<MusicTrack[]>([]);
    /** Populated only in sonic mode — keyed by track id, value in [0,1].
     *  SvelteMap is already reactive — do not wrap with $state. */
    const similarityScores = new SvelteMap<string, number>();
    let loading = $state(true);
    let error = $state<string | null>(null);
    let usedSonicMode = $state(false);
    let loadVersion = 0;
    onDestroy(() => {
        loadVersion++;
    });

    // ==========================================================================
    // Data fetching
    // ==========================================================================

    $effect(() => {
        if (!trackId) return;
        void loadData(trackId);
    });

    async function loadData(id: string): Promise<void> {
        const version = ++loadVersion;
        loading = true;
        sourceTrack = null;
        similarTracks = [];
        error = null;
        usedSonicMode = false;
        similarityScores.clear();

        try {
            const trackResult = await getTrack(id);
            if (version !== loadVersion) return;
            if (!trackResult.error && trackResult.data) {
                sourceTrack = trackResult.data.track;
            }

            const similarResult = await getSimilarTracks(id, {
                basis: sonicEnabled ? 'auto' : 'metadata',
                limit: 20,
            });
            if (version !== loadVersion) return;
            if (!similarResult.error && similarResult.data) {
                const { items, source } = similarResult.data;
                similarTracks = items;
                if (source === 'sonic') {
                    for (const t of items) {
                        if (t.similarityScore !== undefined) {
                            similarityScores.set(t.id, t.similarityScore);
                        }
                    }
                    usedSonicMode = true;
                }
            } else {
                error = 'Could not load similar tracks.';
            }
        } catch {
            if (version !== loadVersion) return;
            error = 'Network error — please try again.';
        } finally {
            if (version === loadVersion) loading = false;
        }
    }

    // ==========================================================================
    // Helpers
    // ==========================================================================

    function formatDuration(seconds: number | null | undefined): string {
        if (!seconds) return '';
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }

    function formatMatchPct(trackId: string): string | undefined {
        const score = similarityScores.get(trackId);
        if (score === undefined) return undefined;
        return `${Math.round(score * 100)}%`;
    }

    function formatBpm(track: MusicTrack): string {
        const bpm = track.audioFeatures?.bpm;
        if (!bpm) return '';
        return `${Math.round(bpm)} BPM`;
    }

    function genreTags(track: MusicTrack): string[] {
        return track.genres?.slice(0, 4) ?? [];
    }

    function playTrack(track: MusicTrack): void {
        musicPlayerStore.play(track);
        modals.close();
    }

    function playSourceTrack(): void {
        if (!sourceTrack) return;
        void musicPlayerStore.startPlayback(sourceTrack);
        modals.close();
    }

    function playSourceAndQueueSimilar(): void {
        if (!sourceTrack) return;
        void musicPlayerStore.enqueueFromBrew([sourceTrack, ...similarTracks]);
        modals.close();
    }
</script>

<div
    id={modalId}
    class="card flex h-[100dvh] w-screen flex-col overflow-hidden bg-surface-900 p-4 sm:h-auto sm:max-h-[85dvh] sm:w-full sm:max-w-lg sm:rounded-xl sm:p-6">
    <!-- Header -->
    <header class="mb-4 flex shrink-0 items-center justify-between gap-3">
        <div class="flex items-center gap-2">
            {#if usedSonicMode}
                <Icon src={SpeakerWave} class="h-5 w-5 text-primary-400" />
                <h3 class="text-lg font-bold text-white">Sounds Like</h3>
            {:else}
                <Icon src={Sparkles} class="h-5 w-5 text-primary-400" />
                <h3 class="text-lg font-bold text-white">Similar Tracks</h3>
            {/if}
        </div>
        <button
            type="button"
            class="btn-icon variant-ghost-surface hover:variant-filled-surface"
            onclick={() => modals.close()}
            aria-label={m.btn_close()}>
            <Icon src={XMark} class="h-5 w-5" />
        </button>
    </header>

    <!-- Source track info -->
    {#if sourceTrack}
        <div class="mb-4 shrink-0 rounded-lg border border-surface-700 bg-surface-800/60 p-3">
            <div class="flex items-start gap-3">
                {#if sourceTrack.images?.primary?.variants?.thumb}
                    <img
                        src={sourceTrack.images.primary?.variants?.thumb}
                        alt={sourceTrack.album?.title ?? sourceTrack.title}
                        class="h-16 w-16 shrink-0 rounded-md object-cover shadow-md" />
                {:else}
                    <div
                        class="flex h-16 w-16 shrink-0 items-center justify-center rounded-md bg-surface-700">
                        <Icon src={MusicalNote} class="h-7 w-7 text-surface-500" />
                    </div>
                {/if}
                <div class="min-w-0 flex-1">
                    <p class="truncate font-semibold text-white">
                        {sourceTrack.title}
                    </p>
                    <p class="truncate text-sm text-surface-400">
                        {sourceTrack.artists.map((a) => a.title).join(', ')}
                        {#if sourceTrack.album?.title}
                            <span class="text-surface-500">
                                &middot; {sourceTrack.album?.title}</span>
                        {/if}
                    </p>
                    <!-- Audio feature chips (BPM, key, energy, danceability) -->
                    <div class="mt-1.5">
                        <SonicStatChips
                            audioFeatures={sourceTrack.audioFeatures}
                            showLabels={true} />
                    </div>
                    <!-- Genre tags -->
                    {#if genreTags(sourceTrack).length > 0}
                        <div class="mt-1 flex flex-wrap gap-1">
                            {#each genreTags(sourceTrack) as tag, tagIdx (tag + '__' + tagIdx)}
                                <span
                                    class="rounded bg-primary-900/60 px-1.5 py-0.5 text-xs text-primary-300">
                                    {tag}
                                </span>
                            {/each}
                        </div>
                    {/if}
                    <!-- Source-track play actions -->
                    <div class="mt-2 flex flex-wrap gap-1.5">
                        <button
                            type="button"
                            class="btn variant-filled-primary btn-sm flex items-center gap-1.5 py-1 pl-2 pr-3 text-xs font-semibold"
                            onclick={playSourceTrack}>
                            <Icon src={PlayCircle} class="h-4 w-4 shrink-0" />
                            Play
                        </button>
                        {#if similarTracks.length > 0}
                            <button
                                type="button"
                                class="btn variant-ghost-primary btn-sm flex items-center gap-1.5 py-1 pl-2 pr-3 text-xs font-semibold"
                                onclick={playSourceAndQueueSimilar}>
                                <Icon src={QueueList} class="h-4 w-4 shrink-0" />
                                Play + Queue Similar
                            </button>
                        {/if}
                    </div>
                </div>
            </div>
        </div>
    {/if}

    <!-- Similar tracks list -->
    <div class="min-h-0 flex-1 overflow-y-auto pr-0.5">
        {#if loading}
            <div class="flex items-center justify-center py-16">
                <div
                    class="h-6 w-6 animate-spin rounded-full border-2 border-primary-500/30 border-t-primary-500">
                </div>
                <span class="ml-3 text-sm text-surface-400">Loading...</span>
            </div>
        {:else if error}
            <div class="py-12 text-center">
                <p class="text-surface-400">{error}</p>
            </div>
        {:else if similarTracks.length === 0}
            <div class="py-12 text-center">
                <div class="mb-3 text-4xl">🎵</div>
                <p class="text-surface-300">No similar tracks found.</p>
                <p class="mt-1 text-sm text-surface-500">
                    Generate music embeddings in Admin to enable this feature.
                </p>
            </div>
        {:else}
            <ul class="space-y-1">
                {#each similarTracks as track (track.id)}
                    {@const matchPct = formatMatchPct(track.id)}
                    <li
                        class="group flex w-full items-center gap-1 rounded-lg transition-colors hover:bg-surface-800"
                        oncontextmenu={(e) => openTrackMenu(e, track)}>
                        <!-- Play area (click to play) -->
                        <button
                            type="button"
                            class="flex min-w-0 flex-1 items-center gap-3 p-2 text-left"
                            onclick={() => playTrack(track)}>
                            {#if track.images?.primary?.variants?.thumb}
                                <img
                                    src={track.images.primary?.variants?.thumb}
                                    alt={track.album?.title ?? track.title}
                                    class="h-10 w-10 shrink-0 rounded object-cover" />
                            {:else}
                                <div
                                    class="flex h-10 w-10 shrink-0 items-center justify-center rounded bg-surface-700">
                                    <Icon src={MusicalNote} class="h-4 w-4 text-surface-500" />
                                </div>
                            {/if}
                            <div class="min-w-0 flex-1">
                                <p
                                    class="truncate text-sm font-medium text-white group-hover:text-primary-300">
                                    {track.title}
                                </p>
                                <p class="truncate text-xs text-surface-400">
                                    {track.artists.map((a) => a.title).join(', ')}
                                    {#if track.album?.title}
                                        <span class="text-surface-500">
                                            &middot; {track.album?.title}</span>
                                    {/if}
                                </p>
                            </div>
                            <div class="flex shrink-0 flex-col items-end gap-0.5">
                                {#if matchPct}
                                    <!-- Sonic match percentage — only in sonic mode -->
                                    <span
                                        class="rounded bg-primary-900/70 px-1.5 py-0.5 text-xs font-semibold text-primary-300">
                                        {matchPct} match
                                    </span>
                                {:else if formatBpm(track)}
                                    <span class="text-xs text-surface-500">
                                        {formatBpm(track)}
                                    </span>
                                {/if}
                                {#if formatDuration(track.durationMs == null ? null : track.durationMs / 1000)}
                                    <span class="text-xs text-surface-600">
                                        {formatDuration(
                                            track.durationMs == null
                                                ? null
                                                : track.durationMs / 1000,
                                        )}
                                    </span>
                                {/if}
                            </div>
                        </button>
                        <!-- Vote affordance — only visible on hover to keep the row uncluttered -->
                        <div
                            class="shrink-0 pr-1 opacity-0 transition-opacity group-hover:opacity-100">
                            <TrackVote trackId={track.id} size="md" />
                        </div>
                    </li>
                {/each}
            </ul>
        {/if}
    </div>

    <!-- Footer -->
    <footer class="mt-4 shrink-0 border-t border-surface-700 pt-3 text-center">
        {#if usedSonicMode}
            <p class="text-xs text-surface-500">
                Ranked by audio fingerprint similarity &middot; click to play
            </p>
        {:else}
            <p class="text-xs text-surface-500">Click a track to play it</p>
        {/if}
    </footer>
</div>

{#if trackMenu}
    <ContextMenu
        x={trackMenu.x}
        y={trackMenu.y}
        items={trackMenuItems}
        title={trackMenu.track.title}
        subtitle={trackMenu.track.artists.map((a) => a.title).join(', ')}
        onClose={() => (trackMenu = null)} />
{/if}
