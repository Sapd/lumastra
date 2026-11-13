// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Artists/{itemId}/InstantMix — instant mix from an artist. The segment is
// `[name]` because it shares its level with `GET /Artists/{name}`; here it is an id.
// Dispatch, pool and paging live in jellyfin-compat/instant-mix.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleInstantMix } from '$lib/server/proprietary/jellyfin-compat/instant-mix';

export const GET: RequestHandler = withJellyfinAuth((event) =>
    handleInstantMix(event, { kind: 'item', id: event.params.name ?? '' }),
);
