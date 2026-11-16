// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Request-level wrapper around canDownload for every download route: returns
 * the 403 problem response when the caller may not download, null otherwise.
 * Call it AFTER auth and checkMediaAccess so an item the user cannot see stays
 * a 404 (no existence leak).
 */

import { ApiProblem } from '$lib/server/api/problem.js';
import { canDownload, userMayDownload } from '$lib/server/services/download-access.service.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import * as m from '$lib/paraglide/messages';

type GuardLocals = Parameters<typeof localsIsAdmin>[0] & {
    user?: { userId?: string; username?: string } | null;
};

/**
 * The subject canDownload / userMayDownload judge, built from the request's
 * locals. Admin is decided by the principal: an admin using a Quick Connect
 * session or a /j API key is treated as a normal user. Null when no user.
 */
export function downloadSubjectOf(
    locals: GuardLocals | null | undefined,
): { userId?: string; username?: string; isAdmin: boolean } | null {
    const user = locals?.user;
    if (!user) return null;
    return { userId: user.userId, username: user.username, isAdmin: localsIsAdmin(locals) };
}

/**
 * The user object every download route hands to the library/age access checks
 * (`checkMediaAccess`, `checkMediaAccessBatch`). One helper so the routes cannot
 * disagree: admin is decided by the principal, so an admin on a Quick Connect
 * session or /j API key is a normal user here too.
 */
export function mediaAccessUserOf<U extends { mediaAccessIsAdmin?: boolean }>(
    locals: { user?: U | null; principal?: { isAdmin?: boolean } | null } | null | undefined,
): U | undefined {
    const user = locals?.user;
    if (!user) return undefined;
    return {
        ...user,
        mediaAccessIsAdmin: locals?.principal?.isAdmin ?? user.mediaAccessIsAdmin,
    };
}

export async function downloadForbiddenResponse(
    locals: GuardLocals | null | undefined,
    opts: { kind: 'original' | 'rendition' } = { kind: 'original' },
): Promise<Response | null> {
    // 'rendition' skips the FEATURE_MEDIA_DOWNLOAD switch (renditions have
    // FEATURE_DOWNLOAD_RENDITIONS).
    const check = opts.kind === 'rendition' ? userMayDownload : canDownload;
    const allowed = await check(downloadSubjectOf(locals));
    if (allowed) return null;
    return ApiProblem.forbidden(m.downloads_not_allowed(), { reason: 'downloads_not_allowed' });
}

/**
 * Browser-session download routes are plain GET links, so a cookie-authenticated GET
 * from another site (an <a>, <img> or navigation on a page we do not control) would
 * start a download as the signed-in user. Browsers label that `Sec-Fetch-Site: cross-site`;
 * `same-origin`, `same-site` and `none` (typed URL) pass.
 *
 * A request WITHOUT the header (an old browser, or a client that strips it) is not trusted
 * blindly: it must then prove it is ours through `Origin` or `Referer`, whose host has to
 * match this request's host (the same host comparison as the CSRF guard, so a TLS-terminating
 * proxy does not matter). Neither present, or a foreign one, is refused.
 * Returns the 403 response, or null.
 */
export function crossSiteForbiddenResponse(
    request: Request,
    url: URL = new URL(request.url),
): Response | null {
    const refuse = (): Response =>
        ApiProblem.forbidden(m.downloads_not_allowed(), { reason: 'cross_site_request' });
    const site = request.headers.get('sec-fetch-site');
    if (site !== null) return site === 'cross-site' ? refuse() : null;

    const hostOf = (value: string | null): string | null => {
        if (!value) return null;
        try {
            return new URL(value).host;
        } catch {
            return null;
        }
    };
    const origin = request.headers.get('origin');
    if (origin !== null) return hostOf(origin) === url.host ? null : refuse();
    const referer = request.headers.get('referer');
    if (referer !== null) return hostOf(referer) === url.host ? null : refuse();
    return refuse();
}
