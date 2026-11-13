// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Enqueue side of push delivery.
 *
 * Called from `publishUserEvent` only when `persistNotification` returned
 * `'inserted'`. That gate is not a detail — it is what stops a season drop
 * producing one lock-screen banner per parallel outbox shard:
 *
 *  - `'conflict'` means another pod already wrote the row and is delivering it.
 *  - `'failed'` means the DB is down and nothing arbitrated the event, so every
 *    shard would enqueue one. A duplicate transient toast is survivable; a
 *    duplicate durable push is not.
 *
 * The feature-flag/token gate runs BEFORE any DB read, mirroring
 * `enqueueUserNotificationWebhook`, so that no row is ever created that a later
 * delivery pass could drain.
 *
 * Never throws. `publishUserEvent` never throws into its caller, and an emitter
 * may be running inside the pipeline dispatcher's transaction.
 *
 * @module services/push/user-push-notifier
 */

import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { enqueuePushOutbox } from '$lib/server/database/queries/user-push-outbox.queries.js';
import { userHasActivePushToken } from '$lib/server/database/queries/user-push-tokens.queries.js';
import { NOTIFICATION_EVENT_KIND_NAMES } from '$lib/server/api/event-kinds.js';
import type { UserId } from '$lib/shared/user-id';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('UserPushNotifier');

const PUSH_KINDS = new Set<string>(NOTIFICATION_EVENT_KIND_NAMES);

/** Only the durable notification kinds are pushable. Signals never are. */
export function isPushNotificationKind(kind: string): boolean {
    return PUSH_KINDS.has(kind);
}

export async function enqueueUserPush(opts: {
    userId: UserId;
    notificationId: string;
    kind: string;
}): Promise<void> {
    // Gate first, before any DB read — a disabled install pays nothing, and no
    // drainable row is created.
    if (!config.FEATURE_PUSH_NOTIFICATIONS) return;
    if (!isPushNotificationKind(opts.kind)) return;

    try {
        const sql = getDb();
        if (!sql) return;

        if (!(await userHasActivePushToken(sql, opts.userId))) return;

        await enqueuePushOutbox(sql, {
            userId: opts.userId,
            notificationId: opts.notificationId,
            kind: opts.kind,
        });
    } catch (err) {
        // Best-effort by contract: the durable row and the live frame are the
        // product; this is a fan-out on top of them.
        logger.warn(
            'Failed to enqueue push',
            { kind: opts.kind, userId: opts.userId },
            err as Error,
        );
    }
}
