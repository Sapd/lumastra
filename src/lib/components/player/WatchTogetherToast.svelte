<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { onDestroy } from 'svelte';
    import { fade, fly } from 'svelte/transition';
    import { flip } from 'svelte/animate';
    import { SvelteSet } from 'svelte/reactivity';
    import { getAvatarUrl } from '$lib/utils/image-utils';
    import * as m from '$lib/paraglide/messages.js';

    interface Toast {
        id: number;
        type: 'join' | 'leave' | 'play' | 'pause' | 'seek' | 'version' | 'stall' | 'disband';
        userId: string;
        displayName: string;
        timestamp: number;
    }

    let toasts: Toast[] = $state([]);
    let nextId = 0;
    const pendingTimers = new SvelteSet<ReturnType<typeof setTimeout>>();

    onDestroy(() => {
        for (const timer of pendingTimers) clearTimeout(timer);
        pendingTimers.clear();
    });

    function getActionText(type: Toast['type']): string {
        switch (type) {
            case 'join':
                return 'joined the party';
            case 'leave':
                return 'left the party';
            case 'play':
                return 'started playback';
            case 'pause':
                return 'paused';
            case 'seek':
                return 'seeked';
            case 'version':
                return 'switched version';
            case 'stall':
                return 'is buffering...';
            case 'disband':
                return 'ended the party';
        }
    }

    function getActionIcon(type: Toast['type']): string {
        switch (type) {
            case 'join':
                return '👋';
            case 'leave':
                return '👋';
            case 'play':
                return '▶️';
            case 'pause':
                return '⏸️';
            case 'seek':
                return '⏩';
            case 'version':
                return '🔄';
            case 'stall':
                return '⏳';
            case 'disband':
                return '🚪';
        }
    }

    export function showToast(type: Toast['type'], userId: string, displayName: string) {
        const id = nextId++;
        const toast: Toast = {
            id,
            type,
            userId,
            displayName: displayName || m.social_someone(),
            timestamp: Date.now(),
        };

        toasts = [...toasts, toast];

        // Auto-remove after 3 seconds
        const timer = setTimeout(() => {
            toasts = toasts.filter((t) => t.id !== id);
            pendingTimers.delete(timer);
        }, 3000);
        pendingTimers.add(timer);
    }

    function removeToast(id: number) {
        toasts = toasts.filter((t) => t.id !== id);
    }
</script>

<div class="toast-container">
    {#each toasts as toast (toast.id)}
        <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_noninteractive_element_interactions -->
        <div
            class="toast toast-{toast.type}"
            in:fly={{ x: 100, duration: 300 }}
            out:fade={{ duration: 200 }}
            animate:flip={{ duration: 300 }}
            onclick={() => removeToast(toast.id)}
            role="status">
            <img src={getAvatarUrl(toast.userId)} alt={toast.displayName} class="toast-avatar" />
            <div class="toast-content">
                <span class="toast-displayName">{toast.displayName}</span>
                <span class="toast-action">{getActionText(toast.type)}</span>
            </div>
            <span class="toast-icon">{getActionIcon(toast.type)}</span>
        </div>
    {/each}
</div>

<style>
    .toast-container {
        position: fixed;
        top: 5rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 10002;
        display: flex;
        flex-direction: column;
        gap: 0.5rem;
        pointer-events: none;
    }

    .toast {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.6rem 1rem;
        background: rgba(0, 0, 0, 0.85);
        backdrop-filter: blur(16px);
        border-radius: 50px;
        border: 1px solid rgba(255, 255, 255, 0.15);
        color: white;
        pointer-events: auto;
        cursor: pointer;
        transition:
            transform 0.2s,
            opacity 0.2s;
    }

    .toast:hover {
        transform: scale(1.02);
    }

    .toast-join {
        border-color: rgba(34, 197, 94, 0.5);
        box-shadow: 0 0 20px rgba(34, 197, 94, 0.2);
    }

    .toast-leave {
        border-color: rgba(239, 68, 68, 0.5);
        box-shadow: 0 0 20px rgba(239, 68, 68, 0.2);
    }

    .toast-play,
    .toast-pause,
    .toast-seek {
        border-color: rgba(139, 92, 246, 0.5);
        box-shadow: 0 0 20px rgba(139, 92, 246, 0.2);
    }

    .toast-version {
        border-color: rgba(59, 130, 246, 0.5);
        box-shadow: 0 0 20px rgba(59, 130, 246, 0.2);
    }

    .toast-stall {
        border-color: rgba(251, 191, 36, 0.5);
        box-shadow: 0 0 20px rgba(251, 191, 36, 0.2);
    }

    .toast-disband {
        border-color: rgba(239, 68, 68, 0.5);
        box-shadow: 0 0 20px rgba(239, 68, 68, 0.2);
    }

    .toast-avatar {
        width: 32px;
        height: 32px;
        border-radius: 50%;
        border: 2px solid rgba(255, 255, 255, 0.3);
        object-fit: cover;
    }

    .toast-content {
        display: flex;
        flex-direction: column;
        line-height: 1.2;
    }

    .toast-displayName {
        font-weight: 600;
        font-size: 0.85rem;
    }

    .toast-action {
        font-size: 0.75rem;
        color: rgba(255, 255, 255, 0.7);
    }

    .toast-icon {
        font-size: 1rem;
        margin-left: 0.25rem;
    }
</style>
