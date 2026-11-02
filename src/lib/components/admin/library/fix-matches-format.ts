// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/** Display helpers shared by the two Fix matches views. */

import { isEpisode, isMovie, isSeason, isSeries } from '$lib/shared/media-types';
import * as m from '$lib/paraglide/messages.js';

/**
 * One label per kind, the same in both views and in the Series/Movies filter
 * ("Series", never the internal "tv" / "Tv"). Unknown kinds (home videos …)
 * fall back to the raw value, capitalised.
 */
export function mediaTypeLabel(type: string): string {
    if (isMovie(type)) return m.admin_fix_matches_type_movie();
    if (isSeries(type)) return m.admin_fix_matches_type_series();
    if (isSeason(type)) return m.admin_fix_matches_type_season();
    if (isEpisode(type)) return m.admin_fix_matches_type_episode();
    const words = type.replace(/[_-]+/g, ' ').trim();
    return words ? words.charAt(0).toUpperCase() + words.slice(1) : type;
}

/** Last path segment — the part that tells two raw release names apart. */
export function fileName(path: string): string {
    const parts = path.split(/[\\/]/).filter(Boolean);
    return parts.at(-1) ?? path;
}
