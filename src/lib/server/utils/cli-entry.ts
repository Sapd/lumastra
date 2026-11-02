// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isMainThread } from 'node:worker_threads';

/**
 * True when a module is being run as a command-line script — i.e. the npm
 * script set `LUMASTRA_CLI=<name>` — and never inside a worker thread.
 *
 * 🔴 Do NOT use the `import.meta.url === \`file://${process.argv[1]}\`` idiom
 * in server modules. esbuild concatenates server modules into
 * `build/sandbox-entry.js` for worker-thread task isolation, and a
 * `node:worker_threads` Worker's `process.argv[1]` is its OWN entry path — so
 * inside the sandbox bundle every such guard compares the bundle's URL with
 * itself and FIRES. That started a TMDB sync, an MDBList sync, a
 * missing-metadata sync and an embedding run in every isolated task run, and
 * whichever finished first called `process.exit(0)` — killing the plugin mid-
 * run ("isolation worker exited (code 0) before completing", intro analyzer /
 * music analysis / trickplay). `cli-entry.test.ts` fails if the idiom returns.
 */
export function isCliEntry(name: string): boolean {
    return isMainThread && process.env.LUMASTRA_CLI === name;
}
