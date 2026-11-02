// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { derived, writable, type Readable } from 'svelte/store';

// Count, not a boolean: several Search instances can mount at once (home page,
// playlist page, player) and one closing must not clear another's open state.
const openCount = writable(0);

/** True while any Search overlay is open (floating controls hide under it). */
export const searchOverlayOpen: Readable<boolean> = derived(openCount, (count) => count > 0);

/** Register an open Search overlay; call the returned function when it closes. */
export function registerSearchOverlay(): () => void {
    openCount.update((count) => count + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        openCount.update((count) => Math.max(0, count - 1));
    };
}
