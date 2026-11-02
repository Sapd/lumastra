<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Home's "who is watching" tile: count, load (transcodes + outbound
  bandwidth) and one avatar per viewer. Ring colours carry the state —
  green playing, grey paused, amber struggling — and the whole tile turns
  amber when anything struggles, so its colour alone says whether to click.
  Everything comes from the status payload, whose sessions block computes
  struggling with the Active sessions table's rule (glanceSessions), so the
  two surfaces never disagree and Home still makes no fetches of its own.
-->
<script lang="ts">
    import { Play } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import StatCard from './StatCard.svelte';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { getAvatarUrl } from '$lib/utils/image-utils';
    import { personName } from '$lib/utils/admin/formatters';
    import type { NowPlayingRow } from '$lib/schemas/api-admin-status-payload';

    interface Props {
        count: number;
        preview: NowPlayingRow[];
        sessionsHref: string;
        load?: { transcoding: number; struggling: number; bandwidthMbps: number };
        lastEnded?: { username: string; title?: string; endedAt: string };
        formatAgo: (iso: string) => string;
    }

    let { count, preview, sessionsHref, load, lastEnded, formatAgo }: Props = $props();

    const MAX_AVATARS = 6;

    /** Struggling first, then playing, then paused — the stack reads left to right by urgency. */
    let ordered = $derived([...preview].sort((a, b) => rank(a) - rank(b)));
    function rank(row: NowPlayingRow): number {
        if (row.struggling) return 0;
        return row.isPaused ? 2 : 1;
    }
    let shown = $derived(ordered.slice(0, MAX_AVATARS));
    let hidden = $derived(Math.max(0, ordered.length - MAX_AVATARS));
    let struggling = $derived((load?.struggling ?? 0) > 0);

    function ringClass(row: NowPlayingRow): string {
        if (row.struggling) return 'ring-amber-400';
        if (row.isPaused) return 'ring-surface-500';
        return 'ring-emerald-500';
    }

    function tooltipFor(row: NowPlayingRow): string {
        const title = row.seriesName ? `${row.seriesName} – ${row.title}` : row.title;
        const parts = [
            row.transcoding
                ? row.encodeSpeed != null
                    ? m.admin_home_glance_transcode_speed({ speed: row.encodeSpeed.toFixed(1) })
                    : m.admin_home_playmethod_transcode()
                : row.playMethod === 'direct'
                  ? m.admin_home_playmethod_direct()
                  : undefined,
            row.bandwidthMbps ? `${row.bandwidthMbps.toFixed(1)} Mbps` : undefined,
            row.isPaused ? m.admin_redesign_sessions_paused() : undefined,
            row.struggling ? m.admin_sessions_needs_look() : undefined,
        ].filter(Boolean);
        return `${personName(row.username)} — ${title}${parts.length ? ` · ${parts.join(' · ')}` : ''}`;
    }

    let subtitle = $derived.by(() => {
        if (count === 0) {
            return lastEnded
                ? m.admin_home_glance_last({
                      name: personName(lastEnded.username),
                      ago: formatAgo(lastEnded.endedAt),
                  })
                : m.admin_redesign_home_sessions_hint();
        }
        if (!load) return m.admin_redesign_home_sessions_hint();
        return m.admin_home_glance_load({
            transcoding: load.transcoding,
            mbps: load.bandwidthMbps.toFixed(1),
        });
    });
</script>

<div
    class="relative rounded-xl transition-shadow {struggling
        ? 'ring-1 ring-amber-500/60 shadow-[0_0_0_1px_rgba(245,158,11,0.15)]'
        : ''}">
    <!-- Stretched link under the card: the card body opens the sessions page,
         while the avatars (pointer-events back on) keep per-session links. -->
    <a
        href={resolve(sessionsHref)}
        class="absolute inset-0 rounded-xl hover:bg-white/[0.02] focus-visible:outline-2 focus-visible:outline-primary-400"
        aria-label={m.admin_home_glance_open_sessions()}></a>
    <div class="pointer-events-none relative h-full [&>*]:h-full">
        <StatCard
            icon={Play}
            title={m.admin_nav_page_users_sessions()}
            value={count.toLocaleString()}
            valueColor={struggling ? 'text-amber-300' : undefined}
            {subtitle}
            color={struggling ? 'yellow' : 'green'}>
            {#if shown.length > 0}
                <ul
                    class="pointer-events-auto mt-3 flex items-center pl-1"
                    aria-label={m.admin_home_glance_viewers()}>
                    {#each shown as row (row.sessionId)}
                        <li class="-ml-1.5 first:ml-0">
                            <Tooltip text={tooltipFor(row)} position="bottom" fixed>
                                <a
                                    href={resolve(
                                        `${sessionsHref}?session=${encodeURIComponent(row.sessionId)}`,
                                    )}
                                    class="block rounded-full ring-2 focus-visible:outline-2 focus-visible:outline-primary-400 {ringClass(
                                        row,
                                    )}"
                                    aria-label={tooltipFor(row)}>
                                    <!-- Dim, never fade: a see-through avatar shows the ring it overlaps. -->
                                    <span
                                        class="flex {row.isPaused
                                            ? 'brightness-75 saturate-50'
                                            : ''}">
                                        <Avatar
                                            size="xs"
                                            username={row.username}
                                            src={getAvatarUrl(row.username)}
                                            alt="" />
                                    </span>
                                </a>
                            </Tooltip>
                        </li>
                    {/each}
                    {#if hidden > 0}
                        <li class="-ml-1.5">
                            <span
                                class="flex h-8 w-8 items-center justify-center rounded-full bg-surface-700 text-xs font-medium text-surface-200"
                                >+{hidden}</span>
                        </li>
                    {/if}
                </ul>
            {/if}
        </StatCard>
    </div>
</div>
