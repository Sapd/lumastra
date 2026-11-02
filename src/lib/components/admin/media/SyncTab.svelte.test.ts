// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The external-id editor in the sync tab writes provider ids that matching
 * and every metadata sync depend on. These tests pin that a save is sent
 * once, records what it sent, and refreshes the page data that the rest of
 * the tab (Sync from provider, the summary) reads.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
    syncMediaMetadata: vi.fn(),
    syncMediaMetadataEnqueue: vi.fn(),
    getMediaExternalIds: vi.fn(),
    upsertMediaExternalId: vi.fn(),
    deleteMediaExternalId: vi.fn(),
    previewEpisodeTmdbExchange: vi.fn(),
    confirmEpisodeTmdbExchange: vi.fn(),
    getMediaSegments: vi.fn(),
    getAdminEpisodes: vi.fn(),
    undoMediaSegments: vi.fn(),
    clearMediaSegments: vi.fn(),
    generateMediaSegments: vi.fn(),
    setMediaSegment: vi.fn(),
    generateTrickplay: vi.fn(),
    regenerateEpisodeThumbnails: vi.fn(),
    syncChapters: vi.fn(),
    cancelRun: vi.fn(),
}));

const tracking = vi.hoisted(() => ({
    browser: false,
    taskId: null as string | null,
    listeners: new Set<() => void>(),
    runsFor: vi.fn((taskId: string) =>
        taskId === tracking.taskId ? [{ id: 'run-thumbnail-season', state: 'pending' }] : [],
    ),
}));

vi.mock('$lib/api/admin', () => api);
vi.mock('$app/environment', () => ({
    get browser() {
        return tracking.browser;
    },
}));
vi.mock('$app/navigation', () => ({ invalidate: vi.fn() }));
vi.mock('$lib/stores/run-sse-bus.js', () => ({
    runSSEBus: {
        onAnyChange: (listener: () => void) => {
            tracking.listeners.add(listener);
            return () => tracking.listeners.delete(listener);
        },
    },
}));
vi.mock('$lib/stores/subject-runs.js', () => ({
    createSubjectRunsTracker: vi.fn(() => ({
        runsFor: tracking.runsFor,
        isActive: (taskId: string) => taskId === tracking.taskId,
        progressFor: () => undefined,
        onSettled: () => () => {},
        destroy: vi.fn(),
    })),
}));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

import SyncTab from './SyncTab.svelte';

const ROWS = [{ id: '1', provider: 'tmdb', external_id: '550', is_primary: true }];

async function openEditor(onsaved = vi.fn()): Promise<HTMLInputElement> {
    render(SyncTab, {
        props: { mediaId: 'movie-1', mediaType: 'movie', externalIds: { tmdb: '550' }, onsaved },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    const identity = await screen.findByRole('link', { name: 'TMDB · movie · 550' });
    expect(identity.getAttribute('href')).toBe('https://www.themoviedb.org/movie/550');
    await fireEvent.click(screen.getByTitle('Edit'));
    return screen.getByDisplayValue('550') as HTMLInputElement;
}

beforeEach(() => {
    api.getMediaSegments.mockResolvedValue({
        data: {
            analysisInputs: [
                {
                    mediaId: 'episode-1',
                    state: 'ready',
                    inputIdentity: 'source-a',
                    fileId: 'file-a',
                    filePath: '/fictional/source-a.mkv',
                    alternate: false,
                    proof: {
                        runId: 'run-1',
                        inputIdentity: 'source-a',
                        stageId: 'lumastra-intro-analyzer:visual',
                        segmentTypes: ['Intro', 'Outro'],
                        segmentsCount: 0,
                        completedAt: '2026-10-24T10:00:00Z',
                    },
                },
            ],
            totalSegments: 0,
            providers: {},
            candidates: [],
        },
        error: undefined,
    });
    api.getMediaExternalIds.mockResolvedValue({ data: { externalIds: ROWS }, error: undefined });
});

afterEach(() => {
    cleanup();
    tracking.browser = false;
    tracking.taskId = null;
    tracking.listeners.clear();
    vi.clearAllMocks();
});

describe('SyncTab external id editor', () => {
    it('sends one save for a double Enter, then refreshes the page data', async () => {
        let resolveSave!: (value: unknown) => void;
        api.upsertMediaExternalId.mockReturnValue(
            new Promise((resolve) => {
                resolveSave = resolve;
            }),
        );
        const onsaved = vi.fn();
        const input = await openEditor(onsaved);
        await fireEvent.input(input, { target: { value: '551' } });

        await fireEvent.keyDown(input, { key: 'Enter' });
        await fireEvent.keyDown(input, { key: 'Enter' });
        resolveSave({ data: { updated: true }, error: undefined });

        await waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1));
        expect(api.upsertMediaExternalId).toHaveBeenCalledTimes(1);
        expect(api.upsertMediaExternalId).toHaveBeenCalledWith('movie-1', {
            provider: 'tmdb',
            externalId: '551',
        });
    });

    it('records the value it sent, and keeps text typed during the save open', async () => {
        let resolveSave!: (value: unknown) => void;
        api.upsertMediaExternalId.mockReturnValue(
            new Promise((resolve) => {
                resolveSave = resolve;
            }),
        );
        const input = await openEditor();
        await fireEvent.input(input, { target: { value: '551' } });
        await fireEvent.keyDown(input, { key: 'Enter' });
        await fireEvent.input(input, { target: { value: '5512' } });

        resolveSave({ data: { updated: true }, error: undefined });

        await waitFor(() => expect(api.upsertMediaExternalId).toHaveBeenCalledTimes(1));
        await new Promise((r) => setTimeout(r, 0));
        expect((screen.getByDisplayValue('5512') as HTMLInputElement).value).toBe('5512');
    });
});

it.each(['artist', 'track', 'audiobook'])(
    '%s hides video processing while keeping metadata actions',
    async (mediaType) => {
        render(SyncTab, { props: { mediaId: 'fictional-audio', mediaType, externalIds: {} } });
        expect(screen.queryByText('Trickplay')).toBeNull();
        expect(screen.queryByText('Chapters')).toBeNull();
        expect(screen.queryByText('Media Segments')).toBeNull();
        expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
        expect(api.generateTrickplay).not.toHaveBeenCalled();
        expect(api.syncChapters).not.toHaveBeenCalled();
        expect(api.generateMediaSegments).not.toHaveBeenCalled();
    },
);

it.each(['season', 'series'] as const)(
    'maintenance thumbnail action submits the %s scope and tracks the queued extraction task',
    async (mediaType) => {
        tracking.browser = true;
        api.regenerateEpisodeThumbnails.mockImplementation(async () => {
            tracking.taskId = 'episode-thumbnail-extract';
            for (const listener of tracking.listeners) listener();
            return { data: { runId: 'run-thumbnail-season', message: 'Queued' }, error: undefined };
        });
        render(SyncTab, {
            props: {
                mediaId: 'thumbnail-parent',
                mediaType,
                externalIds: {},
                taskSection: 'processing',
            },
        });
        const button = screen.getByRole('button', { name: 'Repair episode pictures' });
        await fireEvent.click(button);
        await waitFor(() =>
            expect(api.regenerateEpisodeThumbnails).toHaveBeenCalledExactlyOnceWith(
                'thumbnail-parent',
                { scope: mediaType },
            ),
        );
        await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(true));
        expect(screen.getByText('Queued…')).toBeTruthy();
        expect(tracking.runsFor).toHaveBeenCalledWith('episode-thumbnail-extract');
    },
);

describe('child metadata controls', () => {
    it.each(['episode', 'season'])(
        '%s explains parent scope without a forbidden sync button',
        (mediaType) => {
            render(SyncTab, {
                props: {
                    mediaId: 'episode-1',
                    mediaType,
                    externalIds: { tmdb: '70101' },
                    parentSeriesId: 'series-1',
                },
            });
            expect(screen.queryByRole('button', { name: 'Sync from provider' })).toBeNull();
            expect(screen.getByText(/Direct provider sync is unavailable/)).toBeTruthy();
            expect(
                screen
                    .getByRole('link', { name: 'Inspect parent series controls' })
                    .getAttribute('href'),
            ).toContain('/admin/library/media/series-1?tab=maintenance&section=metadata');
            expect(screen.getByRole('button', { name: 'Manage' })).toBeTruthy();
        },
    );

    it('chooses a same-series episode and applies one swap without an acknowledgement', async () => {
        const preview = {
            series: { id: 'series-1', title: 'Invented Series' },
            first: {
                id: 'episode-1',
                title: 'Pilot A',
                seasonNumber: 1,
                episodeNumber: 1,
                tmdbId: '70101',
            },
            second: {
                id: 'episode-2',
                title: 'Pilot B',
                seasonNumber: 1,
                episodeNumber: 2,
                tmdbId: '70202',
            },
            snapshot: 'a'.repeat(64),
        };
        api.previewEpisodeTmdbExchange.mockResolvedValue({ data: preview });
        api.getAdminEpisodes.mockResolvedValue({
            data: {
                episodes: [
                    { id: 'episode-2', title: 'Pilot B', season_number: 1, episode_number: 2 },
                ],
            },
        });
        api.confirmEpisodeTmdbExchange.mockResolvedValue({
            data: {
                ...preview,
                first: { ...preview.first, tmdbId: '70202' },
                second: { ...preview.second, tmdbId: '70101' },
            },
        });
        const onsaved = vi.fn();
        render(SyncTab, {
            props: {
                mediaId: 'episode-1',
                mediaType: 'episode',
                parentSeriesId: 'series-1',
                externalIds: { tmdb: '70101' },
                onsaved,
            },
        });
        await fireEvent.click(
            screen.getByRole('button', { name: 'Swap the online matches for two episodes' }),
        );
        await screen.findByRole('option', { name: 'S1 E2 · Pilot B' });
        await fireEvent.change(screen.getByLabelText('Other episode in this series'), {
            target: { value: 'episode-2' },
        });
        await screen.findByText('Series: Invented Series');
        expect(screen.getByText(/Current TMDB episode ID: 70101 → Proposed: 70202/)).toBeTruthy();
        expect(screen.getByText(/Current TMDB episode ID: 70202 → Proposed: 70101/)).toBeTruthy();
        const confirm = screen.getByRole('button', {
            name: 'Apply swap',
        }) as HTMLButtonElement;
        expect(confirm.disabled).toBe(false);
        expect(screen.queryByLabelText(/I verified both episodes/)).toBeNull();
        await fireEvent.click(confirm);
        await waitFor(() =>
            expect(api.confirmEpisodeTmdbExchange).toHaveBeenCalledExactlyOnceWith(
                'episode-1',
                'episode-2',
                preview.snapshot,
            ),
        );
        await screen.findByText('Saved TMDB episode IDs: 70202 and 70101.');
        expect(onsaved).toHaveBeenCalledOnce();
        expect(api.syncMediaMetadata).not.toHaveBeenCalled();
    });

    it('keeps the other episode draft after a stale confirmation', async () => {
        const preview = {
            series: { id: 'series-1', title: 'Invented Series' },
            first: {
                id: 'episode-1',
                title: 'Pilot A',
                seasonNumber: 1,
                episodeNumber: 1,
                tmdbId: '70101',
            },
            second: {
                id: 'episode-2',
                title: 'Pilot B',
                seasonNumber: 1,
                episodeNumber: 2,
                tmdbId: '70202',
            },
            snapshot: 'b'.repeat(64),
        };
        api.previewEpisodeTmdbExchange.mockResolvedValue({ data: preview });
        api.getAdminEpisodes.mockResolvedValue({
            data: {
                episodes: [
                    { id: 'episode-2', title: 'Pilot B', season_number: 1, episode_number: 2 },
                ],
            },
        });
        api.confirmEpisodeTmdbExchange.mockResolvedValue({ data: null, error: 'State changed' });
        render(SyncTab, {
            props: {
                mediaId: 'episode-1',
                mediaType: 'episode',
                parentSeriesId: 'series-1',
                externalIds: {},
            },
        });
        await fireEvent.click(
            screen.getByRole('button', { name: 'Swap the online matches for two episodes' }),
        );
        await screen.findByRole('option', { name: 'S1 E2 · Pilot B' });
        await fireEvent.change(screen.getByLabelText('Other episode in this series'), {
            target: { value: 'episode-2' },
        });
        await screen.findByText('Series: Invented Series');
        await fireEvent.click(screen.getByRole('button', { name: 'Apply swap' }));
        await screen.findByRole('alert');
        expect(
            (screen.getByLabelText('Other episode in this series') as HTMLSelectElement).value,
        ).toBe('episode-2');
        expect(screen.queryByText(/Saved TMDB episode IDs/)).toBeNull();
        expect(screen.queryByRole('button', { name: 'Apply swap' })).toBeNull();
    });
});
