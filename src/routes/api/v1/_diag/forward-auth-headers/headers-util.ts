// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Helpers for the forward-auth header reflection endpoint.
 *
 * These live in a sibling module (not `+server.ts`) because SvelteKit only
 * permits reserved exports (GET/POST/…) from a `+server.ts` route file. Keeping
 * the pure helpers here lets both the route and its unit tests import them.
 */

import { config } from '$lib/server/config.js';

/** Shape returned by the reflection endpoint. */
export interface ForwardAuthHeadersResponse {
    /** Names (lowercased) of forward-auth headers present on the inbound request. Never includes values. */
    received: string[];
}

/**
 * Build the allowlist of forward-auth header names to probe for.
 * Derived from live config so it reflects the operator's actual header names.
 *
 * Trim + drop empty/whitespace values: an operator who clears USERHEADER /
 * GROUPHEADER must not put '' in the allowlist (headers.has('') is always false
 * and would silently disable that header's check).
 */
export function buildForwardAuthAllowlist(): string[] {
    return [config.USERHEADER, config.GROUPHEADER]
        .map((h) => h.trim().toLowerCase())
        .filter((h) => h.length > 0);
}

/**
 * Filter the inbound request headers through the forward-auth allowlist and
 * return the NAMES of any that are present.
 *
 * @param headers   - The inbound request Headers (platform-lowercased).
 * @param allowlist - Explicit header names to check (lowercased).
 * @returns Lowercased header names that are present on the request.
 */
export function collectForwardAuthHeaderNames(
    headers: { has: (name: string) => boolean; keys: () => Iterable<string> },
    allowlist: string[],
): string[] {
    const received: string[] = [];

    // Check the fixed allowlist (USERHEADER, GROUPHEADER)
    for (const name of allowlist) {
        if (headers.has(name)) {
            received.push(name);
        }
    }

    // Check any x-authentik-* header present on the request
    for (const name of headers.keys()) {
        if (name.startsWith('x-authentik-') && !received.includes(name)) {
            received.push(name);
        }
    }

    return received;
}
