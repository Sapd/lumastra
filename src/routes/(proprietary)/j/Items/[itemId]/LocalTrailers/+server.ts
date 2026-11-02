// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Items/{itemId}/LocalTrailers (UserLibraryController.GetLocalTrailers): the item's
// local trailer files as Trailer items. 404 when the item is unknown or hidden.
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleItemExtras } from '$lib/server/proprietary/jellyfin-compat/related-media';

export const GET: RequestHandler = withJellyfinAuth((event) => handleItemExtras(event, 'trailers'));
