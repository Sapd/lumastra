<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Settings → Homepage & navigation (admin IA redesign, spec §3.6): Homepage
  and Navigation are now tabs on ONE page instead of two separate routes.
  Library types (sidebar names/icons/order for non-entertainment libraries)
  moved here from Library → Sources: it configures the sidebar, not a library.
-->
<script lang="ts">
    import Tabs, { type TabItem } from '$lib/components/ui/Tabs.svelte';
    import HomepageSettingsTab from '$lib/components/admin/settings-pages/HomepageSettingsTab.svelte';
    import NavigationSettingsTab from '$lib/components/admin/settings-pages/NavigationSettingsTab.svelte';
    import LibraryTypeSettingsPanel from '$lib/components/admin/library/LibraryTypeSettingsPanel.svelte';
    import type { PageData, ActionData } from './$types';
    import * as m from '$lib/paraglide/messages.js';
    import { tabItemsOf } from '$lib/config/admin-search-meta';
    import { searchMeta } from './search-meta';

    interface Props {
        data: PageData;
        form: ActionData;
    }

    let { data, form }: Props = $props();

    const tabItems: TabItem[] = tabItemsOf(searchMeta);
    let activeTab = $state('homepage');
</script>

<svelte:head>
    <title
        >{activeTab === 'navigation'
            ? m.admin_navigation_page_title()
            : m.admin_homepage_page_title()}</title>
</svelte:head>

<div class="space-y-6">
    <Tabs items={tabItems} bind:active={activeTab} syncToUrl />

    <!-- The two settings forms stay mounted (hidden) on the other tabs: a tab
         switch is not a navigation, so unmounting dropped their unsaved edits
         without a word. -->
    <div class:hidden={activeTab !== 'navigation'}>
        <NavigationSettingsTab {data} {form} />
    </div>
    {#if activeTab === 'library-types'}
        <LibraryTypeSettingsPanel />
    {/if}
    <div class:hidden={activeTab === 'navigation' || activeTab === 'library-types'}>
        <HomepageSettingsTab {data} {form} />
    </div>
</div>
