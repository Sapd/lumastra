// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Cover art for albums and tracks.
 *
 * @module utils/music-cover
 */

import { getCatalogPosterUrl, type ImageSize } from '$lib/utils/image-utils';
import { VARIOUS_ARTISTS_COVER_URL } from '$lib/shared/various-artists';

export interface MusicCoverSource {
    /** Album or track id — the row whose parent chain resolves the art. */
    id: string;
    size?: ImageSize;
    /** True when this row carries its own `custom_poster_url`. */
    hasOwnPoster?: boolean;
    /** True for a Various Artists compilation (album, or a track on one). */
    variousArtists?: boolean;
}

/**
 * Resolve the cover URL for an album or track.
 *
 * `custom_poster_url` is NOT the predicate for "has a cover". The byte route
 * walks the parent chain (track → album → artist) and serves the nearest
 * ancestor's artwork, which is what admin surfaces as "INHERITED · FROM
 * <artist>". Gating an `<img>` on the row's own column therefore hid a real,
 * already-resolvable image behind the note placeholder — 979 of 3538 albums on
 * the production library, every one of them a compilation or single whose
 * artist has a photo. Only 71 have nothing anywhere.
 *
 * The ladder:
 *   1. the row's own poster — always resolves, so no 404 probe is needed;
 *   2. a Various Artists compilation — the static VA cover, deliberately AHEAD
 *      of inheritance: the parent of a compilation is the VA marker row, and
 *      inheriting means stamping that marker's uploaded photo onto 203
 *      unrelated albums as if it were their cover;
 *   3. otherwise the catalog URL with `fallback: 'none'`, which inherits and
 *      404s rather than redirecting when nothing resolves.
 *
 * That last point is load-bearing. Without `fallback: 'none'` the route 302s to
 * the generic popcorn placeholder, which LOADS — so `onerror` never fires and
 * a music surface renders a film icon instead of its own note glyph. Callers
 * that render this into an `<img>` must handle `onerror`; {@link
 * '$lib/components/music/MusicCover.svelte'} does it for them.
 */
export function musicCoverUrl({
    id,
    size = 'thumb',
    hasOwnPoster = false,
    variousArtists = false,
}: MusicCoverSource): string {
    if (hasOwnPoster) return getCatalogPosterUrl(id, { size });
    if (variousArtists) return VARIOUS_ARTISTS_COVER_URL;
    return getCatalogPosterUrl(id, { size, fallback: 'none' });
}
