// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * notifications/{id}/push-image — artwork for one push notification.
 *
 * Half of the rich-notification pair an iOS Notification Service Extension
 * fetches (the other is `push-content/{locale}`). The push payload itself is
 * content-free because it crosses the Lumastra-operated relay, so the picture
 * comes from the USER'S OWN SERVER, addressed only by the notification UUID the
 * payload already carries.
 *
 * Auth: PUBLIC, but the `?sig=` HMAC (purpose `push-image`) is the ENTIRE
 * credential — an NSE is a separate process that may hold no usable token, and
 * `<img>`-style byte fetches cannot carry a Bearer header anyway. Same posture as
 * `media/{id}/topshelf-preview/file/{variant}`: sig-or-403, no other accepted
 * path, and nothing about the notification is read before the signature verifies,
 * so an unsigned caller cannot learn whether a given UUID exists.
 *
 * There is no per-user access gate here and none is missing: access was decided
 * when the notification was emitted (`accessibleTo` in `user-notifier.service`),
 * and this URL was minted for exactly that recipient's device.
 *
 * Class R (binary) response: image bytes on success, problem+json on failure.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { PUSH_IMAGE_URL_PURPOSE } from '$lib/server/services/push/push-rich-content.js';
import { serveSignedNotificationArtwork } from '$lib/server/services/notification-artwork-route.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PushImageRoute');

/**
 * Lock-screen attachments are small; `card` (480 px) is the largest preset that
 * still reads as a thumbnail, and it is a BOUNDED preset so every device in a
 * fan-out shares one cached derivative instead of minting per-request variants.
 */
const PUSH_IMAGE_SIZE = 'card';

/**
 * JPEG, and NOT the negotiated default.
 *
 * `UNNotificationAttachment` accepts only JPEG, PNG and GIF. Handing it WebP (or
 * AVIF) fails attachment validation INSIDE the extension — the fetch itself
 * succeeds, so the server sees a clean `200` and the device silently falls back
 * to the app icon. That is exactly how this shipped: prod served `image/webp`,
 * nginx logged `200 2920`, and the banner showed no artwork.
 *
 * The image proxy defaults to WebP for browsers, which is right for every other
 * caller — so the format has to be pinned HERE rather than changed globally.
 */
const PUSH_IMAGE_FORMAT = 'jpg';

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Notifications'],
            summary: 'Get the artwork for a push notification',
            stability: 'beta',
            auth: 'none',
            description:
                'Returns the image bytes an iOS Notification Service Extension attaches to a ' +
                'push banner. A valid `?sig=` HMAC (purpose `push-image`) is REQUIRED — there is ' +
                'no other accepted auth path. The URL is minted at send time and is only present ' +
                'in the payload when artwork actually exists, so a client that receives it can ' +
                'fetch unconditionally; absence of `data.image_url` means "no artwork".',
            responses: {
                200: {
                    // JPEG only, deliberately. This endpoint exists to feed
                    // `UNNotificationAttachment`, which rejects WebP and AVIF —
                    // advertising them here would re-legitimise the bug that
                    // made every banner fall back to the app icon.
                    binary: ['image/jpeg'],
                    description: 'Artwork bytes (always JPEG — iOS attachments reject WebP/AVIF)',
                },
                403: 'Missing, invalid, or expired signature',
                404: 'Unknown or pruned notification, or no artwork for it',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'feature', flag: 'PUSH_NOTIFICATIONS', then: { kind: 'public' } },
    raw: true,

    request: {
        params: z.object({ id: z.string().min(1) }),
    },

    handlers: {
        GET: async (event, _ctx) =>
            serveSignedNotificationArtwork(event, {
                purpose: PUSH_IMAGE_URL_PURPOSE,
                size: PUSH_IMAGE_SIZE,
                format: PUSH_IMAGE_FORMAT,
                logger,
            }),
    },
});
