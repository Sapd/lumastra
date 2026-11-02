// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Test-only reactive URL box for `page.svelte.test.ts`'s `$app/state` mock.
 *
 * A plain `.test.ts` file is never rune-compiled (vite-plugin-svelte only
 * grants rune support to files ending in exactly `.svelte.js`/`.svelte.ts`),
 * so a mock built there that just swaps `page.url` for a new plain `URL`
 * object after mount gives the page's `$effect`/`$derived` nothing to react
 * to — mutating it looks like a no-op from the component's side. `SvelteURL`
 * (this file *is* rune-compiled, so it can use one) wraps each of its own
 * fields in `$state`, so mutating this one instance's `.href` in place is a
 * genuine Svelte signal change — a test can simulate a real SvelteKit
 * navigation mid-test and the component's own `$effect` actually re-runs,
 * which is needed to exercise the list-load race guard (a second, faster
 * filter change must not let an earlier, slower response overwrite it).
 */
import { SvelteURL } from 'svelte/reactivity';

export function createReactiveUrlBox(initial: string): {
    readonly value: URL;
    set(url: string): void;
} {
    // `SvelteURL` is reactive on its own fields (it wraps each part in
    // `$state` internally) — one instance, mutated in place via `.href`,
    // rather than swapping in a new `URL`/`SvelteURL` object each time.
    const current = new SvelteURL(initial);
    return {
        get value() {
            return current;
        },
        set(url: string) {
            current.href = url;
        },
    };
}
