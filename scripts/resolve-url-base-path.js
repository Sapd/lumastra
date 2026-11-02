// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Resolves SvelteKit's `paths.base` (subfolder-install URL prefix) at BUILD time.
 *
 * ## The overload this fixes
 *
 * `BASE_PATH` used to mean two incompatible things:
 *
 *  1. `config.BASE_PATH` (`src/lib/server/config.ts`) — a FILESYSTEM directory.
 *     Seven call sites default it to `/data`, `/config`, or `/tmp`
 *     (`album-enrichment.ts`, `music-scanner-utils.ts`, `media-path-resolver.ts`,
 *     `artwork-volume-headroom.ts`, `video-frame-extractor.service.ts`), and
 *     `docker-compose.example.yml` sets it to `/config` to match the config volume
 *     mount. This is the dominant, correct meaning.
 *  2. `svelte.config.js`'s `paths.base` — the URL prefix for a subfolder install.
 *
 * Because both read the SAME env var, any install following
 * `docker-compose.example.yml` (`BASE_PATH: '/config'`) got `/config/api/v1/...`
 * hrefs baked into the sandbox worker bundle and (if `BASE_PATH` were ever wired
 * into the build) the server bundle too — a live bug independently in
 * `watch-together.service.ts` and `routes/api/v1/watch-together/parties/+server.ts`,
 * which hand-built URLs from `config.BASE_PATH` directly instead of going through
 * `$lib/shared/api-urls.ts`.
 *
 * ## The fix
 *
 * `URL_BASE_PATH` is the dedicated env var for the URL prefix. `BASE_PATH` is still
 * honoured as a fallback — for any existing subpath install that set it before this
 * fix landed — but ONLY when its value does not match one of the well-known
 * filesystem defaults actually used at the config.BASE_PATH call sites above. That is
 * a heuristic, not a real type distinction (both meanings are plain
 * absolute-path-shaped strings), but it precisely targets the one value
 * (`/config`) that `docker-compose.example.yml` ships — the actual collision that
 * shipped the bug — while leaving a distinctively-named existing subpath install
 * (e.g. `/lumastra`) working exactly as before.
 *
 * Docker images built from this repo's own Dockerfile do not set `BASE_PATH` (or
 * `URL_BASE_PATH`) at build time, so every officially-built image already builds
 * with `base: ''` regardless of this change.
 *
 * Used by BOTH `svelte.config.js` (the adapter-node server/client bundle) and
 * `scripts/build-sandbox.ts` (the worker-isolation bundle, via
 * `scripts/sandbox-stubs/app-paths.js`) so the two bundles cannot disagree about
 * `base` — they now call the same function instead of independently reading env vars.
 */

/** Legacy `BASE_PATH` values that are unambiguously the filesystem meaning, not a URL prefix. */
const FILESYSTEM_BASE_PATH_DEFAULTS = new Set(['/data', '/config', '/tmp']);

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} The value for SvelteKit's `kit.paths.base`.
 */
export function resolveUrlBasePath(env = process.env) {
    const dedicated = env.URL_BASE_PATH;
    if (typeof dedicated === 'string' && dedicated.length > 0) {
        return dedicated;
    }

    const legacy = env.BASE_PATH;
    if (
        typeof legacy === 'string' &&
        legacy.length > 0 &&
        !FILESYSTEM_BASE_PATH_DEFAULTS.has(legacy)
    ) {
        return legacy;
    }

    return '';
}
