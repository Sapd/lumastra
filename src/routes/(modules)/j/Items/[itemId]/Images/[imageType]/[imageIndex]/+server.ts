// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// authz: public — intentional Jellyfin-compat image endpoint (matches upstream Jellyfin unauthenticated images); existence oracle collapsed via default-on-miss

// Jellyfin Compatibility Layer — GET /Items/{itemId}/Images/{imageType}/{imageIndex}.
// jellyfin-web asks for backdrops as `/Images/Backdrop/0`. Lumastra keeps one
// image per type, so index 0 is the image and any other index is a 404
// (item-image-handler.ts). Chapter images keep their own static route.

import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { handleItemImage } from '$lib/server/jellyfin-compat/item-image-handler';

export const GET: RequestHandler = withErrorHandler(async (event) => handleItemImage(event));
