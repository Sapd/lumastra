<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onMount, tick } from 'svelte';
    import { Icon, Plus, Check, MusicalNote, XMark } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import type { ExternalIds } from '$lib/types/api-common';
    import { preventDefault } from '$lib/utils/event-helpers';
    import { createPlaylistPicker } from './playlist-picker.svelte';
    import type { Playlist } from '$lib/stores/playlists';

    interface Props {
        externalIds: ExternalIds;
        title: string;
        subtitle?: string;
        posterPath?: string;
        onDone: () => void;
    }
    let { externalIds, title, subtitle, posterPath, onDone }: Props = $props();
    const id = $props.id();
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const picker = createPlaylistPicker(
        () => ({
            externalIds,
            mediaType: 'track',
            title,
            overview: subtitle,
            posterPath,
        }),
        () => {
            closeTimer = setTimeout(onDone, 450);
        },
    );
    const view = picker.state;
    const locked = $derived(picker.busy || !!view.message);
    let nameInput = $state<HTMLInputElement>();
    let searchInput: HTMLInputElement | undefined;
    let createButton = $state<HTMLButtonElement>();

    onMount(() => {
        void picker.load();
        return () => {
            picker.dispose();
            clearTimeout(closeTimer);
        };
    });

    async function toggleCreate(open: boolean): Promise<void> {
        if (locked) return;
        view.showCreate = open;
        await tick();
        (open ? nameInput : createButton)?.focus();
    }
    async function createAndAdd(): Promise<void> {
        if (locked) return;
        await picker.createAndAdd();
        await tick();
        if (!view.showCreate) searchInput?.focus();
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

    // The parent context menu also handles arrows/Home/End. Keep typing and
    // submenu navigation inside this panel, including on the mobile sheet.
    function keyboard(node: HTMLElement): { destroy: () => void } {
        function keydown(event: KeyboardEvent): void {
            const input = event.target instanceof HTMLInputElement;
            if (event.key === 'Escape' && view.showCreate && !locked) {
                event.preventDefault();
                event.stopPropagation();
                void toggleCreate(false);
                return;
            }
            if (
                input &&
                ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(
                    event.key,
                )
            ) {
                event.stopPropagation();
                return;
            }
            if (input || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
            const items = Array.from(
                node.querySelectorAll<HTMLButtonElement>('button[role="menuitem"]:not(:disabled)'),
            );
            if (!items.length) return;
            event.preventDefault();
            event.stopPropagation();
            const index = items.findIndex((item) => item === document.activeElement);
            const next =
                event.key === 'Home'
                    ? 0
                    : event.key === 'End'
                      ? items.length - 1
                      : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                        items.length;
            items[next].focus();
        }
        node.addEventListener('keydown', keydown);
        return { destroy: () => node.removeEventListener('keydown', keydown) };
    }
</script>

<div class="w-72 max-w-full max-h-[70dvh] overflow-y-auto overscroll-contain p-2" use:keyboard>
    <div class="px-1 pb-3">
        <p class="text-xs text-primary-400">{m.viewer_playlist_add_track()}</p>
        <p class="text-sm font-medium break-words">{title}</p>
        {#if subtitle}<p class="text-xs text-surface-400 break-words">{subtitle}</p>{/if}
    </div>
    <label for={id + '-search'} class="text-xs">{m.viewer_playlist_add_search()}</label>
    <div class="flex items-center gap-1 mt-1 mb-3">
        <input
            id={id + '-search'}
            type="search"
            class="input input-sm min-w-0"
            bind:this={searchInput}
            bind:value={view.query} />
        {#if view.query}<button
                type="button"
                class="btn-icon btn-icon-sm shrink-0"
                aria-label={m.viewer_playlist_add_clear_search()}
                onclick={clearSearch}><Icon src={XMark} class="w-4 h-4" /></button
            >{/if}
    </div>
    <div role="status" aria-atomic="true" class="text-xs text-success-400">{view.message}</div>
    {#if view.error}<p role="alert" class="py-2 text-xs text-error-400">{view.error}</p>{/if}
    {#if view.loading}
        <p role="status" class="py-4 text-xs text-surface-400">{m.viewer_playlist_add_loading()}</p>
    {:else if view.loadError}
        <p role="alert" class="py-2 text-xs text-error-400">{m.playlist_load_failed()}</p>
        <button
            type="button"
            role="menuitem"
            class="btn btn-sm variant-ghost-surface"
            onclick={picker.load}>{m.viewer_playlist_add_retry()}</button>
    {:else}
        <div class="max-h-60 overflow-y-auto py-1">
            {#if view.playlists.length === 0}<p class="py-3 text-xs text-surface-400">
                    {m.viewer_playlist_add_no_targets()}
                </p>
            {:else if picker.matches.length === 0}<p
                    role="status"
                    class="py-3 text-xs text-surface-400">
                    {m.viewer_playlist_add_no_matches()}
                </p>
            {:else}
                {#each picker.matches as playlist (playlist.id)}
                    <button
                        type="button"
                        role="menuitem"
                        class="flex w-full items-center gap-2 px-2 py-3 text-left text-sm rounded-lg hover:bg-surface-700 disabled:opacity-70"
                        disabled={locked}
                        onclick={(event) => add(playlist, event)}>
                        <Icon
                            src={view.outcomes[playlist.id] ? Check : MusicalNote}
                            class="w-4 h-4 shrink-0" />
                        <span class="min-w-0">
                            <span class="block break-words">{playlist.name}</span>
                            {#if playlist.role === 'editor'}<span class="text-xs text-surface-400"
                                    >{m.playlist_shared()}</span
                                >{/if}
                            {#if view.addingId === playlist.id}<span
                                    class="block text-xs"
                                    role="status">{m.viewer_playlist_add_adding()}</span
                                >{/if}
                        </span>
                    </button>
                {/each}
            {/if}
        </div>
        {#if view.showCreate}
            <form
                class="border-t border-surface-600 pt-3 space-y-2"
                onsubmit={preventDefault(createAndAdd)}>
                <p class="text-xs text-surface-400">{m.viewer_playlist_add_private()}</p>
                <label for={id + '-name'} class="text-xs">{m.viewer_playlist_add_name()}</label>
                <input
                    id={id + '-name'}
                    bind:this={nameInput}
                    bind:value={view.name}
                    type="text"
                    class="input input-sm"
                    placeholder={m.playlist_name_placeholder()}
                    maxlength="255"
                    required
                    disabled={locked} />
                <div class="flex flex-wrap gap-2">
                    <button
                        type="button"
                        class="btn btn-sm variant-ghost-surface"
                        disabled={locked}
                        onclick={() => toggleCreate(false)}>{m.cancel()}</button>
                    <button
                        type="submit"
                        class="btn btn-sm variant-filled-primary"
                        disabled={locked || !view.name.trim()}
                        >{view.creating
                            ? m.viewer_playlist_add_adding()
                            : m.playlist_create_and_add()}</button>
                </div>
            </form>
        {:else}
            <button
                bind:this={createButton}
                type="button"
                role="menuitem"
                class="flex w-full items-center gap-2 border-t border-surface-600 px-2 py-3 text-sm hover:bg-surface-700 disabled:opacity-70"
                disabled={locked}
                onclick={() => toggleCreate(true)}>
                <Icon src={Plus} class="w-4 h-4 shrink-0" />{m.playlist_new_playlist()}
            </button>
        {/if}
    {/if}
</div>
