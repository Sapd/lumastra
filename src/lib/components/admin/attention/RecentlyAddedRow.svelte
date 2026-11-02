<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { resolve } from '$lib/paths';
    import * as m from '$lib/paraglide/messages.js';
    import { relativeTime } from '$lib/utils/relative-time';
    import { useNow } from '$lib/utils/use-now.svelte';
    import { formatNumberRanges } from '$lib/utils/number-ranges';
    import type { RecentlyAddedItem } from '$lib/schemas/api-attention-responses';

    interface Props {
        item: RecentlyAddedItem;
    }
    let { item }: Props = $props();

    // The server collapses one series' episodes that arrived together into one
    // item; `episodeCount` and `seasons` are set only on those.
    const seasons = $derived(item.seasons ?? []);
    const isGroup = $derived((item.episodeCount ?? 0) > 1 && seasons.length > 0);

    let imgError = $state(false);
    // Reactive clock so "added 5m ago" advances while the drawer stays open
    // instead of freezing at mount time.
    const now = useNow();

    const pad = (n: number): string => String(n).padStart(2, '0');

    const isEpisode = $derived(
        item.type === 'episode' || (item.seasonNumber != null && item.episodeNumber != null),
    );

    // A group of one series' episodes reads "Show · Season 5 · E15–E24" (gaps
    // split the range: "E1–E3, E5"), or "Show · Seasons 4–5" across seasons.
    const groupTitle = $derived.by(() => {
        const series = item.seriesTitle ?? item.title;
        if (seasons.length === 1) {
            const { season, episodes } = seasons[0];
            const eps = formatNumberRanges(episodes, (n) => `E${pad(n)}`);
            return `${series} · ${m.season({ number: season })}${eps ? ` · ${eps}` : ''}`;
        }
        const list = formatNumberRanges(seasons.map((s) => s.season));
        return `${series} · ${m.admin_ops_recent_seasons({ list })}`;
    });

    const displayTitle = $derived(
        isGroup
            ? groupTitle
            : isEpisode && item.seasonNumber != null && item.episodeNumber != null
              ? `${item.seriesTitle ?? item.title} · S${pad(item.seasonNumber)}E${pad(item.episodeNumber)} · ${item.title}`
              : item.year
                ? `${item.title} (${item.year})`
                : item.title,
    );

    const rel = $derived(relativeTime(item.addedAt, now.value));
    const timeLabel = $derived(rel ? `${m.admin_ops_added_ago()} ${rel}` : '');
</script>

<a
    href={resolve(`/admin/library/media/${isGroup && item.seriesId ? item.seriesId : item.id}`)}
    class="flex items-center gap-2 rounded border border-surface-700/50 px-3 py-2 text-xs hover:bg-surface-800/60 transition-colors">
    {#if item.images?.poster && !imgError}
        <img
            src={item.images.poster}
            alt={item.title}
            class="h-10 w-7 shrink-0 rounded object-cover"
            loading="lazy"
            onerror={() => {
                imgError = true;
            }} />
    {:else}
        <div class="h-10 w-7 shrink-0 rounded bg-surface-700/60"></div>
    {/if}

    <div class="min-w-0 flex-1">
        <div class="truncate font-medium text-surface-200" title={displayTitle}>{displayTitle}</div>
        <div class="flex items-center gap-1 text-surface-400">
            <span class="rounded bg-surface-700/60 px-1 py-px font-mono text-[10px] uppercase"
                >{isGroup
                    ? m.series_episodes_count({ count: item.episodeCount ?? 0 })
                    : item.type}</span>
            {#if timeLabel}<span>{timeLabel}</span>{/if}
        </div>
    </div>
</a>
