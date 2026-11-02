// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * One-shot landing params the `/watch/<seriesId>` redirect stamps on the
 * episode URL. They are read once when the page lands and must not survive
 * into a copied/shared URL (M10: a copied URL is just `/watch/<episode>?slug=…`).
 * Playback params (`t`, `playlist`, `position`, `fileId`, `ctx`) and `slug`
 * are not landing-only and stay.
 */
export const WATCH_LANDING_PARAMS: readonly string[] = [
    'resolved',
    'info',
    'dev',
    'mk',
    'seekMs',
    'from',
    'fromPos',
    'fmk',
    'sid',
    // How the viewer opened the item (watch-entry.ts); read once, stored per tab.
    'entry',
    // Age of a resume handoff that jumped here (resume-handoff.ts); named in the toast.
    'age',
    'hchain',
    // Remount nonce of a resume handoff on the same item: a fresh player and session.
    'hn',
];
