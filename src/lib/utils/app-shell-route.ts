// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Pure route classification for `+layout.svelte`'s three-way branch:
 * standalone auth/onboarding pages (`/login`, `/setup`), the public
 * showcase (`/showcase*`, which supplies its own bare chrome), or the app
 * shell (everything else — sidebar, player chrome, the lot).
 *
 * Framework-agnostic and unit-testable without mounting Svelte — see
 * app-shell-route.test.ts. `pathname` is `$page.url.pathname`; `base` is
 * `$app/paths`' `base` (empty string at the root, or a prefix like `/app`
 * for subfolder deployments).
 *
 * This is the ONE source of truth for the three-way split: `+layout.svelte`
 * derives `isAuthPage`/`isShowcasePage` from `isAuthRoute`/`isShowcaseRoute`
 * below (which is what its template's `{#if isAuthPage}...{:else if
 * isShowcasePage}...{:else}` branches on), and gates the music-store
 * bootstrap (Task 8 fix round 1, Critical 1 — see that `$effect`, near
 * `musicStoreBootstrapGate`) on `isAppShellRoute` directly, rather than
 * hand-composing `!isAuthPage && !isShowcasePage` a second time. Extracted
 * in Task 8 fix round 2: that hand-composed boolean was exercised by no
 * test, so a dropped `!` or a swapped `&&`/`||` would have silently brought
 * the Critical-1 regression back (audio resuming on `/login`) with
 * everything else green.
 */

export function isAuthRoute(pathname: string, base: string): boolean {
    return (
        pathname === (base ? `${base}/login` : '/login') ||
        pathname === (base ? `${base}/setup` : '/setup') ||
        pathname === (base ? `${base}/setup/locked` : '/setup/locked')
    );
}

export function isShowcaseRoute(pathname: string, base: string): boolean {
    return pathname.startsWith(base ? `${base}/showcase` : '/showcase');
}

/** True when the app-shell `{:else}` branch is the one that renders for this
 *  route — i.e. neither the standalone auth shell nor the showcase's own
 *  bare chrome applies. */
export function isAppShellRoute(pathname: string, base: string): boolean {
    return !isAuthRoute(pathname, base) && !isShowcaseRoute(pathname, base);
}
