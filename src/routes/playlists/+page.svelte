<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { pickVariant } from '$lib/utils/image-utils.js';
    import { untrack, tick } from 'svelte';
    import { SvelteURLSearchParams } from 'svelte/reactivity';
    import PlaylistLibraryCard from '$lib/components/playlist/PlaylistLibraryCard.svelte';
    import {
        readPlaylistFilter,
        selectPlaylistLibrary,
        type PlaylistLibraryFilter,
    } from '$lib/components/playlist/playlist-library';
    import * as m from '$lib/paraglide/messages.js';
    import { Icon, Plus, QueueList, EnvelopeOpen, Check, XMark } from 'svelte-hero-icons';
    import { goto, replaceState, afterNavigate, invalidateAll } from '$app/navigation';
    import { page } from '$app/state';
    import { resolve } from '$lib/paths';
    import {
        userPlaylists,
        createPlaylist,
        deletePlaylist,
        type Playlist,
    } from '$lib/stores/playlists';
    import * as playlistsApi from '$lib/api/playlists';
    import MusicLibraryTabs from '$lib/components/music/MusicLibraryTabs.svelte';
    import MusicNavigation from '$lib/components/music/MusicNavigation.svelte';
    import type { PageData } from './$types';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    // Pending invites from server — $derived with override allows local mutation
    // (e.g. removing an invite after accept/deny) that resets on next server load
    type PendingInvite = Playlist & { invitedAt?: string };
    let pendingInvites: PendingInvite[] = $derived(data.pendingInvites || []);
    let processingInvite = $state<number | null>(null);
    // Render this request's payload during SSR, not a module-level client store.
    let owned = $derived(data.owned ?? []);
    let shared = $derived(data.shared ?? []);

    // Effects never run during SSR: each request renders only its own data.
    // On hydration and fresh loader data, seed before subscribing so a stale
    // client store cannot overwrite the incoming server snapshot. Afterwards,
    // queue/menu mutations update the cards without needing a route reload.
    $effect(() => {
        const serverState = {
            owned: data.owned ?? [],
            shared: data.shared ?? [],
            loading: false,
            error: data.error ?? null,
        };
        return untrack(() => {
            userPlaylists.set(serverState);
            return userPlaylists.subscribe((state) => {
                owned = state.owned;
                shared = state.shared;
            });
        });
    });

    let filter = $state<PlaylistLibraryFilter>(
        untrack(() => readPlaylistFilter(page.url.searchParams)),
    );
    let musicMode = $derived(filter.kind === 'music');
    let visiblePlaylists = $derived(selectPlaylistLibrary(owned, shared, filter));
    let hasFilters = $derived(
        !!filter.query.trim() || filter.scope !== 'all' || (filter.kind !== 'all' && !musicMode),
    );
    let actionError = $state<string | null>(null);
    let createDialog: HTMLDialogElement | undefined = $state();

    afterNavigate(({ type, to }) => {
        if (type !== 'enter' && to) filter = readPlaylistFilter(to.url.searchParams);
    });

    function updateFilter(next: Partial<PlaylistLibraryFilter>): void {
        filter = { ...filter, ...next };
        const params = new SvelteURLSearchParams(page.url.searchParams);
        for (const [key, value] of Object.entries({
            q: filter.query,
            scope: filter.scope,
            type: filter.kind,
            sort: filter.sort,
        })) {
            if (!value || value === 'all' || (key === 'sort' && value === 'updated'))
                params.delete(key);
            else params.set(key, value);
        }
        replaceState(
            resolve('/playlists' + (params.size ? '?' + params.toString() : '')),
            page.state,
        );
    }

    function clearFilters(): void {
        updateFilter({ query: '', scope: 'all', kind: musicMode ? 'music' : 'all' });
    }

    let showCreateModal = $state(false);
    let newPlaylistName = $state('');
    let newPlaylistDescription = $state('');
    let newPlaylistType: 'music' | 'video' = $state('music');
    let creating = $state(false);
    let createError = $state<string | null>(null);

    let deleting = $state<number | null>(null);

    async function openCreateModal(): Promise<void> {
        showCreateModal = true;
        newPlaylistName = '';
        newPlaylistDescription = '';
        newPlaylistType = musicMode ? 'music' : 'video';
        createError = null;
        await tick();
        createDialog?.showModal();
        createDialog?.querySelector('input')?.focus();
    }

    async function handleCreatePlaylist() {
        if (creating || !newPlaylistName.trim()) return;

        creating = true;
        createError = null;

        try {
            const playlist = await createPlaylist(
                newPlaylistName.trim(),
                newPlaylistDescription.trim() || undefined,
                'private',
                newPlaylistType,
            );
            if (!playlist) {
                throw new Error(m.error_default());
            }
            createDialog?.close();
            const suffix = playlist.playlistType === 'music' ? '?type=music' : '';
            await goto(resolve(`/playlists/${playlist.id}${suffix}`));
        } catch (e) {
            createError = e instanceof Error ? e.message : m.error_default();
        } finally {
            creating = false;
        }
    }

    function playlistHref(playlist: Playlist): string {
        return resolve(
            `/playlists/${playlist.id}${playlist.playlistType === 'music' ? '?type=music' : ''}`,
        );
    }

    async function handleDelete(playlist: Playlist): Promise<void> {
        if (playlist.isSystem || deleting !== null) return;
        if (!confirm(`${m.playlist_delete()} "${playlist.name}"?`)) return;
        deleting = playlist.id;
        actionError = null;
        try {
            if (!(await deletePlaylist(playlist.id)))
                actionError = m.viewer_playlist_delete_failed();
            else owned = owned.filter((item) => item.id !== playlist.id);
        } catch {
            actionError = m.viewer_playlist_delete_failed();
        } finally {
            deleting = null;
        }
    }

    function getCoverImage(playlist: Playlist): string | null {
        return pickVariant(playlist.images.primary, 'card') ?? null;
    }

    async function handleInvite(playlistId: number, action: 'accept' | 'deny') {
        if (processingInvite !== null) return;
        processingInvite = playlistId;
        actionError = null;
        try {
            const { error } = await playlistsApi.respondToInvite(playlistId, action);

            if (!error) {
                if (action === 'accept') {
                    // Move the invite to shared playlists using the data we already have
                    const invite = pendingInvites.find((i) => i.id === playlistId);
                    if (invite) {
                        const { invitedAt, ...playlist } = invite;
                        shared = [playlist, ...shared.filter((item) => item.id !== playlist.id)];
                        userPlaylists.update((s) => ({
                            ...s,
                            shared: [playlist, ...s.shared],
                        }));
                    }
                }
                // Remove from pending invites
                pendingInvites = pendingInvites.filter((i) => i.id !== playlistId);
            } else {
                actionError = m.viewer_playlist_invite_failed();
            }
        } catch (e) {
            actionError = m.viewer_playlist_invite_failed();
        } finally {
            processingInvite = null;
        }
    }
</script>

<svelte:head>
    <title>{musicMode ? m.page_playlist_music() : m.playlist_my_playlists()}</title>
</svelte:head>

<div class="container mx-auto px-4 pb-8 pt-4 lg:pt-20 {musicMode ? 'max-w-7xl' : 'max-w-6xl'}">
    {#if musicMode}
        <div class="mb-6 space-y-3">
            <MusicNavigation />
            <MusicLibraryTabs />
        </div>
    {/if}

    <!-- Header -->
    <header class="playlist-heading">
        <div>
            <h1 class="h1 flex items-center gap-3">
                <Icon src={QueueList} class="w-8 h-8" />
                {musicMode ? m.page_playlist_music() : m.playlist_my_playlists()}
            </h1>
            <p class="intro">
                {musicMode ? m.viewer_playlist_music_intro() : m.viewer_playlist_intro()}
            </p>
        </div>
        <button type="button" class="btn variant-filled-primary" onclick={openCreateModal}>
            <Icon src={Plus} class="w-5 h-5 mr-2" />
            {m.playlist_new()}
        </button>
    </header>

    {#if data.error}
        <div class="alert variant-filled-error mb-6">
            <p>{data.error}</p>
            <button type="button" class="btn variant-soft" onclick={() => invalidateAll()}
                >{m.btn_retry()}</button>
        </div>
    {/if}

    {#if actionError}<p role="alert" class="alert variant-filled-error mb-4">{actionError}</p>{/if}

    <div class="library-toolbar">
        <label class="search-field"
            ><span class="sr-only">{m.viewer_playlist_search()}</span>
            <input
                class="input"
                type="search"
                value={filter.query}
                maxlength="120"
                placeholder={m.viewer_playlist_search()}
                oninput={(event) => updateFilter({ query: event.currentTarget.value })} />
        </label>
        <label class="sort-field"
            ><span>{m.az_sort_label()}</span>
            <select
                class="select"
                value={filter.sort}
                onchange={(event) =>
                    updateFilter({
                        sort: readPlaylistFilter(
                            new URLSearchParams({ sort: event.currentTarget.value }),
                        ).sort,
                    })}>
                <option value="updated">{m.viewer_playlist_recent()}</option>
                <option value="title">{m.viewer_playlist_title()}</option>
                <option value="size">{m.viewer_playlist_size()}</option>
            </select>
        </label>
    </div>
    <div class="filter-bar">
        <div role="group" aria-label={m.viewer_playlist_ownership()} class="filter-group">
            <button
                class:active={filter.scope === 'all'}
                aria-pressed={filter.scope === 'all'}
                onclick={() => updateFilter({ scope: 'all' })}>{m.viewer_playlist_all()}</button>
            <button
                class:active={filter.scope === 'owned'}
                aria-pressed={filter.scope === 'owned'}
                onclick={() => updateFilter({ scope: 'owned' })}
                >{m.playlist_created_by_me()}</button>
            <button
                class:active={filter.scope === 'shared'}
                aria-pressed={filter.scope === 'shared'}
                onclick={() => updateFilter({ scope: 'shared' })}
                >{m.playlist_shared_with_me()}</button>
        </div>
        {#if !musicMode}
            <div role="group" aria-label={m.viewer_playlist_type()} class="filter-group">
                <button
                    class:active={filter.kind === 'all'}
                    aria-pressed={filter.kind === 'all'}
                    onclick={() => updateFilter({ kind: 'all' })}
                    >{m.viewer_playlist_all_types()}</button>
                <button
                    class:active={filter.kind === 'music'}
                    aria-pressed={filter.kind === 'music'}
                    onclick={() => updateFilter({ kind: 'music' })}
                    >{m.viewer_playlist_music()}</button>
                <button
                    class:active={filter.kind === 'video'}
                    aria-pressed={filter.kind === 'video'}
                    onclick={() => updateFilter({ kind: 'video' })}
                    >{m.viewer_playlist_video_filter()}</button>
            </div>
        {/if}
    </div>

    <!-- Pending Invites -->
    {#if pendingInvites.length > 0}
        <section class="mb-10">
            <h2 class="h3 mb-4 text-surface-300 flex items-center gap-2">
                <Icon src={EnvelopeOpen} class="w-5 h-5" />
                {m.playlist_invitations()}
            </h2>

            <div class="space-y-3">
                {#each pendingInvites as invite (invite.id)}
                    <div class="invitation p-4 bg-surface-800/50 rounded-lg">
                        <div class="flex items-center justify-between flex-wrap gap-4">
                            <div class="flex items-center gap-4 min-w-0">
                                <!-- Cover Image or Placeholder -->
                                <div
                                    class="w-16 h-10 rounded overflow-hidden bg-surface-700 shrink-0">
                                    {#if getCoverImage(invite)}
                                        <img
                                            src={getCoverImage(invite)}
                                            alt={invite.name}
                                            class="w-full h-full object-cover" />
                                    {:else}
                                        <div class="w-full h-full center">
                                            <Icon
                                                src={QueueList}
                                                class="w-6 h-6 text-surface-500" />
                                        </div>
                                    {/if}
                                </div>

                                <!-- Info -->
                                <div class="min-w-0">
                                    <p class="text-sm text-surface-400">
                                        {m.playlist_invited_you({
                                            username: invite.owner.displayName ?? '',
                                        })}
                                    </p>
                                    <h3 class="font-semibold truncate">
                                        {invite.name}
                                    </h3>
                                    <p class="text-xs text-surface-500">
                                        {invite.itemCount}
                                        {invite.itemCount === 1
                                            ? m.playlist_entry()
                                            : m.playlist_entries()} · {invite.role === 'editor'
                                            ? m.playlist_editor()
                                            : m.playlist_readonly()}
                                    </p>
                                </div>
                            </div>

                            <!-- Actions -->
                            <div class="flex-center-gap-2 shrink-0">
                                {#if processingInvite === invite.id}
                                    <span class="loading-spinner loading-spinner-primary w-5 h-5"
                                    ></span>
                                {:else}
                                    <button
                                        type="button"
                                        disabled={processingInvite !== null}
                                        class="btn btn-sm variant-filled-primary"
                                        onclick={() => handleInvite(invite.id, 'accept')}>
                                        <Icon src={Check} class="w-4 h-4 mr-1" />
                                        {m.playlist_accept()}
                                    </button>
                                    <button
                                        type="button"
                                        disabled={processingInvite !== null}
                                        class="btn btn-sm variant-ghost-surface"
                                        onclick={() => handleInvite(invite.id, 'deny')}>
                                        <Icon src={XMark} class="w-4 h-4 mr-1" />
                                        {m.playlist_decline()}
                                    </button>
                                {/if}
                            </div>
                        </div>
                    </div>
                {/each}
            </div>
        </section>
    {/if}

    <div class="results-heading">
        <p role="status">{m.viewer_playlist_count({ count: visiblePlaylists.length })}</p>
        {#if hasFilters}<button type="button" onclick={clearFilters}>{m.catalog_clear()}</button
            >{/if}
    </div>
    {#if !data.error && visiblePlaylists.length === 0}
        <div class="empty-library">
            <Icon src={QueueList} class="h-12 w-12 text-surface-400" />
            <h2>{hasFilters ? m.viewer_playlist_no_matches() : m.empty_no_playlists()}</h2>
            <p>
                {hasFilters ? m.viewer_playlist_no_matches_hint() : m.viewer_playlist_empty_hint()}
            </p>
            {#if hasFilters}<button class="btn variant-soft-primary" onclick={clearFilters}
                    >{m.catalog_clear()}</button>
            {:else}<button class="btn variant-filled-primary" onclick={openCreateModal}
                    >{m.playlist_create_first()}</button
                >{/if}
        </div>
    {:else}
        <div class="playlist-grid">
            {#each visiblePlaylists as playlist (playlist.id)}
                <PlaylistLibraryCard
                    {playlist}
                    covers={[]}
                    href={playlistHref(playlist)}
                    owned={owned.some((item) => item.id === playlist.id)}
                    busy={deleting === playlist.id}
                    ondelete={handleDelete} />
            {/each}
        </div>
    {/if}
</div>

<dialog
    bind:this={createDialog}
    class="create-dialog"
    aria-labelledby="create-playlist-title"
    onclose={() => (showCreateModal = false)}
    oncancel={(event) => {
        if (creating) event.preventDefault();
    }}>
    {#if showCreateModal}
        <header>
            <div>
                <h2 id="create-playlist-title">{m.playlist_new()}</h2>
                <p>{m.viewer_playlist_private_hint()}</p>
            </div>
            <button
                type="button"
                disabled={creating}
                onclick={() => createDialog?.close()}
                aria-label={m.btn_cancel()}><Icon src={XMark} class="h-5 w-5" /></button>
        </header>
        {#if createError}<p role="alert" class="alert variant-filled-error">{createError}</p>{/if}
        <form
            onsubmit={(event) => {
                event.preventDefault();
                void handleCreatePlaylist();
            }}>
            <label class="label"
                ><span>{m.playlist_name()}</span><input
                    class="input"
                    type="text"
                    placeholder={m.playlist_placeholder_name()}
                    bind:value={newPlaylistName}
                    maxlength="255"
                    required
                    disabled={creating} /></label>
            <label class="label"
                ><span>{m.playlist_description()}</span><textarea
                    class="textarea"
                    bind:value={newPlaylistDescription}
                    placeholder={m.playlist_placeholder_description()}
                    rows="3"
                    disabled={creating}></textarea
                ></label>
            <fieldset disabled={creating}>
                <legend>{m.viewer_playlist_type()}</legend>
                <div class="filter-group">
                    <button
                        type="button"
                        class:active={newPlaylistType === 'music'}
                        aria-pressed={newPlaylistType === 'music'}
                        onclick={() => (newPlaylistType = 'music')}
                        >{m.viewer_playlist_music()}</button>
                    <button
                        type="button"
                        class:active={newPlaylistType === 'video'}
                        aria-pressed={newPlaylistType === 'video'}
                        onclick={() => (newPlaylistType = 'video')}
                        >{m.viewer_playlist_video()}</button>
                </div>
            </fieldset>
            <footer>
                <button
                    type="button"
                    class="btn variant-ghost-surface"
                    disabled={creating}
                    onclick={() => createDialog?.close()}>{m.btn_cancel()}</button>
                <button
                    class="btn variant-filled-primary"
                    type="submit"
                    disabled={creating || !newPlaylistName.trim()}
                    >{creating ? m.viewer_playlist_creating() : m.playlist_create()}</button>
            </footer>
        </form>
    {/if}
</dialog>

<style>
    .playlist-heading {
        display: flex;
        justify-content: space-between;
        align-items: start;
        flex-wrap: wrap;
        gap: 1rem;
        margin-bottom: 2rem;
    }
    .intro {
        margin-top: 0.5rem;
        color: var(--color-surface-300);
        max-width: 42rem;
    }
    .library-toolbar {
        display: flex;
        gap: 1rem;
        align-items: end;
        flex-wrap: wrap;
    }
    .search-field {
        flex: 1;
        min-width: min(100%, 18rem);
    }
    .sort-field {
        display: flex;
        align-items: center;
        gap: 0.6rem;
        font-size: 0.8rem;
        color: var(--color-surface-300);
    }
    .input,
    .select {
        min-height: 44px;
        border-radius: 0.5rem;
    }
    .filter-bar {
        display: flex;
        gap: 0.75rem 1.5rem;
        flex-wrap: wrap;
        justify-content: space-between;
        padding: 1rem 0;
        margin-bottom: 1.25rem;
        border-bottom: 1px solid color-mix(in srgb, var(--color-surface-500) 25%, transparent);
    }
    .filter-group {
        display: flex;
        gap: 0.3rem;
        flex-wrap: wrap;
    }
    .filter-group button {
        padding: 0.55rem 0.75rem;
        min-height: 44px;
        border-radius: 0.4rem;
        font-size: 0.85rem;
        color: var(--color-surface-300);
    }
    .filter-group button:hover {
        background: var(--color-surface-700);
    }
    .filter-group button.active {
        background: color-mix(in srgb, var(--color-primary-500) 20%, transparent);
        color: var(--color-primary-200);
    }
    button:focus-visible {
        outline: 2px solid var(--color-primary-400);
        outline-offset: 3px;
    }
    .results-heading {
        display: flex;
        justify-content: space-between;
        gap: 1rem;
        align-items: center;
        margin-bottom: 1.25rem;
        font-size: 0.85rem;
        color: var(--color-surface-300);
    }
    .results-heading button {
        color: var(--color-primary-300);
        min-height: 44px;
    }
    .playlist-grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 2rem 1.1rem;
    }
    .empty-library {
        display: grid;
        justify-items: center;
        text-align: center;
        gap: 1rem;
        padding: 3rem 1rem;
    }
    .empty-library h2 {
        font-weight: 600;
        font-size: 1.2rem;
    }
    .empty-library p {
        color: var(--color-surface-300);
        max-width: 28rem;
    }
    .create-dialog {
        width: min(32rem, calc(100vw - 2rem));
        max-height: 90dvh;
        margin: auto;
        border: 0;
        padding: 1.5rem;
        border-radius: 0.85rem;
        background: var(--color-surface-800);
        color: var(--color-surface-50);
        overflow: auto;
    }
    .create-dialog::backdrop {
        background: #050812bb;
        backdrop-filter: blur(4px);
    }
    .create-dialog header {
        display: flex;
        gap: 1rem;
        justify-content: space-between;
        margin-bottom: 1.5rem;
    }
    .create-dialog h2 {
        font-size: 1.4rem;
        font-weight: 600;
    }
    .create-dialog header p {
        font-size: 0.875rem;
        color: var(--color-surface-300);
        margin-top: 0.4rem;
    }
    .create-dialog header button {
        flex-shrink: 0;
        width: 44px;
        height: 44px;
        display: grid;
        place-items: center;
    }
    .create-dialog form {
        display: grid;
        gap: 1.2rem;
    }
    .create-dialog footer {
        display: flex;
        justify-content: end;
        gap: 0.75rem;
        padding-top: 0.5rem;
    }
    @media (min-width: 900px) {
        .playlist-grid {
            grid-template-columns: repeat(3, minmax(0, 1fr));
        }
    }
    @media (max-width: 639px) {
        .playlist-heading {
            gap: 0.5rem;
            margin-bottom: 1rem;
        }
        .playlist-heading h1 {
            font-size: 1.875rem;
            line-height: 1.2;
        }
        .playlist-heading > button {
            min-height: 44px;
        }
        .intro {
            margin-top: 0.25rem;
            font-size: 0.875rem;
            line-height: 1.4;
        }
        .library-toolbar {
            gap: 0.5rem;
        }
        .filter-bar {
            gap: 0.25rem;
            padding: 0.5rem 0;
            margin-bottom: 0.5rem;
        }
        .filter-group {
            width: 100%;
            flex-wrap: nowrap;
        }
        .filter-group button {
            flex: 1 1 auto;
            min-width: 0;
            padding: 0.5rem 0.625rem;
            font-size: 0.75rem;
            white-space: nowrap;
        }
        .results-heading {
            margin-bottom: 0.75rem;
        }
    }
    @media (max-width: 420px) {
        .playlist-grid {
            gap: 1.5rem 0.8rem;
        }
        .sort-field {
            width: 100%;
        }
        .sort-field select {
            flex: 1;
        }
    }
</style>
