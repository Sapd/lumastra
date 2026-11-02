<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        channelName: string;
        channelLogo?: string;
        /** Cause-specific heading; defaults to the priority-eviction wording. */
        title?: string;
        /** Cause-specific explanation; defaults to the priority-eviction wording. */
        message?: string;
        onBrowseChannels: () => void;
    }

    let { channelName, channelLogo, title, message, onBrowseChannels }: Props = $props();
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

    <p class="mb-1 text-base font-medium text-warning-400">
        {title ?? m.livetv_stream_kicked_title()}
    </p>
    <p class="mb-6 max-w-xs text-sm text-surface-400">
        {message ?? m.livetv_stream_kicked_message()}
    </p>

    <div class="flex gap-3">
        <button class="btn variant-filled-warning" onclick={onBrowseChannels}>
            {m.livetv_stream_kicked_browse_channels()}
        </button>
    </div>
</div>
