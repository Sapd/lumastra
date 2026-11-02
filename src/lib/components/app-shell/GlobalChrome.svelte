<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { LayoutServerData } from '../../../routes/$types';
    import ManualRunsPanel from '$lib/components/ManualRunsPanel.svelte';
    import ModalContainer from '$lib/components/ui/ModalContainer.svelte';
    import RequestNotificationWidget from '$lib/components/RequestNotificationWidget.svelte';
    import NotificationBell from '$lib/components/notifications/NotificationBell.svelte';
    import NotificationDrawer from '$lib/components/notifications/NotificationDrawer.svelte';
    import { AddToPlaylistModal } from '$lib/components/playlist';
    import { addToPlaylistModal } from '$lib/stores/playlists';
    import {
        notificationDrawerOpen,
        closeNotificationDrawer,
    } from '$lib/stores/notification-drawer';
    interface Props {
        data: LayoutServerData;
        isStandalone: boolean;
        isAdminPage: boolean;
        isDevicePage: boolean;
    }
    let { data, isStandalone, isAdminPage, isDevicePage }: Props = $props();
</script>

{#if data?.user}<ManualRunsPanel />{/if}
{#if !isStandalone}
    <ModalContainer />
    {#if !isDevicePage}
        <RequestNotificationWidget />
    {/if}
    {#if !isDevicePage && data?.user}
        <!-- Bell is desktop-only (it hides itself under 768px); on mobile the
             dock owns the entry point. The DRAWER is mounted here, once, for
             both openers — mounting it per-opener would give mobile two focus
             traps and two scroll locks over one list. -->
        {#if !isAdminPage}
            <!-- The admin shell renders this bell inline in its own header. -->
            <NotificationBell />
        {/if}
        <NotificationDrawer open={$notificationDrawerOpen} onclose={closeNotificationDrawer} />
    {/if}

    <!-- Add to Playlist Modal - rendered outside Skeleton's Modal for proper z-index stacking -->
    {#if $addToPlaylistModal}
        <AddToPlaylistModal
            externalIds={$addToPlaylistModal.externalIds}
            mediaType={$addToPlaylistModal.mediaType}
            title={$addToPlaylistModal.title}
            overview={$addToPlaylistModal.overview || ''}
            posterPath={$addToPlaylistModal.posterPath || ''}
            seasonNumber={$addToPlaylistModal.seasonNumber}
            episodeNumber={$addToPlaylistModal.episodeNumber}
            seriesName={$addToPlaylistModal.seriesName || ''}
            seriesExternalIds={$addToPlaylistModal.seriesExternalIds} />
    {/if}
{/if}
