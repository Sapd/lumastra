<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Settings → Live TV (admin IA redesign, spec §3.6): Sources, Channels and
  Proxy are tabs on ONE page instead of separate routes. Radio stations
  moved to Settings → Music (internet radio is a music feature).
-->
<script lang="ts">
    import Tabs, { type TabItem } from '$lib/components/ui/Tabs.svelte';
    import LiveTvSourcesTab from '$lib/components/admin/settings-pages/livetv/LiveTvSourcesTab.svelte';
    import LiveTvChannelsTab from '$lib/components/admin/settings-pages/livetv/LiveTvChannelsTab.svelte';
    import LiveTvProxyTab from '$lib/components/admin/settings-pages/livetv/LiveTvProxyTab.svelte';
    import LiveTvFailuresTab from '$lib/components/admin/settings-pages/livetv/LiveTvFailuresTab.svelte';
    import { AdminPageHeader } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import type { PageData, ActionData } from './$types';
    import * as m from '$lib/paraglide/messages.js';
    import { tabItemsOf } from '$lib/config/admin-search-meta';
    import { searchMeta } from './search-meta';
    import { page } from '$app/state';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();

    const tabItems: TabItem[] = tabItemsOf(searchMeta);
    // Seeded from ?tab= so the server-rendered page already shows the linked
    // tab. Starting at 'sources' rendered the Sources pane under a different
    // highlighted tab until hydration caught up (a couple of seconds here).
    const urlTab = page.url.searchParams.get('tab');
    let activeTab = $state(tabItems.some((t) => t.id === urlTab) ? (urlTab as string) : 'sources');

    const TAB_TITLES: Record<string, () => string> = {
        sources: m.admin_livetv_sources_page_title,
        channels: m.admin_livetv_channels_title,
        proxy: m.admin_livetv_proxy_page_title,
        failures: m.admin_livetv_failures_page_title,
    };
</script>

<svelte:head>
    <title>{(TAB_TITLES[activeTab] ?? m.admin_livetv_sources_page_title)()}</title>
</svelte:head>

<div class="space-y-6">
    <AdminPageHeader
        icon={adminPageIcons['/admin/settings/livetv']}
        title={m.admin_nav_page_settings_livetv()}
        description={m.admin_nav_desc_settings_livetv()} />

    <Tabs items={tabItems} bind:active={activeTab} syncToUrl />

    {#if activeTab === 'channels'}
        <LiveTvChannelsTab />
    {:else if activeTab === 'proxy'}
        <LiveTvProxyTab data={data.proxy} />
    {:else if activeTab === 'failures'}
        <LiveTvFailuresTab data={data.failures} />
    {/if}
    <!-- Hidden, not unmounted, on the other tabs: a tab switch is not a
         navigation, so unmounting dropped unsaved settings without a word. -->
    <div class:hidden={['channels', 'proxy', 'failures'].includes(activeTab)}>
        <LiveTvSourcesTab {data} {form} />
    </div>
</div>
