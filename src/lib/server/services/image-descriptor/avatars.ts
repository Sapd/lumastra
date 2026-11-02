// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import { getUserAvatarVersions } from '$lib/server/database/queries/resource-images.queries.js';
import { userAvatarSet } from './resolver.js';

/** Stored versions are read in one query; external fallback uses the avatar proxy cache. */
export async function userImageSets(
    sql: postgres.Sql,
    surface: ApiSurface,
    ids: string[],
    opts: { external?: boolean } = {},
): Promise<Map<string, ImageSet>> {
    if (!ids.length) return new Map();
    const { config } = await import('$lib/server/config.js');
    const versions = await getUserAvatarVersions(sql, ids, config.AUTH_OIDC_SYNC_AVATAR === true);
    const known = new Map(versions.map((row) => [row.id, row]));
    const result = new Map<string, ImageSet>();
    // `external: false` is for author badges on hot paths (comments, party frames, lists): stored
    // versions only, no Jellyfin/Gravatar round trip. The byte route still resolves the real image
    // (`fallback=initials` only applies when nothing resolves), so only `source` is less precise.
    const external = opts.external !== false;
    const proxy = external
        ? (await import('$lib/server/services/image-proxy/index.js')).getImageProxyService()
        : null;
    // Users that do not exist get no entry (callers treat that as "no such user"); the
    // external avatar lookup (Jellyfin/Gravatar via the proxy cache) runs at most 4 at a time.
    const existing = [...new Set(ids)].filter((id) => known.has(id));
    for (let i = 0; i < existing.length; i += 4) {
        await Promise.all(
            existing.slice(i, i + 4).map(async (userId) => {
                const stored = known.get(userId);
                const generated = !stored?.has_avatar && !(proxy && (await proxy.getUserAvatar(userId)));
                result.set(
                    userId,
                    userAvatarSet(surface, { userId, version: stored?.version ?? '0', generated }),
                );
            }),
        );
    }
    return result;
}
