// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `ImageInfo[]` for GET /Items/{itemId}/Images (Jellyfin ImageController
 * .GetItemImageInfos), built from the same `ImageTags` / `BackdropImageTags`
 * the item's BaseItemDto advertises, so the list and the dto never disagree
 * about which images exist or what their tags are.
 *
 * Jellyfin shape: single-image types (Primary, Logo, Thumb, …) come first with
 * `ImageIndex: null`; multi-image types (Backdrop) follow, indexed from 0.
 * `Path` (a server file path) is left out. Lumastra resolves artwork through
 * the image proxy on request and stores no dimensions or byte size for it, so
 * `Width`/`Height` are omitted (nullable) and `Size` — required by the SDK —
 * is 0.
 */

import type { JellyfinBaseItemDto, JellyfinImageInfo, JellyfinImageType } from './types';

const MULTI_IMAGE_TYPES = new Set<string>(['Backdrop', 'Screenshot']);

export function buildItemImageInfos(
    dto: Pick<JellyfinBaseItemDto, 'ImageTags' | 'BackdropImageTags' | 'ImageBlurHashes'>,
): JellyfinImageInfo[] {
    const infos: JellyfinImageInfo[] = [];
    for (const [type, tag] of Object.entries(dto.ImageTags ?? {})) {
        if (MULTI_IMAGE_TYPES.has(type)) continue;
        infos.push(info(type as JellyfinImageType, null, tag, dto.ImageBlurHashes));
    }
    (dto.BackdropImageTags ?? []).forEach((tag, index) => {
        infos.push(info('Backdrop', index, tag, dto.ImageBlurHashes));
    });
    return infos;
}

function info(
    type: JellyfinImageType,
    index: number | null,
    tag: string,
    blurHashes: JellyfinBaseItemDto['ImageBlurHashes'],
): JellyfinImageInfo {
    const blurHash = blurHashes?.[type]?.[tag];
    return {
        ImageType: type,
        ImageIndex: index,
        ImageTag: tag,
        ...(blurHash ? { BlurHash: blurHash } : {}),
        Size: 0,
    };
}
