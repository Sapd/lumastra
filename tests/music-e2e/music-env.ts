// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Environment shared by the music player e2e config, globalSetup and specs. */

/** Port of the dedicated server (MUSIC_E2E_PORT); 5196 avoids the WT runs' 5191–5193. */
export function musicPort(): number {
    return Number(process.env.MUSIC_E2E_PORT || 5196);
}

/**
 * The browsers never talk to the server directly: they go through the fault proxy
 * (music-proxy.ts, started by globalSetup on the next port), which forwards
 * everything untouched until a scenario arms a fault (cut a stream mid-body, fail
 * it with a status). ORIGIN is this URL.
 */
export function proxyPort(): number {
    return musicPort() + 1;
}

export function webUrl(): string {
    return `http://127.0.0.1:${proxyPort()}`;
}

/** The server itself (globalSetup's seeding calls, the webServer readiness probe). */
export function serverUrl(): string {
    return `http://127.0.0.1:${musicPort()}`;
}

/** The listener: non-admin, group Users, signed in by forward-auth headers. */
export const MUSIC_USER = 'music-e2e';

/** Artifact directory. Small by design: CI keeps it on failure only. */
export function outDir(): string {
    return process.env.MUSIC_E2E_DIR || './test-results/music-e2e';
}

/** Where globalSetup writes the generated fixture tracks (inside a library root). */
export function fixtureDir(): string {
    return process.env.MUSIC_E2E_FIXTURES || `${outDir()}/fixtures`;
}
