// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Example names are fictional; production shapes and measurements are retained.
 * "Not linked to Jellyfin" is a note about an integration, not a problem with
 * the media. On prod a series with a few unlinked episodes opened every such
 * season and put a coloured pill on each episode, drowning the badges that
 * matter. Pinned here: notes neither open a season nor repeat per episode.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { BrowserSeasonGroupDto } from '$lib/schemas/api-admin-browser-children.js';
import SeriesTreeRows from './SeriesTreeRows.svelte';
import { getLocale, overwriteGetLocale } from '$lib/paraglide/runtime.js';
const originalGetLocale = getLocale;
afterEach(() => overwriteGetLocale(originalGetLocale));

const NOTE = { kind: 'not_in_jellyfin' as const, severity: 'info' as const };
const PROBLEM = { kind: 'no_overview' as const, severity: 'warn' as const };

function episode(n: number, issues: BrowserSeasonGroupDto['episodes'][number]['issues']) {
    return {
        id: `ep-${n}`,
        title: `Episode ${n}`,
        mediaType: 'episode',
        seasonNumber: 1,
        episodeNumber: n,
        hasFiles: true,
        issues,
    };
}

function mount(seasons: BrowserSeasonGroupDto[], onopenfiles?: (id: string) => void) {
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);
    document.body.appendChild(table);
    return render(SeriesTreeRows, {
        target: tbody,
        props: {
            seriesId: 'series-1',
            seriesTitle: '.harbor',
            status: 'ready',
            seasons,
            colspan: 5,
            onselectview: vi.fn(),
            onopenfiles,
        },
    });
}

afterEach(() => {
    document.body.innerHTML = '';
});

describe('SeriesTreeRows', () => {
    test('a season whose only issues are notes stays closed and shows one count', () => {
        mount([
            {
                seasonNumber: 1,
                episodes: [episode(1, [NOTE]), episode(2, [NOTE]), episode(3, [])],
                withFiles: 3,
            },
        ]);
        expect(screen.queryAllByTestId('tree-episode-row')).toHaveLength(0);
        expect(screen.getByText('2 not linked to Jellyfin')).toBeTruthy();
    });

    test('a real problem opens the season, and episodes carry no note pill', () => {
        mount([
            {
                seasonNumber: 1,
                episodes: [episode(1, [PROBLEM, NOTE]), episode(2, [NOTE])],
                withFiles: 2,
            },
        ]);
        expect(screen.getAllByTestId('tree-episode-row')).toHaveLength(2);
        expect(screen.getByText('No overview')).toBeTruthy();
        // Only the season-level count mentions Jellyfin.
        expect(screen.getAllByText(/Jellyfin/)).toHaveLength(1);
    });
});

test('a nested file-problem badge opens the affected episode, not the series', async () => {
    const onopenfiles = vi.fn();
    mount(
        [
            {
                seasonNumber: 1,
                episodes: [
                    episode(4, [{ kind: 'file_problem', subtype: 'integrity', severity: 'error' }]),
                ],
                withFiles: 1,
            },
        ],
        onopenfiles,
    );
    await waitFor(() => expect(screen.getByTestId('tree-episode-row')).toBeTruthy());
    await fireEvent.click(screen.getByRole('button', { name: 'File problems' }));
    expect(onopenfiles).toHaveBeenCalledWith('ep-4');
});

test('uses German fallback season labels, including specials', () => {
    overwriteGetLocale(() => 'de');
    mount([
        {
            seasonNumber: 1,
            season: {
                id: 'season-1',
                title: 'Season 1',
                mediaType: 'season',
                hasFiles: true,
                issues: [],
            },
            episodes: [episode(1, [])],
            withFiles: 1,
        },
        { seasonNumber: 0, episodes: [], withFiles: 0 },
    ]);
    expect(screen.getByText('Staffel 1')).toBeTruthy();
    expect(screen.getByText('1 von 1 Episode hat Dateien')).toBeTruthy();
    expect(screen.getByText('Specials')).toBeTruthy();
});

test('preserves a season’s actual title', () => {
    overwriteGetLocale(() => 'de');
    mount([
        {
            seasonNumber: 1,
            season: {
                id: 'season-1',
                title: 'Winterbogen',
                mediaType: 'season',
                hasFiles: true,
                issues: [],
            },
            episodes: [],
            withFiles: 0,
        },
    ]);
    expect(screen.getByText('Winterbogen')).toBeTruthy();
});
