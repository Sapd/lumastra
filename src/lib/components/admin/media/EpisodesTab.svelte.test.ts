// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Two things this tab got wrong when GET /api/admin/media/{id}/episodes 500'd
 * on production:
 *
 *  1. A failed load left `episodes` at [] and `loading` at false, so the
 *     template fell through to the empty state. The operator saw "No episodes
 *     found" asserted next to a "Failed to load episodes" toast — two
 *     contradictory claims about the same series, and the reassuring one is
 *     the lie ("12 Monkeys" has 64 episodes).
 *  2. The endpoint was observed being fetched three times for one page load.
 *     The count assertion below pins how many times ONE mounted tab issues it,
 *     so a re-entrant effect introduced here fails rather than being absorbed
 *     by apiFetch's in-flight GET coalescer.
 */

import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { describe, expect, test, vi, beforeEach } from 'vitest';

const getAdminEpisodes = vi.fn();
const syncMediaMetadata = vi.fn();

vi.mock('$lib/api/admin', () => ({
    getAdminEpisodes: (...args: unknown[]) => getAdminEpisodes(...args),
    updateMediaMetadata: vi.fn(),
    syncMediaMetadata,
}));

vi.mock('$lib/utils/ordering-utils', () => ({
    fetchOrderingLabel: vi.fn().mockResolvedValue(null),
}));

const toastError = vi.fn();
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn() },
}));

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

const EpisodesTab = (await import('./EpisodesTab.svelte')).default;

const SERIES_ID = '4a019f72-12d6-4c33-964d-816b0fccbcab';

const EPISODE = {
    id: '11111111-1111-4111-8111-111111111111',
    title: 'Splinter',
    season_number: 1,
    episode_number: 1,
    episode_number_end: null,
    overview: null,
    runtime_seconds: 2700,
    premiere_date: '2015-01-16',
    sort_order: null,
    file_path: '/data/tv/12 Monkeys/S01/s01e01.mkv',
    edition: null,
    jellyfin_id: null,
    chapters: [{ index: 0, name: 'Cold Open', startTicks: '0' }],
};

beforeEach(() => {
    getAdminEpisodes.mockReset();
    toastError.mockReset();
});

describe('EpisodesTab load states', () => {
    test('a failed load shows the error state and NOT the empty state', async () => {
        getAdminEpisodes.mockResolvedValue({ data: null, error: 'Internal server error' });

        render(EpisodesTab, { seriesId: SERIES_ID, initialSeason: null });

        await waitFor(() => {
            expect(screen.getByTestId('episodes-load-error')).toBeTruthy();
        });
        // The whole point: the reassuring claim must be gone.
        expect(screen.queryByText('No episodes found in database.')).toBeNull();
    });

    test('a genuinely empty series shows the empty state and NOT the error state', async () => {
        getAdminEpisodes.mockResolvedValue({ data: { episodes: [] }, error: null });

        render(EpisodesTab, { seriesId: SERIES_ID, initialSeason: null });

        await waitFor(() => {
            expect(screen.getByText('No episodes found in database.')).toBeTruthy();
        });
        expect(screen.queryByTestId('episodes-load-error')).toBeNull();
    });

    test('a thrown load shows the error state, not the empty state', async () => {
        getAdminEpisodes.mockRejectedValue(new Error('network down'));

        render(EpisodesTab, { seriesId: SERIES_ID, initialSeason: null });

        await waitFor(() => {
            expect(screen.getByTestId('episodes-load-error')).toBeTruthy();
        });
        expect(screen.queryByText('No episodes found in database.')).toBeNull();
    });

    test('renders episodes on success', async () => {
        getAdminEpisodes.mockResolvedValue({ data: { episodes: [EPISODE] }, error: null });

        render(EpisodesTab, { seriesId: SERIES_ID, initialSeason: null });

        await waitFor(() => {
            expect(screen.getByText('Splinter')).toBeTruthy();
        });
        expect(screen.queryByTestId('episodes-load-error')).toBeNull();
        expect(screen.queryByText('No episodes found in database.')).toBeNull();
    });
});

describe('EpisodesTab request count', () => {
    test('one mounted tab fetches the episode list exactly once', async () => {
        getAdminEpisodes.mockResolvedValue({ data: { episodes: [EPISODE] }, error: null });

        render(EpisodesTab, { seriesId: SERIES_ID, initialSeason: null });

        await waitFor(() => {
            expect(screen.getByText('Splinter')).toBeTruthy();
        });
        // Settle any follow-on effect the successful load might schedule.
        await new Promise((r) => setTimeout(r, 50));

        expect(getAdminEpisodes).toHaveBeenCalledTimes(1);
        expect(getAdminEpisodes).toHaveBeenCalledWith(SERIES_ID);
    });
});

describe('EpisodesTab reorder scope', () => {
    // Saving a reorder numbers the list 1..N, so it must be exactly one whole
    // season: the All tab would renumber across seasons, and a filtered list
    // would collide with the hidden episodes.
    const SECOND = {
        ...EPISODE,
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Mentally Divergent',
        episode_number: 2,
    };
    const OTHER_SEASON = {
        ...EPISODE,
        id: '33333333-3333-4333-8333-333333333333',
        title: 'Year of the Monkey',
        season_number: 2,
    };

    test('the All tab offers no reorder', async () => {
        getAdminEpisodes.mockResolvedValue({
            data: { episodes: [EPISODE, SECOND, OTHER_SEASON] },
            error: null,
        });
        render(EpisodesTab, { seriesId: SERIES_ID, initialSeason: null });
        await screen.findByText('Splinter');

        await fireEvent.click(screen.getByRole('button', { name: /^All/ }));

        expect(
            (screen.getByRole('button', { name: 'Reorder' }) as HTMLButtonElement).disabled,
        ).toBe(true);
    });

    test('reorder takes the whole season, not just the filtered rows', async () => {
        getAdminEpisodes.mockResolvedValue({
            data: { episodes: [EPISODE, SECOND, OTHER_SEASON] },
            error: null,
        });
        render(EpisodesTab, { seriesId: SERIES_ID, initialSeason: 1 });
        await screen.findByText('Splinter');

        const filter = screen.getByPlaceholderText(/filter/i);
        await fireEvent.input(filter, { target: { value: 'Splinter' } });
        expect(screen.queryByText('Mentally Divergent')).toBeNull();

        await fireEvent.click(screen.getByRole('button', { name: 'Reorder' }));

        expect(screen.getByText('Splinter')).toBeTruthy();
        expect(screen.getByText('Mentally Divergent')).toBeTruthy();
        expect(screen.queryByText('Year of the Monkey')).toBeNull();
    });
});

test('episode row exposes default-file languages before expansion without per-row requests', async () => {
    const fileId = '22222222-2222-4222-8222-222222222222';
    getAdminEpisodes.mockResolvedValue({
        data: {
            episodes: [
                {
                    ...EPISODE,
                    language_summary: {
                        selectedFileId: fileId,
                        selection: 'default',
                        files: [
                            {
                                fileId,
                                isDefault: true,
                                label: 'Anime cut',
                                probed: true,
                                isMissing: false,
                                audio: [
                                    {
                                        language: 'jpn',
                                        isDefault: true,
                                        isForced: false,
                                        source: 'embedded',
                                    },
                                ],
                                subtitles: [
                                    {
                                        language: 'eng',
                                        isDefault: false,
                                        isForced: true,
                                        source: 'sidecar',
                                    },
                                ],
                            },
                        ],
                    },
                },
            ],
        },
        error: null,
    });
    render(EpisodesTab, { seriesId: SERIES_ID });
    await screen.findByText('Splinter');
    const row = screen.getByText('Splinter').closest('tr')!;
    const summary = within(row).getByRole('region', { name: 'Episode languages' });
    const disclosure = within(summary).getByLabelText('Language details');
    expect(disclosure.textContent).toContain('Audio (Default file): Japanese');
    expect(disclosure.textContent).toContain('Subtitles: English');
    expect(getAdminEpisodes).toHaveBeenCalledTimes(1);
    await fireEvent.click(disclosure);
    expect(within(summary).getByText('English · forced · external')).toBeTruthy();
    expect(screen.queryByText('s01e01.mkv')).toBeNull();
});

test('catalog-only episode rows do not add redundant unknown language lines', async () => {
    getAdminEpisodes.mockResolvedValue({
        data: {
            episodes: [
                {
                    ...EPISODE,
                    file_path: null,
                    language_summary: { selectedFileId: null, selection: 'none', files: [] },
                },
            ],
        },
        error: null,
    });
    render(EpisodesTab, { seriesId: SERIES_ID });
    await screen.findByText('Splinter');
    expect(screen.queryByRole('region', { name: 'Episode languages' })).toBeNull();
    expect(screen.queryByText('Unknown (not probed)')).toBeNull();
    expect(getAdminEpisodes).toHaveBeenCalledTimes(1);
});

test('selected episodes link to parent controls without issuing forbidden child sync', async () => {
    getAdminEpisodes.mockResolvedValue({ data: { episodes: [EPISODE] }, error: null });
    render(EpisodesTab, { seriesId: SERIES_ID });
    const row = (await screen.findByText('Splinter')).closest('tr')!;
    await fireEvent.click(row.querySelector('input[type="checkbox"]')!);
    expect(screen.queryByRole('button', { name: 'Sync Metadata' })).toBeNull();
    expect(screen.getByText(/Selected episodes cannot be synced individually/)).toBeTruthy();
    expect(
        screen.getByRole('link', { name: 'Inspect parent series controls' }).getAttribute('href'),
    ).toContain(`/admin/library/media/${SERIES_ID}?tab=maintenance&section=metadata`);
    expect(syncMediaMetadata).not.toHaveBeenCalled();
});
