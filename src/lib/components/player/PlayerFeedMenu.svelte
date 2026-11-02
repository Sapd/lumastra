<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<script lang="ts">
    import './player-presentation.css';
    import { tick } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import type { LiveTvFeed } from '$lib/schemas/livetv.js';
    import { feedQualityLabel } from '$lib/components/livetv/feed-labels.js';
    import { fitTrackMenu } from './track-menu-layout';

    interface Props {
        feeds: LiveTvFeed[];
        name: string;
        currentId?: string;
        onpick: (feed: LiveTvFeed) => void;
        onclose: () => void;
    }
    let { feeds, name, currentId, onpick, onclose }: Props = $props();
    let checkedId = $derived(
        feeds.find((feed) => feed.id === currentId)?.id ?? feeds.find((feed) => feed.isDefault)?.id,
    );

    function ownKeyboard(node: HTMLElement): { destroy: () => void } {
        void tick().then(() => {
            (
                node.querySelector<HTMLButtonElement>('[aria-checked="true"]') ??
                node.querySelector<HTMLButtonElement>('[role="menuitemradio"]')
            )?.focus();
        });
        function keydown(event: KeyboardEvent): void {
            if (!event.ctrlKey && !event.metaKey && !event.altKey) event.stopPropagation();
            const items = [...node.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            if (event.key === 'Escape') {
                event.preventDefault();
                event.stopImmediatePropagation();
                onclose();
            } else if (event.key === 'Tab') {
                onclose();
                event.stopImmediatePropagation();
            } else if (event.key === ' ' || event.key === 'Enter') {
                // Keep the player's global transport shortcuts from consuming selection.
                event.stopImmediatePropagation();
                event.preventDefault();
                (document.activeElement as HTMLButtonElement)?.click();
            } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                event.preventDefault();
                event.stopImmediatePropagation();
                const next =
                    event.key === 'Home'
                        ? 0
                        : event.key === 'End'
                          ? items.length - 1
                          : (index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) %
                            items.length;
                items[next]?.focus();
            }
        }
        node.addEventListener('keydown', keydown, true);
        return { destroy: () => node.removeEventListener('keydown', keydown, true) };
    }
</script>

<div
    class="feed-selector player-menu"
    use:fitTrackMenu
    use:ownKeyboard
    role="menu"
    aria-label={m.livetv_feed_menu_label({ name })}
    onwheel={(event) => event.stopPropagation()}>
    <div class="menu-header">
        <h2>{m.livetv_feed_menu_label({ name })}</h2>
        <button class="close-button" onclick={onclose} aria-label={m.close()}>×</button>
    </div>
    <p>{m.livetv_feed_menu_hint()}</p>
    <div class="track-content">
        {#each feeds as feed (feed.id)}
            <button
                type="button"
                role="menuitemradio"
                aria-checked={feed.id === checkedId}
                class="feed-option"
                class:selected={feed.id === checkedId}
                onclick={() => onpick(feed)}>
                <span class="feed-name">{feed.name}</span>
                {#if feed.qualityTier}<small>{feedQualityLabel(feed.qualityTier)}</small>{/if}
                {#if feed.isDegraded}<small>{m.livetv_feed_degraded()}</small>{/if}
                {#if feed.isDefault}<small>{m.livetv_feed_default()}</small>{/if}
                {#if feed.id === checkedId}<span aria-hidden="true">✓</span>{/if}
            </button>
        {/each}
    </div>
</div>

<style>
    .feed-selector {
        position: fixed;
        bottom: var(--track-menu-bottom, 80px);
        right: var(--track-menu-right, 24px);
        padding: 1rem;
        width: 380px;
        box-sizing: border-box;
        max-width: var(--track-menu-max-width, calc(100vw - 32px));
        max-height: var(--track-menu-max-height, min(640px, calc(100dvh - 104px)));
        display: flex;
        flex-direction: column;
        overflow: hidden;
        z-index: 100;
    }
    .menu-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding-bottom: 12px;
        border-bottom: 1px solid #ffffff12;
        flex-shrink: 0;
    }
    h2 {
        font-size: 14px;
        font-weight: 600;
        margin: 0;
        flex: 1;
        min-width: 0;
    }
    p {
        color: #94a3b8;
        font-size: 12px;
        margin: 8px 0;
        flex-shrink: 0;
    }
    .close-button {
        display: grid;
        place-items: center;
        flex-shrink: 0;
        width: 32px;
        height: 32px;
        border: 0;
        border-radius: 6px;
        background: #ffffff0d;
        color: #cbd5e1;
        cursor: pointer;
        font-size: 24px;
    }
    .track-content {
        min-height: 0;
        overflow-y: auto;
        overscroll-behavior: contain;
        scrollbar-gutter: stable;
        padding: 8px 4px;
    }
    .feed-option {
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        min-height: 44px;
        padding: 10px;
        border: 1px solid transparent;
        border-radius: 6px;
        color: white;
        background: transparent;
        text-align: left;
        cursor: pointer;
    }
    .feed-option:hover,
    .feed-option:focus-visible {
        background: #ffffff12;
    }
    .feed-option.selected {
        background: #818cf826;
        border-color: #818cf880;
    }
    .feed-name {
        flex: 1;
        min-width: 0;
        overflow-wrap: anywhere;
    }
    small {
        font-size: 11px;
        color: #94a3b8;
    }
</style>
