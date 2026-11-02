<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    // The Live TV "this channel will not play" card: copy per failure code, a retry countdown
    // while the server says the failure is retryable, "Try another channel" where retrying the
    // same channel is pointless, and (admins) the feeds that were tried. Simple mode gets the
    // plainest wording and larger type.
    import { onMount } from 'svelte';
    import * as m from '$lib/paraglide/messages.js';
    import { liveTvFailurePresentation } from '$lib/components/player/livetv-failure-presentation.js';
    import type { LiveTvFailureView } from '$lib/components/player/livetv-failure-retry.js';

    interface Props {
        channelName: string;
        channelLogo?: string;
        failure: LiveTvFailureView;
        simple?: boolean;
        isAdmin?: boolean;
        onRetry: () => void;
        onCancelRetry: () => void;
        onAnotherChannel: () => void;
        onBack: () => void;
    }

    let {
        channelName,
        channelLogo,
        failure,
        simple = false,
        isAdmin = false,
        onRetry,
        onCancelRetry,
        onAnotherChannel,
        onBack,
    }: Props = $props();

    let presentation = $derived(
        liveTvFailurePresentation(failure.code, {
            simple,
            isAdmin,
            retryable: failure.retryable,
            feedsTried: failure.feedsTried,
        }),
    );

    let now = $state(Date.now());
    onMount(() => {
        const timer = setInterval(() => (now = Date.now()), 250);
        return () => clearInterval(timer);
    });

    let secondsLeft = $derived(
        failure.retryAt === undefined
            ? null
            : Math.max(1, Math.ceil((failure.retryAt - now) / 1000)),
    );
</script>

<div
    class="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-6 text-center"
    class:simple
    role="alert"
    aria-live="assertive"
    data-testid="livetv-failure-card">
    {#if channelLogo}
        <img
            src={channelLogo}
            alt={channelName}
            class="mb-3 h-12 w-12 rounded-lg object-contain bg-surface-900" />
    {/if}

    <p class="mb-1 font-semibold text-white" class:text-lg={!simple} class:text-3xl={simple}>
        {channelName}
    </p>
    <p class="mb-1 font-medium text-white" class:text-base={!simple} class:text-2xl={simple}>
        {presentation.title}
    </p>
    <p
        class="mb-4 text-surface-300"
        class:max-w-xs={!simple}
        class:text-sm={!simple}
        class:max-w-xl={simple}
        class:text-2xl={simple}
        data-testid="livetv-failure-message">
        {presentation.message}
    </p>

    {#if presentation.feeds.length > 0}
        <div
            class="mb-4 max-w-xs text-left text-xs text-surface-400"
            data-testid="livetv-failure-feeds">
            <p class="mb-1 font-medium text-surface-300">{m.livetv_failure_feeds_tried()}</p>
            <ul class="space-y-0.5">
                {#each presentation.feeds as feed, i (i)}
                    <li class="flex justify-between gap-3">
                        <span class="truncate">{feed.name}</span>
                        <span class="shrink-0">{feed.reason}</span>
                    </li>
                {/each}
            </ul>
        </div>
    {/if}

    {#if secondsLeft !== null}
        <p
            class="mb-4 text-surface-300"
            class:text-sm={!simple}
            class:text-2xl={simple}
            role="status"
            data-testid="livetv-failure-countdown">
            {simple
                ? m.livetv_failure_retry_in_simple({ seconds: String(secondsLeft) })
                : m.livetv_failure_retry_in({ seconds: String(secondsLeft) })}
        </p>
    {/if}

    <div class="flex flex-wrap items-center justify-center gap-3">
        {#if secondsLeft !== null}
            <button
                class="btn variant-ghost-surface"
                class:btn-lg={simple}
                onclick={onCancelRetry}
                data-testid="livetv-failure-cancel">
                {m.livetv_failure_cancel()}
            </button>
        {:else if presentation.actions.includes('retry')}
            <button
                class="btn variant-filled-primary"
                class:btn-lg={simple}
                onclick={onRetry}
                data-testid="livetv-failure-retry">
                {m.livetv_stream_failure_try_again()}
            </button>
        {/if}
        {#if presentation.actions.includes('another_channel')}
            <button
                class="btn variant-filled-primary"
                class:btn-lg={simple}
                onclick={onAnotherChannel}
                data-testid="livetv-failure-another">
                {simple
                    ? m.livetv_failure_another_channel_simple()
                    : m.livetv_failure_another_channel()}
            </button>
        {/if}
        <button
            class="btn variant-ghost-surface"
            class:btn-lg={simple}
            onclick={onBack}
            data-testid="livetv-failure-back">
            {simple ? m.livetv_simple_all_channels_home() : m.livetv_availability_back()}
        </button>
    </div>
</div>

<style>
    .simple button {
        min-height: 4rem;
        font-size: 1.5rem;
        font-weight: 800;
        padding-inline: 1.5rem;
    }
</style>
