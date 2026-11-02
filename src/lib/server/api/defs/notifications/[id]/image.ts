// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * notifications/{id}/image — artwork for a FORWARDED notification.
 *
 * The `imageUrl` in an `org.lumastra.user.notification` webhook points here. A
 * webhook receiver (a Telegram bot, n8n, Home Assistant) holds no user session,
 * so — exactly like `push-image` — the `?sig=` HMAC is the entire credential and
 * nothing is read before it verifies. Separate from `push-image` on purpose:
 * that route is gated by the iOS push feature flag and its signature purpose,
 * and forwarding works on installs with push switched off. A URL minted for one
 * route never opens the other.
 *
 * No per-user gate here and none is missing: access was decided when the
 * notification was emitted, and the URL was minted for that recipient's
 * forwarded copy only.
 */

import { z } from 'zod';
import { defineEndpoint } from '$lib/server/api/define.js';
import { serveSignedNotificationArtwork } from '$lib/server/services/notification-artwork-route.js';
import { NOTIFICATION_IMAGE_URL_PURPOSE } from '$lib/server/services/notification-forwarder.service.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('NotificationImageRoute');

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Notifications'],
            summary: 'Get the artwork for a forwarded notification',
            stability: 'beta',
            auth: 'none',
            description:
                'Returns the image for a notification delivered through an ' +
                '`org.lumastra.user.notification` webhook. A valid `?sig=` HMAC (purpose ' +
                '`notification-image`) is REQUIRED — there is no other accepted auth path. ' +
                'The webhook carries `data.imageUrl` / `data.imagePath` only when artwork ' +
                'exists, and the signature stays valid for 48 hours after the notification ' +
                'was created. Always JPEG, 1280 px wide at most.',
            responses: {
                200: { binary: ['image/jpeg'], description: 'Artwork bytes (JPEG)' },
                403: 'Missing, invalid, or expired signature',
                404: 'Unknown or pruned notification, or no artwork for it',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'public' },
    raw: true,

    request: {
        params: z.object({ id: z.string().min(1) }),
    },

    handlers: {
        GET: async (event, _ctx) =>
            serveSignedNotificationArtwork(event, {
                purpose: NOTIFICATION_IMAGE_URL_PURPOSE,
                // Chat apps show a full-width photo; `card` would look soft there.
                size: 'hd',
                // Telegram, Discord and Matrix all take JPEG as a photo; WebP is
                // sent as a sticker/file by some of them.
                format: 'jpg',
                logger,
            }),
    },
});
