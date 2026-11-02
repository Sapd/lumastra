// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ImageOwnerRow } from '$lib/server/database/queries/image-descriptor.queries.js';
import { buildImageSet } from '$lib/shared/image-descriptor.js';
import type { ApiSurface } from '$lib/shared/api-urls.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';

export function musicImageOwnerFixture(
    id: string,
    overrides: Partial<ImageOwnerRow> = {},
): ImageOwnerRow {
    return {
        id,
        media_type: 'track',
        is_various_artists: false,
        parent_id: null,
        preferred_provider: null,
        poster_blurhash: 'stored-cover-blurhash',
        backdrop_blurhash: null,
        local_artwork: {},
        provider_paths: {},
        custom_urls: { poster: `/fixtures/${id}.jpg` },
        ...overrides,
    };
}

/** Explicit projector input; projector tests do not resolve artwork. */
export function musicImagesFixture(id: string, surface: ApiSurface): ImageSet {
    return buildImageSet(surface, {
        primary: {
            ownerId: id,
            urlRole: 'poster',
            revision: 'fixture-cover-revision',
            placeholder: { blurhash: 'stored-cover-blurhash' },
        },
    });
}
