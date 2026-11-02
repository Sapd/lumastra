<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Episode-mode hint that the series watch marker is further on: the player is
  never moved on its own here, the viewer may go there or dismiss the hint.
-->
<script lang="ts">
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        message: string;
        ongo: () => void;
        ondismiss: () => void;
    }

    let { message, ongo, ondismiss }: Props = $props();
</script>

<div class="marker-hint" role="status">
    <span class="marker-hint-text">{message}</span>
    <button type="button" class="marker-hint-go" onclick={ongo}>{m.watch_marker_hint_go()}</button>
    <button type="button" class="marker-hint-close" aria-label={m.close()} onclick={ondismiss}>
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
            stroke-linecap="round"
            stroke-linejoin="round"
            aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
        </svg>
    </button>
</div>

<style>
    .marker-hint {
        position: fixed;
        top: 1rem;
        left: 50%;
        transform: translateX(-50%);
        z-index: 100;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        max-width: calc(100vw - 2rem);
        padding: 0.5rem 0.5rem 0.5rem 1rem;
        background: rgba(0, 0, 0, 0.8);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 2rem;
        color: white;
        font-size: 0.9rem;
        backdrop-filter: blur(8px);
    }

    .marker-hint-go {
        padding: 0.35rem 0.9rem;
        border: none;
        border-radius: 2rem;
        background: white;
        color: black;
        font-size: 0.85rem;
        cursor: pointer;
        white-space: nowrap;
    }

    .marker-hint-close {
        display: flex;
        padding: 0.35rem;
        border: none;
        border-radius: 50%;
        background: transparent;
        color: white;
        cursor: pointer;
    }

    .marker-hint-close:hover {
        background: rgba(255, 255, 255, 0.15);
    }
</style>
