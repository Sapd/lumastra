// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * notifications/{id}/push-content/{locale} — the real banner text for one push.
 *
 * The push payload is content-free because it crosses the Lumastra-operated
 * relay, which must never learn what media a user is being notified about. The
 * Notification Service Extension therefore fetches the title and body from the
 * user's own server and rewrites the banner locally. This endpoint and
 * `push-image` are fetched CONCURRENTLY, so the pair costs one round-trip.
 *
 * The LOCALE IS IN THE PATH, not a query param, and that is a security property
 * rather than a style choice: the endpoint is unauthenticated, so there is no
 * user record to read a language preference from, and `signUrl` signs the path —
 * an unsigned `?locale=` would let anyone holding the URL change the language of
 * a response the server vouched for. Only `en` and `de` exist; the send path
 * resolves the device's reported BCP-47 tag to one of them before minting.
 *
 * Auth: PUBLIC, `?sig=` (purpose `push-content`) is the entire credential — see
 * the sibling `push-image.ts` for the full rationale. The signature is verified
 * before any DB read, so an unsigned caller cannot probe which ids exist.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { getNotificationById } from '$lib/server/database/queries/user-notifications.queries.js';
import {
    composePushContent,
    PUSH_CONTENT_URL_PURPOSE,
} from '$lib/server/services/push/push-rich-content.js';
import { PushNotificationContentSchema } from '$lib/schemas/push-notifications.js';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser.js';
import { PUSH_CONTENT_LOCALE_SEGMENTS } from '$lib/server/utils/push-rich-paths.js';
import { verifySignedUrl } from '$lib/server/utils/signed-url.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PushContentRoute');

/**
 * The project's two UI locales — `resolvePushLocale`'s output, verbatim.
 *
 * Taken from the shared segment list rather than re-spelled, because the
 * forward-auth / hooks backstop exemption that lets a signed URL reach this
 * route matches on the same set: a locale added here alone would be minted into
 * URLs that are 401'd before this handler ever runs.
 */
const PushLocaleParam = z.enum(PUSH_CONTENT_LOCALE_SEGMENTS);

export const def = defineEndpoint({
    docs: {
        GET: {
            tags: ['Notifications'],
            summary: 'Get the localized text for a push notification',
            stability: 'beta',
            auth: 'none',
            description:
                'Returns `{title, body}` for one notification, already localized to the `{locale}` ' +
                'in the path. Fetched by the iOS Notification Service Extension, which substitutes ' +
                'the text into the content-free banner. A valid `?sig=` HMAC (purpose ' +
                '`push-content`) is REQUIRED — there is no other accepted auth path.',
            responses: {
                200: {
                    schema: PushNotificationContentSchema,
                    description: 'Banner title and body',
                },
                403: 'Missing, invalid, or expired signature',
                404: 'Unknown or pruned notification',
                422: 'Unsupported locale',
                503: 'Database unavailable',
                500: 'Internal server error',
            },
        },
    },

    auth: { kind: 'feature', flag: 'PUSH_NOTIFICATIONS', then: { kind: 'public' } },

    request: {
        params: z.object({ id: z.string().min(1), locale: PushLocaleParam }),
    },

    handlers: {
        GET: async (event, _ctx) => {
            const verification = verifySignedUrl(event.url, PUSH_CONTENT_URL_PURPOSE);
            if (!verification.valid) {
                logger.debug('Push content signature rejected', {
                    path: event.url.pathname,
                    reason: verification.reason,
                });
                return ApiProblem.forbidden('Invalid or expired signature');
            }

            const rawId = event.params.id ?? '';
            if (!isUuid(rawId)) return ApiProblem.notFound('Notification not found');
            const notificationId = normalizeUuid(rawId);

            // Re-parsed rather than read from `ctx.input`: the signature covers
            // this segment, so it can only be one of the two, but a handler that
            // trusts a route param's SHAPE without checking is the kind of thing
            // that quietly becomes wrong when the enum grows.
            const locale = PushLocaleParam.safeParse(event.params.locale);
            if (!locale.success) {
                return ApiProblem.validationFailed([
                    { field: 'locale', message: 'Unsupported locale' },
                ]);
            }

            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

            const notification = await getNotificationById(sql, notificationId);
            if (!notification) return ApiProblem.notFound('Notification not found');

            const content = composePushContent(
                notification.kind,
                notification.payload,
                locale.data,
            );

            // `no-store`: this is one person's notification text rendered for one
            // device. The URL is unguessable but it is still a shared-cache-
            // visible GET, and nothing downstream should hold a copy.
            return json(content, {
                headers: { 'Cache-Control': 'private, no-store' },
            });
        },
    },
});
