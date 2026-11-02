<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy } from 'svelte';
    import type { StageErrorDetail } from '$lib/types/pipeline.js';

    interface Props {
        error: StageErrorDetail;
    }

    const { error }: Props = $props();

    let expanded = $state(false);
    let copied = $state(false);
    let copyResetTimer: ReturnType<typeof setTimeout> | null = null;

    onDestroy(() => {
        if (copyResetTimer !== null) clearTimeout(copyResetTimer);
    });

    async function copyError(): Promise<void> {
        const text = JSON.stringify(error, null, 2);
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
            if (copyResetTimer !== null) clearTimeout(copyResetTimer);
            copyResetTimer = setTimeout(() => {
                copied = false;
                copyResetTimer = null;
            }, 1500);
        } catch {
            // Clipboard unavailable (insecure context / permission) — no-op;
            // the full text is already visible when expanded.
        }
    }
</script>

<div class="flex flex-col gap-1 text-xs">
    <div class="flex flex-wrap items-center gap-2">
        <button
            type="button"
            class="text-left font-medium text-red-400 hover:underline"
            onclick={() => (expanded = !expanded)}
            aria-expanded={expanded}>
            {expanded ? '▾' : '▸'}
            {error.message}
        </button>
        {#if error.code}
            <span class="rounded bg-red-900/40 px-1 py-0.5 font-mono text-[10px] text-red-200">
                {error.code}
            </span>
        {/if}
        {#if error.plugin_id}
            <span class="rounded bg-zinc-700/50 px-1 py-0.5 font-mono text-[10px] text-zinc-300">
                {error.plugin_id}
            </span>
        {/if}
    </div>

    {#if expanded}
        <div class="relative">
            <pre
                class="max-h-64 overflow-auto rounded bg-zinc-900/80 p-2 font-mono text-[11px] text-zinc-300">{JSON.stringify(
                    error,
                    null,
                    2,
                )}</pre>
            <button
                type="button"
                class="absolute right-1 top-1 rounded bg-zinc-700/80 px-1.5 py-0.5 text-[10px] text-zinc-200 hover:bg-zinc-600"
                onclick={() => void copyError()}>
                {copied ? 'Copied' : 'Copy'}
            </button>
        </div>
    {/if}
</div>
