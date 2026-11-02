// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// POST|DELETE /UserItems/[itemId]/Rating — thumbs up/down; see jellyfin-compat/rating-route.ts.

import type { RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleItemRating } from '$lib/server/proprietary/jellyfin-compat/rating-route';

export const POST: RequestHandler = withJellyfinAuth((event) => handleItemRating(event, false), {
    pat: 'deny',
    mode: 'write',
});
export const DELETE: RequestHandler = withJellyfinAuth((event) => handleItemRating(event, true), {
    pat: 'deny',
    mode: 'write',
});
