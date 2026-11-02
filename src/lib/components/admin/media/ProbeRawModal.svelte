<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { Z } from '$lib/utils/z-index';

    interface Props {
        filePath: string;
        probeData: Record<string, unknown>;
        onClose: () => void;
    }

    let { filePath, probeData, onClose }: Props = $props();

    const formatted = $derived(JSON.stringify(probeData, null, 2));

    function handleBackdropClick(e: MouseEvent): void {
        if (e.target === e.currentTarget) onClose();
    }

    function handleKeydown(e: KeyboardEvent): void {
        if (e.key === 'Escape') onClose();
    }

    async function copyToClipboard(): Promise<void> {
        await navigator.clipboard.writeText(formatted);
    }
</script>

<svelte:window onkeydown={handleKeydown} />

<div
    role="presentation"
    class="fixed inset-0 flex items-center justify-center bg-black/70 backdrop-blur-sm"
    style="z-index: {Z.MODAL}"
    onclick={handleBackdropClick}>
    <div
        class="bg-surface-900 border border-surface-700 rounded-xl shadow-2xl w-[90vw] max-w-4xl max-h-[85vh] flex flex-col">
        <!-- Header -->
        <div class="flex items-center justify-between px-5 py-3 border-b border-surface-700">
            <div class="min-w-0">
                <h2 class="text-base font-semibold text-white">{m.media_plain_probe_output()}</h2>
                <p class="text-xs text-surface-400 truncate mt-0.5" title={filePath}>
                    {filePath}
                </p>
            </div>
            <div class="flex items-center gap-2 shrink-0 ml-4">
                <button class="btn btn-sm variant-soft-surface text-xs" onclick={copyToClipboard}>
                    Copy
                </button>
                <button class="btn btn-sm variant-ghost-surface text-xs" onclick={onClose}>
                    {m.media_plain_close()}
                </button>
            </div>
        </div>

        <!-- Body -->
        <div class="overflow-auto flex-1 p-4">
            <pre
                class="text-xs font-mono text-surface-200 whitespace-pre-wrap break-words">{formatted}</pre>
        </div>
    </div>
</div>
