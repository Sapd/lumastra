// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Catch-all 404 for unmatched /j/* paths.
//
// Without this, unmatched /j/* requests fall through to SvelteKit's default
// HTML error page, which renders the full Lumastra app shell to unauthenticated
// callers. The /j/* prefix is self-authenticated (X-Emby-Authorization) and
// reachable without forward auth, so probes from anywhere on the public
// internet would otherwise expose app branding/structure.
//
// Returns the Jellyfin-style 404 envelope so compatible clients see a
// well-formed response from the compat layer.

import type { RequestHandler } from './$types';
import { recordUnknownRoute } from '$lib/server/proprietary/jellyfin-compat/unknown-route-log.js';

const NOT_FOUND_BODY = JSON.stringify({ Status: 'NotFound' });
const HEADERS = { 'Content-Type': 'application/json' };

export const fallback: RequestHandler = ({ request, url }) => {
    // Fire-and-forget: learn which endpoints real apps need. Never throws.
    try {
        recordUnknownRoute(request, url.pathname);
    } catch {
        // never affect the 404
    }
    return new Response(NOT_FOUND_BODY, { status: 404, headers: HEADERS });
};
