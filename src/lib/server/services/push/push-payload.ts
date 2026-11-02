// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * APNs payload construction.
 *
 * Text is rendered HERE, server-side, with an explicit Paraglide locale — not via
 * `title-loc-key`. Two reasons, both load-bearing:
 *
 *  1. A loc-key resolves against the INSTALLED client bundle, so every new
 *     notification kind is dead text until the App Store tail drains, and the
 *     server has no way to detect whether a token's build knows a key. Server
 *     rendering has no tail.
 *  2. A loc-key resolves against the DEVICE language. The moment the iOS app
 *     grows an in-app language picker (the web UI already has one) pushes would
 *     silently disagree with the rest of the app. The client reports its own
 *     effective locale at registration instead.
 *
 * Note also that Apple documents `title` and `title-loc-key` as mutually
 * exclusive with no precedence when both are sent, so "send both as a fallback"
 * is not available.
 *
 * @module services/push/push-payload
 */

import { m } from '$lib/paraglide/messages.js';
import { config } from '$lib/server/config.js';
import {
    KIND_ADMIN_BROADCAST,
    KIND_JELLYFIN_READONLY_TOKEN,
    KIND_LIBRARY_NEW_EPISODE,
    KIND_REQUEST_AVAILABLE,
} from '$lib/shared/user-event-kinds.js';
import { Logger } from '$lib/server/utils/logger.js';
import type { PushContentLocaleSegment } from '$lib/server/utils/push-rich-paths.js';

const logger = Logger.for('PushPayload');

/** Bumped whenever the payload shape changes in a way old clients cannot read. */
export const PUSH_PAYLOAD_VERSION = 1;

/** How long APNs stores an undelivered push for an offline device. */
const EXPIRATION_WINDOW_MS = 4 * 60 * 60 * 1000;

/**
 * Aliased rather than spelled out: the locale also travels as a SIGNED PATH
 * SEGMENT in `push-content/{locale}`, and the middleware exemption that lets
 * that URL reach its route matches on the same set. Widening one without the
 * other mints URLs that are 401'd before the route sees them.
 */
export type PushLocale = PushContentLocaleSegment;
export type PushPayloadMode = 'content-ful' | 'content-free';

export interface PushPayloadInput {
    kind: string;
    notificationId: string;
    badge: number;
    /** Client-reported app locale (BCP-47). Null falls back to English. */
    locale: string | null;
    mode: PushPayloadMode;
    /** Content-ful mode only. Ignored entirely in content-free mode. */
    mediaTitle?: string;
    /** Content-ful mode only. Ignored entirely in content-free mode. */
    mediaSubtitle?: string;
    /**
     * Signed URL returning IMAGE BYTES for this notification's artwork.
     * Omit when no artwork exists — absence is the signal, and it is the only
     * way the extension can tell "no picture" from "picture we failed to serve".
     */
    imageUrl?: string;
    /** Signed URL returning `{title, body}` JSON for this notification. */
    contentUrl?: string;
}

export interface ApnsPayload {
    aps: {
        alert: { title: string; body: string };
        badge: number;
        /** Lets a Notification Service Extension rewrite this before display. */
        'mutable-content': 1;
        sound: 'default';
    };
    /**
     * Everything the relay is allowed to see. The two URLs name the notification
     * UUID — which `id` already carries — and nothing about the media, so the
     * content-free property is preserved: the relay learns no title, no media id
     * and no artwork identity from them.
     *
     * Both are OPTIONAL and both point at the user's own server. The extension
     * fetches them CONCURRENTLY, so two URLs cost one round-trip of latency.
     */
    data: {
        id: string;
        kind: string;
        v: number;
        image_url?: string;
        content_url?: string;
    };
}

/** Narrow a BCP-47 tag to one of the project's two locales. */
export function resolvePushLocale(raw: string | null): PushLocale {
    if (!raw) return 'en';
    return raw.toLowerCase().split(/[-_]/)[0] === 'de' ? 'de' : 'en';
}

/**
 * Absolute expiration, anchored to when the notification was created rather than
 * to now. Recomputing per attempt would stretch the window by the ladder's
 * duration and make the deadline a property of our queue instead of the event.
 */
export function pushExpirationEpochSeconds(createdAt: Date): number {
    return Math.floor((createdAt.getTime() + EXPIRATION_WINDOW_MS) / 1000);
}

/**
 * Title for a content-free banner: the instance's own name.
 *
 * `push_generic_title` renders the literal "Lumastra" in both locales, which is
 * wrong on any install that has rebranded — `branding_removal` is a licensed
 * module, so white-labelling is a product feature, and a push is one of the few
 * surfaces where the product name appears without any of its own chrome around
 * it. `APP_NAME` is the same value the rest of the UI titles itself with.
 *
 * The Paraglide message stays as the fallback rather than a bare string
 * literal, so a blank or whitespace-only `APP_NAME` still produces a title
 * (an empty `alert.title` renders as a gap on the lock screen).
 */
function pushTitle(locale: PushLocale): string {
    const branded = config.APP_NAME.trim();
    return branded.length > 0 ? branded : m.push_generic_title({}, { locale });
}

function genericBody(kind: string, locale: PushLocale): string {
    switch (kind) {
        case KIND_JELLYFIN_READONLY_TOKEN:
            // The relay must not learn the notice text; rich content stays on this server.
            return m.push_generic_body({}, { locale });
        case KIND_REQUEST_AVAILABLE:
            return m.push_request_available_body({}, { locale });
        case KIND_LIBRARY_NEW_EPISODE:
            return m.push_new_episode_body({}, { locale });
        case KIND_ADMIN_BROADCAST:
            // Names the SENDER, never the message. This line is what the
            // content-free transport puts on the lock screen — the relay is a
            // third party and must not learn what an operator told their users.
            // The real text arrives when the Notification Service Extension
            // fetches `content_url` from the user's own server.
            return m.push_admin_broadcast_body({}, { locale });
        default:
            // An unrecognized kind should never render silently as the wrong
            // banner with no trace — warn loudly, then fall back to the
            // new-episode body so the notification still shows something.
            logger.warn('Unrecognized push kind, rendering with new-episode body', { kind });
            return m.push_new_episode_body({}, { locale });
    }
}

/**
 * The generic banner a content-free push displays: the instance's name plus a
 * per-kind line, naming nothing.
 *
 * Exported because it is also the FALLBACK the rich-content endpoint returns
 * when a stored payload cannot produce anything better — the extension then
 * substitutes text identical to what iOS would have shown on its own, so a thin
 * payload degrades to "no change" rather than to a half-built banner.
 */
export function contentFreeAlert(
    kind: string,
    locale: PushLocale,
): { title: string; body: string } {
    return { title: pushTitle(locale), body: genericBody(kind, locale) };
}

export function buildPushPayload(input: PushPayloadInput): ApnsPayload {
    const locale = resolvePushLocale(input.locale);

    // Content-free mode ignores mediaTitle/mediaSubtitle unconditionally. This is
    // a hard branch rather than a conditional spread so that no future edit can
    // leak a title into a relay-bound payload by accident.
    const useMedia =
        input.mode === 'content-ful' && Boolean(input.mediaTitle) && Boolean(input.mediaSubtitle);

    return {
        aps: {
            alert: useMedia
                ? { title: input.mediaTitle!, body: input.mediaSubtitle! }
                : contentFreeAlert(input.kind, locale),
            badge: input.badge,
            'mutable-content': 1,
            sound: 'default',
        },
        data: {
            id: input.notificationId,
            kind: input.kind,
            v: PUSH_PAYLOAD_VERSION,
            // Spread-on-presence, not `?? undefined`: an explicit
            // `image_url: undefined` still serializes as a missing key in JSON,
            // but leaving the key out of the object entirely keeps "absent"
            // unambiguous for anything that inspects the payload before it is
            // serialized (the fake transport in tests, the relay client's own
            // logging).
            ...(input.imageUrl ? { image_url: input.imageUrl } : {}),
            ...(input.contentUrl ? { content_url: input.contentUrl } : {}),
        },
    };
}
