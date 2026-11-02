// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { isAudiobook, isEpisode, isMovie, isSeason, isSeries } from './media-types';
import type { PublicMediaType } from '$lib/schemas/common';
import type { UniversalMediaType } from '$lib/schemas/api-responses';
import type {
    MediaTypeApi,
    MediaTypeDetail,
    MediaTypeMovieOrSeries,
    MediaTypeProviderProjection,
    MediaTypeTmdb,
} from './media-type-domain';

declare const movieOrSeries: MediaTypeMovieOrSeries;
declare const tmdbType: MediaTypeTmdb;
declare const apiType: MediaTypeApi;
declare const detailType: MediaTypeDetail;
declare const providerType: MediaTypeProviderProjection;
declare const publicType: PublicMediaType;
declare const universalType: UniversalMediaType;
declare const rawType: string;

// These are the legitimate checks for the two projections.
isMovie(movieOrSeries);
isSeries(movieOrSeries);
isMovie(tmdbType);
isSeries(tmdbType);
isMovie(apiType);
isSeries(apiType);
isMovie(detailType);
isSeries(detailType);
isMovie(providerType);
isSeries(providerType);
// Public and universal response types are intentionally not branded yet: a
// comparator may legitimately classify an audiobook carried by either shape.
isAudiobook(publicType);
isAudiobook(universalType);
isAudiobook(detailType);
isAudiobook(providerType);

// A projected value cannot be re-narrowed against an impossible vocabulary.
// Keep these as compile-time assertions: removing a brand or widening a
// comparator input makes TypeScript report that the expected error disappeared.
// @ts-expect-error MediaTypeMovieOrSeries cannot be an audiobook.
// eslint-disable-next-line callback-safety/no-comparator-on-narrowed-media-type -- intentional negative fixture for the type-aware rule.
isAudiobook(movieOrSeries);
// @ts-expect-error MediaTypeMovieOrSeries cannot be an episode.
// eslint-disable-next-line callback-safety/no-comparator-on-narrowed-media-type -- intentional negative fixture for the type-aware rule.
isEpisode(movieOrSeries);
// @ts-expect-error MediaTypeTmdb cannot be an audiobook.
// eslint-disable-next-line callback-safety/no-comparator-on-narrowed-media-type -- intentional negative fixture for the type-aware rule.
isAudiobook(tmdbType);
// @ts-expect-error MediaTypeTmdb cannot be an episode.
// eslint-disable-next-line callback-safety/no-comparator-on-narrowed-media-type -- intentional negative fixture for the type-aware rule.
isEpisode(tmdbType);
// @ts-expect-error MediaTypeApi cannot be an audiobook.
// eslint-disable-next-line callback-safety/no-comparator-on-narrowed-media-type -- intentional negative fixture for the type-aware rule.
isAudiobook(apiType);
// @ts-expect-error MediaTypeDetail cannot be an episode.
// eslint-disable-next-line callback-safety/no-comparator-on-narrowed-media-type -- intentional negative fixture for the type-aware rule.
isEpisode(detailType);
// @ts-expect-error MediaTypeDetail cannot be a season.
// eslint-disable-next-line callback-safety/no-comparator-on-narrowed-media-type -- intentional negative fixture for the type-aware rule.
isSeason(detailType);

// Raw values remain valid inputs at provider and database boundaries.
isAudiobook(rawType);
isEpisode(rawType);
