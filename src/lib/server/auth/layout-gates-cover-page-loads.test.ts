// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * A `+layout.server.ts` that redirects or errors only protects the loads that
 * actually wait for it.
 *
 * A client data request with `x-sveltekit-invalidated=0…1` skips the layout
 * load and runs only the page load; a form action and a `+server.ts` never run
 * the layout at all. So under a layout that gates (`redirect(` / `error(` in
 * its load), every other server or universal load must either:
 *   - call `parent()` and await it (directly or in a `Promise.all`) — that forces
 *     the layout load to run, and its redirect rejects this load too, or
 *   - return nothing (`return {}`) and have no form actions, or
 *   - sit under a prefix that hooks.server.ts gates (/admin — admin-route-gate.ts).
 * `+server.ts` endpoints and form actions there need a hooks gate or an entry in
 * ALLOWED with the reason they are safe.
 */

import { describe, it, expect } from 'vitest';
import { relative } from 'node:path';
import { isUnderRoutePrefix } from './admin-route-gate.js';
import {
    listRouteFiles,
    readRouteFile,
    ROUTES_DIR,
    samplePathFor,
} from './route-tree.test-helpers.js';

/** Gating layouts whose subtree is protected some other way, keyed by the layout's route id. */
const ALLOWED: Record<string, string> = {
    // A kill switch, not an access gate: resolveAuth() 404s every /j request
    // itself while FEATURE_JELLYFIN_COMPAT is off, before any route runs.
    '/(proprietary)/j': 'resolveAuth enforces FEATURE_JELLYFIN_COMPAT for all of /j',
};

const LOAD_GATE = /\b(redirect|error)\(/;
const AWAITS_PARENT = /\bparent\(\)/;
const EXPORTS_ACTIONS = /^export const actions\b|^export\s*\{[^}]*\bactions\b[^}]*\}/m;
const EXPORTS_LOAD =
    /^export\s+(const|async function|function)\s+load\b|^export\s*\{[^}]*\bload\b[^}]*\}/m;
/** `export const load = () => ({})` / `async () => { return {}; }`, with an optional type annotation. */
const EMPTY_LOAD =
    /^export const load\b[^=]*=\s*(async\s*)?\(\s*\)\s*=>\s*(\(\s*\{\s*\}\s*\)|\{\s*return\s*\{\s*\}\s*;?\s*\})/m;

const FILES = listRouteFiles();
const isLoadFile = (name: string): boolean =>
    /^\+(page|layout)(@[^.]*)?(\.server)?\.(ts|js)$/.test(name);

const GATING_LAYOUTS = FILES.filter(
    (f) =>
        isLoadFile(f.name) && f.name.startsWith('+layout') && LOAD_GATE.test(readRouteFile(f.file)),
);

function isHooksGated(id: string): boolean {
    return isUnderRoutePrefix(
        { route: { id }, url: new URL(`http://x${samplePathFor(id)}`) },
        '/admin',
        '',
    );
}

describe('loads under a gating layout cannot skip it', () => {
    it('finds the gating layouts', () => {
        const ids = GATING_LAYOUTS.map((f) => f.id);
        expect(ids).toContain('/admin');
        expect(ids).toContain('/livetv');
    });

    for (const layout of GATING_LAYOUTS) {
        it(`${layout.id} (${layout.name})`, () => {
            if (ALLOWED[layout.id] || isHooksGated(layout.id)) return;
            const under = FILES.filter(
                (f) =>
                    f.file !== layout.file &&
                    (f.id === layout.id || f.id.startsWith(`${layout.id}/`)),
            );
            const problems: string[] = [];
            for (const f of under) {
                const where = relative(ROUTES_DIR, f.file);
                if (f.name.startsWith('+server')) {
                    problems.push(`${where}: an endpoint never runs the layout load`);
                    continue;
                }
                if (!isLoadFile(f.name)) continue;
                const src = readRouteFile(f.file);
                if (EXPORTS_ACTIONS.test(src)) {
                    problems.push(
                        `${where}: form actions run before (and without) the layout load`,
                    );
                }
                if (EXPORTS_LOAD.test(src) && !AWAITS_PARENT.test(src) && !EMPTY_LOAD.test(src)) {
                    problems.push(`${where}: load neither calls parent() nor returns {}`);
                }
            }
            expect(
                problems,
                `${layout.id}/${layout.name} gates in its load, which a data request can skip. ` +
                    'Await parent(), re-check access in the load, gate the prefix in hooks.server.ts, ' +
                    'or add the layout to ALLOWED with the reason it is safe.',
            ).toEqual([]);
        });
    }
});
