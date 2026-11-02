// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `$env/dynamic/private` stub for the plugin-isolation worker bundle.
 *
 * A SvelteKit VIRTUAL module, so it can be neither externalized nor moved to
 * `dependencies`. It reaches the worker graph through config.service's
 * `getEnvVariables()` (a dynamic import, which esbuild still bundles). Outside
 * SvelteKit that function already falls back to `process.env`; the worker gets
 * the same values directly.
 */
export const env = process.env;
