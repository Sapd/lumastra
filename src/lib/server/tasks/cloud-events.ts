// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// CloudEvents 1.0 envelope builder for the Lumastra task system.
//
// All state transitions the orchestrator cares about are expressed as typed
// CloudEvents and published to `task:events:<class>` (SSE) and delivered via
// WebhookOutbox (HTTP).

import { ulid } from 'ulid';
import { config } from '$lib/server/config.js';

export { WEBHOOK_EVENTS, WEBHOOK_EVENT_TYPES } from '$lib/shared/webhook-events.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type CloudEventType =
    | 'org.lumastra.task.run.started'
    | 'org.lumastra.task.run.completed'
    | 'org.lumastra.task.run.failed'
    | 'org.lumastra.task.run.cancelled'
    | 'org.lumastra.task.run.cancelling'
    | 'org.lumastra.task.run.progress'
    | 'org.lumastra.task.run.stage.completed'
    | 'org.lumastra.task.cost.threshold.exceeded'
    | 'org.lumastra.media.item.added'
    | 'org.lumastra.user.notification';

export interface CloudEvent<T = unknown> {
    specversion: '1.0';
    id: string;
    source: string;
    type: CloudEventType;
    subject: string;
    time: string;
    datacontenttype: 'application/json';
    dataschema?: string;
    data: T;
}

// ── Builder ───────────────────────────────────────────────────────────────────

export function buildCloudEvent<T>(
    type: CloudEventType,
    taskId: string,
    runId: string,
    data: T,
): CloudEvent<T> {
    return {
        specversion: '1.0',
        id: ulid(),
        source: `lumastra://task-orchestrator/${config.INSTANCE_ID}`,
        type,
        subject: `${taskId}/${runId}`,
        time: new Date().toISOString(),
        datacontenttype: 'application/json',
        data,
    };
}

// ── Media-added builder ───────────────────────────────────────────────────────

/** One hydrated media item carried inside a batched media.item.added event. */
export interface MediaAddedItem {
    mediaType: string;
    title: string | null;
    year: number | null;
    internalId: string;
    externalIds: Record<string, string>;
    posterPath: string;
    libraryGroupId: string | null;
}

/**
 * Build a batched `org.lumastra.media.item.added` CloudEvent. `subject` is the
 * literal `media/batch` and `source` is the pipeline (not task-orchestrator),
 * so a hook with a task filter naturally never matches a media event.
 * `scope.libraryGroupId` is the batch's shared group when uniform, else null
 * (each item also carries its own libraryGroupId).
 */
export function buildMediaCloudEvent(
    items: MediaAddedItem[],
    libraryGroupId: string | null,
): CloudEvent<{
    count: number;
    items: MediaAddedItem[];
    scope: { libraryGroupId: string | null };
}> {
    return {
        specversion: '1.0',
        id: ulid(),
        source: `lumastra://pipeline/${config.INSTANCE_ID}`,
        type: 'org.lumastra.media.item.added',
        subject: 'media/batch',
        time: new Date().toISOString(),
        datacontenttype: 'application/json',
        data: { count: items.length, items, scope: { libraryGroupId } },
    };
}

// ── Per-user notification builder ─────────────────────────────────────────────

/** Structured half of a per-user notification — what a real integration reads. */
export interface UserNotificationEventData {
    /**
     * The notification-class wire kind (`library.new_episode` /
     * `request.available`). Typed `string`, not a literal union, on purpose: the
     * closed set lives in `$lib/shared/user-event-kinds.ts` and the caller gates
     * on it at runtime. A hand-written union here would be a second copy of the
     * taxonomy — the exact drift docs/architecture/user-events.md exists about.
     */
    kind: string;
    /** Headline, already composed for a human ("Harbor Lights — S02E03"). */
    title: string;
    /** One-line body. */
    body: string;
    /** Absolute deep link, or undefined when no public base URL is configured. */
    link?: string;
    /** Absolute poster URL, same caveat as `link`. */
    posterUrl?: string;
    /** Internal media UUID the notification is about. */
    mediaId: string;

    // ── Operator forwarding only (notification-forwarder.service.ts) ──────────
    // A per-user webhook never carries these: its receiver is the user, who
    // knows who they are, and its body travels to a host the USER chose.

    /** The `user_notifications` row id — stable across retries; dedupe on it. */
    notificationId?: string;
    /** Who the notification is for. `username` is the Lumastra login name. */
    user?: { id: string; username: string };
    /** `link` without the origin, for receivers that resolve it themselves. */
    linkPath?: string;
    /** Signed artwork path (`/api/v1/notifications/{id}/image?…`), when artwork exists. */
    imagePath?: string;
    /** `imagePath` made absolute against the public base URL, when one is set. */
    imageUrl?: string;
    /** Why this user was told (`watching` / `watchlist` / `following`), new episodes only. */
    reason?: string;
    seriesId?: string;
    seriesTitle?: string;
    episodeTitle?: string;
    seasonNumber?: number;
    episodeNumber?: number;
    /** `request.available`: the item's title / type / year. */
    mediaTitle?: string;
    mediaType?: string;
    year?: number;
}

/**
 * The render fields a generic receiver looks for, mirrored at the TOP level of
 * the JSON body as CloudEvents extension attributes (lowercase alphanumeric
 * names, string values — legal per the spec's structured JSON mode).
 *
 * This exists because of a mismatch worth stating rather than papering over:
 * `WebhookOutbox` delivers whatever is in `task_webhook_outbox.payload` and
 * `deliver()` reads `payload.type` / `payload.id` off it for the
 * `X-Lumastra-Event` and `X-Lumastra-Event-Id` headers — so the body IS a
 * CloudEvent envelope and cannot not be, short of the parallel delivery path
 * this feature is explicitly forbidden from building. No push receiver speaks
 * CloudEvents:
 *
 * | Receiver | Wants                                | With this payload                          |
 * | -------- | ------------------------------------ | ------------------------------------------ |
 * | Gotify   | `{title, message, priority}`         | renders correctly                          |
 * | Discord  | `{content}` or `{embeds}`            | renders `content`; extra keys ignored      |
 * | ntfy     | `{topic, message, …}` at the ROOT    | 400 without a topic; posting to `/<topic>` |
 * |          | path, or a raw body at `/<topic>`    | renders the whole JSON blob as the text    |
 * | Apprise  | any JSON, templated                  | works, template on `title`/`message`       |
 *
 * So: Gotify and Discord work as-is, Apprise/n8n/Home Assistant template fine,
 * and **ntfy is the one that does not render usefully out of the box** — its
 * JSON publishing mode needs the topic in the BODY, which is a value only the
 * user's URL knows. Documented in the user-facing help text rather than hidden.
 */
export interface UserNotificationRenderFields {
    /** Gotify, ntfy-root, Apprise. */
    title: string;
    /** Gotify, ntfy-root, Apprise. */
    message: string;
    /** Discord webhook body. */
    content: string;
    /** ntfy's click-through attribute; omitted when there is no link. */
    click?: string;
}

export type UserNotificationCloudEvent = CloudEvent<UserNotificationEventData> &
    UserNotificationRenderFields;

/**
 * Build the per-user notification event.
 *
 * `id` is supplied by the caller rather than generated, because the outbox row
 * is keyed on it: a deterministic id makes the enqueue idempotent under retry
 * (`ON CONFLICT DO NOTHING`), where a ULID would queue a duplicate push.
 *
 * `subject` is `notification/<kind>` and deliberately carries no user id — the
 * body travels to a third-party endpoint, and the recipient already knows who
 * they are.
 */
export function buildUserNotificationCloudEvent(params: {
    id: string;
    data: UserNotificationEventData;
}): UserNotificationCloudEvent {
    const { id, data } = params;
    const click = data.link;
    return {
        specversion: '1.0',
        id,
        source: `lumastra://notifications/${config.INSTANCE_ID}`,
        type: 'org.lumastra.user.notification',
        subject: `notification/${data.kind}`,
        time: new Date().toISOString(),
        datacontenttype: 'application/json',
        data,
        // Extension attributes — see UserNotificationRenderFields.
        title: data.title,
        message: data.body,
        content: click
            ? `**${data.title}**\n${data.body}\n${click}`
            : `**${data.title}**\n${data.body}`,
        ...(click ? { click } : {}),
    };
}

// ── Convenience builders ──────────────────────────────────────────────────────

export const cloudEvents = {
    runStarted: (taskId: string, runId: string, data: unknown): CloudEvent =>
        buildCloudEvent('org.lumastra.task.run.started', taskId, runId, data),

    runCompleted: (taskId: string, runId: string, data: unknown): CloudEvent =>
        buildCloudEvent('org.lumastra.task.run.completed', taskId, runId, data),

    runFailed: (taskId: string, runId: string, data: unknown): CloudEvent =>
        buildCloudEvent('org.lumastra.task.run.failed', taskId, runId, data),

    runCancelled: (taskId: string, runId: string, data: unknown): CloudEvent =>
        buildCloudEvent('org.lumastra.task.run.cancelled', taskId, runId, data),

    /**
     * The intermediate pending/active -> cancelling transition. Distinct from
     * `runCancelled`, which is terminal: an active run being cancelled sits in
     * `cancelling` until its handler unwinds, and without this event no client
     * ever learns that, so a "Cancelling…" affordance can never render.
     */
    runCancelling: (taskId: string, runId: string, data: unknown): CloudEvent =>
        buildCloudEvent('org.lumastra.task.run.cancelling', taskId, runId, data),

    runProgress: (taskId: string, runId: string, data: unknown): CloudEvent =>
        buildCloudEvent('org.lumastra.task.run.progress', taskId, runId, data),

    stageCompleted: (taskId: string, runId: string, data: unknown): CloudEvent =>
        buildCloudEvent('org.lumastra.task.run.stage.completed', taskId, runId, data),

    costThresholdExceeded: (taskId: string, runId: string, data: unknown): CloudEvent =>
        buildCloudEvent('org.lumastra.task.cost.threshold.exceeded', taskId, runId, data),
};
