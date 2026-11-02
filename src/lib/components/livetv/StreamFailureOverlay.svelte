<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        channelName: string;
        channelLogo?: string;
        currentProgram?: string;
        failureType: 'source_down' | 'connection_lost' | 'heartbeat_lost';
        diagnostic?: string;
        onRetry: () => void;
        onSwitchChannel: () => void;
    }

    let {
        channelName,
        channelLogo,
        currentProgram,
        failureType,
        diagnostic,
        onRetry,
        onSwitchChannel,
    }: Props = $props();

    let failureMessage = $derived.by(() => {
        switch (failureType) {
            case 'source_down':
                return m.livetv_stream_failure_source_down();
            case 'connection_lost':
                return m.livetv_stream_failure_connection_lost();
            case 'heartbeat_lost':
                return m.livetv_stream_failure_heartbeat_lost();
        }
    });

    let retryLabel = $derived(
        failureType === 'heartbeat_lost'
            ? m.livetv_stream_failure_reconnect()
            : m.livetv_stream_failure_try_again(),
    );
</script>

<div
    class="absolute inset-0 z-50 flex flex-col items-center justify-center bg-black/80 p-6 text-center"
    role="alert"
    aria-live="assertive">
    {#if channelLogo}
        <img
            src={channelLogo}
            alt={channelName}
            class="mb-3 h-12 w-12 rounded-lg object-contain bg-surface-900" />
    {/if}

    <p class="mb-1 text-lg font-semibold text-white">{channelName}</p>

    {#if currentProgram}
        <p class="mb-3 text-sm text-surface-400">{currentProgram}</p>
    {/if}

    <p class="mb-1 text-base font-medium text-white">
        {m.livetv_stream_failure_title()}
    </p>
    <p class="mb-6 max-w-xs text-sm text-surface-400">{failureMessage}</p>
    {#if diagnostic}
        <p class="-mt-4 mb-6 max-w-xs text-xs text-surface-500">{diagnostic}</p>
    {/if}

    <div class="flex gap-3">
        <button class="btn variant-filled-primary" onclick={onRetry}>
            {retryLabel}
        </button>
        <button class="btn variant-ghost-surface" onclick={onSwitchChannel}>
            {m.livetv_availability_back()}
        </button>
    </div>
</div>
