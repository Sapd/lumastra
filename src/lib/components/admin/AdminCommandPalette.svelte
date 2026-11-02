<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { tick } from 'svelte';
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

    interface Props {
        open?: boolean;
        navSections: AdminNavSection[];
        navGate: NavGateContext;
        providerIndex?: ProviderSearchEntry[];
        devFeaturesEnabled?: boolean;
    }
    let {
        open = $bindable(false),
        navSections,
        navGate,
        providerIndex = [],
        devFeaturesEnabled = false,
    }: Props = $props();

    const controller = new CommandPaletteController({
        navSections: () => navSections,
        navGate: () => navGate,
        providerIndex: () => providerIndex,
        devFeaturesEnabled: () => devFeaturesEnabled,
        getRecents,
    });

    let inputEl = $state<HTMLInputElement | null>(null);
    let previouslyFocused: HTMLElement | null = null;

    // Reset + focus when opened.
    $effect(() => {
        if (open) {
            previouslyFocused = document.activeElement as HTMLElement | null;
            controller.reset();
            void tick().then(() => inputEl?.focus());
        }
    });
    // Clamp selection when results shrink.
    $effect(() => {
        void controller.flat;
        controller.clampSelection();
    });

    function close(): void {
        open = false;
        previouslyFocused?.focus();
    }

    async function activate(item: FlatPaletteItem): Promise<void> {
        recordRecent(toRecentEntry(item));
        close();
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
            close();
        } else if (e.key === 'Tab') {
            e.preventDefault();
        }
    }
</script>

{#if open}
    <div
        class="fixed inset-0 z-[100] flex items-start justify-center bg-black/60 pt-[10vh] px-4"
        role="presentation"
        onclick={(e) => {
            if (e.target === e.currentTarget) close();
        }}>
        <div
            class="w-full max-w-xl rounded-xl border border-surface-700 bg-surface-900 shadow-2xl overflow-hidden"
            role="dialog"
            aria-label="Admin command palette">
            <div class="flex items-center gap-2 border-b border-surface-700 px-3">
                <Icon src={MagnifyingGlass} class="w-5 h-5 text-surface-400 shrink-0" />
                <input
                    bind:this={inputEl}
                    bind:value={controller.query}
                    onkeydown={onKeydown}
                    class="w-full bg-transparent py-3 text-sm text-white placeholder:text-surface-500 focus:outline-none"
                    placeholder="Search pages, settings, providers…"
                    aria-label="Search admin" />
            </div>

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
