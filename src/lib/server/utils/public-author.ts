// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { PublicAuthor } from '$lib/schemas/public-author.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { buildPublicAuthor } from '$lib/shared/public-author.js';
import { getDb } from '$lib/server/database/connection.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { getUserDisplayInfoByIds } from '$lib/server/database/queries/users.queries.js';

export function toPublicAuthor(
    { userId, displayName }: { userId: string; displayName: string | null },
    surface: ApiSurface = 'v1',
    images?: ImageSet,
): PublicAuthor {
    return buildPublicAuthor(userId, displayName, surface, images);
}

/**
 * Author for `id` from a `loadPublicAuthors()` map. A hard-deleted (or otherwise
 * missing) user must not turn into `author: undefined` or a 500: the response
 * gets the same placeholder shape every other author has (no display name, the
 * default avatar descriptor).
 */
export function authorOrPlaceholder(
    authors: ReadonlyMap<string, PublicAuthor>,
    userId: string,
    surface: ApiSurface = 'v1',
): PublicAuthor {
    return authors.get(userId) ?? toPublicAuthor({ userId, displayName: null }, surface);
}

/** Missing users are omitted; users without display names retain an explicit null. */
export async function loadPublicAuthors(
    userIds: string[],
    surface: ApiSurface = 'v1',
): Promise<Map<string, PublicAuthor>> {
    if (userIds.length === 0) return new Map();
    const sql = getDb();
    if (!sql) throw new Error('Database is not available');
    const unique = [...new Set(userIds)];
    const [rows, sets] = await Promise.all([
        getUserDisplayInfoByIds(sql, unique),
        userImageSets(sql, surface, unique, { external: false }),
    ]);
    return new Map(
        rows.map((row) => [
            row.id,
            toPublicAuthor(
                { userId: row.id, displayName: row.display_name },
                surface,
                sets.get(row.id),
            ),
        ]),
    );
}
