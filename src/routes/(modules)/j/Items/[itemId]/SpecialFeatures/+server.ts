// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Items/{itemId}/SpecialFeatures (UserLibraryController.GetSpecialFeatures): every
// local extra except trailers (featurettes, behind the scenes, deleted scenes, …).
// 404 when the item is unknown or hidden.
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { handleItemExtras } from '$lib/server/jellyfin-compat/related-media';

export const GET: RequestHandler = withJellyfinAuth((event) =>
    handleItemExtras(event, 'special_features'),
);
