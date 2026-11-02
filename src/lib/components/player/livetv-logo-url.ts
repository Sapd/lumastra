// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { entityImageUrl } from '$lib/shared/api-urls';

/**
 * A Live TV channel's logo for the player overlays: the entity image route the channel bar's
 * `images.primary.href` also uses. The catalog route (`/api/image/catalog/{id}/poster`) missed the
 * M3U `tvg-logo` of some channels and drew the generic placeholder instead.
 */
export function liveTvLogoUrl(channelId: string): string {
    return entityImageUrl(channelId, 'poster', 'internal', { size: 'thumb' });
}
