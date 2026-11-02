<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  The ONE identity workbench (admin IA redesign, spec §3.2). Replaces
  Library → "Unmatched Files", Media browser → "Unidentified", and
  /admin/operations/reidentify with two scoped views:
    - Never matched (?view=never, default) — personal files, never had any
      external id. Auto-Identify is the page's primary action here.
    - Broken match (?view=broken) — was matched once, the provider lookup
      now fails permanently. Fix match / Not-on-TMDB actions.
  ?library=<libraryGroupId> scopes both views and both badges to one library;
  it survives view switches and pagination because every URL write here and in
  the panels starts from the current URL.
-->
<script lang="ts">
    import { page } from '$app/state';
    import { goto } from '$app/navigation';
    import { AdminPageHeader } from '$lib/components/admin/index.js';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons.js';
    import Tabs, { type TabItem } from '$lib/components/ui/Tabs.svelte';
    import NeverMatchedPanel from '$lib/components/admin/library/NeverMatchedPanel.svelte';
    import BrokenMatchPanel from '$lib/components/admin/library/BrokenMatchPanel.svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { tabItemsOf } from '$lib/config/admin-search-meta';
    import { searchMeta } from './search-meta';
    import type { PageData } from './$types';

    let { data }: { data: PageData } = $props();

    // Tab ids match the ?view= values other surfaces already deep-link with
    // (attention adapters' gave-up sourceRef, the pipeline "gave up" chip,
    // HealthStrip's needs-reidentification chip) — 'never' has no query
    // param (the default), 'broken' is `?view=broken`. Do not rename.
    //
    // Both totals start from the server load so each tab shows its count
    // whichever view is open; the mounted panel then keeps its own in sync
    // (search/filter changes, removals, pagination).
    // Writable deriveds, not $state: a library switch re-runs the load, and the
    // badges must follow the new scope instead of keeping the first load's counts.
    let neverTotal = $derived<number | null>(data.neverMatchedTotal);
    let brokenTotal = $derived(data.brokenMatch.total);
    let brokenFiltered = $derived(!!data.brokenMatch.search || !!data.brokenMatch.mediaType);

    let viewTabs = $derived<TabItem[]>(
        tabItemsOf(searchMeta).map((tab) => ({
            ...tab,
            badge:
                tab.id === 'never'
                    ? // A filtered panel reports its FILTERED total — keep the badge on
                      // the unfiltered count the tab stands for.
                      neverTotal && neverTotal > 0
                        ? neverTotal
                        : undefined
                    : brokenTotal > 0
                      ? brokenTotal
                      : undefined,
        })),
    );
    // Seeded from the URL, not left to <Tabs>: Tabs reads ?view= during its own
    // init, but a bound value written by a child during SSR does not reach this
    // component's already-rendered branch below — the server rendered the
    // Never-matched panel (with a false "All clear") under a selected "Broken
    // match" pill, and hydration swapped it a moment later.
    let activeView = $state(page.url.searchParams.get('view') === 'broken' ? 'broken' : 'never');

    function setLibrary(id: string | null): void {
        // The VISIBLE url: <Tabs> writes ?view= with a shallow replaceState,
        // which `page.url` does not see — building from it would drop the view.
        const url = new URL(window.location.href);
        if (id) url.searchParams.set('library', id);
        else url.searchParams.delete('library');
        url.searchParams.delete('offset');
        void goto(url, { keepFocus: true, noScroll: true });
    }
</script>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/library/fix-matches']}
        title={m.route_admin_fix_matches_title()}
        description={m.route_admin_fix_matches_description()} />

    {#if data.libraries.length > 0}
        <div class="flex flex-wrap items-center gap-2">
            <label class="inline-flex items-center gap-2 text-xs text-surface-400">
                <span class="sr-only">{m.media_picker_library()}</span>
                <select
                    class="rounded-lg border border-surface-700 bg-surface-800/60 px-3 py-2 text-sm text-surface-100 focus:border-yellow-500 focus:outline-none"
                    value={data.libraryGroupId ?? ''}
                    onchange={(e) => setLibrary(e.currentTarget.value || null)}>
                    <option value="">{m.media_picker_all_libraries()}</option>
                    {#each data.libraries as library (library.id)}
                        <option value={library.id}>{library.name}</option>
                    {/each}
                </select>
            </label>
            {#if data.libraryGroupId}
                <button
                    type="button"
                    class="text-xs font-medium text-yellow-300 hover:text-yellow-200"
                    onclick={() => setLibrary(null)}>{m.admin_fix_matches_library_clear()}</button>
            {/if}
        </div>
    {/if}

    <Tabs
        items={viewTabs}
        bind:active={activeView}
        syncToUrl
        urlParam="view"
        variant="pills"
        size="sm" />

    {#if activeView === 'broken'}
        <BrokenMatchPanel
            data={data.brokenMatch}
            ontotalchange={(t) => {
                if (!brokenFiltered) brokenTotal = t;
            }} />
    {:else}
        <NeverMatchedPanel
            libraryGroupId={data.libraryGroupId ?? undefined}
            ontotalchange={(t, filtered) => {
                if (!filtered) neverTotal = t;
            }} />
    {/if}
</div>
