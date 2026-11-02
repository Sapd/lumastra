// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `$app/paths` stub for the plugin-isolation worker bundle.
 *
 * `$app/paths` is a SvelteKit VIRTUAL module — there is no package to resolve at
 * runtime, so it can neither be externalized (the prod-import guard in
 * build-sandbox.ts rejects it) nor moved to `dependencies`. Bundle a stub, the
 * same way `@sveltejs/kit` is handled.
 *
 * Why the worker graph reaches this at all: the sandbox calls `loadBuiltins()`,
 * so EVERY builtin task is in the graph, and some legitimately emit client-facing
 * payloads containing image hrefs (`for-you.service.ts`, `next-up-media-item.ts`,
 * `standalone-livetv-provider.ts` → `image-utils.ts` → `shared/api-urls.ts`).
 * Producing base-aware URLs from a task is by design, not a leak — so the stub
 * must be CORRECT, not merely present.
 *
 * `base` is injected at BUILD time by esbuild `define` (see build-sandbox.ts),
 * which computes it via `scripts/resolve-url-base-path.js#resolveUrlBasePath()`
 * — the SAME function `svelte.config.js:37` calls for `paths.base` — so the
 * worker bundle and the server bundle agree by construction.
 * `vite build` and `build:sandbox` run in the same `npm run build` shell with the
 * same env, so both resolve identically.
 *
 * ⚠️ Do NOT read `process.env.BASE_PATH` at RUNTIME here (or fall back to it
 * without going through `resolveUrlBasePath()`). `BASE_PATH` is overloaded in
 * this repo: at runtime it is the config/data DIRECTORY
 * (`docker-compose.example.yml` sets `BASE_PATH: '/config'`, and
 * `media-path-resolver.ts`, `album-enrichment.ts`, `music-scanner-utils.ts` all
 * treat `config.BASE_PATH` as a filesystem path). A bare runtime read would emit
 * `/config/api/media/...` hrefs on every example-compose install — the live bug
 * `resolveUrlBasePath()` exists to fix. The dedicated URL-prefix env var is
 * `URL_BASE_PATH`; `BASE_PATH` is honoured only as a fallback, and only when its
 * value isn't one of the well-known filesystem defaults.
 *
 * Only the exports the worker graph actually uses are provided. If future code
 * imports `resolve`/`asset`/`assets` from `$app/paths`, esbuild fails loudly with
 * "no matching export" rather than silently substituting a wrong value — the same
 * self-enforcing property the `@sveltejs/kit` stub relies on.
 */

/* global __SANDBOX_APP_BASE__ -- esbuild `define`, substituted at bundle time. */

/** Injected by esbuild `define` at build time. */
export const base = __SANDBOX_APP_BASE__;

/** SvelteKit's `assets` defaults to `''` unless configured; nothing sets it here. */
export const assets = '';
