<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    /**
     * DownloadQueuePanel - the persistent download card at the bottom of the toast stack
     * (ToastContainer renders it, so toasts pile above it and never overlap it). Collapsed
     * by default to one line; it expands by itself when the user must act (Start next N,
     * Retry) or something failed. A clean "Done" dismisses itself after a few seconds.
     * `hidden` (fullscreen player) keeps only the screen-reader announcer.
     */
    import { untrack } from 'svelte';
    import { Icon, ArrowDownTray, ChevronUp, ChevronDown } from 'svelte-hero-icons';
    import { downloadQueue, type FailureReason } from '$lib/downloads/download-queue.svelte';
    import { formatFileSize } from '$lib/utils/metric-formatters';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        hidden?: boolean;
    }

    let { hidden = false }: Props = $props();

    const MAX_FAILURES_SHOWN = 5;
    /** A clean "Done" stays this long. */
    const DONE_DISMISS_MS = 8000;

    let q = downloadQueue;
    let visible = $derived(q.state !== 'idle');
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
            case 'not_started':
                return m.downloads_reason_not_started();
            case 'files_unavailable':
                return m.downloads_reason_zip_unavailable();
            case 'too_large':
                return m.downloads_reason_zip_too_large();
            default:
                return m.downloads_reason_http();
        }
    }

    // A failure of the run itself (not a list outcome, those are toasts).
    let errorText = $derived(q.error ? m.downloads_error_not_allowed() : null);
    // Link mode hands over a batch at a time: "done" only once nothing is left to hand over.
    let nextBatch = $derived(q.state === 'running' ? 0 : Math.min(q.linksRemaining, q.linkBatch));
    let canRetryArchive = $derived(
        q.mode === 'zip' && q.state !== 'running' && failed.length > 0 && !q.error,
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
        errorText ?? stateText ?? (waiting ? m.downloads_waiting() : (q.current?.fileName ?? '')),
    );

    // Needs the user (or failed): show the details without a click.
    let needsAttention = $derived(nextBatch > 0 || canRetryArchive || failed.length > 0);
    let expanded = $state(false);
    $effect(() => {
        if (needsAttention) untrack(() => (expanded = true));
    });
    $effect(() => {
        if (!visible) untrack(() => (expanded = false));
    });

    // A clean finish goes away by itself; anything else stays until closed.
    let cleanDone = $derived(q.state === 'done' && !needsAttention && !errorText);
    $effect(() => {
        if (!cleanDone) return;
        const t = setTimeout(() => q.reset(), DONE_DISMISS_MS);
        return () => clearTimeout(t);
    });

    function close() {
        q.reset();
    }
</script>

{#if visible}
    <p class="sr-only" role="status" aria-live="polite" data-testid="download-announcer">
        {announcement}
    </p>
    {#if !hidden}
        <div
            class="pointer-events-auto w-80 max-w-[calc(100vw-2rem)] bg-surface-800 rounded-lg shadow-xl ring-1 ring-black/10 px-3 py-2 text-sm space-y-2"
            data-testid="download-queue-panel"
            data-expanded={expanded}>
            <div class="flex items-center gap-2">
                <Icon
                    src={ArrowDownTray}
                    class="w-4 h-4 shrink-0 text-surface-300"
                    aria-hidden="true" />
                <span
                    class="flex-1 min-w-0 truncate text-surface-100"
                    data-testid="download-summary-line">
                    {#if stateText}
                        {stateText}
                    {:else}
                        {finished}/{q.items.length}{#if q.mode === 'folder'}
                            · {Math.round(percent)} %{#if q.state === 'running' && q.speed > 0}
                                · {formatFileSize(q.speed)}/s{/if}{/if}
                    {/if}
                </span>
                <button
                    type="button"
                    class="shrink-0 rounded p-1 text-surface-300 hover:text-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
                    data-testid="download-toggle"
                    aria-expanded={expanded}
                    aria-label={expanded ? m.downloads_collapse() : m.downloads_expand()}
                    onclick={() => (expanded = !expanded)}>
                    <Icon
                        src={expanded ? ChevronDown : ChevronUp}
                        class="w-4 h-4"
                        aria-hidden="true" />
                </button>
                {#if q.state === 'running'}
                    <button
                        type="button"
                        class="shrink-0 text-surface-300 hover:text-white"
                        data-testid="download-cancel"
                        onclick={() => q.cancel()}>
                        {m.downloads_cancel()}
                    </button>
                {:else}
                    <button
                        type="button"
                        class="shrink-0 text-surface-300 hover:text-white"
                        data-testid="download-close"
                        onclick={close}>
                        {m.downloads_close()}
                    </button>
                {/if}
            </div>

            {#if expanded}
                {#if errorText}
                    <p class="text-amber-300">{errorText}</p>
                {/if}
                {#if stateText && !errorText}
                    <p class="text-surface-200" data-testid="download-state">{stateText}</p>
                {/if}
                {#if waiting}
                    <p class="text-surface-200" data-testid="download-waiting">
                        {m.downloads_waiting()}
                    </p>
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
                        <div
                            class="h-1.5 rounded bg-surface-600 overflow-hidden"
                            aria-hidden="true">
                            <div class="h-full bg-primary-500" style="width: {percent}%"></div>
                        </div>
                        <p class="text-xs text-surface-400">
                            {formatFileSize(q.bytesDone)} / {formatFileSize(
                                q.bytesTotal,
                            )}{#if q.state === 'running' && q.speed > 0}
                                · {formatFileSize(q.speed)}/s{/if}
                        </p>
                    {:else if q.mode === 'links' || q.mode === 'zip'}
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
                    {#if canRetryArchive}
                        <button
                            type="button"
                            class="btn btn-sm variant-filled-primary"
                            data-testid="download-retry"
                            onclick={() => void q.retryArchive()}>
                            {m.downloads_retry()}
                        </button>
                    {/if}
                    {#if failed.length > 0}
                        <ul
                            class="text-xs text-amber-300 space-y-0.5"
                            data-testid="download-failures">
                            {#each failed.slice(0, MAX_FAILURES_SHOWN) as f (f.fileId)}
                                <li>
                                    <span class="break-all">{f.fileName}</span>: {reasonText(
                                        f.reason,
                                    )}
                                </li>
                            {/each}
                            {#if failed.length > MAX_FAILURES_SHOWN}
                                <li>
                                    {m.downloads_more({
                                        count: failed.length - MAX_FAILURES_SHOWN,
                                    })}
                                </li>
                            {/if}
                        </ul>
                    {/if}
                {/if}
            {/if}
        </div>
    {/if}
{/if}
