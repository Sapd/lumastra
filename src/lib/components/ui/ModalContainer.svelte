<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<script lang="ts">
    import { modals, modalStack, hasModals } from '$lib/stores/modal.store';
    import { fade, scale } from 'svelte/transition';
    import { cubicOut } from 'svelte/easing';
    import { browser } from '$app/environment';
    import { Z } from '$lib/utils/z-index';
    import * as m from '$lib/paraglide/messages';

    import { stopPropagation } from '$lib/utils/event-helpers';

    let originalOverflow = '';
    let originalHtmlOverflow = '';
    let originalPaddingRight = '';
    let modalLayerEl: HTMLElement = $state(null!);

    // Auto-wire aria-labelledby for dialogs that contain headings
    function labelDialogs() {
        if (!modalLayerEl) return;
        const dialogs = modalLayerEl.querySelectorAll<HTMLElement>('[role="dialog"]');
        dialogs.forEach((dialog, i) => {
            // Skip if already explicitly labelled
            if (dialog.getAttribute('aria-label') || dialog.getAttribute('aria-labelledby')) return;
            const heading = dialog.querySelector<HTMLElement>('h1, h2, h3, h4, h5, h6');
            if (heading) {
                // On some viewports the labelled heading is `display:none` (e.g.
                // the modal title is moved into a backdrop strip on mobile). A
                // hidden element still has `offsetParent === null`; in that case
                // point the dialog at a plain `aria-label` built from its text so
                // the accessible name is robust regardless of AT quirks. When the
                // heading is rendered, prefer `aria-labelledby` (live, reflects
                // text updates).
                const hidden = heading.offsetParent === null;
                const text = heading.textContent?.trim();
                if (hidden && text) {
                    dialog.setAttribute('aria-label', text);
                    dialog.removeAttribute('aria-labelledby');
                } else {
                    if (!heading.id) heading.id = `modal-heading-${i}`;
                    dialog.setAttribute('aria-labelledby', heading.id);
                    dialog.removeAttribute('aria-label');
                }
            }
        });
    }

    $effect(() => {
        // Track stack length so this re-runs when modals are pushed/popped
        const count = $modalStack.length;
        if (count > 0 && modalLayerEl) {
            // Run after Svelte renders the modal content
            requestAnimationFrame(labelDialogs);
        }
    });

    // === Making the layer actually visible from inside the video player ===
    //
    // Two independent things hide a modal opened from the player, and BOTH
    // have to be handled — fixing either one alone still leaves an invisible,
    // undismissable modal on the stack, which in turn wedges every consumer
    // that keys off `hasModals` (Search auto-hides itself for as long as a
    // modal is open, so its button then just flickers open/closed).
    //
    // 1. Native fullscreen. This layer is `position: fixed` at the document
    //    root, OUTSIDE the fullscreened `.player-container` subtree. The
    //    Fullscreen API paints only that subtree, so no z-index can rescue
    //    it — the only fix is to leave fullscreen.
    // 2. Stacking order. Even windowed, the player tier (`.watch-page` /
    //    `.player-container`, Z.PLAYER = 9000) is a sibling root-level
    //    stacking context that outranks this layer's Z.MODAL (1000) base,
    //    so the modal paints BEHIND the video.
    $effect(() => {
        if (browser && $modalStack.length > 0 && document.fullscreenElement) {
            document.exitFullscreen?.();
        }
    });

    // Lift the layer over the player tier while a player surface is mounted.
    // Probed from the DOM rather than from the route so embedded player
    // shells (lesson/event players) count too, and re-probed on every stack
    // change — the only moment the answer can matter.
    let baseZ = $state<number>(Z.MODAL);
    $effect(() => {
        const open = $modalStack.length > 0;
        if (!browser || !open) return;
        baseZ = document.querySelector('.player-container') ? Z.MODAL_OVER_PLAYER : Z.MODAL;
    });

    // Respect prefers-reduced-motion: when set, the open/close transition drops
    // the scale (transform) animation and falls back to a plain opacity fade.
    // Reactive so a runtime OS change is picked up.
    let reduceMotion = $state(false);
    $effect(() => {
        if (typeof window === 'undefined' || !window.matchMedia) return;
        const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
        reduceMotion = mq.matches;
        const onChange = (e: MediaQueryListEvent) => (reduceMotion = e.matches);
        mq.addEventListener('change', onChange);
        return () => mq.removeEventListener('change', onChange);
    });

    // Focus management: move focus INTO the topmost dialog whenever the TOP
    // modal changes (open, `modals.replace()`, or close-to-parent) and restore
    // it to the original page trigger once the last modal closes. Keyed on the
    // top modal's id, not the stack length, so a count-preserving replace (which
    // swaps the top dialog's DOM node) still re-focuses the new dialog, and a
    // mid-stack `closeById` (top id unchanged) doesn't yank focus around.
    let originalTrigger: HTMLElement | null = null;
    let prevTopId: string | null = null;

    /** Move focus onto the topmost dialog wrapper (role="dialog", tabindex=-1). */
    function focusTopDialog() {
        if (!modalLayerEl) return;
        const dialogs = modalLayerEl.querySelectorAll<HTMLElement>('[role="dialog"]');
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return;
        // Don't steal focus if it's already inside the dialog.
        if (dialog.contains(document.activeElement)) return;
        dialog.focus();
    }

    /** Restore focus to a saved trigger, guarding against it having left the DOM. */
    function restoreFocus(target: HTMLElement | null) {
        if (!target || typeof target.focus !== 'function') return;
        // The trigger may have been removed (e.g. a re-rendered list) — skip
        // silently rather than throwing.
        if (!document.contains(target)) return;
        target.focus();
    }

    $effect(() => {
        const stack = $modalStack;
        const topId = stack.length > 0 ? stack[stack.length - 1].id : null;
        if (!browser) {
            prevTopId = topId;
            return;
        }
        if (topId === null) {
            // Last modal closed — return focus to the page element that opened
            // the first modal.
            if (prevTopId !== null && originalTrigger) {
                const target = originalTrigger;
                requestAnimationFrame(() => restoreFocus(target));
            }
            originalTrigger = null;
            prevTopId = null;
            return;
        }
        if (prevTopId === null) {
            // First modal in a fresh stack — remember the page trigger so the
            // final close can return focus to it.
            originalTrigger = document.activeElement as HTMLElement | null;
        }
        if (topId !== prevTopId) {
            // Top dialog changed (open / replace / close-to-parent): move focus
            // into it. Closing a mid-stack modal leaves topId unchanged → no-op.
            prevTopId = topId;
            requestAnimationFrame(focusTopDialog);
        }
    });

    // Focus trap: keep focus inside the topmost modal dialog
    function trapFocus(event: KeyboardEvent) {
        if (!modalLayerEl) return;

        // Find the topmost dialog (last one in DOM order)
        const dialogs = modalLayerEl.querySelectorAll<HTMLElement>('[role="dialog"]');
        const dialog = dialogs[dialogs.length - 1];
        if (!dialog) return;

        const focusable = dialog.querySelectorAll<HTMLElement>(
            'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        );
        if (focusable.length === 0) {
            event.preventDefault();
            return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (event.shiftKey) {
            if (document.activeElement === first || !dialog.contains(document.activeElement)) {
                event.preventDefault();
                last.focus();
            }
        } else {
            if (document.activeElement === last || !dialog.contains(document.activeElement)) {
                event.preventDefault();
                first.focus();
            }
        }
    }

    // Escape key handler + focus trap
    async function handleKeydown(event: KeyboardEvent) {
        if (event.key === 'Tab' && $hasModals) {
            trapFocus(event);
            return;
        }
        if (event.key === 'Escape' && $hasModals) {
            const top = $modalStack[$modalStack.length - 1];
            if (top?.options?.closeOnEscape !== false) {
                await modals.close();
            }
        }
    }

    // Keydown filter for the dialog content wrapper. Escape and Tab must
    // bubble up to the window handler above (close + focus trap) — a blanket
    // stopPropagation here made Escape a dead key whenever focus sat inside
    // the dialog (which is always: we focus the dialog on open). Everything
    // else is still stopped so typing in a modal can't trigger global
    // shortcuts.
    function handleContentKeydown(event: KeyboardEvent) {
        if (event.key === 'Escape' || event.key === 'Tab') return;
        event.stopPropagation();
    }

    // Backdrop click. Closes the top modal only, EXCEPT for entity modals that
    // opt into `backdropClosesTrail` — those carry their own back button, so
    // popping one trail step here would surface the previous card and read as
    // "clicking outside reopened an old modal" instead of dismissing.
    async function handleBackdropClick() {
        const top = $modalStack[$modalStack.length - 1];
        if (top?.options?.closeOnBackdrop === false) return;
        if (top?.options?.backdropClosesTrail) {
            await modals.closeAll();
        } else {
            await modals.close();
        }
    }

    // Scroll lock + scrollbar compensation.
    // Must lock <html> too: on mobile the root scrolling element is <html>
    // (desktop app-shell locks both via CSS, but mobile lets <html> scroll so
    // iOS Safari's URL bar can shrink). Locking only <body> leaks touch
    // gestures to document scroll when a modal is open.
    $effect(() => {
        if (browser) {
            if ($hasModals) {
                originalOverflow = document.body.style.overflow;
                originalHtmlOverflow = document.documentElement.style.overflow;
                originalPaddingRight = document.body.style.paddingRight;

                const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;

                document.body.style.overflow = 'hidden';
                document.documentElement.style.overflow = 'hidden';
                if (scrollbarWidth > 0) {
                    document.body.style.paddingRight = `${scrollbarWidth}px`;
                }
            } else {
                document.body.style.overflow = originalOverflow;
                document.documentElement.style.overflow = originalHtmlOverflow;
                document.body.style.paddingRight = originalPaddingRight;
            }
        }
    });
</script>

<svelte:window onkeydown={handleKeydown} />

{#if $hasModals}
    <div class="modal-layer" style="z-index: {baseZ}" bind:this={modalLayerEl}>
        {#each $modalStack as { id, component, props, options }, index (id)}
            {#if index === $modalStack.length - 1}
                <div
                    class="backdrop"
                    style="z-index: {Z.MODAL + index}"
                    transition:fade={{ duration: 200 }}
                    onclick={handleBackdropClick}
                    onkeydown={(e) => e.key === 'Enter' && handleBackdropClick()}
                    role="button"
                    tabindex="0"
                    aria-label={m.modal_close_aria()}>
                </div>
            {/if}

            {@const SvelteComponent = component}
            <div
                class="positioner"
                class:stacked={index < $modalStack.length - 1}
                style="z-index: {Z.MODAL + 1 + index}">
                <div
                    class="content {options?.containerClass || ''}"
                    transition:scale={{
                        duration: 200,
                        start: reduceMotion ? 1 : 0.95,
                        easing: cubicOut,
                    }}
                    onclick={stopPropagation()}
                    onkeydown={handleContentKeydown}
                    role="dialog"
                    aria-modal="true"
                    aria-label={options?.ariaLabel || undefined}
                    tabindex="-1">
                    <SvelteComponent {...props} modalId={id} />
                </div>
            </div>
        {/each}
    </div>
{/if}

<style>
    .modal-layer {
        position: fixed;
        inset: 0;
        /* Fallback only — the inline style owns this and switches between
           Z.MODAL and Z.MODAL_OVER_PLAYER. Keep it non-auto so the layer
           always establishes a stacking context and the per-entry
           backdrop/positioner z-indexes below stay purely relative. */
        z-index: 1000; /* Z.MODAL */
    }

    .backdrop {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.7);
        backdrop-filter: blur(4px);
    }

    .positioner {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        /* --miniplayer-modal-inset is the MiniPlayer's measured footprint from
           the viewport bottom, including its real bottom offset (above the
           music bottom nav normally, at bottom:0 + safe area while lifted over
           a music modal). Without a player it falls back to the bottom nav. Adding
           --music-bottom-nav-h on top of the player height used to leave a
           ~3.5rem empty band under music modals on phones. */
        bottom: var(--miniplayer-modal-inset, var(--music-bottom-nav-h, 0px));
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 1rem;
        pointer-events: none;
    }

    .positioner.stacked {
        transform: scale(0.95);
        opacity: 0.5;
        pointer-events: none;
    }

    .content {
        pointer-events: auto;
        max-height: calc(
            100dvh - 2rem - var(--miniplayer-modal-inset, var(--music-bottom-nav-h, 0px))
        );
        max-width: calc(100vw - 2rem);
        overflow: auto;
    }

    /* Modal cards cap themselves at 90vh and scroll internally, but this
       wrapper caps at 100dvh - 2rem - miniplayer. With the mini-player open
       the wrapper is the SMALLER box, so both it and the card scroll — two
       scrollbars side by side. Re-cap direct card children to the wrapper's
       own budget (keeping 90vh as the aesthetic ceiling) so the card stays
       the single scroller. Desktop floating-card band only — page mode
       (below) stretches cards to h-full, which this cap must not shrink. */
    @media (min-width: 1024px) and (min-height: 720px) {
        .content > :global(.card) {
            max-height: min(
                90vh,
                100dvh - 2rem - var(--miniplayer-modal-inset, var(--music-bottom-nav-h, 0px))
            );
        }
    }

    /* Page mode: fullscreen page layout for narrow (<1024px) OR short (<720px)
       viewports — mirrors ModalMovie's page-mode fullscreen CSS so the modal
       content (which sizes itself to 100vw/100dvh) is positioned edge-to-edge.
       The <640px phone experience is a subset of this band and is unchanged.
       Desktop (>=1024px AND >=720px) keeps the floating card + miniplayer-aware
       max-height from the base .content rule above. */
    @media (max-width: 1023px), (max-height: 719px) {
        .positioner {
            padding: 0;
            align-items: stretch;
        }

        .content {
            max-height: none;
            max-width: 100vw;
            width: 100%;
            border-radius: 0;
            overflow: hidden;
        }
    }
</style>
