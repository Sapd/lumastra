// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * register-loader.mjs — MAIN-THREAD bootstrap for def-importing spec generation.
 *
 * This module is imported FIRST by generate.ts (before any other import), so all
 * three of its side effects land before a single def module is resolved or run:
 *
 *  1. register('./node-loader.mjs') — installs the ESM resolve/load hooks that
 *     neutralise `?raw` asset imports and `$app/*` + `$env/*` virtual modules.
 *     (ESM `import` statements hoist above executable code, so putting this in a
 *     first-position side-effect import is the only way to guarantee it runs
 *     before generate.ts's other static imports pull anything def-adjacent.)
 *
 *  2. Svelte rune globals — `$state`, `$derived`, `$effect`, … as identity/no-op
 *     functions on globalThis. `.svelte.ts` modules call these at MODULE SCOPE;
 *     they are free identifiers that resolve to globalThis. They MUST be defined
 *     on the main thread (where modules execute), not in the loader thread — so
 *     they live here, not in node-loader.mjs.
 *
 *  3. Connection env-var scrubbing — delete every `*_URL` env var (plus the known
 *     DB/cache names) so a def module that eagerly constructs a Postgres/Valkey
 *     client at import time can't open a real socket or hang the generator.
 */

import { register } from 'node:module';

// --- 1. Install the ESM hooks (loader thread) ------------------------------
register('./node-loader.mjs', import.meta.url);

// --- 2. Svelte rune globals (main thread) ----------------------------------
// Identity for value-producing runes, no-op for effect runes. Attaching the
// sub-methods (`.raw`, `.by`, `.root`, …) keeps module-scope calls like
// `$derived.by(fn)` / `$effect.root(fn)` from throwing at import time.
const g = /** @type {Record<string, unknown>} */ (globalThis);
const identity = (v) => v;

const $state = identity;
$state.raw = identity;
$state.snapshot = identity;
g.$state = $state;

const $derived = identity;
$derived.by = (fn) => (typeof fn === 'function' ? fn() : fn);
g.$derived = $derived;

const $effect = () => {};
$effect.pre = () => {};
$effect.tracking = () => false;
$effect.root = (fn) => {
    if (typeof fn === 'function') fn();
    return () => {};
};
g.$effect = $effect;

g.$props = () => ({});
g.$bindable = identity;
g.$host = () => undefined;
const $inspect = () => ({ with: () => {} });
g.$inspect = $inspect;

// --- 3. Scrub connection env vars (main thread) ----------------------------
// Named connection vars a def graph might read at import, plus a blanket sweep
// of anything ending in `_URL` (DATABASE_URL, CACHE_URL, VALKEY_URL, REDIS_URL,
// TASK_CACHE_URL, TEST_DATABASE_URL, …). Spec generation never talks to a real
// backend, so removing these is purely defensive — it prevents an eager client
// constructor from opening a socket or blocking the process.
for (const key of Object.keys(process.env)) {
    if (/_URL$/.test(key)) {
        delete process.env[key];
    }
}
