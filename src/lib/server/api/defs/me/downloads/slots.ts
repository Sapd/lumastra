// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/me/downloads/slots[?h=<hand-off nonce>]
 *
 * The caller's own download slots: `maxParallel` (0 = unlimited) and `inUse` (live
 * slots, counted across devices and replicas). With `h`, `started` says whether the
 * download the queue handed over with THAT nonce reached the server (see
 * services/download-handoff.ts): another device's download of the same file cannot confirm it.
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
import { handoffSeen, parseHandoffNonce } from '$lib/server/services/download-handoff.js';
import { crossSiteForbiddenResponse } from '$lib/server/services/download-access-guard.js';
import { listActiveDownloads } from '$lib/server/services/download-leases.js';

const Query = z.object({ h: z.string().max(100).optional() }).strict();

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

            const nonce = parseHandoffNonce(ctx.input?.query?.h);
            if (nonce) body.started = await handoffSeen(userId, nonce);
            return json(body);
        },
    },
});
