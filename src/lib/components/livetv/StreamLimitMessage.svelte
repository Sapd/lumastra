<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import type { StreamLimitActiveChannel } from '$lib/schemas/livetv.js';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        limit: number;
        activeChannels: StreamLimitActiveChannel[];
        showActiveStreams: boolean;
        onJoinChannel: (channelId: string) => void;
        onRetry: () => void;
        onClose: () => void;
        modalId?: string;
    }

    const fallbackId = `stream-limit-${Math.random().toString(36).slice(2, 9)}`;

    let {
        limit,
        activeChannels,
        showActiveStreams,
        onJoinChannel,
        onRetry,
        onClose,
        modalId = fallbackId,
    }: Props = $props();
</script>

<div
    class="bg-surface-800 w-full max-w-md rounded-xl p-6 shadow-xl"
    role="alertdialog"
    aria-labelledby="{modalId}-title"
    aria-describedby="{modalId}-desc">
    <!-- Header -->
    <div class="mb-4 flex items-center gap-3">
        <div class="bg-surface-700 flex h-10 w-10 items-center justify-center rounded-full">
            <svg
                class="h-5 w-5 text-surface-300"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                stroke-width="2">
                <rect x="2" y="7" width="20" height="15" rx="2" ry="2" />
                <polyline points="17 2 12 7 7 2" />
            </svg>
        </div>
        <div>
            <h2 id="{modalId}-title" class="text-lg font-semibold text-white">
                {m.livetv_stream_limit_title()}
            </h2>
            <p id="{modalId}-desc" class="text-sm text-surface-400">
                {limit === 1
                    ? m.livetv_stream_limit_subtitle_one()
                    : m.livetv_stream_limit_subtitle({ limit: String(limit) })}
            </p>
        </div>
    </div>

    <!-- Active streams list -->
    {#if showActiveStreams && activeChannels.length > 0}
        <div class="mb-5">
            <h3 class="mb-2 text-xs font-medium uppercase tracking-wider text-surface-400">
                {m.livetv_stream_limit_currently_streaming()}
            </h3>
            <div class="space-y-2">
                {#each activeChannels as channel (channel.channelId)}
                    <button
                        class="bg-surface-700 hover:bg-surface-600 group flex w-full items-center gap-4 rounded-lg p-3 text-left transition-colors"
                        onclick={() => onJoinChannel(channel.channelId)}
                        aria-label={m.livetv_stream_limit_watch_channel({
                            channel: channel.channelName,
                        })}>
                        <div class="min-w-0 flex-1">
                            <span class="block truncate font-medium text-white">
                                {channel.channelName}
                            </span>
                            <span class="mt-0.5 block text-xs text-surface-400">
                                {#if channel.viewers > 0}
                                    {channel.viewers === 1
                                        ? m.livetv_stream_limit_viewer_singular({
                                              count: String(channel.viewers),
                                          })
                                        : m.livetv_stream_limit_viewer_plural({
                                              count: String(channel.viewers),
                                          })}
                                    ·
                                {/if}
                                {m.livetv_stream_limit_no_extra_connection()}
                            </span>
                        </div>
                        <span
                            class="flex shrink-0 items-center gap-1.5 rounded-full bg-primary-600/20 px-3 py-1.5 text-sm font-medium text-primary-300 transition-colors group-hover:bg-primary-600/30">
                            {m.livetv_stream_limit_join()}
                            <svg
                                class="h-3.5 w-3.5"
                                fill="currentColor"
                                viewBox="0 0 24 24"
                                aria-hidden="true">
                                <path d="M7 4.5v15l12.5-7.5L7 4.5z" />
                            </svg>
                        </span>
                    </button>
                {/each}
            </div>
        </div>
    {/if}

    <!-- Footer actions -->
    <div class="flex justify-end gap-3">
        <button class="btn variant-ghost-surface" onclick={onClose}>
            {m.livetv_stream_limit_close()}
        </button>
        <button class="btn variant-filled-primary" onclick={onRetry}>
            {m.livetv_stream_limit_retry()}
        </button>
    </div>
</div>
