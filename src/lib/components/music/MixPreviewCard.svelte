<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<!--
  Mix preview body. Rendered inside the shared ModalContainer (via MixPreview),
  so it gets the same backdrop, close gestures, focus trap and sizing as the
  album/artist/similar-tracks modals — this component only draws the card.
-->
<script lang="ts">
    import type { Snippet } from 'svelte';
    import {
        Icon,
        XMark,
        Play,
        ArrowsRightLeft,
        MusicalNote,
        QueueList,
    } from 'svelte-hero-icons';
    import type { MusicTrack } from '$lib/schemas/music';
    import { musicPlayerStore } from '$lib/stores/music-player.store';
    import { toasts } from '$lib/stores/toast.store';
    import { shuffledTracks } from '$lib/utils/music-mix';
    import * as m from '$lib/paraglide/messages';
    import { modals } from '$lib/stores/modal.store';

    let {
        modalId,
        title,
        description,
        tracks,
        total,
        loading = false,
        error = null,
        onclose,
        onretry,
        onplay,
        children,
    }: {
        modalId?: string;
        title: string;
        description?: string;
        tracks: MusicTrack[];
        total?: number;
        loading?: boolean;
        error?: string | null;
        onclose: () => void;
        onretry: () => void;
        onplay?: (tracks: MusicTrack[]) => Promise<void>;
        children?: Snippet;
    } = $props();
    let busy = $state(false);
    const duration = $derived(
        Math.round(tracks.reduce((sum, track) => sum + (track.durationMs ?? 0), 0) / 60_000),
    );
    const covers = $derived(
        [
            ...new Set(tracks.map((track) => track.images?.primary?.variants?.thumb).filter((src) => !!src)),
        ].slice(0, 4) as string[],
    );

    function formatDuration(seconds: number | null | undefined): string {
        if (seconds == null) return '—';
        return `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
    }

    // Close through the stack so the card leaves immediately (same path as
    // backdrop/Escape); the stack's onClosed then notifies the caller.
    function close(): void {
        if (modalId) void modals.closeById(modalId);
        else onclose();
    }

    async function play(ordered: MusicTrack[]): Promise<void> {
        if (busy || !ordered.length) return;
        busy = true;
        try {
            if (onplay) await onplay(ordered);
            else await musicPlayerStore.enqueueFromBrew(ordered);
        } catch {
            toasts.error('Unable to start this mix. Please try again.');
        } finally {
            busy = false;
        }
    }
</script>

<div
    class="card flex h-[100dvh] w-screen flex-col overflow-hidden bg-surface-900 p-4 sm:h-auto sm:max-h-[85dvh] sm:w-[40rem] sm:max-w-full sm:rounded-xl sm:p-6">
    <header class="mb-4 flex shrink-0 items-start gap-4">
        <div
            class="grid h-20 w-20 shrink-0 grid-cols-2 grid-rows-2 overflow-hidden rounded-lg bg-surface-800 shadow-md sm:h-24 sm:w-24"
            aria-hidden="true">
            {#each [0, 1, 2, 3] as cell (cell)}
                {#if covers[cell]}
                    <img src={covers[cell]} alt="" class="h-full w-full object-cover" />
                {:else}
                    <div class="flex items-center justify-center bg-primary-900/40">
                        <Icon
                            src={cell === 0 && !covers.length ? QueueList : MusicalNote}
                            class="h-4 w-4 text-primary-400/70" />
                    </div>
                {/if}
            {/each}
        </div>
        <div class="min-w-0 flex-1">
            <h2 class="line-clamp-2 break-words text-lg font-bold text-white sm:text-xl">
                {title}
            </h2>
            {#if description}
                <p class="mt-0.5 line-clamp-2 text-sm text-surface-400">{description}</p>
            {/if}
            <p class="mt-1 text-xs text-surface-500">
                {loading
                    ? 'Loading tracks…'
                    : `${tracks.length} tracks${tracks.every((track) => track.durationMs != null) && duration > 0 ? ` · ${duration} min` : ''}`}
            </p>
        </div>
        <button
            type="button"
            class="btn-icon variant-ghost-surface shrink-0 hover:variant-filled-surface"
            onclick={close}
            aria-label={m.btn_close()}>
            <Icon src={XMark} class="h-5 w-5" />
        </button>
    </header>

    {#if total && total > tracks.length && !loading && !error}
        <p class="mb-3 shrink-0 text-xs text-surface-400">
            A {tracks.length}-track selection from {total.toLocaleString()} tracks. Play, shuffle and
            save use this selection.
        </p>
    {/if}

    {#if loading}
        <div class="flex items-center justify-center py-16" role="status">
            <div
                class="h-6 w-6 animate-spin rounded-full border-2 border-primary-500/30 border-t-primary-500">
            </div>
            <span class="ml-3 text-sm text-surface-400">Loading tracks…</span>
        </div>
    {:else if error || !tracks.length}
        <div class="flex flex-col items-center gap-3 py-12 text-center">
            {#if error}
                <p class="text-surface-300" role="alert">{error}</p>
            {:else}
                <p class="text-surface-300">No accessible tracks in this mix.</p>
            {/if}
            <button type="button" class="btn variant-ghost-surface btn-sm" onclick={onretry}
                >Retry</button>
        </div>
    {:else}
        <div class="mb-3 flex shrink-0 flex-wrap items-center gap-2">
            <button
                type="button"
                class="btn variant-filled-primary btn-sm flex items-center gap-1.5 font-semibold"
                disabled={busy}
                onclick={() => play(tracks)}>
                <Icon src={Play} class="h-4 w-4" solid />
                Play
            </button>
            <button
                type="button"
                class="btn variant-ghost-primary btn-sm flex items-center gap-1.5 font-semibold"
                disabled={busy}
                onclick={() => play(shuffledTracks(tracks))}>
                <Icon src={ArrowsRightLeft} class="h-4 w-4" />
                Shuffle
            </button>
            {#if children}
                <div class="save-slot flex flex-wrap items-center gap-2 text-sm">
                    {@render children()}
                </div>
            {/if}
        </div>
        <ol
            class="-mx-1 min-h-0 flex-1 space-y-0.5 overflow-y-auto px-1"
            aria-label="Tracks in {title}">
            {#each tracks as track, index (track.id)}
                <li>
                    <button
                        type="button"
                        class="group flex w-full items-center gap-3 rounded-lg p-2 text-left transition-colors hover:bg-surface-800 disabled:opacity-60"
                        disabled={busy}
                        aria-label="Play {track.title}"
                        onclick={() => play([...tracks.slice(index), ...tracks.slice(0, index)])}>
                        <span class="w-6 shrink-0 text-right text-xs tabular-nums text-surface-500"
                            >{index + 1}</span>
                        {#if track.images?.primary?.variants?.thumb}
                            <img
                                src={track.images.primary?.variants?.thumb}
                                alt=""
                                loading="lazy"
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
                                {track.artists.map((a) => a.title).join(', ')}{#if track.album?.title}<span class="text-surface-500">
                                        &middot; {track.album?.title}</span
                                    >{/if}
                            </p>
                        </div>
                        <span class="shrink-0 text-xs tabular-nums text-surface-500"
                            >{formatDuration(track.durationMs == null ? null : track.durationMs / 1000)}</span>
                        <Icon
                            src={Play}
                            solid
                            class="h-4 w-4 shrink-0 text-surface-600 group-hover:text-primary-400" />
                    </button>
                </li>
            {/each}
        </ol>
    {/if}
</div>

<style>
    /* SaveMixButton ships plain markup — match it to the btn-sm row. */
    .save-slot :global(button) {
        min-height: 2.25rem;
        padding: 0.375rem 0.875rem;
        border-radius: 9999px;
        font-weight: 600;
    }
    .save-slot :global(button:hover:not(:disabled)) {
        background: rgb(var(--color-surface-800-rgb));
    }
    .save-slot :global(button:disabled) {
        opacity: 0.6;
    }
</style>
