// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { AuthDependencyUnavailableError } from '$lib/server/auth/dependency-unavailable.js';
import { getDb } from '$lib/server/database/connection.js';
import { getFileSiblingEpisodes } from '$lib/server/database/queries/episode-search.queries.js';
import { getFilesForMediaItem } from '$lib/server/database/queries/media-files.queries.js';
import { resolveEpisodeEntryPoint } from '$lib/server/utils/episode-entry-point.js';
import {
    canonicalWatchTogetherMediaType,
    type WatchTogetherMediaType,
} from '$lib/schemas/watch-together';

/** Omitted starts enter the selected episode; explicit positions and live party clocks remain file-absolute. */
export async function resolveWatchTogetherEntryPosition(
    itemId: string,
    mediaType: WatchTogetherMediaType,
    fileId?: string,
    position?: number,
): Promise<number> {
    if (position !== undefined) return position;
    if (canonicalWatchTogetherMediaType(mediaType) !== 'episode') return 0;
    const db = getDb();
    if (!db)
        throw new AuthDependencyUnavailableError(
            new Error('Database unavailable while resolving party entry position'),
        );
    if (fileId) {
        const files = await getFilesForMediaItem(db, itemId);
        // Episode windows belong to the default file, never an alternate cut.
        if (!files.some((file) => file.id === fileId && file.is_default)) return 0;
    }
    const siblings = await getFileSiblingEpisodes(db, itemId);
    return resolveEpisodeEntryPoint(siblings, itemId).streamStartPositionMs / 1000;
}
