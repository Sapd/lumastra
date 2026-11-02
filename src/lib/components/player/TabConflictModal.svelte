<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import './player-presentation.css';
    // Modal shown when a same-browser probe detects another tab playing the
    // same media. The user picks Continue here (proceed → server will
    // supersede the other tab via startPlaySession's kill-prior transaction)
    // or Cancel (do nothing → other tab keeps playing).
    //
    // Esc = Cancel. Focus is moved to the primary button on mount.
    import { fade, fly } from 'svelte/transition';
    import * as m from '$lib/paraglide/messages.js';

    interface Props {
        visible: boolean;
        onResolve: (proceed: boolean) => void;
    }

    let { visible, onResolve }: Props = $props();

    let primaryBtn: HTMLButtonElement | undefined = $state();

    function handleContinue(): void {
        onResolve(true);
    }
    function handleCancel(): void {
        onResolve(false);
    }

    function onKeydown(e: KeyboardEvent): void {
        if (!visible) return;
        if (e.key === 'Escape') {
            e.preventDefault();
            handleCancel();
        }
    }

    $effect(() => {
        if (visible) {
            // Defer focus until the element is in the DOM after the
            // transition starts. Using queueMicrotask is enough — fade-in
            // doesn't block focus and we want it grabbed before the user
            // could possibly interact.
            queueMicrotask(() => primaryBtn?.focus());
        }
    });
</script>

<svelte:window onkeydown={onKeydown} />

{#if visible}
    <div
        class="tab-conflict-backdrop"
        transition:fade={{ duration: 150 }}
        role="presentation"
        onclick={handleCancel}>
    </div>
    <div
        class="tab-conflict-modal player-menu"
        role="dialog"
        aria-modal="true"
        aria-labelledby="tab-conflict-title"
        aria-describedby="tab-conflict-body"
        transition:fly={{ y: 20, duration: 200 }}>
        <h2 id="tab-conflict-title" class="tab-conflict-title">
            {m.tab_conflict_title()}
        </h2>
        <p id="tab-conflict-body" class="tab-conflict-body">
            {m.tab_conflict_body()}
        </p>
        <div class="tab-conflict-actions">
            <button type="button" class="btn-ghost" onclick={handleCancel}>
                {m.tab_conflict_cancel()}
            </button>
            <button
                bind:this={primaryBtn}
                type="button"
                class="btn-primary"
                onclick={handleContinue}>
                {m.tab_conflict_continue()}
            </button>
        </div>
    </div>
{/if}

<style>
    .tab-conflict-backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        backdrop-filter: blur(2px);
        z-index: 80;
    }

    .tab-conflict-modal {
        position: fixed;
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
        z-index: 81;
        max-width: 28rem;
        width: calc(100vw - 2rem);
        padding: 1.5rem;
        color: white;
    }

    .tab-conflict-title {
        margin: 0 0 0.5rem;
        font-size: 1.125rem;
        font-weight: 600;
    }

    .tab-conflict-body {
        margin: 0 0 1.25rem;
        font-size: 0.9rem;
        line-height: 1.5;
        color: rgba(255, 255, 255, 0.8);
    }

    .tab-conflict-actions {
        display: flex;
        gap: 0.5rem;
        justify-content: flex-end;
    }

    .btn-primary,
    .btn-ghost {
        padding: 0.5rem 1rem;
        font-size: 0.875rem;
        font-weight: 600;
        border-radius: 0.5rem;
        cursor: pointer;
        transition:
            background 0.15s,
            transform 0.1s;
    }

    .btn-primary {
        background: linear-gradient(
            135deg,
            rgb(var(--color-primary-500-rgb) / 0.95),
            rgba(139, 92, 246, 0.95)
        );
        color: white;
        border: none;
    }
    .btn-primary:hover {
        transform: translateY(-1px);
    }
    .btn-primary:focus-visible {
        outline: 2px solid rgba(255, 255, 255, 0.6);
        outline-offset: 2px;
    }

    .btn-ghost {
        background: transparent;
        color: rgba(255, 255, 255, 0.85);
        border: 1px solid rgba(255, 255, 255, 0.2);
    }
    .btn-ghost:hover {
        background: rgba(255, 255, 255, 0.08);
    }
    .btn-ghost:focus-visible {
        outline: 2px solid rgba(255, 255, 255, 0.4);
        outline-offset: 2px;
    }
</style>
