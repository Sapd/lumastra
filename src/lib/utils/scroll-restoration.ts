// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Scroll restoration for the app shell's scroller.
 *
 * SvelteKit restores WINDOW scroll on Back/Forward. On desktop (>= 1024px) the
 * window never scrolls: `.main-content` owns vertical scroll (the app-shell
 * pattern in +layout.svelte), so Back from any page landed at the top of the
 * previous one — e.g. a user deep in /browse opened a genre and came back to
 * the first row. And even where the window does scroll (mobile), pages that
 * fetch their content after mount (/browse's rails) are too short at the moment
 * SvelteKit restores, so the position is clamped to near zero.
 *
 * So: remember the scroller's offset per URL before every navigation; on a
 * history traversal to a different page, re-apply it — retrying until the page
 * has grown tall enough — and give up the moment the user scrolls themselves.
 */

/** How long a restore keeps waiting for content to grow tall enough. */
export const RESTORE_TIMEOUT_MS = 4000;
const POLL_MS = 50;
/**
 * The page must hold the same height this long before a restore counts as
 * done. Reaching the target height is not enough: /browse swaps skeleton rows
 * for real ones ABOVE the target after it is already tall enough, and scroll
 * anchoring then drags the offset (measured on preprod: 1500 → 725).
 */
export const SETTLE_MS = 600;
/** Offsets kept, oldest evicted first. */
const MAX_ENTRIES = 50;

/** The element that actually scrolls the page right now. */
export function findPageScroller(doc: Document = document): HTMLElement {
    const main = doc.querySelector<HTMLElement>('main.main-content');
    if (main) {
        const overflowY = getComputedStyle(main).overflowY;
        if (overflowY === 'auto' || overflowY === 'scroll') return main;
    }
    return (doc.scrollingElement as HTMLElement | null) ?? doc.documentElement;
}

/** URL identity for a scroll position: path + query (the hash is in-page). */
export function scrollKey(url: URL): string {
    return url.pathname + url.search;
}

export interface ScrollRestorer {
    /** Record the current offset for the page being left. */
    save(from: URL): void;
    /**
     * React to a completed navigation. `popstate` to another page restores its
     * remembered offset; a link/goto to another page starts at the top. A
     * same-page navigation (query-only: filters, modals) is left alone — the
     * page decides.
     */
    afterNavigate(from: URL | null, to: URL, type: string): void;
    /** Cancel any pending restore (e.g. on teardown). */
    cancel(): void;
}

export function createScrollRestorer(
    getScroller: () => HTMLElement = () => findPageScroller(),
): ScrollRestorer {
    const offsets = new Map<string, number>();
    let pending: { timer: ReturnType<typeof setInterval>; stop: () => void } | null = null;

    function cancel(): void {
        pending?.stop();
        pending = null;
    }

    function restore(target: number): void {
        cancel();
        const scroller = getScroller();
        const started = Date.now();
        let lastHeight = -1;
        let stableSince = started;

        /** Re-apply the target; true once the page is tall enough AND settled. */
        const apply = (): boolean => {
            const now = Date.now();
            if (scroller.scrollHeight !== lastHeight) {
                lastHeight = scroller.scrollHeight;
                stableSince = now;
            }
            const max = scroller.scrollHeight - scroller.clientHeight;
            scroller.scrollTop = Math.min(target, Math.max(0, max));
            return max >= target && now - stableSince >= SETTLE_MS;
        };
        // Nothing to wait for when going back to the very top.
        if (target === 0) {
            scroller.scrollTop = 0;
            return;
        }
        apply();

        // The user taking over ends the restore — never yank them back.
        const onUserScroll = (): void => cancel();
        const opts: AddEventListenerOptions = { passive: true, capture: true };
        const userEvents = ['wheel', 'touchstart', 'keydown', 'mousedown'] as const;
        for (const ev of userEvents) window.addEventListener(ev, onUserScroll, opts);

        const timer = setInterval(() => {
            if (apply() || Date.now() - started > RESTORE_TIMEOUT_MS) cancel();
        }, POLL_MS);
        pending = {
            timer,
            stop: () => {
                clearInterval(timer);
                for (const ev of userEvents) window.removeEventListener(ev, onUserScroll, opts);
            },
        };
    }

    return {
        save(from: URL): void {
            const key = scrollKey(from);
            offsets.delete(key); // re-insert so eviction stays oldest-first
            offsets.set(key, getScroller().scrollTop);
            if (offsets.size > MAX_ENTRIES) {
                const oldest = offsets.keys().next().value;
                if (oldest !== undefined) offsets.delete(oldest);
            }
        },

        afterNavigate(from: URL | null, to: URL, type: string): void {
            // Cancel an older restore even when this navigation stays on the
            // same route or targets an anchor. Its timer must not keep scrolling.
            cancel();
            // Initial load, or a query-only change on the same page.
            if (!from || from.pathname === to.pathname) return;
            if (to.hash) return; // an anchor target wins
            if (type === 'popstate') {
                restore(offsets.get(scrollKey(to)) ?? 0);
            } else {
                cancel();
                getScroller().scrollTop = 0;
            }
        },

        cancel,
    };
}
