// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * notification-display.service.ts — the inbox row PRESENTER.
 *
 * Turns a raw `user_notifications` row into the `{display, link}` envelope that
 * `GET /notifications` and `GET /notifications/{id}` put on the wire.
 *
 * ## Why this exists at all
 *
 * `payload` is freeform JSONB written by whatever server version produced the
 * row. Every client that wanted to render a notification therefore had to know
 * each `kind`'s payload shape — which meant the web drawer carried a second,
 * drifting implementation of rules the server already had (it re-derived
 * title/body from `seriesTitle`/`episodeTitle`/`seasonNumber`, and re-derived a
 * route from `seriesId`/`mediaId`). A new kind was invisible to every shipped
 * client until that client was rebuilt, which for the iOS app means an App Store
 * tail.
 *
 * `display` and `link` invert that: the SERVER renders, the client renders what
 * it is given. A client that has never heard of a kind still shows a correct row
 * and still routes a correct tap. `kind` stays an open string and `payload` stays
 * advisory — neither is a contract a client should be reading.
 *
 * ## Text
 *
 * `composePushContent` — the SAME renderer the push banner and the iOS
 * Notification Service Extension use, imported from `push-content-text.js`
 * (the pure half; see that module's header for why the split exists). One
 * renderer is the point: a notification that reads one way on the lock screen
 * and another way in the drawer is exactly the drift this consolidates away.
 * Its guaranteed non-empty fallback (`contentFreeAlert`) is what lets
 * `display.title` be non-optional on the wire.
 *
 * ## Artwork, and why this does NOT probe the database
 *
 * The push path (`resolvePushImageTarget`) checks whether artwork actually
 * EXISTS before it emits `image_url`, because an iOS Notification Service
 * Extension gets one URL, cannot retry, and shows a broken attachment if it
 * 404s — there, absence is load-bearing information.
 *
 * The inbox is not that consumer, and paying for that check here would cost a
 * recursive-CTE presence probe plus up to two artwork lookups PER ROW — 100-300
 * round trips for a single 50-row page, on the endpoint the drawer re-fetches on
 * every window focus. So `imageUrl` here is a BEST-EFFORT URL: the image route
 * serves a placeholder for an item with no artwork, and every rendering client
 * already needs a broken-image fallback regardless.
 *
 * The URL chosen is the one the previous client-side logic treated as
 * guaranteed-to-resolve (`staticImageUrl`'s pick: the candidate that does NOT
 * suppress the placeholder) — the SERIES poster for an episode, the item's own
 * poster otherwise. That is a deliberate narrowing of the old drawer behaviour,
 * which tried the episode still first and fell through to the series poster on
 * error: a single wire field cannot express a fallback chain, and the poster is
 * the candidate that resolves for every item rather than only for the minority
 * of libraries with per-episode stills.
 *
 * Contrast the two in one line: a missing push `image_url` means "there is no
 * picture"; a missing inbox `display.imageUrl` means "there is no id to build one
 * from".
 */

import { entityImageUrl, type ApiSurface } from '$lib/shared/api-urls.js';
import {
    KIND_ADMIN_BROADCAST,
    KIND_LIBRARY_NEW_EPISODE,
    KIND_REQUEST_AVAILABLE,
} from '$lib/shared/user-event-kinds.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import { composePushContent, nonEmptyString, positiveInteger } from './push/push-content-text.js';
import type { PushLocale } from './push/push-payload.js';
import type { UserNotificationRow } from '$lib/server/database/queries/user-notifications.queries.js';
import type { NotificationDisplay, NotificationLink } from '$lib/schemas/notifications-types.js';

/** What the presenter needs from a row — narrower than the full row on purpose. */
export type PresentableNotification = Pick<UserNotificationRow, 'kind' | 'payload'>;

export interface NotificationPresentation {
    display: NotificationDisplay;
    link?: NotificationLink;
}

/**
 * The route target for a `library.new_episode` row.
 *
 * `mediaId` is the SERIES, not the episode — and that is the existing behaviour
 * being moved server-side, not a new opinion. Opening an episode's own id
 * surfaces a bare episode with no series context, no season list and no play
 * button, so the app's deep-link convention is "open the series with the season
 * and episode preselected". `seasonNumber`/`episodeNumber` are what preselect it.
 *
 * When the payload carries no `seriesId` (an orphaned row whose series could not
 * be resolved), this degrades to a plain `media` link at the episode's own id —
 * a bare-item modal beats a dead row — and deliberately drops the season/episode
 * numbers, which would otherwise preselect against the wrong entity.
 */
function newEpisodeLink(payload: Record<string, unknown>): NotificationLink | undefined {
    const seriesId = nonEmptyString(payload.seriesId);
    const mediaId = nonEmptyString(payload.mediaId);

    if (!seriesId) {
        return mediaId ? { target: 'media', mediaId } : undefined;
    }

    const seasonNumber = positiveInteger(payload.seasonNumber);
    const episodeNumber = positiveInteger(payload.episodeNumber);
    return {
        target: 'episode',
        mediaId: seriesId,
        ...(seasonNumber !== null ? { seasonNumber } : {}),
        ...(episodeNumber !== null ? { episodeNumber } : {}),
    };
}

/**
 * The route target for a `request.available` row: the MEDIA item, not the
 * request.
 *
 * Again the existing client behaviour, preserved rather than redesigned — the
 * drawer opened `?modal=<mediaId>`, because what the user wants after "your
 * request is ready" is to watch the thing, not to inspect a Jellyseerr record.
 * `requestId` rides along for a client that does want to deep-link the request;
 * `target` says which one this row is FOR.
 */
function requestAvailableLink(payload: Record<string, unknown>): NotificationLink | undefined {
    const mediaId = nonEmptyString(payload.mediaId);
    if (!mediaId) return undefined;

    const requestId = positiveInteger(payload.requestId);
    return {
        target: 'media',
        mediaId,
        ...(requestId !== null ? { requestId } : {}),
    };
}

/**
 * URL-bearing notifications use an absolute URL, or remain non-tappable.
 *
 * An announcement still has no in-app destination — it is not about a media
 * item — so a broadcast with no attached link renders exactly as it always did:
 * readable, not tappable. What changed is that an administrator may now attach
 * an ordinary web address (release notes, a status page), which arrives here as
 * `payload.linkUrl`.
 *
 * This does NOT re-validate the URL, and that is deliberate rather than an
 * omission. `SendBroadcastRequestSchema` refuses anything that is not an
 * absolute `http:`/`https:` URL at write time, which is the only moment the
 * value can be rejected cheaply; re-deriving the rule on the read path would
 * make two places responsible for one decision and invite them to disagree.
 * This function is a presenter — it spells the link the row already has.
 */
function notificationUrlLink(payload: Record<string, unknown>): NotificationLink | undefined {
    const url = nonEmptyString(payload.linkUrl);
    return url ? { target: 'url', url } : undefined;
}

/**
 * The image a row renders with, or undefined when the payload names no id to
 * build one from. See the module header for why this does not verify existence.
 */
function displayImageUrl(
    kind: string,
    payload: Record<string, unknown>,
    surface: ApiSurface,
): string | undefined {
    const mediaId = nonEmptyString(payload.mediaId);

    if (kind === KIND_LIBRARY_NEW_EPISODE) {
        // The SERIES poster: an episode row's picture is the show's, because a
        // per-episode still exists for only a minority of libraries and a single
        // wire field cannot fall back.
        const seriesId = nonEmptyString(payload.seriesId) ?? mediaId;
        return seriesId
            ? entityImageUrl(seriesId, 'poster', surface, { size: 'thumb' })
            : undefined;
    }

    // `request.available`, and any kind whose payload happens to carry a
    // `mediaId` — a poster is a safe, generic rendering for an unknown kind in a
    // way that a ROUTE is not (see `buildNotificationPresentation`).
    return mediaId ? entityImageUrl(mediaId, 'poster', surface, { size: 'thumb' }) : undefined;
}

/**
 * Render one row's `{display, link}`.
 *
 * `link` is OMITTED for any kind this build does not recognise. That asymmetry
 * with `imageUrl` above is deliberate: showing a picture for an unknown kind is
 * harmless if it is wrong, whereas guessing a ROUTE sends the user somewhere the
 * notification was not about. A future kind therefore renders as a readable,
 * non-tappable row rather than a plausible-looking link to the wrong screen.
 *
 * Announcements link to the administrator's URL (`notificationUrlLink`).
 * Jellyfin token notices have no link: there is no settings target, and old
 * payloads may carry an untrusted request-derived URL.
 */
export function buildNotificationPresentation(
    row: PresentableNotification,
    opts: { locale: PushLocale; surface: ApiSurface },
): NotificationPresentation {
    const payload = isRecord(row.payload) ? row.payload : {};
    const { title, body } = composePushContent(row.kind, payload, opts.locale);
    const imageUrl = displayImageUrl(row.kind, payload, opts.surface);

    const link =
        row.kind === KIND_LIBRARY_NEW_EPISODE
            ? newEpisodeLink(payload)
            : row.kind === KIND_REQUEST_AVAILABLE
              ? requestAvailableLink(payload)
              : row.kind === KIND_ADMIN_BROADCAST
                ? notificationUrlLink(payload)
                : undefined;

    return {
        display: {
            title,
            body,
            ...(imageUrl !== undefined ? { imageUrl } : {}),
        },
        ...(link !== undefined ? { link } : {}),
    };
}
