// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * PlaySessionId → owning-user verification, backed by the `play_sessions`
 * table.
 *
 * Moved out of `lumastra-segment-handler.ts` (fix plan D-HLS-3, security
 * runtime pass 2026-09-26) so `playback.service.ts` can import it statically
 * — the segment handler is only ever reachable from `playback.service.ts`
 * via a dynamic `import()` (to avoid a static module cycle), which meant this
 * check could not previously run on the master-playlist seam. The segment
 * handler re-exports both names below so its existing importers are
 * unaffected.
 */

import { getDb } from '$lib/server/database/index.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PlaySessionOwnership');

// ================================================================
// PLAY SESSION OWNERSHIP CACHE
// ================================================================

/** Short-lived cache: PlaySessionId → owning username. Only ever holds a
 *  *resolved* owner (a row that exists in play_sessions). The row-absent case is
 *  deliberately never cached — see verifyPlaySessionOwnership. */
const sessionOwnerCache = new Map<string, { owner: string; expiresAt: number }>();

const SESSION_OWNER_CACHE_TTL_MS = 60_000; // 60 seconds

/** Test-only: clear the module-singleton ownership cache. The cache persists
 *  across Vitest watch-mode reruns within a worker, so tests must reset it to
 *  stay deterministic. Not used in production. */
export function __resetSessionOwnerCacheForTests(): void {
    sessionOwnerCache.clear();
}

/**
 * Verify that `playSessionId` belongs to `username`.
 * Results are cached for 60 s so repeated segment requests hit memory only.
 * Preview sessions (prefix "preview-") are exempt — they have no DB rows.
 * Returns true when the session belongs to the user, false otherwise.
 *
 * Row-absent is treated as "allow" and is NEVER cached. The player begins
 * requesting HLS playlists/segments the instant it has a PlaySessionId (handed
 * out by lumastra-info), but the play_sessions row is only written when the
 * client reports the session 'start' — which cannot happen until the stream
 * actually plays. That ordering guarantees a warm-up window where the row does
 * not exist yet. Returning 404 there (and, worse, caching that negative for 60 s)
 * was the root cause of the "media failed to decode" / `stream_N/index.m3u8`
 * 404-on-fresh-load: native HLS fails the whole rendition on a 404, and the
 * cached negative pinned it so it only "recovered" once a reload/seek minted a
 * brand-new PlaySessionId that dodged the cache. Allowing an absent row is safe:
 *   • the request already passed requireAuth + withMediaAccess, so the caller
 *     has access to THE URL's item — not necessarily the job/session this
 *     PlaySessionId names; `checkJobItemBinding` (fix plan 6, C1) is what
 *     verifies that, separately, right after this ownership check;
 *   • PlaySessionId is an unguessable client UUID with no other owner to hijack
 *     while the row is absent for real playback — but NOT for `/j`'s dashless
 *     ids (still hard to guess, just not a UUID) or the deterministic
 *     `preview-cache-<hash>` artifact id, which is why the binding check
 *     rejects the latter outright rather than relying on unguessability; and
 *   • a genuinely dead/expired session is still gated downstream by
 *     restoreHlsJobIfMissing, which itself now 404s (not just 410s) on a
 *     job->item mismatch.
 * Only a row that EXISTS and is owned by a *different* user yields 404.
 */
export async function verifyPlaySessionOwnership(
    playSessionId: string,
    username: string,
): Promise<boolean> {
    if (playSessionId.startsWith('preview-')) {
        return true;
    }

    const now = Date.now();
    const cached = sessionOwnerCache.get(playSessionId);
    if (cached && now < cached.expiresAt) {
        return cached.owner === username;
    }

    const sql = getDb();
    if (!sql) {
        logger.warn('Session ownership check skipped — DB unavailable', {
            playSessionId: playSessionId.slice(0, 8),
        });
        return true;
    }

    try {
        // play_sessions.user_id is the users.id UUID (mig 16.46.0); resolve it to
        // the owner's username so the comparison below (against the authenticated
        // `username`) still works. Comparing the raw uuid to a username always
        // mismatched → 404 on every HLS segment.
        const [row] = await sql<{ username: string }[]>`
            SELECT u.username
            FROM play_sessions p
            JOIN users u ON u.id = p.user_id
            WHERE p.id = ${playSessionId}
            LIMIT 1
        `;

        // Warm-up window: row not persisted yet → allow, but do NOT cache.
        // Caching here would pin the result for the whole TTL and re-break the
        // session even after its row lands a moment later.
        if (!row) {
            return true;
        }

        const owner = row.username;
        if (sessionOwnerCache.size >= 2000) {
            const firstKey = sessionOwnerCache.keys().next().value;
            if (firstKey !== undefined) {
                sessionOwnerCache.delete(firstKey);
            }
        }
        sessionOwnerCache.set(playSessionId, {
            owner,
            expiresAt: now + SESSION_OWNER_CACHE_TTL_MS,
        });

        return owner === username;
    } catch (err) {
        logger.warn('Session ownership query failed, passing through', {
            error: err instanceof Error ? err.message : String(err),
            playSessionId: playSessionId.slice(0, 8),
        });
        return true;
    }
}
