// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleItemsRequest } from '$lib/server/proprietary/jellyfin-compat/items-handler';

/** Jellyfin ItemsController.GetItems — shared with `/Users/{userId}/Items`. */
export const GET: RequestHandler = withJellyfinAuth((event) => handleItemsRequest(event));
