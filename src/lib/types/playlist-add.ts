// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ExternalIds } from './api-common';

/** Confirmed outcome of a search-to-playlist submission. */
export type PlaylistAddOutcome = 'added' | 'duplicate' | 'failed';

export interface PlaylistAddItem {
    externalIds?: ExternalIds;
    mediaType: 'movie' | 'tv' | 'episode' | 'artist' | 'album' | 'track';
    title: string;
    seasonNumber?: number;
    episodeNumber?: number;
    seriesName?: string;
    seriesExternalIds?: ExternalIds;
    posterPath?: string;
    overview?: string;
}
