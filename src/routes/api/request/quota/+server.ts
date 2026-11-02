// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/request/quota — user request quota (internal BFF surface).
 *
 * Preserves the legacy response shape expected by the SPA:
 *   { quota: { movie: {...}, tv: {...} } | null, linked?: bool }
 *
 * Note: the v1 surface at GET /api/v1/requests/quota uses `series` instead of
 * `tv` (canonical discriminator). The legacy BFF uses `tv` to match the SPA's
 * RequestQuotaResponseSchema and component bindings (quota.tv / quota.movie).
 *
 * Auth: user. Rate-limit: STANDARD (100 / 60 s).
 */

import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { mount } from '$lib/server/api/mount.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { config } from '$lib/server/config.js';
import { getEffectiveUser } from '$lib/server/dev-user.js';
import { jellyseerrClient } from '$lib/server/jellyseerr.js';

const def = defineEndpoint({
    auth: { kind: 'user' },
    rateLimit: { limit: 100, windowSec: 60 },
    visibility: 'internal',
    handlers: {
        GET: async (event, _ctx) => {
            const effectiveUsername = getEffectiveUser(
                event.request,
                event.locals.user?.username || config.DEFAULT_USER,
            );

            // Resolve the link first so "not linked" is a distinct, non-leaky signal
            // rather than being conflated with a service outage.
            const link = await jellyseerrClient.resolveUserLink(effectiveUsername);
            if (link.state === 'unavailable') {
                // Dependency down → 503, never 200 with null quota
                return ApiProblem.dependencyUnavailable('Jellyseerr is not reachable');
            }
            if (link.state === 'not_linked') {
                return json({ quota: null, linked: false });
            }

            try {
                const quota = await jellyseerrClient.getUserQuota(link.user.id);
                if (!quota) {
                    // Reachable + linked, but quota lookup failed (transient)
                    return json({ quota: null });
                }

                // Legacy BFF shape: { quota: { movie, tv }, linked }
                // Note: uses `tv` key (not `series`) to match the SPA's schema bindings.
                return json({
                    quota: {
                        movie: {
                            limit: quota.movie.limit,
                            used: quota.movie.used,
                            remaining: quota.movie.limit === 0 ? null : quota.movie.remaining,
                            days: quota.movie.days,
                            restricted: quota.movie.restricted,
                        },
                        tv: {
                            limit: quota.tv.limit,
                            used: quota.tv.used,
                            remaining: quota.tv.limit === 0 ? null : quota.tv.remaining,
                            days: quota.tv.days,
                            restricted: quota.tv.restricted,
                        },
                    },
                    linked: true,
                });
            } catch {
                return ApiProblem.internalError('Failed to fetch request quota');
            }
        },
    },
});

export const { GET } = mount(def, { surface: 'internal' });
