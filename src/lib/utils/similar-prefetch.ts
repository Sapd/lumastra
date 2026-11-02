// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Warm a movie/series detail modal's "Similar" row before the click.
 *
 * The first, uncached lookup is a vector search that took 0.2-1.9 s on prod,
 * and the modal waits on it. `fetchSimilarContent` fills the client cache the
 * modal reads (and the server's), so a click after hover intent finds it
 * ready. Other media types have no Similar row and are ignored.
 *
 * Callers fire this on real intent (a dwell on the card, or the hover popup
 * opening) — never on pointer transit — because each call can cost a search.
 */

import type { ExternalIds } from '$lib/types/api-common';
import { isMovie, isSeries } from '$lib/shared/media-types';

export function prefetchSimilar(item: {
    externalIds?: ExternalIds | null;
    mediaType?: Parameters<typeof isSeries>[0];
}): void {
    const externalIds = item.externalIds;
    if (!externalIds) return;
    const type = isSeries(item.mediaType) ? 'tv' : isMovie(item.mediaType) ? 'movie' : null;
    if (!type) return;
    void import('./modal-data').then(({ fetchSimilarContent }) =>
        fetchSimilarContent(externalIds, type, 10),
    );
}
