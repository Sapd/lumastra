<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import { onDestroy, onMount } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { dndzone } from 'svelte-dnd-action';
    import { flip } from 'svelte/animate';
    import { Icon, ChevronUp, ChevronDown, LockClosed } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages';
    import * as userApi from '$lib/api/user';
    import { toasts } from '$lib/stores/toast.store';
    import Toggle from '$lib/components/ui/Toggle.svelte';
    import SettingsGroup from './SettingsGroup.svelte';
    import SavedCue from './SavedCue.svelte';
    import { createAutosave } from './autosave';
    import { moveUp, moveDown } from './widget-reorder';

    interface WidgetConfig {
        id: string;
        name: string;
        visible: boolean;
        adminDisabled?: boolean;
    }
    interface Props {
        widgetOrder?: string[];
        hiddenWidgets?: string[];
        allWidgetIds?: string[];
        adminDisabledWidgets?: string[];
        getWidgetName?: (id: string) => string;
        onwidgetConfigChange?: (d: { widgetOrder: string[]; hiddenWidgets: string[] }) => void;
    }
    let {
        widgetOrder = [],
        hiddenWidgets = [],
        allWidgetIds = [],
        adminDisabledWidgets = [],
        getWidgetName = (id) => id,
        onwidgetConfigChange,
    }: Props = $props();

    const flipMs = 150;
    let liveMessage = $state('');

    function buildList(): WidgetConfig[] {
        const allowed = new Set(allWidgetIds);
        const ordered =
            widgetOrder.length > 0 ? widgetOrder.filter((id) => allowed.has(id)) : allWidgetIds;
        const hidden = new Set(hiddenWidgets);
        const seen = new SvelteSet<string>();
        const list: WidgetConfig[] = [];
        for (const id of ordered) {
            if (!seen.has(id)) {
                seen.add(id);
                list.push({ id, name: getWidgetName(id), visible: !hidden.has(id) });
            }
        }
        for (const id of allWidgetIds) {
            if (!seen.has(id)) {
                seen.add(id);
                list.push({ id, name: getWidgetName(id), visible: !hidden.has(id) });
            }
        }
        for (const id of adminDisabledWidgets) {
            if (!seen.has(id)) {
                seen.add(id);
                list.push({ id, name: getWidgetName(id), visible: false, adminDisabled: true });
            }
        }
        return list;
    }

    let editWidgets = $state<WidgetConfig[]>(buildList());

    function announce(id: string, dir: 'up' | 'down'): void {
        const idx = editWidgets.findIndex((w) => w.id === id);
        const name = editWidgets[idx]?.name ?? id;
        liveMessage = m.settings_home_announce_moved({
            name,
            dir,
            pos: idx + 1,
            total: editWidgets.length,
        });
    }

    function handleMoveUp(id: string): void {
        editWidgets = moveUp(editWidgets, id);
        announce(id, 'up');
        scheduleSave();
    }
    function handleMoveDown(id: string): void {
        editWidgets = moveDown(editWidgets, id);
        announce(id, 'down');
        scheduleSave();
    }

    function onConsider(e: CustomEvent<{ items: WidgetConfig[] }>): void {
        editWidgets = e.detail.items;
    }
    function onFinalize(e: CustomEvent<{ items: WidgetConfig[] }>): void {
        editWidgets = e.detail.items;
        scheduleSave();
    }

    function toggleVisible(id: string): void {
        editWidgets = editWidgets.map((w) => (w.id === id ? { ...w, visible: !w.visible } : w));
        scheduleSave();
    }

    /**
     * Saves on its own, like every other settings page. This page alone used to
     * need an explicit Save button (two of them), so leaving after a reorder
     * silently dropped the change. A short debounce folds a burst of arrow
     * clicks into one request; leaving the page flushes a pending save.
     */
    let savedAt = $state(0);
    const autosave = createAutosave(save);
    const scheduleSave = autosave.schedule;

    // Leaving settings (component teardown) or closing the tab (pagehide) saves
    // a pending edit right away — behind any save already in flight.
    onDestroy(() => void autosave.flush());
    onMount(() => {
        const onPageHide = (): void => void autosave.flush();
        window.addEventListener('pagehide', onPageHide);
        return () => window.removeEventListener('pagehide', onPageHide);
    });

    async function save(): Promise<void> {
        const userWidgets = editWidgets.filter((w) => !w.adminDisabled);
        const newOrder = userWidgets.map((w) => w.id);
        const newHidden = userWidgets.filter((w) => !w.visible).map((w) => w.id);
        try {
            // DB is the canonical store (SSR'd into the home + settings loads).
            // No localStorage cache — persist straight to the API.
            const { error } = await userApi.updateWidgetOrder({
                widgetOrder: newOrder,
                hiddenWidgets: newHidden,
            });
            if (!error) {
                savedAt = Date.now();
                onwidgetConfigChange?.({ widgetOrder: newOrder, hiddenWidgets: newHidden });
            } else {
                toasts.error(m.settings_home_save_error());
            }
        } catch {
            toasts.error(m.settings_home_save_error());
        }
    }
</script>

<div class="sr-only" aria-live="polite">{liveMessage}</div>

<SettingsGroup label={m.settings_home_widgets_label()} description={m.settings_home_intro()}>
    {#snippet actions()}
        <SavedCue {savedAt} />
    {/snippet}
    {#if editWidgets.length === 0}
        <p class="text-sm text-surface-400 py-3 px-4">
            {m.settings_home_no_widgets()}
        </p>
    {:else}
        <div
            use:dndzone={{ items: editWidgets, flipDurationMs: flipMs, type: 'widget-config' }}
            onconsider={onConsider}
            onfinalize={onFinalize}
            class="divide-y divide-surface-700/50">
            {#each editWidgets as widget, i (widget.id)}
                <div animate:flip={{ duration: flipMs }}>
                    {#if widget.adminDisabled}
                        <div class="flex items-center gap-3 py-2.5 px-4 text-surface-500">
                            <Icon src={LockClosed} class="w-4 h-4 shrink-0" />
                            <span class="flex-1 min-w-0 text-sm truncate">{widget.name}</span>
                            <span class="text-xs">{m.settings_home_admin_disabled()}</span>
                        </div>
                    {:else}
                        <div class="widget-row flex items-center gap-1 sm:gap-2 py-2 px-2 sm:px-4">
                            <!-- touch-action:none scoped to the HANDLE only (req #11) -->
                            <span
                                class="drag-handle text-surface-400 select-none cursor-grab px-1"
                                aria-hidden="true">⋮⋮</span>
                            <span
                                class="flex-1 min-w-0 text-sm break-words"
                                class:text-surface-400={!widget.visible}>{widget.name}</span>
                            <button
                                class="btn-icon w-8 h-8 sm:w-9 sm:h-9 variant-ghost-surface shrink-0"
                                aria-label={m.settings_home_move_up({ name: widget.name })}
                                disabled={i === 0}
                                onclick={() => handleMoveUp(widget.id)}>
                                <Icon src={ChevronUp} class="w-4 h-4" />
                            </button>
                            <button
                                class="btn-icon w-8 h-8 sm:w-9 sm:h-9 variant-ghost-surface shrink-0"
                                aria-label={m.settings_home_move_down({ name: widget.name })}
                                disabled={i === editWidgets.length - 1}
                                onclick={() => handleMoveDown(widget.id)}>
                                <Icon src={ChevronDown} class="w-4 h-4" />
                            </button>
                            <div class="shrink-0 pl-1">
                                <Toggle
                                    label={m.settings_home_show({ name: widget.name })}
                                    checked={widget.visible}
                                    onchange={() => toggleVisible(widget.id)} />
                            </div>
                        </div>
                    {/if}
                </div>
            {/each}
        </div>
    {/if}
</SettingsGroup>

<style>
    /* Scope touch-action to the handle so the list still scrolls on touch
       (Footer.svelte:1797 put it on the whole row — spec req #11 fixes that). */
    .drag-handle {
        touch-action: none;
        user-select: none;
    }
</style>
