// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { getCwDismissArgs, getCwDismissDisplayName } from './cw-dismiss-helper';
import type { UniversalMediaItem } from '$lib/types/server-driven-ui';

const INTERNAL_ID = '7d3f8a7a-32f1-4a0f-bd43-4a36817a12d6';
const SERIES_ID = 'bbdc7ff0-0a0b-49e7-97f2-4bf13fc2448b';

function item(overrides: Partial<UniversalMediaItem>): UniversalMediaItem {
    return {
        id: INTERNAL_ID,
        title: 'Continue item',
        mediaType: 'movie',
        externalIds: { internal: INTERNAL_ID },
        ...overrides,
    } as UniversalMediaItem;
}

describe('getCwDismissArgs', () => {
    it('stores audiobook dismissals as audiobook, not movie', () => {
        expect(getCwDismissArgs(item({ mediaType: 'audiobook' }))).toEqual({
            targetId: INTERNAL_ID,
            targetType: 'audiobook',
        });
    });

    it('keeps episode dismissals at the parent series level', () => {
        expect(getCwDismissArgs(item({ mediaType: 'episode', seriesId: SERIES_ID }))).toEqual({
            targetId: SERIES_ID,
            targetType: 'series',
        });
    });

    it('keeps regular movie dismissals unchanged', () => {
        expect(getCwDismissArgs(item({ mediaType: 'movie' }))).toEqual({
            targetId: INTERNAL_ID,
            targetType: 'movie',
        });
    });
});

describe('getCwDismissDisplayName', () => {
    it('names the series for an episode, since the hide covers the series', () => {
        expect(
            getCwDismissDisplayName(
                item({
                    mediaType: 'episode',
                    title: 'Prince Randall',
                    seriesId: SERIES_ID,
                    seriesName: 'Hafentage',
                }),
            ),
        ).toBe('Hafentage');
    });

    it('names the episode for an orphan episode, which hides only itself', () => {
        expect(
            getCwDismissDisplayName(
                item({ mediaType: 'episode', title: 'Prince Randall', seriesName: 'Hafentage' }),
            ),
        ).toBe('Prince Randall');
    });

    it('names the movie itself', () => {
        expect(getCwDismissDisplayName(item({ title: 'Haze' }))).toBe('Haze');
    });
});
