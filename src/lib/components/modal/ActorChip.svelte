<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { pickVariant } from '$lib/utils/image-utils.js';
    /**
     * ActorChip - Interactive actor chip with hover image preview
     *
     * Features:
     * - Shows actor name as a chip
     * - On hover: displays profile image in a floating preview (lazy-loads person ID if needed)
     * - On click: dispatches event to open actor modal
     */
    import { onDestroy } from 'svelte';
    import * as m from '$lib/paraglide/messages';
    import { url } from '$lib/paths';
    import { getPerson } from '$lib/api/admin';
    import { searchPerson } from '$lib/api/content';
    import { Z } from '$lib/utils/z-index';

    interface Props {
        // Props - either provide id directly, or it will be searched by name
        id?: number | string | undefined;
        profileUrl?: string;
        name: string;
        character?: string | undefined;
        onclick?: (detail: { id: number | string; name: string }) => void;
    }

    let {
        id = undefined,
        name,
        character = undefined,
        profileUrl = undefined,
        onclick,
    }: Props = $props();

    let showPreview = $state(false);
    let chipElement: HTMLButtonElement | undefined = $state();
    let previewPosition = $state({ x: 0, y: 0 });
    let imageLoaded = $state(false);
    let imageError = $state(false);

    // Lazy-loaded person ID - stored when resolved via search
    let resolvedId = $state<number | undefined>(undefined);
    let effectiveId = $derived(id ?? resolvedId);
    let searchInProgress = $state(false);
    let pendingSearch: Promise<number | string | undefined> | null = null;
    let searchFailed = false;

    // Track if mouse is currently over this chip (to handle async race conditions)
    let isHovering = false;
    let hoverTimeout: ReturnType<typeof setTimeout> | null = null;

    // Cleanup timeout on destroy
    onDestroy(() => {
        if (hoverTimeout) {
            clearTimeout(hoverTimeout);
        }
    });

    // Image URL - use our cached proxy (only if we have an ID)
    let resolvedProfile = $state<string | undefined>();
    let imageUrl = $derived(
        profileUrl || resolvedProfile ? url(profileUrl || resolvedProfile!) : null,
    );

    // Search for person ID by name
    function searchPersonId(): Promise<number | string | undefined> {
        if (effectiveId || searchFailed) return Promise.resolve(effectiveId);
        if (pendingSearch) return pendingSearch;
        pendingSearch = resolvePersonId().finally(() => {
            pendingSearch = null;
        });
        return pendingSearch;
    }

    async function resolvePersonId(): Promise<number | string | undefined> {
        searchInProgress = true;
        try {
            const { data: result, error: searchErr } = await searchPerson(name);
            if (!searchErr && result && result.personId > 0) {
                resolvedId = result.personId;
                const { data } = await getPerson(result.personId);
                const image = data?.images.primary;
                resolvedProfile = pickVariant(image, 'thumb');
                return resolvedId;
            }
            searchFailed = true;
        } catch (error) {
            console.warn('Failed to search person:', name, error);
            searchFailed = true;
        } finally {
            searchInProgress = false;
        }
        return undefined;
    }

    async function handleMouseEnter(event: MouseEvent) {
        // Clear any pending timeout
        if (hoverTimeout) {
            clearTimeout(hoverTimeout);
            hoverTimeout = null;
        }

        isHovering = true;

        if (!chipElement) return;
        const rect = chipElement.getBoundingClientRect();
        previewPosition = {
            x: rect.left + rect.width / 2,
            y: rect.top - 8,
        };

        // Small delay to prevent flickering on quick mouse movements
        hoverTimeout = setTimeout(async () => {
            // Check if still hovering after delay
            if (!isHovering) return;

            // If no ID yet, search for it
            if (!effectiveId && !searchFailed) {
                await searchPersonId();
            }

            // Only show preview if still hovering after async operation
            if (isHovering && effectiveId) {
                showPreview = true;
            }
        }, 100);
    }

    function handleMouseLeave() {
        isHovering = false;
        showPreview = false;

        // Clear any pending timeout
        if (hoverTimeout) {
            clearTimeout(hoverTimeout);
            hoverTimeout = null;
        }
    }

    async function handleClick() {
        // Ensure we have the person ID
        if (!effectiveId && !searchFailed) {
            await searchPersonId();
        }

        if (effectiveId) {
            onclick?.({ id: effectiveId, name });
        }
    }

    function handleImageLoad() {
        imageLoaded = true;
    }

    function handleImageError() {
        imageError = true;
        showPreview = false;
    }

    function handleKeyDown(event: KeyboardEvent) {
        if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            handleClick();
        }
    }
</script>

<button
    bind:this={chipElement}
    class="actor-chip text-xs bg-surface-600 hover:bg-surface-500 text-surface-200 px-2 py-1 rounded-full cursor-pointer transition-colors"
    onmouseenter={handleMouseEnter}
    onmouseleave={handleMouseLeave}
    onclick={handleClick}
    onkeydown={handleKeyDown}
    title={character ? m.actor_chip_title_with_character({ name, character }) : name}
    aria-label={character
        ? m.actor_chip_aria_with_character({ name, character })
        : m.actor_chip_aria({ name })}>
    {name}
</button>

<!-- Floating preview on hover -->
{#if showPreview && imageUrl && !imageError}
    <div
        class="actor-preview fixed pointer-events-none"
        style="left: {previewPosition.x}px; top: {previewPosition.y}px; transform: translate(-50%, -100%); z-index: {Z.TOOLTIP}">
        <div
            class="bg-surface-800 rounded-lg shadow-xl overflow-hidden border border-surface-600 w-24">
            {#if searchInProgress}
                <div class="w-full h-32 bg-surface-700 animate-pulse center">
                    <span class="loading-spinner"></span>
                </div>
            {:else}
                <div class="relative w-full h-32">
                    <img
                        src={imageUrl}
                        alt={name}
                        class="w-full h-full object-cover transition-opacity duration-200"
                        class:opacity-0={!imageLoaded}
                        class:opacity-100={imageLoaded}
                        onload={handleImageLoad}
                        onerror={handleImageError} />
                    {#if !imageLoaded && !imageError}
                        <div class="w-full h-full bg-surface-700 animate-pulse absolute inset-0">
                        </div>
                    {/if}
                </div>
            {/if}
            <div class="px-2 py-1.5 text-center w-full">
                <p class="text-xs font-medium text-surface-100 truncate">
                    {name}
                </p>
                {#if character}
                    <p class="text-[10px] text-surface-400 truncate">
                        {character}
                    </p>
                {/if}
            </div>
        </div>
    </div>
{/if}

<style>
    .actor-chip {
        user-select: none;
    }

    .actor-preview img {
        transition: opacity 0.2s ease;
    }

    /* Animation for preview appearing */
    .actor-preview {
        animation: preview-fade-in 0.15s ease-out;
    }

    @keyframes preview-fade-in {
        from {
            opacity: 0;
            transform: translate(-50%, -90%);
        }
        to {
            opacity: 1;
            transform: translate(-50%, -100%);
        }
    }
</style>
