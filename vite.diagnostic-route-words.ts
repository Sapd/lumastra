// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * Every literal path segment of the app's routes (`api`, `play-sessions`,
 * `master.m3u8`), for `__DIAGNOSTIC_ROUTE_WORDS__`.
 *
 * The web client's diagnostics keep a URL path segment only when it is one of
 * these words and replace everything else with `:id`. A heuristic cannot tell
 * `/api/search/inception` or a short share code from a route name; the route
 * tree can. Route groups `(x)` are not part of a URL and parameter folders
 * `[id]` never name a word, so both are skipped. A route added later is just
 * reported as `:id` until the next build, which fails closed.
 */
export function diagnosticRouteWords(root: string): string[] {
    const words = new Set<string>();
    const walk = (dir: string): void => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isDirectory()) continue;
            const name = entry.name;
            if (!name.includes('[') && !/^\(.*\)$/.test(name)) words.add(name);
            walk(join(dir, name));
        }
    };
    walk(resolve(root, 'src/routes'));
    return [...words].sort();
}
