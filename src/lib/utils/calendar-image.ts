// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { pickVariantUrl } from '$lib/utils/image-utils.js';
import type { MediaPreview } from '$lib/schemas/api-media-preview';
import { url } from '$lib/paths';

export type CalendarImageSource = MediaPreview & { monitored?: boolean; hasFile?: boolean };

export function calendarModalImageUrl(item: CalendarImageSource): string {
    const image = item.images.poster ?? item.images.thumb ?? item.images.primary;
    return image ? url(pickVariantUrl(image, 'card')) : '';
}

export function calendarEventImageUrl(
    item: CalendarImageSource,
    artwork: 'poster' | 'backdrop' = 'poster',
): string {
    const image = item.images[artwork] ?? item.images.thumb ?? item.images.poster;
    return image ? url(pickVariantUrl(image, 'card')) : '';
}
