<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script module lang="ts">
    import type { LocalizedLabels } from '$lib/shared/localized-label';
    // Common navigation item interface
    export interface NavigationItem {
        id?: string;
        label: string;
        url?: string;
        icon?: string;
        external?: boolean;
        groups?: string[];
        section?: string;
        variant?: string;
        outline?: boolean;
        /** Optional per-language labels; `label` is the fallback. */
        labels?: LocalizedLabels;
    }
</script>

<script lang="ts">
    import { untrack } from 'svelte';
    import { base } from '$app/paths';
    import * as m from '$lib/paraglide/messages';
    import {
        Icon,
        Trash,
        ChevronUp,
        ChevronDown,
        PencilSquare,
        Check,
        XMark,
    } from 'svelte-hero-icons';
    import { navigationIconMap, defaultNavigationIcons } from './navigation-icons';
    import NavigationIconDropdown from './NavigationIconDropdown.svelte';
    import NavigationSectionDropdown from './NavigationSectionDropdown.svelte';
    import NavigationVariantDropdown from './NavigationVariantDropdown.svelte';
    import AddGroupInline from './AddGroupInline.svelte';
    import LocalizedLabelFields from './LocalizedLabelFields.svelte';
    import { cleanLabels } from '$lib/shared/localized-label';

    interface Props {
        item: NavigationItem;
        index: number;
        isFirst?: boolean;
        isLast?: boolean;
        startInEditMode?: boolean;
        sections?: { id: string; label: string; icon?: string }[];
        showSection?: boolean;
        showUrl?: boolean;
        showVariant?: boolean;
        showExternal?: boolean;
        showGroups?: boolean;
        showOutline?: boolean;
        externalLabel?: string;
        availableGroups?: string[];
        availableIcons?: string[];
        suggestedIcons?: string[];
        availableLocalIcons?: string[];
        onupdate?: (detail: NavigationItem) => void;
        ondelete?: () => void;
        oncancel?: () => void;
        onmoveUp?: () => void;
        onmoveDown?: () => void;
        onaddgroup?: (groups: string[]) => void;
    }

    // item.id, item.variant, item.outline are part of NavigationItem interface
    // and pass through via editItem = {...item} and dispatch('update', editItem)

    let {
        item,
        index,
        isFirst = false,
        isLast = false,
        startInEditMode = false,
        sections = [],
        showSection = false,
        showUrl = true,
        showVariant = false,
        showExternal = true,
        showGroups = true,
        showOutline = false,
        externalLabel = 'External (opens in new tab/iframe)',
        availableGroups = [],
        availableIcons = defaultNavigationIcons,
        suggestedIcons = [],
        availableLocalIcons = [],
        onupdate,
        ondelete,
        oncancel,
        onmoveUp,
        onmoveDown,
        onaddgroup,
    }: Props = $props();

    // Plain $state so in-progress edits are not clobbered when a dependency
    // recomputes (a $derived override is discarded on any dependency change).
    // Seeded once from the initial props; the $effect below resyncs from props
    // only while not editing. untrack() makes the initial-capture intent explicit.
    let isEditing = $state(untrack(() => startInEditMode));
    let editItem = $state<NavigationItem>(untrack(() => buildEditItem(item)));
    let urlError = $state(false);

    function buildEditItem(source: NavigationItem): NavigationItem {
        return {
            ...source,
            icon: normalizeOptionalString(source.icon),
            section: normalizeOptionalString(source.section),
            variant: normalizeOptionalString(normalizeVariant(source.variant)),
        };
    }

    // Resync editItem/isEditing from the props ONLY when not actively editing,
    // so a top-level DnD reorder (rebuilds item) or an Add Link toggle
    // (changes startInEditMode) never overwrites an in-progress edit.
    $effect(() => {
        const nextItem = item;
        const nextStartInEditMode = startInEditMode;
        if (!isEditing) {
            editItem = buildEditItem(nextItem);
            isEditing = nextStartInEditMode;
        }
    });

    function normalizeOptionalString(value?: string): string {
        return value ?? '';
    }

    const CUSTOM_ICON_SENTINEL = '__custom__';

    function sanitizeForSave(value?: string): string | undefined {
        const trimmed = value?.trim() ?? '';
        if (trimmed.length === 0 || trimmed === CUSTOM_ICON_SENTINEL) return undefined;
        return trimmed;
    }

    function isValidUrl(value: string): boolean {
        return value.startsWith('/') || /^https?:\/\//.test(value);
    }

    function normalizeDropdownValue(value: unknown): string {
        return typeof value === 'string' ? value : '';
    }

    function startEditing() {
        editItem = buildEditItem(item);
        urlError = false;
        isEditing = true;
    }

    function cancelEditing() {
        editItem = buildEditItem(item);
        urlError = false;
        isEditing = false;
        oncancel?.();
    }

    function saveEditing() {
        const trimmedUrl = editItem.url?.trim() ?? '';
        if (trimmedUrl.length > 0 && !isValidUrl(trimmedUrl)) {
            urlError = true;
            return;
        }
        urlError = false;
        onupdate?.({
            ...editItem,
            label: editItem.label.trim(),
            labels: cleanLabels(editItem.labels),
            url: trimmedUrl.length > 0 ? trimmedUrl : undefined,
            icon: sanitizeForSave(editItem.icon),
            section: sanitizeForSave(editItem.section),
            variant: normalizeVariant(sanitizeForSave(editItem.variant)),
        });
        isEditing = false;
    }

    function handleDelete() {
        if (confirm(m.admin_navigation_item_delete_confirm({ label: item.label }))) {
            ondelete?.();
        }
    }

    function normalizeVariant(variant?: string): string | undefined {
        if (!variant) return variant;
        if (variant === 'ghost-tertiary') return 'ghost-surface';
        return variant;
    }

    function toggleGroup(group: string) {
        const currentGroups = editItem.groups || [];
        let newGroups: string[];
        if (currentGroups.includes(group)) {
            newGroups = currentGroups.filter((g) => g !== group);
        } else {
            newGroups = [...currentGroups, group];
        }
        // Reassign editItem to trigger Svelte reactivity (not just a property)
        editItem = { ...editItem, groups: newGroups };
    }

    // Check if icon is a custom path
    function isCustomIconPath(icon: string | undefined): boolean {
        if (!icon) return false;
        return icon.startsWith('/') || icon.startsWith('http://') || icon.startsWith('https://');
    }

    function isLocalIconPath(icon: string | undefined): boolean {
        if (!icon) return false;
        return availableLocalIcons.includes(icon);
    }

    // Resolve icon path with base path for relative URLs
    function resolveIconPath(icon: string): string {
        // Full URLs don't need modification
        if (icon.startsWith('http://') || icon.startsWith('https://') || icon.startsWith('//')) {
            return icon;
        }
        // Relative paths starting with / need base path prefix
        if (icon.startsWith('/')) {
            return `${base}${icon}`;
        }
        return icon;
    }

    // Custom icon preview with debounce
    let customIconPreview = $state('');
    let customIconDebounceTimer: ReturnType<typeof setTimeout>;
    let customIconError = $state(false);

    function updateCustomIconPreview(value: string) {
        customIconError = false;
        clearTimeout(customIconDebounceTimer);
        if (isCustomIconPath(value)) {
            customIconDebounceTimer = setTimeout(() => {
                customIconPreview = value;
            }, 500);
        } else {
            customIconPreview = '';
        }
    }

    // Reset preview when editing starts; clear it otherwise.
    $effect(() => {
        if (isEditing && editItem.icon && isCustomIconPath(editItem.icon)) {
            customIconPreview = editItem.icon;
            // Reset the error flag when the icon value changes (e.g. the parent
            // rebinds `item` to a different link via DnD). Otherwise a stale
            // load-error from a previous item would paint a spurious red border
            // over the new item's valid icon until it is re-typed; the <img>
            // onerror re-fires if this icon is itself broken.
            customIconError = false;
        } else {
            customIconPreview = '';
            customIconError = false;
        }
        return () => {
            clearTimeout(customIconDebounceTimer);
        };
    });

    // Variant options for footer buttons
    const variantOptions = [
        { value: 'filled-primary', label: 'Filled Primary' },
        { value: 'filled-secondary', label: 'Filled Secondary' },
        { value: 'filled-surface', label: 'Filled Surface' },
        { value: 'ghost-primary', label: 'Ghost Primary' },
        { value: 'ghost-secondary', label: 'Ghost Secondary' },
        { value: 'ghost-surface', label: 'Ghost Surface' },
        { value: 'soft-primary', label: 'Soft Primary' },
        { value: 'soft-surface', label: 'Soft Surface' },
        { value: 'ringed-surface', label: 'Ringed Surface' },
    ];

    const variantGroups = [
        {
            label: 'Filled',
            options: variantOptions.filter((opt) => opt.value.startsWith('filled')),
        },
        {
            label: 'Ghost',
            options: variantOptions.filter((opt) => opt.value.startsWith('ghost')),
        },
        {
            label: 'Soft',
            options: variantOptions.filter((opt) => opt.value.startsWith('soft')),
        },
        {
            label: 'Outline',
            options: variantOptions.filter((opt) => opt.value.startsWith('ringed')),
        },
    ];
</script>

<div
    class="bg-surface-700/30 rounded-lg border border-surface-600/30 p-3 hover:border-surface-500/50 transition-colors">
    {#if isEditing}
        <!-- Edit Mode -->
        <div class="space-y-3">
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <!-- Label -->
                <div>
                    <label for="label-{index}" class="block text-hint mb-1">Label *</label>
                    <input
                        id="label-{index}"
                        type="text"
                        bind:value={editItem.label}
                        class="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm text-surface-200 focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                        placeholder={m.admin_navigation_item_label_placeholder()} />
                </div>

                <!-- URL -->
                {#if showUrl}
                    <div>
                        <label for="url-{index}" class="block text-hint mb-1">URL</label>
                        <input
                            id="url-{index}"
                            type="text"
                            bind:value={editItem.url}
                            oninput={() => {
                                urlError = false;
                            }}
                            class="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm text-surface-200 focus:ring-2 focus:ring-cyan-500 focus:border-transparent {urlError
                                ? 'border-red-500/50'
                                : ''}"
                            placeholder={m.admin_navigation_item_url_placeholder()} />
                        {#if urlError}
                            <p class="text-xs text-red-400 mt-1">
                                {m.admin_navigation_item_url_error()}
                            </p>
                        {/if}
                    </div>
                {/if}
            </div>

            <LocalizedLabelFields
                labels={editItem.labels}
                fallback={editItem.label}
                idPrefix="label-{index}-i18n"
                onchange={(labels) => (editItem = { ...editItem, labels })} />

            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <!-- Icon -->
                <div>
                    <label for="icon-{index}" class="block text-hint mb-1">Icon</label>
                    <div class="flex gap-2 items-center">
                        <!-- Icon preview -->
                        <div
                            class="w-10 h-10 rounded bg-surface-700/50 center text-surface-400 shrink-0 border border-surface-600 {customIconError
                                ? 'border-red-500/50'
                                : ''}">
                            {#if customIconPreview && !customIconError}
                                <img
                                    src={resolveIconPath(customIconPreview)}
                                    alt=""
                                    class="w-5 h-5 object-contain"
                                    onerror={() => {
                                        customIconError = true;
                                    }} />
                            {:else if editItem.icon && navigationIconMap[editItem.icon]}
                                <Icon src={navigationIconMap[editItem.icon]} class="w-5 h-5" />
                            {:else if editItem.icon === '__custom__'}
                                <span class="text-[10px] text-surface-500">URL</span>
                            {:else}
                                <span class="text-[10px] text-surface-600">—</span>
                            {/if}
                        </div>
                        <NavigationIconDropdown
                            bind:value={editItem.icon}
                            {availableIcons}
                            {suggestedIcons}
                            {availableLocalIcons}
                            onChange={(nextValue) => {
                                customIconError = false;
                                const normalized = normalizeDropdownValue(nextValue);
                                customIconPreview = isCustomIconPath(normalized) ? normalized : '';
                            }} />
                    </div>
                    {#if editItem.icon === '__custom__' || (isCustomIconPath(editItem.icon) && !isLocalIconPath(editItem.icon))}
                        <div class="mt-2">
                            <input
                                type="text"
                                value={editItem.icon === '__custom__' ? '' : editItem.icon}
                                oninput={(e) => {
                                    const newIcon = e.currentTarget.value;
                                    editItem = { ...editItem, icon: newIcon };
                                    updateCustomIconPreview(newIcon);
                                }}
                                class="w-full px-3 py-2 bg-surface-800 border border-surface-600 rounded-lg text-sm text-surface-200 focus:ring-2 focus:ring-cyan-500 {customIconError
                                    ? 'border-red-500/50'
                                    : ''}"
                                placeholder={m.admin_navigation_item_icon_placeholder()} />
                            {#if customIconError}
                                <p class="text-xs text-red-400 mt-1">
                                    {m.admin_navigation_item_icon_load_error()}
                                </p>
                            {/if}
                        </div>
                    {/if}
                </div>

                <!-- Section (for sidebar) -->
                {#if showSection && sections.length > 0}
                    <div>
                        <label for="section-{index}" class="block text-hint mb-1">Section</label>
                        <NavigationSectionDropdown
                            bind:value={editItem.section}
                            {sections}
                            onChange={(nextValue) => {
                                editItem = {
                                    ...editItem,
                                    section: normalizeDropdownValue(nextValue),
                                };
                            }} />
                    </div>
                {/if}

                <!-- Variant (for footer) -->
                {#if showVariant}
                    <div>
                        <label for="variant-{index}" class="block text-hint mb-1">Style</label>
                        <NavigationVariantDropdown
                            bind:value={editItem.variant}
                            groups={variantGroups}
                            onChange={(nextValue) => {
                                editItem = {
                                    ...editItem,
                                    variant: normalizeDropdownValue(nextValue),
                                };
                            }} />
                    </div>
                {/if}
            </div>

            <!-- Toggles -->
            <div class="flex flex-wrap gap-4">
                {#if showExternal}
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            bind:checked={editItem.external}
                            class="w-4 h-4 rounded bg-surface-800 border-surface-600 text-cyan-500 focus:ring-cyan-500" />
                        <span class="text-sm text-surface-300">{externalLabel}</span>
                    </label>
                {/if}

                {#if showOutline}
                    <label class="flex items-center gap-2 cursor-pointer">
                        <input
                            type="checkbox"
                            bind:checked={editItem.outline}
                            class="w-4 h-4 rounded bg-surface-800 border-surface-600 text-cyan-500 focus:ring-cyan-500" />
                        <span class="text-sm text-surface-300"
                            >{m.admin_navigation_item_outline_label()}</span>
                    </label>
                {/if}
            </div>

            <!-- Groups -->
            {#if showGroups && availableGroups.length > 0}
                <div role="group" aria-label={m.admin_navigation_item_groups_label()}>
                    <span class="block text-hint mb-1"
                        >{m.admin_navigation_item_groups_label()}</span>
                    <div class="flex flex-wrap gap-2">
                        {#each availableGroups as group (group)}
                            <button
                                type="button"
                                class="px-2 py-1 text-xs rounded-full transition-colors {(
                                    editItem.groups || []
                                ).includes(group)
                                    ? 'bg-cyan-500/30 text-cyan-300 border border-cyan-500/50'
                                    : 'bg-surface-700 text-surface-400 border border-surface-600 hover:border-surface-500'}"
                                onclick={() => toggleGroup(group)}>
                                {group}
                            </button>
                        {/each}
                        <button
                            type="button"
                            class="px-2 py-1 text-xs rounded-full transition-colors {(
                                editItem.groups || []
                            ).includes('__ADMIN__')
                                ? 'bg-yellow-500/30 text-yellow-300 border border-yellow-500/50'
                                : 'bg-surface-700 text-surface-400 border border-surface-600 hover:border-surface-500'}"
                            onclick={() => toggleGroup('__ADMIN__')}>
                            {m.admin_navigation_item_admin_only()}
                        </button>
                    </div>
                </div>
            {/if}
            {#if showGroups && onaddgroup}
                <AddGroupInline {availableGroups} onadded={onaddgroup} />
            {/if}

            <!-- Action buttons -->
            <div class="flex justify-end gap-2 pt-2 border-t border-surface-700">
                <button
                    type="button"
                    class="px-3 py-1.5 text-sm text-surface-400 hover:text-white transition-colors"
                    onclick={cancelEditing}>
                    {m.admin_navigation_item_cancel()}
                </button>
                <button
                    type="button"
                    class="px-3 py-1.5 text-sm bg-cyan-500 hover:bg-cyan-400 text-surface-900 font-medium rounded-lg transition-colors flex items-center gap-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    onclick={saveEditing}
                    disabled={!editItem.label?.trim() ||
                        (!!editItem.url?.trim() && !isValidUrl(editItem.url.trim()))}>
                    <Icon src={Check} class="w-4 h-4" />
                    {m.admin_navigation_item_save()}
                </button>
            </div>
        </div>
    {:else}
        <!-- View Mode -->
        <div class="flex items-center gap-3">
            <!-- Reorder buttons -->
            <div class="flex flex-col gap-0.5">
                <button
                    type="button"
                    class="p-1 text-surface-500 hover:text-surface-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    disabled={isFirst}
                    onclick={() => onmoveUp?.()}
                    aria-label={m.admin_navigation_item_move_up({ label: item.label })}>
                    <Icon src={ChevronUp} class="w-4 h-4" />
                </button>
                <button
                    type="button"
                    class="p-1 text-surface-500 hover:text-surface-300 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                    disabled={isLast}
                    onclick={() => onmoveDown?.()}
                    aria-label={m.admin_navigation_item_move_down({ label: item.label })}>
                    <Icon src={ChevronDown} class="w-4 h-4" />
                </button>
            </div>

            <!-- Icon display -->
            {#if item.icon}
                <div class="w-8 h-8 rounded bg-surface-700/50 center text-surface-400 shrink-0">
                    {#if isCustomIconPath(item.icon)}
                        <img
                            src={resolveIconPath(item.icon)}
                            alt=""
                            class="w-5 h-5 object-contain" />
                    {:else if navigationIconMap[item.icon]}
                        <Icon src={navigationIconMap[item.icon]} class="w-5 h-5" />
                    {:else}
                        <span class="text-[10px]">{item.icon.substring(0, 3)}</span>
                    {/if}
                </div>
            {/if}

            <!-- Item info -->
            <div class="flex-1 min-w-0">
                <div class="flex items-center gap-2">
                    <span class="font-medium text-surface-200 truncate">{item.label}</span>
                </div>
                {#if item.url}
                    <div class="text-caption truncate">{item.url}</div>
                {/if}
                {#if item.groups && item.groups.length > 0}
                    <div class="flex gap-1 mt-1">
                        {#each item.groups as group (group)}
                            <span
                                class="px-1.5 py-0.5 text-[10px] rounded bg-surface-600 text-surface-300">
                                {group === '__ADMIN__'
                                    ? m.admin_navigation_item_admin_only()
                                    : group}
                            </span>
                        {/each}
                    </div>
                {/if}
            </div>

            <!-- Badges -->
            <div class="flex items-center gap-2">
                {#if item.external}
                    <span class="badge badge-info"> External </span>
                {/if}
                {#if item.section}
                    <span class="badge badge-purple">
                        {item.section}
                    </span>
                {/if}
            </div>

            <!-- Actions -->
            <div class="flex items-center gap-1">
                <button
                    type="button"
                    class="p-2 text-surface-400 hover:text-cyan-400 transition-colors rounded-lg hover:bg-surface-600/50"
                    onclick={startEditing}
                    aria-label={m.admin_navigation_item_edit({ label: item.label })}>
                    <Icon src={PencilSquare} class="w-4 h-4" />
                </button>
                <button
                    type="button"
                    class="p-2 text-surface-400 hover:text-red-400 transition-colors rounded-lg hover:bg-surface-600/50"
                    onclick={handleDelete}
                    aria-label={m.admin_navigation_item_delete({ label: item.label })}>
                    <Icon src={Trash} class="w-4 h-4" />
                </button>
            </div>
        </div>
    {/if}
</div>
