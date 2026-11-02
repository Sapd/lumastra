// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Dismissals Service
 *
 * Single source of truth: `user_media_flags` with flag_type='request_dismissed',
 * target_type='request', target_id=composite_key (e.g. `tmdb:12345:movie`).
 *
 * The underlying storage moved from the bespoke `user_notification_dismissals`
 * table to the generic `user_media_flags` table in migration 16.108.0. The
 * public interface of this module is unchanged — callers still get/upsert/delete
 * dismissals via the same function signatures.
 *
 * Re-request semantics: when a user re-requests media via POST /api/request,
 * the route calls `deleteDismissal()` to clear the row. Combined with
 * `shouldShowNotification`'s `requestedAt > dismissedAt` check on the client,
 * this is robust against clock skew between Lumastra and Jellyseerr — once
 * the dismissal row is gone, no timestamp comparison is needed at all.
 */

import { getDb } from '$lib/server/database/connection.js';
import { getUserIdByUsername } from '$lib/server/database/queries/users.queries.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { ExternalIds } from '$lib/types/api-common.js';
import { buildRequestDismissalExtKey } from '$lib/shared/request-dismissal-key.js';

const logger = Logger.for('DismissalsService');

/**
 * Build the canonical key for a request dismissal.
 *
 * Delegates to `$lib/shared/request-dismissal-key.ts` — the same builder the
 * popup reads with. It used to be a private copy here, and the copy is exactly
 * how the spellings diverged: this side kept the storage token 'tv' (as it
 * must — stored rows depend on it) while the client built 'series', so no
 * series dismissal this function wrote was ever legible to the surface that
 * wrote it.
 */
function buildDismissalKey(externalIds: ExternalIds, mediaType: 'movie' | 'tv'): string | null {
    return buildRequestDismissalExtKey(externalIds, mediaType);
}

/**
 * A dismissed request, as returned to the client.
 *
 * The client only consumes `id` and `dismissedAt`. Note that this list is NOT
 * filtered by `target_type` — it carries both the K-EXT rows written here and
 * the K-UUID rows written by the For-You surface, so the client has to be able
 * to build both shapes to read it. `requestDismissalKeys()` in
 * `$lib/shared/request-dismissal-key.ts` is what does that.
 */
export interface DismissedRequest {
    id: string;
    dismissedAt: string;
}

export interface UpsertDismissalResult {
    success: boolean;
    dismissedAt?: string;
    error?: string;
}

/**
 * Get all dismissals for a user.
 */
export async function getDismissalsForUser(username: string): Promise<DismissedRequest[]> {
    const db = getDb();
    if (!db) return [];

    try {
        // Resolve username → users.id UUID; no such user → empty.
        const uid = await getUserIdByUsername(db, username);
        if (!uid) return [];

        type Row = { target_id: string; created_at: Date };
        const rows = await db<Row[]>`
            SELECT target_id, created_at
            FROM user_media_flags
            WHERE user_id = ${uid}::uuid
              AND flag_type = 'request_dismissed'
        `;

        return rows.map((row) => ({
            id: row.target_id,
            dismissedAt: row.created_at.toISOString(),
        }));
    } catch (error) {
        logger.warn('Failed to fetch dismissals', { username, error });
        return [];
    }
}

/**
 * Upsert a dismissal. Writes a 'request_dismissed' flag into user_media_flags.
 *
 * ON CONFLICT … DO UPDATE refreshes created_at so a re-dismiss of media the
 * user re-requested after a prior dismissal uses the new timestamp (unlike
 * the old DO NOTHING behaviour on other flag types — here "last dismiss wins"
 * is intentional because the client reads dismissedAt for its requestedAt
 * comparison).
 */
export async function upsertDismissal(
    username: string,
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv',
): Promise<UpsertDismissalResult> {
    const db = getDb();
    if (!db) {
        return { success: false, error: 'Database not available' };
    }

    const compositeKey = buildDismissalKey(externalIds, mediaType);
    if (!compositeKey) {
        return { success: false, error: 'Cannot identify media' };
    }

    const uid = await getUserIdByUsername(db, username);
    if (!uid) {
        return { success: false, error: 'Unknown user' };
    }

    try {
        const rows = await db<{ created_at: Date }[]>`
            INSERT INTO user_media_flags (user_id, target_id, target_type, flag_type, created_at, expires_at)
            VALUES (${uid}::uuid, ${compositeKey}, 'request', 'request_dismissed', NOW(), NULL)
            ON CONFLICT (user_id, target_id, flag_type)
            DO UPDATE SET created_at = NOW()
            RETURNING created_at
        `;

        const dismissedAt = rows[0]?.created_at;
        if (!dismissedAt) {
            return { success: false, error: 'Failed to save dismissal' };
        }

        // Reconcile outward. The row just written is the K-EXT shape
        // (target_id = composite key, target_type = 'request'), which the
        // For-You fulfilled-requests anti-join — which matches internal UUIDs —
        // cannot see, and it leaves any unread `request.available` inbox row
        // still unread. `request-dismissal-sync.service.ts` is the single place
        // that maps between the two key shapes; it is deliberately fired
        // without awaiting so a reconcile failure cannot fail this dismiss.
        const { scheduleRequestDismissalSync } =
            await import('$lib/server/services/request-dismissal-sync.service.js');
        scheduleRequestDismissalSync(db, uid, { externalIds, mediaType }, 'popup');

        return { success: true, dismissedAt: dismissedAt.toISOString() };
    } catch (error) {
        logger.error('Failed to upsert dismissal', error as Error, {
            username,
            mediaType,
        });
        return { success: false, error: 'Database error' };
    }
}

/**
 * Delete a dismissal. Called from POST /api/request when a user re-requests
 * previously dismissed media — removing the row sidesteps the cross-service
 * clock-skew gotcha that timestamp-comparison alone would expose.
 *
 * Best-effort: failures are logged but not surfaced. Worst case the popup
 * stays hidden until the user re-dismisses; no data loss.
 */
export async function deleteDismissal(
    username: string,
    externalIds: ExternalIds,
    mediaType: 'movie' | 'tv',
): Promise<void> {
    const db = getDb();
    if (!db) return;

    const compositeKey = buildDismissalKey(externalIds, mediaType);
    if (!compositeKey) return;

    const uid = await getUserIdByUsername(db, username);
    if (!uid) return;

    try {
        await db`
            DELETE FROM user_media_flags
            WHERE user_id = ${uid}::uuid
              AND target_id = ${compositeKey}
              AND flag_type = 'request_dismissed'
        `;

        // Clear the mirrored K-UUID row too. Without this, a re-request would
        // un-hide the popup but leave the For-You rail's anti-join still
        // matching — the dismissal bug in reverse.
        const { scheduleRequestUndismissalSync } =
            await import('$lib/server/services/request-dismissal-sync.service.js');
        scheduleRequestUndismissalSync(db, uid, { externalIds, mediaType }, 'popup');
    } catch (error) {
        logger.warn('Failed to delete dismissal on re-request', {
            username,
            mediaType,
            error,
        });
    }
}
