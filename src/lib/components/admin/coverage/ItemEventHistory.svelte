<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { ItemEventRow } from '$lib/schemas/pipeline-timeline.schema.js';

    interface Props {
        events: ItemEventRow[];
    }

    const { events }: Props = $props();

    function fmt(ts: string): string {
        return new Date(ts).toLocaleString();
    }

    function statusLabel(ev: ItemEventRow): { text: string; cls: string } {
        if (ev.deadLetter) return { text: 'gave up', cls: 'text-red-300' };
        if (ev.consumedAt) return { text: 'handled', cls: 'text-emerald-300' };
        if (ev.nextRetryAt)
            return {
                text: `retry ${fmt(ev.nextRetryAt)}`,
                cls: 'text-amber-300',
            };
        return { text: 'waiting', cls: 'text-zinc-400' };
    }
</script>

<section class="mt-4">
    <h3 class="mb-2 text-sm font-semibold text-zinc-300">Event history</h3>
    {#if events.length === 0}
        <p class="text-xs text-zinc-500">No pipeline events recorded for this item.</p>
    {:else}
        <ol class="space-y-1">
            {#each events as ev (ev.id)}
                {@const status = statusLabel(ev)}
                <li class="flex flex-wrap items-baseline gap-x-3 text-xs">
                    <span class="text-zinc-500 tabular-nums">{fmt(ev.createdAt)}</span>
                    <span class="font-mono text-zinc-300">{ev.eventName}</span>
                    <span class={status.cls}>{status.text}</span>
                    {#if ev.attempts > 0}
                        <span class="text-zinc-600">attempts: {ev.attempts}</span>
                    {/if}
                    {#if ev.lastError}
                        <span class="text-red-400" title={ev.lastError}>
                            {ev.lastError.length > 80
                                ? ev.lastError.slice(0, 80) + '…'
                                : ev.lastError}
                        </span>
                    {/if}
                </li>
            {/each}
        </ol>
    {/if}
</section>
