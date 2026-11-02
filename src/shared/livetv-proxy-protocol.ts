// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Live TV proxy protocol number and build-id file, known to the app and the
 * Rust proxy in native/livetv-proxy/.
 *
 * The proxy runs on its own pinned image, so after an app update it can be older than
 * web/worker. It reports LIVETV_PROXY_PROTOCOL and its build id in its heartbeat;
 * Admin → Cluster compares them with the app's (services/livetv/proxy-compat.ts).
 *
 * Bump LIVETV_PROXY_PROTOCOL when the app↔proxy contract changes: the HTTP routes and
 * bodies between app and proxy, the Valkey keys/payloads either side reads from the
 * other (heartbeat, failure events), or the shared types in livetv-proxy-types.ts.
 * Raise LIVETV_PROXY_MIN_PROTOCOL in proxy-compat.ts too when older proxies no longer
 * work with the new app. The Rust copy (runtime_operations.rs PROXY_PROTOCOL) is
 * checked against this file by a Rust test.
 *
 * RULES: constants only, ZERO imports (bundled into the TypeScript proxy).
 */

export const LIVETV_PROXY_PROTOCOL = 1;

/**
 * File next to the proxy executables (build/) holding the proxy build id: a hash of
 * every proxy input, written by `npm run build:proxy` (scripts/livetv-proxy-inputs.mjs).
 * Two images with the same id run the same proxy code.
 */
export const LIVETV_PROXY_BUILD_FILE = 'livetv-proxy-build';
