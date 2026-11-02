// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ImageSetRole } from '$lib/schemas/api-image-descriptor.js';
import type { ImageRole } from '$lib/shared/api-urls.js';
import {
    isMovie,
    isSeries,
    isSeason,
    isEpisode,
    isTrack,
    isAlbum,
    isArtist,
    isAudiobook,
    isTvChannel,
} from '$lib/server/utils/media-types.js';

export interface ChainStep {
    owner:
        | 'self'
        | 'season'
        | 'series'
        | 'album'
        | 'artist'
        | 'uploaded'
        | 'idp'
        | 'jellyfin'
        | 'gravatar'
        | 'generated';
    role: ImageRole;
}
const self = (role: ImageRole): readonly ChainStep[] => [{ owner: 'self', role }];
const series = (role: ImageRole): readonly ChainStep[] => [
    { owner: 'self', role },
    { owner: 'series', role },
];
const episode = (role: ImageRole): readonly ChainStep[] => [
    { owner: 'self', role },
    { owner: 'season', role },
    { owner: 'series', role },
];

/** Ordered availability checks. No IO or provider policy is hidden in the table. */
export const IMAGE_CHAINS: Readonly<
    Record<string, Partial<Record<ImageSetRole, readonly ChainStep[]>>>
> = {
    movie: {
        poster: self('poster'),
        backdrop: self('backdrop'),
        logo: self('logo'),
        thumb: self('thumb'),
        banner: self('banner'),
    },
    series: {
        poster: self('poster'),
        backdrop: self('backdrop'),
        logo: self('logo'),
        thumb: self('thumb'),
        banner: self('banner'),
    },
    season: {
        poster: series('poster'),
        backdrop: series('backdrop'),
        logo: series('logo'),
        thumb: self('thumb'),
        banner: series('banner'),
    },
    episode: {
        poster: episode('poster'),
        backdrop: episode('backdrop'),
        logo: episode('logo'),
        banner: episode('banner'),
        thumb: [
            { owner: 'self', role: 'thumb' },
            { owner: 'self', role: 'backdrop' },
            { owner: 'series', role: 'backdrop' },
        ],
    },
    track: {
        primary: [
            { owner: 'self', role: 'poster' },
            { owner: 'album', role: 'poster' },
        ],
    },
    // Artist pictures are display-only; never store them as album covers.
    album: {
        primary: [
            { owner: 'self', role: 'poster' },
            { owner: 'artist', role: 'poster' },
        ],
        backdrop: self('backdrop'),
        logo: self('logo'),
        banner: self('banner'),
    },
    artist: {
        primary: self('poster'),
        banner: self('banner'),
        backdrop: self('backdrop'),
        logo: self('logo'),
    },
    audiobook: { primary: self('poster') },
    person: { primary: self('poster') },
    user: {
        primary: [
            { owner: 'uploaded', role: 'avatar' },
            { owner: 'idp', role: 'avatar' },
            { owner: 'jellyfin', role: 'avatar' },
            { owner: 'gravatar', role: 'avatar' },
            { owner: 'generated', role: 'avatar' },
        ],
    },
    library: {
        primary: [{ owner: 'generated', role: 'primary' }],
        backdrop: [{ owner: 'generated', role: 'backdrop' }],
    },
    tvchannel: { primary: self('poster') },
    playlist: {
        primary: [
            { owner: 'self', role: 'poster' },
            { owner: 'generated', role: 'primary' },
        ],
    },
};

export function chainFor(mediaType: string, role: ImageSetRole): readonly ChainStep[] {
    const type = isMovie(mediaType)
        ? 'movie'
        : isSeries(mediaType)
          ? 'series'
          : isSeason(mediaType)
            ? 'season'
            : isEpisode(mediaType)
              ? 'episode'
              : isTrack(mediaType)
                ? 'track'
                : isAlbum(mediaType)
                  ? 'album'
                  : isArtist(mediaType)
                    ? 'artist'
                    : isAudiobook(mediaType)
                      ? 'audiobook'
                      : isTvChannel(mediaType) || mediaType === 'station' || mediaType === 'channel'
                        ? 'tvchannel'
                        : mediaType.toLowerCase();
    return IMAGE_CHAINS[type]?.[role] ?? [];
}
