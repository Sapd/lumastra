// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Jellyfin compat: /UserImage
//
// POST and DELETE (the signed-in user's own avatar) are authenticated and live
// in jellyfin-compat/user-avatar.ts. The rest of this note is about GET.
//
// Seerr (Jellyseerr) hits this with `?UserId=<flat-hex>` to fetch a user's
// avatar — separate from the per-user `/Users/{id}/Images/{type}` path that
// Swiftfin uses. Both ultimately resolve to the same image-proxy avatar
// resolution chain (custom upload → Jellyfin → Gravatar → default).
//
// The Jellyfin-format Id is the dashless UUID (`caaf0693bbfd4444bde3c429bfb4dc86`),
// but Postgres coerces that into a uuid value for the WHERE clause — so we
// query users.id directly with the dashless form and read back the username.
//
// GET needs a Jellyfin credential (api_key, X-Emby-Token, Authorization/
// X-Emby-Authorization Token=) to see a real avatar. Upstream Jellyfin serves
// this unauthenticated, but an uploaded avatar is personal data and no login
// screen needs it here (/j/Users/Public lists nobody). A caller without a valid
// credential, for example a Seerr page loading the <img> in a browser, gets the
// generic silhouette. We call the image-proxy service directly (rather than
// fetching `/api/image/user/...`) to bypass the forward-auth that protects `/api/*`.
//
// Security: unknown/invalid UserId returns the same default-avatar 200 as a
// known user who has no custom avatar, so probing arbitrary UUIDs yields no
// signal about whether an account exists.

import type { RequestHandler as KitRequestHandler } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { getDb } from '$lib/server/database';
import { getImageProxyService, imageResponse } from '$lib/server/services/image-proxy';
import { parseQualityParam } from '$lib/server/utils/image-proxy';
import { anonymousAvatarResponse, defaultAvatarResponse } from '$lib/server/utils/default-avatar';
import { withJellyfinAuth, withOptionalJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import {
    handleDeleteUserImage,
    handleUploadUserImage,
} from '$lib/server/proprietary/jellyfin-compat/user-avatar';

interface UsernameRow {
    username: string;
}

const getAvatar: KitRequestHandler = async ({ url, request }) => {
    const userIdRaw = url.searchParams.get('UserId') ?? url.searchParams.get('userId');
    if (!userIdRaw) {
        return new Response(null, { status: 400 });
    }

    // Accept either flat-hex (Jellyfin format) or dashed UUID. Anything else,
    // the UserId is not a valid format — fall through to default avatar so the
    // response is indistinguishable from "known user with no avatar".
    const isFlatHex = /^[0-9a-f]{32}$/i.test(userIdRaw);
    const isDashedUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        userIdRaw,
    );
    if (!isFlatHex && !isDashedUuid) {
        return defaultAvatarResponse(request);
    }

    const sql = getDb();
    if (!sql) return new Response(null, { status: 503 });

    const rows = await sql<UsernameRow[]>`
        SELECT username FROM users WHERE id = ${userIdRaw}::uuid LIMIT 1
    `;
    const username = rows[0]?.username;
    if (!username) {
        // Unknown user — return the same default as a known user with no avatar.
        return defaultAvatarResponse(request);
    }

    const quality = parseQualityParam(url);
    const result = await getImageProxyService().getUserAvatar(username, {
        quality,
    });
    if (!result) return defaultAvatarResponse(request);
    return imageResponse(result, request, { scope: 'private', maxAge: 300 });
};

export const GET: RequestHandler = withErrorHandler(
    withOptionalJellyfinAuth(getAvatar, ({ request }) => anonymousAvatarResponse(request)),
);

export const POST: RequestHandler = withJellyfinAuth(handleUploadUserImage, {
    pat: 'deny',
    mode: 'write',
});
export const DELETE: RequestHandler = withJellyfinAuth(handleDeleteUserImage, {
    pat: 'deny',
    mode: 'write',
});
