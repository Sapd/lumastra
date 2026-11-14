// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// GET /Items/{itemId}/CriticReviews — removed from Jellyfin (10.9) but still called by
// older clients; Jellyfin always answered an empty BaseItemDtoQueryResult.
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';

export const GET: RequestHandler = withJellyfinAuth(async () =>
    json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
);
