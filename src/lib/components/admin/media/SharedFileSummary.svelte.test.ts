// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
const getFileEpisodes = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/admin', () => ({ getFileEpisodes }));
import SharedFileSummary from './SharedFileSummary.svelte';

function mapping(id: string, title: string) {
    return {
        data: {
            file: { id, filePath: '/fictional/shared.mp4', durationMs: 150000, manual: true },
            links: [
                {
                    mediaItemId: 'episode-a',
                    seasonNumber: 1,
                    episodeNumber: 1,
                    title: 'Lantern Rising',
                    isDefault: true,
                    sortOrder: 0,
                    startMs: 0,
                    endMs: 90000,
                    offsetSource: 'manual',
                },
                {
                    mediaItemId: 'episode-b',
                    seasonNumber: 1,
                    episodeNumber: 2,
                    title,
                    isDefault: true,
                    sortOrder: 1,
                    startMs: 90000,
                    endMs: 150000,
                    offsetSource: 'manual',
                },
            ],
            chapters: [],
            episodes: [],
        },
        error: null,
    };
}
afterEach(() => {
    vi.unstubAllGlobals();
    getFileEpisodes.mockReset();
});
describe('shared-file disclosure', () => {
    it('uses the default playback file and shows unequal file windows separately from episode time', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    files: [
                        { id: 'alphabetically-first', is_default: false },
                        { id: 'default-playback', is_default: true },
                    ],
                }),
            })),
        );
        getFileEpisodes.mockResolvedValue(mapping('default-playback', 'Lantern Setting'));
        render(SharedFileSummary, { mediaId: 'episode-b' });
        await waitFor(() =>
            expect(getFileEpisodes).toHaveBeenCalledWith('episode-b', 'default-playback'),
        );
        expect(await screen.findByText('Part 2 of 2')).toBeTruthy();
        expect(screen.getAllByText(/File time:/)).toHaveLength(2);
        expect(screen.getAllByText(/Episode time:/)).toHaveLength(2);
        expect(screen.getByText(/Lantern Setting/)).toBeTruthy();
    });
    it('ignores an older selected-file response after navigation', async () => {
        let finishOld: ((value: ReturnType<typeof mapping>) => void) | undefined;
        getFileEpisodes.mockImplementation((_media: string, file: string) =>
            file === 'file-a'
                ? new Promise((resolve) => {
                      finishOld = resolve;
                  })
                : Promise.resolve(mapping('file-b', 'New Episode')),
        );
        const view = render(SharedFileSummary, { mediaId: 'episode-b', fileId: 'file-a' });
        await waitFor(() => expect(getFileEpisodes).toHaveBeenCalledWith('episode-b', 'file-a'));
        await view.rerender({ mediaId: 'episode-b', fileId: 'file-b' });
        expect(await screen.findByText(/New Episode/)).toBeTruthy();
        finishOld?.(mapping('file-a', 'Old Episode'));
        await Promise.resolve();
        expect(screen.queryByText(/Old Episode/)).toBeNull();
    });
});

it('refreshes mappings after a successful editor save without changing the selected file', async () => {
    getFileEpisodes
        .mockResolvedValueOnce(mapping('same', 'Before edit'))
        .mockResolvedValueOnce(mapping('same', 'After edit'));
    const view = render(SharedFileSummary, { mediaId: 'episode-b', fileId: 'same', refreshKey: 0 });
    expect(await screen.findByText(/Before edit/)).toBeTruthy();
    await view.rerender({ mediaId: 'episode-b', fileId: 'same', refreshKey: 1 });
    expect(await screen.findByText(/After edit/)).toBeTruthy();
    expect(screen.queryByText(/Before edit/)).toBeNull();
    expect(getFileEpisodes).toHaveBeenCalledTimes(2);
});

it('refreshes saved estimate evidence on the same physical file without promoting it to manual evidence', async () => {
    const before = mapping('same', 'Before estimate');
    const after = mapping('same', 'Saved estimate');
    const estimated = {
        ...after,
        data: {
            ...after.data,
            links: after.data.links.map((link) => ({ ...link, boundaryOrigin: 'even-split' })),
        },
    };
    getFileEpisodes.mockResolvedValueOnce(before).mockResolvedValueOnce(estimated);
    const view = render(SharedFileSummary, { mediaId: 'episode-b', fileId: 'same', refreshKey: 0 });
    await screen.findByText(/Before estimate/);
    await view.rerender({ mediaId: 'episode-b', fileId: 'same', refreshKey: 1 });
    await screen.findByText(/Saved estimate/);
    expect(screen.getAllByText(/Estimated equal split/)).toHaveLength(2);
    expect(screen.queryByText(/Saved manual boundary/)).toBeNull();
});

it('explains unverified chapter boundaries in plain language', async () => {
    const result = mapping('file-a', 'Copper Valley');
    for (const link of result.data.links) link.offsetSource = 'unknown';
    getFileEpisodes.mockResolvedValue(result);
    render(SharedFileSummary, { mediaId: 'episode-b', fileId: 'file-a' });
    expect(await screen.findByText(/Copper Valley/)).toBeTruthy();
    expect(screen.getAllByText(/How these timings were set is unknown/)).toHaveLength(2);
});
