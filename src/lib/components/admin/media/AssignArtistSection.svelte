<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import MusicEditUndo from './MusicEditUndo.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { searchArtists, reassignAlbumArtist, createArtistAndAssign } from '$lib/api/admin.js';
    import { toasts } from '$lib/stores/toast.store.js';

    interface Props {
        albumId: string;
        currentArtistId?: string;
        currentArtistTitle?: string | null;
        onsaved?: () => void | Promise<void>;
    }

    let { albumId, currentArtistId, currentArtistTitle, onsaved }: Props = $props();

    let editing = $state(false);
    let snapshot = $state<string>();
    let recoveryKey = $state(0);
    let query = $state('');
    let results = $state<{ id: string; title: string }[]>([]);
    let searching = $state(false);
    let saving = $state(false);
    let inputEl = $state<HTMLInputElement | null>(null);

    $effect(() => {
        if (editing && inputEl) inputEl.focus();
    });

    // Plain variable (not $state) — used as generation counter to discard stale responses
    let searchGen = 0;

    $effect(() => {
        if (!editing) {
            results = [];
            return;
        }
        const q = query;
        const myGen = ++searchGen;
        searching = true;
        const delay = q === '' ? 0 : 300;
        const timer = setTimeout(async () => {
            try {
                const { data, error } = await searchArtists(albumId, q);
                if (myGen === searchGen) {
                    if (data) {
                        results = data.artists;
                        snapshot = data.snapshot;
                    } else if (error) toasts.error(m.media_plain_artist_search_failed());
                }
            } catch {
                if (myGen === searchGen) toasts.error(m.media_plain_artist_search_failed());
            } finally {
                if (myGen === searchGen) searching = false;
            }
        }, delay);
        return () => clearTimeout(timer);
    });

    let hasExactMatch = $derived(
        query.trim() !== '' &&
            results.some((a) => a.title.toLowerCase() === query.trim().toLowerCase()),
    );

    async function assignArtist(artistId: string): Promise<void> {
        saving = true;
        try {
            const { data, error } = await reassignAlbumArtist(albumId, artistId, snapshot);
            if (error || !data) {
                toasts.error(m.media_plain_artist_assign_failed());
                return;
            }
            toasts.success(m.media_plain_artist_assigned({ name: data.artistTitle }));
            editing = false;
            query = '';
            recoveryKey++;
            try {
                await onsaved?.();
            } catch {
                toasts.error(m.music_credits_refresh_failed());
            }
        } catch {
            toasts.error(m.media_plain_artist_assign_failed());
        } finally {
            saving = false;
        }
    }

    async function createAndAssign(): Promise<void> {
        const name = query.trim();
        if (!name) return;
        saving = true;
        try {
            const { data, error } = await createArtistAndAssign(albumId, name, snapshot);
            if (error || !data) {
                toasts.error(m.media_plain_artist_create_failed());
                return;
            }
            toasts.success(m.media_plain_artist_created({ name: data.artistTitle }));
            editing = false;
            query = '';
            recoveryKey++;
            try {
                await onsaved?.();
            } catch {
                toasts.error(m.music_credits_refresh_failed());
            }
        } catch {
            toasts.error(m.media_plain_artist_create_failed());
        } finally {
            saving = false;
        }
    }

    function startEditing(): void {
        query = '';
        editing = true;
    }

    function cancelEditing(): void {
        editing = false;
        query = '';
    }
</script>

{#if !editing}
    <div class="flex items-center gap-3">
        <span class="text-surface-200 text-sm py-2">
            {currentArtistTitle ?? m.media_plain_no_artist()}
        </span>
        <button class="btn variant-ghost-surface text-xs px-3 py-1" onclick={startEditing}>
            {m.media_plain_change()}
        </button>
    </div>
{:else}
    <div class="space-y-2">
        <p class="text-sm text-surface-400">{m.music_album_artist_save_help()}</p>
        <input
            type="text"
            class="w-full bg-surface-800/60 border border-surface-700/50 rounded-lg px-3 py-2 text-surface-100 text-sm focus:border-primary-500 focus:outline-none"
            placeholder={m.media_plain_search_artists()}
            bind:value={query}
            bind:this={inputEl}
            disabled={saving} />

        {#if results.length > 0 || query.trim()}
            <div
                class="bg-surface-900/80 border border-surface-700/50 rounded-lg overflow-hidden overflow-y-auto max-h-52">
                {#each results as artist (artist.id)}
                    <button
                        class="w-full text-left px-3 py-2 text-sm hover:bg-surface-700/60 transition-colors {artist.id ===
                        currentArtistId
                            ? 'text-primary-300 bg-primary-900/20'
                            : 'text-surface-200'}"
                        onclick={() => assignArtist(artist.id)}
                        disabled={saving}>
                        {artist.title}
                    </button>
                {/each}

                {#if results.length === 0 && !searching && query.trim() === ''}
                    <p class="px-3 py-2 text-sm text-surface-500">{m.media_plain_no_artists()}</p>
                {/if}

                {#if query.trim() && !hasExactMatch && !searching}
                    <button
                        class="w-full text-left px-3 py-2 text-sm hover:bg-surface-700/60 transition-colors text-primary-400 {results.length >
                        0
                            ? 'border-t border-surface-700/50'
                            : ''}"
                        onclick={createAndAssign}
                        disabled={saving}>
                        {m.media_plain_create_artist({ name: query.trim() })}
                    </button>
                {/if}
            </div>
        {:else if !searching}
            <div class="bg-surface-900/80 border border-surface-700/50 rounded-lg overflow-hidden">
                <p class="px-3 py-2 text-sm text-surface-500">{m.media_plain_no_artists()}</p>
            </div>
        {/if}

        <button
            class="btn variant-ghost-surface text-xs px-3 py-1"
            onclick={cancelEditing}
            disabled={saving}>
            {m.media_plain_cancel()}
        </button>
    </div>
{/if}

<MusicEditUndo mediaId={albumId} refreshKey={recoveryKey} disabled={saving} {onsaved} />
