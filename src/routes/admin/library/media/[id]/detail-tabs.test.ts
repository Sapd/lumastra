// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { canonicalDetailTab, detailTabPath } from './detail-tabs.js';
describe('legacy media detail destinations', () => {
    it.each([
        ['images', 'artwork', undefined],
        ['sync', 'maintenance', 'metadata'],
        ['pipeline', 'maintenance', 'processing'],
        ['ordering', 'episodes', 'ordering'],
        ['health', 'episodes', 'issues'],
        ['season', 'episodes', undefined],
    ])('maps %s to its canonical tool', (oldTab, tab, section) => {
        expect(canonicalDetailTab(oldTab ?? null)).toEqual({
            tab,
            ...(section ? { section } : {}),
        });
    });
    it('preserves nonvideo tools', () => {
        expect(canonicalDetailTab('lyrics')).toEqual({ tab: 'lyrics' });
    });
});

describe('detail shortcuts', () => {
    it.each([
        ['files', undefined, false],
        ['overview', undefined, true],
        ['maintenance', 'processing', false],
        ['maintenance', 'history', false],
    ])('carries collection return state to %s', (tab, section, edit) => {
        const source = new URLSearchParams(
            'tab=tracks&tracks_q=Harbour&tracks_page=3&music_from_album=album-1&albums_q=Mixes&section=old',
        );
        const url = new URL(
            detailTabPath(
                'track-1',
                source,
                tab as string,
                section as string | undefined,
                edit as boolean,
            ),
            'http://localhost',
        );
        expect(url.searchParams.get('tracks_q')).toBe('Harbour');
        expect(url.searchParams.get('tracks_page')).toBe('3');
        expect(url.searchParams.get('music_from_album')).toBe('album-1');
        expect(url.searchParams.get('tab')).toBe(tab);
        expect(url.searchParams.get('section')).toBe(section ?? null);
        expect(url.searchParams.get('edit')).toBe(edit ? '1' : null);
    });
});
