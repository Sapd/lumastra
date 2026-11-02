<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import {
        Icon,
        ArrowLeft,
        LockClosed,
        GlobeAlt,
        PencilSquare,
        Plus,
        Share,
        Trash,
        Play,
        ArrowsRightLeft,
    } from 'svelte-hero-icons';
    import PlaylistMemberProgress from '$lib/components/playlist/PlaylistMemberProgress.svelte';
    import type { Playlist } from '$lib/types/api-playlists';
    import type { MemberProgress } from '$lib/types/playlist';

    interface Props {
        playlist: Playlist;
        canEdit?: boolean;
        canManageMembers?: boolean;
        username?: string | null;
        editingName?: boolean;
        editingDescription?: boolean;
        playlistName?: string;
        playlistDescription?: string;
        addingItem?: boolean;
        deletingPlaylist?: boolean;
        savingOrder?: boolean;
        savingMetadata?: boolean;
        membersExpanded?: boolean;
        totalCount?: number;
        watchableCount?: number;
        watchedCount?: number;
        progressPercent?: number;
        memberProgress?: MemberProgress[];
        isMusicPlaylist?: boolean;
        onBack?: () => void;
        onToggleVisibility?: () => void;
        onOpenSearch?: () => void;
        onToggleMembers?: () => void;
        onDeletePlaylist?: () => void;
        onSaveName?: () => void;
        onSaveDescription?: () => void;
        onPlayAll?: () => void;
        onShuffle?: () => void;
        /** Video playlists: start the first unwatched item in playlist context. */
        playNext?: { mode: 'start' | 'continue' | 'again'; title: string; onPlay: () => void };
    }

    let {
        playlist,
        canEdit = false,
        canManageMembers = false,
        username = null,
        editingName = $bindable(false),
        editingDescription = $bindable(false),
        playlistName = $bindable(''),
        playlistDescription = $bindable(''),
        addingItem = false,
        deletingPlaylist = false,
        savingOrder = false,
        savingMetadata = false,
        membersExpanded = false,
        totalCount = 0,
        watchableCount = totalCount,
        watchedCount = 0,
        progressPercent = 0,
        memberProgress = [],
        isMusicPlaylist = false,
        onBack = () => {},
        onToggleVisibility = () => {},
        onOpenSearch = () => {},
        onToggleMembers = () => {},
        onDeletePlaylist = () => {},
        onSaveName = () => {},
        onSaveDescription = () => {},
        onPlayAll,
        playNext,
        onShuffle,
    }: Props = $props();

    // A system playlist (the watchlist) has a fixed identity: no rename, no
    // visibility change, no sharing, no delete.
    let isSystem = $derived(playlist.isSystem === true);

    function focusEditor(node: HTMLElement): void {
        node.focus();
    }
</script>

<header class="mb-6">
    <div class="flex flex-wrap items-start gap-4 mb-4">
        <button
            type="button"
            class="btn-icon variant-ghost-surface"
            onclick={onBack}
            aria-label={m.a11y_back()}>
            <Icon src={ArrowLeft} class="w-5 h-5" />
        </button>

        <div class="flex-1 min-w-0">
            {#if editingName && canEdit && !isSystem}
                <form
                    onsubmit={(event) => {
                        event.preventDefault();
                        onSaveName();
                    }}>
                    <label for="playlist-name" class="label">{m.playlist_name()}</label>
                    <input
                        id="playlist-name"
                        {@attach focusEditor}
                        type="text"
                        class="input text-2xl font-bold bg-transparent border-b-2 border-primary-500 rounded-none px-0 py-1"
                        bind:value={playlistName}
                        required
                        disabled={savingMetadata}
                        onkeydown={(event) => {
                            if (event.key === 'Escape' && !savingMetadata) editingName = false;
                        }} />
                    <div class="flex gap-2 mt-2">
                        <button
                            type="submit"
                            class="btn btn-sm variant-filled-primary"
                            disabled={savingMetadata || !playlistName.trim()}
                            >{savingMetadata
                                ? m.playlist_saving()
                                : m.viewer_playlist_save()}</button>
                        <button
                            type="button"
                            class="btn btn-sm variant-ghost-surface"
                            disabled={savingMetadata}
                            onclick={() => (editingName = false)}>{m.common_cancel()}</button>
                    </div>
                </form>
            {:else}
                <h1 class="h2 break-words">
                    {playlist.name}
                </h1>
                {#if canEdit && !isSystem}
                    <button
                        type="button"
                        class="btn btn-sm variant-ghost-surface mt-1"
                        disabled={savingMetadata}
                        onclick={() => (editingName = true)}>
                        <Icon src={PencilSquare} class="w-4 h-4 mr-1" />
                        {m.viewer_playlist_edit_details()}
                    </button>
                {/if}
            {/if}
        </div>

        <div class="flex flex-wrap items-center gap-2 w-full">
            {#if isMusicPlaylist && totalCount > 0}
                {#if onPlayAll}
                    <button type="button" class="btn variant-filled-primary" onclick={onPlayAll}>
                        <Icon src={Play} class="w-4 h-4 mr-1" />{playNext
                            ? m.playlist_play_songs()
                            : m.album_play_all()}
                    </button>
                {/if}
                {#if onShuffle}
                    <button type="button" class="btn variant-ghost-primary" onclick={onShuffle}>
                        <Icon src={ArrowsRightLeft} class="w-4 h-4 mr-1" />{playNext
                            ? m.playlist_shuffle_songs()
                            : m.album_shuffle()}
                    </button>
                {/if}
            {/if}
            {#if playNext}
                <button
                    type="button"
                    class="btn variant-filled-primary"
                    title={m.playlist_play_hint({ title: playNext.title })}
                    onclick={playNext.onPlay}>
                    <Icon src={Play} class="w-4 h-4 mr-1" />{playNext.mode === 'continue'
                        ? m.playlist_play_continue()
                        : playNext.mode === 'again'
                          ? m.playlist_play_again()
                          : m.playlist_play_start()}
                </button>
            {/if}
            {#if canEdit}
                <button
                    type="button"
                    class="btn {onPlayAll || playNext
                        ? 'variant-ghost-primary'
                        : 'variant-filled-primary'}"
                    onclick={onOpenSearch}
                    disabled={addingItem}>
                    {#if addingItem}
                        <span class="loading-spinner loading-spinner-white w-4 h-4 mr-1"></span>
                    {:else}
                        <Icon src={Plus} class="w-4 h-4 mr-1" />
                    {/if}
                    {m.playlist_add()}
                </button>
            {/if}

            {#if canManageMembers && !isSystem}
                <button
                    type="button"
                    class="btn btn-sm variant-ghost-primary"
                    aria-expanded={membersExpanded}
                    aria-controls="playlist-members"
                    onclick={onToggleMembers}>
                    <Icon src={Share} class="w-4 h-4 mr-1" />
                    {m.viewer_playlist_sharing_members()}
                </button>
            {/if}

            {#if playlist.role === 'owner' && !isSystem}
                <button
                    type="button"
                    class="btn btn-sm variant-ghost-surface"
                    onclick={onToggleVisibility}
                    disabled={savingMetadata}
                    title={playlist.visibility === 'public'
                        ? m.playlist_public_click_private()
                        : m.playlist_private_click_public()}>
                    <Icon
                        src={playlist.visibility === 'public' ? GlobeAlt : LockClosed}
                        class="w-4 h-4 mr-1" />
                    {playlist.visibility === 'public' ? m.playlist_public() : m.playlist_private()}
                </button>
                <button
                    type="button"
                    class="btn-icon btn-icon-sm variant-ghost-error"
                    onclick={onDeletePlaylist}
                    disabled={deletingPlaylist}
                    title={m.playlist_delete()}
                    aria-label={m.playlist_delete()}>
                    {#if deletingPlaylist}
                        <span class="loading-spinner loading-spinner-error w-4 h-4"></span>
                    {:else}
                        <Icon src={Trash} class="w-4 h-4" />
                    {/if}
                </button>
            {/if}
        </div>
    </div>

    {#if editingDescription && canEdit && !isSystem}
        <form
            class="mb-4"
            onsubmit={(event) => {
                event.preventDefault();
                onSaveDescription();
            }}>
            <label for="playlist-description" class="label">{m.playlist_description()}</label>
            <textarea
                id="playlist-description"
                {@attach focusEditor}
                class="textarea"
                bind:value={playlistDescription}
                disabled={savingMetadata}
                onkeydown={(event) => {
                    if (event.key === 'Escape' && !savingMetadata) editingDescription = false;
                }}
                placeholder={m.playlist_add_description()}
                rows="2"></textarea>
            <div class="flex gap-2 mt-2">
                <button
                    type="submit"
                    class="btn btn-sm variant-filled-primary"
                    disabled={savingMetadata}
                    >{savingMetadata ? m.playlist_saving() : m.viewer_playlist_save()}</button>
                <button
                    type="button"
                    class="btn btn-sm variant-ghost-surface"
                    disabled={savingMetadata}
                    onclick={() => (editingDescription = false)}>{m.common_cancel()}</button>
            </div>
        </form>
    {:else if canEdit && !isSystem}
        <button
            type="button"
            class="text-left text-surface-400 mb-4 hover:text-surface-200 break-words"
            disabled={savingMetadata}
            onclick={() => (editingDescription = true)}>
            {playlist.description || m.playlist_add_description()}
            <Icon src={PencilSquare} class="w-4 h-4 inline-block ml-1" />
        </button>
    {:else if playlist.description}
        <p class="text-surface-400 mb-4 break-words">{playlist.description}</p>
    {/if}

    <div class="flex items-center gap-4 text-sm text-surface-500 flex-wrap">
        <span
            >{totalCount}
            {totalCount === 1 ? m.playlist_entry() : m.playlist_entries()}</span>
        <span
            >{m.playlist_by({
                username: playlist.owner.displayName ?? '',
            })}</span>
        {#if username && watchableCount > 0 && (!isMusicPlaylist || playNext)}
            <span class="flex items-center gap-2">
                <span
                    >{watchedCount}/{watchableCount}
                    {m.playlist_watched()}</span>
                <div class="w-24 h-2 bg-surface-700 rounded-full overflow-hidden">
                    <div
                        class="h-full bg-success-500 transition-all duration-300"
                        style="width: {progressPercent}%">
                    </div>
                </div>
                <span class="text-xs">{progressPercent}%</span>
            </span>
        {/if}
        {#if savingOrder}
            <span role="status" class="flex items-center gap-1 text-primary-400">
                <span class="loading-spinner loading-spinner-primary w-3 h-3"></span>
                {m.playlist_saving()}
            </span>
        {/if}
    </div>

    {#if memberProgress.length > 1}
        <div class="mt-4 pt-4 border-t border-surface-700">
            <PlaylistMemberProgress members={memberProgress} currentUser={username} />
        </div>
    {/if}
</header>
