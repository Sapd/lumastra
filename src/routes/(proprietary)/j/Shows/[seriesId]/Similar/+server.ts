// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Shows/{itemId}/Similar — an alias Jellyfin's LibraryController.GetSimilarItems
// answers exactly like /Items/{itemId}/Similar. The segment is [seriesId] because
// Shows/{seriesId}/Episodes and /Seasons already own this level.
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleSimilarItems } from '$lib/server/proprietary/jellyfin-compat/similar-items-handler';

export const GET: RequestHandler = withJellyfinAuth((event) =>
    handleSimilarItems(event, event.params.seriesId),
);
