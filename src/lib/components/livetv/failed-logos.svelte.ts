// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Channel logo URLs that failed to load in this page session (a provider's logo
 * host is down or the logo is gone; logo URLs use `fallback=none`, so that is a
 * 404). Shared by every list that shows channel logos: the row shows its
 * fallback tile at once and no later render requests the dead URL again — the
 * 404 is `no-store`, so the browser would otherwise ask on every re-render.
 */

import { SvelteSet } from 'svelte/reactivity';

export const failedLogos = new SvelteSet<string>();

export function markLogoFailed(url: string | undefined): void {
    if (url) failedLogos.add(url);
}

/** The logo to show, or undefined when there is none or it failed to load. */
export function usableLogo(url: string | undefined): string | undefined {
    return url && !failedLogos.has(url) ? url : undefined;
}
