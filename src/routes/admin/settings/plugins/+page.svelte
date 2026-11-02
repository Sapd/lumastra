<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Settings → Plugins & features (admin IA redesign, spec §3.6). Feature
  plugins with settings, watch-sync providers, integration connections, and
  external plugin install/reload — an OPERATOR page (not Developer). The
  full plugin/task registry dump lives at Developer → Registry instead.
-->
<script lang="ts">
    import { Icon, Cog6Tooth, PuzzlePiece, FolderOpen, ArrowPath, Eye } from 'svelte-hero-icons';
    import type { PageData } from './$types';
    import { AdminPageHeader, SearchInput } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import ProviderCategorySection from '$lib/components/admin/providers/ProviderCategorySection.svelte';
    import PluginSettingsPanel from '$lib/components/admin/PluginSettingsPanel.svelte';
    import { openPluginSettings } from '$lib/stores/plugin-settings-open.store';
    import { tick } from 'svelte';
    import { toasts } from '$lib/stores/toast.store';
    import { adminStatus } from '$lib/stores/admin-status.store.svelte.js';
    import { afterNavigate, invalidateAll } from '$app/navigation';
    import * as m from '$lib/paraglide/messages.js';
    import { reloadPlugins } from '$lib/api/admin.js';
    import type { PluginReloadResponse } from '$lib/schemas/api-admin-responses.js';
    import ExternalPluginCard from '$lib/components/admin/plugins/ExternalPluginCard.svelte';
    import ExternalPluginInstallForm from '$lib/components/admin/plugins/ExternalPluginInstallForm.svelte';
    import PluginCatalog from '$lib/components/admin/plugins/PluginCatalog.svelte';

    interface Props {
        data: PageData;
    }

    let { data }: Props = $props();

    let featurePlugins = $derived(data.featurePlugins ?? []);
    let watchSyncPlugins = $derived(data.watchSyncPlugins ?? []);
    let externalPlugins = $derived(data.externalPlugins ?? []);
    let externalPluginsEnabled = $derived(data.externalPluginsEnabled ?? false);
    let installEnabled = $derived(data.installEnabled ?? false);
    let trustedKeysConfigured = $derived(data.trustedKeysConfigured ?? false);
    let externalPluginsError = $derived(data.externalPluginsError ?? false);
    let integrationProviders = $derived(data.integrationProviders ?? []);
    let checkableIds = $derived(new Set(data.checkableIds ?? []));
    // Integrations whose connection is a host setting link to it instead of a
    // settings modal (they have none of their own).
    let integrationLinks = $derived(
        Object.fromEntries(
            Object.entries(data.integrationSetup ?? {}).map(([id, setup]) => [
                id,
                {
                    href: setup.href,
                    label:
                        setup.status === 'ready'
                            ? m.admin_plugins_page_edit_connection()
                            : m.admin_plugins_page_set_up_connection(),
                },
            ]),
        ),
    );

    let externalEnabledCount = $derived(externalPlugins.filter((p) => p.enabled).length);
    let externalLoadedCount = $derived(externalPlugins.filter((p) => p.loaded).length);
    let externalRestartCount = $derived(externalPlugins.filter((p) => p.restartRequired).length);

    // Settings expand inline under the plugin's card (the same components as
    // the host settings pages), one card at a time.
    function toggleSettings(pluginId: string): void {
        openPluginSettings.update((current) => (current === pluginId ? null : pluginId));
    }

    function openSettingsForTarget(target: string): boolean {
        const known =
            [...featurePlugins, ...watchSyncPlugins].some((p) => p.id === target) ||
            integrationProviders.some((p) => p.provider === target);
        if (!known) {
            toasts.error(m.admin_extensions_plugin_not_found({ id: target }));
            return false;
        }
        openPluginSettings.set(target);
        return true;
    }

    // Scroll the deep-linked card into view and briefly highlight it.
    function revealCard(target: string): void {
        const el = document.getElementById(`settings-card-${target}`);
        if (!el) return;
        el.scrollIntoView({ block: 'center' });
        el.classList.add('settings-card-highlight');
        window.setTimeout(() => el.classList.remove('settings-card-highlight'), 2200);
    }

    // Deep-link support: an admin alert's "Configure" action or the command
    // palette lands here with `?settings=<pluginId>` to open that plugin's
    // settings panel. Runs in afterNavigate (post-hydration, router ready);
    // the param is stripped with the native History API so a refresh/back does
    // not reopen it.
    afterNavigate(({ to }) => {
        // Guard `to` itself, not just the param: `to` is null on an external
        // navigation, and `new URL(to.url)` below dereferenced it unguarded.
        if (!to) return;
        const target = to.url.searchParams.get('settings');
        if (!target) return;
        const url = new URL(to.url);
        url.searchParams.delete('settings');
        window.history.replaceState(window.history.state, '', url);
        if (openSettingsForTarget(target)) {
            void tick().then(() => revealCard(target));
        }
    });

    let totalBuiltinPlugins = $derived(featurePlugins.length + watchSyncPlugins.length);

    // A plugin only lands here (registry has no per-plugin enable flag; runtime
    // gating is inside isAvailable(ctx), which this load-time listing can't
    // call without a full PluginContext) once it registered successfully, so
    // every built-in row is "Active" — there is no per-plugin disable state to
    // show instead. "Needs attention" is scoped to what IS independently
    // knowable and actionable here: an external plugin that failed to load, or
    // one whose enable/disable/uninstall only takes effect after a restart.
    let needsAttentionCount = $derived(
        externalPlugins.filter((p) => !!p.error || p.restartRequired).length,
    );

    // One-line descriptions for built-in plugins. Neither FeatureDefinition
    // nor WatchSyncDefinition carries a description field, so these are
    // curated here (mirrors the task-descriptions.ts pattern) rather than
    // read off the definition — there is nothing on it to read.
    const builtinPluginDescriptions: Partial<Record<string, () => string>> = {
        'holiday-recommendations': m.admin_plugins_page_desc_holiday_recommendations,
        dummy: m.admin_plugins_page_desc_dummy,
        announcement: m.admin_plugins_page_desc_announcement,
        shoutbox: m.admin_plugins_page_desc_shoutbox,
        'jellyfin-watch-sync': m.admin_plugins_page_desc_jellyfin,
        'audiobookshelf-watch-sync': m.admin_plugins_page_desc_audiobookshelf,
        'mal-watch-sync': m.admin_plugins_page_desc_mal,
        'trakt-watch-sync': m.admin_plugins_page_desc_trakt,
    };
    function describePlugin(plugin: { id: string; description: string }): string {
        return plugin.description || builtinPluginDescriptions[plugin.id]?.() || '';
    }

    // Search/filter — only surfaced once the page has enough rows across all
    // sections to be worth filtering (spec: "if there are more than ~8
    // plugins"). Filtering an empty query is a no-op, so the derived arrays
    // below are safe to use unconditionally even while the box is hidden.
    let pluginSearchQuery = $state('');
    let totalFilterableItems = $derived(
        featurePlugins.length +
            watchSyncPlugins.length +
            integrationProviders.length +
            externalPlugins.length,
    );
    function matchesSearch(name: string): boolean {
        const q = pluginSearchQuery.trim().toLowerCase();
        return q === '' || name.toLowerCase().includes(q);
    }
    let filteredFeaturePlugins = $derived(featurePlugins.filter((p) => matchesSearch(p.name)));
    let filteredWatchSyncPlugins = $derived(watchSyncPlugins.filter((p) => matchesSearch(p.name)));
    let filteredIntegrationProviders = $derived(
        integrationProviders.filter((p) => matchesSearch(p.label)),
    );
    let filteredExternalPlugins = $derived(externalPlugins.filter((p) => matchesSearch(p.name)));
    let hasAnySearchResults = $derived(
        filteredFeaturePlugins.length +
            filteredWatchSyncPlugins.length +
            filteredIntegrationProviders.length +
            filteredExternalPlugins.length >
            0,
    );

    // Hot-load reload state. Synchronous guard — no parallel invocations.
    let reloading = $state(false);

    async function refreshPluginState(): Promise<void> {
        await Promise.all([invalidateAll(), adminStatus.forceRefresh()]);
    }

    async function handleReloadPlugins(): Promise<void> {
        if (reloading) return;
        reloading = true;
        try {
            const { data: reloadResult, error } = await reloadPlugins();
            if (error) {
                toasts.error(error);
                return;
            }
            const reloadData = reloadResult as PluginReloadResponse | null;
            const count = reloadData?.newlyLoaded.length ?? 0;
            if (count === 0) {
                toasts.info(m.admin_toast_no_new_plugins_found());
            } else {
                toasts.success(
                    m.admin_extensions_loaded_new({
                        count,
                        plugins: (reloadData?.newlyLoaded ?? []).join(', '),
                    }),
                );
            }
            const errorCount =
                (reloadData?.errors?.length ?? 0) + (reloadData?.sdkImportErrors?.length ?? 0);
            if (errorCount > 0) {
                const hint =
                    (reloadData?.sdkImportErrors?.length ?? 0) > 0
                        ? m.admin_extensions_reload_hint_sdk()
                        : m.admin_extensions_reload_hint_logs();
                toasts.warning(
                    m.admin_extensions_load_errors({
                        count: errorCount,
                        hint,
                    }),
                );
            }
            if (reloadData?.validationError) {
                toasts.warning(
                    m.admin_extensions_validation_failed({ error: reloadData.validationError }),
                );
            }
            // Refresh the listing so newly-loaded plugins appear without a full
            // page reload. Re-runs the +page.server.ts load fn.
            await refreshPluginState();
        } finally {
            reloading = false;
        }
    }
</script>

<svelte:head>
    <title>{m.admin_nav_page_settings_plugins()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/settings/plugins']}
        title={m.admin_nav_page_settings_plugins()}
        description={m.admin_nav_desc_settings_plugins()} />

    <!-- Summary Stats -->
    {#if totalBuiltinPlugins > 0 || externalPlugins.length > 0}
        <div class="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div class="card-base text-center">
                <p class="text-2xl font-bold text-white">
                    {totalBuiltinPlugins + externalPlugins.length}
                </p>
                <p class="text-caption">{m.admin_plugins_page_stat_total()}</p>
            </div>
            <div class="card-base text-center">
                <p class="text-2xl font-bold text-blue-400">
                    {externalPlugins.length}
                </p>
                <p class="text-caption">{m.admin_extensions_external()}</p>
            </div>
            <div class="card-base text-center">
                <p
                    class="text-2xl font-bold {needsAttentionCount > 0
                        ? 'text-amber-400'
                        : 'text-green-400'}">
                    {needsAttentionCount}
                </p>
                <p class="text-caption">{m.admin_plugins_page_stat_needs_attention()}</p>
            </div>
        </div>
    {/if}

    {#if externalRestartCount > 0}
        <div role="alert" class="section-warning space-y-2">
            <h2 class="font-semibold">{m.plugins_external_restart_pending_title()}</h2>
            <p>{m.plugins_external_restart_pending_detail()}</p>
        </div>
    {/if}

    <!-- Search — only worth showing once there's enough to filter -->
    {#if totalFilterableItems > 8}
        <div>
            <SearchInput
                bind:value={pluginSearchQuery}
                placeholder={m.admin_plugins_page_search_placeholder()} />
            {#if pluginSearchQuery.trim() && !hasAnySearchResults}
                <p class="text-hint mt-2">
                    {m.admin_plugins_page_search_no_results({ query: pluginSearchQuery.trim() })}
                </p>
            {/if}
        </div>
    {/if}

    <!-- Feature Plugins -->
    {#if filteredFeaturePlugins.length > 0}
        <div>
            <div class="between mb-4">
                <div>
                    <h3 class="text-lg font-semibold flex items-center gap-2">
                        <Icon src={PuzzlePiece} class="w-5 h-5 text-green-400" />
                        {m.admin_extensions_feature_plugins()}
                    </h3>
                    <p class="text-muted text-sm">
                        {m.admin_extensions_feature_plugins_desc()}
                    </p>
                </div>
            </div>
            <div class="grid gap-4">
                {#each filteredFeaturePlugins as plugin (plugin.id)}
                    <div id="settings-card-{plugin.id}" class="card-base">
                        <div class="flex flex-wrap items-start justify-between gap-3">
                            <div class="min-w-0 flex-1 space-y-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h4 class="text-lg font-medium text-white">{plugin.name}</h4>
                                    {#if plugin.version}
                                        <span class="text-sm text-surface-400"
                                            >v{plugin.version}</span>
                                    {/if}
                                    <span
                                        class="inline-flex items-center rounded-full bg-surface-700 px-2 py-0.5 text-xs font-medium text-surface-300">
                                        {m.admin_plugins_page_source_builtin()}
                                    </span>
                                    {#if plugin.setup?.status === 'off'}
                                        <span
                                            class="inline-flex items-center rounded-full bg-surface-700 px-2 py-0.5 text-xs font-medium text-surface-400">
                                            {m.admin_plugins_page_status_off()}
                                        </span>
                                    {:else}
                                        <span
                                            class="inline-flex items-center rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-400">
                                            {m.admin_plugins_page_status_active()}
                                        </span>
                                    {/if}
                                </div>
                                {#if describePlugin(plugin)}
                                    <p class="text-sm text-surface-400">{describePlugin(plugin)}</p>
                                {/if}
                            </div>
                            {#if plugin.setup?.status === 'off'}
                                <!-- Turned off by an admin setting: link straight to it. -->
                                <a
                                    href={plugin.setup.href}
                                    class="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-surface-600 bg-surface-800 px-3 py-2 text-sm font-medium text-surface-200 transition-colors hover:bg-surface-700 hover:text-white">
                                    <Icon src={Cog6Tooth} class="w-4 h-4" />
                                    {m.admin_plugins_page_turn_on()}
                                </a>
                            {:else if plugin.hasSettings}
                                <button
                                    type="button"
                                    class="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-surface-600 bg-surface-800 px-3 py-2 text-sm font-medium text-surface-200 transition-colors hover:bg-surface-700 hover:text-white"
                                    aria-expanded={$openPluginSettings === plugin.id}
                                    onclick={() => toggleSettings(plugin.id)}>
                                    <Icon src={Cog6Tooth} class="w-4 h-4" />
                                    {m.settings()}
                                </button>
                            {/if}
                        </div>
                        {#if plugin.hasSettings && $openPluginSettings === plugin.id}
                            <div class="mt-4">
                                <PluginSettingsPanel
                                    pluginId={plugin.id}
                                    heading={m.plugin_settings_title({ name: plugin.name })}
                                    onClose={() => openPluginSettings.set(null)} />
                            </div>
                        {/if}
                    </div>
                {/each}
            </div>
        </div>
    {/if}

    <!-- Watch-sync providers -->
    {#if filteredWatchSyncPlugins.length > 0}
        <div>
            <div class="between mb-4">
                <div>
                    <h3 class="text-lg font-semibold flex items-center gap-2">
                        <Icon src={Eye} class="w-5 h-5 text-indigo-400" />
                        {m.admin_extensions_watch_sync()}
                    </h3>
                    <p class="text-muted text-sm">{m.admin_extensions_watch_sync_desc()}</p>
                </div>
            </div>
            <div class="grid gap-4">
                {#each filteredWatchSyncPlugins as plugin (plugin.id)}
                    <div id="settings-card-{plugin.id}" class="card-base">
                        <div class="flex flex-wrap items-start justify-between gap-3">
                            <div class="min-w-0 flex-1 space-y-1">
                                <div class="flex flex-wrap items-center gap-2">
                                    <h4 class="text-lg font-medium text-white">{plugin.name}</h4>
                                    {#if plugin.version}
                                        <span class="text-sm text-surface-400"
                                            >v{plugin.version}</span>
                                    {/if}
                                    <span
                                        class="inline-flex items-center rounded-full bg-surface-700 px-2 py-0.5 text-xs font-medium text-surface-300">
                                        {m.admin_plugins_page_source_builtin()}
                                    </span>
                                    <!-- Whether its host connection is set up — "Active"
                                         was claimed for every registered sync. -->
                                    {#if plugin.setup?.status === 'ready'}
                                        <span
                                            class="inline-flex items-center rounded-full bg-green-500/15 px-2 py-0.5 text-xs font-medium text-green-400">
                                            {m.admin_plugins_page_status_ready()}
                                        </span>
                                    {:else if plugin.setup?.status === 'off'}
                                        <span
                                            class="inline-flex items-center rounded-full bg-surface-700 px-2 py-0.5 text-xs font-medium text-surface-400">
                                            {m.admin_plugins_page_status_off()}
                                        </span>
                                    {:else if plugin.setup}
                                        <span
                                            class="inline-flex items-center rounded-full bg-amber-500/15 px-2 py-0.5 text-xs font-medium text-amber-300">
                                            {m.admin_plugins_page_status_not_set_up()}
                                        </span>
                                    {/if}
                                </div>
                                {#if describePlugin(plugin)}
                                    <p class="text-sm text-surface-400">{describePlugin(plugin)}</p>
                                {/if}
                            </div>
                            {#if plugin.hasSettings}
                                <button
                                    type="button"
                                    class="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-surface-600 bg-surface-800 px-3 py-2 text-sm font-medium text-surface-200 transition-colors hover:bg-surface-700 hover:text-white"
                                    aria-expanded={$openPluginSettings === plugin.id}
                                    onclick={() => toggleSettings(plugin.id)}>
                                    <Icon src={Cog6Tooth} class="w-4 h-4" />
                                    {m.settings()}
                                </button>
                            {:else if plugin.setup}
                                <a
                                    href={plugin.setup.href}
                                    class="inline-flex min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-surface-600 bg-surface-800 px-3 py-2 text-sm font-medium text-surface-200 transition-colors hover:bg-surface-700 hover:text-white">
                                    <Icon src={Cog6Tooth} class="w-4 h-4" />
                                    {plugin.setup.status === 'ready'
                                        ? m.admin_plugins_page_edit_connection()
                                        : m.admin_plugins_page_set_up_connection()}
                                </a>
                            {/if}
                        </div>
                        {#if plugin.hasSettings && $openPluginSettings === plugin.id}
                            <div class="mt-4">
                                <PluginSettingsPanel
                                    pluginId={plugin.id}
                                    heading={m.plugin_settings_title({ name: plugin.name })}
                                    onClose={() => openPluginSettings.set(null)} />
                            </div>
                        {/if}
                    </div>
                {/each}
            </div>
        </div>
    {/if}

    <!-- Integrations (connection cards — moved from the Providers page's
         former "Library & Integration Services" section, spec §3.6) -->
    {#if filteredIntegrationProviders.length > 0}
        <ProviderCategorySection
            title={m.admin_extensions_integrations()}
            description={m.admin_extensions_integrations_desc()}
            icon={Cog6Tooth}
            iconClass="text-emerald-400"
            providers={filteredIntegrationProviders}
            {checkableIds}
            configureLinks={integrationLinks} />
    {/if}

    {#if totalBuiltinPlugins === 0 && integrationProviders.length === 0}
        <div class="card-base text-center py-12">
            <Icon src={Cog6Tooth} class="w-12 h-12 text-surface-600 mx-auto mb-4" />
            <h3 class="text-lg font-semibold">{m.admin_extensions_none()}</h3>
            <p class="text-surface-500">
                {m.admin_extensions_none_desc()}
            </p>
        </div>
    {/if}

    <!-- External Plugins -->
    <div class="mt-12 pt-8 border-t border-surface-700">
        <div class="between mb-6">
            <div>
                <h2 class="text-2xl font-semibold flex items-center gap-2">
                    <Icon src={PuzzlePiece} class="w-7 h-7 text-blue-400" />
                    {m.admin_extensions_external_plugins()}
                </h2>
                <p class="text-muted mt-1">{m.admin_extensions_external_plugins_desc()}</p>
            </div>
            {#if externalPluginsEnabled}
                <button
                    type="button"
                    class="btn-secondary text-sm inline-flex items-center gap-2"
                    onclick={handleReloadPlugins}
                    disabled={reloading}
                    title={m.admin_extensions_reload_tooltip()}>
                    <Icon src={ArrowPath} class="w-4 h-4 {reloading ? 'animate-spin' : ''}" />
                    {reloading ? m.admin_extensions_reloading() : m.admin_extensions_reload()}
                </button>
            {/if}
        </div>

        {#if !externalPluginsEnabled}
            <div class="section-info">
                <h4 class="text-sm font-medium text-cyan-300 mb-2">
                    {m.admin_extensions_disabled_title()}
                </h4>
                <p class="text-hint">
                    {m.admin_extensions_disabled_set()}
                    <code class="bg-surface-800 px-1 rounded">PLUGINS_ENABLED=true</code>
                    {m.admin_extensions_disabled_mount()}
                    <code class="bg-surface-800 px-1 rounded">/app/plugins</code>
                    {m.admin_extensions_disabled_enable()}
                </p>
            </div>
        {:else}
            <div class="space-y-4">
                {#if data.multiNode}
                    <p class="text-caption">{m.plugins_external_per_replica_note()}</p>
                {/if}

                <ExternalPluginInstallForm
                    {installEnabled}
                    {trustedKeysConfigured}
                    onchanged={refreshPluginState} />

                <PluginCatalog
                    repositories={data.repositories ?? []}
                    catalog={data.catalog ?? []}
                    {installEnabled}
                    {trustedKeysConfigured}
                    onchanged={refreshPluginState} />

                {#if externalPluginsError}
                    <div class="section-error">{m.plugins_external_registry_error()}</div>
                {/if}

                {#if externalPlugins.length === 0}
                    {#if !externalPluginsError}
                        <div class="card-base text-center py-12">
                            <Icon
                                src={FolderOpen}
                                class="w-12 h-12 text-surface-600 mx-auto mb-4" />
                            <h3 class="text-lg font-medium text-surface-400 mb-2">
                                {m.admin_extensions_no_external_installed()}
                            </h3>
                            <p class="text-surface-500 mb-4">
                                {m.admin_extensions_drop_folders()}
                            </p>
                            <div class="text-sm text-surface-500">
                                <p>{m.admin_extensions_folder_should_contain()}</p>
                                <code
                                    class="block mt-2 bg-surface-800 p-2 rounded text-left max-w-md mx-auto">
                                    /app/plugins/my-plugin/<br />
                                    ├── manifest.json<br />
                                    └── index.js
                                </code>
                            </div>
                        </div>
                    {/if}
                {:else if filteredExternalPlugins.length === 0}
                    <!-- Real plugins exist, the search just doesn't match any of
                         them — distinct from the "none installed" empty state
                         above, which would misleadingly suggest dropping in
                         folders is the fix. -->
                    <p class="text-hint">
                        {m.admin_plugins_page_search_no_results({
                            query: pluginSearchQuery.trim(),
                        })}
                    </p>
                {:else}
                    <div class="grid gap-4">
                        {#each filteredExternalPlugins as plugin (plugin.id)}
                            <ExternalPluginCard {plugin} onchanged={refreshPluginState} />
                        {/each}
                    </div>

                    <div class="grid grid-cols-2 sm:grid-cols-4 gap-4 mt-2">
                        <div class="card-base text-center">
                            <p class="text-2xl font-bold text-white">{externalPlugins.length}</p>
                            <p class="text-caption">{m.plugins_external_tile_total()}</p>
                        </div>
                        <div class="card-base text-center">
                            <p class="text-2xl font-bold text-green-400">{externalEnabledCount}</p>
                            <p class="text-caption">{m.plugins_external_tile_enabled()}</p>
                        </div>
                        <div class="card-base text-center">
                            <p class="text-2xl font-bold text-blue-400">{externalLoadedCount}</p>
                            <p class="text-caption">{m.plugins_external_tile_loaded()}</p>
                        </div>
                        <div class="card-base text-center">
                            <p class="text-2xl font-bold text-amber-400">{externalRestartCount}</p>
                            <p class="text-caption">{m.plugins_external_tile_restart()}</p>
                        </div>
                    </div>
                {/if}
            </div>
        {/if}
    </div>
</div>
