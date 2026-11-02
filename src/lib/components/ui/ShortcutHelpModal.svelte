<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { ShortcutGroup } from '$lib/stores/shortcuts.svelte';
    import { Icon, XMark } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        open?: boolean;
        groups?: ShortcutGroup[];
    }

    let { open = $bindable(false), groups = [] }: Props = $props();

    let dialogRef = $state<HTMLDialogElement | undefined>(undefined);

    $effect(() => {
        if (open) {
            dialogRef?.showModal();
        } else {
            dialogRef?.close();
        }
    });

    function handleClose() {
        open = false;
    }

    function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape') {
            event.preventDefault();
            handleClose();
        }
    }

    function handleBackdropClick(event: MouseEvent) {
        const rect = dialogRef?.getBoundingClientRect();
        if (!rect) return;
        if (
            event.clientX < rect.left ||
            event.clientX > rect.right ||
            event.clientY < rect.top ||
            event.clientY > rect.bottom
        ) {
            handleClose();
        }
    }
</script>

<dialog
    bind:this={dialogRef}
    class="bg-transparent p-0 backdrop:bg-black/70 backdrop:backdrop-blur-sm"
    onclose={handleClose}
    onkeydown={handleKeydown}
    onclick={handleBackdropClick}>
    <div
        class="bg-surface-900 border border-surface-700 rounded-xl p-6 max-w-lg w-full"
        role="document">
        <div class="flex items-center justify-between mb-4">
            <h2 class="text-xl font-semibold text-white">Keyboard Shortcuts</h2>
            <button
                type="button"
                class="p-1.5 rounded-lg hover:bg-surface-700 text-surface-400 hover:text-white transition-colors"
                onclick={handleClose}
                aria-label={m.btn_close()}>
                <Icon src={XMark} class="w-5 h-5" />
            </button>
        </div>

        {#if groups.length === 0}
            <p class="text-sm text-surface-400">No shortcuts registered for this page.</p>
        {:else}
            <div class="space-y-5">
                {#each groups as group (group.label)}
                    <div>
                        <h3
                            class="text-xs font-medium text-surface-400 uppercase tracking-wider mb-2">
                            {group.label}
                        </h3>
                        <dl class="space-y-1.5">
                            {#each group.entries as entry (entry.description)}
                                <div
                                    class="flex items-center justify-between py-1.5 px-2 rounded hover:bg-surface-800/50 transition-colors">
                                    <dt class="text-sm text-surface-300">
                                        {entry.description}
                                    </dt>
                                    <dd class="flex items-center gap-1">
                                        {#each entry.keys as key, i (key)}
                                            <kbd
                                                class="inline-flex items-center justify-center min-w-[1.5rem] px-1.5 py-0.5 text-xs font-mono font-medium rounded bg-surface-700 text-surface-200 border border-surface-600">
                                                {key}
                                            </kbd>
                                            {#if i < entry.keys.length - 1}
                                                <span class="text-xs text-surface-500">or</span>
                                            {/if}
                                        {/each}
                                    </dd>
                                </div>
                            {/each}
                        </dl>
                    </div>
                {/each}
            </div>
        {/if}
    </div>
</dialog>

<style>
    dialog::backdrop {
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(4px);
    }

    dialog[open] {
        display: flex;
        align-items: center;
        justify-content: center;
        max-width: calc(100vw - 2rem);
        max-height: calc(100dvh - 2rem);
        overflow: visible;
    }

    dialog {
        margin: auto;
    }
</style>
