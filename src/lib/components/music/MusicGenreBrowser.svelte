<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  MusicGenreBrowser — the pin/filter genre accordion. Pin/unpin re-runs the
  current route's load (invalidateAll) to reorder its genre carousels — the
  same side effect the /music home relied on. Shown on /music/explore at all
  breakpoints; desktop-only on /music home.
-->

<script lang="ts">
    import { invalidateAll } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { SvelteSet } from 'svelte/reactivity';
    import { Icon, MagnifyingGlass, XMark, MapPin } from 'svelte-hero-icons';
    import { pinMusicGenre, unpinMusicGenre } from '$lib/api/music';
    import * as m from '$lib/paraglide/messages.js';

    interface LibraryGenre {
        genre: string;
        trackCount: number;
        albumCount: number;
    }

    interface Props {
        libraryGenres: LibraryGenre[];
        pinnedGenreNames: string[];
    }

    let { libraryGenres, pinnedGenreNames }: Props = $props();

    let genreFilter = $state('');
    let genreFilterRef: HTMLInputElement | undefined = $state();
    let showAllGenres = $state(false);

    // svelte-ignore state_referenced_locally
    const pinnedGenres: SvelteSet<string> = new SvelteSet(pinnedGenreNames ?? []);
    let pinningGenre = $state<string | null>(null);

    $effect(() => {
        const serverPinned = pinnedGenreNames ?? [];
        pinnedGenres.clear();
        for (const g of serverPinned) pinnedGenres.add(g);
    });

    async function togglePin(genre: string): Promise<void> {
        if (pinningGenre) return;
        pinningGenre = genre;
        const wasPinned = pinnedGenres.has(genre);
        try {
            if (wasPinned) pinnedGenres.delete(genre);
            else pinnedGenres.add(genre);
            const { error } = wasPinned ? await unpinMusicGenre(genre) : await pinMusicGenre(genre);
            if (error) {
                if (wasPinned) pinnedGenres.add(genre);
                else pinnedGenres.delete(genre);
            } else {
                invalidateAll();
            }
        } finally {
            pinningGenre = null;
        }
    }

    const VISIBLE_GENRE_COUNT = 12;

    let filteredGenres = $derived.by(() => {
        const q = genreFilter.trim().toLowerCase();
        const all = libraryGenres;
        const filtered = q ? all.filter((g) => g.genre.toLowerCase().includes(q)) : all;
        return filtered.toSorted((a, b) => {
            const aPinned = pinnedGenres.has(a.genre);
            const bPinned = pinnedGenres.has(b.genre);
            if (aPinned && !bPinned) return -1;
            if (!aPinned && bPinned) return 1;
            return 0;
        });
    });

    let visibleGenres = $derived(
        showAllGenres ? filteredGenres : filteredGenres.slice(0, VISIBLE_GENRE_COUNT),
    );
    let hasMoreGenres = $derived(!showAllGenres && filteredGenres.length > VISIBLE_GENRE_COUNT);
</script>

{#if libraryGenres.length > 0}
    <details open={pinnedGenres.size > 0}>
        <summary
            class="flex cursor-pointer select-none list-none items-center gap-2 text-xs font-semibold uppercase tracking-wider text-surface-400 hover:text-surface-300 group/genre-summary">
            <span class="genre-caret">&#9654;</span>
            {m.route_music_browse_genres()}
        </summary>
        <div class="mt-3 space-y-2">
            <div class="flex items-center justify-between">
                <div class="relative">
                    <span
                        class="pointer-events-none absolute top-1/2 left-2 -translate-y-1/2 text-surface-500">
                        <Icon src={MagnifyingGlass} class="h-3 w-3" />
                    </span>
                    <input
                        type="text"
                        placeholder={m.route_music_find_genre_placeholder()}
                        bind:value={genreFilter}
                        bind:this={genreFilterRef}
                        class="w-36 rounded-md border border-surface-700/50 bg-surface-800/50 py-1 pr-6 pl-6 text-xs text-surface-50 placeholder-surface-600 outline-none transition-colors focus:w-48 focus:border-primary-500/40 focus:ring-1 focus:ring-primary-500/20" />
                    {#if genreFilter}
                        <button
                            class="absolute top-1/2 right-1.5 -translate-y-1/2 text-surface-500 hover:text-surface-50"
                            onclick={() => {
                                genreFilter = '';
                                genreFilterRef?.focus();
                            }}>
                            <Icon src={XMark} class="h-3 w-3" />
                        </button>
                    {/if}
                </div>
            </div>
            <div class="flex flex-wrap gap-1.5">
                {#each visibleGenres as g, gIdx (g.genre + '-' + gIdx)}
                    {@const isPinned = pinnedGenres.has(g.genre)}
                    <span
                        class="group/chip inline-flex items-center gap-1 rounded-full border px-3 py-1.5 text-xs font-medium transition-all {isPinned
                            ? 'border-primary-500/40 bg-primary-500/15 text-primary-300'
                            : 'border-surface-600/30 bg-surface-800/40 text-surface-300 hover:border-surface-500/50 hover:bg-surface-700/60 hover:text-surface-50'}">
                        <a
                            href={resolve(`/music/genres/${encodeURIComponent(g.genre)}`)}
                            class="hover:underline">
                            {g.genre}
                        </a>
                        <span class="text-surface-500">{g.trackCount}</span>
                        <button
                            class="ml-0.5 {isPinned
                                ? 'text-primary-400'
                                : 'hidden text-surface-500 group-hover/chip:inline-flex hover:text-primary-400'}"
                            disabled={pinningGenre === g.genre}
                            title={isPinned
                                ? m.route_music_unpin_from_home()
                                : m.route_music_pin_to_home()}
                            aria-label={isPinned
                                ? m.route_music_unpin_from_home()
                                : m.route_music_pin_to_home()}
                            onclick={(e: MouseEvent) => {
                                e.preventDefault();
                                e.stopPropagation();
                                togglePin(g.genre);
                            }}>
                            <Icon src={MapPin} class="h-3 w-3" solid={isPinned} />
                        </button>
                    </span>
                {/each}
                {#if hasMoreGenres}
                    <button
                        class="flex items-center gap-1.5 rounded-full border border-surface-600/30 bg-surface-800/40 px-3 py-1.5 text-xs font-medium text-primary-400 transition-all hover:border-primary-500/40 hover:bg-surface-700/60"
                        onclick={() => (showAllGenres = true)}>
                        {m.route_music_more_genres({
                            count: filteredGenres.length - VISIBLE_GENRE_COUNT,
                        })}
                    </button>
                {:else if showAllGenres && filteredGenres.length > VISIBLE_GENRE_COUNT}
                    <button
                        class="flex items-center gap-1.5 rounded-full border border-surface-600/30 bg-surface-800/40 px-3 py-1.5 text-xs font-medium text-primary-400 transition-all hover:border-primary-500/40 hover:bg-surface-700/60"
                        onclick={() => (showAllGenres = false)}>
                        {m.section_show_less()}
                    </button>
                {/if}
                {#if genreFilter && filteredGenres.length === 0}
                    <span class="px-2 py-1.5 text-xs text-surface-500">
                        {m.route_music_no_genres_match({ filter: genreFilter })}</span>
                {/if}
            </div>
        </div>
    </details>
{/if}

<style>
    details > summary .genre-caret {
        display: inline-block;
        transition: transform 200ms ease-in-out;
        transform: rotate(0deg);
    }
    details[open] > summary .genre-caret {
        transform: rotate(90deg);
    }
</style>
