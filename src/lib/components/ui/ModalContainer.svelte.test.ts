// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { tick } from 'svelte';
import ModalContainer from './ModalContainer.svelte';
import ModalFixture from './modal-container-fixture.svelte';
import { modals } from '$lib/stores/modal.store';
import { Z } from '$lib/utils/z-index';

async function settle(): Promise<void> {
    await tick();
    // modals.close() is async (beforeClose hook) — flush the microtask queue.
    await new Promise((r) => setTimeout(r, 0));
    await tick();
}

describe('ModalContainer keyboard handling', () => {
    afterEach(async () => {
        await modals.closeAll();
        cleanup();
    });

    test('Escape pressed inside the dialog content closes the modal', async () => {
        render(ModalContainer);
        modals.open(ModalFixture, {});
        await settle();
        expect(modals.count).toBe(1);

        // Regression: the content wrapper used to stopPropagation() ALL keydowns,
        // so Escape never reached the window handler while focus sat inside the
        // dialog (which is always the case — the dialog is focused on open).
        const inner = screen.getByTestId('inner-button');
        inner.focus();
        await fireEvent.keyDown(inner, { key: 'Escape' });
        await settle();

        expect(modals.count).toBe(0);
    });

    test('closeOnEscape: false is respected for keydowns from inside the dialog', async () => {
        render(ModalContainer);
        modals.open(ModalFixture, {}, { closeOnEscape: false });
        await settle();

        const inner = screen.getByTestId('inner-button');
        await fireEvent.keyDown(inner, { key: 'Escape' });
        await settle();

        expect(modals.count).toBe(1);
    });

    test('non-Escape keys from inside the dialog do not leak to window listeners', async () => {
        render(ModalContainer);
        modals.open(ModalFixture, {});
        await settle();

        const windowSpy = vi.fn();
        window.addEventListener('keydown', windowSpy);
        try {
            const inner = screen.getByTestId('inner-button');
            await fireEvent.keyDown(inner, { key: 'f' });
            expect(windowSpy).not.toHaveBeenCalled();

            await fireEvent.keyDown(inner, { key: 'Escape' });
            expect(windowSpy).toHaveBeenCalledTimes(1);
        } finally {
            window.removeEventListener('keydown', windowSpy);
        }
    });
});

describe('ModalContainer fullscreen handling', () => {
    afterEach(async () => {
        await modals.closeAll();
        cleanup();
        vi.restoreAllMocks();
        Object.defineProperty(document, 'fullscreenElement', {
            value: null,
            configurable: true,
        });
    });

    /**
     * Regression: the modal layer is `position: fixed` at the document root,
     * outside whatever element (e.g. the video player) is in native
     * Fullscreen. The Fullscreen API only paints the fullscreened element's
     * own subtree, so a modal opened while something else is fullscreen
     * mounted but never became visible — and its backdrop still blocked
     * clicks on everything underneath, including re-opening the control that
     * triggered it (e.g. the player's search button).
     */
    test('opening a modal while something else is fullscreen exits fullscreen', async () => {
        const fakeFullscreenEl = document.createElement('div');
        Object.defineProperty(document, 'fullscreenElement', {
            value: fakeFullscreenEl,
            configurable: true,
        });
        const exitFullscreen = vi.fn().mockResolvedValue(undefined);
        document.exitFullscreen = exitFullscreen;

        render(ModalContainer);
        modals.open(ModalFixture, {});
        await settle();

        expect(exitFullscreen).toHaveBeenCalledTimes(1);
    });

    test('does not touch fullscreen when nothing is fullscreen', async () => {
        const exitFullscreen = vi.fn().mockResolvedValue(undefined);
        document.exitFullscreen = exitFullscreen;

        render(ModalContainer);
        modals.open(ModalFixture, {});
        await settle();

        expect(exitFullscreen).not.toHaveBeenCalled();
    });
});

describe('ModalContainer stacking over the player tier', () => {
    afterEach(async () => {
        await modals.closeAll();
        cleanup();
        document.querySelectorAll('.player-container').forEach((el) => el.remove());
    });

    function layerZ(container: HTMLElement): number {
        const el = container.querySelector<HTMLElement>('.modal-layer');
        if (!el) throw new Error('modal-layer not rendered');
        return Number(el.style.zIndex);
    }

    /**
     * Regression: `.watch-page` / `.player-container` are root-level fixed
     * stacking contexts at Z.PLAYER (9000); the modal layer is a SIBLING
     * root-level context at Z.MODAL (1000). A search result opened from
     * inside the player therefore painted BEHIND the video — mounted but
     * invisible and impossible to dismiss, which left `hasModals` stuck true
     * and made the player's search button flicker open/closed forever.
     */
    test('lifts above the player tier when a player surface is mounted', async () => {
        const player = document.createElement('div');
        player.className = 'player-container';
        document.body.appendChild(player);

        const { container } = render(ModalContainer);
        modals.open(ModalFixture, {});
        await settle();

        expect(layerZ(container)).toBe(Z.MODAL_OVER_PLAYER);
        expect(layerZ(container)).toBeGreaterThan(Z.PLAYER);
    });

    test('stays at the normal modal base with no player mounted', async () => {
        const { container } = render(ModalContainer);
        modals.open(ModalFixture, {});
        await settle();

        // Must NOT lift unconditionally — MUSIC_OVER_MODAL, TOAST, SEARCH,
        // FLOATING_MODAL, TOOLTIP and CTX_MENU all sit deliberately above
        // Z.MODAL and would invert.
        expect(layerZ(container)).toBe(Z.MODAL);
    });
});

describe('ModalContainer backdrop click', () => {
    afterEach(async () => {
        await modals.closeAll();
        cleanup();
    });

    /** The backdrop is only rendered for the topmost entry. */
    function backdrop(container: HTMLElement): HTMLElement {
        const el = container.querySelector<HTMLElement>('.backdrop');
        if (!el) throw new Error('backdrop not rendered');
        return el;
    }

    test('pops a single step for sub-dialogs (no backdropClosesTrail)', async () => {
        const { container } = render(ModalContainer);
        modals.open(ModalFixture, {});
        modals.open(ModalFixture, {});
        await settle();

        await fireEvent.click(backdrop(container));
        await settle();

        expect(modals.count).toBe(1);
    });

    test('leaves the whole trail when the top opts into backdropClosesTrail', async () => {
        const { container } = render(ModalContainer);
        modals.open(ModalFixture, {}, { backdropClosesTrail: true });
        modals.open(ModalFixture, {}, { backdropClosesTrail: true });
        await settle();

        // Regression: popping one step here re-surfaced the previous entity
        // card, so clicking outside looked like it reopened an old modal
        // instead of dismissing.
        await fireEvent.click(backdrop(container));
        await settle();

        expect(modals.count).toBe(0);
    });

    test('closeOnBackdrop: false wins over backdropClosesTrail', async () => {
        const { container } = render(ModalContainer);
        modals.open(ModalFixture, {}, { backdropClosesTrail: true, closeOnBackdrop: false });
        await settle();

        await fireEvent.click(backdrop(container));
        await settle();

        expect(modals.count).toBe(1);
    });
});
