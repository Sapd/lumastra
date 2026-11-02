// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The only form a URL path takes in a web diagnostic: every segment that is not
 * a literal route name of this app becomes `:id`.
 *
 * Route names come from the route tree at build time (`__DIAGNOSTIC_ROUTE_WORDS__`,
 * vite.diagnostic-route-words.ts) plus the configured base path. An allowlist,
 * not a heuristic: a search term, a user or artist name, a share code or a grant
 * in a path all look like ordinary words, and none of them may leave the
 * browser. Query strings and fragments are always dropped. Where the word list
 * was not compiled in, every segment becomes `:id`.
 */

import { base } from '$app/paths';
import { diagnosticRouteTemplate } from '$lib/shared/client-diagnostics-routing.js';

let words: Set<string> | null = null;

function routeWords(): Set<string> {
    if (words) return words;
    const compiled =
        typeof __DIAGNOSTIC_ROUTE_WORDS__ !== 'undefined' ? __DIAGNOSTIC_ROUTE_WORDS__ : [];
    words = new Set([...(compiled ?? []), ...base.split('/').filter(Boolean)]);
    return words;
}

export function diagnosticPathTemplate(endpoint: string): string {
    const known = routeWords();
    return diagnosticRouteTemplate(endpoint)
        .split('/')
        .map((segment) =>
            segment === '' || segment === ':id' || known.has(segment) ? segment : ':id',
        )
        .join('/');
}
