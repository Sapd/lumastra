// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `$env/dynamic/public` stub for the plugin-isolation worker bundle.
 *
 * A SvelteKit VIRTUAL module (see env-dynamic-private.js). It reaches the worker
 * graph through `boot/compat-init` -> the assistant service. SvelteKit exposes
 * the `PUBLIC_`-prefixed variables there; the worker reads the same ones from
 * `process.env`.
 */
export const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => key.startsWith('PUBLIC_')),
);
