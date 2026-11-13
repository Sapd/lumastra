// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * File-system view of `src/routes` for the access-gate tests: which route ids
 * exist, which route files define them, and a concrete URL path for each.
 * Reads the tree only — it never imports a route module, so it works the same
 * in the public tree and in a checkout that also has the `(private)` routes.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

export const ROUTES_DIR = join(process.cwd(), 'src/routes');

/** `+page.svelte`, `+page.server.ts`, `+layout@.svelte`, `+server.ts`, … */
const ROUTE_FILE = /^\+(page|layout|server)(@[^.]*)?(\.server)?\.(ts|js|svelte)$/;

export interface RouteFile {
    /** SvelteKit route id, groups and params verbatim: `/admin/(private)/courses/[id]`. */
    id: string;
    /** Absolute path on disk. */
    file: string;
    /** File name: `+page.server.ts`. */
    name: string;
}

/** Every route file under `src/routes`, with the route id SvelteKit gives its directory. */
export function listRouteFiles(dir: string = ROUTES_DIR): RouteFile[] {
    const out: RouteFile[] = [];
    const walk = (d: string): void => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, entry.name);
            if (entry.isDirectory()) walk(p);
            else if (ROUTE_FILE.test(entry.name)) {
                const rel = relative(dir, d).split(sep).join('/');
                out.push({ id: rel ? `/${rel}` : '/', file: p, name: entry.name });
            }
        }
    };
    walk(dir);
    return out;
}

/** Distinct route ids, sorted. */
export function listRouteIds(dir: string = ROUTES_DIR): string[] {
    return [...new Set(listRouteFiles(dir).map((f) => f.id))].sort();
}

/**
 * A URL path that routes to `id`: groups dropped, `[x]`/`[x=matcher]` filled,
 * `[...rest]` given two segments, `[[optional]]` left out.
 */
export function samplePathFor(id: string): string {
    const segments = id
        .split('/')
        .filter(Boolean)
        .filter((s) => !/^\(.+\)$/.test(s))
        .filter((s) => !/^\[\[[^\]]+\]\]$/.test(s))
        .map((s) =>
            s
                .replace(/\[\.\.\.[^\]]+\]/g, 'a/b')
                .replace(/\[\[[^\]]+\]\]/g, '')
                .replace(/\[[^\]]+\]/g, 'p1'),
        );
    return `/${segments.join('/')}`;
}

/** `/admin/(private)/courses` → `/admin/courses`. */
export function withoutGroups(id: string): string {
    return id.replace(/\/\([^/)]+\)/g, '') || '/';
}

export function readRouteFile(file: string): string {
    return readFileSync(file, 'utf8');
}
