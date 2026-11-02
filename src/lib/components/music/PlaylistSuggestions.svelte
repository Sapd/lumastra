<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    import { toasts } from '$lib/stores/toast.store';
    import { getPlaylistSuggestions } from '$lib/api/playlists';
    import type { ImageSet } from '$lib/schemas/api-image-descriptor';
    interface SuggestionItem {
        id: string;
        title: string;
        artist: string;
        album?: string;
        images?: ImageSet;
        duration?: number;
    }

    interface Props {
        playlistId: string;
        suggestions?: SuggestionItem[];
        onAdd?: (trackId: string) => Promise<boolean>;
    }

    let { playlistId, suggestions = [], onAdd }: Props = $props();
    let loading = $state(false);
    const adding = new SvelteSet<string>();
    let suggestionSource = $state<'sonic' | 'metadata' | undefined>(undefined);
    // Writable $derived: tracks the parent's `suggestions` prop but can also be
    // reassigned locally in refresh()/handleAdd() (Svelte 5.25+). Reassigning a
    // plain $derived used to throw — this is the supported writable form.
    let items = $derived(suggestions);

    async function refresh(): Promise<void> {
        const sourcePlaylist = playlistId;
        loading = true;
        try {
            const { data, error } = await getPlaylistSuggestions(Number(playlistId), 6);
            if (playlistId !== sourcePlaylist) return;
            if (error) toasts.error('Unable to load suggestions. Please try again.');
            if (!error && data) {
                const queue = data;
                items = queue.items.map((s) => ({
                    id: s.id,
                    title: s.title,
                    artist: s.artists.map((a) => a.title).join(', '),
                    album: s.album?.title,
                    images: s.images,
                    duration: s.durationMs == null ? undefined : s.durationMs / 1000,
                }));
                suggestionSource = queue.source;
            }
        } catch (e) {
            console.warn('[PlaylistSuggestions] Failed to load suggestions', e);
        } finally {
            loading = false;
        }
    }

    async function handleAdd(trackId: string): Promise<void> {
        if (!onAdd || adding.has(trackId)) return;
        const sourcePlaylist = playlistId;
        adding.add(trackId);
        try {
            if (await onAdd(trackId)) {
                if (playlistId === sourcePlaylist)
                    items = items.filter((item) => item.id !== trackId);
            } else {
                toasts.error('Unable to add this song. Please try again.');
            }
        } catch {
            toasts.error('Unable to add this song. Please try again.');
        } finally {
            adding.delete(trackId);
        }
    }

    function formatDuration(seconds: number | undefined): string {
        if (!seconds) return '';
        const m = Math.floor(seconds / 60);
        const s = Math.floor(seconds % 60);
        return `${m}:${String(s).padStart(2, '0')}`;
    }
</script>

<div class="mt-6 border-t border-surface-700 pt-6">
    <div class="mb-3 flex items-center justify-between">
        <div class="flex items-center gap-2">
            <h3 class="text-sm font-medium text-surface-300">Suggested to add</h3>
            {#if suggestionSource === 'sonic'}
                <span
                    class="rounded-full bg-primary-500/20 px-2 py-0.5 text-xs font-medium text-primary-400"
                    title="Suggestions powered by audio similarity">
                    sonic
                </span>
            {/if}
        </div>
        <button
            class="text-xs text-primary-400 hover:text-primary-300 disabled:opacity-50"
            onclick={refresh}
            disabled={loading}>
            {loading ? 'Loading...' : 'Refresh'}
        </button>
    </div>
    {#if items.length > 0}
        <div class="space-y-2">
            {#each items as item (item.id)}
                <div class="flex items-center gap-3 rounded-lg p-2 hover:bg-surface-800/50">
                    <div class="h-10 w-10 flex-shrink-0 overflow-hidden rounded bg-surface-700">
                        {#if item.images?.primary?.variants?.thumb}
                            <img
                                src={item.images.primary?.variants?.thumb}
                                alt=""
                                class="h-full w-full object-cover" />
                        {:else}
                            <div
                                class="flex h-full w-full items-center justify-center text-surface-500">
                                ♪
                            </div>
                        {/if}
                    </div>
                    <div class="min-w-0 flex-1">
                        <p class="truncate text-sm text-white">{item.title}</p>
                        <p class="truncate text-xs text-surface-400">
                            {item.artist}
                        </p>
                    </div>
                    {#if item.duration}
                        <span class="text-xs tabular-nums text-surface-500"
                            >{formatDuration(item.duration)}</span>
                    {/if}
                    <button
                        class="rounded-full bg-primary-500/20 px-3 py-1 text-xs font-medium text-primary-400 transition-colors hover:bg-primary-500/30"
                        disabled={!onAdd || adding.has(item.id)}
                        onclick={() => handleAdd(item.id)}>
                        {adding.has(item.id) ? 'Adding…' : 'Add'}
                    </button>
                </div>
            {/each}
        </div>
    {/if}
</div>
