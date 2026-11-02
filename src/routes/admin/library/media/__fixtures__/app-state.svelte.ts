// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A REACTIVE stand-in for `$app/state`, for `page.svelte.test.ts`.
 *
 * The mock it replaces was `vi.mock('$app/state', () => ({ page: { url: new
 * URL('…/admin/library/media'), data: {} } }))` — one frozen URL for the whole
 * file. `+page.svelte`'s selection-clearing effect reads
 * `filterIdentity(page.url.searchParams)` and compares it against the previous
 * run's, so with a URL that never moves the compare branch was UNREACHABLE:
 * no test in that file could turn a page or change a filter, and the two rules
 * the effect exists to enforce — a selection SURVIVES pagination, a selection
 * CLEARS on a filter change — had no page-level proof at all. (`selection.ts`'s
 * own tests call `filterIdentity`/`shouldClearSelection` directly, which is the
 * half that does not regress silently.)
 *
 * It lives in a `.svelte.ts` module because the reactivity is the whole point:
 * a plain object mutated mid-test would change what a later render reads but
 * would never re-run the effect, so a test built on one would pass whether or
 * not the page reacts to the URL — the un-failable shape this suite keeps
 * having to root out. `$state` is only legal in a rune-enabled module, and a
 * `.test.ts` file is not one.
 */

import { SvelteURL } from 'svelte/reactivity';

const DEFAULT_URL = 'http://localhost/admin/library/media';

export const page = $state({
    url: new SvelteURL(DEFAULT_URL),
    data: {} as Record<string, unknown>,
    state: {} as Record<string, unknown>,
});

/** Navigate the fake `page`, the way a client-side `goto` would. */
export function setPageUrl(href: string): void {
    page.url = new SvelteURL(href, DEFAULT_URL);
}

/**
 * Back to the starting URL. Module state outlives a single test, so every test
 * in the file must start from the same place or the effect's previous-identity
 * comparison leaks across them.
 */
export function resetPageUrl(): void {
    setPageUrl(DEFAULT_URL);
}
