// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET/POST /System/Ping — plain-text reachability check, unauthenticated
 * (same posture as System/Endpoint). Real Jellyfin servers return the
 * literal string "Jellyfin Server", not JSON — clients that call this
 * (e.g. Moonfin) check for that exact body/200, not a schema.
 */

import type { RequestHandler } from './$types';

const PING_BODY = 'Jellyfin Server';

const respond: RequestHandler = async () =>
    new Response(PING_BODY, { headers: { 'Content-Type': 'text/plain' } });

export const GET = respond;
export const POST = respond;
