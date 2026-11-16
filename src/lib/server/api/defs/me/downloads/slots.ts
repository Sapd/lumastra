// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/me/downloads/slots[?fileId=<file or rendition id>]
 *
 * The caller's own download slots: `maxParallel` (0 = unlimited) and `inUse` (live
 * slots, counted across devices and replicas). With `fileId`, `started` says whether a
 * download of that file is running or was logged within the last minute.
 *
 * The web queue's link mode cannot observe the browser's download manager, so it asks
 * here before handing over the next link (a free slot?) and afterwards (did the server
 * see it start?), instead of silently losing an episode to a 429.
 *
 * Auth: user, self-only (never a user parameter). Cookie CSRF guard like the other
 * internal download routes. Surface: internal.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { getDb } from '$lib/server/database/connection.js';
import { hasRecentDownloadStart } from '$lib/server/database/queries/download-events.queries.js';
import { crossSiteForbiddenResponse } from '$lib/server/services/download-access-guard.js';
import { listActiveDownloads } from '$lib/server/services/download-leases.js';

/** A download logged within this window counts as "the server saw it start". */
const STARTED_WINDOW_MS = 60_000;

const Query = z.object({ fileId: z.string().min(1).max(100).optional() }).strict();

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    request: { query: Query },
    handlers: {
        GET: async (event, ctx) => {
            const crossSite = crossSiteForbiddenResponse(event.request, event.url);
            if (crossSite) return crossSite;

            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized('Authentication required');

            const mine = (await listActiveDownloads()).filter((d) => d.userId === userId);
            const body: { maxParallel: number; inUse: number; started?: boolean } = {
                maxParallel: Math.max(0, Math.floor(config.DOWNLOAD_MAX_PARALLEL_PER_USER)),
                inUse: mine.length,
            };

            const fileId = ctx.input?.query?.fileId;
            if (fileId) {
                let started = mine.some((d) => d.fileId === fileId);
                if (!started) {
                    const sql = getDb();
                    if (sql) {
                        started = await hasRecentDownloadStart(
                            sql,
                            userId,
                            fileId,
                            new Date(Date.now() - STARTED_WINDOW_MS),
                        );
                    }
                }
                body.started = started;
            }
            return json(body);
        },
    },
});
