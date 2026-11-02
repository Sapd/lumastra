// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Singleton coordinator for body-portal popups (MediaHoverCard).
 *
 * The home page mounts hundreds of MediaHoverCard instances. Before this
 * coordinator existed, each instance owned:
 *   * its own <div class="media-hover-portal"> appended to <body>
 *     → ~840 empty container divs in <body>
 *   * its own document.addEventListener('media-hover-show', …) → every
 *     popup-show event fanned out to every other instance
 *   * its own document.addEventListener('keydown', …) → every keystroke
 *     ran 840 listener callbacks
 *
 * Replacing those per-instance hooks with one shared portal element and
 * one $state-backed activeId reduces fan-out from O(N) to O(1) per
 * popup transition. Components subscribe to activeId via $effect; only
 * the previously-active card's effect runs work when another card
 * becomes active. Escape closes the active popup by setting activeId to
 * null — the same effect path then calls hidePopup() on whoever owned
 * the popup.
 */
import { browser } from '$app/environment';
import { hasModals, modalCount } from '$lib/stores/modal.store';
import { Z } from '$lib/utils/z-index';

class MediaHoverCoordinator {
    /** id of the popup currently shown, or null if none. */
    activeId = $state<string | null>(null);

    private portal: HTMLDivElement | null = null;
    private overlayPortal: HTMLDivElement | null = null;
    private keydownAttached = false;

    /**
     * Lazily creates the shared body-portal container on first call and
     * returns it. Subsequent calls return the same element. Returns null
     * during SSR.
     *
     * This container sits BELOW the modal layer (z-index 990) so a stale
     * media preview can never paint over an open modal. Popups whose trigger
     * surface lives ABOVE the modal (the music mini-player / modal tracklists)
     * must use getOverlayPortal() instead — a child cannot escape this
     * container's z-index:990 stacking context, so its own z-index is capped
     * below the modal here no matter how high it sets it.
     */
    getPortal(): HTMLDivElement | null {
        if (!browser) return null;
        if (!this.portal) {
            this.portal = document.createElement('div');
            this.portal.className = 'media-hover-portal';
            document.body.appendChild(this.portal);
        }
        return this.portal;
    }

    /**
     * Body-portal container for popups that must render ABOVE the modal layer
     * — the music artist/album hover card, whose triggers (the lifted
     * mini-player, album/artist modal tracklists, the fullscreen player) all
     * sit at or above the modal. Separate element from getPortal() because a
     * fixed, z-indexed container establishes a stacking context: a card set to
     * z-index 1051 inside the 990 preview portal is still trapped below the
     * modal.
     *
     * Its z-index tracks the modal stack (see setOverlayZIndex): baseline
     * MUSIC_OVER_MODAL_POPUP, raised to sit one above the topmost stacked
     * ModalContainer modal so the card clears an artist/album modal opened on
     * top of another, not just a single base modal. Returns null during SSR.
     */
    getOverlayPortal(): HTMLDivElement | null {
        if (!browser) return null;
        if (!this.overlayPortal) {
            this.overlayPortal = document.createElement('div');
            this.overlayPortal.className = 'media-hover-portal-over-modal';
            document.body.appendChild(this.overlayPortal);
            // Track the modal stack for the singleton's lifetime (same as the
            // portal element), so the container stays above the current top
            // modal. subscribe() fires synchronously here, seeding the initial
            // z-index from the current depth.
            modalCount.subscribe((count) => this.setOverlayZIndex(count));
        }
        return this.overlayPortal;
    }

    /**
     * Pin the overlay portal one above the topmost ModalContainer modal. Each
     * stacked modal's panel sits at `Z.MODAL + 1 + index`, so the top panel is
     * `Z.MODAL + count`; sit one above it. Never drop below
     * MUSIC_OVER_MODAL_POPUP, which already clears a single base modal and the
     * lifted mini-player. No-op before the portal exists.
     *
     * (FLOATING_MODAL one-offs live above even the lifted mini-player, so the
     * card's own trigger is already behind them — deliberately not tracked.)
     */
    private setOverlayZIndex(count: number): void {
        if (!this.overlayPortal) return;
        const z = Math.max(Z.MUSIC_OVER_MODAL_POPUP, Z.MODAL + count + 1);
        this.overlayPortal.style.zIndex = String(z);
    }

    /** Mark the given popup id as the active one. */
    claim(id: string): void {
        this.activeId = id;
    }

    /**
     * Clear the active id if it matches. A no-op if some other popup
     * has already claimed activity, so two cards racing to release/claim
     * cannot accidentally overwrite each other.
     */
    release(id: string): void {
        if (this.activeId === id) {
            this.activeId = null;
        }
    }

    /**
     * Attach the document-level Escape handler exactly once. Subsequent
     * calls are no-ops. The handler clears activeId, which downstream
     * $effects watch to hide their popups.
     */
    ensureEscapeListener(): void {
        if (!browser || this.keydownAttached) return;
        this.keydownAttached = true;
        document.addEventListener('keydown', (e: KeyboardEvent): void => {
            if (e.key === 'Escape' && this.activeId !== null) {
                this.activeId = null;
            }
        });
    }
}

export const mediaHoverCoordinator = new MediaHoverCoordinator();

// Force-close any open hover preview the moment a modal opens. Belt-and-
// braces alongside the popup portal's z-index (Z.MEDIA_HOVER_PREVIEW, pinned
// below Z.MODAL): a preview that was showing at click time would otherwise
// keep playing its trailer while the modal opens on top of it. Module-level
// singleton subscription — never unsubscribed by design, same lifetime as
// the coordinator itself.
if (browser) {
    hasModals.subscribe((open) => {
        if (open) {
            mediaHoverCoordinator.activeId = null;
        }
    });
}
