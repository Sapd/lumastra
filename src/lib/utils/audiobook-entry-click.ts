// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { AudiobookPreview } from '$lib/schemas/api-audiobook-preview';

export type AudiobookEntryClick = { action: 'series'; seriesId: string } | { action: 'book' };

export function resolveAudiobookEntryClick(item: AudiobookPreview): AudiobookEntryClick {
    const series = item.audiobook.series;
    return series?.bookCount !== undefined
        ? { action: 'series', seriesId: series.id }
        : { action: 'book' };
}
