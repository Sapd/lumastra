// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Display labels for a library's media type and metadata provider — shared
 * between the Libraries overview (`/admin/library/sources`) and a single
 * library's page (`/admin/library/sources/[id]`), so the two never disagree
 * on what "TMDB" or "Anime" is called.
 */

import { getMediaTypeDisplay } from '$lib/utils/media-types';
import * as m from '$lib/paraglide/messages.js';
import { getRemoteLibrarySourceDescriptor } from '$lib/shared/remote-library-sources';

const PROVIDER_LABELS: Record<string, string> = {
    tmdb: 'TMDB',
    tvdb: 'TheTVDB',
    anidb: 'AniDB',
    jellyfin: 'Jellyfin',
    musicbrainz: 'MusicBrainz',
};

/** Localized library type, with the plural series label used by library selectors. */
export function typeDefaultLabel(mt: string): string {
    if (mt === 'home_video') return m.media_plain_home_videos();
    return mt === 'tv'
        ? m.admin_library_type_series()
        : mt === 'anime'
          ? m.media_plain_anime()
          : getMediaTypeDisplay(mt);
}

export function mediaTypeLabel(mt: string): string {
    return typeDefaultLabel(mt);
}

export function providerLabel(provider: string): string {
    return (
        PROVIDER_LABELS[provider] ?? getRemoteLibrarySourceDescriptor(provider)?.label ?? provider
    );
}

/** True when `provider` belongs to a remote media server rather than a filesystem scan. */
export function isRemoteProvider(provider: string): boolean {
    return getRemoteLibrarySourceDescriptor(provider) !== undefined;
}
