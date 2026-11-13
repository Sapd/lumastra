// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';

// Lumastra has no DVR: answer with the empty QueryResult Jellyfin returns when
// nothing has been recorded or scheduled, so DVR screens render empty instead
// of failing on a 404. No permission check is needed: nothing is returned.
export const GET: RequestHandler = withJellyfinAuth(async () =>
    json({ Items: [], TotalRecordCount: 0, StartIndex: 0 }),
);
