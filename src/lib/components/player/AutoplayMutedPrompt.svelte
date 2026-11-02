<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { fade, fly } from 'svelte/transition';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        visible?: boolean;
        showTutorial?: boolean;
        onunmute?: () => void;
        ondismiss?: () => void;
    }

    let { visible = false, showTutorial = false, onunmute, ondismiss }: Props = $props();

    function handleUnmute() {
        onunmute?.();
    }

    function handleDismiss() {
        ondismiss?.();
    }

    // Detect browser for tutorial text
    type BrowserType = 'Safari' | 'Chrome' | 'Firefox' | 'Edge' | 'generic';

    function getBrowserType(): BrowserType {
        if (typeof navigator === 'undefined') return 'generic';
        const ua = navigator.userAgent.toLowerCase();
        if (ua.includes('safari') && !ua.includes('chrome') && !ua.includes('chromium'))
            return 'Safari';
        if (ua.includes('firefox')) return 'Firefox';
        if (ua.includes('edg')) return 'Edge';
        if (ua.includes('chrome') || ua.includes('chromium')) return 'Chrome';
        return 'generic';
    }

    function getTutorialText(browser: BrowserType): string {
        switch (browser) {
            case 'Safari':
                return m.player_autoplay_blocked_safari();
            case 'Chrome':
            case 'Edge':
                return m.player_autoplay_blocked_chrome();
            case 'Firefox':
                return m.player_autoplay_blocked_firefox();
            default:
                return m.player_autoplay_blocked_generic();
        }
    }

    let browserType = $derived(getBrowserType());
    let tutorialText = $derived(getTutorialText(browserType));
</script>

{#if visible}
    <!-- Unmute button overlay - appears in bottom center above controls -->
    <div class="autoplay-muted-overlay" transition:fade={{ duration: 200 }}>
        <button
            class="unmute-button"
            onclick={handleUnmute}
            transition:fly={{ y: 20, duration: 300 }}>
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round">
                <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon>
                <line x1="23" y1="9" x2="17" y2="15"></line>
                <line x1="17" y1="9" x2="23" y2="15"></line>
            </svg>
            <span>{m.player_unmute()}</span>
        </button>

        {#if showTutorial}
            <div class="tutorial-hint" transition:fade={{ duration: 300, delay: 500 }}>
                <p class="tutorial-text">
                    {tutorialText}
                </p>
                <button class="dismiss-button" onclick={handleDismiss}>
                    {m.player_autoplay_understood()}
                </button>
            </div>
        {/if}
    </div>
{/if}

<style>
    .autoplay-muted-overlay {
        position: absolute;
        bottom: 7rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 60;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 1rem;
        pointer-events: none;
    }

    .unmute-button {
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.875rem 1.5rem;
        background: linear-gradient(
            135deg,
            rgb(var(--color-primary-500-rgb) / 0.9),
            rgba(139, 92, 246, 0.9)
        );
        border: none;
        border-radius: 9999px;
        color: white;
        font-size: 1rem;
        font-weight: 600;
        cursor: pointer;
        pointer-events: auto;
        box-shadow:
            0 4px 20px rgb(var(--color-primary-500-rgb) / 0.4),
            0 0 40px rgb(var(--color-primary-500-rgb) / 0.2);
        backdrop-filter: blur(8px);
        transition:
            transform 0.2s,
            box-shadow 0.2s;
        animation: pulse-glow 2s ease-in-out infinite;
    }

    .unmute-button:hover {
        transform: scale(1.05);
        box-shadow:
            0 6px 24px rgb(var(--color-primary-500-rgb) / 0.5),
            0 0 60px rgb(var(--color-primary-500-rgb) / 0.3);
    }

    .unmute-button:active {
        transform: scale(0.98);
    }

    .unmute-button svg {
        flex-shrink: 0;
    }

    @keyframes pulse-glow {
        0%,
        100% {
            box-shadow:
                0 4px 20px rgb(var(--color-primary-500-rgb) / 0.4),
                0 0 40px rgb(var(--color-primary-500-rgb) / 0.2);
        }
        50% {
            box-shadow:
                0 4px 30px rgb(var(--color-primary-500-rgb) / 0.6),
                0 0 60px rgb(var(--color-primary-500-rgb) / 0.3);
        }
    }

    .tutorial-hint {
        max-width: 320px;
        padding: 1rem 1.25rem;
        background: rgba(0, 0, 0, 0.85);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 1rem;
        backdrop-filter: blur(12px);
        pointer-events: auto;
        text-align: center;
    }

    .tutorial-text {
        margin: 0 0 0.75rem;
        font-size: 0.875rem;
        line-height: 1.5;
        color: rgba(255, 255, 255, 0.9);
    }

    .dismiss-button {
        padding: 0.5rem 1rem;
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 0.5rem;
        color: rgba(255, 255, 255, 0.8);
        font-size: 0.813rem;
        cursor: pointer;
        transition:
            background 0.2s,
            color 0.2s;
    }

    .dismiss-button:hover {
        background: rgba(255, 255, 255, 0.2);
        color: white;
    }

    /* Mobile adjustments */
    @media (max-width: 640px) {
        .autoplay-muted-overlay {
            bottom: 6rem;
        }

        .unmute-button {
            padding: 0.75rem 1.25rem;
            font-size: 0.9rem;
        }

        .tutorial-hint {
            max-width: 280px;
            margin: 0 1rem;
        }
    }
</style>
