// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Generic user silhouette served when no avatar exists.
//
// This response is intentionally indistinguishable from the response for a
// known user who has no custom avatar — both cases return 200 with this SVG
// so that probing arbitrary UUIDs yields no account-existence signal.
//
// The SVG is a stable byte sequence so CDN/browser ETags are reproducible
// without any runtime hashing.

const DEFAULT_AVATAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40" width="40" height="40">
  <rect width="40" height="40" rx="20" fill="#64748b"/>
  <circle cx="20" cy="15" r="7" fill="#cbd5e1"/>
  <ellipse cx="20" cy="36" rx="13" ry="9" fill="#cbd5e1"/>
</svg>`;

const DEFAULT_AVATAR_BYTES = Buffer.from(DEFAULT_AVATAR_SVG, 'utf-8');

// Stable ETag derived from the literal SVG content (no runtime hashing needed).
const DEFAULT_AVATAR_ETAG = `W/"default-avatar-v1"`;

/**
 * Return a 200 response containing the generic user-silhouette SVG.
 *
 * Pass the incoming `request` to honour If-None-Match conditional-GET;
 * omit it (or pass undefined) to always return a 200 body.
 */
export function defaultAvatarResponse(request?: Request): Response {
    if (request) {
        const ifNoneMatch = request.headers.get('if-none-match');
        if (
            ifNoneMatch &&
            (ifNoneMatch.trim() === DEFAULT_AVATAR_ETAG || ifNoneMatch.trim() === '*')
        ) {
            return new Response(null, {
                status: 304,
                headers: {
                    'Content-Type': 'image/svg+xml',
                    'Cache-Control': 'public, max-age=172800, stale-while-revalidate=86400',
                    ETag: DEFAULT_AVATAR_ETAG,
                    Vary: 'Accept, Save-Data',
                },
            });
        }
    }

    return new Response(new Uint8Array(DEFAULT_AVATAR_BYTES), {
        status: 200,
        headers: {
            'Content-Type': 'image/svg+xml',
            'Cache-Control': 'public, max-age=172800, stale-while-revalidate=86400',
            ETag: DEFAULT_AVATAR_ETAG,
            Vary: 'Accept, Save-Data',
        },
    });
}

/**
 * The answer an unauthenticated caller gets on a surface that serves real
 * avatars to signed-in callers only (/j user images): the generic silhouette,
 * for every id. Unlike {@link defaultAvatarResponse} it is not shareable: the
 * same URL answers differently once the caller sends a token, so a shared
 * cache must not keep the silhouette for signed-in viewers.
 */
export function anonymousAvatarResponse(request?: Request): Response {
    const res = defaultAvatarResponse(request);
    res.headers.set('Cache-Control', 'private, max-age=300');
    res.headers.set(
        'Vary',
        'Accept, Save-Data, Authorization, X-Emby-Authorization, X-Emby-Token, X-MediaBrowser-Token',
    );
    return res;
}
