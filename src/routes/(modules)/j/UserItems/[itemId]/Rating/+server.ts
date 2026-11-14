// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// POST|DELETE /UserItems/[itemId]/Rating — thumbs up/down; see jellyfin-compat/rating-route.ts.

import type { RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { handleItemRating } from '$lib/server/jellyfin-compat/rating-route';

export const POST: RequestHandler = withJellyfinAuth((event) => handleItemRating(event, false), {
    pat: 'deny',
    mode: 'write',
});
export const DELETE: RequestHandler = withJellyfinAuth((event) => handleItemRating(event, true), {
    pat: 'deny',
    mode: 'write',
});
