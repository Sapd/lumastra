<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only

  The rows a series expands into, inside the media browser's table (triage
  spec §4): one row per season with its completeness ("13 of 13 episodes have
  files") and badges, and, when the season is open, one row per episode.

  Rendered as <tr> siblings of the series row, each a single cell spanning the
  table, so the drill-down never has to keep step with the column plan.
  Seasons that contain an episode with a problem start open — that is usually
  why the operator expanded the series. Info notes (Not linked to Jellyfin)
  neither open a season nor repeat on every episode: the season row carries
  one muted count instead.
-->
<script lang="ts">
    import { SvelteSet } from 'svelte/reactivity';
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import type { BrowserSeasonGroupDto } from '$lib/schemas/api-admin-browser-children.js';
    import {
        ISSUE_VIEW,
        noteIssues,
        problemIssues,
        type MediaBrowserView,
    } from '$lib/shared/media-issues.js';
    import MediaIssueBadges from './MediaIssueBadges.svelte';

    interface Props {
        seriesId: string;
        seriesTitle: string;
        /** More episodes exist than were returned. */
        truncated?: boolean;
        status: 'loading' | 'error' | 'ready';
        seasons: readonly BrowserSeasonGroupDto[];
        colspan: number;
        onselectview: (view: MediaBrowserView) => void;
        onopenfiles?: (id: string) => void;
    }
    let {
        seriesId,
        seriesTitle,
        truncated = false,
        status,
        seasons,
        colspan,
        onselectview,
        onopenfiles,
    }: Props = $props();

    const open = new SvelteSet<number>();
    let seeded = false;
    $effect(() => {
        if (seeded || status !== 'ready') return;
        seeded = true;
        for (const g of seasons) {
            if (g.episodes.some((e) => problemIssues(e.issues).length > 0))
                open.add(g.seasonNumber);
        }
    });

    function seasonLabel(g: BrowserSeasonGroupDto): string {
        const title = g.season?.title;
        if (
            title &&
            title !== `Season ${g.seasonNumber}` &&
            !(g.seasonNumber === 0 && title === 'Specials')
        )
            return title;
        return g.seasonNumber === 0
            ? m.episode_picker_specials()
            : m.season_label({ number: g.seasonNumber });
    }

    function episodeCode(season?: number, episode?: number): string {
        const pad = (n?: number): string => String(n ?? 0).padStart(2, '0');
        return `S${pad(season)}E${pad(episode)}`;
    }

    /** Episodes of a season with a Not-linked-to-Jellyfin note. */
    function unlinkedCount(g: BrowserSeasonGroupDto): number {
        return g.episodes.filter((e) =>
            noteIssues(e.issues).some((i) => i.kind === 'not_in_jellyfin'),
        ).length;
    }

    function toggle(sn: number): void {
        if (open.has(sn)) open.delete(sn);
        else open.add(sn);
    }
</script>

{#if status === 'loading'}
    <tr class="border-b border-surface-800 bg-surface-900/40">
        <td {colspan} class="py-2 pl-16 text-xs text-surface-400">{m.media_tree_loading()}</td>
    </tr>
{:else if status === 'error'}
    <tr class="border-b border-surface-800 bg-surface-900/40">
        <td {colspan} class="py-2 pl-16 text-xs text-red-300">{m.media_tree_error()}</td>
    </tr>
{:else}
    {#each seasons as g (g.seasonNumber)}
        {@const label = seasonLabel(g)}
        {@const isOpen = open.has(g.seasonNumber)}
        <tr class="border-b border-surface-800 bg-surface-900/40" data-testid="tree-season-row">
            <td {colspan} class="py-1.5 pl-10 pr-4">
                <div class="flex flex-wrap items-center gap-3">
                    <button
                        type="button"
                        class="inline-flex items-center gap-2 rounded px-1 text-sm font-medium text-surface-100 hover:text-primary-300"
                        aria-expanded={isOpen}
                        aria-label={isOpen
                            ? m.media_tree_collapse_season({ title: `${seriesTitle} ${label}` })
                            : m.media_tree_expand_season({ title: `${seriesTitle} ${label}` })}
                        onclick={() => toggle(g.seasonNumber)}>
                        <span
                            aria-hidden="true"
                            class="inline-block w-3 text-surface-400 transition-transform {isOpen
                                ? 'rotate-90'
                                : ''}">›</span>
                        {label}
                    </button>
                    <span
                        class="text-xs {g.withFiles < g.episodes.length
                            ? 'text-amber-300'
                            : 'text-surface-400'}">
                        {m.media_tree_season_files({
                            withFiles: g.withFiles,
                            total: g.episodes.length,
                        })}
                    </span>
                    {#if unlinkedCount(g) > 0}
                        <button
                            type="button"
                            class="text-[11px] text-surface-500 hover:text-surface-300 hover:underline"
                            onclick={() => onselectview(ISSUE_VIEW.not_in_jellyfin)}
                            >{m.media_tree_season_unlinked({ count: unlinkedCount(g) })}</button>
                    {/if}
                    {#if g.season}
                        <MediaIssueBadges
                            issues={g.season.issues}
                            mediaType="season"
                            tooltipId={`media-issues-season-${seriesId}-${g.seasonNumber}`}
                            onselectview={(view) =>
                                view === 'files' && onopenfiles && g.season
                                    ? onopenfiles(g.season.id)
                                    : onselectview(view)} />
                    {/if}
                </div>
            </td>
        </tr>
        {#if isOpen}
            {#each g.episodes as ep (ep.id)}
                <tr
                    class="border-b border-surface-800/60 bg-surface-950/30 {ep.hasFiles
                        ? ''
                        : 'opacity-60'}"
                    data-testid="tree-episode-row">
                    <td {colspan} class="py-1 pl-20 pr-4">
                        <div class="flex flex-wrap items-center gap-3 text-sm">
                            <span class="w-16 shrink-0 font-mono text-xs text-surface-500"
                                >{episodeCode(ep.seasonNumber, ep.episodeNumber)}</span>
                            <a
                                href={resolve(`/admin/library/media/${ep.id}`)}
                                data-sveltekit-preload-data="hover"
                                class="min-w-0 truncate text-surface-200 hover:text-primary-300 hover:underline">
                                {ep.title}
                            </a>
                            {#if !ep.hasFiles}
                                <span class="text-xs text-surface-500"
                                    >{m.media_tree_no_file()}</span>
                            {/if}
                            <MediaIssueBadges
                                issues={problemIssues(ep.issues)}
                                mediaType="episode"
                                tooltipId={`media-issues-episode-${ep.id}`}
                                onselectview={(view) =>
                                    view === 'files' && onopenfiles
                                        ? onopenfiles(ep.id)
                                        : onselectview(view)} />
                        </div>
                    </td>
                </tr>
            {/each}
        {/if}
    {/each}
    {#if truncated}
        <tr class="border-b border-surface-800 bg-surface-900/40">
            <td {colspan} class="py-2 pl-10 text-xs text-amber-300">
                {m.media_tree_truncated()}
                <a
                    class="ml-2 font-medium text-yellow-300 hover:text-yellow-200"
                    href={resolve(`/admin/library/media/${seriesId}?tab=episodes`)}
                    >{m.media_tree_open_series()}</a>
            </td>
        </tr>
    {/if}
{/if}
