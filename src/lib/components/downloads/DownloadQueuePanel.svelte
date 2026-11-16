<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * DownloadQueuePanel - small floating panel for the running / finished
     * download queue. Mounted once in the root layout so it outlives any modal.
     */
    import { downloadQueue } from '$lib/downloads/download-queue.svelte';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages';

    let q = downloadQueue;
    let visible = $derived(q.state !== 'idle' || !!q.error);
    let finished = $derived(
        q.items.filter((i) => ['done', 'skipped', 'handed'].includes(i.status)).length,
    );
    let percent = $derived(
        q.bytesTotal > 0 ? Math.min(100, (q.bytesDone / q.bytesTotal) * 100) : 0,
    );

    let errorText = $derived.by(() => {
        switch (q.error) {
            case undefined:
                return null;
            case 'downloads_not_allowed':
                return m.downloads_error_not_allowed();
            case 'busy':
                return m.downloads_error_busy();
            case 'nothing_to_download':
                return m.downloads_error_empty();
            default:
                return m.downloads_error_list();
        }
    });
    let stateText = $derived(
        q.state === 'done'
            ? m.downloads_state_done()
            : q.state === 'stopped'
              ? m.downloads_state_stopped()
              : null,
    );

    function close() {
        q.reset();
    }
</script>

{#if visible}
    <div
        class="fixed bottom-20 left-4 w-72 max-w-[calc(100vw-2rem)] bg-surface-800 rounded-lg shadow-xl p-3 space-y-2 text-sm"
        style="z-index: {Z.ADMIN_BANNER}"
        role="status"
        aria-live="polite"
        data-testid="download-queue-panel">
        <div class="flex items-center justify-between gap-2">
            <span class="font-semibold text-white">{m.downloads_panel_title()}</span>
            {#if q.state === 'running'}
                <button
                    type="button"
                    class="text-surface-300 hover:text-white"
                    data-testid="download-cancel"
                    onclick={() => q.cancel()}>
                    {m.downloads_cancel()}
                </button>
            {:else}
                <button type="button" class="text-surface-300 hover:text-white" onclick={close}>
                    {m.downloads_close()}
                </button>
            {/if}
        </div>

        {#if errorText}
            <p class="text-amber-300">{errorText}</p>
        {/if}
        {#if stateText && !errorText}
            <p class="text-surface-200">{stateText}</p>
        {/if}

        {#if q.items.length > 0}
            {#if q.current}
                <p class="text-surface-200 truncate" title={q.current.fileName}>
                    {q.current.fileName}
                </p>
            {/if}
            <p class="text-surface-300">
                {m.downloads_progress({ done: finished, total: q.items.length })}
            </p>
            {#if q.mode === 'folder'}
                <div class="h-1.5 rounded bg-surface-600 overflow-hidden">
                    <div class="h-full bg-primary-500" style="width: {percent}%"></div>
                </div>
                <p class="text-xs text-surface-400">
                    {formatFileSize(q.bytesDone)} / {formatFileSize(
                        q.bytesTotal,
                    )}{#if q.state === 'running' && q.speed > 0}
                        · {formatFileSize(q.speed)}/s{/if}
                </p>
            {:else if q.mode === 'links'}
                <p class="text-xs text-surface-400">{m.downloads_handed()}</p>
            {/if}
        {/if}
    </div>
{/if}
