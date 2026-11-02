<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import type { LiveTvFailureInfo } from '$lib/api/livetv-failure-problem.js';
    import { liveTvFailurePresentation } from '$lib/components/player/livetv-failure-presentation.js';

    interface Props {
        channelName: string;
        /** Untyped failure (legacy copy). Ignored when `failure` is set. */
        failureType?: 'source_down' | 'connection_lost';
        /** Typed failure from the start request: code-specific copy and actions. */
        failure?: LiveTvFailureInfo;
        isAdmin?: boolean;
        onRetry: () => void;
        onClose: () => void;
        /** Offered for the codes where another channel is the useful next step. */
        onAnotherChannel?: () => void;
        modalId?: string;
    }

    const fallbackId = `stream-failure-${Math.random().toString(36).slice(2, 9)}`;

    let {
        channelName,
        failureType = 'source_down',
        failure,
        isAdmin = false,
        onRetry,
        onClose,
        onAnotherChannel,
        modalId = fallbackId,
    }: Props = $props();

    let presentation = $derived(
        failure
            ? liveTvFailurePresentation(failure.code, {
                  simple: false,
                  isAdmin,
                  retryable: failure.retryable,
                  feedsTried: failure.feedsTried,
              })
            : null,
    );
    let title = $derived(presentation?.title ?? m.livetv_stream_failure_title());
    let failureMessage = $derived(
        presentation?.message ??
            (failureType === 'connection_lost'
                ? m.livetv_stream_failure_connection_lost()
                : m.livetv_stream_failure_source_down()),
    );
    let canRetry = $derived(presentation ? presentation.actions.includes('retry') : true);
    let canTryAnother = $derived(
        !!onAnotherChannel && !!presentation?.actions.includes('another_channel'),
    );
</script>

<div
    class="bg-surface-800 w-full max-w-md rounded-xl p-6 shadow-xl"
    role="alertdialog"
    aria-labelledby="{modalId}-title"
    aria-describedby="{modalId}-desc">
    <div class="mb-4 flex items-center gap-3">
        <div class="bg-surface-700 flex h-10 w-10 items-center justify-center rounded-full">
            <svg
                class="h-5 w-5 text-surface-300"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2">
                <path
                    d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
                <line x1="12" y1="9" x2="12" y2="13" />
                <line x1="12" y1="17" x2="12.01" y2="17" />
            </svg>
        </div>
        <div>
            <h2 id="{modalId}-title" class="text-lg font-semibold text-white">
                {title}
            </h2>
            <p id="{modalId}-desc" class="text-sm text-surface-400">
                {channelName}
            </p>
        </div>
    </div>

    <p class="mb-5 text-sm text-surface-400">{failureMessage}</p>

    {#if presentation && presentation.feeds.length > 0}
        <ul class="mb-5 space-y-0.5 text-xs text-surface-400" data-testid="stream-failure-feeds">
            {#each presentation.feeds as feed, i (i)}
                <li class="flex justify-between gap-3">
                    <span class="truncate">{feed.name}</span>
                    <span class="shrink-0">{feed.reason}</span>
                </li>
            {/each}
        </ul>
    {/if}

    <div class="flex justify-end gap-3">
        <button class="btn variant-ghost-surface" onclick={onClose}>
            {m.livetv_stream_limit_close()}
        </button>
        {#if canTryAnother}
            <button class="btn variant-filled-primary" onclick={onAnotherChannel}>
                {m.livetv_failure_another_channel()}
            </button>
        {/if}
        {#if canRetry}
            <button
                class={canTryAnother ? 'btn variant-ghost-surface' : 'btn variant-filled-primary'}
                onclick={onRetry}>
                {m.livetv_stream_failure_try_again()}
            </button>
        {/if}
    </div>
</div>
