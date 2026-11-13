// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// authz: public — intentional Jellyfin-compat image endpoint (matches upstream Jellyfin unauthenticated images); existence oracle collapsed via default-on-miss

// Jellyfin Compatibility Layer — Item Image Proxy: GET /Items/{itemId}/Images/{imageType}.
// The handler (type mapping, size box, anti-oracle placeholder) is shared with
// the /{imageIndex} variant: item-image-handler.ts.

import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { handleItemImage } from '$lib/server/proprietary/jellyfin-compat/item-image-handler';

export const GET: RequestHandler = withErrorHandler(async (event) => handleItemImage(event));
