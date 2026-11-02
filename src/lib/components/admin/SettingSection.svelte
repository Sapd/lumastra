<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { integrationRedirectUri } from '$lib/shared/public-base-url.js';
    import { SvelteMap, SvelteSet } from 'svelte/reactivity';
    import { slide } from 'svelte/transition';
    import { Icon, ChevronDown, ChevronRight } from 'svelte-hero-icons';
    import type { SectionDefinition, SettingDefinition } from '$lib/config/schema';
    import {
        getVisibleSettingsBySection,
        isSettingVisible,
        isSettingEnabled,
        configSchema,
    } from '$lib/config/schema';
    import { getSettingRestriction } from '$lib/utils/admin/setting-restrictions';
    import SettingInput from './SettingInput.svelte';
    import { settingMatchesSearch as matchesSearch } from '$lib/utils/admin/settings-search';
    import * as m from '$lib/paraglide/messages.js';
    import { helpTextSegments } from '$lib/utils/admin/help-text';

    interface Props {
        section: SectionDefinition;
        values: Record<string, unknown>;
        envOverrides: Set<string>;
        /** Keys saved in settings.json — an ENV-locked one then needs no "Save to config". */
        configFileKeys?: ReadonlySet<string>;
        /** ENV-locked keys queued to be copied into settings.json on save. */
        pendingPersistEnv?: readonly string[];
        collapsed?: boolean;
        searchQuery?: string;
        targetSettingKey?: string | null;
        forceExpanded?: boolean;
        /**
         * Whether the section header can be collapsed at all. Defaults to true,
         * preserving existing behaviour everywhere this is not passed. The
         * settings page shows exactly one section at a time (picked by the
         * left-hand section nav), so its chevron/toggle is dead weight there —
         * the page passes `collapsible={false}` and the section renders its
         * header plain, always expanded.
         */
        collapsible?: boolean;
        /** Reveal `uiHints.advanced` settings (driven by the page-level toggle). */
        showAdvanced?: boolean;
        /** Reveal `uiHints.devOnly` settings (dev/preprod deployments only). */
        devFeaturesEnabled?: boolean;
        /**
         * Render exactly this list instead of looking up `section.id` in the schema.
         * Used by cross-cutting audit panels (e.g. the Access page's "Group-based
         * rules" panel) that aggregate settings from OTHER sections under a synthetic
         * `section`. When set, the advanced/devOnly visibility flags above are
         * ignored entirely — the caller has already decided which settings to show
         * (an audit view intentionally bypasses the advanced-hidden toggle), and the
         * "N advanced hidden" count is suppressed accordingly.
         */
        settingsOverride?: SettingDefinition[];
        /**
         * Optional per-setting "origin chip" — a small badge linking back to the
         * setting's home settings page. Only meaningful alongside `settingsOverride`
         * (aggregate panels showing settings that don't actually belong to `section`).
         */
        originChipFor?: (setting: SettingDefinition) => { label: string; href: string } | undefined;
        // Callbacks
        onchange?: (detail: { key: string; value: unknown }) => void;
        onsaveEnvToConfig?: (detail: { key: string; value: unknown }) => void;
    }

    let {
        section,
        values,
        envOverrides,
        configFileKeys = new Set<string>(),
        pendingPersistEnv = [],
        collapsed = $bindable(false),
        searchQuery = '',
        targetSettingKey = null,
        forceExpanded = false,
        collapsible = true,
        showAdvanced = false,
        devFeaturesEnabled = false,
        settingsOverride,
        originChipFor,
        onchange,
        onsaveEnvToConfig,
    }: Props = $props();

    const MAX_NESTING_DEPTH = 4;

    // Handle saving ENV value to config
    function handleSaveEnvToConfig(key: string, value: unknown) {
        onsaveEnvToConfig?.({ key, value });
    }

    // Row-level filter during search. Must use the SAME matcher the page-level
    // section filter uses — if this one were narrower (e.g. ignoring option labels),
    // a query that keeps the section visible could still filter away every row and
    // render an empty card.
    function settingMatchesSearch(setting: SettingDefinition): boolean {
        return matchesSearch(setting, searchQuery, section);
    }

    // Handle setting change
    function handleSettingChange(key: string, value: unknown) {
        onchange?.({ key, value });
    }

    // Toggle section collapsed state
    function toggleCollapsed() {
        if (!collapsible) return;
        collapsed = !collapsed;
    }

    let headerClass = $derived(
        `w-full between p-4 text-left transition-colors ${
            collapsible ? 'hover:bg-surface-700/30 cursor-pointer' : ''
        }`,
    );

    // Toggle the feature flag
    function toggleFeatureFlag(e: Event) {
        e.stopPropagation();
        if (section.featureFlag && !featureFlagLocked) {
            onchange?.({
                key: section.featureFlag,
                value: !values[section.featureFlag],
            });
        }
    }

    // Get human-readable label for a dependency key
    function getDependencyLabel(key: string): string {
        const setting = configSchema.find((s) => s.key === key);
        return setting?.label || key;
    }

    type SettingHierarchy = {
        roots: SettingDefinition[];
        childrenByParent: SvelteMap<string, SettingDefinition[]>;
        settingsByKey: SvelteMap<string, SettingDefinition>;
        visibleSettings: SettingDefinition[];
    };

    function buildHierarchy(settings: SettingDefinition[]): SettingHierarchy {
        const settingsByKey = new SvelteMap<string, SettingDefinition>();
        const visibleSettings = settings.filter((s) => !s.uiHints?.hidden);

        for (const setting of visibleSettings) {
            settingsByKey.set(setting.key, setting);
        }

        const roots: SettingDefinition[] = [];
        const childrenByParent = new SvelteMap<string, SettingDefinition[]>();

        for (const setting of visibleSettings) {
            const parentKey = setting.dependsOn ?? setting.showWhen?.key;
            if (parentKey && settingsByKey.has(parentKey)) {
                const existing = childrenByParent.get(parentKey) || [];
                existing.push(setting);
                childrenByParent.set(parentKey, existing);
            } else {
                roots.push(setting);
            }
        }

        return { roots, childrenByParent, settingsByKey, visibleSettings };
    }

    // Build hierarchy for nested rendering. Settings hidden by the advanced/dev-only
    // visibility flags are filtered out here so the rendered rows and the section's
    // "N settings" count both update live when the toggle changes.
    let hierarchy = $derived(
        buildHierarchy(
            settingsOverride ??
                getVisibleSettingsBySection(section.id, { devFeaturesEnabled, showAdvanced }),
        ),
    );

    // Calculate total settings count (all non-hidden settings + feature toggle if not listed)
    let totalSettingsCount = $derived.by(() => {
        let count = hierarchy.visibleSettings.length;
        if (
            section.featureFlag &&
            !hierarchy.visibleSettings.some((setting) => setting.key === section.featureFlag)
        ) {
            count += 1;
        }
        return count;
    });

    // Advanced settings hidden by the page-level toggle — surfaced in the count
    // badge ("x settings · y advanced") so operators know the section has more
    // than what is currently rendered (owner request: the Live TV group read
    // "1 setting" while its substance sat behind the Advanced toggle).
    let advancedHiddenCount = $derived.by(() => {
        if (settingsOverride) return 0;
        if (showAdvanced) return 0;
        const withAdvanced = getVisibleSettingsBySection(section.id, {
            devFeaturesEnabled,
            showAdvanced: true,
        });
        return Math.max(0, withAdvanced.length - hierarchy.visibleSettings.length);
    });

    // The toggle in the header controls this setting — its own label (e.g. "Enable
    // Public API") rather than the section's ("Public API & Device Auth"), so the
    // toggle can be identified by assistive tech and matches what the settings
    // search box surfaces for it. Previously unlabelled: a screen reader announced
    // only "button", and there was nothing for a sighted user to read either.
    let featureFlagLabel = $derived(
        section.featureFlag ? getDependencyLabel(section.featureFlag) : '',
    );

    // Is the feature enabled?
    let featureEnabled = $derived(section.featureFlag ? !!values[section.featureFlag] : true);
    // Is the feature flag locked by ENV?
    let featureFlagLocked = $derived(
        section.featureFlag ? envOverrides.has(section.featureFlag) : false,
    );
    let isCollapsed = $derived(!collapsible ? false : forceExpanded ? false : collapsed);

    type SettingRow = {
        setting: SettingDefinition;
        depth: number;
        disabled: boolean;
        disabledReason?: string;
        disabledHref?: string;
    };

    let orderedSettings = $derived.by(() => {
        const rows: SettingRow[] = [];
        const searchActive = !!searchQuery.trim();
        const visited = new SvelteSet<string>();
        const matchCache = new SvelteMap<string, boolean>();

        function subtreeHasMatch(setting: SettingDefinition): boolean {
            if (!searchActive) return true;
            if (matchCache.has(setting.key)) {
                return matchCache.get(setting.key) || false;
            }
            matchCache.set(setting.key, false);
            const children = hierarchy.childrenByParent.get(setting.key) || [];
            const hasMatch = settingMatchesSearch(setting) || children.some(subtreeHasMatch);
            matchCache.set(setting.key, hasMatch);
            return hasMatch;
        }

        function addSetting(setting: SettingDefinition, depth: number, ancestorVisible: boolean) {
            if (!ancestorVisible || visited.has(setting.key)) return;
            visited.add(setting.key);

            if (searchActive && !subtreeHasMatch(setting)) {
                return;
            }

            if (
                !isSettingVisible(setting, values) &&
                !searchActive &&
                setting.key !== targetSettingKey
            ) {
                return;
            }

            const display = setting.key !== section.featureFlag;
            const restriction = getSettingRestriction(
                setting,
                values,
                section.featureFlag,
                settingsOverride ? [...configSchema, ...settingsOverride] : configSchema,
                devFeaturesEnabled,
            );
            const disabled = !!restriction || !featureEnabled || !isSettingEnabled(setting, values);
            const disabledReason = restriction?.reason;

            if (display) {
                rows.push({
                    setting,
                    depth: Math.min(depth, MAX_NESTING_DEPTH),
                    disabled,
                    disabledReason,
                    disabledHref: restriction?.href,
                });
            }

            const children = hierarchy.childrenByParent.get(setting.key) || [];
            const nextDepth = depth >= MAX_NESTING_DEPTH ? MAX_NESTING_DEPTH : depth + 1;
            for (const child of children) {
                addSetting(child, nextDepth, true);
            }
        }

        for (const root of hierarchy.roots) {
            addSetting(root, 0, true);
        }

        if (searchActive || targetSettingKey) {
            for (const setting of hierarchy.visibleSettings) {
                if (
                    !visited.has(setting.key) &&
                    (setting.key === targetSettingKey ||
                        (searchActive && settingMatchesSearch(setting)))
                ) {
                    addSetting(setting, 0, true);
                }
            }
        }
        return rows;
    });
</script>

<div
    id={`section-${section.id}`}
    class="section-card card-glass border border-surface-700 overflow-hidden !p-0"
    class:opacity-60={section.featureFlag && !featureEnabled}>
    <!-- Section Header -->
    {#snippet headerContent()}
        <div class="flex items-center gap-3">
            {#if collapsible}
                <Icon
                    src={isCollapsed ? ChevronRight : ChevronDown}
                    class="w-5 h-5 text-surface-400 transition-transform" />
            {/if}
            <div>
                <h3 class="text-base font-medium text-surface-200">
                    {section.label}
                </h3>
                <p class="text-hint mt-0.5">
                    {section.description}
                </p>
            </div>
        </div>
        <div class="flex items-center gap-3">
            {#if section.featureFlag}
                <!-- Feature toggle in header. The section label above it ("Public API
                     & Device Auth") is not always the toggle's own label ("Enable
                     Public API"), so a sighted user had nothing next to the switch
                     telling them what it does — this mirrors the aria-label below. -->
                <span class="hidden text-xs text-surface-400 sm:inline">{featureFlagLabel}</span>
                <button
                    id={`setting-${section.featureFlag}`}
                    type="button"
                    class="relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-hidden focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 focus:ring-offset-surface-800"
                    class:bg-primary-600={featureEnabled}
                    class:bg-surface-600={!featureEnabled}
                    class:opacity-50={featureFlagLocked}
                    class:cursor-not-allowed={featureFlagLocked}
                    onclick={toggleFeatureFlag}
                    aria-label={featureFlagLabel}
                    title={featureFlagLocked
                        ? 'Locked by environment variable'
                        : featureEnabled
                          ? 'Enabled'
                          : 'Disabled'}
                    disabled={featureFlagLocked}>
                    <span
                        class="pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out"
                        class:translate-x-5={featureEnabled}
                        class:translate-x-0={!featureEnabled}></span>
                </button>
            {/if}
            <span class="text-caption"
                >{totalSettingsCount === 1
                    ? m.admin_settings_count_one()
                    : m.admin_settings_count_many({
                          count: totalSettingsCount,
                      })}{advancedHiddenCount > 0
                    ? ` ${m.admin_settings_advanced_hidden({ count: advancedHiddenCount })}`
                    : ''}</span>
        </div>
    {/snippet}
    {#if collapsible}
        <div
            class={headerClass}
            onclick={toggleCollapsed}
            onkeydown={(e) => e.key === 'Enter' && toggleCollapsed()}
            role="button"
            tabindex={0}
            aria-expanded={!isCollapsed}>
            {@render headerContent()}
        </div>
    {:else}
        <div class={headerClass}>
            {@render headerContent()}
        </div>
    {/if}

    <!-- Section Content -->
    {#if !isCollapsed}
        <div class="px-4 pb-4 border-t border-surface-700/50" transition:slide={{ duration: 200 }}>
            {#if featureFlagLocked && section.featureFlag}
                <p class="mt-3 text-sm text-cyan-200">
                    {m.admin_settings_environment_override({ key: section.featureFlag })}
                </p>
            {/if}
            <!-- Help text if present -->
            {#if section.helpText}
                <div
                    class="help-text mt-3 mb-4 p-3 bg-blue-500/10 border border-blue-500/20 rounded-lg text-sm text-surface-300 whitespace-pre-wrap">
                    {#each helpTextSegments(section.helpText) as segment, i (i)}{#if segment.bold}<strong
                                class="font-semibold text-surface-100">{segment.text}</strong
                            >{:else}{segment.text}{/if}{/each}
                </div>
            {/if}

            {#if section.id === 'conn-trakt' || section.id === 'conn-mal'}
                {@const provider = section.id === 'conn-trakt' ? 'trakt' : 'mal'}
                {@const redirectUri = integrationRedirectUri(values.PUBLIC_BASE_URL, provider)}
                <div class="p-3 text-sm space-y-2">
                    {#if redirectUri}
                        <p>
                            {m.connections_redirect_uri({
                                provider: provider === 'trakt' ? 'Trakt' : 'MyAnimeList',
                            })}
                        </p>
                        <code class="block break-all select-all">{redirectUri}</code>
                    {:else}
                        <p>{m.connections_public_url_required()}</p>
                    {/if}
                </div>
            {/if}

            <div class="divide-y divide-surface-700/50">
                {#each orderedSettings as row (row.setting.key)}
                    <div
                        class="setting-row border-surface-700"
                        class:border-l-2={row.depth > 0}
                        class:pl-4={row.depth > 0}
                        style={row.depth > 0 ? `margin-left: ${row.depth * 24}px` : ''}>
                        <SettingInput
                            setting={row.setting}
                            value={values[row.setting.key]}
                            allValues={values}
                            envLocked={envOverrides.has(row.setting.key)}
                            inConfigFile={configFileKeys.has(row.setting.key)}
                            persistPending={pendingPersistEnv.includes(row.setting.key)}
                            disabled={row.disabled}
                            disabledReason={row.disabledReason}
                            disabledHref={row.disabledHref}
                            originChip={originChipFor?.(row.setting)}
                            onchange={(value: unknown) =>
                                handleSettingChange(row.setting.key, value)}
                            onsaveEnvToConfig={(value: unknown) =>
                                handleSaveEnvToConfig(row.setting.key, value)} />
                    </div>
                {/each}
            </div>
        </div>
    {/if}
</div>

<style>
    .section-card {
        margin-bottom: 1rem;
    }

    .setting-row {
        padding-top: 0.25rem;
    }

    /* Landing on a SECTION (search result for a section, or a setting row that a
       `showWhen` condition hid) previously added `.search-highlight` with no rule
       behind it, so the scroll happened with no visual confirmation. Mirrors
       SettingInput's row glow at card scale. */
    :global(.section-card.search-highlight) {
        animation: section-search-glow 3s ease-out;
    }

    @keyframes section-search-glow {
        0% {
            box-shadow: 0 0 0 2px rgb(250 204 21 / 0.9);
            background-color: rgb(250 204 21 / 0.1);
        }
        100% {
            box-shadow: 0 0 0 2px rgb(250 204 21 / 0);
            background-color: rgb(250 204 21 / 0);
        }
    }

    @media (prefers-reduced-motion: reduce) {
        :global(.section-card.search-highlight) {
            animation: none;
            box-shadow: 0 0 0 2px rgb(250 204 21 / 0.9);
        }
    }
</style>
