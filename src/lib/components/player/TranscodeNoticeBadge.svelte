<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    A short, calm line about the server's video encoder: busy (another app
    holds the GPU encoder), too slow (CPU), or switched to software. Which one
    is decided by transcodeNotice() in transcode-progress-view.ts; this only
    renders it. Informational, never an error: playback continues.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import type { TranscodeNotice } from './transcode-progress-view.js';

    interface Props {
        notice: TranscodeNotice | null;
    }

    let { notice }: Props = $props();

    const text = $derived.by(() => {
        switch (notice) {
            case 'gpu_busy':
                return m.player_notice_encoder_busy();
            case 'cpu_slow':
                return m.player_notice_cpu_slow();
            case 'software_fallback':
                return m.player_notice_software_fallback();
            case 'software_fallback_slow':
                return m.player_notice_software_fallback_slow();
            default:
                return null;
        }
    });
</script>

{#if text}
    <div class="transcode-notice" role="status" aria-live="polite" data-notice={notice}>
        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16" aria-hidden="true">
            <path
                d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z" />
        </svg>
        <span>{text}</span>
    </div>
{/if}

<style>
    /* Positioned by the parent: the info-badge area's last row, or its anchor. */
    .transcode-notice {
        display: flex;
        align-items: flex-start;
        gap: 0.5rem;
        max-width: 36rem;
        padding: 0.45rem 0.75rem;
        background: rgba(0, 0, 0, 0.7);
        color: rgba(255, 255, 255, 0.95);
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        line-height: 1.35;
        pointer-events: none;
        backdrop-filter: blur(4px);
    }

    .transcode-notice svg {
        flex-shrink: 0;
        margin-top: 1px;
        color: rgba(255, 255, 255, 0.75);
    }
</style>
