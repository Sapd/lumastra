// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { RouteMetadata } from '$lib/server/openapi';

export const route: RouteMetadata = {
    POST: {
        tags: ['Admin', 'Users', 'Watch State'],
        summary: "Clear a user's pull-log cursor",
        description:
            "Deletes the user's per-provider rows from `watch_state_pull_log` so the next scheduled pull cycle does a full re-fetch from Jellyfin (and any other configured watch-sync provider). Useful when Lumastra's `user_media_state` has drifted from the source of truth — for example after a Jellyfin user unmarked episodes whose `LastPlayedDate` was already older than the cursor. Does not trigger an immediate sync; the regular 5-min cycle picks the change up.",
        responses: {
            200: 'Cursor(s) cleared (or none existed)',
            400: 'Username required',
            401: 'Authentication required',
            403: 'Admin privileges required',
            500: 'Internal server error',
        },
    },
};
