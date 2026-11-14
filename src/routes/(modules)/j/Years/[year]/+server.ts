// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /Years/{year} (Jellyfin YearsController.GetYear) — one Year item.
 *
 * Jellyfin answers any year; here a year with no item the user can see is a
 * 404, the same answer an inaccessible item gets everywhere else on /j, so the
 * lookup says nothing about items outside the user's libraries or age limit.
 * A non-numeric year is a 400 (Jellyfin's int route binding).
 */

import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { getDb } from '$lib/server/database';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { buildJellyfinAccessContext } from '$lib/server/jellyfin-compat/access-context';
import { getDistinctYears } from '$lib/server/database/queries/jellyfin-years.queries';
import { parseYear, serializeYear } from '$lib/server/jellyfin-compat/years';
import { jellyfinBadRequest } from '$lib/server/jellyfin-compat/bad-request';

const logger = Logger.for('JellyfinCompat:Years');

export const GET: RequestHandler = withJellyfinAuth(async ({ params, locals }) => {
    const year = parseYear(params.year);
    if (year === null) return jellyfinBadRequest('Year must be a number');

    const sql = getDb();
    if (!sql) return ApiResponses.error('Database unavailable');

    try {
        const access = await buildJellyfinAccessContext(sql, locals.user);
        const [found] = await getDistinctYears(sql, {
            parentId: null,
            mediaTypes: [],
            excludeMediaTypes: [],
            year,
            access: access.boundary,
        });
        if (!found) return ApiResponses.notFound('Year not found');
        return json(serializeYear(found.year, found.itemCount));
    } catch (err) {
        logger.error('Year lookup failed', err as Error, { year });
        return ApiResponses.error('Failed to get year');
    }
});
