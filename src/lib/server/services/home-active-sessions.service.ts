// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import {
    SessionsResponseSchema,
    type SessionsResponse,
} from '$lib/schemas/api-playback-responses.js';
import { toPublicMediaType } from '$lib/shared/media-type-domain.js';
import { localsIsAdmin } from '$lib/server/auth/locals-admin.js';
import { config } from '$lib/server/config.js';
import { denyAllAccess } from '$lib/server/database/queries/builders/media-access-boundary.js';
import { getDb } from '$lib/server/database/connection.js';
import {
    resolveViewerMetadataLanguages,
    type ResolvedMetadataLanguages,
} from '$lib/server/utils/metadata-language-resolve.js';
import {
    buildSearchAccessContext,
    searchAccessBoundary,
} from '$lib/server/utils/search-access-context.js';
import { isWidgetDisabled } from '$lib/server/utils/widget-guard.js';
import { getVisibleActiveSessions } from './active-sessions-view.service.js';

/** Shared home-widget loader and serializer for SSR and polling. */
export async function getHomeActiveSessions(
    locals: App.Locals,
    metadataLangs?: ResolvedMetadataLanguages,
): Promise<SessionsResponse> {
    if (!config.FEATURE_SESSIONS || isWidgetDisabled('streaming-sessions')) {
        return { sessions: [], cacheTimestamp: Date.now() };
    }

    // Same boundary search and the home rows use (library groups + age ceiling).
    // Fails closed: no user or no database means no access to other users' rows.
    const sql = getDb();
    const access =
        locals.user && sql
            ? searchAccessBoundary(await buildSearchAccessContext(sql, locals.user))
            : denyAllAccess();

    const result = await getVisibleActiveSessions({
        access,
        userId: locals.user?.userId,
        username: locals.user?.username,
        userGroups: locals.user?.userGroups ?? [],
        isAdmin: localsIsAdmin(locals),
        hasWatchPermission: locals.user?.hasWatchPermission ?? false,
        hasLiveTvPermission: locals.user?.hasLiveTvPermission ?? false,
        metadataLangs:
            metadataLangs ?? (await resolveViewerMetadataLanguages(getDb(), locals.user?.userId)),
    });

    // Keep the full enriched session, including paused/external streams. Both
    // transports use this schema, rather than rebuilding cards from the compact
    // playback-management DTO (which lacks artwork and music/codec metadata).
    return SessionsResponseSchema.parse({
        sessions: result.visible
            ? result.sessions.map((session) => ({
                  ...session,
                  // Read-model rows still use storage vocabulary (e.g. tv).
                  mediaType: toPublicMediaType(session.mediaType) ?? session.mediaType,
              }))
            : [],
        cacheTimestamp: result.cacheTimestamp,
    });
}
