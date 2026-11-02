<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { markLogoFailed, usableLogo } from '$lib/components/livetv/failed-logos.svelte.js';
    import type { GroupedProgramChannel } from '$lib/schemas/livetv.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        channels: GroupedProgramChannel[];
        onSelect: (channelId: string) => void;
    }

    let { channels, onSelect }: Props = $props();

    function handleKeydown(event: KeyboardEvent) {
        const target = event.currentTarget as HTMLElement;
        if (event.key === 'ArrowDown') {
            event.preventDefault();
            (target.nextElementSibling as HTMLElement)?.focus();
        } else if (event.key === 'ArrowUp') {
            event.preventDefault();
            (target.previousElementSibling as HTMLElement)?.focus();
        } else if (event.key === 'Enter') {
            event.preventDefault();
            target.click();
        }
    }
</script>

<div class="space-y-2" role="listbox" aria-label={m.browse_live_tv_channels()}>
    {#each channels as channel, index (channel.id)}
        <button
            class="flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-surface-600 {index ===
            0
                ? 'bg-surface-600/80'
                : 'bg-surface-700/50'}"
            role="option"
            aria-selected={false}
            onclick={(e: MouseEvent) => {
                e.stopPropagation();
                onSelect(channel.id);
            }}
            onkeydown={handleKeydown}>
            {#if usableLogo(channel.images?.primary?.href)}
                <img
                    src={channel.images?.primary?.href}
                    alt={channel.name}
                    class="h-6 w-6 rounded object-contain bg-surface-900"
                    loading="lazy"
                    onerror={() => markLogoFailed(channel.images?.primary?.href)} />
            {:else}
                <span
                    class="flex h-6 w-6 items-center justify-center rounded bg-surface-600 text-[10px] font-bold text-surface-300">
                    {channel.name.charAt(0).toUpperCase()}
                </span>
            {/if}
            <span class="text-surface-200">{channel.name}</span>
            <span class="ml-auto text-xs text-surface-500">▶</span>
        </button>
    {/each}
</div>
