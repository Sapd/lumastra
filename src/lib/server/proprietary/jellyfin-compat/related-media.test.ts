// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import { serializeExtra, toJellyfinExtraType } from './related-media';
import type { ItemExtraRow } from '$lib/server/database/queries/related-media.queries';

const PARENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function row(extra: Partial<ItemExtraRow>): ItemExtraRow {
    return {
        id: '11111111-2222-3333-4444-555555555555',
        title: 'trailer',
        extra_type: 'trailer',
        runtime_seconds: 120,
        created_at: '2026-01-01T00:00:00.000Z',
        parent_id: PARENT,
        parent_title: 'The Movie',
        parent_year: 2020,
        parent_poster_path: '/p.jpg',
        parent_backdrop_path: null,
        ...extra,
    };
}

describe('toJellyfinExtraType', () => {
    it('maps every scanner extra_type onto Jellyfin ExtraType', () => {
        expect(toJellyfinExtraType('trailer')).toBe('Trailer');
        expect(toJellyfinExtraType('behind_the_scenes')).toBe('BehindTheScenes');
        expect(toJellyfinExtraType('deleted_scene')).toBe('DeletedScene');
        expect(toJellyfinExtraType('featurette')).toBe('Featurette');
        expect(toJellyfinExtraType('interview')).toBe('Interview');
        expect(toJellyfinExtraType('scene')).toBe('Scene');
        expect(toJellyfinExtraType('short')).toBe('Short');
        expect(toJellyfinExtraType('extra')).toBe('Unknown');
        expect(toJellyfinExtraType(null)).toBe('Unknown');
    });
});

describe('serializeExtra', () => {
    it('a trailer is a Trailer item named after its movie, with the movie as image owner', () => {
        const dto = serializeExtra(row({}));
        expect(dto).toMatchObject({
            Type: 'Trailer',
            ExtraType: 'Trailer',
            Name: 'The Movie',
            ParentId: PARENT,
            ProductionYear: 2020,
            ImageTags: {},
            ParentPrimaryImageItemId: PARENT,
            ParentPrimaryImageTag: 'aaaaaaaabbbbcccc',
            MediaType: 'Video',
            IsFolder: false,
        });
        expect(dto.ParentBackdropItemId).toBeUndefined();
    });

    it('a featurette is a Video with its own title; a named trailer keeps its title', () => {
        expect(serializeExtra(row({ extra_type: 'featurette', title: 'Making Of' }))).toMatchObject(
            { Type: 'Video', ExtraType: 'Featurette', Name: 'Making Of' },
        );
        expect(serializeExtra(row({ title: 'Teaser 2' })).Name).toBe('Teaser 2');
        expect(serializeExtra(row({ title: 'Teaser 2' }), { nameFromParent: true }).Name).toBe(
            'The Movie',
        );
    });
});
