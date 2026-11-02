// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The two signed URLs a content-free push carries.
 *
 * Both are keyed on the notification UUID and NOTHING else. That UUID is already
 * in the payload as `data.id`, so putting it in a URL discloses nothing new to
 * the relay — whereas a media id, a title or a role in the path would hand the
 * relay exactly the fact the content-free design exists to withhold.
 *
 * The HMAC is the entire credential: these endpoints are unauthenticated because
 * a Notification Service Extension is a separate process that may hold no usable
 * token (see A12 of the design). `signUrl` covers `path:expires:purpose`, and the
 * two purposes are distinct so an artwork credential cannot be replayed against
 * the content endpoint.
 *
 * Minted on the SEND path (a worker with no request context), which is why the
 * surface is written out here rather than derived from `ctx.surface`: the worker
 * cannot know whether the reader is a browser or a Bearer client. v1 is the
 * client-facing surface and the signature covers the path, so the mount the
 * signature is valid for is `/api/v1` and only `/api/v1`.
 *
 * @module services/push/push-rich-urls
 */

import { signUrl } from '$lib/server/utils/signed-url.js';
import {
    PUSH_CONTENT_URL_PURPOSE,
    PUSH_IMAGE_URL_PURPOSE,
    pushRichUrlExpiresInSeconds,
} from './push-rich-content.js';
import type { PushLocale } from './push-payload.js';

/**
 * The mount these signatures are valid for. Not derivable from `ctx.surface`
 * here — there is no request. See the module note.
 */
const PUSH_RICH_SURFACE = '/api/v1';

/**
 * Signed artwork URL, or null when the notification's window has already closed.
 *
 * Callers must only emit `image_url` when artwork actually exists — see
 * `resolvePushImageTarget`. A URL that is always present and sometimes 404s is
 * the failure the client asked us to remove.
 */
export function buildPushImageUrl(notificationId: string, createdAt: Date): string | null {
    const expiresIn = pushRichUrlExpiresInSeconds(createdAt);
    if (expiresIn <= 0) return null;
    return signUrl(`${PUSH_RICH_SURFACE}/notifications/${notificationId}/push-image`, {
        expiresIn,
        purpose: PUSH_IMAGE_URL_PURPOSE,
    });
}

/**
 * Signed title/body URL, or null when the notification's window has closed.
 *
 * The locale is IN THE SIGNED PATH rather than a query param: the endpoint is
 * unauthenticated and therefore has no user to read a locale from, and an
 * unsigned param would let anyone holding the URL swap the language of a
 * response we vouched for. Only `en` and `de` exist, and the send path resolves
 * the token's reported locale to one of them before it gets here.
 */
export function buildPushContentUrl(
    notificationId: string,
    locale: PushLocale,
    createdAt: Date,
): string | null {
    const expiresIn = pushRichUrlExpiresInSeconds(createdAt);
    if (expiresIn <= 0) return null;
    return signUrl(`${PUSH_RICH_SURFACE}/notifications/${notificationId}/push-content/${locale}`, {
        expiresIn,
        purpose: PUSH_CONTENT_URL_PURPOSE,
    });
}
