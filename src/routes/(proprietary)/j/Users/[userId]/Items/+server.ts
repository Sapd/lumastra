// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleItemsRequest } from '$lib/server/proprietary/jellyfin-compat/items-handler';

/**
 * Legacy `GET /Users/{userId}/Items` (dropped from the Jellyfin spec in 10.9,
 * still used by older Infuse builds and Kodi add-ons). Same implementation as
 * `/Items`; the user comes from the session, never from the path.
 */
export const GET: RequestHandler = withJellyfinAuth((event) =>
    handleItemsRequest(event, { legacyUserRoute: true }),
);
