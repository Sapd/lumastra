// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Items/{itemId}/InstantMix — instant mix from any item.
// Dispatch, pool and paging live in jellyfin-compat/instant-mix.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { handleInstantMix } from '$lib/server/jellyfin-compat/instant-mix';

export const GET: RequestHandler = withJellyfinAuth((event) =>
    handleInstantMix(event, { kind: 'item', id: event.params.itemId ?? '' }),
);
