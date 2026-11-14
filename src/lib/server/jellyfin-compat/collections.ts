// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { ApiResponses } from '$lib/server/utils/api-responses';

/**
 * Jellyfin collections (BoxSets) have no Lumastra counterpart: there is no
 * user-creatable collection, and playlists are the curation tool. Rather than
 * silently turning "Add to collection" into a playlist the user never asked
 * for, the CollectionController endpoints answer 403 — what Jellyfin itself
 * returns to a user without the collection-management permission, which apps
 * already handle.
 */
export function collectionsUnsupportedResponse(): Response {
    return ApiResponses.forbidden(
        'Collections are not supported on this server. Use a playlist instead.',
    );
}
