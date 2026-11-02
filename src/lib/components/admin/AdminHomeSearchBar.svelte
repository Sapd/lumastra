<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { tick } from 'svelte';
    import { fade, slide } from 'svelte/transition';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import { Icon, MagnifyingGlass } from 'svelte-hero-icons';
    import type { AdminNavSection, NavGateContext } from '$lib/config/admin-nav';
    import type { ProviderSearchEntry } from '$lib/utils/admin/settings-search';
    import {
        CommandPaletteController,
        toRecentEntry,
        type FlatPaletteItem,
    } from '$lib/utils/admin/use-command-palette.svelte';
    import { getRecents, recordRecent } from '$lib/utils/admin/command-palette-recents';
    import AdminCommandResultsList from '$lib/components/admin/AdminCommandResultsList.svelte';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        navSections: AdminNavSection[];
        navGate: NavGateContext;
        providerIndex?: ProviderSearchEntry[];
        devFeaturesEnabled?: boolean;
    }
    let { navSections, navGate, providerIndex = [], devFeaturesEnabled = false }: Props = $props();

    const controller = new CommandPaletteController({
        navSections: () => navSections,
        navGate: () => navGate,
        providerIndex: () => providerIndex,
        devFeaturesEnabled: () => devFeaturesEnabled,
        getRecents,
    });

    let expanded = $state(false);
    let triggerEl = $state<HTMLButtonElement | null>(null);
    let inputEl = $state<HTMLInputElement | null>(null);

    // Clamp selection when results shrink (same pattern as AdminCommandPalette).
    $effect(() => {
        void controller.flat;
        controller.clampSelection();
    });

    function expand(): void {
        if (expanded) return;
        expanded = true;
        controller.reset();
        void tick().then(() => inputEl?.focus());
    }

    function collapse(): void {
        expanded = false;
        triggerEl?.focus();
    }

    /** Imperative API for the admin home page's `/` shortcut handler. */
    export function focusAndExpand(): void {
        triggerEl?.scrollIntoView({ behavior: 'smooth', block: 'center' });
        expand();
    }

    async function activate(item: FlatPaletteItem): Promise<void> {
        recordRecent(toRecentEntry(item));
        collapse();
        try {
            await goto(resolve(item.href));
        } catch {
            /* navigation interrupted/aborted — ignore */
        }
    }

    function onKeydown(e: KeyboardEvent): void {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            controller.moveSelection(1);
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            controller.moveSelection(-1);
        } else if (e.key === 'Enter') {
            e.preventDefault();
            const item = controller.itemAt();
            if (item) void activate(item);
        } else if (e.key === 'Escape') {
            e.preventDefault();
            collapse();
        } else if (e.key === 'Tab') {
            e.preventDefault();
        }
    }
</script>

<div class="relative z-50">
    <button
        bind:this={triggerEl}
        type="button"
        data-testid="admin-home-search-trigger"
        class="flex w-full items-center gap-2 rounded-full border border-surface-700/60 bg-surface-800/60 px-4 py-2.5 text-left text-sm text-surface-400 transition-colors hover:border-surface-600 hover:text-surface-300"
        onclick={expand}>
        <Icon src={MagnifyingGlass} class="w-4 h-4 shrink-0" />
        <span class="flex-1 truncate">{m.admin_home_search_placeholder()}</span>
        <kbd
            class="inline-flex items-center justify-center min-w-[1.25rem] px-1 py-0.5 text-xs font-mono rounded bg-surface-900 border border-surface-600 text-surface-500">
            /
        </kbd>
    </button>

    {#if expanded}
        <div
            class="fixed inset-0 z-40 bg-black/60"
            role="presentation"
            transition:fade={{ duration: 150 }}
            onclick={collapse}>
        </div>

        <div
            class="absolute inset-x-0 top-0 z-50 overflow-hidden rounded-xl border border-surface-700 bg-surface-900 shadow-2xl"
            role="dialog"
            aria-label={m.admin_home_search_dialog_label()}>
            <div
                class="flex items-center gap-2 border-b border-surface-700 px-4 ring-2 ring-sky-500/40">
                <Icon src={MagnifyingGlass} class="w-5 h-5 text-surface-400 shrink-0" />
                <input
                    bind:this={inputEl}
                    bind:value={controller.query}
                    onkeydown={onKeydown}
                    class="w-full bg-transparent py-3.5 text-sm text-white placeholder:text-surface-500 focus:outline-none"
                    placeholder={m.admin_home_search_placeholder()}
                    aria-label={m.admin_home_search_input_label()} />
            </div>

            <div transition:slide={{ duration: 200 }}>
                <AdminCommandResultsList
                    recents={controller.recents}
                    results={controller.results}
                    flat={controller.flat}
                    selectedIndex={controller.selectedIndex}
                    pagesOffset={controller.pagesOffset}
                    settingsOffset={controller.settingsOffset}
                    providersOffset={controller.providersOffset}
                    onhoverindex={(i) => (controller.selectedIndex = i)}
                    onactivate={(item) => void activate(item)} />
            </div>
        </div>
    {/if}
</div>
