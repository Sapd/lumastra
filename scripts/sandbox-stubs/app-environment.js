// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `$app/environment` stub for the plugin-isolation worker bundle.
 *
 * A SvelteKit VIRTUAL module (see app-paths.js). It reaches the worker graph
 * through credential revocation -> `boot/compat-init` -> the assistant's tool
 * registry -> `dev-user.ts` (dynamic imports, which esbuild still bundles). The
 * worker is a production server process: never the browser, never a dev build.
 */
export const browser = false;
export const dev = false;
export const building = false;
export const version = '';
