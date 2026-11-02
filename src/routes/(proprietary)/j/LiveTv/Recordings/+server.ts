// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';

export const GET: RequestHandler = withJellyfinAuth(async ({ locals }) => {
    // Gate LiveTV metadata on permission
    if (!locals.user?.hasLiveTvPermission) {
        return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
    }

    return json({ Items: [], TotalRecordCount: 0, StartIndex: 0 });
});
