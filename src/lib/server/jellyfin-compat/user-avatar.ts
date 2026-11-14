// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * POST|DELETE /UserImage (Jellyfin ImageController.PostUserImage /
 * DeleteUserImage): the signed-in user uploads or removes their own avatar.
 *
 * Jellyfin's body is the image itself, base64-encoded, with an `image/*`
 * Content-Type (jellyfin-web, the Android and iOS apps all send that). Raw image
 * bytes are accepted too. The upload goes through the same checks and
 * processing as the web app's avatar upload (2 MB cap, JPEG/PNG/WebP/GIF,
 * re-encoded to a 200 px WebP) and lands in the same place, so the avatar
 * shows everywhere. Success is 204, as in Jellyfin. `userId` naming anyone but
 * the caller is a 403 whether or not that user exists.
 */

import type { RequestEvent } from '@sveltejs/kit';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getDb } from '$lib/server/database';
import { deleteUserAvatar, setUserAvatar } from '$lib/server/database/queries/users.queries';
import { getImageProxyService } from '$lib/server/services/image-proxy';
import {
    AVATAR_TOO_MANY_PIXELS_MESSAGE,
    AvatarTooManyPixelsError,
    isAllowedAvatarImage,
    processAvatarImage,
} from '$lib/server/utils/avatar-image';
import { AVATAR_MAX_UPLOAD_BYTES, AVATAR_MAX_UPLOAD_LABEL } from '$lib/server/utils/avatar-upload';
import {
    BODY_TOO_LARGE,
    isDeclaredContentLengthOverCap,
    readBoundedBodyBytes,
} from '$lib/server/utils/bounded-body-reader';
import { getParam } from './utils';
import { isOtherUser } from './self-user';
import { jellyfinBadRequest } from './bad-request';

const logger = Logger.for('JellyfinCompat:UserImage');

/** The base64 form of a maximum-size image, plus slack for line breaks. */
const MAX_BODY_BYTES = Math.ceil((AVATAR_MAX_UPLOAD_BYTES * 4) / 3) + 64 * 1024;

/**
 * The image in an upload body: the bytes themselves when they already are an
 * allowed image, else the base64 text decoded (a `data:` URL prefix and
 * whitespace tolerated). Null when neither yields an allowed image.
 */
export function decodeUploadedImage(body: Uint8Array): Buffer | null {
    const raw = Buffer.from(body);
    if (isAllowedAvatarImage(raw)) return raw;
    const text = raw
        .toString('latin1')
        .replace(/^data:[^,]*,/, '')
        .replace(/\s+/g, '');
    if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text)) return null;
    const decoded = Buffer.from(text, 'base64');
    return isAllowedAvatarImage(decoded) ? decoded : null;
}

function forOtherUser(event: RequestEvent): boolean {
    return isOtherUser(getParam(event.url, 'UserId'), event.locals.user.userId);
}

export async function handleUploadUserImage(event: RequestEvent): Promise<Response> {
    if (forOtherUser(event)) {
        return ApiResponses.forbidden('User is not allowed to update the image.');
    }
    const tooLarge = (): Response =>
        ApiResponses.payloadTooLarge(`File too large (max ${AVATAR_MAX_UPLOAD_LABEL})`);
    if (isDeclaredContentLengthOverCap(event.request, MAX_BODY_BYTES)) return tooLarge();
    const body = await readBoundedBodyBytes(event.request, MAX_BODY_BYTES);
    if (body === BODY_TOO_LARGE) return tooLarge();

    const image = decodeUploadedImage(body);
    if (!image) {
        return jellyfinBadRequest('Body must be a JPEG, PNG, WebP or GIF image (base64)');
    }
    if (image.length > AVATAR_MAX_UPLOAD_BYTES) return tooLarge();

    let processed: Buffer;
    try {
        processed = await processAvatarImage(image);
    } catch (err) {
        if (err instanceof AvatarTooManyPixelsError) {
            return jellyfinBadRequest(AVATAR_TOO_MANY_PIXELS_MESSAGE);
        }
        return jellyfinBadRequest('Image processing failed — file may be corrupt');
    }

    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const username = event.locals.user.username;
    if (!(await setUserAvatar(sql, username, processed, 'image/webp'))) {
        return ApiResponses.notFound('User not found');
    }
    await getImageProxyService().invalidateAvatarCache(username);
    logger.info('Avatar uploaded from an app', { username, size: processed.length });
    return new Response(null, { status: 204 });
}

export async function handleDeleteUserImage(event: RequestEvent): Promise<Response> {
    if (forOtherUser(event)) {
        return ApiResponses.forbidden('User is not allowed to delete the image.');
    }
    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');
    const username = event.locals.user.username;
    await deleteUserAvatar(sql, username);
    await getImageProxyService().invalidateAvatarCache(username);
    logger.info('Avatar removed from an app', { username });
    return new Response(null, { status: 204 });
}
