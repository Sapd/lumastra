<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Settings → Music (admin IA redesign, spec §3.6): music settings (which
  already absorbed Music Alchemy's fields — the old /admin/music-alchemy
  route was a redirect stub, deleted), the Quick Picks inspector, and Radio
  stations (moved here from Settings → Live TV — internet radio is a music
  feature) are tabs on ONE page instead of separate routes.
-->
<script lang="ts">
    import { AdminSettingsPage } from '$lib/components/admin';
    import { adminPageIcons } from '$lib/components/admin/admin-page-icons';
    import Tabs, { type TabItem } from '$lib/components/ui/Tabs.svelte';
    import MusicQuickPicksTab from '$lib/components/admin/settings-pages/MusicQuickPicksTab.svelte';
    import MusicRadioTab from '$lib/components/admin/settings-pages/MusicRadioTab.svelte';
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
    let activeTab = $state('settings');

    const TAB_TITLES: Record<string, () => string> = {
        settings: m.admin_nav_page_settings_music,
        'quick-picks': m.admin_musicpicks_title,
        radio: m.admin_radio_page_title,
    };
</script>

<svelte:head>
    <title>{(TAB_TITLES[activeTab] ?? m.admin_nav_page_settings_music)()} - Admin</title>
</svelte:head>

<div class="space-y-6">
    <Tabs items={tabItems} bind:active={activeTab} syncToUrl />

    {#if activeTab === 'quick-picks'}
        <MusicQuickPicksTab data={data.quickPicks} />
    {:else if activeTab === 'radio'}
        <MusicRadioTab />
    {/if}
    <!-- Hidden, not unmounted, on the other tabs: a tab switch is not a
         navigation, so unmounting dropped unsaved settings without a word. -->
    <div class:hidden={activeTab === 'quick-picks' || activeTab === 'radio'}>
        <AdminSettingsPage
            {data}
            {form}
            icon={adminPageIcons['/admin/settings/music']}
            heading={m.admin_nav_page_settings_music()}
            description={m.admin_music_alchemy_description()} />
    </div>
</div>
