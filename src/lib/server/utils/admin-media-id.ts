// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isUuid } from '$lib/server/utils/media-key-parser.js';

/**
 * The media item id of an `/api/admin/media/[id]/*` request, or null when the
 * path segment is not a UUID (callers answer null with 404).
 *
 * These internal admin routes take the row's UUID only; the admin UI never
 * sends anything else. They do not resolve aliases (composite
 * `tmdb:550:movie`, Jellyfin ids): no middleware populates
 * `locals.resolvedIds` on them, and the defs used to fall back to the raw
 * param, so any other format reached a uuid column and 500'd. The public
 * catalog surfaces do alias resolution (defs/catalog/resolve-id.ts).
 */
export function adminMediaId(event: { params: Partial<Record<string, string>> }): string | null {
    const id = event.params.id;
    return id && isUuid(id) ? id : null;
}
