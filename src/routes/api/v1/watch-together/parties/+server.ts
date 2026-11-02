// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Watch Together Public API - List Sessions
 * GET /api/v1/watch-together/parties - Get all public sessions
 *
 * Applies the same media-access boundary (library-group + age-rating) as the
 * SPA-internal /api/watch-together/parties handler so callers cannot discover
 * sessions for media they are not permitted to see.
 */

import { config } from '$lib/server/config.js';
import type { RequestHandler } from './$types';
import { getAllSessions } from '$lib/server/services/watch-together.service';
import type { PublicParty } from '$lib/types/api-watch-together';
import { Logger } from '$lib/server/utils/logger';
import { problem } from '$lib/server/api/problem';
import { isWidgetDisabled, createDisabledWidgetResponse } from '$lib/server/utils/widget-guard.js';
import { entityImageUrl } from '$lib/shared/api-urls';
import { getDb } from '$lib/server/database';
import {
    filterSessionsByAccess,
    resolveWatchTogetherBoundary,
} from '$lib/server/utils/watch-together-access';

import { toPublicParties } from '$lib/server/services/watch-together-public';

const logger = Logger.for('PublicAPI:WatchTogether:Sessions');

/** Public session fields plus device counts and artwork. */
type PublicPartyListItem = PublicParty & {
    posterUrl: string;
    uniqueParticipants: number;
};

/**
 * Count unique users in a session (same user on multiple devices counts as 1)
 */
function getUniqueUserCount(participants: { userId: string }[]): number {
    return new Set(participants.map((p) => p.userId)).size;
}

/**
 * GET /api/v1/watch-together/parties
 * Get all public watch together sessions
 */
export const GET: RequestHandler = async ({ url, locals }) => {
    if (!config.FEATURE_WATCH_TOGETHER) {
        return problem('not_found', { error: 'Feature not available' });
    }

    if (isWidgetDisabled('watch-parties')) {
        return createDisabledWidgetResponse();
    }

    if (!locals.user?.username) {
        return problem('unauthorized', { error: 'Authentication required' });
    }

    try {
        const includePrivate = url.searchParams.get('includePrivate') === 'true';

        // Only admins can see private sessions
        const publicOnly = !(includePrivate && locals.principal?.isAdmin === true);

        const rawSessions = await getAllSessions(publicOnly);

        // Apply the same media-access boundary used by /api/watch-together/parties,
        // via the SHARED implementation, so callers cannot discover sessions for
        // media they are not allowed to see and the two copies cannot drift.
        //
        // `publicOnly` above is an orthogonal visibility axis (session privacy).
        // An admin passing includePrivate=true bypasses session privacy but still
        // gets the media boundary applied here — the two must not be conflated.
        const sql = getDb();
        const boundary = await resolveWatchTogetherBoundary(sql, locals.user);
        const visibleSessions = await filterSessionsByAccess(sql, rawSessions, boundary);

        // Map to public session format with uniqueParticipants
        const parties = await toPublicParties(visibleSessions, 'v1');
        const items: PublicPartyListItem[] = parties.map((session) => ({
            code: session.code,
            host: session.host,
            visibility: session.visibility,
            title: session.title,
            mediaType: session.mediaType,
            posterUrl: session.posterUrl || entityImageUrl(session.itemId, 'poster', 'v1'),
            participantCount: session.participants.length,
            uniqueParticipants: getUniqueUserCount(session.participants),
            isPlaying: session.isPlaying,
            createdAt: session.createdAt,
        }));

        return Response.json({
            items,
            page: { limit: items.length, offset: 0, hasMore: false, total: items.length },
        });
    } catch (err) {
        logger.error('Get all sessions error', err as Error);
        return problem('internal_error', { error: 'Failed to get sessions' });
    }
};

import { mount as mountCreate } from '$lib/server/api/mount.js';
import { def as createDef } from '$lib/server/api/defs/watch-together/parties-create.js';

export const { POST } = mountCreate(createDef, { surface: 'v1' });
