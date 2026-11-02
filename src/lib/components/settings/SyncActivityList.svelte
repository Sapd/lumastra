<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages';
    import type { SyncActivityItem } from '$lib/schemas/api-integrations-responses';

    let { items }: { items: SyncActivityItem[] } = $props();

    function rel(iso: string): string {
        const t = new Date(iso).getTime();
        if (Number.isNaN(t)) return '';
        const s = Math.max(0, (Date.now() - t) / 1000);
        if (s < 60) return `${Math.floor(s)}s`;
        if (s < 3600) return `${Math.floor(s / 60)}m`;
        if (s < 86400) return `${Math.floor(s / 3600)}h`;
        return `${Math.floor(s / 86400)}d`;
    }

    /**
     * "<Series> · S{season}E{episode}" when season+episode numbers are known,
     * "<Series> · <Episode>" when only the series title is known, otherwise
     * bare title/ref.
     */
    function displayTitle(it: SyncActivityItem): string {
        if (it.seriesTitle && it.seasonNumber != null && it.episodeNumber != null) {
            return `${it.seriesTitle} · S${it.seasonNumber}E${it.episodeNumber}`;
        }
        if (it.seriesTitle) {
            const base = it.title ?? it.externalRef ?? '—';
            return `${it.seriesTitle} · ${base}`;
        }
        return it.title ?? it.externalRef ?? '—';
    }

    /**
     * Back-to-back rows for the same episode, direction and outcome collapse
     * into one with a count. A single rewatch used to fill four of the ten
     * visible lines with "↑ ✓ The Order · S1E10".
     */
    const rows = $derived.by(() => {
        const out: { item: SyncActivityItem; count: number }[] = [];
        for (const it of items) {
            const prev = out[out.length - 1];
            if (
                prev &&
                displayTitle(prev.item) === displayTitle(it) &&
                prev.item.direction === it.direction &&
                prev.item.outcome === it.outcome &&
                prev.item.eventKind === it.eventKind
            ) {
                prev.count += 1;
            } else {
                out.push({ item: it, count: 1 });
            }
        }
        return out.slice(0, 10);
    });

    /** A success row for an in-progress/resume pull is NOT "watched" — don't show a checkmark for it. */
    function isProgressOnly(it: SyncActivityItem): boolean {
        return it.outcome === 'success' && it.eventKind === 'progress';
    }
</script>

{#if items.length === 0}
    <p class="text-xs text-surface-400 px-4 py-3">{m.settings_connections_activity_none()}</p>
{:else}
    <ul class="px-4 py-3 space-y-1">
        {#each rows as { item: it, count }, i (i)}
            <li class="text-xs flex items-start gap-2" title={it.error ?? undefined}>
                <span
                    class="text-surface-400"
                    aria-label={it.direction === 'push'
                        ? m.settings_connections_activity_pushed()
                        : m.settings_connections_activity_pulled()}>
                    {it.direction === 'push' ? '↑' : '↓'}
                </span>
                <span
                    class="shrink-0"
                    role="img"
                    aria-label={it.outcome === 'success'
                        ? isProgressOnly(it)
                            ? m.settings_connections_activity_progress()
                            : m.settings_connections_activity_ok()
                        : it.outcome === 'skipped'
                          ? m.settings_connections_activity_skipped()
                          : m.settings_connections_activity_failed()}>
                    {it.outcome === 'success'
                        ? isProgressOnly(it)
                            ? '⏸'
                            : '✓'
                        : it.outcome === 'skipped'
                          ? '⚠'
                          : '✗'}
                </span>
                <span class="min-w-0 flex-1 truncate"
                    >{displayTitle(it)}{#if count > 1}<span class="text-surface-400">
                            ×{count}</span
                        >{/if}</span>
                <span class="text-surface-400 shrink-0">{rel(it.occurredAt)}</span>
                {#if it.outcome !== 'success'}
                    <span class="text-surface-400 shrink-0">
                        ·
                        {it.outcome === 'skipped'
                            ? m.settings_connections_activity_skipped()
                            : it.terminal
                              ? m.settings_connections_activity_gaveup()
                              : m.settings_connections_activity_retry()}
                    </span>
                {/if}
                {#if it.error}
                    <span class="sr-only">{it.error}</span>
                {/if}
            </li>
        {/each}
    </ul>
{/if}
