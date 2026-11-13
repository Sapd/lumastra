// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';

/**
 * POST /LiveStreams/Close?liveStreamId= → 204.
 *
 * A no-op: the live HLS route keeps a viewer alive only while its playlist is
 * polled, and the proxy's orphan sweep releases the source slot once the
 * client stops. Revoking the play token here would cut off a client that
 * closes the handle but keeps the player running.
 */
export const POST: RequestHandler = withJellyfinAuth(
    async () => new Response(null, { status: 204 }),
    { mode: 'write' },
);
