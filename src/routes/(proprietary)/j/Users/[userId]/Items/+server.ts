// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

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
