// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { localsIsAdmin } from '$lib/server/auth/locals-admin';
import type { RequestHandler } from './$types';
import { withJellyfinAuth } from '$lib/server/proprietary/jellyfin-compat/middleware';
import { getParam } from '$lib/server/proprietary/jellyfin-compat/utils';
import { ApiResponses } from '$lib/server/utils/api-responses';
import { getDb } from '$lib/server/database';
import { parseItemIds } from '$lib/server/proprietary/jellyfin-compat/remote-control/protocol';
import {
    remoteSessionId,
    setNowViewing,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/device-registry';
import { resolveControllableTarget } from '$lib/server/proprietary/jellyfin-compat/remote-control/commands';
import {
    badRequest,
    noContent,
} from '$lib/server/proprietary/jellyfin-compat/remote-control/route-helpers';

/**
 * Jellyfin SessionController.ReportViewing — an app reports the item it is
 * showing. Stored on the device record (`sessionId` defaults to the caller's
 * own device). An unknown device or an item id that is not a Guid is a no-op
 * 204, as Jellyfin's in-memory update is for a session without a record.
 */
export const POST: RequestHandler = withJellyfinAuth(
    async (event) => {
        const { url, locals } = event;
        const caller = locals.user;
        if (!caller) return ApiResponses.unauthorized();
        const itemIds = parseItemIds([getParam(url, 'itemId') ?? '']);
        if (!itemIds || itemIds.length !== 1) return badRequest('itemId is required');

        const requested = getParam(url, 'sessionId');
        let targetId: string | null = null;
        if (requested) {
            const sql = getDb();
            if (!sql) return ApiResponses.error('Database unavailable');
            const target = await resolveControllableTarget(sql, requested, {
                userId: caller.userId,
                ownerIsAdmin: localsIsAdmin(locals),
            });
            if (!target) return ApiResponses.notFound('Session not found');
            targetId = target.id;
        } else if (locals.jfDevice?.deviceId) {
            targetId = remoteSessionId(String(caller.userId), locals.jfDevice.deviceId);
        }
        if (targetId) await setNowViewing(targetId, itemIds[0]);
        return noContent();
    },
    { mode: 'write' },
);
