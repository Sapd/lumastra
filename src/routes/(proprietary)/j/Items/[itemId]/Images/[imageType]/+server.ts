// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// authz: public — intentional Jellyfin-compat image endpoint (matches upstream Jellyfin unauthenticated images); existence oracle collapsed via default-on-miss

// Jellyfin Compatibility Layer — Item Image Proxy: GET /Items/{itemId}/Images/{imageType}.
// The handler (type mapping, size box, anti-oracle placeholder) is shared with
// the /{imageIndex} variant: item-image-handler.ts.

import type { RequestHandler } from './$types';
import { withErrorHandler } from '$lib/server/middleware/error-handler';
import { handleItemImage } from '$lib/server/proprietary/jellyfin-compat/item-image-handler';

export const GET: RequestHandler = withErrorHandler(async (event) => handleItemImage(event));
