// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import type { AdminMediaRow } from '$lib/server/database/queries/admin-media.queries.js';

const listAdminMediaItems = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/database/queries/admin-media.queries.js', () => ({ listAdminMediaItems }));

import {
    BROWSER_CHILDREN_LIMIT,
    getBrowserChildren,
    groupBrowserChildren,
} from './admin-media-browser-children.js';

function row(o: Partial<AdminMediaRow> & Pick<AdminMediaRow, 'id' | 'media_type'>): AdminMediaRow {
    return {
        title: o.id,
        original_title: null,
        english_title: null,
        year: 2020,
        status: 'active',
        season_number: null,
        episode_number: null,
        created_at: '',
        updated_at: '',
        jellyfin_id: 'jf',
        jellyfin_linked: true,
        tmdb_id: null,
        child_count: 0,
        has_files: true,
        metadata_locked: false,
        is_local_only: false,
        poster_blurhash: null,
        has_poster: false,
        has_overview: true,
        runtime_seconds: null,
        overview: 'x',
        file_count: 1,
        health_issue_types: [],
        health_issue_details: [],
        integrity_issues: [],
        book_author: null,
        book_narrator: null,
        book_series: null,
        book_series_sequence: null,
        artist_title: null,
        album_title: null,
        series_title: null,
        season_title: null,
        generic_parent_title: null,
        generic_root_title: null,
        is_duplicate: false,
        files_lost: false,
        episode_problem_count: 0,
        parent_id: null,
        ...o,
    } as AdminMediaRow;
}

describe('groupBrowserChildren', () => {
    it('attaches episodes to their season, sorted, and counts the ones with files', () => {
        const groups = groupBrowserChildren(
            [
                row({ id: 's2', media_type: 'season', season_number: 2, parent_id: 'tv' }),
                row({ id: 's1', media_type: 'season', season_number: 1, parent_id: 'tv' }),
                row({
                    id: 'e1-2',
                    media_type: 'episode',
                    season_number: 1,
                    episode_number: 2,
                    parent_id: 's1',
                    has_files: false,
                }),
                row({
                    id: 'e1-1',
                    media_type: 'episode',
                    season_number: 1,
                    episode_number: 1,
                    parent_id: 's1',
                }),
            ],
            false,
        );
        expect(groups.map((g) => g.seasonNumber)).toEqual([1, 2]);
        expect(groups[0]!.episodes.map((e) => e.id)).toEqual(['e1-1', 'e1-2']);
        expect(groups[0]!.withFiles).toBe(1);
        expect(groups[1]!.episodes).toEqual([]);
    });

    it('puts an episode parented directly to the series into a virtual season group', () => {
        const [g] = groupBrowserChildren(
            [
                row({
                    id: 'e0-1',
                    media_type: 'episode',
                    season_number: 0,
                    episode_number: 1,
                    parent_id: 'tv',
                }),
            ],
            false,
        );
        expect(g!.season).toBeUndefined();
        expect(g!.seasonNumber).toBe(0);
        expect(g!.episodes[0]!.id).toBe('e0-1');
    });

    it('derives episode issues with the shared vocabulary', () => {
        const [g] = groupBrowserChildren(
            [
                row({ id: 's1', media_type: 'season', season_number: 1, parent_id: 'tv' }),
                row({
                    id: 'e1',
                    media_type: 'episode',
                    season_number: 1,
                    episode_number: 1,
                    parent_id: 's1',
                    has_overview: false,
                    health_issue_types: ['truncated_video'],
                }),
            ],
            false,
        );
        expect(g!.episodes[0]!.issues.map((i) => i.kind)).toEqual(['file_problem', 'no_overview']);
        // A season has no poster by design: no badge.
        expect(g!.season!.issues).toEqual([]);
    });
});

describe('getBrowserChildren', () => {
    /** Revert-check: drop the `+ 1` on the limit and `truncated` can never be true. */
    it('reports a series with more descendants than the limit as truncated', async () => {
        const many = Array.from({ length: BROWSER_CHILDREN_LIMIT + 1 }, (_, i) =>
            row({
                id: `e${i}`,
                media_type: 'episode',
                season_number: 1,
                episode_number: i,
                parent_id: 'tv',
            }),
        );
        listAdminMediaItems.mockResolvedValueOnce(many);
        const result = await getBrowserChildren({} as never, 'tv', false);
        expect(listAdminMediaItems.mock.calls[0]![1]).toMatchObject({
            ancestorId: 'tv',
            limit: BROWSER_CHILDREN_LIMIT + 1,
        });
        expect(result.truncated).toBe(true);
        expect(result.seasons[0]!.episodes).toHaveLength(BROWSER_CHILDREN_LIMIT);
    });

    it('is not truncated at or under the limit', async () => {
        listAdminMediaItems.mockResolvedValueOnce([
            row({
                id: 'e1',
                media_type: 'episode',
                season_number: 1,
                episode_number: 1,
                parent_id: 'tv',
            }),
        ]);
        expect((await getBrowserChildren({} as never, 'tv', false)).truncated).toBe(false);
    });
});
