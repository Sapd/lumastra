<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * DownloadQueuePanel - small floating panel for the running / finished
     * download queue. Mounted once in the root layout so it outlives any modal.
     */
    import { downloadQueue, type FailureReason } from '$lib/downloads/download-queue.svelte';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages';

    const MAX_FAILURES_SHOWN = 5;

    let q = downloadQueue;
    let visible = $derived(q.state !== 'idle' || !!q.error || !!q.notice);
    let finished = $derived(
        q.items.filter((i) => ['done', 'skipped', 'handed'].includes(i.status)).length,
    );
    let failed = $derived(q.items.filter((i) => i.status === 'failed'));
    let waiting = $derived(q.items.some((i) => i.status === 'waiting'));
    let percent = $derived(
        q.bytesTotal > 0 ? Math.min(100, (q.bytesDone / q.bytesTotal) * 100) : 0,
    );

    function reasonText(reason: FailureReason | undefined): string {
        switch (reason) {
            case 'limit':
                return m.downloads_reason_limit();
            case 'network':
                return m.downloads_reason_network();
            case 'size_mismatch':
                return m.downloads_reason_size();
            case 'fat32':
                return m.downloads_reason_fat32();
            case 'forbidden':
                return m.downloads_error_not_allowed();
            case 'write':
                return m.downloads_reason_write();
            default:
                return m.downloads_reason_http();
        }
    }

    let errorText = $derived.by(() => {
        switch (q.error) {
            case undefined:
                return null;
            case 'downloads_not_allowed':
                return m.downloads_error_not_allowed();
            case 'nothing_to_download':
                return m.downloads_error_empty();
            default:
                return m.downloads_error_list();
        }
    });
    let noticeText = $derived(q.notice === 'busy' ? m.downloads_error_busy() : null);
    // Link mode hands over a batch at a time: "done" only once nothing is left to hand over.
    let nextBatch = $derived(
        q.state === 'running' ? 0 : Math.min(q.linksRemaining, q.linkBatch),
    );
    let stateText = $derived(
        q.state === 'done' && nextBatch > 0
            ? null
            : q.state === 'done'
            ? failed.length > 0
                ? m.downloads_state_done_failed({ count: failed.length })
                : m.downloads_state_done()
            : q.state === 'stopped'
              ? m.downloads_state_stopped()
              : null,
    );
    // Screen readers hear only state, error and the current file, never byte ticks.
    let announcement = $derived(
        errorText ??
            noticeText ??
            stateText ??
            (waiting ? m.downloads_waiting() : (q.current?.fileName ?? '')),
    );

    function close() {
        q.reset();
    }
</script>

{#if visible}
    <div
        class="fixed bottom-20 left-4 w-72 max-w-[calc(100vw-2rem)] bg-surface-800 rounded-lg shadow-xl p-3 space-y-2 text-sm"
        style="z-index: {Z.ADMIN_BANNER}"
        data-testid="download-queue-panel">
        <p class="sr-only" role="status" aria-live="polite" data-testid="download-announcer">
            {announcement}
        </p>
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
        {#if noticeText}
            <p class="text-surface-200">{noticeText}</p>
        {/if}
        {#if stateText && !errorText}
            <p class="text-surface-200" data-testid="download-state">{stateText}</p>
        {/if}
        {#if waiting}
            <p class="text-surface-200" data-testid="download-waiting">{m.downloads_waiting()}</p>
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
                <div class="h-1.5 rounded bg-surface-600 overflow-hidden" aria-hidden="true">
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
                {#if nextBatch > 0}
                    <button
                        type="button"
                        class="btn btn-sm variant-filled-primary"
                        data-testid="download-start-next"
                        onclick={() => void q.startNextLinks()}>
                        {q.profile.hint === 'ios'
                            ? m.downloads_start_next_one()
                            : m.downloads_start_next({ count: nextBatch })}
                    </button>
                {/if}
            {/if}
            {#if failed.length > 0}
                <ul class="text-xs text-amber-300 space-y-0.5" data-testid="download-failures">
                    {#each failed.slice(0, MAX_FAILURES_SHOWN) as f (f.fileId)}
                        <li>
                            <span class="break-all">{f.fileName}</span>: {reasonText(f.reason)}
                        </li>
                    {/each}
                    {#if failed.length > MAX_FAILURES_SHOWN}
                        <li>{m.downloads_more({ count: failed.length - MAX_FAILURES_SHOWN })}</li>
                    {/if}
                </ul>
            {/if}
        {/if}
    </div>
{/if}
