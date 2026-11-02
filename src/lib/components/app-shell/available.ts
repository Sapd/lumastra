// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type * as AppChromeModule from './index';

type AppChrome = typeof AppChromeModule;

// Only module constructors live here, never request data or mounted instances.
// The root imports this module directly so reading the cache cannot pull chrome
// into the watch route's static graph.
// SvelteKit resolves the route's static imports before SSR and hydration. Catalog
// layouts register eagerly; the root can reuse them without a universal load.
let eagerChrome: AppChrome | null = null;

export function registerEagerAppChrome(chrome: AppChrome): void {
    eagerChrome = chrome;
}

export function getEagerAppChrome(): AppChrome | null {
    return eagerChrome;
}
