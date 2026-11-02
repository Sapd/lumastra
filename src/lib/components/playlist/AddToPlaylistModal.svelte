<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { Icon, Plus, QueueList, Check, XMark } from 'svelte-hero-icons';
    import { Z } from '$lib/utils/z-index';
    import { trapFocus } from '$lib/utils/focus-trap';
    import { preventDefault, self } from '$lib/utils/event-helpers';
    import type { ExternalIds } from '$lib/types/api-common';
    import * as m from '$lib/paraglide/messages';
    import { closeAddToPlaylistModal, type Playlist } from '$lib/stores/playlists';
    import { createPlaylistPicker } from './playlist-picker.svelte';

    interface Props {
        externalIds: ExternalIds;
        mediaType: 'movie' | 'tv' | 'episode' | 'track';
        title: string;
        overview?: string;
        posterPath?: string;
        seasonNumber?: number;
        episodeNumber?: number;
        seriesName?: string;
        seriesExternalIds?: ExternalIds;
    }
    let {
        externalIds,
        mediaType,
        title,
        overview = '',
        posterPath = '',
        seasonNumber,
        episodeNumber,
        seriesName = '',
        seriesExternalIds,
    }: Props = $props();

    const id = $props.id();
    const picker = createPlaylistPicker(() => ({
        externalIds,
        mediaType,
        title,
        overview,
        posterPath,
        seasonNumber,
        episodeNumber,
        seriesName: seriesName || undefined,
        seriesExternalIds,
    }));
    const view = picker.state;
    let searchInput: HTMLInputElement | undefined;
    let nameInput = $state<HTMLInputElement>();
    let createButton = $state<HTMLButtonElement>();
    const typeLabel = $derived(
        mediaType === 'tv'
            ? m.viewer_playlist_add_series()
            : mediaType === 'episode'
              ? m.viewer_playlist_add_episode()
              : mediaType === 'track'
                ? m.viewer_playlist_add_track()
                : m.viewer_playlist_add_movie(),
    );

    onMount(() => {
        void picker.load();
        return picker.dispose;
    });

    async function toggleCreate(open: boolean): Promise<void> {
        if (picker.busy) return;
        view.showCreate = open;
        await tick();
        (open ? nameInput : createButton)?.focus();
    }
    async function createAndAdd(): Promise<void> {
        await picker.createAndAdd();
        await tick();
        if (!view.showCreate) searchInput?.focus();
    }
    function close(): void {
        if (!picker.busy) closeAddToPlaylistModal();
    }
    function keydown(event: KeyboardEvent): void {
        if (event.key !== 'Escape') return;
        event.preventDefault();
        event.stopPropagation();
        close();
    }
    function clearSearch(): void {
        view.query = '';
        searchInput?.focus();
    }

    async function add(playlist: Playlist, event: MouseEvent): Promise<void> {
        const button = event.currentTarget as HTMLButtonElement;
        const hadFocus = document.activeElement === button;
        await picker.add(playlist);
        await tick();
        if (
            button.isConnected &&
            hadFocus &&
            (document.activeElement === document.body || document.activeElement === button)
        ) {
            (button.disabled ? searchInput : button)?.focus();
        }
    }

    function destinationLabel(playlist: Playlist): string {
        return playlist.playlistType === 'watchlist'
            ? m.viewer_playlist_watchlist()
            : playlist.playlistType === 'music'
              ? m.viewer_playlist_music()
              : playlist.playlistType === 'video'
                ? m.viewer_playlist_video()
                : m.viewer_playlist_mixed();
    }
</script>

<div
    class="modal-overlay modal-overlay-blur p-3 sm:p-4"
    style="z-index: {Z.FLOATING_MODAL}"
    onclick={self(close)}
    onkeydown={keydown}
    role="dialog"
    aria-modal="true"
    aria-labelledby={id + '-heading'}
    aria-describedby={id + '-scope'}
    tabindex="-1"
    use:trapFocus>
    <div
        class="w-full max-w-lg max-h-[90dvh] overflow-y-auto overscroll-contain rounded-xl bg-surface-800 p-4 sm:p-6 shadow-xl">
        <header class="flex items-start justify-between gap-3 mb-4">
            <h2 id={id + '-heading'} class="text-xl font-semibold flex items-center gap-2">
                <Icon src={QueueList} class="w-5 h-5" />{m.playlist_add_to_playlist()}
            </h2>
            <button
                type="button"
                class="btn-icon variant-ghost-surface text-surface-200 shrink-0"
                aria-label={m.close()}
                disabled={picker.busy}
                onclick={close}>
                <Icon src={XMark} class="w-5 h-5" />
            </button>
        </header>
        <div id={id + '-scope'} class="mb-5">
            <p class="text-xs text-primary-400 mb-1">{typeLabel}</p>
            <p class="font-medium break-words">{title}</p>
            {#if mediaType === 'episode'}
                <p class="text-sm text-surface-300">
                    {seriesName}
                    {#if seasonNumber !== undefined && episodeNumber !== undefined}
                        · S{seasonNumber}E{episodeNumber}{/if}
                </p>
                <p class="text-sm text-surface-400 mt-2">{m.viewer_playlist_add_episode_scope()}</p>
            {:else if mediaType === 'tv'}
                <p class="text-sm text-surface-400 mt-2">{m.viewer_playlist_add_series_scope()}</p>
            {/if}
        </div>
        <label for={id + '-search'} class="text-sm">{m.viewer_playlist_add_search()}</label>
        <div class="flex items-center gap-2 mt-1 mb-2">
            <input
                id={id + '-search'}
                type="search"
                class="input min-w-0"
                bind:this={searchInput}
                bind:value={view.query}
                data-autofocus />
            {#if view.query}<button
                    type="button"
                    class="btn-icon variant-ghost-surface shrink-0"
                    aria-label={m.viewer_playlist_add_clear_search()}
                    onclick={clearSearch}><Icon src={XMark} class="w-5 h-5" /></button
                >{/if}
        </div>
        <p class="text-xs text-surface-400 mb-4">{m.viewer_playlist_add_choose()}</p>
        <div role="status" aria-atomic="true" class="text-sm text-success-400">{view.message}</div>
        {#if view.error}<p role="alert" class="text-sm text-error-400 my-3">{view.error}</p>{/if}
        {#if view.loading}
            <p role="status" class="py-6 text-surface-400">{m.viewer_playlist_add_loading()}</p>
        {:else if view.loadError}
            <div class="py-4">
                <p role="alert" class="text-error-400 mb-3">{m.playlist_load_failed()}</p>
                <button type="button" class="btn variant-ghost-surface" onclick={picker.load}
                    >{m.viewer_playlist_add_retry()}</button>
            </div>
        {:else}
            <div class="space-y-2 max-h-[40dvh] overflow-y-auto overscroll-contain my-4">
                {#if view.playlists.length === 0}<p class="py-3 text-sm text-surface-400">
                        {m.viewer_playlist_add_no_targets()}
                    </p>
                {:else if picker.matches.length === 0}<p
                        role="status"
                        class="py-3 text-sm text-surface-400">
                        {m.viewer_playlist_add_no_matches()}
                    </p>
                {:else}
                    {#each picker.matches as playlist (playlist.id)}
                        <button
                            type="button"
                            class="w-full p-3 rounded-lg flex items-center justify-between gap-3 text-left bg-surface-700 hover:bg-surface-600 disabled:opacity-70"
                            disabled={picker.busy || !!view.outcomes[playlist.id]}
                            onclick={(event) => add(playlist, event)}>
                            <span class="min-w-0">
                                <span class="block font-medium break-words">{playlist.name}</span>
                                <span class="block text-xs text-surface-400"
                                    >{destinationLabel(playlist)}{#if !view.outcomes[playlist.id]}
                                        · {playlist.itemCount}
                                        {playlist.itemCount === 1
                                            ? m.playlist_item_singular()
                                            : m.playlist_items_plural()}{/if}{playlist.role ===
                                    'editor'
                                        ? ' · ' + m.playlist_shared()
                                        : ''}</span>
                                {#if mediaType === 'tv' && playlist.playlistType === 'watchlist'}<span
                                        class="block text-xs text-primary-400 mt-1"
                                        >{m.viewer_playlist_add_watchlist_scope()}</span
                                    >{/if}
                                {#if view.outcomes[playlist.id]}<span
                                        class="block text-xs text-success-400 mt-1"
                                        >{view.outcomes[playlist.id]}</span
                                    >{/if}
                                {#if view.addingId === playlist.id}<span
                                        class="block text-xs"
                                        role="status">{m.viewer_playlist_add_adding()}</span
                                    >{/if}
                            </span>
                            <Icon
                                src={view.outcomes[playlist.id] ? Check : Plus}
                                class="w-5 h-5 shrink-0" />
                        </button>
                    {/each}
                {/if}
            </div>
            {#if view.showCreate}
                <form
                    class="border-t border-surface-600 pt-4 space-y-3"
                    onsubmit={preventDefault(createAndAdd)}>
                    <p class="text-xs text-surface-400">{m.viewer_playlist_add_private()}</p>
                    <label class="block text-sm" for={id + '-name'}
                        >{m.viewer_playlist_add_name()}</label>
                    <input
                        id={id + '-name'}
                        bind:this={nameInput}
                        type="text"
                        class="input"
                        bind:value={view.name}
                        maxlength="255"
                        required
                        disabled={picker.busy} />
                    <label class="block text-sm" for={id + '-description'}
                        >{m.viewer_playlist_add_description()}</label>
                    <textarea
                        id={id + '-description'}
                        class="textarea"
                        bind:value={view.description}
                        rows="2"
                        disabled={picker.busy}></textarea>
                    <div class="flex flex-wrap gap-2">
                        <button
                            type="button"
                            class="btn variant-ghost-surface"
                            disabled={picker.busy}
                            onclick={() => toggleCreate(false)}>{m.cancel()}</button>
                        <button
                            type="submit"
                            class="btn variant-filled-primary"
                            disabled={picker.busy || !view.name.trim()}
                            >{view.creating
                                ? m.viewer_playlist_add_adding()
                                : m.playlist_create_and_add()}</button>
                    </div>
                </form>
            {:else}
                <button
                    bind:this={createButton}
                    type="button"
                    class="btn variant-ghost-primary w-full"
                    disabled={picker.busy}
                    onclick={() => toggleCreate(true)}
                    ><Icon src={Plus} class="w-4 h-4 mr-2" />{m.playlist_create_new()}</button>
            {/if}
        {/if}
    </div>
</div>
