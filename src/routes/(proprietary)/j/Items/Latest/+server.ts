// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { handleLatestRequest } from '$lib/server/proprietary/jellyfin-compat/latest-handler';

/** Jellyfin UserLibraryController.GetLatestMedia — shared with `/Users/{userId}/Items/Latest`. */
export const GET: RequestHandler = withJellyfinAuth((event) => handleLatestRequest(event));
