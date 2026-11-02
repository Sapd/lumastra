<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Inline card for a series whose watch marker is `finished`: the player stays
  paused behind it until the viewer picks the next season (when one exists),
  a rewatch from the start (when its first episode is known), or to stay on
  the current episode.
-->
<script lang="ts">
    import './player-presentation.css';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        title: string;
        showNextSeason: boolean;
        showRewatch: boolean;
        onnextseason: () => void;
        onrewatch: () => void;
        onstay: () => void;
    }

    let { title, showNextSeason, showRewatch, onnextseason, onrewatch, onstay }: Props = $props();
</script>

<div class="finished-card player-menu" role="dialog" aria-live="polite" aria-label={title}>
    <p class="finished-title">{title}</p>
    <div class="finished-actions">
        {#if showNextSeason}
            <button type="button" class="primary" onclick={onnextseason}>
                {m.watch_marker_finished_next_season()}
            </button>
        {/if}
        {#if showRewatch}
            <button type="button" class:primary={!showNextSeason} onclick={onrewatch}>
                {m.watch_marker_finished_rewatch()}
            </button>
        {/if}
        <button type="button" onclick={onstay}>{m.watch_marker_finished_stay()}</button>
    </div>
</div>

<style>
    .finished-card {
        position: fixed;
        left: 50%;
        bottom: 7rem;
        transform: translateX(-50%);
        z-index: 100;
        display: flex;
        flex-direction: column;
        gap: 0.75rem;
        max-width: min(32rem, calc(100vw - 2rem));
        padding: 1rem 1.25rem;
        color: white;
    }

    .finished-title {
        margin: 0;
        font-size: 1rem;
        font-weight: 600;
    }

    .finished-actions {
        display: flex;
        flex-wrap: wrap;
        gap: 0.5rem;
    }

    .finished-actions button {
        padding: 0.5rem 1rem;
        border: 1px solid rgba(255, 255, 255, 0.3);
        border-radius: 2rem;
        background: transparent;
        color: white;
        font-size: 0.9rem;
        cursor: pointer;
    }

    .finished-actions button:hover {
        background: rgba(255, 255, 255, 0.15);
    }

    .finished-actions button.primary {
        background: white;
        color: black;
        border-color: white;
    }
</style>
