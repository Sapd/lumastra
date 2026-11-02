<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { untrack } from 'svelte';
    import * as m from '$lib/paraglide/messages';
    import { slide } from 'svelte/transition';
    import { flip } from 'svelte/animate';
    import { dndzone } from 'svelte-dnd-action';
    import { apiPost } from '$lib/api/client.js';
    import { HomepageResetWidgetsResponseSchema } from '$lib/schemas/api-admin-navigation.js';
    import {
        Icon,
        ChevronDown,
        Bars3,
        InformationCircle,
        LockClosed,
        ExclamationTriangle,
        // Widget icons
        Users,
        Tv,
        Sparkles,
        ChartBar,
        Fire,
        Gift,
        CpuChip,
        Bookmark,
        Calendar,
        CalendarDays,
        PuzzlePiece,
        ArrowPath,
        type IconSource,
    } from 'svelte-hero-icons';
    import {
        WIDGET_DEFINITIONS,
        featureKeyForFlag,
        type WidgetDefinition,
        type WidgetVisibility,
        type WidgetVisibilityMap,
    } from '$lib/config/schema';
    import ActionButton from './ActionButton.svelte';
    import ActionModal from './ActionModal.svelte';
    import { toasts } from '$lib/stores/toast.store';

    interface Props {
        // Props
        widgetOrder?: string[];
        widgetVisibility?: WidgetVisibilityMap;
        featureFlags?: Record<string, boolean>;
        /**
         * Plugin-contributed widgets (id `plugin:<featureId>:<widgetId>`), so they
         * are reorderable/hideable here alongside built-ins. Generic — any current
         * or future feature plugin's widgets flow in via this list.
         */
        pluginWidgets?: { id: string; label: string }[];
        envOverrides?: {
            widgetOrder?: boolean;
            widgetVisibility?: boolean;
        };
        collapsed?: boolean;
        // Callbacks
        onchange?: (detail: {
            widgetOrder: string[];
            widgetVisibility: WidgetVisibilityMap;
        }) => void;
    }

    let {
        widgetOrder = $bindable([]),
        widgetVisibility = $bindable({}),
        featureFlags = {},
        pluginWidgets = [],
        envOverrides = {},
        collapsed = $bindable(false),
        onchange,
    }: Props = $props();

    // Icon mapping
    const iconMap: Record<string, IconSource> = {
        users: Users,
        tv: Tv,
        sparkles: Sparkles,
        'chart-bar': ChartBar,
        fire: Fire,
        gift: Gift,
        'cpu-chip': CpuChip,
        bookmark: Bookmark,
        calendar: Calendar,
        'calendar-days': CalendarDays,
        'puzzle-piece': PuzzlePiece,
    };

    // Build ordered widget list with definitions
    interface WidgetItem {
        id: string;
        definition: WidgetDefinition;
    }

    function buildWidgetItems(): WidgetItem[] {
        // Synthesize a definition for each plugin widget (id not already a
        // built-in) so plugin widgets are configurable like the rest. Generic:
        // covers the shoutbox and any future feature-plugin widget.
        const pluginDefs: WidgetDefinition[] = pluginWidgets
            .filter(
                (pw) =>
                    pw &&
                    pw.id &&
                    !WIDGET_DEFINITIONS.some((d) => d.id === (pw.id as WidgetDefinition['id'])),
            )
            .map((pw) => ({
                id: pw.id as WidgetDefinition['id'],
                label: pw.label || pw.id,
                icon: 'puzzle-piece',
            }));
        const allDefs = [...WIDGET_DEFINITIONS, ...pluginDefs];
        const definitionMap = new Map<string, WidgetDefinition>(allDefs.map((d) => [d.id, d]));

        const items: WidgetItem[] = [];
        const seen: Record<string, boolean> = {};

        // Add widgets in the current saved order (built-in or plugin).
        for (const id of widgetOrder) {
            const def = definitionMap.get(id);
            if (def && !seen[id]) {
                items.push({ id, definition: def });
                seen[id] = true;
            }
        }

        // Add any not-yet-ordered widgets (built-in + plugin) at the end.
        for (const def of allDefs) {
            if (!seen[def.id]) {
                items.push({ id: def.id, definition: def });
                seen[def.id] = true;
            }
        }

        return items;
    }

    let widgets = $state(buildWidgetItems());
    const flipDurationMs = 200;

    // Follow the order the parent holds. The list used to be built once, so
    // Discard (or a reload) reverted the saved order while the list kept
    // showing the dragged one. Only order changes from outside rebuild it: a
    // drag in progress changes `widgets`, not `widgetOrder`.
    $effect(() => {
        void widgetOrder;
        void pluginWidgets;
        untrack(() => {
            const next = buildWidgetItems();
            const ids = (list: WidgetItem[]): string => list.map((w) => w.id).join('\n');
            if (ids(next) !== ids(widgets)) widgets = next;
        });
    });

    // DnD handlers
    function handleDndConsider(e: CustomEvent<{ items: WidgetItem[] }>) {
        widgets = e.detail.items;
    }

    function handleDndFinalize(e: CustomEvent<{ items: WidgetItem[] }>) {
        widgets = e.detail.items;
        widgetOrder = widgets.map((w) => w.id);
        emitChange();
    }

    // Visibility helpers
    function getVisibility(widgetId: string): WidgetVisibility {
        return widgetVisibility[widgetId] || 'visible';
    }

    function setVisibility(widgetId: string, visibility: WidgetVisibility) {
        if (visibility === 'visible') {
            // Remove from map (default is visible)
            const { [widgetId]: _, ...rest } = widgetVisibility;
            widgetVisibility = rest;
        } else {
            widgetVisibility = { ...widgetVisibility, [widgetId]: visibility };
        }
        emitChange();
    }

    function handleVisibilityChange(widgetId: string, event: Event) {
        const target = event.target as HTMLSelectElement;
        setVisibility(widgetId, target.value as WidgetVisibility);
    }

    // Check if widget is disabled by feature flag.
    //
    // Uses the shared derivation rather than a local map. The map that used to
    // live here listed five flags while the home page's own list covered four,
    // and `trending` was the one only this side knew about — so the editor
    // greyed the widget out while the home page happily rendered it.
    function isFeatureFlagDisabled(widget: WidgetDefinition): boolean {
        if (!widget.featureFlag) return false;
        const featureKey = featureKeyForFlag(widget.featureFlag);
        if (featureKey in featureFlags) {
            return featureFlags[featureKey] === false;
        }
        return false;
    }

    function emitChange() {
        onchange?.({
            widgetOrder,
            widgetVisibility,
        });
    }

    function toggleCollapsed() {
        collapsed = !collapsed;
    }

    // --- Reset all users to admin defaults ---------------------------------
    let showResetModal = $state(false);

    async function confirmReset(): Promise<void> {
        try {
            const { data, error } = await apiPost(
                '/api/admin/homepage/reset-widgets',
                HomepageResetWidgetsResponseSchema,
                undefined,
            );
            if (error) {
                toasts.error(m.admin_homepage_reset_error());
                return;
            }
            const count = Number(data?.resetCount) || 0;
            toasts.success(m.admin_homepage_reset_success({ count }));
        } finally {
            showResetModal = false;
        }
    }

    let isEnvOverridden = $derived(envOverrides.widgetOrder || envOverrides.widgetVisibility);

    // Visibility options
    const visibilityOptions: {
        value: WidgetVisibility;
        label: string;
        description: string;
    }[] = [
        { value: 'visible', label: 'Visible', description: 'Shown by default' },
        {
            value: 'hidden',
            label: 'Hidden',
            description: 'Hidden by default, users can enable',
        },
        {
            value: 'disabled',
            label: 'Disabled',
            description: 'Force off, users cannot enable',
        },
    ];
</script>

<div class="section-card card-glass border border-surface-700 overflow-hidden !p-0">
    <!-- Section Header -->
    <button
        type="button"
        class="w-full between p-4 text-left hover:bg-surface-700/30 transition-colors"
        onclick={toggleCollapsed}
        aria-expanded={!collapsed}>
        <div class="flex items-center gap-3">
            <Icon
                src={ChevronDown}
                class="w-5 h-5 text-surface-400 transition-transform {collapsed
                    ? '-rotate-90'
                    : ''}" />
            <div>
                <h3 class="text-base font-medium text-surface-200">Homepage Widgets</h3>
                <p class="text-hint mt-0.5">Configure widget order and visibility for users</p>
            </div>
        </div>
        <span class="text-caption">{widgets.length} widgets</span>
    </button>

    <!-- Section Content -->
    {#if !collapsed}
        <div class="px-4 pb-4 border-t border-surface-700/50" transition:slide={{ duration: 200 }}>
            <!-- ENV Override Warning -->
            {#if isEnvOverridden}
                <div class="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 mt-4 mb-4">
                    <div class="flex gap-2">
                        <Icon
                            src={InformationCircle}
                            class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                        <p class="text-xs text-blue-300">
                            Widget configuration is currently overridden by an environment variable.
                            Changes made here will be saved to the config file, but the ENV variable
                            takes priority at runtime.
                        </p>
                    </div>
                </div>
            {/if}

            <!-- Instructions -->
            <p class="text-caption mt-4 mb-3">
                Drag widgets to reorder. Set visibility to control what users see by default.
            </p>

            <!-- Widget List -->
            <div
                class="space-y-2"
                use:dndzone={{
                    items: widgets,
                    flipDurationMs,
                    type: 'widgets',
                }}
                onconsider={handleDndConsider}
                onfinalize={handleDndFinalize}>
                {#each widgets as widget (widget.id)}
                    {@const featureDisabled = isFeatureFlagDisabled(widget.definition)}
                    {@const visibility = getVisibility(widget.id)}
                    <div
                        class="flex items-center gap-3 bg-surface-700/30 rounded-lg p-3 {featureDisabled
                            ? 'opacity-50'
                            : ''}"
                        animate:flip={{ duration: flipDurationMs }}>
                        <!-- Drag Handle -->
                        <div
                            class="cursor-grab text-surface-500 hover:text-surface-300 active:cursor-grabbing">
                            <Icon src={Bars3} class="w-4 h-4" />
                        </div>

                        <!-- Icon -->
                        <div
                            class="w-8 h-8 rounded bg-surface-700/50 center text-surface-400 shrink-0">
                            {#if iconMap[widget.definition.icon]}
                                <Icon src={iconMap[widget.definition.icon]} class="w-4 h-4" />
                            {:else}
                                <Icon src={Sparkles} class="w-4 h-4" />
                            {/if}
                        </div>

                        <!-- Widget Info -->
                        <div class="flex-1 min-w-0">
                            <div class="flex items-center gap-2">
                                <span class="text-sm font-medium text-surface-200"
                                    >{widget.definition.label}</span>
                                {#if widget.definition.permissionNote}
                                    <span
                                        class="px-1.5 py-0.5 text-[10px] bg-amber-500/20 text-amber-400 rounded flex items-center gap-1">
                                        <Icon src={ExclamationTriangle} class="w-3 h-3" />
                                        {widget.definition.permissionNote}
                                    </span>
                                {/if}
                            </div>
                            {#if featureDisabled}
                                <p class="text-xs text-red-400/70 flex items-center gap-1 mt-0.5">
                                    <Icon src={LockClosed} class="w-3 h-3" />
                                    Disabled by {widget.definition.featureFlag}
                                </p>
                            {/if}
                        </div>

                        <!-- Visibility Dropdown -->
                        <div class="shrink-0">
                            {#if featureDisabled}
                                <div
                                    class="px-3 py-1.5 bg-surface-800/50 text-surface-500 text-sm rounded-lg border border-surface-700 flex items-center gap-1">
                                    <Icon src={LockClosed} class="w-3 h-3" />
                                    Feature Off
                                </div>
                            {:else}
                                <select
                                    value={visibility}
                                    onchange={(e) => handleVisibilityChange(widget.id, e)}
                                    class="px-3 py-1.5 bg-surface-800 border border-surface-600 rounded-lg text-sm text-surface-200 cursor-pointer
										{visibility === 'visible' ? 'text-green-400' : ''}
										{visibility === 'hidden' ? 'text-amber-400' : ''}
										{visibility === 'disabled' ? 'text-red-400' : ''}">
                                    {#each visibilityOptions as option (option.value)}
                                        <option value={option.value}>{option.label}</option>
                                    {/each}
                                </select>
                            {/if}
                        </div>
                    </div>
                {/each}
            </div>

            <!-- Legend -->
            <div class="mt-4 bg-surface-800/30 rounded-lg p-3">
                <p class="text-hint font-medium mb-2">Visibility Legend:</p>
                <div class="flex flex-wrap gap-4 text-caption">
                    <div class="flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full bg-green-500"></span>
                        <span>Visible</span>
                        <span class="text-caption">- Shown by default</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full bg-amber-500"></span>
                        <span>{m.admin_livetv_backup_group_hidden()}</span>
                        <span class="text-caption">- Users can enable</span>
                    </div>
                    <div class="flex items-center gap-1.5">
                        <span class="w-2 h-2 rounded-full bg-red-500"></span>
                        <span>{m.player_forced_disabled()}</span>
                        <span class="text-caption">- Force off</span>
                    </div>
                </div>
            </div>

            <!-- Reset all users -->
            <div
                class="mt-4 flex items-center justify-between gap-3 flex-wrap bg-surface-800/30 rounded-lg p-3">
                <p class="text-caption flex-1 min-w-[12rem]">
                    {m.admin_homepage_reset_modal_body()}
                </p>
                <ActionButton
                    variant="danger"
                    size="sm"
                    icon={ArrowPath}
                    onclick={() => (showResetModal = true)}>
                    {m.admin_homepage_reset_button()}
                </ActionButton>
            </div>

            <!-- Help Info -->
            <div class="bg-blue-500/10 border border-blue-500/30 rounded-lg p-3 mt-4">
                <div class="flex gap-2">
                    <Icon src={InformationCircle} class="w-4 h-4 text-blue-400 shrink-0 mt-0.5" />
                    <div class="text-xs text-blue-300 space-y-1">
                        <p><strong>Notes:</strong></p>
                        <ul class="list-disc list-inside space-y-0.5">
                            <li>
                                <strong>Visible:</strong> Widget shown by default, users can hide it
                            </li>
                            <li>
                                <strong>Hidden:</strong> Widget hidden by default, users can enable it
                            </li>
                            <li>
                                <strong>Disabled:</strong> Widget completely disabled - users cannot enable
                                it and API routes return empty data
                            </li>
                            <li>
                                Greyed-out widgets have their feature flag disabled and won't appear
                                regardless of this setting
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    {/if}
</div>

{#if showResetModal}
    <ActionModal
        title={m.admin_homepage_reset_modal_title()}
        confirmText={m.admin_homepage_reset_confirm()}
        confirmColor="red"
        onclose={() => (showResetModal = false)}
        onconfirm={confirmReset}>
        <p class="text-sm text-surface-300">{m.admin_homepage_reset_modal_body()}</p>
    </ActionModal>
{/if}
