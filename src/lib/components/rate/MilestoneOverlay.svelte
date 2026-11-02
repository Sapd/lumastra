<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
  Presentational milestone celebration: shown when the caller crosses a
  rating-count milestone (5/25/50/...). CSS-only confetti-lite (no canvas
  dependency), auto-dismiss, and a manual dismiss button. Props in, events
  out — no API/store imports.
-->
<script lang="ts">
    import { Icon, Sparkles, XMark } from 'svelte-hero-icons';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages';

    interface Props {
        /** The milestone count reached (e.g. 5, 25, 50), or null to hide. */
        milestone: number | null;
        /** Auto-dismiss delay in ms. */
        autoDismissMs?: number;
        ondismiss: () => void;
    }

    let { milestone, autoDismissMs = 4000, ondismiss }: Props = $props();

    const CONFETTI_PIECES = Array.from({ length: 16 }, (_, i) => i);

    let dismissButton = $state<HTMLButtonElement | undefined>(undefined);

    $effect(() => {
        if (milestone === null) return;
        const timer = setTimeout(() => ondismiss(), autoDismissMs);
        return () => clearTimeout(timer);
    });

    // Move focus into the dialog while it's open; restore it on close so
    // keyboard/SR users land back where they were (typically the deck).
    $effect(() => {
        if (milestone === null || !dismissButton) return;
        const previouslyFocused =
            document.activeElement instanceof HTMLElement ? document.activeElement : null;
        dismissButton.focus();
        return () => previouslyFocused?.focus({ preventScroll: true });
    });

    function handleKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') {
            e.preventDefault();
            ondismiss();
        }
    }
</script>

{#if milestone !== null}
    <div
        class="fixed inset-0 flex items-center justify-center bg-black/60 px-4"
        style="z-index: {Z.FLOATING_MODAL}"
        role="dialog"
        aria-modal="true"
        aria-live="assertive"
        aria-labelledby="rate-milestone-title"
        tabindex="-1"
        onkeydown={handleKey}>
        <div
            class="relative w-full max-w-sm overflow-hidden rounded-2xl border border-primary-500/40 bg-surface-900 p-6 text-center shadow-2xl">
            <div class="pointer-events-none absolute inset-0 overflow-hidden" aria-hidden="true">
                {#each CONFETTI_PIECES as piece (piece)}
                    <span
                        class="confetti-piece"
                        style="left: {(piece * 61) % 100}%; animation-delay: {(piece % 8) *
                            0.12}s; background: {['#f59e0b', '#ec4899', '#8b5cf6', '#22c55e'][
                            piece % 4
                        ]};"></span>
                {/each}
            </div>

            <button
                type="button"
                class="absolute right-3 top-3 text-surface-400 hover:text-surface-100"
                aria-label={m.close()}
                onclick={ondismiss}>
                <Icon src={XMark} class="h-5 w-5" />
            </button>

            <Icon src={Sparkles} class="mx-auto mb-3 h-10 w-10 text-primary-400" />

            <h2 id="rate-milestone-title" class="mb-2 text-xl font-bold text-white">
                {m.rate_milestone_title({ count: String(milestone) })}
            </h2>
            <p class="mb-5 text-sm text-surface-300">
                {m.rate_milestone_body()}
            </p>

            <button
                type="button"
                class="btn variant-filled-primary w-full"
                bind:this={dismissButton}
                onclick={ondismiss}>
                {m.rate_milestone_dismiss()}
            </button>
        </div>
    </div>
{/if}

<style>
    .confetti-piece {
        position: absolute;
        top: -10%;
        width: 8px;
        height: 14px;
        opacity: 0.9;
        animation: confetti-fall 1.6s ease-in forwards;
    }

    @keyframes confetti-fall {
        from {
            transform: translateY(0) rotate(0deg);
            opacity: 1;
        }
        to {
            transform: translateY(420px) rotate(340deg);
            opacity: 0;
        }
    }

    @media (prefers-reduced-motion: reduce) {
        .confetti-piece {
            animation: none;
            opacity: 0;
        }
    }
</style>
