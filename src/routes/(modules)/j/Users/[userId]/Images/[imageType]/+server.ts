// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Jellyfin Compatibility Layer — User Image Proxy
//
// Serves user avatar images for Android TV and other Jellyfin clients.
// Resolves Jellyfin hex user IDs to usernames, then delegates to the
// internal avatar endpoint (Gravatar → default).
//
// A real avatar needs a Jellyfin credential (api_key, X-Emby-Token,
// Authorization/X-Emby-Authorization Token=). Upstream Jellyfin serves this
// unauthenticated, but an uploaded avatar is personal data and no login screen
// needs it here (/j/Users/Public lists nobody). Without a valid credential the
// answer is the generic silhouette, for every id.
//
// Security: when the avatar service returns nothing (unknown user or no avatar),
// we substitute the same default-avatar 200 so probing arbitrary UUIDs yields
// no signal about whether an account exists.

import type { RequestHandler as KitRequestHandler } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { getDb } from '$lib/server/database';
import { anonymousAvatarResponse, defaultAvatarResponse } from '$lib/server/utils/default-avatar';
import { withOptionalJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy';
import { parseQualityParam } from '$lib/server/utils/image-proxy';
import { parseAvatarWidth } from '$lib/server/utils/image-params';

function hexToUuid(hex: string): string {
    if (hex.length !== 32) return hex;
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const getAvatar: KitRequestHandler = async ({ params, url, request }) => {
    const { userId } = params;

    if (!userId) {
        return new Response('User ID required', { status: 400 });
    }

    // Resolve Jellyfin hex user ID -> username for the avatar service. An id
    // that is not a user answers like a user without an avatar.
    const sql = getDb();
    if (!sql) return defaultAvatarResponse(request);
    const rows = await sql<{ username: string }[]>`
        SELECT username FROM users WHERE id::text = ${hexToUuid(userId).toLowerCase()} LIMIT 1
    `;
    const username = rows[0]?.username;
    if (!username) return defaultAvatarResponse(request);

    const width = parseAvatarWidth(url);
    const result = await getImageProxyService().getUserAvatar(username, {
        quality: parseQualityParam(url),
        ...(width === undefined ? {} : { maxWidth: String(width) }),
    });

    // Collapse the oracle: no avatar and no such user look identical.
    if (!result) return defaultAvatarResponse(request);
    return imageResponse(result, request, { bounded: true, scope: 'private', maxAge: 300 });
};

export const GET: RequestHandler = withErrorHandler(
    withOptionalJellyfinAuth(getAvatar, ({ request }) => anonymousAvatarResponse(request)),
);
