<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->
<!--
  Guest-side watch-party sync/drift indicator, extracted so it can render both
  inside the watch-party panel (with a pin toggle) and as a standalone pinned
  chip that stays visible when the panel is closed. Reads the shared
  watchTogether store directly.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';
    import { watchTogether } from '$lib/stores/watchTogether.svelte';

    interface Props {
        /** Show the pin toggle button (panel usage). */
        showPin?: boolean;
        /** Current pinned state (drives the pin button icon). */
        pinned?: boolean;
        /** Toggle handler for the pin button. */
        onTogglePin?: () => void;
        /** Standalone/pinned render — floats as a compact chip. */
        standalone?: boolean;
    }

    let { showPin = false, pinned = false, onTogglePin, standalone = false }: Props = $props();

    function formatTimeToSync(seconds: number | null): string {
        if (seconds === null) return '';
        if (seconds < 60) return `~${Math.round(seconds)}s`;
        return `~${Math.round(seconds / 60)}m`;
    }
    function getTrendArrow(trend: 'improving' | 'worsening' | 'stable'): string {
        return trend === 'improving' ? '↓' : trend === 'worsening' ? '↑' : '→';
    }
    function formatDrift(drift: number): string {
        const sign = drift >= 0 ? '+' : '';
        return `${sign}${drift.toFixed(1)}s`;
    }
    function formatRate(rate: number): string {
        return `${rate.toFixed(2)}x`;
    }

    let isSynced = $derived(Math.abs(watchTogether.watchPartyDrift) < 0.5);
    let syncing = $derived(watchTogether.isWatchPartySyncing);
</script>

<div class="sync-status" class:standalone>
    {#if syncing}
        <div class="sync-indicator syncing">
            <svg class="syncing-spinner" viewBox="0 0 24 24" width="14" height="14">
                <circle
                    cx="12"
                    cy="12"
                    r="10"
                    stroke="currentColor"
                    stroke-width="2"
                    fill="none"
                    stroke-linecap="round"
                    stroke-dasharray="31.4 31.4" />
            </svg>
            <span>{m.watch_party_syncing()}</span>
        </div>
    {:else}
        <div
            class="sync-indicator"
            class:synced={isSynced}
            class:catching-up={!isSynced && watchTogether.watchPartyCatchUpMode === 'catching-up'}
            class:slowing-down={!isSynced &&
                watchTogether.watchPartyCatchUpMode === 'slowing-down'}>
            {#if isSynced}
                <span class="sync-icon">✓</span>
                <span>{m.watch_party_synced()}</span>
            {:else}
                <span class="sync-drift">{formatDrift(watchTogether.watchPartyDrift)}</span>
                <span
                    class="sync-trend"
                    class:improving={watchTogether.watchPartyDriftTrend === 'improving'}
                    class:worsening={watchTogether.watchPartyDriftTrend === 'worsening'}
                    >{getTrendArrow(watchTogether.watchPartyDriftTrend)}</span>
                <span class="sync-rate">({formatRate(watchTogether.watchPartyPlaybackRate)})</span>
                {#if watchTogether.watchPartyTimeToSync !== null}
                    <span class="sync-eta"
                        >{formatTimeToSync(watchTogether.watchPartyTimeToSync)}</span>
                {/if}
            {/if}
        </div>
    {/if}

    {#if showPin}
        <button
            type="button"
            class="pin-btn"
            class:active={pinned}
            aria-pressed={pinned}
            aria-label={pinned ? 'Unpin sync status' : 'Keep sync status visible'}
            title={pinned ? 'Unpin sync status' : 'Keep sync status visible'}
            onclick={onTogglePin}>
            <svg
                viewBox="0 0 24 24"
                width="13"
                height="13"
                fill={pinned ? 'currentColor' : 'none'}
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round">
                <path d="M12 17v5" />
                <path
                    d="M9 10.8V6a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1v4.8a2 2 0 0 1-1.1 1.8l-1.8.9A2 2 0 0 0 5 15.2V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.8a2 2 0 0 0-1.1-1.8l-1.8-.9A2 2 0 0 1 15 10.8V6a1 1 0 0 1 1-1" />
            </svg>
        </button>
    {/if}
</div>

<style>
    .sync-status {
        display: flex;
        align-items: center;
        gap: 0.35rem;
    }

    /* Standalone/pinned chip: floats top-right just under the watch-party avatar
       (the avatar cluster sits at top:1.5rem and is ~44px tall). Stays visible
       over the video even when the controls hide; the parent hides it while the
       panel is open, since the panel drops into this same spot and shows the
       status itself. */
    .sync-status.standalone {
        position: absolute;
        top: 4.75rem;
        right: calc(1.5rem + env(safe-area-inset-right, 0px));
        left: auto;
        z-index: 40;
        pointer-events: none;
        background: rgba(0, 0, 0, 0.55);
        padding: 0.2rem 0.3rem;
        border-radius: 8px;
        backdrop-filter: blur(4px);
    }

    .sync-indicator {
        display: flex;
        align-items: center;
        gap: 0.35rem;
        padding: 0.35rem 0.5rem;
        border-radius: 6px;
        font-size: 0.7rem;
        font-weight: 500;
    }

    /* In-panel usage keeps the original bottom margin; standalone drops it. */
    .sync-status:not(.standalone) .sync-indicator {
        margin-bottom: 0;
    }

    .sync-indicator.synced {
        background: rgba(34, 197, 94, 0.2);
        border: 1px solid rgba(34, 197, 94, 0.4);
        color: #86efac;
    }

    .sync-indicator.catching-up {
        background: rgba(59, 130, 246, 0.2);
        border: 1px solid rgba(59, 130, 246, 0.4);
        color: #93c5fd;
    }

    .sync-indicator.slowing-down {
        background: rgba(249, 115, 22, 0.2);
        border: 1px solid rgba(249, 115, 22, 0.4);
        color: #fdba74;
    }

    .sync-indicator.syncing {
        background: rgba(139, 92, 246, 0.2);
        border: 1px solid rgba(139, 92, 246, 0.4);
        color: #c4b5fd;
    }

    .sync-icon {
        font-size: 0.6rem;
        letter-spacing: -1px;
    }

    .sync-drift {
        font-size: 0.7rem;
        font-weight: 600;
        font-variant-numeric: tabular-nums;
    }

    .sync-trend {
        font-size: 0.75rem;
        opacity: 0.8;
    }

    .sync-trend.improving {
        color: #86efac;
    }

    .sync-trend.worsening {
        color: #fca5a5;
    }

    .sync-rate {
        font-size: 0.65rem;
        opacity: 0.7;
        font-variant-numeric: tabular-nums;
    }

    .sync-eta {
        background: rgba(0, 0, 0, 0.3);
        padding: 1px 4px;
        border-radius: 3px;
        font-size: 0.6rem;
        font-variant-numeric: tabular-nums;
        opacity: 0.8;
    }

    .syncing-spinner {
        animation: spin 1s linear infinite;
    }

    .pin-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border: 1px solid rgba(255, 255, 255, 0.15);
        border-radius: 6px;
        background: rgba(255, 255, 255, 0.06);
        color: rgba(255, 255, 255, 0.6);
        cursor: pointer;
        transition: all 0.15s;
        flex-shrink: 0;
    }

    .pin-btn:hover {
        background: rgba(255, 255, 255, 0.12);
        color: rgba(255, 255, 255, 0.9);
    }

    .pin-btn.active {
        background: rgba(139, 92, 246, 0.25);
        border-color: rgba(139, 92, 246, 0.5);
        color: #c4b5fd;
    }

    @keyframes spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
