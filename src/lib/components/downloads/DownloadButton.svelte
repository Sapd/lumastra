<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * DownloadButton - a small icon-only ghost button (tooltip + aria-label) that starts the
     * web download flow for a movie, episode or (single-season) series. Renders nothing
     * unless the server feature is on AND the download-list endpoint says this user is
     * allowed (hides all download UI otherwise).
     *
     * `accessId` lets many buttons (one per episode) share ONE cached permission check on
     * the series instead of listing every episode. `showSize` adds "(<size>)" to the
     * tooltip, loaded lazily on first hover/focus.
     */
    import { page } from '$app/stores';
    import { Icon, ArrowDownTray } from 'svelte-hero-icons';
    import Tooltip from '$lib/components/ui/Tooltip.svelte';
    import { downloadQueue } from '$lib/downloads/download-queue.svelte';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        mediaItemId: string;
        accessId?: string;
        /** Accessible name and tooltip (default "Download", or "Download episode") */
        label?: string;
        /**
         * 'ghost' (default): the quiet 16 px icon (season picker, episode rows).
         * 'action': the modal's icon button, same classes as the Share button.
         */
        variant?: 'ghost' | 'action';
        /** Tooltip/label gets "(<size>)", loaded lazily on first hover/focus */
        showSize?: boolean;
        /** Episode rows: icon only shows on row hover/focus (always on touch). */
        revealOnHover?: boolean;
        /** Start from this season of a series; the sheet can widen it to the series. */
        season?: number;
        testId?: string;
    }

    let {
        mediaItemId,
        accessId = undefined,
        label = undefined,
        variant = 'ghost',
        showSize = false,
        revealOnHover = false,
        season = undefined,
        testId = 'download-button',
    }: Props = $props();

    let featureOn = $derived($page.data?.features?.mediaDownload === true);
    let info = $state<{ allowed: boolean } | null>(null);
    let sizeBytes = $state<number | null>(null);
    let sizeRequested = false;

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

    function loadSize() {
        if (!showSize || sizeRequested) return;
        sizeRequested = true;
        const id = mediaItemId;
        void downloadQueue.fetchList(id).then((list) => {
            if (!list) {
                sizeRequested = false;
                return;
            }
            sizeBytes = list.items.filter((i) => i.available).reduce((s, i) => s + i.sizeBytes, 0);
        });
    }

    let base = $derived(label ?? (showSize ? m.downloads_button() : m.downloads_episode_aria()));
    let text = $derived(
        showSize && sizeBytes !== null && sizeBytes > 0
            ? m.downloads_with_size({ size: formatFileSize(sizeBytes) })
            : base,
    );

    function start(e: MouseEvent) {
        e.stopPropagation();
        // While a run is going enqueue() answers with the "already running" toast.
        void downloadQueue.enqueue(
            mediaItemId,
            season === undefined ? {} : season === 0 ? { season, specials: true } : { season },
            season,
        );
    }
</script>

{#if featureOn && info?.allowed}
    <Tooltip {text} position="top" inline fixed>
        <button
            type="button"
            data-testid={testId}
            class={variant === 'action' ? 'btn-icon variant-ghost-surface' : 'download-ghost'}
            class:download-reveal={revealOnHover}
            aria-label={text}
            onpointerenter={loadSize}
            onfocus={loadSize}
            onclick={start}>
            <Icon
                src={ArrowDownTray}
                class={variant === 'action' ? 'w-5 h-5' : 'w-4 h-4'}
                aria-hidden="true" />
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
