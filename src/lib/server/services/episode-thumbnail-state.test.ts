// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { classifyEpisodeThumbnail } from './episode-thumbnail-state.js';

const row = {
    episodeId: '781cf231-79ed-448e-b4b9-5adc65b70229',
    seasonId: 'season',
    fileId: 'combined',
    videoPath: '/season/Show - S01E22-23.mkv',
    durationSeconds: 1200,
    artworkPath: '/season/Show - S01E20-thumb.jpg',
    startOffsetMs: '600000',
    endOffsetMs: '1200000',
};

describe('combined episode thumbnail ownership', () => {
    it('does not excuse a foreign thumbnail just because the video is shared', () => {
        expect(classifyEpisodeThumbnail(row, new Set()).state).toBe('missing');
    });
    it('remaps a combined episode to its actual file sidecar', () => {
        expect(
            classifyEpisodeThumbnail(row, new Set(['Show - S01E22-23-thumb.jpg'])),
        ).toMatchObject({ state: 'unmapped', resolvedPath: '/season/Show - S01E22-23-thumb.jpg' });
    });
    it('preserves a legitimately shared sidecar', () => {
        expect(
            classifyEpisodeThumbnail(
                { ...row, artworkPath: '/season/Show - S01E22-23-thumb.jpg' },
                new Set(['Show - S01E22-23-thumb.jpg']),
            ).state,
        ).toBe('shared-file');
    });
    it('preserves an existing PNG sidecar of the combined video', () => {
        expect(
            classifyEpisodeThumbnail(
                { ...row, artworkPath: '/season/Show - S01E22-23-thumb.png' },
                new Set(['Show - S01E22-23-thumb.png']),
            ).state,
        ).toBe('shared-file');
    });
});

describe('immutable published thumbnails', () => {
    it('recognizes its full owner identity and preserves an existing generated frame', () => {
        const name = `${row.episodeId}-a566562c-59e2-471b-bbee-1a8d1d97c485-thumb.jpg`;
        expect(
            classifyEpisodeThumbnail({ ...row, artworkPath: `/season/${name}` }, new Set([name]))
                .state,
        ).toBe('shared-file');
    });
    it('rejects a sibling generated frame despite a shared video', () => {
        const name =
            '788a8906-cbca-4e8a-88d0-14e799a29010-a566562c-59e2-471b-bbee-1a8d1d97c485-thumb.jpg';
        expect(
            classifyEpisodeThumbnail({ ...row, artworkPath: `/season/${name}` }, new Set([name]))
                .state,
        ).toBe('missing');
    });
});
