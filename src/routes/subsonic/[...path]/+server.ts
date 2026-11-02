// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Catch-all 404 for unmatched /subsonic/* paths.
//
// /subsonic/* is reachable without forward auth (clients carry credentials as
// query params on every /subsonic/rest request, validated by the dispatcher).
// Anything outside /subsonic/rest/* is unauthenticated and would otherwise
// render SvelteKit's HTML error page, leaking the app shell. Plain JSON 404
// prevents the leak.
//
// The on-spec dispatcher at /subsonic/rest/[...path] still handles all real
// Subsonic clients; this only catches unknown sibling paths.

import type { RequestHandler } from './$types';

const NOT_FOUND_BODY = JSON.stringify({ error: 'Not Found' });
const HEADERS = { 'Content-Type': 'application/json' };

export const fallback: RequestHandler = () =>
    new Response(NOT_FOUND_BODY, { status: 404, headers: HEADERS });
