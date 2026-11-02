<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- Desktop-only detail panel for the player episode drawer. It deliberately
     docks left: the drawer occupies the right edge of the player. -->
<script lang="ts">
    import './player-presentation.css';
    import { autoUpdate } from '@floating-ui/dom';

    export interface EpisodeOverview {
        id?: string;
        name?: string;
        episodeNumber: number;
        episodeNumberEnd?: number;
        overview?: string;
    }

    interface Props {
        episode: EpisodeOverview | null;
        anchorEl: HTMLElement | null;
        panelId: string;
        onpointerenter?: () => void;
        onpointerleave?: () => void;
    }

    let { episode, anchorEl, panelId, onpointerenter, onpointerleave }: Props = $props();

    const PANEL_MARGIN = 12;
    const PANEL_MIN_WIDTH = 280;
    const PANEL_MAX_WIDTH = 420;
    const PANEL_EDGE = 8;

    let panelEl: HTMLDivElement | undefined = $state();
    let placement = $state<{ visible: boolean; left: number; top: number; width: number }>({
        visible: false,
        left: 0,
        top: 0,
        width: 0,
    });

    function reposition(): void {
        if (
            !anchorEl ||
            !panelEl ||
            !window.matchMedia('(hover: hover) and (pointer: fine)').matches
        ) {
            placement = { visible: false, left: 0, top: 0, width: 0 };
            return;
        }

        const drawerEl = anchorEl.closest('.episode-browser-drawer');
        if (!drawerEl) {
            placement = { visible: false, left: 0, top: 0, width: 0 };
            return;
        }

        const drawerRect = drawerEl.getBoundingClientRect();
        const anchorRect = anchorEl.getBoundingClientRect();
        const available = drawerRect.left - PANEL_MARGIN * 2;
        if (
            available < PANEL_MIN_WIDTH ||
            anchorRect.bottom < 0 ||
            anchorRect.top > window.innerHeight
        ) {
            placement = { visible: false, left: 0, top: 0, width: 0 };
            return;
        }

        const width = Math.min(available, PANEL_MAX_WIDTH);
        const height = panelEl.offsetHeight;
        const top = Math.max(
            PANEL_EDGE,
            Math.min(anchorRect.top, window.innerHeight - height - PANEL_EDGE),
        );
        placement = {
            visible: true,
            left: drawerRect.left - PANEL_MARGIN - width,
            top,
            width,
        };
    }

    $effect(() => {
        if (!episode || !anchorEl || !panelEl) return;
        return autoUpdate(anchorEl, panelEl, reposition);
    });
</script>

{#if episode?.overview}
    <div
        bind:this={panelEl}
        id={panelId}
        role="tooltip"
        class="episode-overview-hover-panel player-menu fixed rounded-lg bg-surface-800 shadow-2xl ring-1 ring-surface-700/60 p-4"
        style:z-index="10002"
        style:left={placement.visible ? `${placement.left}px` : '0px'}
        style:top={placement.visible ? `${placement.top}px` : '0px'}
        style:width={placement.visible ? `${placement.width}px` : 'auto'}
        style:visibility={placement.visible ? 'visible' : 'hidden'}
        onpointerenter={() => onpointerenter?.()}
        onpointerleave={() => onpointerleave?.()}>
        <h3 class="text-sm font-medium text-white break-words">
            <span class="text-surface-400">E{episode.episodeNumber}</span>
            {episode.name || `Episode ${episode.episodeNumber}`}
        </h3>
        <p class="mt-2 text-sm leading-6 text-surface-200 whitespace-pre-wrap break-words">
            {episode.overview}
        </p>
    </div>
{/if}

<style>
    .episode-overview-hover-panel {
        max-height: calc(100dvh - 16px);
        overflow-y: auto;
        overscroll-behavior: contain;
        transition: opacity 120ms ease-out;
    }

    @media (prefers-reduced-motion: reduce) {
        .episode-overview-hover-panel {
            transition: none;
        }
    }
</style>
