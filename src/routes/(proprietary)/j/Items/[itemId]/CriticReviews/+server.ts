// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// GET /Items/{itemId}/CriticReviews — removed from Jellyfin (10.9) but still called by
// older clients; Jellyfin always answered an empty BaseItemDtoQueryResult.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';

export const GET: RequestHandler = withJellyfinAuth(async () =>
    json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
);
