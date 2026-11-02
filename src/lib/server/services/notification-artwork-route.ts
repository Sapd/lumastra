// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Shared body of the two signed notification-artwork routes:
 *   - `notifications/{id}/push-image` — iOS Notification Service Extension
 *   - `notifications/{id}/image`      — forwarded-notification webhooks
 *
 * Both are PUBLIC routes whose `?sig=` HMAC is the entire credential, and both
 * verify it before reading anything, so an unsigned caller cannot learn whether
 * a notification UUID exists. They differ only in the signature purpose (a URL
 * minted for one can never open the other) and in the rendered size.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { ApiProblem } from '$lib/server/api/problem.js';
import { getDb } from '$lib/server/database/index.js';
import { getNotificationById } from '$lib/server/database/queries/user-notifications.queries.js';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy/index.js';
import type { ImageFormat, ImageSize } from '$lib/server/services/image-proxy/types.js';
import { resolvePushImageTarget } from '$lib/server/services/push/push-rich-content.js';
import { isUuid, normalizeUuid } from '$lib/server/utils/media-key-parser.js';
import { verifySignedUrl } from '$lib/server/utils/signed-url.js';
import type { Logger } from '$lib/server/utils/logger.js';

type ScopedLogger = ReturnType<typeof Logger.for>;

export async function serveSignedNotificationArtwork(
    event: RequestEvent,
    opts: { purpose: string; size: ImageSize; format: ImageFormat; logger: ScopedLogger },
): Promise<Response> {
    const verification = verifySignedUrl(event.url, opts.purpose);
    if (!verification.valid) {
        opts.logger.debug('Notification image signature rejected', {
            path: event.url.pathname,
            reason: verification.reason,
        });
        return ApiProblem.forbidden('Invalid or expired signature');
    }

    const rawId = event.params.id ?? '';
    if (!isUuid(rawId)) return ApiProblem.notFound('Notification not found');
    const notificationId = normalizeUuid(rawId);

    const sql = getDb();
    if (!sql) return ApiProblem.dependencyUnavailable('Database unavailable');

    const notification = await getNotificationById(sql, notificationId);
    if (!notification) return ApiProblem.notFound('Notification not found');

    const target = await resolvePushImageTarget(sql, notification.kind, notification.payload);
    if (!target) return ApiProblem.notFound('No artwork for this notification');

    const result = await getImageProxyService().getImageByCatalogId(target.mediaId, target.role, {
        size: opts.size,
        format: opts.format,
    });
    if (!result) return ApiProblem.notFound('No artwork for this notification');

    return imageResponse(result, event.request, { immutable: true });
}
