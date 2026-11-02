// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getFallbackChain } from './jellyfin-fallback-strategy';

describe('Jellyfin episode image fallback', () => {
    it('uses landscape-friendly fallbacks for episode thumbnails', () => {
        const chain = getFallbackChain('episode-1', 'Episode', 'Thumb', {
            Type: 'Episode',
            SeriesId: 'series-1',
        });

        expect(chain).toEqual([
            {
                itemId: 'episode-1',
                imageType: 'Primary',
                description: 'Episode Primary for thumbnail',
            },
            {
                itemId: 'series-1',
                imageType: 'Thumb',
                description: 'Series Thumb for episode',
            },
            {
                itemId: 'series-1',
                imageType: 'Backdrop',
                description: 'Series Backdrop for episode',
            },
            {
                itemId: 'series-1',
                imageType: 'Primary',
                description: 'Series Primary for episode',
            },
        ]);
    });
});
