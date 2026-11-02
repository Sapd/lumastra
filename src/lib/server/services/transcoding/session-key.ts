// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { UUID_RE } from '$lib/utils/id-patterns.js';

const DASHLESS_UUID_RE = /^[0-9a-f]{32}$/;

/**
 * `deviceId` of every transcode the `/j` (Jellyfin-compat) master route starts.
 *
 * Its PlaySessionId is NOT a `play_sessions.id`: `/j` keeps one play_sessions
 * row per (user, item) under its own random id (`findOrCreateJellyfinSession`),
 * and the client's PlaySessionId only keys the transcode. So such a job's row is
 * written without the play_sessions stub `upsertJob` otherwise inserts —
 * a stub under the PlaySessionId would be a second ACTIVE session next to the
 * real one, counted against the user's stream limit and freemium cap.
 */
export const JELLYFIN_COMPAT_DEVICE_ID = 'jellyfin-compat';

/**
 * Fold a play-session id into the key every in-memory session map uses.
 *
 * One session reaches the transcode service under several spellings of the
 * SAME UUID, and every one of them has to land on one key:
 *  - iOS creates the id with Swift's `UUID().uuidString`, which is UPPERCASE
 *    and is what every segment request carries. Prod 2026-08-28: `restoreJob`
 *    registered a job under the lowercase DB value, so every later lookup —
 *    keyed on the uppercase request id — missed forever, forcing every segment
 *    request down the DB path where a single failed `fileExists` respawned
 *    FFmpeg over a job that was already complete.
 *  - `/j` (Jellyfin-compat) PlaySessionIds are dashless 32-hex.
 *  - `active_transcode_jobs.play_session_id` is a `uuid` column, so Postgres
 *    hands every one of them back lowercase and DASHED.
 * The key is that DB form, so a value read back from a row needs no further
 * folding to match a resident job. A non-UUID id (`preview-…`) is only
 * lowercased.
 *
 * ONLY for map keys and for comparing an id with a DB value. The on-disk
 * directory name keeps the ORIGINAL spelling, so a folded key must never reach
 * the filesystem — see `getSessionOutputDir`.
 */
export function sessionKey(playSessionId: string | undefined | null): string {
    // Nullish is reachable: a job restored from a row whose `config` JSONB
    // predates `playSessionId` has `job.config.playSessionId === undefined`, and
    // teardown paths key off exactly that. A plain `Map.get(undefined)` used to
    // miss harmlessly, so this must not start throwing on the cleanup path.
    const folded = playSessionId?.toLowerCase() ?? '';
    if (!DASHLESS_UUID_RE.test(folded)) return folded;
    return `${folded.slice(0, 8)}-${folded.slice(8, 12)}-${folded.slice(12, 16)}-${folded.slice(16, 20)}-${folded.slice(20)}`;
}

/**
 * Whether `active_transcode_jobs` can hold this id: exactly the shapes
 * {@link sessionKey} folds to the dashed form the `uuid` column returns (dashed
 * or dashless, any case). Postgres would also take a partly-dashed spelling,
 * but its key would never match the value read back, so it is refused.
 */
export function isPersistablePlaySessionId(playSessionId: string): boolean {
    return UUID_RE.test(sessionKey(playSessionId));
}
