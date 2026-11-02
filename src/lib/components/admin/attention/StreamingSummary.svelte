<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { Icon, PlayCircle } from 'svelte-hero-icons';
    import { apiGet } from '$lib/api/client.js';
    import * as m from '$lib/paraglide/messages.js';
    import { resolve } from '$lib/paths';
    import { getAvatarUrl } from '$lib/utils/image-utils';
    import { displayName } from '$lib/utils/data-extraction';
    import Avatar from '$lib/components/ui/Avatar.svelte';
    import { relativeTime } from '$lib/utils/relative-time';
    import { useNow } from '$lib/utils/use-now.svelte';
    import { StreamingSummarySchema } from '$lib/schemas/api-streaming-responses';
    import type { StreamingSummary } from '$lib/schemas/api-streaming-responses';
    import { streamMethodLabel, streamMethodStyle } from './stream-method-display.js';

    interface Props {
        /** Drawer open flag — we only poll while the drawer is visible. */
        open: boolean;
    }
    let { open }: Props = $props();

    let data = $state<StreamingSummary | null>(null);
    let lastUpdatedAt = $state<number | null>(null);
    const now = useNow();

    /** Max per-stream rows shown before "+N more" (keeps a busy server from pushing
     *  the attention sections below the fold). */
    const VISIBLE = 5;
    /** Live-ish but cheap; only runs while the drawer is open. */
    const POLL_MS = 20_000;

    async function load(): Promise<void> {
        const { data: res, error } = await apiGet(
            '/api/admin/streaming-summary',
            StreamingSummarySchema,
        );
        if (!error && res) {
            data = res;
            lastUpdatedAt = Date.now();
        }
    }

    // Open-gated lifecycle: fetch on open + poll, tear down on close/destroy. Mirrors
    // the drawer's runSSEBus effect — never polls while closed.
    $effect(() => {
        if (!open) return;
        void load();
        const timer = setInterval(() => void load(), POLL_MS);
        return () => clearInterval(timer);
    });

    const updatedLabel = $derived(
        lastUpdatedAt ? relativeTime(new Date(lastUpdatedAt).toISOString(), now.value) : '',
    );

    // Badge colour and text are `streamMethodStyle` / `streamMethodLabel` in
    // `stream-method-display.ts`. They were two records keyed on
    // `StreamRow['method']` here, checked by nothing — tsgo skips `.svelte`, and
    // svelte-check-native does not flag a broken key in a component-local record
    // — so a widened stream method rendered an empty bordered chip.

    type SourceBadge = { label: string; classes: string };

    // Mirrors the source badge on /admin/users/sessions (ActivePlaySessionsPanel) so the
    // ambient strip labels each stream's origin the same way the console does.
    function sourceBadge(source: string | undefined, deviceId: string | undefined): SourceBadge {
        if (source === 'lumastra' && deviceId?.startsWith('jellyfin-compat-')) {
            return { label: '/j Compat', classes: 'text-teal-300 border-teal-500/40' };
        }
        switch (source) {
            case 'jellyfin':
                return { label: 'Jellyfin', classes: 'text-purple-300 border-purple-500/40' };
            case 'livetv':
                return { label: 'LiveTV', classes: 'text-green-300 border-green-500/40' };
            case 'music':
                return { label: 'Music', classes: 'text-pink-300 border-pink-500/40' };
            case 'subsonic':
                return { label: 'Subsonic', classes: 'text-amber-300 border-amber-500/40' };
            default:
                return { label: 'Lumastra', classes: 'text-blue-300 border-blue-500/40' };
        }
    }
</script>

<section>
    <h3
        class="mb-2 flex items-center gap-1.5 text-xs font-medium uppercase tracking-wide text-surface-400">
        <Icon src={PlayCircle} class="h-3.5 w-3.5 text-cyan-400" aria-hidden="true" />
        {m.admin_ops_streaming_now()}
        {#if data && data.streamCount > 0}
            <span class="ml-1 rounded bg-surface-700 px-1.5 py-0.5 text-surface-300"
                >{data.streamCount}</span>
        {/if}
    </h3>

    {#if !data}
        <!-- Pre-first-fetch: render nothing under the header rather than flash "Nothing streaming". -->
    {:else if data.streamCount === 0}
        <p class="text-xs text-surface-500">{m.admin_ops_streaming_empty()}</p>
    {:else}
        <!-- Glance line: counts + approximate bandwidth + honest staleness -->
        <div class="mb-1.5 flex items-center gap-1.5 text-xs text-surface-300">
            <span class="text-cyan-300">{data.streamCount} {m.admin_ops_streaming_streams()}</span>
            {#if data.userCount !== data.streamCount}
                <span aria-hidden="true">·</span>
                <span>{data.userCount} {m.admin_ops_streaming_users()}</span>
            {/if}
            {#if data.bandwidthMbps > 0}
                <span aria-hidden="true">·</span>
                <span class="tabular-nums text-cyan-300">~{data.bandwidthMbps} Mbps</span>
            {/if}
            {#if updatedLabel}
                <span class="ml-auto text-[11px] text-surface-500"
                    >{m.admin_ops_updated()} {updatedLabel}</span>
            {/if}
        </div>

        <div class="space-y-1">
            <!-- Index key: a read-only, fully-replaced-each-poll list with no per-row state or
                 transitions. user+title is NOT unique (same user, same title, two devices). -->
            {#each data.streams.slice(0, VISIBLE) as s, i (i)}
                {@const src = sourceBadge(s.source, s.deviceId)}
                {@const name = displayName(s.username)}
                <a
                    href={resolve('/admin/users/sessions')}
                    class="flex items-center gap-2 rounded border border-surface-700/50 px-2 py-1 text-xs transition-colors hover:bg-surface-800/60 {s.paused
                        ? 'opacity-60'
                        : ''}">
                    <Avatar
                        size="2xs"
                        username={s.username}
                        src={getAvatarUrl(s.user)}
                        initials={name.charAt(0)}
                        alt=""
                        border="border border-surface-800" />
                    <span class="w-16 shrink-0 truncate text-surface-200" title={name}>{name}</span>
                    <span class="min-w-0 flex-1 truncate text-surface-400" title={s.title}
                        >{s.title}</span>
                    <span
                        class="shrink-0 rounded border px-1 py-px text-[10px] {src.classes}"
                        title="Source">{src.label}</span>
                    <span
                        class="shrink-0 rounded border px-1 py-px text-[10px] {streamMethodStyle(
                            s.method,
                        )}">{streamMethodLabel(s.method)}</span>
                    {#if s.bitrateMbps}
                        <span class="shrink-0 tabular-nums text-cyan-300">{s.bitrateMbps}</span>
                    {/if}
                </a>
            {/each}
        </div>

        <a
            href={resolve('/admin/users/sessions')}
            class="mt-1.5 inline-block text-[11px] text-surface-500 hover:text-surface-300 hover:underline">
            {#if data.streamCount > VISIBLE}
                +{data.streamCount - VISIBLE} {m.admin_ops_more()} ·
            {/if}{m.admin_ops_view_all_sessions()} →
        </a>
    {/if}
</section>
