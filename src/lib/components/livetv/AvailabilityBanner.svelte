<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import type { LiveTvAvailability } from '$lib/schemas/livetv-availability.js';
    import * as m from '$lib/paraglide/messages.js';
    let {
        availability,
        readError = false,
        onretry,
    }: { availability?: LiveTvAvailability; readError?: boolean; onretry: () => void } = $props();
    let outage = $derived(availability?.sources.some((s) => s.playback === 'upstream'));
    let service = $derived(availability?.sources.some((s) => s.playback === 'service'));
    let feed = $derived(availability?.sources.some((s) => s.channelFeed.state === 'failed'));
    let guide = $derived(availability?.sources.some((s) => s.guideFeed.state === 'failed'));
    let partial = $derived(availability?.sources.some((s) => s.playback === 'partial'));
</script>

{#if readError || availability?.evidenceUnavailable || outage || service || feed || guide || partial}
    <div
        role="status"
        class="my-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-4 text-sm text-surface-100">
        <div class="flex-1 space-y-1">
            {#if readError}<p>{m.livetv_availability_unknown()}</p>
            {:else if availability?.evidenceUnavailable}<p>
                    {m.livetv_availability_unknown()}
                </p>{/if}
            {#if outage}<p>{m.livetv_availability_outage()}</p>{/if}{#if service}<p>
                    {m.livetv_availability_service()}
                </p>{/if}{#if partial}<p>{m.livetv_availability_partial()}</p>{/if}
            {#if feed && !outage}<p>{m.livetv_availability_feed()}</p>{/if}
            {#if guide}<p>{m.livetv_availability_guide()}</p>{/if}
        </div>
        <button type="button" class="min-h-10 rounded-lg bg-surface-700 px-4" onclick={onretry}
            >{m.common_retry()}</button>
    </div>
{/if}
