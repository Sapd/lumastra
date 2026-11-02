// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it } from 'vitest';
import { musicCollageImages } from './collage-images.js';
import { musicImagesFixture } from './__tests__/image-fixtures.js';

describe('music collage descriptors', () => {
    it('omits artwork for an empty collage', () => {
        expect(musicCollageImages([], 'v1', new Map())).toEqual({});
    });

    it.each(['internal', 'v1'] as const)('keeps the collage byte route on %s', (surface) => {
        const members = new Map([['album', musicImagesFixture('album', surface)]]);
        const images = musicCollageImages(['album', 'album'], surface, members);
        const base = surface === 'v1' ? '/api/v1' : '/api';
        expect(images.primary).toMatchObject({ source: 'generated' });
        expect(images.primary?.href).toBe(
            `${base}/music/images/collage?ids=album&size=card&v=${images.primary?.revision}`,
        );
        expect(images.primary?.variants?.thumb).toContain('&size=thumb&v=');
        expect(images).not.toHaveProperty('poster');
    });

    it('revises the collage when member artwork or its order changes', () => {
        const first = musicImagesFixture('a', 'v1');
        const members = new Map([
            ['a', first],
            ['b', musicImagesFixture('b', 'v1')],
        ]);
        const original = musicCollageImages(['a', 'b'], 'v1', members).primary?.revision;
        expect(musicCollageImages(['b', 'a'], 'v1', members).primary?.revision).not.toBe(original);
        members.set('a', { primary: { ...first.primary!, revision: 'updated-cover' } });
        expect(musicCollageImages(['a', 'b'], 'v1', members).primary?.revision).not.toBe(original);
    });
});
