// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Global fetch interceptor for subfolder deployment support
 *
 * This module patches the global fetch to automatically prefix
 * internal URLs with the base path. This ensures backward compatibility
 * with existing code that uses raw fetch('/api/...') calls.
 *
 * Import this module early in your app initialization (e.g., in +layout.svelte)
 */

import { browser } from '$app/environment';
import { base } from '$app/paths';

let isPatched = false;

/**
 * Install the fetch interceptor
 * Only patches fetch in browser context when base path is set
 */
export function installFetchInterceptor() {
    if (!browser || isPatched || !base) {
        return;
    }

    const originalFetch = window.fetch;

    window.fetch = function (input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
        // Only intercept string URLs that start with /
        if (typeof input === 'string' && input.startsWith('/') && !input.startsWith('//')) {
            // Don't double-prefix if already has base
            if (!input.startsWith(base + '/') && input !== base) {
                input = base + input;
            }
        }

        return originalFetch.call(this, input, init);
    };

    isPatched = true;
    console.log('[FetchInterceptor] Installed with base path:', base);
}

/**
 * Check if the interceptor is installed
 */
export function isInterceptorInstalled(): boolean {
    return isPatched;
}
