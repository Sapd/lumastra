// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { localsIsAdmin } from '$lib/server/auth/locals-admin';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/jellyfin-compat/middleware';
import { badRequest } from '$lib/server/jellyfin-compat/remote-control/route-helpers';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { Logger } from '$lib/server/utils/logger';
import { getParam } from '$lib/server/jellyfin-compat/utils';
import { buildSessionList } from '$lib/server/jellyfin-compat/remote-control/sessions-list';
import { parseOptionalInt } from '$lib/server/jellyfin-compat/remote-control/protocol';
import { aiDbService } from '$lib/server/services/database.service';

const logger = Logger.for('JellyfinCompat:Sessions');

export const GET: RequestHandler = withJellyfinAuth(async (event) => {
    const { locals, url } = event;
    if (!locals.user) return ApiResponses.unauthorized();

    const activeWithinSeconds = parseOptionalInt(getParam(url, 'activeWithinSeconds'));
    if (activeWithinSeconds === null) {
        return badRequest('activeWithinSeconds must be an integer');
    }

    try {
        const sql = await aiDbService.getSql();
        if (!sql) return ApiResponses.error('Database unavailable');

        const sessions = await buildSessionList(
            sql,
            { userId: locals.user.userId, ownerIsAdmin: localsIsAdmin(locals) },
            {
                deviceId: getParam(url, 'deviceId'),
                controllableByUserId: getParam(url, 'controllableByUserId'),
                activeWithinSeconds,
            },
        );
        return json(sessions);
    } catch (err) {
        logger.error('Failed to build sessions list', err as Error);
        return ApiResponses.error('Failed to build sessions list');
    }
});
