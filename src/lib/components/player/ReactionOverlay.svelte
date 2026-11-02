<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import './player-presentation.css';
    import { onMount, onDestroy } from 'svelte';
    import { watchTogether } from '$lib/stores/watchTogether.svelte';
    import { REACTION_EMOJIS, SCREEN_EFFECTS } from '$lib/types/watch-together';

    // Active floating reactions on screen
    interface FloatingReaction {
        id: number;
        emoji: string;
        displayName: string;
        x: number; // Random horizontal position (%)
        startTime: number;
    }

    let floatingReactions: FloatingReaction[] = $state([]);
    let reactionCounter = 0;

    interface Props {
        // Reaction picker state
        showPicker?: boolean;
    }

    let { showPicker = $bindable(false) }: Props = $props();

    // Tab state: 'emojis' or 'effects'
    let activeTab: 'emojis' | 'effects' = $state('emojis');

    function addFloatingReaction(emoji: string, displayName: string) {
        const reaction: FloatingReaction = {
            id: reactionCounter++,
            emoji,
            displayName,
            x: 10 + Math.random() * 80, // 10-90% from left
            startTime: Date.now(),
        };

        floatingReactions = [...floatingReactions, reaction];

        // Remove after animation completes (3s)
        setTimeout(() => {
            floatingReactions = floatingReactions.filter((r) => r.id !== reaction.id);
        }, 3000);
    }

    function handleSendReaction(emoji: string) {
        watchTogether.sendReaction(emoji);
        showPicker = false;
    }

    function handleSendEffect(effectId: string) {
        watchTogether.sendScreenEffect(effectId);
        showPicker = false;
    }

    onMount(() => {
        // Listen for incoming reactions
        watchTogether.onReaction((emoji, userId, displayName) => {
            addFloatingReaction(emoji, displayName);
        });
    });
</script>

<!-- Floating reactions overlay -->
<div class="reaction-overlay">
    {#each floatingReactions as reaction (reaction.id)}
        <div class="floating-reaction" style="left: {reaction.x}%;">
            <span class="emoji">{reaction.emoji}</span>
            <span class="displayName">{reaction.displayName}</span>
        </div>
    {/each}
</div>

<!-- Reaction picker (shown when toggled) -->
{#if showPicker && watchTogether.isInWatchParty}
    <div class="reaction-picker player-menu">
        <!-- Tab buttons -->
        <div class="picker-tabs">
            <button
                class="tab-btn"
                class:active={activeTab === 'emojis'}
                onclick={() => (activeTab = 'emojis')}
                aria-label="Emoji reactions">
                <span class="tab-icon">😀</span>
                <span class="tab-label">Reactions</span>
            </button>
            <button
                class="tab-btn"
                class:active={activeTab === 'effects'}
                onclick={() => (activeTab = 'effects')}
                aria-label="Screen effects">
                <span class="tab-icon">✨</span>
                <span class="tab-label">Effects</span>
            </button>
        </div>

        <!-- Content -->
        <div class="picker-content">
            {#if activeTab === 'emojis'}
                <div class="emoji-grid">
                    {#each REACTION_EMOJIS as emoji (emoji)}
                        <button
                            class="reaction-btn"
                            onclick={() => handleSendReaction(emoji)}
                            aria-label="Send {emoji} reaction">
                            {emoji}
                        </button>
                    {/each}
                </div>
            {:else}
                <div class="effects-grid">
                    {#each SCREEN_EFFECTS as effect (effect.id)}
                        <button
                            class="effect-btn"
                            onclick={() => handleSendEffect(effect.id)}
                            aria-label="Trigger {effect.label} effect"
                            title={effect.label}>
                            <span class="effect-icon">{effect.icon}</span>
                            <span class="effect-label">{effect.label}</span>
                        </button>
                    {/each}
                </div>
            {/if}
        </div>
    </div>
{/if}

<style>
    .reaction-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 100px; /* Above controls */
        pointer-events: none;
        overflow: hidden;
        z-index: 50;
    }

    .floating-reaction {
        position: absolute;
        bottom: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        animation: float-up 3s ease-out forwards;
        pointer-events: none;
    }

    .emoji {
        font-size: 48px;
        filter: drop-shadow(0 2px 4px rgba(0, 0, 0, 0.5));
        animation: pulse 0.3s ease-out;
    }

    .displayName {
        font-size: 12px;
        color: white;
        background: rgba(0, 0, 0, 0.6);
        padding: 2px 8px;
        border-radius: 10px;
        margin-top: 4px;
        white-space: nowrap;
        opacity: 0.8;
    }

    @keyframes float-up {
        0% {
            transform: translateY(0) scale(1);
            opacity: 1;
        }
        70% {
            opacity: 1;
        }
        100% {
            transform: translateY(-400px) scale(0.8);
            opacity: 0;
        }
    }

    @keyframes pulse {
        0% {
            transform: scale(0.5);
        }
        50% {
            transform: scale(1.2);
        }
        100% {
            transform: scale(1);
        }
    }

    /* Reaction picker */
    .reaction-picker {
        position: fixed;
        bottom: 90px;
        left: 50%;
        transform: translateX(-50%);
        display: flex;
        flex-direction: column;
        z-index: 100;
        animation: picker-appear 0.2s ease-out;
        overflow: hidden;
        max-width: 90vw;
    }

    .picker-tabs {
        display: flex;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
    }

    .tab-btn {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        padding: 10px 16px;
        background: transparent;
        border: none;
        cursor: pointer;
        color: rgba(255, 255, 255, 0.6);
        transition: all 0.15s ease;
    }

    .tab-btn:hover {
        background: rgba(255, 255, 255, 0.05);
        color: white;
    }

    .tab-btn.active {
        color: white;
        background: rgba(255, 255, 255, 0.1);
    }

    .tab-icon {
        font-size: 18px;
    }

    .tab-label {
        font-size: 13px;
        font-weight: 500;
    }

    .picker-content {
        padding: 12px;
    }

    .emoji-grid {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
        justify-content: center;
    }

    .effects-grid {
        display: grid;
        grid-template-columns: repeat(5, 1fr);
        gap: 8px;
    }

    @keyframes picker-appear {
        0% {
            transform: translateX(-50%) translateY(20px);
            opacity: 0;
        }
        100% {
            transform: translateX(-50%) translateY(0);
            opacity: 1;
        }
    }

    .reaction-btn {
        font-size: 28px;
        background: transparent;
        border: none;
        cursor: pointer;
        padding: 8px;
        border-radius: 50%;
        transition: all 0.15s ease;
        line-height: 1;
    }

    .reaction-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        transform: scale(1.2);
    }

    .reaction-btn:active {
        transform: scale(0.95);
    }

    .effect-btn {
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 4px;
        padding: 10px 8px;
        background: rgba(255, 255, 255, 0.05);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 12px;
        cursor: pointer;
        transition: all 0.15s ease;
        min-width: 64px;
    }

    .effect-btn:hover {
        background: rgba(255, 255, 255, 0.15);
        transform: scale(1.05);
        border-color: rgba(255, 255, 255, 0.2);
    }

    .effect-btn:active {
        transform: scale(0.95);
    }

    .effect-icon {
        font-size: 24px;
    }

    .effect-label {
        font-size: 10px;
        color: rgba(255, 255, 255, 0.7);
        white-space: nowrap;
    }

    /* Mobile: smaller picker */
    @media (max-width: 600px) {
        .reaction-picker {
            bottom: 70px;
            width: calc(100vw - 20px);
            max-width: none;
        }

        .picker-content {
            padding: 8px;
        }

        .emoji-grid {
            gap: 4px;
        }

        .effects-grid {
            grid-template-columns: repeat(5, 1fr);
            gap: 6px;
        }

        .reaction-btn {
            font-size: 24px;
            padding: 6px;
        }

        .effect-btn {
            padding: 8px 4px;
            min-width: auto;
        }

        .effect-icon {
            font-size: 20px;
        }

        .effect-label {
            font-size: 9px;
        }

        .emoji {
            font-size: 36px;
        }

        .tab-label {
            display: none;
        }

        .tab-btn {
            padding: 8px 12px;
        }
    }
</style>
