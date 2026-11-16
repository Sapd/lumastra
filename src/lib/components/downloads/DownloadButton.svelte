<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * DownloadButton - the quiet icon-only ghost button (tooltip + aria-label) of an episode
     * row. It opens the download sheet with "This episode" preselected (the sheet can widen it
     * to the rest of the season, a hand-picked list, the season or the series). Renders
     * nothing unless the server feature is on AND the download-list endpoint says this user
     * is allowed.
     *
     * `accessId` is the series id: many buttons (one per episode) share ONE cached permission
     * check on it instead of listing every episode, and the sheet lists that series once.
     * Without `accessId` the button downloads `mediaItemId` alone.
     */
    import { page } from '$app/stores';
    import { Icon, ArrowDownTray } from 'svelte-hero-icons';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { downloadQueue } from '$lib/downloads/download-queue.svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        mediaItemId: string;
        accessId?: string;
        /** Accessible name and tooltip (default "Download episode") */
        label?: string;
        /** Episode rows: icon only shows on row hover/focus (always on touch). */
        revealOnHover?: boolean;
        testId?: string;
    }

    let {
        mediaItemId,
        accessId = undefined,
        label = undefined,
        revealOnHover = false,
        testId = 'download-button',
    }: Props = $props();

    let featureOn = $derived($page.data?.features?.mediaDownload === true);
    let info = $state<{ allowed: boolean } | null>(null);

    $effect(() => {
        info = null;
        if (!featureOn) return;
        const id = accessId ?? mediaItemId;
        let cancelled = false;
        void downloadQueue.downloadInfo(id).then((r) => {
            if (!cancelled) info = r;
        });
        return () => {
            cancelled = true;
        };
    });

    let text = $derived(label ?? m.downloads_episode_aria());

    function start(e: MouseEvent) {
        e.stopPropagation();
        // While a run is going the queue answers with the "already running" toast.
        if (accessId) {
            void downloadQueue.enqueueSeries(accessId, {
                scope: 'episode',
                episodeId: mediaItemId,
            });
        } else {
            void downloadQueue.enqueue(mediaItemId);
        }
    }
</script>

{#if featureOn && info?.allowed}
    <Tooltip {text} position="top" inline fixed>
        <button
            type="button"
            data-testid={testId}
            class="download-ghost"
            class:download-reveal={revealOnHover}
            aria-label={text}
            onclick={start}>
            <Icon src={ArrowDownTray} class="w-4 h-4" aria-hidden="true" />
        </button>
    </Tooltip>
{/if}

<style>
    .download-ghost {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 2rem;
        min-height: 2rem;
        flex-shrink: 0;
        border-radius: 0.25rem;
        color: var(--color-surface-400);
        transition:
            color 0.15s,
            opacity 0.15s;
    }
    .download-ghost:hover {
        color: var(--color-surface-100);
    }
    .download-ghost:focus-visible {
        outline: 2px solid var(--color-primary-500);
        outline-offset: 1px;
        opacity: 1;
    }
    @media (hover: hover) {
        .download-reveal {
            opacity: 0;
        }
        :global(.download-row:hover) .download-reveal,
        :global(.download-row:focus-within) .download-reveal {
            opacity: 1;
        }
    }
    @media (hover: none) {
        .download-reveal {
            min-width: 2.5rem;
            min-height: 2.5rem;
        }
    }
</style>
