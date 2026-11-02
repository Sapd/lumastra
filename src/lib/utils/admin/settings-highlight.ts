// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scroll-to + flash-highlight for admin settings rows.
 *
 * Shared by BOTH ways a user lands on a setting:
 *  - a cross-page search result (`?section=…&highlight=…` deep link on arrival), and
 *  - a same-page search result (clicked in the "on this page" jump list).
 *
 * Both paths must behave identically, which is why the DOM lookup, the
 * advanced-toggle retry and the section fallback live here instead of in the page
 * component.
 */
import { tick } from 'svelte';

/** How long the yellow glow stays on the target. Matches the CSS animation. */
export const HIGHLIGHT_DURATION_MS = 3000;

const HIGHLIGHT_CLASS = 'search-highlight';

/** Pending removal timers, so re-clicking the same result restarts the flash. */
const pendingClears = new WeakMap<Element, number>();

/**
 * Add the highlight class and strip it again after `durationMs`.
 *
 * Re-flashing an element that is still glowing has to remove the class and force
 * a reflow first — a CSS animation does not restart when the class is merely
 * re-added while already present, so a second click on the same result would
 * otherwise look like nothing happened.
 */
export function flashHighlight(el: HTMLElement, durationMs = HIGHLIGHT_DURATION_MS): void {
    const pending = pendingClears.get(el);
    if (pending !== undefined) {
        window.clearTimeout(pending);
        el.classList.remove(HIGHLIGHT_CLASS);
        void el.offsetWidth; // force reflow so the animation restarts
    }

    el.classList.add(HIGHLIGHT_CLASS);
    pendingClears.set(
        el,
        window.setTimeout(() => {
            el.classList.remove(HIGHLIGHT_CLASS);
            pendingClears.delete(el);
        }, durationMs),
    );
}

export interface ScrollToSettingOptions {
    sectionId: string;
    /** Omit to land on the section header instead of a specific row. */
    settingKey?: string | null;
    /** Expand the section — its rows only exist in the DOM once it is open. */
    expandSection?: (sectionId: string) => void;
    /** Reveal `uiHints.advanced` rows. Only called if the row is missing first time. */
    revealAdvanced?: () => void;
    /** Cancel stale work after navigation, including delayed scroll correction. */
    isCurrent?: () => boolean;
}

/**
 * `tick()` flushes Svelte's DOM writes but NOT layout. Expanding a section or
 * revealing the advanced rows inserts dozens of rows ABOVE the target, so its
 * final offset isn't known until the browser has laid out again. Two rAFs put us
 * after the next style+layout pass.
 */
function afterLayout(): Promise<void> {
    return new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
}

/** How far off-center we tolerate before re-asserting the scroll. */
const CENTER_TOLERANCE_PX = 120;

/**
 * Expand → scroll → flash. Returns false only when neither the setting row nor
 * its section could be found (caller can then fall back to a full navigation).
 */
export async function scrollToSetting({
    sectionId,
    settingKey,
    expandSection,
    revealAdvanced,
    isCurrent = () => true,
}: ScrollToSettingOptions): Promise<boolean> {
    if (typeof document === 'undefined' || !isCurrent()) return false;

    expandSection?.(sectionId);
    await tick();
    if (!isCurrent()) return false;

    const targetId = settingKey ? `setting-${settingKey}` : `section-${sectionId}`;
    let el = document.getElementById(targetId);

    // The row may be hidden behind the advanced-settings toggle — reveal and retry
    // before giving up.
    if (!el && settingKey && revealAdvanced) {
        revealAdvanced();
        await tick();
        if (!isCurrent()) return false;
        el = document.getElementById(targetId);
    }

    // Still missing (e.g. a `showWhen` condition hides the row entirely) — land on
    // the section so the user isn't dropped with no feedback.
    if (!el && settingKey) {
        el = document.getElementById(`section-${sectionId}`);
    }

    if (!el || !isCurrent()) return false;
    const target = el;

    // Highlight first: it is a class toggle, unaffected by layout, and it means the
    // row is already glowing when the scroll arrives.
    flashHighlight(target);
    const ownedHighlight = pendingClears.get(target);

    // Let the newly-inserted rows lay out before measuring, otherwise a smooth
    // scroll animates toward the position the row had when it was one of 21
    // instead of one of 95, and stops ~1000px short.
    await afterLayout();
    if (!isCurrent() || !target.isConnected) {
        if (pendingClears.get(target) === ownedHighlight) target.classList.remove(HIGHLIGHT_CLASS);
        return false;
    }

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const behavior: ScrollBehavior = reduceMotion ? 'auto' : 'smooth';
    target.scrollIntoView({ behavior, block: 'center' });

    if (behavior === 'smooth') {
        // A smooth scroll runs for a few hundred ms and can still be outrun by a
        // late reflow (fonts, images, a section transition finishing). Re-assert
        // once it has settled, and only if we actually ended up off-target.
        window.setTimeout(() => {
            if (!isCurrent() || !target.isConnected) return;
            const rect = target.getBoundingClientRect();
            const offCenter = Math.abs(rect.top + rect.height / 2 - window.innerHeight / 2);
            if (offCenter > CENTER_TOLERANCE_PX) {
                target.scrollIntoView({ behavior: 'auto', block: 'center' });
            }
        }, 450);
    }

    return true;
}
