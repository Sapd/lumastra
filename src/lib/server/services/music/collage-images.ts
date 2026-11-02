// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { createHash } from 'node:crypto';
import { IMAGE_ALGO_VERSION } from '$lib/server/services/image-descriptor/revision.js';
import type { ImageSet } from '$lib/schemas/api-image-descriptor.js';
import { buildCollageRefs, type ApiSurface } from '$lib/shared/api-urls.js';

/** Collages have their own byte route; the catalog resolver only resolves their members. */
export function musicCollageImages(
    ids: readonly string[],
    surface: ApiSurface,
    members: ReadonlyMap<string, ImageSet>,
): ImageSet {
    const cover = buildCollageRefs(ids, surface);
    if (!cover) return {};
    const revision = createHash('sha256')
        .update(IMAGE_ALGO_VERSION)
        .update(
            JSON.stringify([...new Set(ids)].map((id) => [id, members.get(id)?.primary?.revision])),
        )
        .digest('hex')
        .slice(0, 16);
    const versioned = (href: string): string => `${href}&v=${revision}`;
    return {
        primary: {
            href: versioned(cover.card),
            variants: {
                thumb: versioned(cover.thumb),
                card: versioned(cover.card),
                full: versioned(cover.full),
            },
            revision,
            source: 'generated',
        },
    };
}
