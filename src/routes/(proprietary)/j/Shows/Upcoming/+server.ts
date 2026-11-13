// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from '@sveltejs/kit';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';

// Jellyfin "Upcoming" = not-yet-aired episodes. We don't track air dates,
// so return empty — the client row simply won't render.
export const GET: RequestHandler = withJellyfinAuth(async () => {
    return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
});
