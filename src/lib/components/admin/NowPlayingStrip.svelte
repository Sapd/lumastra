<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { resolve } from '$lib/paths';
    import { Icon, PlayCircle, ArrowRight, Film, ExclamationTriangle } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { personName } from '$lib/utils/admin/formatters';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import { getAvatarUrl, getCatalogPosterUrl } from '$lib/utils/image-utils';
    import type { NowPlayingRow } from '$lib/schemas/api-admin-status-payload';

    /** "S02·E05" locator, or '' when neither number is known. */
    function episodeLocator(row: NowPlayingRow): string {
        const season =
            row.seasonNumber != null ? `S${String(row.seasonNumber).padStart(2, '0')}` : '';
        const episode =
            row.episodeNumber != null ? `E${String(row.episodeNumber).padStart(2, '0')}` : '';
        if (season && episode) return `${season}·${episode}`;
        return `${season}${episode}`;
    }

    /** Full title text for the row's tooltip/truncated span. */
    function rowTitle(row: NowPlayingRow): string {
        if (!row.seriesName) return row.title;
        const locator = episodeLocator(row);
        return locator
            ? `${row.seriesName} · ${locator} · ${row.title}`
            : `${row.seriesName} · ${row.title}`;
    }

    /**
     * Home's now-playing mini-strip (spec §3.1 §6): the glance version of the
     * Active sessions table — poster, viewer, title, one delivery chip,
     * bandwidth and progress. Sessions that need a look sort first (same
     * rule as the table, computed in the status payload); at most
     * MAX_ROWS rows, then "all N sessions →". Source, device and quality
     * live on the sessions page. Deliberately NO kill actions.
     */
    interface Props {
        count: number;
        preview: NowPlayingRow[];
        /** Full active-sessions page ("all N sessions →"). */
        sessionsHref: string;
    }

    let { count, preview, sessionsHref }: Props = $props();

    const MAX_ROWS = 5;
    let rows = $derived(
        [...preview]
            .sort((a, b) => Number(Boolean(b.struggling)) - Number(Boolean(a.struggling)))
            .slice(0, MAX_ROWS),
    );
    let posterErrors = $state(new Set<string>());

    function deliveryChip(row: NowPlayingRow): { label: string; classes: string } | null {
        if (row.transcoding || row.playMethod === 'transcode') {
            const speed = row.encodeSpeed != null ? ` ${row.encodeSpeed.toFixed(1)}×` : '';
            return {
                label: `${m.admin_home_playmethod_transcode()}${speed}`,
                classes: row.struggling
                    ? 'bg-amber-950/60 text-amber-300'
                    : 'bg-violet-950/40 text-violet-300',
            };
        }
        if (row.playMethod === 'direct') {
            return {
                label: m.admin_home_playmethod_direct(),
                classes: 'bg-emerald-950/40 text-emerald-300',
            };
        }
        return null;
    }
</script>

{#if count === 0}
    <p class="flex items-center gap-2 text-sm text-surface-500">
        <Icon src={PlayCircle} class="h-4 w-4 shrink-0" aria-hidden="true" />
        {m.admin_home_now_playing_idle()}
    </p>
{:else}
    <section class="space-y-2" aria-label={m.admin_home_now_playing_heading()}>
        <div class="flex items-baseline justify-between gap-3">
            <h3 class="text-xs font-medium uppercase tracking-wider text-surface-400">
                {m.admin_home_now_playing_heading()}
            </h3>
            <a
                href={resolve(sessionsHref)}
                class="inline-flex items-center gap-1 text-xs font-medium text-sky-400 hover:text-sky-300">
                {m.admin_home_now_playing_all({ count })}
                <Icon src={ArrowRight} class="h-3.5 w-3.5" />
            </a>
        </div>
        <ul class="space-y-1.5">
            {#each rows as row (row.sessionId)}
                {@const chip = deliveryChip(row)}
                <li>
                    <a
                        href={resolve(
                            `${sessionsHref}?session=${encodeURIComponent(row.sessionId)}`,
                        )}
                        class="flex items-center gap-3 rounded border px-2 py-1.5 transition-colors hover:bg-surface-700/30 {row.struggling
                            ? 'border-amber-600/50'
                            : 'border-surface-700/40'} {row.isPaused ? 'opacity-75' : ''}">
                        <span
                            class="relative h-12 w-8 shrink-0 overflow-hidden rounded border border-surface-700/80 bg-surface-900">
                            {#if row.posterMediaId && !posterErrors.has(row.posterMediaId)}
                                <img
                                    src={getCatalogPosterUrl(row.posterMediaId, { size: 'thumb' })}
                                    alt=""
                                    loading="lazy"
                                    decoding="async"
                                    class="absolute inset-0 h-full w-full object-cover"
                                    onerror={() => {
                                        if (row.posterMediaId)
                                            posterErrors = new Set([
                                                ...posterErrors,
                                                row.posterMediaId,
                                            ]);
                                    }} />
                            {:else}
                                <Icon
                                    src={Film}
                                    class="absolute inset-0 m-auto h-4 w-4 text-surface-600" />
                            {/if}
                        </span>
                        <span class="min-w-0 flex-1">
                            <span class="flex min-w-0 items-center gap-1.5">
                                <Avatar
                                    size="2xs"
                                    username={row.username}
                                    src={getAvatarUrl(row.username)}
                                    alt=""
                                    border="border border-surface-800" />
                                <span class="truncate text-xs text-surface-300"
                                    >{personName(row.username)}</span>
                                {#if row.struggling}
                                    <Icon
                                        src={ExclamationTriangle}
                                        class="h-3.5 w-3.5 shrink-0 text-amber-400"
                                        aria-label={m.admin_sessions_needs_look()} />
                                {/if}
                                <span class="flex-1"></span>
                                {#if chip}
                                    <span
                                        class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium {chip.classes}"
                                        >{chip.label}</span>
                                {/if}
                            </span>
                            <span
                                class="mt-0.5 block truncate text-sm text-surface-100"
                                title={rowTitle(row)}>{rowTitle(row)}</span>
                            <span class="mt-1 flex items-center gap-2">
                                {#if row.progressPercent !== undefined}
                                    <span
                                        class="block h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-surface-700"
                                        role="progressbar"
                                        aria-valuenow={Math.round(row.progressPercent)}
                                        aria-valuemin={0}
                                        aria-valuemax={100}
                                        aria-label={m.admin_home_progress_aria()}>
                                        <span
                                            class="block h-full rounded-full {row.isPaused
                                                ? 'bg-surface-500'
                                                : 'bg-sky-500'}"
                                            style="width: {row.progressPercent}%"></span>
                                    </span>
                                {:else}
                                    <span class="flex-1"></span>
                                {/if}
                                {#if row.bandwidthMbps}
                                    <span class="shrink-0 font-mono text-[10px] text-cyan-400"
                                        >{row.bandwidthMbps.toFixed(1)} Mbps</span>
                                {/if}
                            </span>
                        </span>
                    </a>
                </li>
            {/each}
        </ul>
    </section>
{/if}
