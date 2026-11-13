// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Artists/{itemId}/Similar — artists that sound like this one. The segment is
// `[name]` because it shares its level with `GET /Artists/{name}`; here it is an id.
// Ranking, excludeArtistIds and paging live in jellyfin-compat/music-similar.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleMusicSimilar } from '$lib/server/proprietary/jellyfin-compat/music-similar';

export const GET: RequestHandler = withJellyfinAuth((event) =>
    handleMusicSimilar(event, event.params.name ?? ''),
);
