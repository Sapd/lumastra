<!-- SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
     SPDX-License-Identifier: AGPL-3.0-only -->
<script lang="ts">
    import { pickVariant } from '$lib/utils/image-utils.js';
    import {
        Icon,
        QueueList,
        MusicalNote,
        EllipsisVertical,
        PencilSquare,
        Trash,
        LockClosed,
        GlobeAlt,
    } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import type { Playlist } from '$lib/types/api-playlists';
    import { resolve } from '$lib/paths';
    let {
        playlist,
        covers,
        href,
        owned,
        busy = false,
        ondelete,
    }: {
        playlist: Playlist;
        covers: string[];
        href: string;
        owned: boolean;
        busy?: boolean;
        ondelete: (playlist: Playlist) => void;
    } = $props();
    let music = $derived(playlist.playlistType === 'music');
    // Native <details> has no light-dismiss: close it on Escape (returning focus
    // to the trigger) and on any pointer-down outside the menu.
    let menuOpen = $state(false);
    let menuEl: HTMLDetailsElement | undefined = $state();
    function closeMenu(restoreFocus: boolean): void {
        menuOpen = false;
        if (restoreFocus) menuEl?.querySelector('summary')?.focus();
    }
</script>

<svelte:window
    onpointerdown={(event) => {
        if (menuOpen && !menuEl?.contains(event.target as Node)) closeMenu(false);
    }}
    onkeydown={(event) => {
        if (menuOpen && event.key === 'Escape') {
            event.preventDefault();
            closeMenu(true);
        }
    }} />

<article class="playlist-card" class:busy aria-busy={busy}>
    <a class="playlist-link" {href}>
        <div class="artwork" class:music>
            {#if pickVariant(playlist.images.primary, 'card')}
                <img src={pickVariant(playlist.images.primary, 'card')} alt="" loading="lazy" />
            {:else if covers.length >= 4}
                <div class="collage">
                    {#each covers.slice(0, 4) as cover, index (index)}<img
                            src={cover}
                            alt=""
                            loading="lazy" />{/each}
                </div>
            {:else if covers.length}
                <img src={covers[0]} alt="" loading="lazy" />
            {:else}
                <Icon src={music ? MusicalNote : QueueList} class="h-12 w-12" />
            {/if}
            <span class="kind"
                >{music
                    ? m.viewer_playlist_music()
                    : playlist.isSystem
                      ? m.viewer_playlist_watchlist()
                      : playlist.playlistType === 'general'
                        ? m.viewer_playlist_mixed()
                        : m.viewer_playlist_video()}</span>
        </div>
        <h3>{playlist.name}</h3>
        {#if playlist.description}<p class="description">{playlist.description}</p>{/if}
    </a>
    <div class="metadata">
        <span
            >{playlist.itemCount}
            {playlist.itemCount === 1 ? m.playlist_entry() : m.playlist_entries()}</span>
        {#if owned}
            <span class="visibility"
                ><Icon
                    src={playlist.visibility === 'public' ? GlobeAlt : LockClosed}
                    class="h-3.5 w-3.5" />{playlist.visibility === 'public'
                    ? m.playlist_public()
                    : m.playlist_private()}</span>
        {:else}
            <span>{m.playlist_by({ username: playlist.owner.displayName ?? '' })}</span>
        {/if}
    </div>
    {#if !owned}<p class="role">
            {playlist.role === 'editor' ? m.playlist_editor() : m.playlist_readonly()}
        </p>{/if}
    {#if owned && !playlist.isSystem}
        <details class="actions" bind:open={menuOpen} bind:this={menuEl}>
            <summary aria-label={m.viewer_playlist_actions({ name: playlist.name })}
                ><Icon src={EllipsisVertical} class="h-5 w-5" /></summary>
            <div class="action-menu">
                <a href={resolve(`/playlists/${playlist.id}?edit=1${music ? '&type=music' : ''}`)}
                    ><Icon src={PencilSquare} class="h-4 w-4" />{m.btn_edit()}</a>
                <button
                    type="button"
                    disabled={busy}
                    onclick={() => {
                        closeMenu(false);
                        ondelete(playlist);
                    }}><Icon src={Trash} class="h-4 w-4" />{m.btn_delete()}</button>
            </div>
        </details>
    {/if}
</article>

<style>
    .playlist-card {
        position: relative;
        min-width: 0;
    }
    .busy {
        opacity: 0.55;
        pointer-events: none;
    }
    .playlist-link {
        display: block;
        color: inherit;
        text-decoration: none;
        border-radius: 0.65rem;
    }
    .playlist-link:focus-visible,
    summary:focus-visible {
        outline: 2px solid var(--color-primary-400);
        outline-offset: 4px;
    }
    .artwork {
        position: relative;
        aspect-ratio: 16 / 10;
        display: grid;
        place-items: center;
        overflow: hidden;
        border-radius: 0.65rem;
        background: var(--color-surface-800);
        color: var(--color-surface-400);
    }
    .artwork.music {
        background: linear-gradient(135deg, var(--color-primary-900), var(--color-surface-800));
    }
    .artwork img {
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .collage {
        position: absolute;
        inset: 0;
        display: grid;
        grid-template-columns: 1fr 1fr;
        grid-template-rows: 1fr 1fr;
    }
    .collage img {
        min-height: 0;
    }
    .kind {
        position: absolute;
        left: 0.6rem;
        bottom: 0.6rem;
        padding: 0.25rem 0.5rem;
        background: rgb(0 0 0 / 0.75);
        color: white;
        border-radius: 0.3rem;
        font-size: 0.7rem;
    }
    h3 {
        margin: 0.8rem 0 0.3rem;
        font-size: 1.05rem;
        font-weight: 600;
        overflow-wrap: anywhere;
    }
    .description {
        color: var(--color-surface-300);
        font-size: 0.875rem;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        margin-bottom: 0.5rem;
    }
    .metadata {
        display: flex;
        gap: 0.75rem;
        flex-wrap: wrap;
        font-size: 0.8rem;
        color: var(--color-surface-400);
    }
    .visibility {
        display: inline-flex;
        gap: 0.3rem;
        align-items: center;
    }
    .role {
        color: var(--color-primary-300);
        font-size: 0.75rem;
        margin-top: 0.35rem;
    }
    .actions {
        position: absolute;
        top: 0.5rem;
        right: 0.5rem;
    }
    summary {
        width: 2.75rem;
        height: 2.75rem;
        display: grid;
        place-items: center;
        list-style: none;
        cursor: pointer;
        background: rgb(0 0 0 / 0.7);
        color: white;
        border-radius: 0.4rem;
    }
    summary::-webkit-details-marker {
        display: none;
    }
    .action-menu {
        position: absolute;
        z-index: 2;
        right: 0;
        margin-top: 0.35rem;
        padding: 0.3rem;
        min-width: 10rem;
        border-radius: 0.5rem;
        background: var(--color-surface-700);
        box-shadow: 0 8px 24px #0006;
    }
    .action-menu a,
    .action-menu button {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        padding: 0.6rem 0.8rem;
        min-height: 44px;
        width: 100%;
        text-align: left;
        border-radius: 0.3rem;
    }
    .action-menu a:hover,
    .action-menu button:hover {
        background: var(--color-surface-600);
    }
    .action-menu button {
        color: var(--color-error-300);
    }
</style>
