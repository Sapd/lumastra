<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { onMount } from 'svelte';
    import { SvelteSet } from 'svelte/reactivity';
    import { getLocale } from '$lib/paraglide/runtime.js';
    import {
        defaultLineupCountries,
        displayRegionCode,
    } from '$lib/shared/livetv-lineup-defaults.js';
    import { getSetupSummary, applySetupPreferences } from '$lib/api/livetv';
    import type { SetupSummary } from '$lib/schemas/livetv';
    import type { ImportResult } from '$lib/types/livetv.js';
    import { toasts } from '$lib/stores/toast.store';
    import { Icon, ArrowPath, CheckCircle, Cog6Tooth } from 'svelte-hero-icons';

    interface Props {
        sourceId: string;
        importResult?: ImportResult;
        onComplete: () => void;
        /**
         * True when re-running setup on a source that already has an arrangement
         * (vs. the first run right after import). Drives the "this discards your
         * current arrangement" warning.
         */
        isReconfigure?: boolean;
    }

    let { sourceId, importResult, onComplete, isReconfigure = false }: Props = $props();

    // State
    let summary = $state<SetupSummary | null>(null);
    let loading = $state(true);
    let applying = $state(false);
    let completed = $state(false);

    // Form state
    /** Countries/regions to keep; empty keeps every country. */
    const countries = new SvelteSet<string>();
    /** Pre-selected chips stay in view after a deselect, so they can be picked again. */
    const pinnedRegions = new SvelteSet<string>();
    let includeUntagged = $state(true);
    let hideLoopChannels = $state(true);
    // Defaults for a first run: screens and lists no viewer wants. Event slots
    // stay: during a match they are the only way to it, and Live TV collapses
    // each family into one card.
    const NOISE_DEFAULTS = {
        hideInfoChannels: true,
        hideEventSlots: false,
        hideLocalStations: true,
        hideRadio: true,
    } as const;
    let hideInfoChannels = $state<boolean>(NOISE_DEFAULTS.hideInfoChannels);
    let hideEventSlots = $state<boolean>(NOISE_DEFAULTS.hideEventSlots);
    let hideLocalStations = $state<boolean>(NOISE_DEFAULTS.hideLocalStations);
    let hideRadio = $state<boolean>(NOISE_DEFAULTS.hideRadio);
    const hiddenCategories = new SvelteSet<string>();
    let channelOrder = $state<'traditional' | 'sports-first'>('traditional');
    let preferHighQuality = $state(true);
    let showAllRegions = $state(false);
    let categoryQuery = $state('');

    // Result
    let resultVisible = $state(0);
    let resultCategories = $state(0);

    const REGION_PREVIEW = 18;
    const regions = $derived(summary?.regions ?? []);
    // The largest countries, plus every selected one: a pre-selected country
    // further down the list must not be selected out of sight.
    const shownRegions = $derived(
        showAllRegions || regions.length <= REGION_PREVIEW + 2
            ? regions
            : regions.filter(
                  (r, i) =>
                      i < REGION_PREVIEW || countries.has(r.code) || pinnedRegions.has(r.code),
              ),
    );
    const filteredCategories = $derived.by(() => {
        const q = categoryQuery.trim().toLowerCase();
        const all = summary?.categories ?? [];
        return q ? all.filter((c) => c.name.toLowerCase().includes(q)) : all;
    });

    let regionNames: Intl.DisplayNames | null = null;
    try {
        regionNames = new Intl.DisplayNames([getLocale()], { type: 'region' });
    } catch {
        regionNames = null;
    }

    function regionLabel(code: string): string {
        switch (code) {
            case 'arab':
                return m.livetv_admin_setup_region_arab();
            case 'exyu':
                return m.livetv_admin_setup_region_exyu();
            case 'kurd':
                return m.livetv_admin_setup_region_kurd();
            case 'religious':
                return m.livetv_admin_setup_region_religious();
            case 'adult':
                return m.livetv_admin_setup_region_adult();
        }
        const iso = displayRegionCode(code);
        return (iso && regionNames?.of(iso)) || code.toUpperCase();
    }

    function toggleCountry(code: string): void {
        if (countries.has(code)) countries.delete(code);
        else countries.add(code);
    }

    function toggleCategory(name: string): void {
        if (hiddenCategories.has(name)) hiddenCategories.delete(name);
        else hiddenCategories.add(name);
    }

    function prefill(loaded: SetupSummary): void {
        const available = (loaded.regions ?? []).map((r) => r.code);
        const saved = loaded.savedSetup;
        countries.clear();
        hiddenCategories.clear();
        if (saved) {
            // Only codes the provider still has: an invisible selected code
            // could not be unselected and would hide everything else.
            for (const c of saved.countries) if (available.includes(c)) countries.add(c);
            for (const c of saved.hiddenCategories) hiddenCategories.add(c);
            includeUntagged = saved.includeUntagged;
            hideLoopChannels = saved.hideLoopChannels;
            // Choices stored before a switch existed leave it at its default.
            hideInfoChannels = saved.hideInfoChannels ?? NOISE_DEFAULTS.hideInfoChannels;
            hideEventSlots = saved.hideEventSlots ?? NOISE_DEFAULTS.hideEventSlots;
            hideLocalStations = saved.hideLocalStations ?? NOISE_DEFAULTS.hideLocalStations;
            hideRadio = saved.hideRadio ?? NOISE_DEFAULTS.hideRadio;
            if (saved.channelOrder) channelOrder = saved.channelOrder;
            if (saved.preferHighQuality !== undefined) preferHighQuality = saved.preferHighQuality;
            return;
        }
        // First run: the admin's own languages decide (German + English →
        // Germany, Austria, Switzerland, UK, US...), limited to what the
        // provider carries. Adult and religious channels are never pre-picked.
        const languages =
            typeof navigator !== 'undefined' && navigator.languages?.length
                ? navigator.languages
                : [getLocale()];
        for (const c of defaultLineupCountries(languages, available)) countries.add(c);
        // Nothing matched but the list is tagged: keep everything except the
        // opt-in groups rather than hiding the whole provider.
        if (countries.size === 0 && available.some((c) => c === 'adult' || c === 'religious')) {
            for (const c of available) if (c !== 'adult' && c !== 'religious') countries.add(c);
        }
    }

    const hasMultipleQualities = $derived(
        summary
            ? [
                  summary.qualityDistribution.uhd,
                  summary.qualityDistribution.fhd,
                  summary.qualityDistribution.hd,
                  summary.qualityDistribution.sd,
              ].filter((n) => n > 0).length > 1
            : false,
    );

    async function loadSummary(): Promise<void> {
        loading = true;
        try {
            const result = await getSetupSummary(sourceId);
            if (result.data) {
                summary = result.data;
                prefill(result.data);
                for (const c of countries) pinnedRegions.add(c);
            } else {
                toasts.error(m.livetv_admin_setup_load_failed());
            }
        } catch {
            toasts.error(m.livetv_admin_setup_load_failed());
        } finally {
            loading = false;
        }
    }

    async function handleApply(): Promise<void> {
        applying = true;
        try {
            const result = await applySetupPreferences(sourceId, {
                countries: [...countries],
                includeUntagged,
                // Only what the admin could see and change.
                hideLoopChannels: (summary?.loopChannelCount ?? 0) > 0 && hideLoopChannels,
                hideInfoChannels: (summary?.infoChannelCount ?? 0) > 0 && hideInfoChannels,
                hideEventSlots: (summary?.eventSlotCount ?? 0) > 0 && hideEventSlots,
                hideLocalStations: (summary?.localStationCount ?? 0) > 0 && hideLocalStations,
                hideRadio: (summary?.radioChannelCount ?? 0) > 0 && hideRadio,
                hiddenCategories: [...hiddenCategories],
                channelOrder,
                preferHighQuality,
            });
            if (result.data) {
                resultVisible = result.data.visibleChannels;
                resultCategories = result.data.categories;
                completed = true;
            } else {
                toasts.error(m.livetv_admin_setup_apply_failed());
            }
        } catch {
            toasts.error(m.livetv_admin_setup_apply_failed());
        } finally {
            applying = false;
        }
    }

    onMount(() => {
        void loadSummary();
    });
</script>

<div class="bg-surface-800 border border-surface-700 rounded-lg p-6 space-y-6">
    <!-- Header -->
    <div>
        <div class="flex items-center gap-2 mb-1">
            <Icon src={Cog6Tooth} class="w-5 h-5 text-yellow-400" />
            <h3 class="text-lg font-semibold text-white">
                {m.livetv_admin_setup_title()}
            </h3>
        </div>
        <p class="text-sm text-surface-400">
            {m.livetv_admin_setup_subtitle()}
        </p>
    </div>

    {#if loading}
        <div class="p-8 text-center text-surface-400">
            <Icon src={ArrowPath} class="w-6 h-6 mx-auto animate-spin mb-2" />
        </div>
    {:else if completed}
        <!-- Completion State -->
        <div class="text-center py-6">
            <Icon src={CheckCircle} class="w-12 h-12 mx-auto text-green-400 mb-3" />
            <h4 class="text-lg font-medium text-white mb-2">
                {m.livetv_admin_setup_complete_title()}
            </h4>
            <p class="text-surface-300">
                {m.livetv_admin_setup_complete_message({
                    visible: String(resultVisible),
                    categories: String(resultCategories),
                })}
            </p>
            <div class="flex items-center justify-center gap-3 mt-6">
                <button
                    type="button"
                    class="btn bg-surface-700 hover:bg-surface-600 text-white"
                    onclick={onComplete}>
                    {m.livetv_admin_setup_done()}
                </button>
            </div>
        </div>
    {:else if summary}
        <!-- Destructive / one-time nature of the guided setup -->
        {#if isReconfigure}
            <div
                class="bg-amber-900/30 border border-amber-700/50 rounded-lg p-3 text-sm text-amber-200">
                ⚠️ {m.livetv_admin_setup_reconfigure_warning()}
            </div>
        {/if}
        <p class="text-xs text-surface-400 leading-relaxed">
            {m.livetv_admin_setup_onetime_note()}
        </p>

        <!-- Import Results Summary -->
        <div class="bg-surface-900/50 rounded-lg p-4">
            <h4 class="text-sm font-medium text-surface-300 mb-3">
                {m.livetv_admin_setup_import_summary()}
            </h4>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {#if importResult}
                    <div class="text-center">
                        <div class="text-xl font-bold text-white">
                            {importResult.channelCount}
                        </div>
                        <div class="text-xs text-surface-400">Channels</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-white">
                            {importResult.backupGroupCount}
                        </div>
                        <div class="text-xs text-surface-400">Backup Groups</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-white">
                            {importResult.epgMatchCount}
                        </div>
                        <div class="text-xs text-surface-400">EPG Matches</div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-white">
                            {importResult.categoryCount}
                        </div>
                        <div class="text-xs text-surface-400">Categories</div>
                    </div>
                {:else}
                    <div class="text-center">
                        <div class="text-xl font-bold text-white">
                            {summary.totalChannels}
                        </div>
                        <div class="text-xs text-surface-400">
                            {m.livetv_admin_setup_channels_count({
                                count: String(summary.totalChannels),
                            })}
                        </div>
                    </div>
                    <div class="text-center">
                        <div class="text-xl font-bold text-white">
                            {summary.categories.length}
                        </div>
                        <div class="text-xs text-surface-400">
                            {m.livetv_admin_setup_categories_count({
                                count: String(summary.categories.length),
                            })}
                        </div>
                    </div>
                {/if}
            </div>
        </div>

        <!-- Import Warnings -->
        {#if importResult?.warnings && importResult.warnings.length > 0}
            <div class="bg-yellow-900/30 border border-yellow-700/50 rounded-lg p-4">
                <h4 class="text-sm font-medium text-yellow-300 mb-2">
                    {importResult.warnings.length} warning{importResult.warnings.length === 1
                        ? ''
                        : 's'}
                </h4>
                <div class="max-h-40 overflow-y-auto space-y-1">
                    {#each importResult.warnings as warning, i (i)}
                        <p class="text-xs text-yellow-200/70">{warning}</p>
                    {/each}
                </div>
            </div>
        {/if}

        <!-- Import Errors -->
        {#if importResult?.errors && importResult.errors.length > 0}
            <div class="bg-red-900/30 border border-red-700/50 rounded-lg p-4">
                <h4 class="text-sm font-medium text-red-300 mb-2">
                    {importResult.errors.length} error{importResult.errors.length === 1 ? '' : 's'}
                </h4>
                <div class="max-h-40 overflow-y-auto space-y-1">
                    {#each importResult.errors as error (error)}
                        <p class="text-xs text-red-200/70">{error}</p>
                    {/each}
                </div>
            </div>
        {/if}

        <!-- Q1: Countries -->
        <div class="space-y-3">
            <div>
                <h4 class="text-sm font-medium text-white">
                    {m.livetv_admin_setup_countries_title()}
                </h4>
                <p class="text-xs text-surface-400 mt-0.5">
                    {regions.length > 0
                        ? m.livetv_admin_setup_countries_description()
                        : m.livetv_admin_setup_countries_none()}
                </p>
            </div>
            {#if regions.length > 0}
                <div
                    class="flex flex-wrap gap-2"
                    role="group"
                    aria-label={m.livetv_admin_setup_countries_title()}>
                    {#each shownRegions as region (region.code)}
                        <button
                            type="button"
                            aria-pressed={countries.has(region.code)}
                            class="min-h-9 rounded-full px-3 py-1.5 text-sm transition-colors
                                {countries.has(region.code)
                                ? 'bg-yellow-500 text-surface-900'
                                : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
                            onclick={() => toggleCountry(region.code)}>
                            {regionLabel(region.code)}
                            <span class="opacity-70">{region.channelCount}</span>
                        </button>
                    {/each}
                    {#if shownRegions.length < regions.length}
                        <button
                            type="button"
                            class="min-h-9 rounded-full px-3 py-1.5 text-sm text-yellow-400 hover:underline"
                            onclick={() => (showAllRegions = true)}>
                            {m.livetv_admin_setup_countries_more({
                                count: regions.length - shownRegions.length,
                            })}
                        </button>
                    {/if}
                </div>
                <p class="text-xs text-surface-500">
                    {countries.size === 0
                        ? regions.some((r) => r.code === 'adult')
                            ? m.livetv_admin_setup_countries_all_adult()
                            : m.livetv_admin_setup_countries_all()
                        : m.livetv_admin_setup_countries_selected({ count: countries.size })}
                    {#if countries.size > 0}
                        · <button
                            type="button"
                            class="text-yellow-400 hover:underline"
                            onclick={() => countries.clear()}
                            >{m.livetv_admin_setup_countries_clear()}</button>
                    {/if}
                </p>
                {#if countries.size > 0 && (summary.untaggedChannelCount ?? 0) > 0}
                    <label class="flex items-center gap-3 cursor-pointer">
                        <input
                            type="checkbox"
                            bind:checked={includeUntagged}
                            class="w-5 h-5 rounded bg-surface-700 border-surface-600 text-yellow-500 focus:ring-yellow-500/30" />
                        <span class="text-sm text-surface-300">
                            {m.livetv_admin_setup_include_untagged({
                                count: summary.untaggedChannelCount ?? 0,
                            })}
                        </span>
                    </label>
                {/if}
            {/if}
            {#if (summary.loopChannelCount ?? 0) > 0}
                <label class="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        bind:checked={hideLoopChannels}
                        class="w-5 h-5 rounded bg-surface-700 border-surface-600 text-yellow-500 focus:ring-yellow-500/30" />
                    <span class="text-sm text-surface-300">
                        {m.livetv_admin_setup_hide_loop({ count: summary.loopChannelCount ?? 0 })}
                    </span>
                </label>
            {/if}
            {#if (summary.infoChannelCount ?? 0) > 0}
                <label class="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        bind:checked={hideInfoChannels}
                        class="w-5 h-5 rounded bg-surface-700 border-surface-600 text-yellow-500 focus:ring-yellow-500/30" />
                    <span class="text-sm text-surface-300">
                        {m.livetv_admin_setup_hide_info({ count: summary.infoChannelCount ?? 0 })}
                    </span>
                </label>
            {/if}
            {#if (summary.radioChannelCount ?? 0) > 0}
                <label class="flex items-center gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        bind:checked={hideRadio}
                        class="w-5 h-5 rounded bg-surface-700 border-surface-600 text-yellow-500 focus:ring-yellow-500/30" />
                    <span class="text-sm text-surface-300">
                        {m.livetv_admin_setup_hide_radio({ count: summary.radioChannelCount ?? 0 })}
                    </span>
                </label>
            {/if}
            {#if (summary.localStationCount ?? 0) > 0}
                <label class="flex items-start gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        bind:checked={hideLocalStations}
                        class="mt-0.5 w-5 h-5 rounded bg-surface-700 border-surface-600 text-yellow-500 focus:ring-yellow-500/30" />
                    <span class="text-sm text-surface-300">
                        {m.livetv_admin_setup_hide_local_stations({
                            count: summary.localStationCount ?? 0,
                        })}
                        <span class="block text-xs text-surface-500">
                            {m.livetv_admin_setup_hide_local_stations_hint()}
                        </span>
                    </span>
                </label>
            {/if}
            {#if (summary.eventSlotCount ?? 0) > 0}
                <label class="flex items-start gap-3 cursor-pointer">
                    <input
                        type="checkbox"
                        bind:checked={hideEventSlots}
                        class="mt-0.5 w-5 h-5 rounded bg-surface-700 border-surface-600 text-yellow-500 focus:ring-yellow-500/30" />
                    <span class="text-sm text-surface-300">
                        {m.livetv_admin_setup_hide_event_slots({
                            count: summary.eventSlotCount ?? 0,
                        })}
                        <span class="block text-xs text-surface-500">
                            {m.livetv_admin_setup_hide_event_slots_hint()}
                        </span>
                    </span>
                </label>
            {/if}
            {#if summary.categories.length > 1}
                <details class="rounded-lg bg-surface-900/50 p-3">
                    <summary class="cursor-pointer text-sm text-surface-300">
                        {m.livetv_admin_setup_categories_title()}
                        {#if hiddenCategories.size > 0}
                            <span class="text-surface-500">
                                · {m.livetv_admin_setup_categories_hidden({
                                    count: hiddenCategories.size,
                                })}
                            </span>
                        {/if}
                    </summary>
                    <input
                        type="search"
                        bind:value={categoryQuery}
                        placeholder={m.livetv_admin_setup_categories_search()}
                        aria-label={m.livetv_admin_setup_categories_search()}
                        class="input mt-3 w-full text-sm" />
                    <ul class="mt-2 max-h-64 space-y-1 overflow-y-auto">
                        {#each filteredCategories as category (category.name)}
                            <li>
                                <label class="flex cursor-pointer items-center gap-3 py-1">
                                    <input
                                        type="checkbox"
                                        checked={!hiddenCategories.has(category.name)}
                                        onchange={() => toggleCategory(category.name)}
                                        class="w-4 h-4 rounded bg-surface-700 border-surface-600 text-yellow-500 focus:ring-yellow-500/30" />
                                    <span class="flex-1 truncate text-sm text-surface-300"
                                        >{category.name}</span>
                                    <span class="text-xs text-surface-500"
                                        >{category.channelCount}</span>
                                </label>
                            </li>
                        {/each}
                    </ul>
                </details>
            {/if}
        </div>

        <!-- Q2: Channel Order -->
        <div class="space-y-3">
            <h4 class="text-sm font-medium text-white">
                {m.livetv_admin_setup_order_title()}
            </h4>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <button
                    type="button"
                    class="px-4 py-3 rounded-lg text-left transition-colors
                        {channelOrder === 'traditional'
                        ? 'bg-yellow-500 text-surface-900'
                        : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
                    onclick={() => {
                        channelOrder = 'traditional';
                    }}>
                    <div class="font-medium text-sm">
                        {m.livetv_admin_setup_order_traditional()}
                    </div>
                    <div
                        class="text-xs mt-0.5 {channelOrder === 'traditional'
                            ? 'text-surface-800'
                            : 'text-surface-400'}">
                        {m.livetv_admin_setup_order_traditional_desc()}
                    </div>
                </button>
                <button
                    type="button"
                    class="px-4 py-3 rounded-lg text-left transition-colors
                        {channelOrder === 'sports-first'
                        ? 'bg-yellow-500 text-surface-900'
                        : 'bg-surface-700 text-surface-300 hover:bg-surface-600'}"
                    onclick={() => {
                        channelOrder = 'sports-first';
                    }}>
                    <div class="font-medium text-sm">
                        {m.livetv_admin_setup_order_sports()}
                    </div>
                    <div
                        class="text-xs mt-0.5 {channelOrder === 'sports-first'
                            ? 'text-surface-800'
                            : 'text-surface-400'}">
                        {m.livetv_admin_setup_order_sports_desc()}
                    </div>
                </button>
            </div>
        </div>

        <!-- Q3: Quality Preference -->
        <div class="space-y-3">
            <div>
                <h4 class="text-sm font-medium text-white">
                    {m.livetv_admin_setup_quality_title()}
                </h4>
                <p class="text-xs text-surface-400 mt-0.5">
                    {m.livetv_admin_setup_quality_description()}
                </p>
            </div>
            <label class="flex items-center gap-3 cursor-pointer">
                <input
                    type="checkbox"
                    bind:checked={preferHighQuality}
                    class="w-5 h-5 rounded bg-surface-700 border-surface-600 text-yellow-500 focus:ring-yellow-500/30" />
                <span class="text-sm text-surface-300"
                    >{m.livetv_admin_setup_quality_prefer_high()}</span>
            </label>
            {#if hasMultipleQualities && preferHighQuality}
                <p class="text-xs text-surface-500">
                    {m.livetv_admin_setup_quality_description()}
                </p>
            {/if}
        </div>

        <!-- Apply Button -->
        <div class="pt-2">
            <button
                type="button"
                class="btn w-full bg-yellow-500 hover:bg-yellow-400 text-surface-900 font-medium flex items-center justify-center gap-2"
                disabled={applying}
                onclick={() => void handleApply()}>
                {#if applying}
                    <Icon src={ArrowPath} class="w-4 h-4 animate-spin" />
                    {m.livetv_admin_setup_applying()}
                {:else}
                    {m.livetv_admin_setup_apply()}
                {/if}
            </button>
        </div>
    {/if}
</div>
