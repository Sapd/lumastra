<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * Admin Providers Page
     *
     * Slimmed per the admin IA redesign (spec §3.6): metadata chain +
     * provider config + connection settings only. The full registry dump
     * ("Library & Integration Services") is gone — Settings → Plugins &
     * features and the Developer registry are the curated/complete views of
     * that data now. "Optional dependencies" status also moved off this page
     * — System → Health owns status everywhere (see the link in
     * `afterSections` below).
     *
     * Displays provider dashboard grouped by category:
     * 1. Operation mode banner
     * 2. Metadata Provider Chain (drag-and-drop reorder)
     * 3. Metadata Providers (enable/disable, health)
     * 4. AI Services
     * 5. Field Authorities table (read-only, collapsed)
     */
    import { flip } from 'svelte/animate';
    import { dndzone } from 'svelte-dnd-action';
    import {
        Icon,
        ArrowPath,
        TableCells,
        Bolt,
        Bars3,
        ChevronUp,
        ChevronDown,
        ChevronRight,
        XMark,
        Plus,
        LockClosed,
    } from 'svelte-hero-icons';
    import type { PageData, ActionData } from './$types';
    import { toasts } from '$lib/stores/toast.store';
    import { afterNavigate, invalidateAll } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import * as adminApi from '$lib/api/admin';
    import { AdminPageHeader, AdminSettingsPage } from '$lib/components/admin';
    import * as m from '$lib/paraglide/messages.js';

    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import { openPluginSettings } from '$lib/stores/plugin-settings-open.store';
    import { tick } from 'svelte';
    import ProviderCategorySection from '$lib/components/admin/providers/ProviderCategorySection.svelte';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();

    // Reactive state from server data
    let providerConfig = $derived(data.providerConfig);
    let providers = $derived(data.providers ?? []);
    let fieldAuthorities = $derived(data.fieldAuthorities ?? []);
    let metadataChain = $derived(
        data.metadataChain ?? { chain: [], addable: [], envLocked: false },
    );
    let checkableIds = $derived(new Set(data.checkableIds ?? []));

    // Grouped providers by category. Health-check/enable-toggle/settings UI
    // for each card now lives in the shared `ProviderCategorySection`
    // (admin IA redesign — the same card renders here AND on Settings →
    // Plugins & features' Integrations section; "registry renders once").
    let metadataProviders = $derived(providers.filter((p) => p.category === 'metadata'));

    let savingChain = $state(false);

    // Deep-link support: an admin alert's "Configure" action or the command
    // palette lands here with `?settings=<providerId>`; the provider's settings
    // panel expands under its card. Runs in afterNavigate (post-hydration);
    // the param is stripped so a refresh/back does not reopen it.
    afterNavigate(({ to }) => {
        // Guard `to` itself, not just the param: `to` is null on an external
        // navigation, and `new URL(to.url)` below dereferenced it unguarded.
        if (!to) return;
        const target = to.url.searchParams.get('settings');
        if (!target) return;
        const url = new URL(to.url);
        url.searchParams.delete('settings');
        window.history.replaceState(window.history.state, '', url);

        const provider = providers.find((p) => p.provider === target);
        if (!provider) {
            toasts.error(m.admin_extensions_plugin_not_found({ id: target }));
            return;
        }
        openPluginSettings.set(provider.provider);
        void tick().then(() => {
            const el = document.getElementById(`settings-card-${provider.provider}`);
            if (!el) return;
            el.scrollIntoView({ block: 'center' });
            el.classList.add('settings-card-highlight');
            window.setTimeout(() => el.classList.remove('settings-card-highlight'), 2200);
        });
    });

    // Summary stats — only what this page shows. Counting the whole registry
    // (tasks, media sources, watch syncs) put "116 providers" above 7 cards.
    let metadataConfigured = $derived(metadataProviders.filter((p) => p.configured).length);

    // Providers without a settings modal of their own, and where they ARE set up.
    const configureLinks = {
        'tmdb-metadata-provider': {
            href: '/admin/settings/providers?section=metadata&highlight=TMDB_API_KEY',
            label: m.admin_providers_configure_key_below(),
        },
        'mdblist-metadata-provider': {
            href: '/admin/settings/providers?section=metadata&highlight=MDBLIST_API_KEY',
            label: m.admin_providers_configure_key_below(),
        },
        'jellyfin-metadata-provider': {
            href: '/admin/settings/connections?section=conn-jellyfin&highlight=JELLYFINURL',
            label: m.admin_providers_configure_via_jellyfin(),
        },
    };

    // Metadata source order. Each item is a METADATA_PROVIDERS entry
    // ('tmdb', 'mdblist', …); 'aggregated' is implicit and always first.
    interface ChainDndItem {
        id: string;
    }

    const SOURCE_LABELS: Record<string, string> = {
        tmdb: 'TMDB',
        mdblist: 'MDBList',
        imdb: 'IMDb',
        trakt: 'Trakt',
        tvdb: 'TheTVDB',
        mal: 'MyAnimeList',
    };
    function sourceLabel(id: string): string {
        return SOURCE_LABELS[id] ?? id;
    }
    function sourceDescription(id: string): string {
        if (id === 'tmdb') return m.admin_providers_source_tmdb();
        if (id === 'mdblist') return m.admin_providers_source_mdblist();
        return '';
    }

    // Writable derived: follows the server's chain, and drag/arrow moves
    // overwrite it optimistically until the save's invalidateAll re-derives it.
    let chainItems = $derived<ChainDndItem[]>(metadataChain.chain.map((id) => ({ id })));
    let flipDurationMs = 200;

    async function saveChain(next: string[]): Promise<void> {
        savingChain = true;
        const { error } = await adminApi.reorderMetadataChain(next);
        savingChain = false;
        if (error) {
            toasts.error(m.admin_providers_reorder_failed({ error }));
        } else {
            toasts.success(m.admin_toast_metadata_chain_reordered());
        }
        await invalidateAll(); // server state either way
    }

    function handleChainConsider(e: CustomEvent<{ items: ChainDndItem[] }>): void {
        chainItems = e.detail.items;
    }

    async function handleChainFinalize(e: CustomEvent<{ items: ChainDndItem[] }>): Promise<void> {
        chainItems = e.detail.items;
        const next = chainItems.map((item) => item.id);
        if (next.join(',') === metadataChain.chain.join(',')) return;
        await saveChain(next);
    }

    // Arrow buttons: the keyboard/touch-friendly way to reorder.
    async function moveSource(index: number, delta: -1 | 1): Promise<void> {
        const next = chainItems.map((item) => item.id);
        const target = index + delta;
        if (target < 0 || target >= next.length) return;
        [next[index], next[target]] = [next[target], next[index]];
        chainItems = next.map((id) => ({ id }));
        await saveChain(next);
    }

    async function removeSource(id: string): Promise<void> {
        await saveChain(chainItems.map((item) => item.id).filter((p) => p !== id));
    }

    async function addSource(id: string): Promise<void> {
        await saveChain([...chainItems.map((item) => item.id), id]);
    }

    // Field authority search
    let fieldSearch = $state('');
    let filteredFieldAuthorities = $derived(
        fieldSearch
            ? fieldAuthorities.filter(
                  (fa) =>
                      fa.fieldName.toLowerCase().includes(fieldSearch.toLowerCase()) ||
                      fa.provider.toLowerCase().includes(fieldSearch.toLowerCase()),
              )
            : fieldAuthorities,
    );
</script>

<svelte:head>
    <title>{m.admin_nav_page_settings_providers()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <!-- Header -->
    <AdminPageHeader
        icon={adminPageIcons['/admin/settings/providers']}
        title={m.admin_nav_page_settings_providers()}
        description={m.admin_providers_description()} />

    {#if data.loadError}
        <div
            role="alert"
            class="rounded border border-red-800/60 bg-red-950/40 px-4 py-3 text-sm text-red-300">
            Provider settings could not be loaded: {data.loadError}
        </div>
    {/if}

    <nav
        aria-label={m.admin_providers_sections()}
        class="sticky top-2 z-10 flex gap-1 lg:top-16 overflow-x-auto rounded-lg border border-surface-700/70 bg-surface-950/90 p-1 backdrop-blur">
        <a
            class="inline-flex min-h-10 shrink-0 items-center rounded px-3 text-xs text-surface-300 hover:bg-surface-800"
            href="#chain">{m.admin_providers_nav_chain()}</a>
        <a
            class="inline-flex min-h-10 shrink-0 items-center rounded px-3 text-xs text-surface-300 hover:bg-surface-800"
            href="#providers">{m.admin_providers_nav_providers()}</a>
        {#if fieldAuthorities.length > 0}
            <a
                class="inline-flex min-h-10 shrink-0 items-center rounded px-3 text-xs text-surface-300 hover:bg-surface-800"
                href="#authorities">{m.admin_providers_nav_authorities()}</a>
        {/if}
        <a
            class="inline-flex min-h-10 shrink-0 items-center rounded px-3 text-xs text-surface-300 hover:bg-surface-800"
            href="#connection">{m.admin_providers_nav_connection()}</a>
    </nav>

    <!-- Summary Stats -->
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div class="card-base text-center">
            <p class="text-2xl font-bold text-white">
                {metadataConfigured}
                <span class="text-base font-medium text-surface-500"
                    >{m.providers_stat_of_total({ total: metadataProviders.length })}</span>
            </p>
            <p class="text-caption">{m.providers_stat_metadata_configured()}</p>
        </div>
        <div class="card-base text-center">
            <p class="text-2xl font-bold text-cyan-400">{metadataChain.chain.length}</p>
            <p class="text-caption">{m.providers_stat_in_chain()}</p>
        </div>
    </div>

    <!-- B. Metadata source order (METADATA_PROVIDERS) -->
    <div id="chain" class="card-bordered scroll-mt-16 lg:scroll-mt-32">
        <div class="flex items-center justify-between mb-4">
            <h3 class="text-lg font-semibold flex items-center gap-2">
                <Icon src={Bolt} class="w-5 h-5 text-yellow-400" />
                {m.providers_heading_metadata_chain()}
            </h3>
            {#if savingChain}
                <span class="text-xs text-surface-400 flex items-center gap-1">
                    <Icon src={ArrowPath} class="w-3 h-3 animate-spin" />
                    {m.providers_status_saving()}
                </span>
            {/if}
        </div>

        <p class="text-sm text-surface-400 mb-3">{m.admin_providers_chain_reorder_hint()}</p>

        {#if metadataChain.envLocked}
            <p
                class="mb-3 flex items-center gap-2 rounded border border-amber-700/40 bg-amber-900/20 px-3 py-2 text-sm text-amber-200">
                <Icon src={LockClosed} class="w-4 h-4 shrink-0" />
                {m.admin_providers_chain_env_locked()}
            </p>
        {/if}

        {#if chainItems.length > 0}
            <ol
                class="flex flex-col gap-2"
                aria-label={m.providers_heading_metadata_chain()}
                use:dndzone={{
                    items: chainItems,
                    flipDurationMs,
                    type: 'metadata-chain',
                    dragDisabled: metadataChain.envLocked || savingChain,
                }}
                onconsider={handleChainConsider}
                onfinalize={handleChainFinalize}>
                {#each chainItems as item, i (item.id)}
                    <li
                        class="flex items-center gap-3 px-4 py-3 rounded-lg bg-surface-800/50 border border-surface-700/50
                               hover:border-yellow-700/50 hover:bg-surface-800 transition-colors
                               {metadataChain.envLocked
                            ? ''
                            : 'cursor-grab active:cursor-grabbing'}"
                        animate:flip={{ duration: flipDurationMs }}>
                        {#if !metadataChain.envLocked}
                            <Icon src={Bars3} class="w-4 h-4 text-surface-500 shrink-0" />
                        {/if}
                        <span class="text-sm font-mono text-yellow-300/80 w-6 text-right">
                            {i + 1}.
                        </span>
                        <span class="min-w-0 flex-1">
                            <span class="font-medium text-white">{sourceLabel(item.id)}</span>
                            {#if sourceDescription(item.id)}
                                <span class="block text-xs text-surface-400"
                                    >{sourceDescription(item.id)}</span>
                            {/if}
                        </span>
                        {#if !metadataChain.envLocked}
                            <span class="flex shrink-0 items-center gap-1">
                                <button
                                    type="button"
                                    class="rounded p-1.5 text-surface-400 hover:bg-surface-700 hover:text-white disabled:opacity-30"
                                    aria-label={m.admin_providers_chain_move_up({
                                        source: sourceLabel(item.id),
                                    })}
                                    disabled={i === 0 || savingChain}
                                    onclick={() => moveSource(i, -1)}>
                                    <Icon src={ChevronUp} class="w-4 h-4" />
                                </button>
                                <button
                                    type="button"
                                    class="rounded p-1.5 text-surface-400 hover:bg-surface-700 hover:text-white disabled:opacity-30"
                                    aria-label={m.admin_providers_chain_move_down({
                                        source: sourceLabel(item.id),
                                    })}
                                    disabled={i === chainItems.length - 1 || savingChain}
                                    onclick={() => moveSource(i, 1)}>
                                    <Icon src={ChevronDown} class="w-4 h-4" />
                                </button>
                                <button
                                    type="button"
                                    class="rounded p-1.5 text-surface-400 hover:bg-surface-700 hover:text-red-300 disabled:opacity-30"
                                    aria-label={m.admin_providers_chain_remove({
                                        source: sourceLabel(item.id),
                                    })}
                                    disabled={chainItems.length <= 1 || savingChain}
                                    onclick={() => removeSource(item.id)}>
                                    <Icon src={XMark} class="w-4 h-4" />
                                </button>
                            </span>
                        {/if}
                    </li>
                {/each}
            </ol>
        {:else}
            <p class="text-surface-500 text-sm">{m.admin_providers_none_configured()}</p>
        {/if}

        {#if !metadataChain.envLocked && metadataChain.addable.length > 0}
            <div class="mt-3 flex flex-wrap gap-2">
                {#each metadataChain.addable as id (id)}
                    <button
                        type="button"
                        class="inline-flex items-center gap-1 rounded-md border border-dashed border-surface-600 px-3 py-1.5 text-xs text-surface-300 hover:border-surface-400 hover:text-white disabled:opacity-50"
                        disabled={savingChain}
                        onclick={() => addSource(id)}>
                        <Icon src={Plus} class="w-3.5 h-3.5" />
                        {m.admin_providers_chain_add({ source: sourceLabel(id) })}
                    </button>
                {/each}
            </div>
        {/if}

        <!-- Key providers -->
        <div class="flex flex-wrap gap-3 text-sm mt-4 pt-4 border-t border-surface-700/50">
            <div class="flex items-center gap-1.5">
                <span class="text-surface-500">{m.providers_label_primary_id()}</span>
                <span class="badge-soft-cyan">{providerConfig.primaryExternalId}</span>
            </div>
            <div class="flex items-center gap-1.5">
                <span class="text-surface-500">{m.providers_label_images()}</span>
                <span class="badge-soft-blue">{providerConfig.primaryImageProvider}</span>
            </div>
            <div class="flex items-center gap-1.5">
                <span class="text-surface-500">{m.providers_label_search()}</span>
                <span class="badge-soft-purple">{providerConfig.primarySearchProvider}</span>
            </div>
        </div>
    </div>

    <!-- C. Metadata Providers -->
    {#if metadataProviders.length > 0}
        <div id="providers" class="scroll-mt-16 lg:scroll-mt-32">
            <ProviderCategorySection
                title={m.providers_section_metadata_providers()}
                description={m.providers_desc_metadata_providers()}
                icon={Bolt}
                iconClass="text-yellow-400"
                providers={metadataProviders}
                {checkableIds}
                {configureLinks} />
        </div>
    {/if}

    <!-- F. Field Authorities Table — read-only reference, collapsed by default.
         It used to appear only while the connection form's Advanced switch was
         on, so flipping a switch in one card silently added a section above
         it. The collapsed <details> already keeps it out of the way. -->
    {#if fieldAuthorities.length > 0}
        <details id="authorities" class="group mt-8 scroll-mt-16 lg:scroll-mt-32">
            <summary class="cursor-pointer list-none text-lg font-semibold text-white">
                <span class="inline-flex items-center gap-2">
                    <Icon
                        src={ChevronRight}
                        class="w-4 h-4 text-surface-400 transition-transform group-open:rotate-90" />
                    <Icon src={TableCells} class="w-5 h-5 text-purple-400" />
                    {m.providers_heading_field_authorities()}
                    <span class="text-sm font-normal text-surface-500"
                        >({fieldAuthorities.length})</span>
                </span>
            </summary>

            <div class="mt-4">
                <div class="mb-4 flex justify-end">
                    <input
                        type="text"
                        bind:value={fieldSearch}
                        placeholder={m.admin_placeholder_filter_fields()}
                        class="w-48 rounded-lg border border-surface-600 bg-surface-700 px-3 py-1.5 text-sm text-white placeholder-surface-500" />
                </div>

                <div class="card-bordered overflow-x-auto">
                    <table class="w-full text-sm">
                        <thead>
                            <tr class="border-b border-surface-700">
                                <th class="text-left py-2 px-3 text-surface-400 font-medium"
                                    >{m.providers_col_field()}</th>
                                <th class="text-left py-2 px-3 text-surface-400 font-medium"
                                    >{m.providers_col_provider()}</th>
                                <th class="text-left py-2 px-3 text-surface-400 font-medium"
                                    >{m.providers_col_priority()}</th>
                                <th class="text-left py-2 px-3 text-surface-400 font-medium"
                                    >{m.providers_col_media_type()}</th>
                                <th class="text-left py-2 px-3 text-surface-400 font-medium"
                                    >{m.providers_col_anime()}</th>
                            </tr>
                        </thead>
                        <tbody>
                            {#each filteredFieldAuthorities as fa (fa.fieldName + fa.provider + (fa.mediaType ?? '') + String(fa.isAnime ?? ''))}
                                <tr class="border-b border-surface-700/50 hover:bg-surface-800/50">
                                    <td class="py-2 px-3 text-white font-mono">{fa.fieldName}</td>
                                    <td class="py-2 px-3">
                                        <span class="badge-soft-cyan">{fa.provider}</span>
                                    </td>
                                    <td class="py-2 px-3 text-surface-300">{fa.priority}</td>
                                    <td class="py-2 px-3 text-surface-400"
                                        >{fa.mediaType ?? m.providers_fallback_all()}</td>
                                    <td class="py-2 px-3 text-surface-400"
                                        >{fa.isAnime === true
                                            ? m.providers_fallback_yes()
                                            : fa.isAnime === false
                                              ? m.providers_fallback_no()
                                              : '—'}</td>
                                </tr>
                            {/each}
                        </tbody>
                    </table>
                </div>

                <p class="text-hint mt-2">
                    {m.admin_providers_field_authorities_hint()}
                </p>
            </div>
        </details>
    {/if}

    <div id="connection" class="scroll-mt-16 lg:scroll-mt-32">
        <AdminSettingsPage
            {data}
            {form}
            icon={adminPageIcons['/admin/settings/providers']}
            heading={m.admin_providers_connection_heading()}
            description={m.admin_providers_connection_description()}>
            {#snippet afterSections()}
                <div
                    class="mt-6 rounded border border-surface-700/60 bg-surface-900/30 px-4 py-3 text-sm">
                    <p class="text-surface-300">{m.admin_providers_dependency_status_moved()}</p>
                    <a
                        href={resolve('/admin/system/health#dependencies')}
                        class="mt-1 inline-block text-xs font-medium text-sky-400 hover:text-sky-300">
                        {m.admin_providers_view_health()}
                    </a>
                </div>
            {/snippet}
        </AdminSettingsPage>
    </div>
</div>
