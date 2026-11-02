// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { env } from '$env/dynamic/public';

/**
 * Build the Kavita web-UI URL for a book/manga/comic series.
 * Returns null when Kavita is not configured or no series id is available.
 *
 * @param seriesId - Kavita series id (bare numeric string)
 * @param libraryId - Kavita library id (defaults to 1 when unknown)
 */
export function kavitaSeriesUrl(
    seriesId: string | null | undefined,
    libraryId?: number | null,
): string | null {
    if (!env.PUBLIC_KAVITAURL || !seriesId) return null;
    return `${env.PUBLIC_KAVITAURL}/library/${libraryId ?? 1}/series/${seriesId}`;
}

/**
 * Open a book/manga/comic series in Kavita in a new tab.
 * Does NOT close the search panel (external link pattern).
 *
 * @param item - Object with optional mediaId, libraryId, and the `kavita` id fallback
 */
export function openKavitaItem(item: {
    mediaId?: string;
    libraryId?: number;
    kavitaId?: string | null;
}): void {
    const url = kavitaSeriesUrl(item.mediaId || item.kavitaId, item.libraryId);
    if (!url) return;
    window.open(url, '_blank', 'noopener');
}
