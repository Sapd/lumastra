// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * defs/admin/playback-plans/[planId]/index.ts
 *
 * GET /api/admin/playback-plans/[planId]
 *
 * Returns the PlaybackPlan stored in Valkey at session-start time.
 * Returns { plan: null, expired: true } when the plan has expired (Valkey TTL
 * elapsed) or the planId never existed — the modal renders an "expired" state
 * in either case rather than 404, so the admin still sees the planId they
 * clicked and can copy it for offline diagnosis.
 *
 * Auth: admin (playback:read scope for token-based callers).
 * Surface: internal-only.
 */

import { z } from 'zod';
import { json } from '@sveltejs/kit';
import { defineEndpoint } from '$lib/server/api/define.js';
import { playbackPlanner } from '$lib/server/services/playback-planner.service.js';
import { AdminPlaybackPlanResponseSchema } from '$lib/schemas/api-admin-responses.js';

export const def = defineEndpoint({
    auth: { kind: 'admin' },
    visibility: 'internal',
    request: {
        params: z.object({ planId: z.string().min(1) }),
    },
    handlers: {
        GET: async (_event, ctx) => {
            const { planId } = ctx.input!.params!;

            const plan = await playbackPlanner.getPlan(planId);
            return json(AdminPlaybackPlanResponseSchema.parse({ plan, expired: plan === null }));
        },
    },
});
