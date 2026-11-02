<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { env } from '$env/dynamic/public';
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import BrandedPlayIcon from '$lib/icons/BrandedPlayIcon.svelte';
    import { saveReturnPath } from '$lib/stores/playerNavigation';
    import type { ExternalIds } from '$lib/types/api-common';
    import { getPreferredExternalId } from '$lib/utils/external-ids';
    import { buildMediaKey, getPlayableId, getExternalIdFor } from '$lib/utils/media-id-helpers';
    import { page } from '$app/stores';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /**
         * Reusable media action buttons component
         * Handles Watch/Request/Search actions for media items
         */
        isAvailable?: boolean;
        canRequest?: boolean;
        externalIds?: ExternalIds | undefined;
        mediaType?: 'movie' | 'tv';
        title?: string;
        size?: 'sm' | 'md';
        fullWidth?: boolean;
        /** Whether the user has permission to make requests (hides request button if false) */
        hasRequestPermission?: boolean;
    }

    let {
        isAvailable = false,
        canRequest = false,
        externalIds = undefined,
        mediaType = 'movie',
        title = '',
        size = 'md',
        fullWidth = true,
        hasRequestPermission = true,
    }: Props = $props();

    // Check if we have valid external IDs for request
    let hasValidExternalIds = $derived(externalIds && Object.keys(externalIds).length > 0);

    // Neither the request modal nor an external Jellyseerr URL is configured —
    // the request button must fall back to the search button.
    let requestsConfigured = $derived(
        $page.data?.features?.requests === true || !!env.PUBLIC_REQUESTURL,
    );

    let sizeClass = $derived(size === 'sm' ? 'btn-sm' : '');
    let widthClass = $derived(fullWidth ? 'w-full' : '');

    // UUID-first key for internal player — prefers internal UUID over provider IDs
    let mediaKey = $derived(
        buildMediaKey(externalIds, mediaType as import('$lib/types/api-common').ApiMediaType),
    );

    let playableId = $derived(getPlayableId({ externalIds }));

    function getWatchUrl(): string {
        return resolve(`/watch/${mediaKey}`);
    }

    function handleWatch(event: MouseEvent) {
        event.preventDefault();
        saveReturnPath();
        goto(resolve(`/watch/${mediaKey}`));
    }

    function handleRequest() {
        if (!env.PUBLIC_REQUESTURL) {
            console.warn(
                '[MediaActionButtons] Cannot open request - Jellyseerr URL not configured',
            );
            return;
        }

        if (!externalIds || Object.keys(externalIds).length === 0) {
            console.warn('[MediaActionButtons] Cannot open request - no external IDs available');
            return;
        }

        // Use provider-agnostic helper for priority-based ID selection
        const preferred = getPreferredExternalId(externalIds);

        if (!preferred) {
            console.warn('[MediaActionButtons] Cannot open request - no resolvable provider IDs');
            return;
        }

        // Use redirect endpoint with composite key
        const compositeKey = `${preferred.provider}:${preferred.id}:${mediaType}`;
        const requestUrl = `/api/request/redirect?id=${encodeURIComponent(compositeKey)}`;
        window.open(requestUrl, '_blank');
    }

    function handleSearch() {
        if (!title) return;
        const searchUrl = `https://www.google.com/search?q=${encodeURIComponent(title)}`;
        window.open(searchUrl, '_blank');
    }
</script>

{#if playableId}
    <!-- Watch Button -->
    <a
        href={resolve(getWatchUrl())}
        onclick={handleWatch}
        class={`btn variant-filled-success ${sizeClass} ${widthClass} glossy-btn`}>
        <BrandedPlayIcon size="w-4 h-4" />
        <span class="ml-1">{m.btn_watch()}</span>
    </a>
{:else if canRequest && hasValidExternalIds && hasRequestPermission && requestsConfigured}
    <!-- Request Button -->
    <button
        onclick={handleRequest}
        class={`btn variant-filled-primary ${sizeClass} ${widthClass} glossy-btn`}>
        <span>📝</span>
        <span class="ml-1">Anfragen</span>
    </button>
{:else}
    <!-- Search Button (Fallback) -->
    <button onclick={handleSearch} class={`btn variant-ghost-surface ${sizeClass} ${widthClass}`}>
        <span>🔍</span>
        <span class="ml-1">Suchen</span>
    </button>
{/if}
