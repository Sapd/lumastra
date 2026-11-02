// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { withImageProxyRateLimit } from '$lib/server/middleware/valkey-rate-limit';
import type { RequestHandler } from './$types';
import { json } from '@sveltejs/kit';
import { Logger } from '$lib/server/utils/logger';
import { parseQualityParam } from '$lib/server/utils/image-proxy';
import { parseAvatarImageOptions } from '$lib/server/utils/image-params';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy';
import { requireAuth } from '$lib/server/middleware/auth.js';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { getDb } from '$lib/server/database/connection.js';
import {
    getUserByUsername,
    setUserAvatar,
    deleteUserAvatar,
} from '$lib/server/database/queries/users.queries.js';
import {
    AVATAR_TOO_MANY_PIXELS_MESSAGE,
    AvatarTooManyPixelsError,
    isAllowedAvatarImage,
    processAvatarImage,
} from '$lib/server/utils/avatar-image.js';
import { AVATAR_MAX_UPLOAD_LABEL, readAvatarUpload } from '$lib/server/utils/avatar-upload.js';

const logger = Logger.for('UserAvatarRoute');

const getAvatar = withErrorHandler(async ({ params, url, request }) => {
    const { userId: userIdOrName } = params;

    if (!userIdOrName) {
        return new Response('User ID required', { status: 400 });
    }

    const quality = parseQualityParam(url);
    // Same `?width=` / `?size=` contract as /api/v1/users/{id}/images/avatar —
    // this route is still what the admin stats leaderboards and two playlist
    // components fetch, which are the densest avatar lists in the app.
    const avatarOptions = parseAvatarImageOptions(url);
    const service = getImageProxyService();
    const result = await service.getUserAvatar(userIdOrName, {
        quality,
        ...avatarOptions,
    });

    if (!result) return new Response('Avatar not found', { status: 404 });
    return imageResponse(result, request, { bounded: true, maxAge: 300 });
});

/**
 * Own avatar, or an admin credential. Admin comes from the principal: a scoped
 * token of an admin owner keeps `user.isAdmin` (the owner flag) but is not admin.
 */
function mayEditAvatar(locals: App.Locals, targetUsername: string): boolean {
    const isOwn = locals.user?.username?.toLowerCase() === targetUsername.toLowerCase();
    return isOwn || locals.principal?.isAdmin === true;
}

const putAvatar = requireAuth(
    withErrorHandler(async ({ params, request, locals }) => {
        const { userId: targetUsername } = params;
        if (!targetUsername) {
            return ApiResponses.badRequest('Username required');
        }

        if (!mayEditAvatar(locals, targetUsername)) {
            return ApiResponses.forbidden("Cannot change another user's avatar");
        }

        // Parse multipart form data. Over the cap — ours or the adapter's
        // BODY_SIZE_LIMIT — is a 413, never a 500.
        const upload = await readAvatarUpload(request);
        if (upload.kind === 'too_large') {
            return ApiResponses.payloadTooLarge(`File too large (max ${AVATAR_MAX_UPLOAD_LABEL})`);
        }
        if (upload.kind === 'missing') {
            return ApiResponses.badRequest('No avatar file provided');
        }
        const { file } = upload;
        if (file.size === 0) {
            return ApiResponses.badRequest('Empty file');
        }

        const rawBuffer = Buffer.from(await file.arrayBuffer());

        // Magic byte validation
        if (!isAllowedAvatarImage(rawBuffer)) {
            return ApiResponses.badRequest('Invalid image format. Allowed: JPEG, PNG, WebP, GIF');
        }

        // Process: strip EXIF, resize to 200x200, convert to WebP
        let processedBuffer: Buffer;
        try {
            processedBuffer = await processAvatarImage(rawBuffer);
        } catch (err) {
            if (err instanceof AvatarTooManyPixelsError) {
                return ApiResponses.badRequest(AVATAR_TOO_MANY_PIXELS_MESSAGE);
            }
            return ApiResponses.badRequest('Image processing failed — file may be corrupt');
        }

        // Verify target user exists
        const db = getDb();
        if (!db) return ApiResponses.error('Database not available', undefined, 503);
        const user = await getUserByUsername(db, targetUsername);
        if (!user) {
            return ApiResponses.notFound('User not found');
        }

        // Save to DB (re-check user exists to handle race with deletion)
        const saved = await setUserAvatar(db, targetUsername, processedBuffer, 'image/webp');
        if (!saved) {
            return ApiResponses.notFound('User not found');
        }

        // Invalidate disk cache
        const service = getImageProxyService();
        await service.invalidateAvatarCache(targetUsername);

        logger.info('Avatar uploaded', {
            username: targetUsername,
            size: processedBuffer.length,
        });

        return json({ success: true });
    }),
);

export const DELETE: RequestHandler = requireAuth(
    withErrorHandler(async ({ params, locals }) => {
        const { userId: targetUsername } = params;
        if (!targetUsername) {
            return ApiResponses.badRequest('Username required');
        }

        if (!mayEditAvatar(locals, targetUsername)) {
            return ApiResponses.forbidden("Cannot remove another user's avatar");
        }

        const db = getDb();
        if (!db) return ApiResponses.error('Database not available', undefined, 503);
        const user = await getUserByUsername(db, targetUsername);
        if (!user) {
            return ApiResponses.notFound('User not found');
        }
        await deleteUserAvatar(db, targetUsername);

        // Invalidate disk cache
        const service = getImageProxyService();
        await service.invalidateAvatarCache(targetUsername);

        logger.info('Avatar removed', { username: targetUsername });

        return json({ success: true });
    }),
);

export const GET: RequestHandler = withImageProxyRateLimit(getAvatar);
export const PUT: RequestHandler = withImageProxyRateLimit(putAvatar);
