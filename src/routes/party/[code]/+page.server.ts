// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Party Join Page - Server Load
 * GET /party/[code]
 *
 * Loads session data for the join page
 */

import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { features } from '$lib/server/config';
import { getDb } from '$lib/server/database/connection.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { checkRateLimit } from '$lib/server/middleware/valkey-rate-limit.js';
import { toPublicParty } from '$lib/server/services/watch-together-public';
import { getSession } from '$lib/server/services/watch-together.service';
import {
    JOIN_RATE_LIMIT_MAX,
    JOIN_RATE_LIMIT_WINDOW_S,
} from '$lib/server/api/defs/watch-together/[code]/join-rate-limit.js';

const NOT_FOUND = 'Watch party not found or has ended';

/**
 * Held to the same rules as the two join endpoints: the feature flag, the
 * viewer's access to the party's item (a party for an item they may not see
 * looks exactly like a party that does not exist), and the per-user join budget
 * for misses, so the page cannot be used to sweep the code space for live
 * parties. A hit is not charged: following an invite link and then joining
 * must not spend the budget twice. Found in the 2026-10-07 entry-point review.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
    if (!features.watchTogether) {
        throw error(404, 'Not found');
    }

    const user = locals.user;
    if (!user?.userId) {
        throw error(401, 'Authentication required');
    }

    const { code } = params;
    if (!code) {
        throw error(400, 'Session code required');
    }

    const session = await getSession(code);
    const visible = session !== null && (await viewerMaySee(session.itemId, user));

    if (!session || !visible) {
        const rl = await checkRateLimit(
            `wt-join:${user.userId}`,
            JOIN_RATE_LIMIT_MAX,
            JOIN_RATE_LIMIT_WINDOW_S,
        );
        if (!rl.allowed) throw error(429, 'Too many attempts. Try again in a minute.');
        throw error(404, NOT_FOUND);
    }

    const party = await toPublicParty(session, 'internal');
    return {
        party: {
            code: session.code,
            title: session.title,
            mediaType: session.mediaType,
            itemId: session.itemId,
            fileId: session.fileId,
            host: party.host,
            participantCount: session.participants.length,
            visibility: session.visibility ?? 'unlisted',
        },
        userId: user.userId,
    };
};

/** Fail-closed media access, as the join paths apply it (`participantMayAccess`). */
async function viewerMaySee(
    itemId: string | undefined,
    user: NonNullable<App.Locals['user']>,
): Promise<boolean> {
    if (!itemId) return true;
    try {
        const db = getDb();
        if (!db) return false;
        return await checkMediaAccess(db, itemId, user);
    } catch {
        return false;
    }
}
