// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { expect, it, vi, afterEach } from 'vitest';
import SourceManager from './SourceManager.svelte';
const { updateLiveTvSource, bus, toastError, sourceStatus } = vi.hoisted(() => ({
    sourceStatus: { value: 'failed' },
    updateLiveTvSource: vi.fn(),
    toastError: vi.fn(),
    bus: {
        connect: vi.fn(),
        disconnect: vi.fn(),
        onAnyChange: vi.fn(() => () => {}),
        runs: new Map<
            string,
            {
                id: string;
                taskId: string;
                state: string;
                stages: unknown[];
                error?: { message: string };
            }
        >(),
    },
}));
vi.mock('$lib/api/livetv', () => ({
    updateLiveTvSource,
    getLiveTvSources: vi.fn().mockImplementation(async () => ({
        data: {
            sources: [
                {
                    id: 'source',
                    name: 'Provider',
                    sourceType: 'm3u',
                    channelCount: 0,
                    maxStreams: 1,
                    lastRefreshStatus: sourceStatus.value,
                    lastRefreshError:
                        'Fetch failed http://user:secret@provider.example/epg?password=secret',
                },
            ],
        },
    })),
}));
vi.mock('$lib/stores/toast.store', () => ({ toasts: { success: vi.fn(), error: toastError } }));
vi.mock('$lib/stores/run-sse-bus', () => ({ runSSEBus: bus }));
afterEach(cleanup);
it.each(['failed', 'success'])(
    'shows a failed playlist or guide in red with a redacted reason (playlist: %s)',
    async (status) => {
        sourceStatus.value = status;
        render(SourceManager);
        const badge = await screen.findByText('failed', { exact: true });
        expect(badge.className).toContain('text-red-300');
        expect(await screen.findByText(/Fetch failed/)).toBeTruthy();
        expect(document.body.textContent).not.toContain('secret');
    },
);

it('finishes an EPG-only edit immediately instead of waiting for another child run', async () => {
    bus.disconnect.mockClear();
    bus.runs.set('run-epg', {
        id: 'run-epg',
        taskId: 'import-epg',
        state: 'completed',
        stages: [],
    });
    updateLiveTvSource.mockResolvedValue({
        data: { source: { id: 'source' }, taskIds: { epg: 'run-epg' } },
    });
    const { container } = render(SourceManager);
    await fireEvent.click(await screen.findByRole('button', { name: /Edit Source/i }));
    await fireEvent.input(container.querySelector('#xmltv-url')!, {
        target: { value: 'http://provider.example/epg' },
    });
    await fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(bus.disconnect).toHaveBeenCalled());
});

it('redacts a failed import run before displaying its progress error', async () => {
    toastError.mockClear();
    bus.runs.set('run-failed', {
        id: 'run-failed',
        taskId: 'import-epg',
        state: 'failed',
        stages: [],
        error: {
            message: 'Could not fetch http://user:secret@provider.example/epg?password=secret',
        },
    });
    updateLiveTvSource.mockResolvedValue({
        data: { source: { id: 'source' }, taskIds: { epg: 'run-failed' } },
    });
    const { container } = render(SourceManager);
    await fireEvent.click(await screen.findByRole('button', { name: /Edit Source/i }));
    await fireEvent.input(container.querySelector('#xmltv-url')!, {
        target: { value: 'http://provider.example/epg' },
    });
    await fireEvent.submit(container.querySelector('form')!);
    await waitFor(() => expect(toastError).toHaveBeenCalled());
    expect(JSON.stringify(toastError.mock.calls)).not.toContain('secret');
});

it('identifies a failed non-destructive playlist retry as a channel failure', async () => {
    toastError.mockClear();
    bus.runs.set('run-refresh-failed', {
        id: 'run-refresh-failed',
        taskId: 'refresh-m3u',
        state: 'failed',
        stages: [],
        error: { message: 'Playlist unavailable' },
    });
    updateLiveTvSource.mockResolvedValue({
        data: { source: { id: 'source' }, taskIds: { m3u: 'run-refresh-failed' } },
    });
    const { container } = render(SourceManager);
    await fireEvent.click(await screen.findByRole('button', { name: /Edit Source/i }));
    await fireEvent.submit(container.querySelector('form')!);
    await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(expect.stringContaining('Channel import failed')),
    );
});
