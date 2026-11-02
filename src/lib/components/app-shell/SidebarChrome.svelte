<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import Sidebar from '$lib/Sidebar.svelte';
    import type { LayoutServerData } from '../../../routes/$types';
    interface Props {
        data: LayoutServerData;
        isAdminPage: boolean;
        isWatchPage: boolean;
        isRatePage: boolean;
        dockIsVisible: boolean;
        settingsOverlayOpen: boolean;
        sidebarOpen?: boolean;
    }
    let {
        data,
        isAdminPage,
        isWatchPage,
        isRatePage,
        dockIsVisible,
        settingsOverlayOpen,
        sidebarOpen = $bindable(false),
    }: Props = $props();
</script>

{#if !isAdminPage && !isWatchPage && !isRatePage && data?.features?.sidebar !== false && dockIsVisible}
    <!-- inert ONLY the sidebar while the /settings overlay is open (a11y
                 spec #2). display:contents keeps the Sidebar a direct flex child
                 of .app-layout (layout-transparent) while inert still propagates
                 to its subtree. The overlay itself lives in <main> and stays
                 interactive. -->
    <div style="display: contents" inert={settingsOverlayOpen || undefined}>
        <Sidebar
            userGroups={data?.user?.userGroups || []}
            adminGroups={data?.adminGroups || ['admin']}
            isAdmin={data?.user?.isAdmin === true}
            customLinks={data?.sidebarLinks || []}
            pluginNavEntries={data?.pluginNavEntries || []}
            sections={data?.sidebarSections || []}
            nonEntertainmentLibraries={data?.nonEntertainmentLibraries || []}
            activeLibraryTypes={data?.activeLibraryTypes ?? []}
            primaryMode={data?.primaryMode ?? 'vod'}
            liveTV={data?.features?.liveTV === true}
            musicAlchemy={data?.features?.musicAlchemy === true}
            musicMap={data?.features?.musicMap === true}
            lyricsSearch={data?.features?.lyricsSearch === true}
            sonicEmbeddings={data?.features?.sonicEmbeddings === true}
            musicClusters={data?.features?.musicClusters === true}
            textToSound={data?.features?.textToSound === true}
            trainingAssignments={data?.features?.trainingAssignments === true}
            assessment={data?.features?.assessment === true}
            bind:isOpen={sidebarOpen} />
    </div>
{/if}
