// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /api/for-you/section-order
 *
 * Ranked per-user render order for the long-tail For-You carousel sections
 * (M3, flag-gated by FEATURE_FORYOU_SECTION_RANKER — see
 * `features.forYouSectionRanker` in config.ts). The curated/fixed-position
 * rails (watching strip, mood, featured-pick, fulfilled-requests) are NOT
 * part of this order and are never reordered.
 *
 * When the flag is OFF, returns FORYOU_LONG_TAIL_ORDER unchanged — the
 * client's reorder step is then a no-op, matching pre-ranker behavior
 * exactly.
 *
 * When ON, reorders that same canonical list by the user's accumulated
 * section-feedback engagement via `computeSectionOrder()`.
 *
 * Response: { order: string[] }
 */

import { json } from '@sveltejs/kit';
import type postgres from 'postgres';
import { defineEndpoint } from '$lib/server/api/define.js';
import { ApiProblem } from '$lib/server/api/problem.js';
import { features } from '$lib/server/config.js';
import { FORYOU_LONG_TAIL_ORDER } from '$lib/shared/feed-section-kinds.js';
import { getFeedback } from '$lib/server/database/queries/user-section-feedback.queries.js';
import { computeSectionOrder } from '$lib/server/services/section-ranker.js';
import type { UserId } from '$lib/shared/user-id.js';

/**
 * Compose the ranked long-tail section order for a user. Exported so
 * integration tests can exercise the exact flag→feedback→ranker wiring the
 * GET handler runs, without mounting the endpoint over HTTP — mirrors
 * `getTasteRailPage` in `defs/for-you/taste.ts`.
 *
 * Returns `FORYOU_LONG_TAIL_ORDER` unchanged when the ranker flag is off.
 */
export async function getRankedSectionOrder(sql: postgres.Sql, userId: UserId): Promise<string[]> {
    if (!features.forYouSectionRanker) {
        return [...FORYOU_LONG_TAIL_ORDER];
    }
    const feedback = await getFeedback(sql, userId);
    return computeSectionOrder(feedback, [...FORYOU_LONG_TAIL_ORDER]);
}

export const def = defineEndpoint({
    auth: { kind: 'user' },
    visibility: 'internal',
    handlers: {
        GET: async (event) => {
            const userId = event.locals.user?.userId;
            if (!userId) return ApiProblem.unauthorized();

            if (!features.forYouSectionRanker) {
                return json({ order: [...FORYOU_LONG_TAIL_ORDER] });
            }

            const { getDb } = await import('$lib/server/database/connection.js');
            const sql = getDb();
            if (!sql) return ApiProblem.dependencyUnavailable('Database not available');

            const order = await getRankedSectionOrder(sql, userId);
            return json({ order });
        },
    },
});
