// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'crypto';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';

// Jellyfin server version we advertise (System/Info, System/Info/Public → Version), in
// the "major.minor.patch" format real Jellyfin reports. Clients check minimum-version
// compatibility against it. Keep it at the newest spec in tests/jellyfin-contract
// (a unit test enforces that): bump together with `npx tsx tests/jellyfin-contract/extract.ts`.
export const JELLYFIN_EMULATED_VERSION = '12.2.0';

/**
 * Stable, unguessable server ID.
 *
 * Must be consistent across restarts of the same deployment so clients don't
 * treat each restart as a new server. It is seeded from `LUMASTRA_MASTER_KEY`
 * (a stable, high-entropy, SECRET per-deployment value) via a one-way SHA-256,
 * NOT from the host name. Hashing the master key keeps the id stable without
 * leaking or confirming any infrastructure identifier: an attacker can't guess
 * the seed (unlike a container hostname), so the published id is no longer a
 * confirmation oracle. The hash is one-way, so the id never exposes the master
 * key. When no master key is configured (dev/unconfigured — nothing secret to
 * protect) a fixed fallback keeps the value deterministic.
 *
 * Rotating `LUMASTRA_MASTER_KEY` changes this id, so previously-paired clients
 * re-pair once — an accepted, rare one-time cost (key rotation is already a
 * disruptive operation).
 *
 * Jellyfin uses 32-char hex WITHOUT dashes (not standard UUID format).
 */
export const JELLYFIN_SERVER_ID = (() => {
    // resolveMasterKey(), NOT the LUMASTRA_MASTER_KEY const: that const is a
    // LOAD-TIME snapshot of process.env, while an unset key is resolved (and
    // generated into <config>/master.key) lazily at RUNTIME. Reading the
    // snapshot meant every deployment that didn't set the env var explicitly
    // fell through to the shared literal below — i.e. they all published the
    // SAME server id, which is exactly the guessable-seed property the doc
    // above says this design avoids. No effect where the env var is set.
    const seed = resolveMasterKey() || 'lumastra-jellyfin-default-server-id';
    return createHash('sha256')
        .update('jellyfin-server-id:' + seed)
        .digest('hex')
        .slice(0, 32);
})();

/**
 * Fixed pseudo-ID for the synthetic "Live TV" virtual folder in UserViews.
 * Live TV isn't backed by a `library_paths` row (see `getLiveTvProvider`),
 * so it needs a stable ID of its own — clients (e.g. Moonfin) key off
 * `CollectionType === 'livetv'` to route to their Live TV guide screen and
 * don't otherwise resolve this ID against a real library, so any fixed
 * 32-char-hex value works as long as it never changes across requests.
 */
export const LIVETV_VIRTUAL_FOLDER_ID = 'a656b907eb3a512cf9c34a1f094c1478';

// Tick conversions
// Jellyfin uses "ticks" = 10,000,000 per second (100 nanosecond units)
// Lumastra uses milliseconds
export const TICKS_PER_SECOND = 10_000_000;
export const TICKS_PER_MS = 10_000;

export function ticksToMs(ticks: number): number {
    return Math.floor(ticks / TICKS_PER_MS);
}

export function msToTicks(ms: number): number {
    return Math.round(ms * TICKS_PER_MS);
}

export function secondsToTicks(seconds: number): number {
    return Math.round(seconds * TICKS_PER_SECOND);
}

export function ticksToSeconds(ticks: number): number {
    return Math.floor(ticks / TICKS_PER_SECOND);
}

/**
 * Fixed id of the user root folder (`GET /Items/Root`, Jellyfin's
 * UserRootFolder, "Media Folders"). Lumastra has no row for it; `/Items` treats
 * `ParentId=<this>` as "no parent" (the library views), like Jellyfin.
 */
export const USER_ROOT_FOLDER_ID = 'f27caa37e5142225cceded48f6553502';
