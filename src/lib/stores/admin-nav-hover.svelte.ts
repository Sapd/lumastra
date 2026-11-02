// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The admin page link under the pointer, shared by every admin nav renderer
 * (sidebar lists, flyouts, the section tab row, Settings' area nav). When the
 * same page is on screen twice — the Settings flyout beside Settings' own strip,
 * the rail flyout beside the tab row — hovering one copy lights the other too.
 */

class AdminNavHoverStore {
    #path = $state<string | null>(null);

    /** Path of the hovered page link, or null. */
    get path(): string | null {
        return this.#path;
    }

    /** Pointer entered a page link. */
    enter(path: string): void {
        this.#path = path;
    }

    /** Forget the hover (a hovered link was hidden or the page changed). */
    clear(): void {
        this.#path = null;
    }

    /** Pointer left a page link (ignored if another link already took over). */
    leave(path: string): void {
        if (this.#path === path) this.#path = null;
    }
}

/** The one shared hover state. */
export const adminNavHover = new AdminNavHoverStore();
