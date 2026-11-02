// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The left navigation dock's one display preference.
 *
 * This replaces three overlapping mechanisms that used to describe the same
 * rail and disagreed about it:
 *   - `uiPreferences.dockVisible`  (localStorage) — show the dock at all
 *   - `sidebar-collapsed`          (localStorage, + a `sidebar-toggle` window
 *                                   event) — slide the rail off-screen while
 *                                   the layout kept its 70px gutter, so hiding
 *                                   it left a dead strip
 *   - `lumastra_dock_labels`       (cookie) — labelled vs icon-only
 * Two of those were client-only, which is why the gutter was painted from a
 * default on the server and then corrected after hydration.
 *
 * Cookie-backed, because the rail's width IS the main content's left gutter and
 * `.main-content` is server-rendered: a client-only preference paints the wrong
 * gutter first and slides the page on hydration. The store is the in-session
 * channel so the rail and the gutter move together without a reload; the cookie
 * only carries the choice to the next server render.
 */

import { derived, get, writable } from 'svelte/store';
import { browser } from '$app/environment';

export const DOCK_COOKIE = 'lumastra_dock';

/**
 * `icons` is the default deliberately (product decision, 2026-09-27): a
 * collapsed rail keeps more width for content on first run, and every viewer
 * can still expand it with the rail's own toggle or Settings → Display — that
 * choice is what the cookie then remembers. Anyone whose cookie already says
 * `labels` (or `hidden`) keeps that choice; this only changes what a browser
 * with no cookie yet — a new user, or one who cleared cookies — starts at.
 * The old `labels`-by-default rationale (an icon-only rail has no affordance
 * for viewers who have not memorised the glyphs, and touch devices cannot
 * hover) still applies, which is why the rail keeps a labelled row on hover
 * and remains one click away from `labels`.
 */
export type DockMode = 'labels' | 'icons' | 'hidden';
export const DEFAULT_DOCK_MODE: DockMode = 'icons';

export function parseDockMode(raw: string | undefined | null): DockMode {
    return raw === 'labels' || raw === 'icons' || raw === 'hidden' ? raw : DEFAULT_DOCK_MODE;
}

export const dockMode = writable<DockMode>(DEFAULT_DOCK_MODE);

/** The dock is rendered at all. Drives the layout gutter and the <Sidebar />. */
export const dockVisible = derived(dockMode, (mode) => mode !== 'hidden');
/** The rail shows item names. Drives the rail's width, and so the gutter's. */
export const dockLabels = derived(dockMode, (mode) => mode === 'labels');

/**
 * Which mode to come back to when the dock is un-hidden. Session-scoped on
 * purpose: the cookie records what the dock IS, not what it was, so a viewer
 * who hides it and returns tomorrow gets the default rather than a mode they
 * cannot see to remember.
 */
let lastVisibleMode: DockMode = DEFAULT_DOCK_MODE;

function persist(mode: DockMode): void {
    if (!browser) return;
    document.cookie = `${DOCK_COOKIE}=${mode}; path=/; max-age=31536000; SameSite=Lax`;
}

export function setDockMode(mode: DockMode): void {
    if (mode !== 'hidden') lastVisibleMode = mode;
    dockMode.set(mode);
    persist(mode);
}

/** Settings → Display and the user menu both drive this one. */
export function toggleDockHidden(): void {
    setDockMode(get(dockMode) === 'hidden' ? lastVisibleMode : 'hidden');
}

/** The rail's own control: names on, names off. */
export function toggleDockLabels(): void {
    setDockMode(get(dockMode) === 'labels' ? 'icons' : 'labels');
}

/**
 * Seed from the value the server rendered with. Client-only and one-shot: a
 * module-level store written during SSR is shared by every concurrent request,
 * which would hand one viewer's dock to the next.
 */
export function seedDockMode(mode: DockMode): void {
    if (!browser) return;
    if (mode !== 'hidden') lastVisibleMode = mode;
    dockMode.set(mode);
}
