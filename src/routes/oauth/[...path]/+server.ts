// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// Catch-all 404 for unmatched /oauth/* paths.
//
// /oauth/* is reachable without forward auth (handleOAuthRoute in
// forward-auth.ts only checks features.deviceAuth before passing through),
// so unmatched paths would otherwise render SvelteKit's HTML error page
// to unauthenticated callers. Plain JSON 404 prevents the leak.

import type { RequestHandler } from './$types';

const NOT_FOUND_BODY = JSON.stringify({ error: 'Not Found' });
const HEADERS = { 'Content-Type': 'application/json' };

export const fallback: RequestHandler = () =>
    new Response(NOT_FOUND_BODY, { status: 404, headers: HEADERS });
