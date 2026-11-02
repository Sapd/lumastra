// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getDb } from '$lib/server/database';
import { getCachedGuideEndDate } from '$lib/server/proprietary/jellyfin-compat/livetv-guide-end';
import { hasLiveTvPermission } from '$lib/server/proprietary/jellyfin-compat/utils';

const logger = Logger.for('JellyfinCompat:LiveTv:GuideInfo');

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * GET /LiveTv/GuideInfo → GuideInfo { StartDate, EndDate }.
 *
 * Jellyfin answers "now" to "now + configured guide days"; clients use it to
 * bound how far the guide scrolls. Here the end is where the imported EPG
 * actually ends, so the guide never offers empty days. With no future
 * listings (no EPG source, or a stale import) it falls back to one day ahead,
 * the window the guide routes serve by default.
 *
 * 404 without Live TV permission, just like an unconfigured source:
 * there is no empty form of this DTO to hand out instead.
 */
export const GET: RequestHandler = withJellyfinAuth(async ({ locals }) => {
    if (!hasLiveTvPermission(locals.user)) {
        return ApiResponses.notFound();
    }

    const now = new Date();
    try {
        const sql = getDb();
        const epgEnd = sql ? await getCachedGuideEndDate(sql) : null;
        const end =
            epgEnd && epgEnd.getTime() > now.getTime() ? epgEnd : new Date(now.getTime() + DAY_MS);
        return json({ StartDate: now.toISOString(), EndDate: end.toISOString() });
    } catch (error) {
        logger.error('LiveTv/GuideInfo GET failed', error as Error);
        return ApiResponses.error('Failed to fetch guide info');
    }
});
