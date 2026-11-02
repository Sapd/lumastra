<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!-- src/lib/components/player/AnnotationPopup.svelte -->
<script lang="ts">
    import './player-presentation.css';
    import { fly } from 'svelte/transition';
    import { SvelteSet } from 'svelte/reactivity';
    import type { AnnotationData } from '$lib/types/media-annotations';
    import * as m from '$lib/paraglide/messages';
    import { formatUsername } from '$lib/utils/data-extraction';
    import { getAvatarUrl } from '$lib/utils/image-utils';

    interface Props {
        currentTime: number;
        duration: number;
        pins: AnnotationData[];
        enabled: boolean;
    }

    let { currentTime, duration, pins, enabled }: Props = $props();

    // Track which pin IDs have already been shown this playback session
    const shown = new SvelteSet<string>();
    let activePopup = $state<AnnotationData | null>(null);
    let dismissTimer: ReturnType<typeof setTimeout> | null = null;

    // Horizontal position of the popup as a percentage (0–100), clamped to keep
    // the popup visible. We derive it from the pin's timestamp and the total duration.
    const POPUP_WIDTH_PX = 300;
    let popupEl = $state<HTMLDivElement | null>(null);

    let pinPercent = $derived.by(() => {
        if (!activePopup || !duration || duration <= 0) return 50;
        return Math.min(100, Math.max(0, (Number(activePopup.timestamp_seconds) / duration) * 100));
    });

    $effect(() => {
        if (!enabled || pins.length === 0) return;
        // Find a pin within 1 second of currentTime that hasn't been shown yet
        const match = pins.find(
            (p) =>
                p.timestamp_seconds != null &&
                !shown.has(p.id) &&
                Math.abs(Number(p.timestamp_seconds) - currentTime) < 1,
        );
        if (match) {
            shown.add(match.id);
            showPopup(match);
        }
    });

    function showPopup(pin: AnnotationData): void {
        activePopup = pin;
        if (dismissTimer) clearTimeout(dismissTimer);
        dismissTimer = setTimeout(() => {
            activePopup = null;
        }, 8000);
    }

    function dismiss(): void {
        activePopup = null;
        if (dismissTimer) clearTimeout(dismissTimer);
    }

    function handleImageError(event: Event): void {
        const img = event.target as HTMLImageElement;
        if (img) img.style.display = 'none';
    }

    // Clean up timer on component destroy
    $effect(() => {
        return () => {
            if (dismissTimer) clearTimeout(dismissTimer);
        };
    });
</script>

{#if activePopup}
    <div
        bind:this={popupEl}
        class="annotation-popup player-menu"
        style="left: clamp(8px, calc({pinPercent}% - {POPUP_WIDTH_PX /
            2}px), calc(100% - {POPUP_WIDTH_PX + 8}px))"
        role="status"
        transition:fly={{ y: 6, duration: 220 }}>
        <!-- Arrow pointing down toward seekbar -->
        <div class="popup-arrow"></div>
        <div class="popup-header">
            <!-- Avatar -->
            <div class="popup-avatar">
                <span class="popup-avatar-initial">
                    {activePopup.username.slice(0, 1).toUpperCase()}
                </span>
                <img
                    src={getAvatarUrl(activePopup.username)}
                    alt={activePopup.username}
                    class="popup-avatar-img"
                    onerror={handleImageError} />
            </div>
            <span class="popup-user">{formatUsername(activePopup.username)}</span>
            <button
                class="popup-dismiss"
                onclick={dismiss}
                aria-label={m.annotations_popup_dismiss()}>
                ✕
            </button>
        </div>
        <p class="popup-content">{activePopup.content}</p>
    </div>
{/if}

<style>
    .annotation-popup {
        position: absolute;
        /* Sit just above the controls bar (~56px) with a small gap */
        bottom: 68px;
        width: 300px;
        padding: 0.6rem 0.75rem 0.65rem;
        z-index: 60;
    }
    /* Small triangle pointing down toward the seekbar */
    .popup-arrow {
        position: absolute;
        bottom: -6px;
        left: 50%;
        transform: translateX(-50%);
        width: 0;
        height: 0;
        border-left: 6px solid transparent;
        border-right: 6px solid transparent;
        border-top: 6px solid rgba(255, 255, 255, 0.12);
    }
    .popup-header {
        display: flex;
        align-items: center;
        gap: 0.45rem;
        margin-bottom: 0.35rem;
    }
    .popup-avatar {
        position: relative;
        width: 22px;
        height: 22px;
        border-radius: 50%;
        overflow: hidden;
        background: #374151;
        flex-shrink: 0;
    }
    .popup-avatar-initial {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-size: 10px;
        font-weight: 600;
        color: #9ca3af;
    }
    .popup-avatar-img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
    }
    .popup-user {
        font-size: 0.75rem;
        font-weight: 600;
        color: #f59e0b;
        flex: 1;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .popup-dismiss {
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.45);
        cursor: pointer;
        font-size: 0.75rem;
        padding: 0.25rem 0.35rem;
        border-radius: 4px;
        line-height: 1;
        flex-shrink: 0;
        transition:
            color 0.15s,
            background 0.15s;
    }
    .popup-dismiss:hover {
        color: rgba(255, 255, 255, 0.85);
        background: rgba(255, 255, 255, 0.1);
    }
    .popup-content {
        font-size: 0.82rem;
        color: white;
        margin: 0;
        line-height: 1.4;
    }
</style>
