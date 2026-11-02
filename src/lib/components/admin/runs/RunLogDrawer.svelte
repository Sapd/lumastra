<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  RunLogDrawer — slide-over chrome around RunLogStream.

  Used where there's no detail sidebar to embed into (the /admin/tasks
  pages). RunDetailPanel embeds RunLogStream inline instead of opening this.
-->

<script lang="ts">
    import { fly, fade } from 'svelte/transition';
    import { trapFocus } from '$lib/utils/focus-trap.js';
    import { Z } from '$lib/utils/z-index.js';
    import RunLogStream from './RunLogStream.svelte';

    interface Props {
        runId: string;
        onclose: () => void;
    }

    let { runId, onclose }: Props = $props();

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
                return;
            }
            if (window.getSelection()?.toString()) return;
            e.stopPropagation();
            onclose();
        }
    }
</script>

<div
    class="fixed inset-0 bg-black/50"
    style="z-index: {Z.FLOATING_MODAL}"
    onclick={onclose}
    role="presentation"
    tabindex="-1"
    transition:fade={{ duration: 150 }}>
</div>

<div
    class="fixed right-0 top-0 bottom-0 flex w-[520px] max-w-full flex-col border-l border-surface-700 bg-surface-800"
    style="z-index: {Z.FLOATING_MODAL + 1}"
    transition:fly={{ x: 520, duration: 200 }}
    role="dialog"
    aria-modal="true"
    aria-label="Live run logs"
    tabindex="-1"
    use:trapFocus
    onkeydown={handleKeydown}>
    <div class="flex items-center justify-between border-b border-surface-700 p-4">
        <div class="min-w-0">
            <h3 class="text-base font-medium text-white">Logs</h3>
            <p class="mt-0.5 font-mono text-xs text-surface-500 truncate">
                {runId}
            </p>
        </div>
        <button
            type="button"
            class="p-1 text-surface-400 hover:text-white"
            onclick={onclose}
            data-autofocus
            aria-label="Close log drawer"
            title="Close">
            ✕
        </button>
    </div>

    <div class="flex-1 overflow-hidden p-4">
        <RunLogStream {runId} bodyClass="flex-1" />
    </div>
</div>
