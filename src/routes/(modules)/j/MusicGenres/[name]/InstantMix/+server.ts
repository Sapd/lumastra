// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /MusicGenres/{name}/InstantMix — instant mix from a genre, by name.
// Dispatch, pool and paging live in jellyfin-compat/instant-mix.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { handleInstantMix } from '$lib/server/jellyfin-compat/instant-mix';

export const GET: RequestHandler = withJellyfinAuth((event) =>
    handleInstantMix(event, { kind: 'genreName', name: event.params.name ?? '' }),
);
