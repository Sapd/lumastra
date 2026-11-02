// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * node-loader.mjs — Node ESM customization hooks for the OpenAPI generator.
 *
 * WHY THIS EXISTS
 * ---------------
 * Phase 1 of the OpenAPI architecture fix derives each def-mounted `/api/v1`
 * route's request contract (query/body/params) directly from the route's
 * `def.request` Zod schemas — the SAME object mount() validates at runtime.
 * That means the generator must `import()` real def modules under `npx tsx`.
 *
 * Def modules transitively pull in Vite-only constructs that THROW under plain
 * Node/tsx (no Vite plugin pipeline):
 *   1. `?raw` (and `?url`/`?inline`) imports — e.g. the task Lua sources in
 *      `src/lib/server/tasks/lua/loader.ts` → `ERR_UNKNOWN_FILE_EXTENSION ".lua"`.
 *   2. SvelteKit virtual modules `$app/*` and `$env/*` (all five `$env`
 *      subpaths) — Node can't resolve the `$`-prefixed bare specifiers at all.
 *   3. Svelte rune globals (`$state`, `$derived`, `$effect`, …) called at
 *      module scope in `.svelte.ts` files. Those are handled on the MAIN thread
 *      by register-loader.mjs (globals must exist where modules EXECUTE, not in
 *      this loader thread) — see that file. This loader only covers 1 & 2, which
 *      are resolve/load-time concerns.
 *
 * These hooks run in Node's dedicated loader thread (off the main thread), so
 * they may ONLY influence module resolution/loading — never main-thread globals.
 *
 * The hooks are intentionally narrow: anything they don't recognise is delegated
 * to the next hook in the chain (tsx's loader), so normal `.ts` resolution is
 * completely unaffected.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// A query string that requests the raw text / url of an asset instead of its
// module semantics: `?raw`, `?url`, `?inline` (optionally combined with others).
const ASSET_QUERY_RE = /(?:^|&)(?:raw|url|inline)(?:&|$)/;

// Custom URL scheme for the SvelteKit virtual-module stubs we synthesize. The
// `load` hook recognises this scheme and returns benign stub source.
const STUB_SCHEME = 'lumastra-stub:';

/**
 * Benign stub source for a `$app/*` or `$env/*` virtual module.
 *
 * Only the named exports the def graph actually imports need to be real; the
 * rest are provided defensively so an unexpected import doesn't crash the run.
 * Values are inert: `browser=false`, `dev=false`, `building=true`, empty env,
 * empty base path, no-op navigation helpers.
 */
function stubSource(specifier) {
    switch (specifier) {
        case '$app/environment':
            return [
                'export const browser = false;',
                'export const dev = false;',
                'export const building = true;',
                "export const version = '';",
            ].join('\n');

        case '$app/paths':
            // Server code imports { base }. Provide the full modern surface so a
            // stray `assets`/`resolveRoute`/`resolve` import also resolves.
            return [
                "export const base = '';",
                "export const assets = '';",
                'export function resolveRoute(path) { return path; }',
                'export function resolve(path) { return path; }',
            ].join('\n');

        case '$app/navigation':
            return [
                'export function goto() { return Promise.resolve(); }',
                'export function invalidate() { return Promise.resolve(); }',
                'export function invalidateAll() { return Promise.resolve(); }',
                'export function preloadData() { return Promise.resolve(); }',
                'export function preloadCode() { return Promise.resolve(); }',
                'export function beforeNavigate() {}',
                'export function afterNavigate() {}',
                'export function onNavigate() {}',
                'export function pushState() {}',
                'export function replaceState() {}',
                'export function disableScrollHandling() {}',
                'export function goto_() {}',
            ].join('\n');

        case '$app/stores': {
            // Minimal svelte-store-shaped stubs (subscribe returns an unsubscribe).
            const store = (val) => `{ subscribe(run) { run(${val}); return () => {}; } }`;
            return [
                `export const page = ${store('{ url: new URL("http://localhost/"), params: {}, data: {} }')};`,
                `export const navigating = ${store('null')};`,
                `export const updated = ${store('false')};`,
                'export function getStores() { return { page, navigating, updated }; }',
            ].join('\n');
        }

        case '$env/dynamic/public':
        case '$env/dynamic/private':
            // Runtime env access: an empty object returns `undefined` for any key,
            // which is exactly the behaviour a missing env var should have.
            return 'export const env = {};';

        case '$env/static/public':
        case '$env/static/private':
            // Static env is inlined per named export at build time. No def-graph
            // module imports from these today, so an empty module suffices. If one
            // ever does, the missing named export surfaces as a LOUD import failure
            // (GUARD B) rather than a silent wrong value.
            return 'export {};';

        default:
            // Unknown $app/$env subpath: empty module. A named import against it
            // will throw at link time and surface via GUARD B.
            return 'export {};';
    }
}

/** resolve hook — redirect virtual specifiers and asset-query imports. */
export async function resolve(specifier, context, nextResolve) {
    // SvelteKit virtual modules: $app/* and $env/*.
    if (specifier.startsWith('$app/') || specifier.startsWith('$env/')) {
        return { url: STUB_SCHEME + specifier, shortCircuit: true };
    }

    // Asset-query imports: `./foo.lua?raw`, `./bar.svg?url`, etc. Resolve the
    // underlying file relative to the importer, then carry the query through so
    // the load hook can read the raw text.
    const qIdx = specifier.indexOf('?');
    if (qIdx !== -1 && ASSET_QUERY_RE.test(specifier.slice(qIdx + 1))) {
        const base = specifier.slice(0, qIdx);
        const query = specifier.slice(qIdx + 1);
        // Resolve the bare (query-stripped) specifier against the parent so the
        // default resolver computes the real file URL, then re-attach the query.
        const resolved = await nextResolve(base, context);
        return { url: `${resolved.url}?${query}`, shortCircuit: true };
    }

    return nextResolve(specifier, context);
}

/** load hook — serve stub source and raw-asset source. */
export async function load(url, context, nextLoad) {
    // Virtual $app/$env stub.
    if (url.startsWith(STUB_SCHEME)) {
        const specifier = url.slice(STUB_SCHEME.length);
        return { format: 'module', shortCircuit: true, source: stubSource(specifier) };
    }

    // Asset-query import → `export default <raw file text>`.
    const qIdx = url.indexOf('?');
    if (qIdx !== -1 && ASSET_QUERY_RE.test(url.slice(qIdx + 1))) {
        const filePath = fileURLToPath(url.slice(0, qIdx));
        const text = readFileSync(filePath, 'utf-8');
        return {
            format: 'module',
            shortCircuit: true,
            source: `export default ${JSON.stringify(text)};`,
        };
    }

    return nextLoad(url, context);
}
