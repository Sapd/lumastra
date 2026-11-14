// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Items/{itemId}/LocalTrailers (UserLibraryController.GetLocalTrailers): the item's
// local trailer files as Trailer items. 404 when the item is unknown or hidden.
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { handleItemExtras } from '$lib/server/jellyfin-compat/related-media';

export const GET: RequestHandler = withJellyfinAuth((event) => handleItemExtras(event, 'trailers'));
