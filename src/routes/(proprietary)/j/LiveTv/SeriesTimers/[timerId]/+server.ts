// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';

// Lumastra has no DVR, so no series timer exists to return. An explicit 404 (as
// Jellyfin answers for an unknown id) rather than an unmatched-route warning.
export const GET: RequestHandler = withJellyfinAuth(async () =>
    ApiResponses.notFound('Series timer not found'),
);
