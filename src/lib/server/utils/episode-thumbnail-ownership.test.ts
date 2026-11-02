// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { ownsEpisodeThumb } from './episode-thumbnail-ownership.js';

const owner = 'abcdef12-3456-4789-abcd-123456789abc';

describe('episode thumbnail ownership case handling', () => {
    it.each(['Release-THUMB.JPG', 'release-thumb.png', 'RELEASE-ThUmB.AvIf'])(
        'accepts the same video stem with mixed case: %s',
        (name) => {
            expect(ownsEpisodeThumb(`/test/${name}`, ['/test/Release.mkv'], owner)).toBe(true);
        },
    );

    it.each([
        `/test/Combined-${owner.slice(0, 8).toUpperCase()}-THUMB.JPG`,
        `/cache/${owner.toUpperCase()}-12345678-1234-4567-abcd-123456789abc-THUMB.JPG`,
    ])('accepts case-insensitive owner suffixes: %s', (path) => {
        expect(ownsEpisodeThumb(path, [], owner)).toBe(true);
    });

    it.each([
        '/test/Other-THUMB.JPG',
        '/other/Release-THUMB.JPG',
        '/test/Combined-deadbeef-THUMB.JPG',
    ])('rejects a different file, directory or owner: %s', (path) => {
        expect(ownsEpisodeThumb(path, ['/test/Release.mkv'], owner)).toBe(false);
    });
});
