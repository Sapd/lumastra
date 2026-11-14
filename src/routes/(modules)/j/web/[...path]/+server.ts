// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Jellyfin web-UI deep-link compat for /j/web/*
//
// Jellyfin clients (mobile, TV, web) construct deep links like
//   /j/web/index.html#!/details?id=<uuid>&context=home&serverId=<sid>
// when a user clicks "Play" or shares a link. The fragment after `#` is
// client-side only — the server only sees `/j/web/index.html`.
//
// We serve a tiny HTML page that reads `location.hash` and `location.replace`s
// to the matching Lumastra page (`/watch/<id>`, or the Jellyfin connect modal
// for a Quick Connect code); see redirect-html.ts. A malformed or absent hash
// falls back to `/`.
//
// === AUTH (trusted-proxy only; access enforced at the redirect target) ===
//
// This endpoint is NOT a media-access boundary. It serves a static page that
// reads the client-supplied `#!/details?id=<uuid>` fragment and redirects to
// `/watch/<id>`. The real gate is `/watch/[itemId]` (+page.server.ts), whose
// `load()` requires `locals.user` and runs `isMediaAccessible()` — and that is
// populated by Lumastra's central auth for EVERY login method (Authentik
// forward-auth, native login, and OIDC). Gating this route on forward-auth
// headers (`USERHEADER`/`GROUPHEADER`) would 404 any user who logged in
// natively or via OIDC, since those carry no Authentik headers — exactly the
// "open in media server" link from Jellyseerr breaking for non-forward-auth
// users.
//
// So we require only that the request arrives through the trusted reverse
// proxy (hooks.server.ts bypasses forward-auth for all `/j/*`, so we can't use
// `locals.user` here). A direct-to-container hit from an untrusted peer gets a
// 404 — same response as a missing path, so no path-existence signal leaks.
// The redirect HTML itself leaks nothing: the id comes from the caller's own
// hash and `/watch/<id>` denies access (404) to anyone not entitled to it.
//
// (We do not inspect `params.path` — the handler always returns the same
// static redirect HTML regardless of subpath, so path-traversal is moot.)

import type { RequestHandler } from './$types';
import { isForwardAuthPeerTrusted } from '$lib/server/utils/client-ip';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { base } from '$app/paths';
import { buildDeeplinkRedirectHtml } from './redirect-html';

const REDIRECT_HTML = buildDeeplinkRedirectHtml(base);

function isFromTrustedProxy(event: { getClientAddress: () => string }): boolean {
    // The request is only legitimate when it arrives via the reverse proxy: if
    // TRUSTED_PROXY_IPS is configured and the TCP peer is not in it, the app was
    // reached directly — reject. We deliberately do NOT inspect forward-auth
    // headers: access control belongs to the `/watch/<id>` redirect target,
    // which gates every login method (forward-auth / native / OIDC).
    let peer: string;
    try {
        peer = event.getClientAddress();
    } catch {
        // best-effort/fail-closed: unknowable peer → sentinel that fails the trusted-peer check below.
        peer = '0.0.0.0';
    }
    return isForwardAuthPeerTrusted(peer);
}

export const GET: RequestHandler = (event) => {
    if (!isFromTrustedProxy(event)) {
        // Return 404 (not 401/403) so a direct-to-container probe from an
        // untrusted peer can't confirm the path exists.
        return ApiResponses.notFound('Not Found');
    }
    return new Response(REDIRECT_HTML, {
        headers: {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store, private',
            'X-Robots-Tag': 'noindex',
            'Referrer-Policy': 'no-referrer',
        },
    });
};
