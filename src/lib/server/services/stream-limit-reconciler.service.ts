// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { getUserById } from '$lib/server/database/queries/users.queries.js';
import { unmeteredSources } from '$lib/server/database/queries/play-sessions.queries.js';
import { setIfNotExists, cacheGet, cacheSet, cacheDel } from '$lib/server/cache/valkey.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { UserId } from '$lib/shared/user-id.js';
import { getEffectivePolicy, getActiveSessionsForUser } from './play-sessions.service.js';
import { killSessionUnified } from './session-kill.service.js';
import { isUnlimitedStreams } from '$lib/schemas/play-sessions.js';

const logger = Logger.for('StreamLimitReconciler');

/** Cross-replica throttle: at most one reconciliation per user per window. */
const THROTTLE_SECONDS = 30;
/** TTL for the over-limit marker — comfortably longer than GRACE_SECONDS. */
const MARKER_TTL_SECONDS = 120;
/** Grace a freshly-detected over-limit user gets before sessions are kicked. */
const GRACE_SECONDS = 45;

const KILLED_BY = 'system:stream-limit-reconciler';
const KICK_REASON = 'stream_limit';

function throttleKey(userId: string): string {
    return `v1:stream-limit:recheck:${userId}`;
}

function overLimitMarkerKey(userId: string): string {
    return `v1:stream-limit:over:${userId}`;
}

/**
 * Continuous stream-limit reconciliation ("grace-then-kick") for the native
 * heartbeat path.
 *
 * Admission-time enforcement (POST /api/play-sessions 422 + HLS manifest 429)
 * can be evaded (direct-play clients that ignore the 422, transcode-path
 * session stubs) or raced (an admin lowering a user's limit mid-stream). This
 * re-checks the user's effective policy on every heartbeat and, when they are
 * over limit, kicks the newest excess sessions after a short grace period —
 * gated on the `STREAM_LIMITS_ENFORCED` policy.
 *
 * Fail-safe by design: gated on the kill-switch, throttled across replicas via
 * a Valkey `SET NX`, and any error (including Valkey being unavailable) is a
 * silent no-op — admission-time enforcement still applies regardless.
 */
export async function reconcileStreamLimit(sql: postgres.Sql, userId: UserId): Promise<void> {
    if (!config.STREAM_LIMITS_ENFORCED) return;

    // Cross-replica throttle — only one reconciliation per user per window,
    // regardless of which replica handled the heartbeat that triggered it.
    const acquired = await setIfNotExists(
        throttleKey(userId),
        String(Date.now()),
        THROTTLE_SECONDS,
    );
    if (!acquired) return;

    try {
        const user = await getUserById(sql, userId);
        // No username resolvable (deleted user, or a UUID-only caller) — fall
        // back to the UUID as the policy key, same convention as the
        // Jellyfin-compat path: user_stream_policies finds no row and the
        // default policy applies.
        const policyKey = user?.username ?? userId;
        const policy = await getEffectivePolicy(sql, policyKey);

        // Steady-state count — no admission-time exclusions apply here.
        // play_sessions.id is `uuid NOT NULL` (see base schema), so a
        // 'preview-' prefixed id (as used by manifest-level preview sessions)
        // can never appear in this table — no filter needed.
        //
        // Unmetered sources are dropped from BOTH the count and the kick set,
        // and the second half is the load-bearing one: kicking a native
        // Jellyfin / Subsonic mirror only deletes our row (the ~5s poller
        // re-ingests it), and killing a 'local' row cannot stop a file playing
        // off the client's own disk. Kicking either would report a
        // reconciliation that did not happen. Must use the same trust-gated set
        // as enforceStreamPolicy: counting a session the limit check exempted
        // would kick users for being over a limit they were never over.
        const unmetered = unmeteredSources(config.TRUST_CLIENT_LOCAL_PLAYBACK);
        const sessions = (await getActiveSessionsForUser(sql, userId)).filter(
            (s) => !unmetered.includes(s.source),
        );
        const limit = policy.max_concurrent_streams;
        const markerKey = overLimitMarkerKey(userId);

        // Unlimited sentinel: nobody is ever over the limit. Falling through
        // would compare `sessions.length <= -1` (always false) and then kick
        // every active session down to -1 once the grace period elapsed.
        // Clear any marker left over from a previous, finite limit.
        if (isUnlimitedStreams(limit)) {
            await cacheDel(markerKey);
            return;
        }

        if (sessions.length <= limit) {
            await cacheDel(markerKey);
            return;
        }

        const existingMarker = await cacheGet(markerKey);
        if (!existingMarker) {
            // First detection this window — start the grace period, don't kick yet.
            await cacheSet(markerKey, String(Date.now()), MARKER_TTL_SECONDS);
            return;
        }

        const markerAgeMs = Date.now() - Number(existingMarker);
        if (markerAgeMs < GRACE_SECONDS * 1000) return; // still within grace

        // Grace elapsed — kick the newest sessions down to the limit.
        // getActiveSessionsForUser orders by started_at DESC (newest first).
        const excess = sessions.length - limit;
        const toKick = sessions.slice(0, excess);
        const killedSessionIds: string[] = [];
        for (const session of toKick) {
            const result = await killSessionUnified(sql, session.id, KILLED_BY, {
                setCooldown: false,
                reason: KICK_REASON,
            });
            if (result?.killed) killedSessionIds.push(session.id);
        }

        await cacheDel(markerKey);

        logger.info('Stream-limit reconciliation kicked excess sessions', {
            userId,
            killedSessionIds,
            active: sessions.length,
            limit,
        });
    } catch (err) {
        logger.warn('Stream-limit reconciliation failed', { userId }, err as Error);
    }
}
