// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';

export const GET: RequestHandler = withJellyfinAuth(async () => {
    return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
});
