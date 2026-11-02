// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Tab-title override layer.
 *
 * Pages own the tab title through `<svelte:head><title>`, which Svelte compiles
 * down to a bare `document.title = ...` assignment inside an effect — there is
 * no hook to wrap and no store to read. This module lets a concern that
 * outlives the page (the music player) paint over that title without any page
 * knowing: a MutationObserver on `<head>` records whatever a page last set as
 * the base title, and re-asserts the override on top of it.
 *
 * Clearing the override restores the base title, so a page that never sets one
 * of its own keeps whatever was there before — same as without this module.
 *
 * The video player takes the simpler snapshot/restore route instead (see
 * `favicon-controller.ts`): it owns a whole route, so nothing can change the
 * title underneath it.
 */

let override: string | null = null;
let baseTitle = '';

/**
 * Last value written by this module, AS THE BROWSER READS IT BACK. Observer
 * callbacks compare against it to tell a page's write apart from the echo of
 * our own — without that check the re-assert below would feed itself forever.
 *
 * It must be the read-back value, not what was assigned: the `document.title`
 * getter strips and collapses whitespace, so a track titled
 * "Falling Apart  (Radio Mix)" never reads back equal to what was written. That
 * mismatch looked like a page write on every echo, re-applied the override, and
 * spun the observer in a microtask loop that froze the whole tab.
 */
let lastWritten: string | null = null;
let observer: MutationObserver | null = null;

/** The browser's read-side normalization of a title ("strip and collapse ASCII whitespace"). */
function normalizeTitle(title: string): string {
    return title.replace(/[\t\n\f\r ]+/g, ' ').replace(/^ | $/g, '');
}

function apply(): void {
    const next = override ?? baseTitle;
    if (document.title === normalizeTitle(next)) return;
    document.title = next;
    lastWritten = document.title;
}

function handleHeadMutation(): void {
    const current = document.title;
    if (current === lastWritten) return;
    baseTitle = current;
    apply();
}

function ensureObserver(): void {
    if (observer) return;
    baseTitle = document.title;
    observer = new MutationObserver(handleHeadMutation);
    // `document.title = x` rewrites the text inside the existing <title>, while
    // navigation can swap head elements wholesale. Watching the whole subtree
    // covers both without caring which happened.
    observer.observe(document.head, { childList: true, subtree: true, characterData: true });
}

/**
 * Paint `title` over whatever the current page set, or pass `null` to hand the
 * tab title back to the page. Safe to call on every state change — a repeat
 * call with an unchanged value does nothing. No-op outside the browser.
 */
export function setDocumentTitleOverride(title: string | null): void {
    if (typeof document === 'undefined') return;
    ensureObserver();
    if (override === title) return;
    override = title;
    apply();
}

/**
 * Drop the override, give the page's own title back and stop observing.
 */
export function stopDocumentTitleOverride(): void {
    if (typeof document === 'undefined') return;
    if (override !== null) {
        override = null;
        apply();
    }
    observer?.disconnect();
    observer = null;
    lastWritten = null;
    baseTitle = '';
}
