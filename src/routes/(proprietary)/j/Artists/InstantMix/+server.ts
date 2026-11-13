// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Artists/InstantMix?id= — legacy query-string form of Artists/{itemId}/InstantMix.
// Dispatch, pool and paging live in jellyfin-compat/instant-mix.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleInstantMix } from '$lib/server/proprietary/jellyfin-compat/instant-mix';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';

export const GET: RequestHandler = withJellyfinAuth((event) => {
    const id = getParam(event.url, 'Id');
    return handleInstantMix(event, id ? { kind: 'item', id } : null);
});
