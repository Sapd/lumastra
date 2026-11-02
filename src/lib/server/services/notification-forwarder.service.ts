// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * notification-forwarder.service.ts — copies a user's notification to the
 * OPERATOR webhooks subscribed to `org.lumastra.user.notification`.
 *
 * This is how an operator-run integration (a Telegram bot, n8n, Home Assistant,
 * Apprise) delivers the notifications Lumastra already produces, in its own
 * channel. Lumastra does not know or care what is on the other end; the event
 * carries who the notification is for, and the receiver maps that to its own
 * recipient.
 *
 * ## Two gates, both required
 *
 * - The OPERATOR named the event in an active hook's filter. An empty filter —
 *   "everything" for task and media events — never matches here
 *   (`listUserNotificationForwardingHooks` uses containment), so no hook that
 *   existed before this event did starts receiving private notifications.
 * - The USER switched `notification_forwarding` on. The operator subscribing a
 *   hook is not the user's consent to have their notifications leave the server.
 *
 * ## Delivery
 *
 * One `task_webhook_outbox` row per (hook, notification), drained by the same
 * `WebhookOutbox.deliveryPass()` as every other hook: HMAC signing, backoff, DLQ.
 * Not through `WebhookOutbox.enqueue()` — that path also fans every event out to
 * subscribing plugins, and per-user notification content is not a plugin event.
 *
 * Fired from `publishUserEvent` on the same `inserted` gate as the per-user
 * webhook and APNs push, for the same reason (see user-webhook-notifier).
 */

import type postgres from 'postgres';
import { getDb } from '$lib/server/database/connection.js';
import { Logger } from '$lib/server/utils/logger.js';
import { signUrl } from '$lib/server/utils/signed-url.js';
import { buildUserNotificationCloudEvent } from '$lib/server/tasks/cloud-events.js';
import {
    enqueueForwardedNotification,
    getForwardingRecipient,
    listUserNotificationForwardingHooks,
} from '$lib/server/database/queries/notification-forwarding.queries.js';
import { resolvePushImageTarget } from '$lib/server/services/push/push-rich-content.js';
import {
    absolutise,
    deepLinkPath,
    publicOrigin,
    render,
} from '$lib/server/services/user-webhook-notifier.service.js';
import { KIND_LIBRARY_NEW_EPISODE, KIND_REQUEST_AVAILABLE } from '$lib/shared/user-event-kinds.js';

const log = Logger.for('NotificationForwarder');

/**
 * The kinds a user consents to forwarding — exactly what the opt-in toggle says
 * ("new-episode and request notifications"). An explicit list, not "every
 * notification-class kind": a kind added to the taxonomy later must not start
 * leaving the server under a consent that never mentioned it.
 */
const FORWARDABLE_KINDS: ReadonlySet<string> = new Set([
    KIND_LIBRARY_NEW_EPISODE,
    KIND_REQUEST_AVAILABLE,
]);

/** Signature purpose of `notifications/{id}/image`. Distinct from `push-image`. */
export const NOTIFICATION_IMAGE_URL_PURPOSE = 'notification-image';

/**
 * How long a forwarded image URL stays valid. The outbox retries for about a day
 * and a half (1 s … 24 h backoff), so a receiver handed the event on its last
 * attempt can still fetch the picture.
 */
export const NOTIFICATION_IMAGE_URL_TTL_SECONDS = 48 * 60 * 60;

/** The signature covers the path, and v1 is the surface it is minted for. */
const IMAGE_SURFACE = '/api/v1';

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Structured fields a receiver composes its own message from. */
function structuredFields(data: Record<string, unknown>): Record<string, string | number> {
    const out: Record<string, string | number> = {};
    for (const key of ['reason', 'seriesId', 'seriesTitle', 'episodeTitle', 'mediaType']) {
        const v = str(data[key]);
        if (v) out[key] = v;
    }
    for (const key of ['seasonNumber', 'episodeNumber', 'year']) {
        const v = num(data[key]);
        if (v !== undefined) out[key] = v;
    }
    // `request.available` carries the item title as `title`, which would collide
    // with the rendered headline; expose it under an unambiguous name.
    const itemTitle = str(data.title);
    if (itemTitle) out.mediaTitle = itemTitle;
    return out;
}

/** Signed image path (relative) when the notification has artwork, else undefined. */
async function signedImagePath(
    sql: postgres.Sql,
    notificationId: string,
    kind: string,
    data: Record<string, unknown>,
): Promise<string | undefined> {
    const target = await resolvePushImageTarget(sql, kind, data);
    if (!target) return undefined;
    return signUrl(`${IMAGE_SURFACE}/notifications/${notificationId}/image`, {
        expiresIn: NOTIFICATION_IMAGE_URL_TTL_SECONDS,
        purpose: NOTIFICATION_IMAGE_URL_PURPOSE,
    });
}

/**
 * Queue one notification for every subscribed operator hook, if the user opted
 * in. Best-effort like every side effect of `publishUserEvent`: never throws.
 *
 * `notificationId` is the durable `user_notifications` row. It is required —
 * only an `inserted` row is forwarded, and it is both the event id (the
 * receiver's dedupe key) and what the image URL is minted for.
 */
export async function forwardUserNotification(opts: {
    userId: string;
    kind: string;
    data: Record<string, unknown>;
    notificationId: string;
}): Promise<void> {
    if (!FORWARDABLE_KINDS.has(opts.kind)) return;

    const sql = getDb();
    if (!sql) return;

    try {
        const hooks = await listUserNotificationForwardingHooks(sql);
        if (hooks.length === 0) return;

        const recipient = await getForwardingRecipient(sql, opts.userId);
        if (!recipient) return;

        const origin = publicOrigin();
        const { title, body } = render(opts.kind, opts.data);
        const linkPath = deepLinkPath(opts.kind, opts.data);
        const link = absolutise(origin, linkPath);
        const posterUrl = absolutise(origin, str(opts.data.posterUrl));
        // Artwork is decoration: a failed lookup or signing (JWT_SECRET unset,
        // transient DB error) sends the notification without a picture rather
        // than not at all.
        let imagePath: string | undefined;
        try {
            imagePath = await signedImagePath(sql, opts.notificationId, opts.kind, opts.data);
        } catch (err) {
            log.warn('Forwarded notification sent without artwork', {
                notificationId: opts.notificationId,
                err: err instanceof Error ? err.message : String(err),
            });
        }
        const imageUrl = absolutise(origin, imagePath);

        const event = buildUserNotificationCloudEvent({
            // One notification row = one event, whichever hook receives it. The
            // outbox's (hook_id, event_id) key makes a retried enqueue a no-op.
            id: `user.notification:${opts.notificationId}`,
            data: {
                kind: opts.kind,
                title,
                body,
                mediaId: str(opts.data.mediaId) ?? '',
                ...(link ? { link } : {}),
                ...(posterUrl ? { posterUrl } : {}),
                notificationId: opts.notificationId,
                user: { id: opts.userId, username: recipient.username },
                ...(linkPath ? { linkPath } : {}),
                ...(imagePath ? { imagePath } : {}),
                ...(imageUrl ? { imageUrl } : {}),
                ...structuredFields(opts.data),
            },
        });

        // One hook failing to enqueue must not cost the others their copy.
        for (const hook of hooks) {
            try {
                await enqueueForwardedNotification(sql, {
                    hookId: hook.id,
                    eventId: event.id,
                    payload: event as unknown as Record<string, unknown>,
                });
            } catch (err) {
                log.warn('Failed to enqueue forwarded notification for one hook', {
                    hookId: hook.id,
                    notificationId: opts.notificationId,
                    err: err instanceof Error ? err.message : String(err),
                });
            }
        }
    } catch (err) {
        log.warn('Failed to forward notification to operator webhooks', {
            userId: opts.userId,
            kind: opts.kind,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}
