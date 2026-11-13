<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { SvelteMap, SvelteSet, SvelteURL } from 'svelte/reactivity';
    import type { Snippet } from 'svelte';

    import { enhance } from '$app/forms';
    import { tick, onDestroy, untrack } from 'svelte';
    import {
        Icon,
        ArrowPath,
        Check,
        ExclamationTriangle,
        AdjustmentsHorizontal,
        type IconSource,
    } from 'svelte-hero-icons';
    import { SettingSection, StickySaveBar, SearchInput, ActionModal } from '$lib/components/admin';
    import HelpPopover from '$lib/components/admin/HelpPopover.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { toasts } from '$lib/stores/toast.store';
    import { showAdvancedSettings } from '$lib/stores/admin-show-advanced.store';
    import {
        filterSettings,
        isInputFocused,
        searchAllSettings,
        searchSectionSettings,
        matchProviders,
        buildSettingDeepLink,
        buildProviderDeepLink,
    } from '$lib/utils/admin/settings-search';
    import { scrollToSetting } from '$lib/utils/admin/settings-highlight';
    import { settingValueEqual } from '$lib/utils/admin/setting-value-equal';
    import { page } from '$app/state';
    import { adminWorkspaceUrl, writeAdminWorkspaceUrl } from '../admin-workspace-url';
    import { beforeNavigate, goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import {
        getSettingsBySection,
        getVisibleSettingsBySection,
        isSettingVisible,
    } from '$lib/config/schema';
    import type { SectionDefinition, SettingDefinition } from '$lib/config/schema';

    const MAX_CROSS_PAGE_PER_GROUP = 8;
    /** Cap on the "on this page" jump list before it collapses to a "+N more" note. */
    const MAX_LOCAL_RESULTS = 12;

    interface PageData {
        values: Record<string, unknown>;
        envOverrides: string[];
        /** Keys saved in settings.json. */
        configFileKeys?: string[];
        /** Restart-only settings saved with a value this server has not applied. */
        restartPendingKeys?: string[];
        schema: {
            sections: SectionDefinition[];
            settings: SettingDefinition[];
        };
        /** Whether dev-only settings are exposed on this deployment (dev/preprod). */
        devFeaturesEnabled?: boolean;
        configPath: string;
        storageStatus: {
            willPersist: boolean;
            message?: string;
            path?: string;
            isMounted?: boolean;
        } | null;
        warnings?: string[];
        allSections?: {
            sections: SectionDefinition[];
            settings: SettingDefinition[];
        };
        providerIndex?: import('$lib/utils/admin/settings-search').ProviderSearchEntry[];
        // Deliberately NO `[key: string]: unknown` catch-all. Nothing here indexes
        // `data` dynamically, and an index signature is not satisfied by an
        // interface — so the two tab components whose loaders return
        // `SettingsLoadResult & {…}` could not pass their own data through.
        // Callers hand in a variable, not a fresh literal, so extra keys are
        // accepted without it.
    }

    interface ActionFormData {
        success?: boolean;
        error?: string;
        reloaded?: boolean;
    }

    /**
     * The live form context handed to page-specific snippets so they can render
     * extra `SettingInput`/`SettingSection` content that saves through THIS
     * page's single `?/save` form — never a second, competing save path.
     */
    interface SettingsFormContext {
        currentValues: Record<string, unknown>;
        envOverridesSet: SvelteSet<string>;
        handleChange: (key: string, value: unknown) => void;
    }

    interface Props {
        data: PageData;
        form: ActionFormData | null;
        icon: IconSource;
        heading: string;
        description: string;
        /** Bindable — allows parent to observe and react to the search query (e.g. for cross-page search) */
        searchQuery?: string;
        /** Extra result count to add to the search results info (e.g. cross-page results) */
        extraResultsCount?: number;
        beforeSectionSnippet?: Snippet<[{ sectionId: string } & SettingsFormContext]>;
        sectionSnippet?: Snippet<[{ sectionId: string } & SettingsFormContext]>;
        /**
         * Page-specific content rendered ABOVE the config sections — for pages
         * whose primary subject is not a config section at all (e.g. the Access
         * page's in-app group manager, which owns the page while `groups`/`auth`/
         * `social` are supporting settings below it). Deliberately arg-less: it
         * is not part of the settings form.
         */
        beforeSections?: Snippet;
        /**
         * Page-specific content rendered BELOW the config sections. Receives the
         * form context so an aggregate panel (e.g. the Access page's "Group-based
         * rules" audit view, which renders settings owned by OTHER sections) edits
         * and saves through this page's form. Arg-less consumers stay valid.
         */
        afterSections?: Snippet<[SettingsFormContext]>;
    }

    let {
        data,
        form,
        icon,
        heading,
        description,
        searchQuery = $bindable(''),
        extraResultsCount = 0,
        sectionSnippet,
        beforeSectionSnippet,
        beforeSections,
        afterSections,
    }: Props = $props();

    // Search state
    let searchInputComponent = $state<{
        focus: () => void;
        blur: () => void;
    } | null>(null);

    // Track modified values
    let modifiedValues: Record<string, unknown> = $state({});
    // ENV-locked keys whose environment value the operator asked to copy into
    // settings.json on the next save ("Save to config").
    let pendingPersistEnv = $state<string[]>([]);
    let hasChanges = $derived(
        Object.keys(modifiedValues).length > 0 || pendingPersistEnv.length > 0,
    );
    let isSaving = $state(false);
    let isReloading = $state(false);
    let saveForm = $state<HTMLFormElement | undefined>();
    let reloadTimer: ReturnType<typeof setTimeout> | undefined;
    onDestroy(() => clearTimeout(reloadTimer));
    let pendingNavigation = $state<URL | null>(null);

    beforeNavigate((navigation) => {
        if (navigation.willUnload || !navigation.to) return;
        if (isSaving || isReloading) {
            navigation.cancel();
            return;
        }
        if (!hasChanges) return;
        if (
            navigation.to.url.pathname === page.url.pathname &&
            navigation.to.url.search === workspaceUrl.search
        )
            return;
        navigation.cancel();
        pendingNavigation = navigation.to.url;
    });

    // Initialize values from server data
    let currentValues = $derived({ ...data.values, ...modifiedValues });
    let envOverridesSet = $derived(new SvelteSet(data.envOverrides));

    let modifiedCount = $derived(Object.keys(modifiedValues).length + pendingPersistEnv.length);
    let configFileKeys = $derived(new Set(data.configFileKeys ?? []));
    // Labels of saved settings that only apply after a restart (all pages share
    // one list: a pending restart concerns the whole server, not one page).
    let restartPendingLabels = $derived.by(() => {
        const settings = data.allSections?.settings ?? data.schema.settings;
        return (data.restartPendingKeys ?? []).map(
            (key) => settings.find((st) => st.key === key)?.label ?? key,
        );
    });

    // Visibility flags: dev-only settings show on dev/preprod; advanced settings show
    // when the page-level "Show advanced" toggle (persisted in localStorage) is on.
    let visibilityFlags = $derived({
        devFeaturesEnabled: data.devFeaturesEnabled ?? false,
        showAdvanced: $showAdvancedSettings || searchQuery.trim().length > 0,
    });

    // A section stays visible when it has a category toggle (featureFlag) or has no
    // schema settings at all (custom editors like Navigation). Sections whose settings
    // are ALL hidden by the current flags — and that have no toggle — are dropped so we
    // don't render empty cards (e.g. an advanced-only section while advanced is off).
    function sectionHasVisibleContent(section: SectionDefinition): boolean {
        if (section.featureFlag) return true;
        if (getSettingsBySection(section.id).length === 0) return true;
        // A row whose showWhen condition is not met is not rendered either: a section
        // whose only rows are such rows would be an empty card.
        return getVisibleSettingsBySection(section.id, visibilityFlags).some((setting) =>
            isSettingVisible(setting, currentValues),
        );
    }

    // svelte-ignore state_referenced_locally
    const initialSectionCollapsed = Object.fromEntries(
        data.schema.sections.map((section) => [section.id, false]),
    );
    // Focused categories start expanded; users can still collapse their contents.
    let sectionCollapsed: Record<string, boolean> = $state(initialSectionCollapsed);

    // Filter sections based on search query (search also respects visibility flags so
    // hidden advanced/dev-only settings don't surface in results).
    let { filteredSections } = $derived(
        filterSettings(data.schema.sections, searchQuery, visibilityFlags),
    );

    // When not searching, additionally drop sections left empty by the visibility flags.
    let displaySections = $derived(
        searchQuery.trim() ? filteredSections : filteredSections.filter(sectionHasVisibleContent),
    );

    let orderedSections = $derived(displaySections.toSorted((a, b) => a.order - b.order));
    let workspaceUrl = $derived(adminWorkspaceUrl(page.url, page.state));
    let selectedSection = $derived(
        orderedSections.find(
            (section) =>
                section.id ===
                (workspaceUrl.searchParams.get('category') ??
                    workspaceUrl.searchParams.get('section')),
        )?.id ??
            orderedSections[0]?.id ??
            '',
    );
    let visiblePageSections = $derived(
        searchQuery.trim()
            ? orderedSections
            : orderedSections.filter((section) => section.id === selectedSection),
    );
    let changedSettings = $derived(
        (data.allSections?.settings ?? data.schema.settings).filter(
            (setting) => setting.key in modifiedValues,
        ),
    );
    let overriddenSettings = $derived(
        data.schema.settings.filter((setting) => envOverridesSet.has(setting.key)),
    );
    let pageOverrideCount = $derived(overriddenSettings.length);
    let showOverrides = $state(false);

    function selectSection(id: string): void {
        if (isSaving || isReloading) return;
        searchQuery = '';
        writeLocation(id, null, false, true);
    }

    function sectionChangeCount(sectionId: string): number {
        return changedSettings.filter((setting) => setting.section === sectionId).length;
    }

    // Matches ON THIS PAGE (only while searching) — rendered as a clickable jump
    // list so a hit deep in a long page is one click away instead of a manual scroll
    // hunt through the filtered sections.
    let localSettingMatches = $derived(
        searchQuery.trim()
            ? searchSectionSettings(data.schema.sections, searchQuery, visibilityFlags)
            : [],
    );

    // Cross-page matches (only while searching). Excludes sections already on THIS page.
    let localSectionIds = $derived(new Set(data.schema.sections.map((s) => s.id)));
    let crossPageSettingMatches = $derived.by(() => {
        if (!searchQuery.trim() || !data.allSections) return [];
        return searchAllSettings(data.allSections.sections, searchQuery, visibilityFlags).filter(
            (m) => !localSectionIds.has(m.section.id),
        );
    });
    let crossPageByPage = $derived.by(() => {
        const groups = new SvelteMap<
            string,
            { href: string; label: string; matches: typeof crossPageSettingMatches }
        >();
        for (const match of crossPageSettingMatches) {
            const g = groups.get(match.pageHref) ?? {
                href: match.pageHref,
                label: match.pageLabel,
                matches: [],
            };
            g.matches.push(match);
            groups.set(match.pageHref, g);
        }
        return [...groups.values()];
    });
    let providerMatches = $derived(matchProviders(data.providerIndex ?? [], searchQuery));
    let crossPageCount = $derived(crossPageSettingMatches.length + providerMatches.length);

    // Keyboard shortcut for search (/). Ctrl/Cmd+K is deliberately NOT bound here:
    // the admin shell advertises it as the command palette on every page, and a
    // page that silently repurposes it breaks that promise.
    function handleKeydown(event: KeyboardEvent) {
        if (
            event.defaultPrevented ||
            pendingNavigation ||
            (event.target instanceof Element && event.target.closest('[aria-modal="true"]'))
        )
            return;
        const isSearchShortcut =
            event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey;
        if (isSearchShortcut && !isInputFocused()) {
            event.preventDefault();
            searchInputComponent?.focus();
        }
        if (event.key === 'Escape' && searchQuery.trim()) {
            searchQuery = '';
            searchInputComponent?.blur();
        }
    }

    function handleBeforeUnload(event: BeforeUnloadEvent): void {
        if (!hasChanges) return;
        event.preventDefault();
        event.returnValue = '';
    }

    let targetSettingKey = $derived(workspaceUrl.searchParams.get('highlight'));
    let locationSection = $derived(
        orderedSections.find((section) => section.id === selectedSection),
    );
    let targetUnavailable = $state(false);
    let scrollGeneration = 0;
    let preserveScrollForUrl: string | null = null;
    onDestroy(() => {
        scrollGeneration += 1;
    });

    function writeLocation(
        sectionId: string,
        settingKey: string | null,
        replace: boolean,
        preserveScroll = false,
    ): void {
        const url = new SvelteURL(workspaceUrl);
        url.hash = '';
        url.searchParams.set('category', sectionId);
        url.searchParams.set('section', sectionId);
        if (settingKey) url.searchParams.set('highlight', settingKey);
        else url.searchParams.delete('highlight');
        if (preserveScroll) preserveScrollForUrl = url.href;
        if (url.href !== workspaceUrl.href) writeAdminWorkspaceUrl(url, page.state, replace);
        else void runDeepLink(url);
    }

    /** Automatic reveal must not create history entries or erase the exact target. */
    function expandSection(sectionId: string): void {
        if (sectionId in sectionCollapsed) sectionCollapsed[sectionId] = false;
    }

    function revealAdvanced(): void {
        if (!$showAdvancedSettings) showAdvancedSettings.set(true);
    }

    async function runDeepLink(url: URL): Promise<void> {
        const generation = ++scrollGeneration;
        const isCurrent = (): boolean =>
            generation === scrollGeneration && workspaceUrl.href === url.href;
        const sectionId = url.searchParams.get('category') ?? url.searchParams.get('section');
        targetUnavailable = false;
        const settingKey = url.searchParams.get('highlight');
        const preserveScroll = !settingKey && preserveScrollForUrl === url.href;
        preserveScrollForUrl = null;
        if (!sectionId) return;
        expandSection(sectionId);
        await tick();
        if (!isCurrent() || preserveScroll) return;
        await scrollToSetting({ sectionId, settingKey, expandSection, revealAdvanced, isCurrent });
        if (isCurrent() && settingKey)
            targetUnavailable = !document.getElementById(`setting-${settingKey}`);
    }

    // page.state changes on shallow Back/Forward as well as deliberate clicks.
    $effect(() => {
        const url = workspaceUrl;
        untrack(() => {
            searchQuery = '';
            void runDeepLink(url);
        });
    });

    // Target availability follows actual rendered rows, without scrolling on form edits.
    $effect(() => {
        const key = targetSettingKey;
        const searching = !!searchQuery.trim();
        const updateAvailability = (): void => {
            const unavailable = !searching && !!key && !document.getElementById(`setting-${key}`);
            untrack(() => {
                targetUnavailable = unavailable;
            });
        };
        const observer = new MutationObserver(updateAvailability);
        const root = document.querySelector('[data-admin-settings-page]');
        if (root) observer.observe(root, { childList: true, subtree: true });
        updateAvailability();
        return () => observer.disconnect();
    });

    function jumpToSetting(sectionId: string, settingKey: string): void {
        if (isSaving || isReloading) return;
        searchQuery = '';
        writeLocation(sectionId, settingKey, false);
    }

    // Handle setting change
    function handleSettingChange(detail: { key: string; value: unknown }) {
        handleChange(detail.key, detail.value);
    }

    // Unified change handler (also exposed to sectionSnippet)
    function handleChange(key: string, value: unknown) {
        if (isSaving || isReloading) return;
        if (settingValueEqual(value, data.values[key])) {
            const { [key]: _, ...rest } = modifiedValues;
            modifiedValues = rest;
        } else {
            modifiedValues = { ...modifiedValues, [key]: value };
        }
    }

    // "Save to config" on an ENV-locked setting: queue the key; the server copies
    // the environment's value into settings.json on save. It used to put the
    // value into the normal save payload, which the server skips for ENV-owned
    // keys — the promised copy never happened.
    function handleSaveEnvToConfig(detail: { key: string; value: unknown }) {
        if (pendingPersistEnv.includes(detail.key)) {
            pendingPersistEnv = pendingPersistEnv.filter((k) => k !== detail.key);
            return;
        }
        pendingPersistEnv = [...pendingPersistEnv, detail.key];
        toasts.info(m.admin_settings_env_copy_queued({ key: detail.key }));
    }

    // Reset all changes
    function resetChanges() {
        if (isSaving || isReloading) return;
        modifiedValues = {};
        pendingPersistEnv = [];
    }

    /** Set by "Save and leave": where to go once the save succeeds. */
    let navigateAfterSave: URL | null = null;

    function handleSaveResult(result: import('@sveltejs/kit').ActionResult) {
        const actionData =
            result.type === 'success' || result.type === 'failure'
                ? (result.data as ActionFormData | undefined)
                : undefined;
        if (result.type === 'success' && actionData?.success === true) {
            toasts.success(m.admin_toast_settings_saved_reloading_to_apply_changes());
            modifiedValues = {};
            pendingPersistEnv = [];
            // Full reload so all stores (appConfig, $page.data.features) pick up new
            // values — to the page the operator was leaving for, if they chose
            // "Save and leave".
            const target = navigateAfterSave;
            navigateAfterSave = null;
            reloadTimer = setTimeout(() => {
                if (target) window.location.assign(target.href);
                else window.location.reload();
            }, 600);
            return; // Keep controls locked until the saved configuration has reloaded.
        } else if (result.type === 'failure' || actionData?.error) {
            const errorMsg =
                (result.type === 'failure' && (result.data as ActionFormData | undefined)?.error) ||
                actionData?.error ||
                'Unknown error';
            toasts.error(`Failed: ${errorMsg}`);
            navigateAfterSave = null;
        } else {
            // 'error', a 'redirect' (e.g. the session expired) or a success
            // without the flag: the form used to unlock without a word, so the
            // operator could not tell the save had not happened.
            toasts.error(m.admin_settings_unknown_error());
            navigateAfterSave = null;
        }
        isSaving = false;
    }

    function handleReloadResult(result: import('@sveltejs/kit').ActionResult) {
        const actionData =
            result.type === 'success' || result.type === 'failure'
                ? (result.data as ActionFormData | undefined)
                : undefined;
        if (result.type === 'success' && actionData?.reloaded === true) {
            toasts.success(m.admin_toast_settings_reloaded_from_file());
        } else if (result.type === 'failure' || actionData?.error) {
            const errorMsg =
                (result.type === 'failure' && (result.data as ActionFormData | undefined)?.error) ||
                actionData?.error ||
                'Unknown error';
            toasts.error(`Failed: ${errorMsg}`);
        } else if (result.type === 'error') {
            toasts.error(m.admin_settings_unknown_error());
        }
        isReloading = false;
    }
</script>

<svelte:window onkeydown={handleKeydown} onbeforeunload={handleBeforeUnload} />

<div class="settings-page" data-admin-settings-page>
    <nav aria-label={m.admin_settings_current_location()} class="mb-4 text-sm text-surface-300">
        <ol class="flex flex-wrap items-center gap-x-2 gap-y-1 break-words">
            <li>{m.admin_nav_section_settings()}</li>
            <li aria-hidden="true">→</li>
            <li aria-current={!locationSection && !searchQuery.trim() ? 'location' : undefined}>
                {heading}
            </li>
            {#if locationSection || searchQuery.trim()}
                <li aria-hidden="true">→</li>
                <li aria-current="location">
                    {searchQuery.trim()
                        ? m.admin_settings_search_location()
                        : locationSection?.label}
                </li>
            {/if}
        </ol>
    </nav>
    {#if targetUnavailable}<p role="status" class="mb-4 text-sm text-amber-200">
            {m.admin_settings_target_unavailable()}
        </p>{/if}
    <!-- Header -->
    <div class="flex flex-wrap items-center justify-between gap-4 mb-6">
        <div>
            <h1 class="text-2xl font-semibold flex items-center gap-2">
                <Icon src={icon} class="w-7 h-7 text-cyan-400" />
                {heading}
            </h1>
            <p class="text-muted mt-1">{description}</p>
        </div>

        <!-- Actions -->
        <div class="flex flex-wrap items-center gap-3">
            {#if hasChanges}
                <span class="text-sm text-yellow-400 flex items-center gap-1">
                    <Icon src={ExclamationTriangle} class="w-4 h-4" />
                    {m.admin_navigation_unsaved_changes()}
                </span>
                <button
                    type="button"
                    class="px-3 py-2 text-sm text-surface-400 hover:text-white transition-colors"
                    disabled={isSaving || isReloading}
                    onclick={resetChanges}>
                    {m.admin_sticky_discard()}
                </button>
            {/if}

            <!-- Show advanced settings toggle (persisted per-device in localStorage) -->
            <div
                class="flex items-center gap-2 text-sm text-surface-300 select-none"
                title={m.admin_settings_show_advanced_hint()}>
                <Icon src={AdjustmentsHorizontal} class="w-4 h-4 text-surface-400" />
                <span>{m.admin_settings_show_advanced()}</span>
                <button
                    type="button"
                    role="switch"
                    aria-checked={$showAdvancedSettings}
                    aria-label={m.admin_settings_show_advanced_hint()}
                    class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-surface-800"
                    class:bg-yellow-500={$showAdvancedSettings}
                    class:bg-surface-600={!$showAdvancedSettings}
                    onclick={() => showAdvancedSettings.update((v) => !v)}>
                    <span
                        class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
                        class:translate-x-5={$showAdvancedSettings}
                        class:translate-x-0={!$showAdvancedSettings}></span>
                </button>
            </div>

            <!-- Reload from file -->
            <form
                method="POST"
                action="?/reload"
                use:enhance={({ cancel }) => {
                    if (isReloading || isSaving || hasChanges) {
                        cancel();
                        return;
                    }
                    isReloading = true;
                    return async ({ update, result }) => {
                        try {
                            await update();
                            await tick();
                            handleReloadResult(result);
                        } catch {
                            isReloading = false;
                            toasts.error(m.admin_settings_unknown_error());
                        }
                    };
                }}>
                <button
                    type="submit"
                    class="btn btn-sm btn-gray flex items-center gap-2"
                    title={m.admin_settings_reload_from_disk_hint({ path: data.configPath })}
                    disabled={isReloading || hasChanges || isSaving}>
                    <Icon src={ArrowPath} class="w-4 h-4 {isReloading ? 'animate-spin' : ''}" />
                    {m.admin_settings_reload_from_disk()}
                </button>
            </form>

            <!-- Save -->
            <form
                method="POST"
                action="?/save"
                bind:this={saveForm}
                use:enhance={({ cancel }) => {
                    if (isSaving || isReloading || !hasChanges) {
                        // A cancelled "Save and leave" must not carry its target
                        // over to the next, plain save.
                        if (!isSaving) navigateAfterSave = null;
                        cancel();
                        return;
                    }
                    isSaving = true;
                    return async ({ update, result }) => {
                        try {
                            await update();
                            await tick();
                            handleSaveResult(result);
                        } catch {
                            isSaving = false;
                            navigateAfterSave = null;
                            toasts.error(m.admin_settings_unknown_error());
                        }
                    };
                }}>
                <!-- Only the keys the operator changed: posting the whole loaded config
                     re-wrote every setting on the page (a stale tab reverted
                     other admins' edits) and logged them all as changed. -->
                <input type="hidden" name="updates" value={JSON.stringify(modifiedValues)} />
                <input type="hidden" name="persistEnv" value={JSON.stringify(pendingPersistEnv)} />
                <button
                    type="submit"
                    class="flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg transition-colors disabled:cursor-not-allowed {hasChanges
                        ? 'bg-yellow-500 hover:bg-yellow-400 text-surface-900'
                        : 'border border-surface-600 bg-transparent text-surface-400'}"
                    disabled={!hasChanges || isSaving}>
                    {#if isSaving}
                        <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                        {m.admin_settings_saving()}
                    {:else}
                        <Icon src={Check} class="w-4 h-4" />
                        {m.admin_navigation_save_changes()}{#if hasChanges}
                            ({modifiedCount}){/if}
                    {/if}
                </button>
            </form>
        </div>
    </div>

    <!-- Configuration Warnings -->
    {#if data.warnings?.length}
        {#each data.warnings as warning, i (i)}
            <div class="bg-orange-500/10 border border-orange-500/30 rounded-lg p-4 mb-6">
                <div class="flex items-start gap-3">
                    <Icon
                        src={ExclamationTriangle}
                        class="w-5 h-5 text-orange-400 shrink-0 mt-0.5" />
                    <div class="text-sm">
                        <p class="text-orange-200">{warning}</p>
                    </div>
                </div>
            </div>
        {/each}
    {/if}

    <!-- Storage Status Warning (only shown if settings won't persist) -->
    {#if data.storageStatus && !data.storageStatus.willPersist}
        <div class="bg-red-500/10 border border-red-500/30 rounded-lg p-4 mb-6">
            <div class="flex items-start gap-3">
                <Icon src={ExclamationTriangle} class="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                <div class="text-sm">
                    <p class="text-red-200 font-medium">{m.admin_settings_not_persisting()}</p>
                    <p class="text-red-300/70 mt-1">
                        {data.storageStatus?.message}
                    </p>
                    {#if data.storageStatus?.path === '/config/settings.json' && !data.storageStatus?.isMounted}
                        <div class="mt-2">
                            <HelpPopover
                                variant="inline"
                                summary={m.admin_settings_storage_fix_summary()}>
                                <p>
                                    Add this to your <code class="bg-surface-800 px-1 rounded"
                                        >docker-compose.yml</code
                                    >:
                                </p>
                                <pre
                                    class="bg-surface-900 rounded p-2 mt-2 text-xs text-surface-300 overflow-x-auto">volumes:
  - ./config:/config</pre>
                            </HelpPopover>
                        </div>
                    {/if}
                </div>
            </div>
        </div>
    {/if}

    <div
        class="mb-5 flex flex-wrap items-center gap-x-5 gap-y-2 rounded-lg border border-surface-700 bg-surface-800/30 px-4 py-3 text-sm">
        <span class={hasChanges ? 'text-amber-300' : 'text-surface-300'} aria-live="polite">
            {hasChanges
                ? m.admin_redesign_settings_changed({ count: modifiedCount })
                : m.admin_redesign_settings_saved()}
        </span>
        {#if pageOverrideCount > 0}<button
                type="button"
                class="text-surface-400 underline decoration-dotted underline-offset-4 hover:text-white"
                aria-expanded={showOverrides}
                aria-controls="settings-env-overrides"
                onclick={() => (showOverrides = !showOverrides)}
                >{m.admin_redesign_settings_overrides({ count: pageOverrideCount })}</button
            >{/if}
        <details class="min-w-0 basis-full sm:flex-1">
            <summary class="cursor-pointer text-surface-400"
                >{m.admin_redesign_settings_configuration()}</summary>
            <div class="mt-3 space-y-2">
                <div class="text-sm text-surface-300">
                    <p class="text-blue-200">
                        Settings are saved to <code class="bg-surface-800 px-1 rounded"
                            >{data.configPath}</code
                        >. Environment variables override JSON values (shown with
                        <span class="badge badge-info gap-1"> ENV </span>
                        badge).
                    </p>
                    <p class="text-blue-300/70 mt-1">
                        Some settings require an application restart to take effect (shown with
                        <span class="badge badge-warning gap-1"> Restart </span>
                        badge).
                    </p>
                </div>

                {#if !data.storageStatus}<p class="text-sm text-amber-300">
                        {m.admin_redesign_settings_storage_unknown()}
                    </p>{/if}
            </div>
        </details>
        {#if showOverrides && pageOverrideCount > 0}
            <div id="settings-env-overrides" class="w-full border-t border-surface-700 pt-3">
                <p class="text-xs text-surface-400">{m.admin_settings_env_overrides_hint()}</p>
                <ul class="mt-2 flex flex-wrap gap-2">
                    {#each overriddenSettings as setting (setting.key)}
                        <li>
                            <button
                                type="button"
                                class="rounded bg-surface-800 px-2 py-1 text-sm text-surface-200 hover:text-white"
                                title={setting.key}
                                onclick={() => {
                                    searchQuery = '';
                                    jumpToSetting(setting.section, setting.key);
                                }}>{setting.label} →</button>
                        </li>
                    {/each}
                </ul>
            </div>
        {/if}
    </div>

    <!-- Search -->
    <SearchInput
        bind:this={searchInputComponent}
        bind:value={searchQuery}
        placeholder={m.admin_redesign_settings_search()} />

    <!-- Search results info -->
    {#if searchQuery.trim()}
        {@const otherPagesCount = extraResultsCount + crossPageCount}
        {@const totalCount = localSettingMatches.length + otherPagesCount}
        <div class="mt-4 mb-4 text-sm text-surface-400" aria-live="polite">
            {#if totalCount === 0 && filteredSections.length === 0}
                {m.admin_settings_search_none({ query: searchQuery.trim() })}
            {:else}
                {m.admin_settings_search_found({ count: totalCount })}
                {#if otherPagesCount > 0}
                    <span class="text-surface-500"
                        >{m.admin_settings_search_found_elsewhere({
                            count: otherPagesCount,
                        })}</span>
                {/if}
            {/if}
        </div>

        <!-- Jump list: matches on this page, click to scroll + highlight -->
        {#if localSettingMatches.length > 0}
            <div class="mb-4 rounded-lg border border-surface-700/50 bg-surface-800/30 p-3">
                <div
                    class="px-1 pb-2 text-xs font-medium uppercase tracking-wider text-surface-400">
                    {m.admin_settings_jump_to_on_page({ count: localSettingMatches.length })}
                </div>
                <ul class="space-y-0.5">
                    {#each localSettingMatches.slice(0, MAX_LOCAL_RESULTS) as match (match.setting.key)}
                        <li>
                            <button
                                type="button"
                                class="flex w-full items-baseline justify-between gap-3 rounded px-2 py-1 text-left text-sm text-surface-200 transition-colors hover:bg-surface-700/40 hover:text-yellow-400"
                                onclick={() => jumpToSetting(match.section.id, match.setting.key)}>
                                <span>{match.setting.label}</span>
                                <span class="shrink-0 text-xs text-surface-500"
                                    >{match.section.label}</span>
                            </button>
                        </li>
                    {/each}
                </ul>
                {#if localSettingMatches.length > MAX_LOCAL_RESULTS}
                    <div class="mt-1 px-2 text-xs text-surface-500">
                        {m.admin_settings_jump_more({
                            count: localSettingMatches.length - MAX_LOCAL_RESULTS,
                        })}
                    </div>
                {/if}
            </div>
        {/if}
    {/if}

    <!-- Saved restart-only settings this server has not applied yet. -->
    {#if restartPendingLabels.length > 0}
        <div
            class="mt-6 flex items-start gap-2 rounded-lg border border-amber-600/40 bg-amber-900/20 px-4 py-3 text-sm text-amber-100"
            role="status">
            <Icon src={ArrowPath} class="mt-0.5 h-4 w-4 shrink-0 text-amber-300" />
            <p>
                {m.admin_settings_restart_pending({
                    count: restartPendingLabels.length,
                    settings: restartPendingLabels.join(', '),
                })}
            </p>
        </div>
    {/if}

    <!-- Before sections slot (e.g. the Access page's group manager) -->
    <fieldset disabled={isSaving || isReloading} class="min-w-0">
        {#if beforeSections}
            <div class="mt-6">
                {@render beforeSections()}
            </div>
        {/if}

        <div
            class="mt-6 grid items-start gap-5 {orderedSections.length > 1 && !searchQuery.trim()
                ? 'lg:grid-cols-[12rem_minmax(0,1fr)]'
                : ''}">
            {#if orderedSections.length > 1 && !searchQuery.trim()}
                <nav
                    class="flex flex-wrap gap-2 lg:sticky lg:top-6 lg:flex-col"
                    aria-label={m.admin_redesign_settings_sections()}>
                    <p
                        class="w-full px-2 pb-1 text-xs font-medium uppercase tracking-wide text-surface-400">
                        {m.admin_redesign_settings_category()}
                    </p>
                    {#each orderedSections as section (section.id)}
                        {@const changed = sectionChangeCount(section.id)}
                        <button
                            type="button"
                            class="flex items-center justify-between gap-2 rounded-lg border px-3 py-2.5 text-left text-sm transition-colors {selectedSection ===
                            section.id
                                ? 'border-primary-500/40 bg-primary-500/10 text-primary-200'
                                : 'border-transparent text-surface-400 hover:bg-surface-800 hover:text-white'}"
                            aria-pressed={selectedSection === section.id}
                            aria-current={selectedSection === section.id ? 'location' : undefined}
                            onclick={() => selectSection(section.id)}>
                            {section.label}
                            {#if changed > 0}<span
                                    class="rounded bg-amber-500/10 px-1.5 text-xs text-amber-300"
                                    aria-label={m.admin_redesign_settings_changed({
                                        count: changed,
                                    })}>{changed}</span
                                >{/if}
                        </button>
                    {/each}
                </nav>
            {/if}
            <!-- Sections -->
            <div class="min-w-0 space-y-4">
                {#each visiblePageSections as section (section.id)}
                    {#if beforeSectionSnippet}
                        {@render beforeSectionSnippet({
                            sectionId: section.id,
                            currentValues,
                            envOverridesSet,
                            handleChange,
                        })}
                    {/if}
                    <SettingSection
                        {section}
                        values={currentValues}
                        envOverrides={envOverridesSet}
                        {configFileKeys}
                        {pendingPersistEnv}
                        showAdvanced={visibilityFlags.showAdvanced}
                        devFeaturesEnabled={data.devFeaturesEnabled ?? false}
                        searchQuery={searchQuery.trim()}
                        forceExpanded={!!searchQuery.trim()}
                        {targetSettingKey}
                        collapsible={false}
                        bind:collapsed={sectionCollapsed[section.id]}
                        onchange={handleSettingChange}
                        onsaveEnvToConfig={handleSaveEnvToConfig} />

                    {#if sectionSnippet}
                        {@render sectionSnippet({
                            sectionId: section.id,
                            currentValues,
                            envOverridesSet,
                            handleChange,
                        })}
                    {/if}
                {/each}
            </div>
        </div>

        {#if hasChanges}
            <details class="mt-6 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4">
                <summary class="cursor-pointer text-sm font-medium text-amber-200"
                    >{m.admin_redesign_settings_review()} ({modifiedCount})</summary>
                <p class="mt-2 text-sm text-surface-400">
                    {m.admin_redesign_settings_review_hint()}
                </p>
                <ul class="mt-3 flex flex-wrap gap-2">
                    {#each changedSettings as setting (setting.key)}
                        <li>
                            <button
                                type="button"
                                class="rounded bg-surface-800 px-2 py-1 text-sm text-surface-200 hover:text-white"
                                onclick={() => {
                                    searchQuery = '';
                                    jumpToSetting(setting.section, setting.key);
                                }}>{setting.label} →</button>
                        </li>
                    {/each}
                </ul>
            </details>
        {/if}

        <!-- After sections slot (e.g., cross-page search results) -->
        {#if afterSections}
            {@render afterSections({ currentValues, envOverridesSet, handleChange })}
        {/if}

        <!-- Cross-page search results (settings + providers on other pages) -->
        {#if searchQuery.trim() && crossPageCount > 0}
            <div class="mt-6 space-y-3">
                <h3 class="text-sm font-medium text-surface-400 uppercase tracking-wider">
                    {m.admin_settings_also_found_other_pages()}
                </h3>

                {#each crossPageByPage as group (group.href)}
                    <div class="rounded-lg border border-surface-700/50 bg-surface-800/30 p-4">
                        <div class="text-sm font-medium text-white">{group.label}</div>
                        <ul class="mt-2 space-y-1">
                            {#each group.matches.slice(0, MAX_CROSS_PAGE_PER_GROUP) as match (match.setting.key)}
                                <li>
                                    <a
                                        href={resolve(buildSettingDeepLink(match))}
                                        class="flex items-baseline justify-between gap-3 rounded px-2 py-1 text-sm text-surface-200 hover:bg-surface-700/40 hover:text-yellow-400 transition-colors">
                                        <span>{match.setting.label}</span>
                                        <span class="text-xs text-surface-500"
                                            >{match.section.label} →</span>
                                    </a>
                                </li>
                            {/each}
                        </ul>
                        {#if group.matches.length > MAX_CROSS_PAGE_PER_GROUP}
                            <div class="mt-1 px-2 text-xs text-surface-500">
                                +{group.matches.length - MAX_CROSS_PAGE_PER_GROUP} more
                            </div>
                        {/if}
                    </div>
                {/each}

                {#if providerMatches.length > 0}
                    <div class="rounded-lg border border-surface-700/50 bg-surface-800/30 p-4">
                        <!-- Named for what the entries ARE, not the page they live on: the
                         Providers & metadata page's own settings already form a group above
                         under that page's name, and two identically named groups read as a
                         duplicate. -->
                        <div class="text-sm font-medium text-white">
                            {m.admin_settings_search_provider_group()}
                        </div>
                        <ul class="mt-2 space-y-1">
                            {#each providerMatches as entry (entry.id)}
                                <li>
                                    <a
                                        href={resolve(buildProviderDeepLink(entry))}
                                        class="flex items-baseline justify-between gap-3 rounded px-2 py-1 text-sm text-surface-200 hover:bg-surface-700/40 hover:text-yellow-400 transition-colors">
                                        <span>{entry.label}</span>
                                        <span class="text-xs text-surface-500"
                                            >{entry.category} →</span>
                                    </a>
                                </li>
                            {/each}
                        </ul>
                    </div>
                {/if}
            </div>
        {/if}
    </fieldset>

    <!-- Sticky Save Bar (when has changes) -->
    {#if hasChanges}
        <StickySaveBar
            {modifiedCount}
            {currentValues}
            {isSaving}
            ondiscard={resetChanges}
            onsave={() => {
                saveForm?.requestSubmit();
            }} />
    {/if}
</div>

{#if pendingNavigation}
    <ActionModal
        title={m.admin_redesign_settings_leave_title()}
        onclose={() => {
            pendingNavigation = null;
        }}>
        <p class="text-surface-300">{m.admin_redesign_settings_leave_hint()}</p>
        {#snippet footer()}
            <div class="flex flex-wrap justify-end gap-3">
                <button
                    class="btn border border-red-500/40 bg-transparent text-red-300 hover:bg-red-500/10"
                    onclick={() => {
                        const target = pendingNavigation;
                        pendingNavigation = null;
                        resetChanges();
                        if (target) void goto(resolve(target.href));
                    }}>{m.admin_redesign_settings_leave()}</button>
                <button
                    class="btn btn-surface"
                    onclick={() => {
                        pendingNavigation = null;
                    }}>{m.admin_redesign_settings_stay()}</button>
                <button
                    class="btn btn-primary"
                    disabled={isSaving}
                    onclick={() => {
                        navigateAfterSave = pendingNavigation;
                        pendingNavigation = null;
                        saveForm?.requestSubmit();
                    }}>{m.admin_settings_save_and_leave()}</button>
            </div>
        {/snippet}
    </ActionModal>
{/if}

<style>
    .settings-page {
        padding-bottom: 100px; /* Space for sticky save bar */
    }

    code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
        font-size: 0.875em;
    }
</style>
