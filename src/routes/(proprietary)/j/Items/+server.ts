// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleItemsRequest } from '$lib/server/proprietary/jellyfin-compat/items-handler';

/** Jellyfin ItemsController.GetItems — shared with `/Users/{userId}/Items`. */
export const GET: RequestHandler = withJellyfinAuth((event) => handleItemsRequest(event));
