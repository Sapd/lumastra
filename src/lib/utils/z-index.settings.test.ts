// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, test } from 'vitest';
import { Z } from './z-index';

describe('Z.SETTINGS_OVERLAY', () => {
    test('covers page chrome and nav popups (above NAV_POPUP and the real mini-player z-40)', () => {
        expect(Z.SETTINGS_OVERLAY).toBeGreaterThan(Z.NAV_POPUP);
        expect(Z.SETTINGS_OVERLAY).toBeGreaterThan(40);
    });

    test('sits BELOW the modal tier so in-settings dialogs stack above the overlay', () => {
        // token-create / Jellyfin-Subsonic connect / change-password open at MODAL
        // and MUST render above the settings overlay (and register hasModals so
        // Escape closes the dialog first, not the whole overlay).
        expect(Z.SETTINGS_OVERLAY).toBeLessThan(Z.MODAL);
    });

    test('stays below toasts and the fullscreen player', () => {
        expect(Z.SETTINGS_OVERLAY).toBeLessThan(Z.TOAST);
        expect(Z.SETTINGS_OVERLAY).toBeLessThan(Z.PLAYER);
    });
});

describe('Z.MODAL_OVER_PLAYER', () => {
    test('beats the whole player tier so a modal opened from the player is visible', () => {
        // Regression: the modal layer sat at Z.MODAL (1000) while `.watch-page`
        // / `.player-container` sit at Z.PLAYER (9000) as a SIBLING root-level
        // fixed stacking context — so a search result opened from inside the
        // player painted behind the video: mounted, invisible, undismissable.
        expect(Z.MODAL_OVER_PLAYER).toBeGreaterThan(Z.PLAYER);
        expect(Z.MODAL_OVER_PLAYER).toBeGreaterThan(Z.PLAYER_TOAST);
        expect(Z.MODAL_OVER_PLAYER).toBeGreaterThan(Z.PLAYER_SIDEBAR);
        expect(Z.MODAL_OVER_PLAYER).toBeGreaterThan(Z.PLAYER_SIDEBAR_CONTENT);
        expect(Z.MODAL_OVER_PLAYER).toBeGreaterThan(Z.PLAYER_ANNOTATIONS);
    });

    test('still loses to critical system overlays', () => {
        expect(Z.MODAL_OVER_PLAYER).toBeLessThan(Z.SYSTEM_OVERLAY);
    });

    test('is an opt-in lift, never the global modal base', () => {
        // These tiers are deliberately ABOVE Z.MODAL and would invert if the
        // modal layer were raised unconditionally instead of only while a
        // player surface is mounted.
        expect(Z.MODAL_OVER_PLAYER).toBeGreaterThan(Z.MODAL);
        for (const above of [
            Z.MUSIC_OVER_MODAL,
            Z.MUSIC_SHEET,
            Z.ADMIN_BANNER,
            Z.TOAST,
            Z.SEARCH,
            Z.FLOATING_MODAL,
            Z.TOOLTIP,
            Z.CTX_MENU,
        ]) {
            expect(above).toBeGreaterThan(Z.MODAL);
        }
    });
});
