// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * user-webhook-notifier.service.ts — turns a per-user notification into one
 * `task_webhook_outbox` row addressed to that user's own endpoint.
 *
 * ## What this file is NOT
 *
 * It is not a delivery path. It writes to the same table `WebhookOutbox.enqueue()`
 * writes, and `WebhookOutbox.deliveryPass()` — the one that already owns
 * exponential backoff, HMAC signing, the 404/410 fast-death, the DLQ and the
 * admin outbox view — drains it. The only thing that differs is which owner
 * column the row carries (`user_hook_id` instead of `hook_id`, migration
 * 16.192.0). If you find yourself adding a fetch here, stop.
 *
 * ## The fire point, and why it is where it is
 *
 * `publishUserEvent()` calls this AFTER its durable `user_notifications` INSERT
 * has returned `inserted`. That ordering is the whole correctness argument:
 *
 * - The emitter's `hasCoalescedNotificationToday()` pre-check is a check-then-act
 *   read in a different transaction, and the outbox dispatcher drains
 *   `hashtext(media_item_id)` shards in parallel. Two episodes of one season are
 *   genuinely handled concurrently and both pre-checks pass.
 * - The unique partial index from 16.191.0 is what actually holds the line, and
 *   `insertNotification`'s `ON CONFLICT DO NOTHING` result is how a caller learns
 *   the outcome. A season drop therefore produces one row, one toast — and, from
 *   here, one push.
 * - Firing before the INSERT, or from `user-notifier.service.ts` next to the
 *   pre-check, would reintroduce exactly the duplicate this ordering exists to
 *   remove — and a duplicate push is worse than a duplicate toast, because the
 *   outbox retries it for 24 hours and it lands on someone's phone.
 *
 * `publishUserEvent` also falls through to live delivery when the persist
 * *failed* (DB down): that is a deliberate "a Postgres outage must not silently
 * turn notifications off" choice for the transient toast. This path does NOT
 * follow it there. A failed insert means nothing arbitrated the event, so every
 * parallel shard would enqueue, and each of those rows is durable and retried —
 * the annoyance stops being transient. During a DB outage there is no row, no
 * webhook, and only the live frame survives; that is the honest trade and it is
 * stated here so nobody "fixes" the asymmetry later.
 */

import { composePushContent } from './push/push-content-text.js';
import { KIND_JELLYFIN_READONLY_TOKEN } from '$lib/shared/user-event-kinds.js';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    getUserNotificationWebhookTarget,
    enqueueUserWebhookDelivery,
} from '$lib/server/database/queries/user-notification-webhooks.queries.js';
import { buildUserNotificationCloudEvent } from '$lib/server/tasks/cloud-events.js';
import { NOTIFICATION_EVENT_KIND_NAMES } from '$lib/server/api/event-kinds.js';

const log = Logger.for('UserWebhookNotifier');

/**
 * Is this kind allowed to reach a user webhook at all?
 *
 * Sourced from the taxonomy's notification subset, so a signal kind
 * (`session_changed`, `watch_state_set_changed`, `device.state`, `device.command_status`,
 * `admin`) can never produce a webhook — not because the caller is careful, but
 * because this returns false for it. `publishUserEvent` already only reaches
 * this call site on `inserted`, which only persisting kinds can be; this is the
 * second, independent statement of the same rule.
 */
export function isWebhookNotificationKind(kind: string): boolean {
    return NOTIFICATION_EVENT_KIND_NAMES.includes(kind);
}

// ---------------------------------------------------------------------------
// Payload rendering
// ---------------------------------------------------------------------------

function str(value: unknown): string | undefined {
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function num(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * Absolute-ise a relative app path against the configured public origin.
 *
 * A relative `/api/media/…` poster path is useless to ntfy or Discord — they
 * fetch it from the open internet, not from a browser that already has an
 * origin. When no public origin is configured we omit the field entirely rather
 * than send a path that will 404 on the receiver's side.
 *
 * `PUBLIC_BASE_URL` is preferred, `DEVICE_VERIFICATION_BASE_URL` is the same
 * fallback order the admin security self-check uses.
 */
export function publicOrigin(): string | null {
    const raw = config.PUBLIC_BASE_URL || config.DEVICE_VERIFICATION_BASE_URL;
    if (!raw) return null;
    try {
        return new URL(raw).origin;
    } catch {
        return null;
    }
}

export function absolutise(origin: string | null, path: string | undefined): string | undefined {
    if (!origin || !path) return undefined;
    try {
        return new URL(path, origin).toString();
    } catch {
        return undefined;
    }
}

/**
 * Build the relative deep-link path for a notification kind + payload.
 *
 * MUST stay in lockstep with `deriveHref()` in
 * `src/lib/stores/notification-inbox.ts` — that function is the reference
 * implementation this one exists to match. `library.new_episode` payloads
 * carry `seriesId` precisely so a link can open the SERIES modal with
 * `season`/`episode` preselected; opening `?modal=<episodeUuid>` directly
 * (the episode's own id) surfaces a bare episode with no series context, no
 * season list and no play button — the exact failure `deriveHref` was written
 * to avoid, and one this webhook must not reintroduce on its own surface.
 *
 * `deriveHref` cannot be imported from here: it lives in a client store
 * module (`svelte/store`, `$app/environment`, the validated `$lib/api`
 * client) that must not enter the server/worker bundle this file ships in,
 * and this file — which reads `$lib/server/config.js` — must not enter the
 * client bundle for the same reason in reverse. The two implementations are
 * therefore hand-duplicated; if you change the link contract in one, change
 * it in the other.
 *
 * `request.available` deliberately keeps using `mediaId` — that kind's
 * payload has no series indirection to get wrong, so `mediaId` is already
 * the correct target.
 */
export function deepLinkPath(kind: string, data: Record<string, unknown>): string | undefined {
    if (kind === 'library.new_episode') {
        const seriesId = str(data.seriesId);
        const mediaId = str(data.mediaId);
        // Fall back to the episode's own id when the series could not be
        // resolved (orphaned row) — a bare-item modal beats a dead link.
        const target = seriesId ?? mediaId;
        if (!target) return undefined;
        const params = new URLSearchParams({ modal: target });
        // Only meaningful when the link actually points at the series; on the
        // fallback branch the numbers would preselect against the wrong entity.
        if (target === seriesId) {
            const season = num(data.seasonNumber);
            const episode = num(data.episodeNumber);
            if (season !== undefined) params.set('season', String(season));
            if (episode !== undefined) params.set('episode', String(episode));
        }
        return `/?${params.toString()}`;
    }

    // `request.available` and any future/unknown kind: a plain item modal.
    const mediaId = str(data.mediaId);
    if (!mediaId) return undefined;
    return `/?${new URLSearchParams({ modal: mediaId }).toString()}`;
}

function seasonEpisodeLabel(season: number | undefined, episode: number | undefined): string {
    if (season === undefined || episode === undefined) return '';
    return `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
}

/**
 * Render title + body from the event data.
 *
 * Defensive in the same way the inbox renderer is: the payload is written by one
 * version and read by another, so every field is optional at the type level and
 * a missing one degrades to a shorter sentence rather than "undefined".
 *
 * English only, deliberately. This runs on the worker pod, where there is no
 * request, no `Accept-Language` and no session locale; the user's UI locale
 * lives in a cookie. Rendering a localized string here would mean threading a
 * per-user locale through the emitter for a surface whose receiver (ntfy,
 * Discord) has no locale of its own. Named as a limitation, not hidden.
 */
export function render(
    kind: string,
    data: Record<string, unknown>,
): { title: string; body: string } {
    if (kind === KIND_JELLYFIN_READONLY_TOKEN) {
        return composePushContent(kind, data, 'en');
    }
    if (kind === 'library.new_episode') {
        const seriesTitle = str(data.seriesTitle);
        const episodeTitle = str(data.episodeTitle);
        const se = seasonEpisodeLabel(num(data.seasonNumber), num(data.episodeNumber));
        const title = seriesTitle ?? episodeTitle ?? 'New episode';
        const bodyParts = [se, episodeTitle === title ? undefined : episodeTitle].filter(
            (p): p is string => p !== undefined && p.length > 0,
        );
        return {
            title: se ? `${title} — ${se}` : title,
            body: bodyParts.length > 0 ? `New episode: ${bodyParts.join(' · ')}` : 'New episode',
        };
    }
    if (kind === 'request.available') {
        const title = str(data.title) ?? 'Your request is available';
        const year = num(data.year);
        return {
            title: year ? `${title} (${year})` : title,
            body: 'Your request is now available to watch.',
        };
    }
    // A notification kind added to the taxonomy after this file was written.
    // `isWebhookNotificationKind` already let it through (it reads the taxonomy,
    // not a copy), so render something truthful rather than mislabelling it as a
    // fulfilled request — which is what an `else` that assumed the last known
    // kind would have done.
    return {
        title: str(data.title) ?? str(data.seriesTitle) ?? 'Lumastra',
        body: str(data.body) ?? 'You have a new notification.',
    };
}

/**
 * The outbox event id, and therefore the idempotency key.
 *
 * Deterministic where the notification has a coalescing identity, so a retry
 * after a crash between the durable INSERT and this enqueue cannot produce a
 * second push. `coalesceKey` already encodes "(series, season)" or "(media)";
 * the UTC day matches the coalescing index's bucket in 16.191.0 exactly, so the
 * webhook's idea of "the same notification" and the row's cannot diverge.
 *
 * Without a coalesceKey there is nothing to be deterministic about, and the
 * upstream INSERT is then the only arbiter — which is still one row, so still
 * one enqueue.
 */
function eventIdFor(userId: string, kind: string, data: Record<string, unknown>): string {
    const coalesceKey = str(data.coalesceKey);
    const day = new Date().toISOString().slice(0, 10);
    if (coalesceKey) return `${kind}:${coalesceKey}:${day}:${userId}`;
    const mediaId = str(data.mediaId) ?? 'unknown';
    return `${kind}:media:${mediaId}:${day}:${userId}`;
}

// ---------------------------------------------------------------------------
// Enqueue
// ---------------------------------------------------------------------------

/**
 * Queue one notification for the user's own webhook, if they have one and the
 * operator has enabled the feature.
 *
 * Best-effort by contract, like every other side effect hanging off
 * `publishUserEvent`: this never throws into its caller. A user's endpoint being
 * unreachable, unconfigured, or the feature being off must not affect the
 * durable row or the live frame that already succeeded.
 */
export async function enqueueUserNotificationWebhook(opts: {
    userId: string;
    kind: string;
    data: Record<string, unknown>;
}): Promise<void> {
    // Admin gate FIRST — before the DB read, so a disabled install pays nothing
    // and, more importantly, so no row is ever created that a later delivery
    // pass could drain.
    if (!config.FEATURE_USER_NOTIFICATION_WEBHOOKS) return;
    if (!isWebhookNotificationKind(opts.kind)) return;

    const sql = getDb();
    if (!sql) return;

    try {
        const target = await getUserNotificationWebhookTarget(sql, opts.userId);
        if (!target) return;

        const origin = publicOrigin();
        const { title, body } = render(opts.kind, opts.data);
        const mediaId = str(opts.data.mediaId) ?? '';
        // See `deepLinkPath()` above for the contract this has to match.
        const link = absolutise(origin, deepLinkPath(opts.kind, opts.data));
        const posterUrl = absolutise(origin, str(opts.data.posterUrl));

        const event = buildUserNotificationCloudEvent({
            id: eventIdFor(opts.userId, opts.kind, opts.data),
            data: {
                kind: opts.kind,
                title,
                body,
                mediaId,
                ...(link ? { link } : {}),
                ...(posterUrl ? { posterUrl } : {}),
            },
        });

        await enqueueUserWebhookDelivery(sql, {
            userHookId: target.id,
            eventId: event.id,
            payload: event as unknown as Record<string, unknown>,
        });
    } catch (err) {
        log.warn('Failed to enqueue user notification webhook', {
            userId: opts.userId,
            kind: opts.kind,
            err: err instanceof Error ? err.message : String(err),
        });
    }
}
