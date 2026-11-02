// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /MusicGenres/InstantMix?id= — instant mix from a music genre Id (or any item Id,
// which Jellyfin also accepts here).
// Dispatch, pool and paging live in jellyfin-compat/instant-mix.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleInstantMix } from '$lib/server/proprietary/jellyfin-compat/instant-mix';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';

export const GET: RequestHandler = withJellyfinAuth((event) => {
    const id = getParam(event.url, 'Id');
    return handleInstantMix(event, id ? { kind: 'item', id } : null);
});
