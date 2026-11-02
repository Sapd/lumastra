// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Albums/{itemId}/Similar — albums that sound like this one.
// Ranking, excludeArtistIds and paging live in jellyfin-compat/music-similar.ts.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleMusicSimilar } from '$lib/server/proprietary/jellyfin-compat/music-similar';

export const GET: RequestHandler = withJellyfinAuth((event) =>
    handleMusicSimilar(event, event.params.itemId ?? ''),
);
