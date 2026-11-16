<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * DownloadButton - starts the web download flow for a movie, episode,
     * season or series. Renders nothing unless the server feature is on AND the
     * download-list endpoint says this user is allowed (hides all download UI
     * otherwise).
     *
     * `accessId` lets many buttons (one per episode) share ONE cached
     * permission check on the series instead of listing every episode.
     */
    import { page } from '$app/stores';
    import { Icon, ArrowDownTray } from 'svelte-hero-icons';
    import { downloadQueue } from '$lib/downloads/download-queue.svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        mediaItemId: string;
        accessId?: string;
        variant?: 'button' | 'icon';
        label?: string;
        season?: number;
        testId?: string;
    }

    let {
        mediaItemId,
        accessId = undefined,
        variant = 'button',
        label = undefined,
        season = undefined,
        testId = 'download-button',
    }: Props = $props();

    let featureOn = $derived($page.data?.features?.mediaDownload === true);
    let info = $state<{ allowed: boolean } | null>(null);
    // One run at a time: starting another while the queue runs would only be refused.
    let busy = $derived(downloadQueue.state === 'running');

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

    let text = $derived(label ?? m.downloads_button());

    function start(e: MouseEvent) {
        e.stopPropagation();
        void downloadQueue.enqueue(mediaItemId, season === undefined ? {} : { season });
    }
</script>

{#if featureOn && info?.allowed}
    {#if variant === 'icon'}
        <button
            type="button"
            data-testid={testId}
            class="p-1 rounded hover:bg-surface-600 transition-colors shrink-0 text-surface-500 hover:text-surface-200"
            aria-label={label ?? m.downloads_episode_aria()}
            title={label ?? m.downloads_episode_aria()}
            disabled={busy}
            onclick={start}>
            <Icon src={ArrowDownTray} class="w-4 h-4" aria-hidden="true" />
        </button>
    {:else}
        <button
            type="button"
            data-testid={testId}
            class="btn variant-ghost-surface inline-flex items-center gap-1.5"
            disabled={busy}
            onclick={start}>
            <Icon src={ArrowDownTray} class="w-4 h-4" aria-hidden="true" />
            <span>{text}</span>
        </button>
    {/if}
{/if}
