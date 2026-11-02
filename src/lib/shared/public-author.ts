// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { ImageSet } from '$lib/schemas/api-image-descriptor';
import type { PublicAuthor } from '$lib/schemas/public-author';
import type { ApiSurface } from './api-urls';
import { userAvatarSet } from './image-descriptor';

/**
 * Public author with the user's avatar descriptor. Pass the `ImageSet` from `userImageSets` to get
 * the real revision and source; without it the descriptor is the `generated` initials one
 * (revision `0`), whose href always resolves even for a user with no avatar anywhere.
 */
export function buildPublicAuthor(
    userId: string,
    displayName: string | null,
    surface: ApiSurface,
    images?: ImageSet,
): PublicAuthor {
    const primary =
        images?.primary ?? userAvatarSet(surface, { userId, version: '0', generated: true }).primary!;
    return { userId, displayName, images: { primary } };
}
