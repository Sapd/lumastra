<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Compact playback-health badge of one Live TV feed: "Offline" (red) or "Failing"
  (amber); renders nothing while the feed is ok. Tooltip and secondary text read
  "<reason> · <time ago> · <n> failures in a row". An optional Reset button clears
  the failure streak (the parent calls the API and refreshes).
-->
<script lang="ts">
    import type { LiveTvChannelHealth } from '$lib/schemas/livetv-failures.js';
    import * as m from '$lib/paraglide/messages.js';
    import { feedHealthDetail, feedHealthIssue, feedHealthStateLabel } from './feed-health.js';

    interface Props {
        health: LiveTvChannelHealth | undefined;
        /** Present: a Reset button is shown for failing/offline feeds. */
        onReset?: () => Promise<unknown> | void;
        /** Show the "<reason> · <time>" text next to the badge. */
        showDetail?: boolean;
    }

    let { health, onReset, showDetail = true }: Props = $props();

    let issue = $derived(feedHealthIssue(health));
    let detail = $derived(health && issue ? feedHealthDetail(health) : '');
    let busy = $state(false);

    async function reset(event: MouseEvent): Promise<void> {
        event.stopPropagation();
        if (!onReset || busy) return;
        busy = true;
        try {
            await onReset();
        } finally {
            busy = false;
        }
    }
</script>

{#if health && issue}
    <div
        class="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] leading-tight"
        data-testid="feed-health">
        <span
            class="inline-flex shrink-0 items-center rounded border px-1.5 py-0.5 font-medium {issue ===
            'offline'
                ? 'border-red-700/50 bg-red-900/40 text-red-300'
                : 'border-amber-700/50 bg-amber-900/40 text-amber-300'}"
            title={detail}
            data-testid="feed-health-badge"
            data-state={issue}>
            {feedHealthStateLabel(issue)}
        </span>
        {#if showDetail}
            <span class="min-w-0 truncate text-surface-400" data-testid="feed-health-detail"
                >{detail}</span>
        {/if}
        {#if onReset}
            <button
                type="button"
                class="shrink-0 rounded px-1 text-surface-300 underline hover:text-white disabled:opacity-50"
                title={m.admin_livetv_health_reset_tooltip()}
                disabled={busy}
                onclick={reset}>
                {m.admin_livetv_health_reset()}
            </button>
        {/if}
    </div>
{/if}
