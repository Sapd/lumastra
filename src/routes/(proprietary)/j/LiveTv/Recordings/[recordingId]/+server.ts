// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';

// Lumastra has no DVR, so no recording exists to return. An explicit 404 (as
// Jellyfin answers for an unknown id) rather than an unmatched-route warning.
export const GET: RequestHandler = withJellyfinAuth(async () =>
    ApiResponses.notFound('Recording not found'),
);
