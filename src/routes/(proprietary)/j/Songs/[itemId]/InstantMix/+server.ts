// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Songs/{itemId}/InstantMix — instant mix from a song.
// Dispatch, pool and paging live in jellyfin-compat/instant-mix.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleInstantMix } from '$lib/server/proprietary/jellyfin-compat/instant-mix';

export const GET: RequestHandler = withJellyfinAuth((event) =>
    handleInstantMix(event, { kind: 'item', id: event.params.itemId ?? '' }),
);
