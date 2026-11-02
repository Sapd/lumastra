<!--
  SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
  SPDX-License-Identifier: AGPL-3.0-only
-->

<!--
    ActionPopover.svelte

    Generic trigger-anchored popover for the modal action bar. Renders a
    trigger button (caller-supplied contents via the `trigger` snippet) and,
    when open, a floating panel (caller-supplied contents via `content`)
    positioned relative to the trigger with @floating-ui/dom.

    Used to declutter ModalActions.svelte: collapses a cluster of always-
    visible buttons behind a single trigger (e.g. the rating cluster, or the
    admin-only settings/debug utilities).

    Accessibility:
    - Trigger has aria-haspopup/aria-expanded.
    - Escape closes and returns focus to the trigger.
    - Outside pointerdown closes (guarded against the opening gesture).
    - On open, focus moves to the first focusable element in the panel.
    - Panel is portaled to document.body so position: fixed always resolves
      against the viewport, even inside transformed/overflow ancestors (the
      modal footer's horizontal scroller).

    Usage:
        <ActionPopover ariaLabel="Rate">
            {#snippet trigger()}
                <span>⭐ Rate</span>
            {/snippet}
            {#snippet content({ close })}
                <button onclick={close}>...</button>
            {/snippet}
        </ActionPopover>
-->
<script lang="ts">
    import { tick } from 'svelte';
    import type { Snippet } from 'svelte';
    import {
        computePosition,
        autoUpdate,
        offset,
        flip,
        shift,
        type Placement,
    } from '@floating-ui/dom';
    import { Z } from '$lib/utils/z-index';

    interface Props {
        /** aria-label for the trigger button. */
        ariaLabel: string;
        /** Tooltip/title text for the trigger button (defaults to ariaLabel). */
        title?: string;
        /** Placement of the panel relative to the trigger. */
        placement?: Placement;
        /** Extra classes for the trigger <button>. */
        triggerClass?: string;
        /** Extra classes for the floating panel. */
        panelClass?: string;
        /** role applied to the floating panel. */
        panelRole?: 'menu' | 'dialog' | 'group';
        trigger: Snippet;
        content: Snippet<[{ close: () => void }]>;
    }

    let {
        ariaLabel,
        title = undefined,
        placement = 'bottom-end',
        triggerClass = '',
        panelClass = '',
        panelRole = 'menu',
        trigger,
        content,
    }: Props = $props();

    let open = $state(false);
    let triggerEl = $state<HTMLButtonElement | undefined>(undefined);
    let panelEl = $state<HTMLDivElement | undefined>(undefined);
    let openedAt = 0;
    const OPEN_GUARD_MS = 200;

    function openPopover(): void {
        if (open) return;
        open = true;
        openedAt = Date.now();
    }

    function close(): void {
        if (!open) return;
        open = false;
        triggerEl?.focus();
    }

    function toggle(): void {
        if (open) close();
        else openPopover();
    }

    // Portal the panel to document.body so position: fixed resolves against
    // the viewport even inside the modal footer's overflow-x scroller.
    function bodyPortal(node: HTMLElement) {
        const anchor = document.createComment('');
        node.before(anchor);
        document.body.appendChild(node);
        return {
            destroy() {
                node.remove();
                anchor.remove();
            },
        };
    }

    $effect(() => {
        if (!open || !triggerEl || !panelEl) return;
        const cleanup = autoUpdate(triggerEl, panelEl, () => {
            if (!triggerEl || !panelEl) return;
            void computePosition(triggerEl, panelEl, {
                placement,
                middleware: [offset(8), flip({ padding: 8 }), shift({ padding: 8 })],
            }).then(({ x, y }) => {
                if (!panelEl) return;
                Object.assign(panelEl.style, { left: `${x}px`, top: `${y}px` });
            });
        });
        return cleanup;
    });

    $effect(() => {
        if (!open || !panelEl) return;
        let cancelled = false;
        void tick().then(() => {
            if (cancelled || !panelEl) return;
            const first = panelEl.querySelector<HTMLElement>(
                'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
            );
            first?.focus();
        });
        return () => {
            cancelled = true;
        };
    });

    function handleWindowPointerDown(e: PointerEvent | TouchEvent): void {
        if (!open || Date.now() - openedAt < OPEN_GUARD_MS) return;
        const target = e.target as Node;
        if (triggerEl?.contains(target)) return;
        if (panelEl && !panelEl.contains(target)) close();
    }

    // ModalContainer also registers a window-level keydown listener (bubble
    // phase, registered earlier at app start) that closes the whole modal on
    // Escape. A bubble-phase stopPropagation() here can't stop a listener
    // already registered on the same target (window) — only
    // stopImmediatePropagation would, and even that can't help once the
    // event has already reached window in the bubble phase in the "wrong"
    // order. So instead this registers its own listener directly on window
    // in the CAPTURE phase while the popover is open: capture runs before
    // any bubble-phase listener sees the event at all, so calling
    // stopPropagation() there halts the event before it can reach
    // ModalContainer's handler and close the parent modal.
    $effect(() => {
        if (!open) return;
        function handleKeydownCapture(e: KeyboardEvent): void {
            if (e.key !== 'Escape') return;
            e.stopPropagation();
            e.preventDefault();
            close();
        }
        window.addEventListener('keydown', handleKeydownCapture, true);
        return () => window.removeEventListener('keydown', handleKeydownCapture, true);
    });
</script>

<svelte:window onpointerdown={handleWindowPointerDown} ontouchstart={handleWindowPointerDown} />

<button
    type="button"
    bind:this={triggerEl}
    class={triggerClass}
    aria-label={ariaLabel}
    title={title ?? ariaLabel}
    aria-haspopup="true"
    aria-expanded={open}
    onclick={toggle}>
    {@render trigger()}
</button>

{#if open}
    <div use:bodyPortal>
        <div
            bind:this={panelEl}
            class="fixed {panelClass}"
            style="z-index: {Z.CTX_MENU};"
            role={panelRole}
            tabindex="-1">
            {@render content({ close })}
        </div>
    </div>
{/if}
