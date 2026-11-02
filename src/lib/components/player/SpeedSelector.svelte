<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import './player-presentation.css';
    import { playerStore } from './playerStore.svelte';
    import { watchTogether } from '$lib/stores/watchTogether.svelte';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        onclose?: () => void;
    }

    let { onclose }: Props = $props();

    const speeds = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

    function selectSpeed(speed: number) {
        playerStore.setPlaybackRate(speed);

        // Sync to watch party if in one
        if (watchTogether.isInWatchParty && watchTogether.getHasSyncedInitially()) {
            const state = playerStore.getState();
            watchTogether.syncPlaybackState(state.currentTime, state.isPlaying, speed);
        }

        onclose?.();
    }

    function formatSpeed(speed: number): string {
        if (speed === 1) return m.player_speed_normal();
        return `${speed}x`;
    }
</script>

<div class="speed-selector player-menu" role="menu" aria-label={m.player_playback_speed()}>
    <div class="header">
        <h3 class="title">{m.player_playback_speed()}</h3>
    </div>

    <div class="speed-options">
        {#each speeds as speed (speed)}
            <button
                class="speed-option"
                class:selected={playerStore.playbackRate === speed}
                onclick={() => selectSpeed(speed)}>
                <span class="speed-label">{formatSpeed(speed)}</span>
                {#if playerStore.playbackRate === speed}
                    <span class="check-icon">
                        <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                            <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z" />
                        </svg>
                    </span>
                {/if}
            </button>
        {/each}
    </div>
</div>

<style>
    .speed-selector {
        position: fixed;
        bottom: 80px;
        right: 20px;
        padding: 1rem;
        min-width: 180px;
        z-index: 100;
    }

    .header {
        padding-bottom: 0.5rem;
        border-bottom: 1px solid rgba(255, 255, 255, 0.1);
        margin-bottom: 0.5rem;
    }

    .title {
        font-size: 14px;
        font-weight: 600;
        color: white;
        margin: 0;
    }

    .speed-options {
        display: flex;
        flex-direction: column;
        gap: 0.25rem;
    }

    .speed-option {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 0.6rem 0.75rem;
        background: transparent;
        border: none;
        color: white;
        cursor: pointer;
        border-radius: 6px;
        transition: all 0.15s ease;
        font-size: 14px;
    }

    .speed-option:hover {
        background: rgba(255, 255, 255, 0.1);
    }

    .speed-option.selected {
        background: rgba(129, 140, 248, 0.15);
    }

    .speed-label {
        font-weight: 500;
    }

    .speed-option.selected .speed-label {
        color: #a5b4fc;
    }

    .check-icon {
        color: #a5b4fc;
        display: flex;
        align-items: center;
        justify-content: center;
    }

    /* Mobile portrait - center the popup */
    @media (max-width: 640px) and (orientation: portrait) {
        .speed-selector {
            position: fixed;
            bottom: auto;
            top: 50%;
            left: 50%;
            right: auto;
            transform: translate(-50%, -50%);
            width: calc(100vw - 64px);
            max-width: 280px;
        }
    }
</style>
