// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Connection settings shared by the tuned global undici dispatcher
 * (`runtime-optimizations.ts`) and the per-request pinned Agents in
 * `ssrf-guard.ts`, so a pinned fetch behaves like an unpinned one.
 *
 * Side-effect free on purpose: importing `runtime-optimizations.ts` would build
 * the global Agent as a module side effect.
 */

/** TCP + TLS connect timeout. undici's own default is 10s. */
export const OUTBOUND_CONNECT_TIMEOUT_MS = 15_000;

/**
 * HTTP/2 stays off. undici 8 enables it by default; see the note on
 * `undiciAgent` in runtime-optimizations.ts for why the global pool keeps h1.
 */
export const OUTBOUND_ALLOW_H2 = false;
