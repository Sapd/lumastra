<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { goto } from '$app/navigation';
    import { resolve } from '$lib/paths';
    import BrandedPlayIcon from '$lib/icons/BrandedPlayIcon.svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        itemId: string;
        variant?: 'link' | 'button' | 'icon';
        size?: 'sm' | 'md' | 'lg';
        label?: string;
        showIcon?: boolean;
        /** Optional playlist context - when provided, navigates with playlist params */
        playlistContext?: { playlistId: number; position: number } | undefined;
    }

    let {
        itemId,
        variant = 'link',
        size = 'md',
        label = m.btn_watch(),
        showIcon = true,
        playlistContext = undefined,
    }: Props = $props();

    // Build internal player URL with optional playlist context
    function getInternalWatchUrl(): string {
        let url = resolve(`/watch/${itemId}`);
        if (playlistContext) {
            const params = new URLSearchParams({
                playlist: playlistContext.playlistId.toString(),
                position: playlistContext.position.toString(),
            });
            url += `?${params.toString()}`;
        }
        return url;
    }

    function handleClick(e: MouseEvent) {
        e.preventDefault();
        void goto(getInternalWatchUrl());
    }

    // Size classes
    let sizeClasses = $derived(
        {
            sm: 'text-xs px-2 py-1',
            md: 'text-sm px-3 py-1.5',
            lg: 'text-base px-4 py-2',
        }[size],
    );

    let iconSize = $derived(
        {
            sm: 'w-3 h-3',
            md: 'w-4 h-4',
            lg: 'w-5 h-5',
        }[size],
    );
</script>

{#if variant === 'link'}
    <a
        href={getInternalWatchUrl()}
        onclick={handleClick}
        class="text-green-400 hover:text-green-300 inline-flex items-center gap-1">
        {#if showIcon}
            <BrandedPlayIcon size={iconSize} />
        {/if}
        <span class="ml-1">{label}</span>
    </a>
{:else if variant === 'button'}
    <a
        href={getInternalWatchUrl()}
        onclick={handleClick}
        class="btn variant-filled-primary {sizeClasses} inline-flex items-center gap-1">
        {#if showIcon}
            <BrandedPlayIcon size={iconSize} />
        {/if}
        <span class="ml-1">{label}</span>
    </a>
{:else if variant === 'icon'}
    <a
        href={getInternalWatchUrl()}
        onclick={handleClick}
        class="hover:opacity-80 transition-opacity"
        title={label}>
        <BrandedPlayIcon size={iconSize} />
    </a>
{/if}
