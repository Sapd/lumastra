<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Sidebar names, icons, visibility and order for the non-entertainment library
  types (home videos, training, educational, personal).

  Lives with the navigation settings: it configures the SIDEBAR, not any
  library. It used to be a tab on Library → Sources, where it was the one thing
  on the page that was not about where media comes from (library sources
  restructure spec, 2026-09-27, step 6). Loads its own data so it can be
  mounted anywhere.
-->
<script lang="ts">
    import { onMount } from 'svelte';
    import { Icon } from 'svelte-hero-icons';
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store';
    import { getErrorMessage } from '$lib/utils/error-handling';
    import {
        getLibraryTypeSettings,
        upsertLibraryTypeSetting,
        getLibraryPaths,
    } from '$lib/api/admin';
    import NavigationIconDropdown from '$lib/components/admin/navigation/NavigationIconDropdown.svelte';
    import {
        defaultNavigationIcons,
        navigationIconMap,
    } from '$lib/components/admin/navigation/navigation-icons';
    import { getLibraryTypeTemplate } from '$lib/shared/library-type-templates';

    /** Only what the usage count needs from a library path. */
    interface PathTypeRef {
        mediaType: string;
        libraryGroupId: string;
    }

    let paths = $state<PathTypeRef[]>([]);

    interface LibraryTypeSettingRow {
        media_type: string;
        display_name: string | null;
        sidebar_visible: boolean;
        icon: string | null;
        sort_order: number;
    }

    let typeSettings = $state<LibraryTypeSettingRow[]>([]);
    let typeSettingsLoading = $state(false);
    let typeSettingsLoaded = $state(false);
    let typeSettingsError = $state<string | null>(null);

    const NON_ENT_TYPES = ['home_video', 'training', 'educational', 'personal'] as const;

    // Editable $state array — every NON_ENT_TYPE row is always present as a real proxy.
    // Read-only derived kept for reference but inputs are bound to typeSettingsEditable.
    let typeSettingsEditable = $state<LibraryTypeSettingRow[]>([]);

    function defaultTypeRow(mt: string): LibraryTypeSettingRow {
        return {
            media_type: mt,
            display_name: null,
            sidebar_visible: true,
            icon: null,
            sort_order: 0,
        };
    }

    function buildEditableRows(apiRows: LibraryTypeSettingRow[]): LibraryTypeSettingRow[] {
        const map = new Map(apiRows.map((s) => [s.media_type, s]));
        return NON_ENT_TYPES.map((mt) => ({ ...(map.get(mt) ?? defaultTypeRow(mt)) }));
    }

    /** The human name the sidebar shows when no display name is set. */
    function typeDefaultLabel(mt: string): string {
        return (
            getLibraryTypeTemplate(mt)?.label ??
            mt.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
        );
    }

    /**
     * How many libraries hold paths of this type. These settings only reach the
     * sidebar once a library of the type exists, so an operator editing an
     * unused type should know the change will not show anywhere yet.
     */
    function typeUsageCount(mt: string): number {
        const groupIds = paths.filter((p) => p.mediaType === mt).map((p) => p.libraryGroupId);
        return groupIds.filter((id, i) => groupIds.indexOf(id) === i).length;
    }

    function isTypeRowDirty(row: LibraryTypeSettingRow): boolean {
        const saved =
            typeSettings.find((s) => s.media_type === row.media_type) ??
            defaultTypeRow(row.media_type);
        const norm = (v: string | null | undefined): string | null => v?.trim() || null;
        return (
            norm(row.display_name) !== norm(saved.display_name) ||
            norm(row.icon) !== norm(saved.icon) ||
            row.sidebar_visible !== saved.sidebar_visible ||
            row.sort_order !== saved.sort_order
        );
    }

    const dirtyTypeRows = $derived(typeSettingsEditable.filter(isTypeRowDirty));
    let savingAllTypes = $state(false);

    /** One Save for the whole table: writes only the rows that changed. */
    async function saveAllTypeSettings(): Promise<void> {
        if (savingAllTypes) return;
        savingAllTypes = true;
        let ok = true;
        try {
            for (const row of dirtyTypeRows) {
                ok = (await saveTypeSetting(row)) && ok;
            }
            if (ok) toasts.success(m.admin_toast_setting_saved());
        } finally {
            savingAllTypes = false;
        }
    }

    async function loadTypeSettings(): Promise<void> {
        typeSettingsLoading = true;
        typeSettingsError = null;
        try {
            const { data, error } = await getLibraryTypeSettings();
            if (error) throw new Error(error);
            if (data) {
                typeSettings = data.settings;
                typeSettingsEditable = buildEditableRows(data.settings);
                typeSettingsLoaded = true;
            }
        } catch (e) {
            // Surface a recoverable error state instead of leaving the tab stuck
            // on the loading placeholder forever (the lazy-load $effect only
            // re-runs while !typeSettingsLoaded, so a failed first load needs an
            // explicit Retry affordance).
            const msg = getErrorMessage(e, m.admin_library_err_load_type_settings());
            typeSettingsError = msg;
            toasts.error(msg);
        } finally {
            typeSettingsLoading = false;
        }
    }

    function editableFields(row: LibraryTypeSettingRow): unknown[] {
        return [row.display_name, row.sidebar_visible, row.icon, row.sort_order];
    }

    async function saveTypeSetting(row: LibraryTypeSettingRow): Promise<boolean> {
        // What is being sent; edits typed into this row while the request runs
        // must survive the response instead of being overwritten by it.
        const sent = JSON.stringify(editableFields(row));
        try {
            const icon = row.icon?.trim();
            const { data, error } = await upsertLibraryTypeSetting({
                mediaType: row.media_type,
                displayName: row.display_name?.trim() || null,
                sidebarVisible: row.sidebar_visible,
                // '__custom__' is the picker's "custom path" option before a path
                // has been typed — not an icon.
                icon: icon && icon !== '__custom__' ? icon : null,
                sortOrder: row.sort_order,
            });
            if (error) throw new Error(error);
            if (data) {
                // Update backing typeSettings array
                const idx = typeSettings.findIndex((s) => s.media_type === row.media_type);
                if (idx >= 0) {
                    typeSettings[idx] = data.setting;
                } else {
                    typeSettings = [...typeSettings, data.setting];
                }
                // Sync only the saved row in the editable array; leave other rows' edits intact
                const editIdx = typeSettingsEditable.findIndex(
                    (s) => s.media_type === row.media_type,
                );
                if (
                    editIdx >= 0 &&
                    JSON.stringify(editableFields(typeSettingsEditable[editIdx])) === sent
                ) {
                    typeSettingsEditable[editIdx] = { ...data.setting };
                }
            }
            return true;
        } catch (e) {
            toasts.error(getErrorMessage(e, m.admin_library_err_save_setting()));
            return false;
        }
    }

    onMount(() => {
        void loadTypeSettings();
        void getLibraryPaths()
            .then(({ data }) => {
                if (data) paths = data.items;
            })
            .catch(() => {
                /* expected: non-critical — usage counts fall back to "unused" */
            });
    });
</script>

<div class="space-y-4">
    <div>
        <h2 class="text-2xl font-semibold">
            {m.route_admin_library_type_settings()}
        </h2>
        <p class="text-muted text-sm mt-1">
            {m.admin_library_type_settings_desc()}
        </p>
    </div>

    {#if typeSettingsLoading}
        <p class="text-muted text-sm py-4">{m.loading()}</p>
    {:else if typeSettingsError && !typeSettingsLoaded}
        <div class="bg-surface-800 border border-surface-700 rounded-lg p-6 text-center">
            <p class="text-error-400 text-sm">{typeSettingsError}</p>
            <button class="btn btn-ghost btn-sm mt-3" onclick={() => void loadTypeSettings()}>
                {m.btn_retry()}
            </button>
        </div>
    {:else if !typeSettingsLoaded}
        <p class="text-muted text-sm py-4">{m.loading()}</p>
    {:else}
        <!-- One row per type, stacked on phones. A single Save writes every
                 changed row; per-row Save buttons made "I edited three rows"
                 three separate commits, and an unsaved row looked saved. -->
        <div
            class="bg-surface-800 border border-surface-700 rounded-lg divide-y divide-surface-700">
            {#each typeSettingsEditable as row (row.media_type)}
                {@const usage = typeUsageCount(row.media_type)}
                {@const defaultIcon = getLibraryTypeTemplate(row.media_type)?.icon ?? 'folder'}
                {@const previewIcon =
                    navigationIconMap[
                        row.icon && row.icon !== '__custom__' ? row.icon : defaultIcon
                    ]}
                <div
                    class="grid gap-3 p-4 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)_minmax(0,13rem)_auto_auto] sm:items-end">
                    <div class="min-w-0 self-center">
                        <p class="flex items-center gap-2 font-medium text-white">
                            {#if previewIcon}
                                <Icon src={previewIcon} class="w-4 h-4 text-surface-400" />
                            {/if}
                            {typeDefaultLabel(row.media_type)}
                        </p>
                        <p class="text-xs {usage > 0 ? 'text-surface-400' : 'text-surface-500'}">
                            {usage > 0
                                ? m.admin_library_types_used({ count: usage })
                                : m.admin_library_types_unused()}
                        </p>
                    </div>
                    <label class="block min-w-0">
                        <span class="block text-xs text-surface-400 mb-1"
                            >{m.route_admin_library_col_display_name()}</span>
                        <input
                            type="text"
                            class="input w-full"
                            placeholder={typeDefaultLabel(row.media_type)}
                            bind:value={
                                () => row.display_name ?? '', (v) => (row.display_name = v || null)
                            } />
                    </label>
                    <div class="min-w-0">
                        <span class="block text-xs text-surface-400 mb-1"
                            >{m.route_admin_library_col_icon()}</span>
                        <NavigationIconDropdown
                            bind:value={() => row.icon ?? '', (v) => (row.icon = v || null)}
                            placeholder={m.admin_library_types_default_icon()}
                            availableIcons={defaultNavigationIcons}
                            suggestedIcons={[defaultIcon]} />
                        {#if row.icon === '__custom__' || row.icon?.startsWith('/') || row.icon?.startsWith('http')}
                            <input
                                type="text"
                                class="input w-full mt-2 font-mono text-xs"
                                placeholder="/icons/my-icon.svg"
                                value={row.icon === '__custom__' ? '' : row.icon}
                                oninput={(e) =>
                                    (row.icon = e.currentTarget.value || '__custom__')} />
                        {/if}
                    </div>
                    <label class="flex items-center gap-2 text-sm text-surface-300 sm:pb-2.5">
                        <input
                            type="checkbox"
                            bind:checked={row.sidebar_visible}
                            class="rounded border-surface-600 bg-surface-800 text-blue-500" />
                        {m.route_admin_library_col_visible()}
                    </label>
                    <label class="flex items-center gap-2 text-sm text-surface-300 sm:block">
                        <span class="sm:block sm:text-xs sm:text-surface-400 sm:mb-1"
                            >{m.route_admin_library_col_order()}</span>
                        <input
                            type="number"
                            class="input w-20 text-center"
                            min="0"
                            bind:value={
                                () => row.sort_order,
                                (v) => (row.sort_order = Number.isFinite(v) ? v : 0)
                            } />
                    </label>
                </div>
            {/each}
        </div>

        <div class="flex flex-wrap items-center justify-between gap-3 mt-3">
            <p class="text-xs text-surface-500 max-w-prose">
                {m.admin_library_type_settings_help()}
            </p>
            <button
                class="btn btn-blue"
                disabled={dirtyTypeRows.length === 0 || savingAllTypes}
                onclick={() => void saveAllTypeSettings()}>
                {savingAllTypes ? m.route_admin_library_saving() : m.admin_library_types_save_all()}
            </button>
        </div>
    {/if}
</div>
