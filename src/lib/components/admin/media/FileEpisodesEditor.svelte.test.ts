// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import userEvent from '@testing-library/user-event';
import FileEpisodesEditor from './FileEpisodesEditor.svelte';

const api = vi.hoisted(() => ({
    getFileEpisodes: vi.fn(),
    setFileEpisodes: vi.fn(),
    undoFileEpisodes: vi.fn(),
    clearFileEpisodes: vi.fn(),
    searchFileEpisodeSeries: vi.fn(),
    syncChapters: vi.fn(),
}));
const getRun = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({ apiGet: getRun }));
const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/api/admin', () => api);
vi.mock('./EpisodeTrickplayPreview.svelte', () => ({ default: () => undefined }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));
const source = {
    revision: 'a'.repeat(64),
    file: { id: 'file', filePath: '/series/wrong.mkv', durationMs: 1000, manual: false },
    links: [
        {
            mediaItemId: 'old',
            isDefault: true,
            offsetSource: null,
            title: 'Old episode',
            seasonNumber: 1,
            episodeNumber: 1,
            startMs: null,
        },
    ],
    episodes: [{ id: 'old', title: 'Old episode', seasonNumber: 1, episodeNumber: 1 }],
    chapters: [],
};
const target = {
    ...source,
    episodes: [{ id: 'new', title: 'Correct episode', seasonNumber: 2, episodeNumber: 3 }],
};

beforeEach(() => {
    api.getFileEpisodes.mockResolvedValue({ data: source });
    api.searchFileEpisodeSeries.mockResolvedValue({
        data: { results: [{ id: 'canonical', title: 'Canonical series', year: 2001 }] },
    });
    api.setFileEpisodes.mockResolvedValue({
        data: { ...target, links: [{ mediaItemId: 'new', isDefault: true }] },
    });
});
afterEach(() => {
    cleanup();
    vi.resetAllMocks();
    getRun.mockReset();
});

async function chooseTarget(): Promise<void> {
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search for a series' }), {
        target: { value: 'Canonical' },
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'Canonical series (2001)' }));
}

describe('file episode series reassignment', () => {
    it('keeps a stale draft and requires evidence reload before saving again', async () => {
        api.setFileEpisodes.mockResolvedValueOnce({ data: null, status: 409 });
        render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
        await screen.findByRole('combobox', { name: 'Choose an episode…' });
        await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
        await screen.findByText(/The file or episode mapping changed/);
        expect(screen.getByText('S01E01 — Old episode', { selector: 'span' })).toBeTruthy();
        expect(
            (screen.getByRole('button', { name: 'Save links' }) as HTMLButtonElement).disabled,
        ).toBe(true);
        api.getFileEpisodes.mockResolvedValueOnce({
            data: { ...source, revision: 'b'.repeat(64), links: [] },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Reload episodes' }));
        await screen.findByText(/Current evidence reloaded/);
        expect(screen.getByText('S01E01 — Old episode', { selector: 'span' })).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
        await waitFor(() =>
            expect(api.setFileEpisodes).toHaveBeenLastCalledWith('source', 'file', {
                revision: 'b'.repeat(64),
                episodes: [{ mediaItemId: 'old' }],
            }),
        );
    });
    it('stages a different series and episode until Save, then uses the target context', async () => {
        const changed = vi.fn();
        render(FileEpisodesEditor, {
            mediaId: 'source',
            fileId: 'file',
            onClose: vi.fn(),
            onChanged: changed,
        });
        await screen.findByText('S01E01 — Old episode', { selector: 'span' });
        api.getFileEpisodes.mockResolvedValue({ data: target });
        await chooseTarget();
        await screen.findByRole('option', { name: 'S02E03 — Correct episode' });
        const picker = screen.getByRole('combobox', { name: 'Choose an episode…' });
        await userEvent.setup().selectOptions(picker, 'new');
        await fireEvent.change(picker);
        await waitFor(() =>
            expect(
                (screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled,
            ).toBe(false),
        );
        await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        expect(api.setFileEpisodes).not.toHaveBeenCalled();
        expect(screen.getByText('S02E03 — Correct episode', { selector: 'span' })).toBeTruthy();
        expect(screen.queryByText('S01E01 — Old episode', { selector: 'span' })).toBeNull();
        await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
        await waitFor(() =>
            expect(api.setFileEpisodes).toHaveBeenCalledWith('canonical', 'file', {
                revision: source.revision,
                episodes: [{ mediaItemId: 'new' }],
            }),
        );
        expect(changed).toHaveBeenCalledOnce();
    });

    it('Cancel after choosing another series writes nothing', async () => {
        const close = vi.fn();
        render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: close });
        await screen.findByRole('combobox', { name: 'Choose an episode…' });
        api.getFileEpisodes.mockResolvedValue({ data: target });
        await chooseTarget();
        await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
        expect(close).toHaveBeenCalledOnce();
        expect(api.setFileEpisodes).not.toHaveBeenCalled();
        expect(api.clearFileEpisodes).not.toHaveBeenCalled();
    });

    it('a failed save keeps the draft and allows another attempt', async () => {
        api.setFileEpisodes.mockResolvedValueOnce({ error: 'Save rejected' });
        render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
        await screen.findByRole('combobox', { name: 'Choose an episode…' });
        await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
        await waitFor(() => expect(toasts.error).toHaveBeenCalledWith('Save rejected'));
        expect(screen.getByText('S01E01 — Old episode', { selector: 'span' })).toBeTruthy();
        expect(
            (screen.getByRole('button', { name: 'Save links' }) as HTMLButtonElement).disabled,
        ).toBe(false);
    });

    it('ignores stale searches and stale episode loads; a failed load is retryable', async () => {
        let resolveOld!: (v: unknown) => void;
        api.searchFileEpisodeSeries.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveOld = resolve;
            }),
        );
        let resolveSource!: (v: unknown) => void;
        api.getFileEpisodes.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveSource = resolve;
            }),
        );
        render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
        await fireEvent.input(screen.getByRole('searchbox', { name: 'Search for a series' }), {
            target: { value: 'Old search' },
        });
        api.getFileEpisodes.mockResolvedValueOnce({ error: 'load failed' });
        await chooseTarget();
        resolveOld({ data: { results: [{ id: 'stale', title: 'Stale search', year: null }] } });
        resolveSource({ data: source });
        await screen.findByRole('button', { name: 'Retry loading' });
        expect(screen.queryByRole('button', { name: 'Stale search' })).toBeNull();
        api.getFileEpisodes.mockResolvedValueOnce({ data: target });
        await fireEvent.click(screen.getByRole('button', { name: 'Retry loading' }));
        await screen.findByRole('combobox', { name: 'Choose an episode…' });
        expect(screen.queryByText('S01E01 — Old episode', { selector: 'span' })).toBeNull();
    });
});

it('stages Back to automatic until explicit Save and Cancel writes nothing', async () => {
    api.getFileEpisodes.mockResolvedValue({
        data: { ...source, file: { ...source.file, manual: true } },
    });
    const close = vi.fn();
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: close });
    await fireEvent.click(await screen.findByRole('button', { name: 'Back to automatic' }));
    expect(api.clearFileEpisodes).not.toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    expect(close).toHaveBeenCalledOnce();
    expect(api.clearFileEpisodes).not.toHaveBeenCalled();
});

const pair = {
    ...source,
    file: { ...source.file, durationMs: 60000, manual: true },
    links: [
        { ...source.links[0], offsetSource: 'manual', startMs: 0, endMs: 24000 },
        {
            ...source.links[0],
            mediaItemId: 'second',
            title: 'Second episode',
            episodeNumber: 2,
            offsetSource: 'manual',
            startMs: 24000,
            endMs: 60000,
        },
    ],
    episodes: [
        ...source.episodes,
        { id: 'second', title: 'Second episode', seasonNumber: 1, episodeNumber: 2 },
        { id: 'third', title: 'Third episode', seasonNumber: 1, episodeNumber: 3 },
    ],
    chapters: [
        { name: 'Opening', startMs: 0 },
        { name: 'Second chapter', startMs: 36000 },
    ],
};

it('Save automatic preserves linked episodes and removes manual mode in the saved context', async () => {
    api.getFileEpisodes.mockResolvedValue({ data: pair });
    api.clearFileEpisodes.mockResolvedValue({
        data: {
            ...pair,
            file: { ...pair.file, manual: false },
            links: pair.links.map((l) => ({
                ...l,
                offsetSource: null,
                startMs: null,
                endMs: null,
            })),
        },
    });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Back to automatic' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() =>
        expect(api.clearFileEpisodes).toHaveBeenCalledWith('source', 'file', source.revision),
    );
    await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Back to automatic' })).toBeNull(),
    );
    expect(screen.getByText('S01E01 — Old episode', { selector: 'span' })).toBeTruthy();
    expect(screen.getByText('S01E02 — Second episode', { selector: 'span' })).toBeTruthy();
    expect(api.setFileEpisodes).not.toHaveBeenCalled();
});

it.each(['add', 'remove', 'reorder', 'boundary', 'chapters', 'even', 'snap'])(
    'reset then %s saves the visible manual draft with PUT',
    async (edit) => {
        api.getFileEpisodes.mockResolvedValue({ data: pair });
        render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
        await fireEvent.click(await screen.findByRole('button', { name: 'Back to automatic' }));
        if (edit === 'add') {
            await fireEvent.change(screen.getByRole('combobox', { name: 'Choose an episode…' }), {
                target: { value: 'third' },
            });
            await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
        } else if (edit === 'remove')
            await fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[0]);
        else if (edit === 'reorder')
            await fireEvent.click(screen.getAllByRole('button', { name: 'Move down' })[0]);
        else if (edit === 'boundary')
            await fireEvent.input(screen.getByLabelText('Episode 2 starts at'), {
                target: { value: '0:20.0' },
            });
        else if (edit === 'chapters')
            await fireEvent.click(screen.getByRole('button', { name: 'From chapters' }));
        else if (edit === 'even')
            await fireEvent.click(screen.getByRole('button', { name: 'Even split' }));
        else
            await fireEvent.change(screen.getByRole('combobox', { name: 'Chapter…' }), {
                target: { value: '36000' },
            });
        expect(screen.queryByText('Automatic linking will be restored when you Save.')).toBeNull();
        if (edit === 'add')
            await fireEvent.click(screen.getByRole('button', { name: 'Even split' }));
        await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
        await waitFor(() => expect(api.setFileEpisodes).toHaveBeenCalledOnce());
        expect(api.clearFileEpisodes).not.toHaveBeenCalled();
        const body = api.setFileEpisodes.mock.calls[0][2];
        if (edit === 'boundary') expect(body.episodes[1].startMs).toBe(20000);
        if (edit === 'reorder') expect(body.episodes[0].mediaItemId).toBe('second');
        if (edit === 'add') expect(body.episodes).toHaveLength(3);
        if (edit === 'remove') expect(body.episodes).toHaveLength(1);
    },
);

it('does not reset in an unsaved target context; allows reset after that reassignment is saved', async () => {
    api.getFileEpisodes.mockResolvedValue({
        data: { ...target, file: { ...source.file, manual: true } },
    });
    api.setFileEpisodes.mockResolvedValue({
        data: {
            ...target,
            file: { ...source.file, manual: true },
            links: [{ ...source.links[0], mediaItemId: 'new', offsetSource: 'manual' }],
        },
    });
    api.clearFileEpisodes.mockResolvedValue({
        data: {
            ...target,
            file: { ...source.file, manual: false },
            links: [{ ...source.links[0], mediaItemId: 'new' }],
        },
    });
    render(FileEpisodesEditor, {
        mediaId: 'source',
        fileId: 'file',
        initialTargetSeries: { id: 'canonical', title: 'Canonical series' },
        onClose: vi.fn(),
    });
    const reset = await screen.findByRole('button', { name: 'Back to automatic' });
    expect((reset as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(reset);
    expect(api.clearFileEpisodes).not.toHaveBeenCalled();
    await fireEvent.change(screen.getByRole('combobox', { name: 'Choose an episode…' }), {
        target: { value: 'new' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() =>
        expect(
            (screen.getByRole('button', { name: 'Back to automatic' }) as HTMLButtonElement)
                .disabled,
        ).toBe(false),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Back to automatic' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() =>
        expect(api.clearFileEpisodes).toHaveBeenCalledWith('canonical', 'file', source.revision),
    );
    expect(screen.getByText('Canonical series')).toBeTruthy();
});

it('reselecting the current series preserves draft order and edited boundaries without loading again', async () => {
    api.getFileEpisodes.mockResolvedValue({ data: pair });
    api.searchFileEpisodeSeries.mockResolvedValue({
        data: { results: [{ id: 'source', title: 'Original series', year: null }] },
    });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    await screen.findByRole('button', { name: 'Back to automatic' });
    await fireEvent.input(screen.getByLabelText('Episode 2 starts at'), {
        target: { value: '0:20.0' },
    });
    await fireEvent.input(screen.getByRole('searchbox', { name: 'Search for a series' }), {
        target: { value: 'Original' },
    });
    await fireEvent.click(await screen.findByRole('button', { name: 'Original series' }));
    expect(api.getFileEpisodes).toHaveBeenCalledOnce();
    expect((screen.getByLabelText('Episode 2 starts at') as HTMLInputElement).value).toBe('0:20.0');
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() =>
        expect(api.setFileEpisodes).toHaveBeenCalledWith('source', 'file', {
            revision: source.revision,
            episodes: [
                { mediaItemId: 'old', startMs: 0, endMs: 20000, boundaryOrigin: 'unknown' },
                { mediaItemId: 'second', startMs: 20000, endMs: 60000, boundaryOrigin: 'manual' },
            ],
        }),
    );
});

it('empty target offers the existing series sync UI and reloads populated episodes without writes', async () => {
    api.getFileEpisodes.mockResolvedValueOnce({ data: { ...target, episodes: [] } });
    render(FileEpisodesEditor, {
        mediaId: 'source',
        fileId: 'file',
        initialTargetSeries: { id: 'canonical', title: 'Canonical series' },
        onClose: vi.fn(),
    });
    const link = await screen.findByRole('link', { name: 'Open series Maintenance → Metadata' });
    expect(link.getAttribute('href')).toBe(
        '/admin/library/media/canonical?tab=maintenance&section=metadata',
    );
    expect(link.getAttribute('target')).toBe('_blank');
    expect(screen.getByRole('status').textContent).toContain('Include all seasons and episodes');
    api.getFileEpisodes.mockResolvedValueOnce({ data: target });
    await fireEvent.click(screen.getByRole('button', { name: 'Reload episodes' }));
    await screen.findByRole('option', { name: 'S02E03 — Correct episode' });
    expect(api.getFileEpisodes).toHaveBeenLastCalledWith('canonical', 'file');
    expect(api.setFileEpisodes).not.toHaveBeenCalled();
    expect(api.clearFileEpisodes).not.toHaveBeenCalled();
});

it('finds episodes in a large series without altering explicit selected order or silently splitting new windows', async () => {
    const episodes = Array.from({ length: 804 }, (_, n) => ({
        id: `candidate-${n}`,
        title: `Harbour Story ${n}`,
        seasonNumber: Math.floor(n / 67) + 1,
        episodeNumber: (n % 67) + 1,
    }));
    api.getFileEpisodes.mockResolvedValue({
        data: {
            ...pair,
            series: { id: 'series', title: 'Lantern Shore' },
            episodes: [...pair.episodes, ...episodes],
        },
    });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    expect(await screen.findByText('Lantern Shore')).toBeTruthy();
    const picker = screen.getByRole('combobox', { name: 'Choose an episode…' });
    expect(picker.querySelectorAll('option').length).toBeLessThanOrEqual(51);
    await fireEvent.input(
        screen.getByRole('searchbox', { name: 'Find an episode by title or number' }),
        { target: { value: 'Harbour Story 803' } },
    );
    await fireEvent.change(screen.getByRole('combobox', { name: 'Season filter' }), {
        target: { value: '12' },
    });
    expect(screen.getByRole('option', { name: 'S12E67 — Harbour Story 803' })).toBeTruthy();
    expect(screen.getByText('S01E01 — Old episode', { selector: 'span' })).toBeTruthy();
    await fireEvent.change(picker, { target: { value: 'candidate-803' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect((screen.getByRole('button', { name: 'Save links' }) as HTMLButtonElement).disabled).toBe(
        true,
    );
    expect(screen.getByLabelText<HTMLInputElement>('Episode 2 starts at').value).toBe('');
    await fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[2]);
    await fireEvent.click(screen.getAllByRole('button', { name: 'Move up' })[1]);
    await fireEvent.click(screen.getByRole('button', { name: 'Even split' }));
    expect(screen.getAllByText('Draft equal-split estimate; review before saving')).toHaveLength(2);
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() => expect(api.setFileEpisodes).toHaveBeenCalledOnce());
    expect(
        api.setFileEpisodes.mock.calls[0][2].episodes.map(
            (episode: { mediaItemId: string }) => episode.mediaItemId,
        ),
    ).toEqual(['candidate-803', 'old', 'second']);
});

it('labels estimates and reloads canonical chapter results without replacing edited cuts or ordered episodes', async () => {
    const estimated = {
        ...pair,
        file: { ...pair.file, manual: false },
        chapters: [],
        links: pair.links.map((link) => ({ ...link, offsetSource: 'runtime-split' })),
    };
    api.getFileEpisodes.mockResolvedValue({ data: estimated });
    api.syncChapters.mockResolvedValue({ data: { started: true, runId: 'chapters-run' } });
    getRun.mockResolvedValue({
        data: {
            id: 'chapters-run',
            taskId: 'chapter-sync',
            input: { mediaItemId: 'old' },
            state: 'completed',
            result: { success: true },
        },
    });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    expect(
        await screen.findByText('Estimated from episode runtimes; content not verified'),
    ).toBeTruthy();
    expect(screen.getByText(/Embedded chapters may still exist/)).toBeTruthy();
    await fireEvent.input(screen.getByLabelText('Episode 2 starts at'), {
        target: { value: '0:22.0' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh chapters for linked item' }));
    expect(api.syncChapters).toHaveBeenCalledWith('old');
    expect(
        (await screen.findByRole('link', { name: 'View chapter refresh run' })).getAttribute(
            'href',
        ),
    ).toBe('/admin/tasks/runs?run=chapters-run');
    api.getFileEpisodes.mockResolvedValue({
        data: {
            ...estimated,
            revision: 'd'.repeat(64),
            links: [],
            chapters: [{ name: 'Story chapter', startMs: 36000 }],
        },
    });
    await vi.waitFor(() => expect(getRun).toHaveBeenCalled(), { timeout: 5000 });
    expect(
        await screen.findByText(/Reloaded 1 saved library chapter records/, {}, { timeout: 5000 }),
    ).toBeTruthy();
    expect(screen.getByLabelText<HTMLInputElement>('Episode 2 starts at').value).toBe('0:22.0');
    expect(screen.getByText('S01E01 — Old episode', { selector: 'span' })).toBeTruthy();
    expect(
        (screen.getByRole('button', { name: 'From chapters' }) as HTMLButtonElement).disabled,
    ).toBe(false);
    expect(api.setFileEpisodes).not.toHaveBeenCalled();
});

it('ignores a save result after switching to another physical file', async () => {
    let finish!: (value: object) => void;
    const changed = vi.fn();
    api.setFileEpisodes.mockReturnValue(
        new Promise((resolve) => {
            finish = resolve;
        }),
    );
    const view = render(FileEpisodesEditor, {
        mediaId: 'source',
        fileId: 'file',
        onClose: vi.fn(),
        onChanged: changed,
    });
    await screen.findByText('S01E01 — Old episode', { selector: 'span' });
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    api.getFileEpisodes.mockResolvedValue({
        data: { ...source, file: { ...source.file, id: 'next-file', filePath: '/next-file.mkv' } },
    });
    await view.rerender({
        mediaId: 'source',
        fileId: 'next-file',
        onClose: vi.fn(),
        onChanged: changed,
    });
    await screen.findByText('/next-file.mkv', { exact: false });
    finish({ data: pair });
    await Promise.resolve();
    await Promise.resolve();
    expect(changed).not.toHaveBeenCalled();
    expect(toasts.success).not.toHaveBeenCalled();
    expect((screen.getByRole('button', { name: 'Save links' }) as HTMLButtonElement).disabled).toBe(
        false,
    );
});

it('retains readable missing draft rows after conflict reload and blocks Save until they are removed', async () => {
    api.getFileEpisodes.mockResolvedValue({ data: pair });
    api.setFileEpisodes.mockResolvedValueOnce({ data: null, status: 409 });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    await screen.findByText('S01E01 — Old episode', { selector: 'span' });
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await screen.findByText(/The file or episode mapping changed/);
    api.getFileEpisodes.mockResolvedValueOnce({
        data: { ...pair, revision: 'c'.repeat(64), links: [], episodes: pair.episodes.slice(0, 1) },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Reload episodes' }));
    await screen.findByText('No longer in the selected series');
    expect(screen.getAllByRole('listitem')[1].textContent).toContain('Second episode');
    expect((screen.getByRole('button', { name: 'Save links' }) as HTMLButtonElement).disabled).toBe(
        true,
    );
    await fireEvent.click(screen.getAllByRole('button', { name: 'Remove' })[1]);
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() =>
        expect(api.setFileEpisodes).toHaveBeenLastCalledWith('source', 'file', {
            revision: 'c'.repeat(64),
            episodes: [{ mediaItemId: 'old' }],
        }),
    );
});

it('uses the refreshed review revision when saving a retained chapter-refresh draft', async () => {
    api.getFileEpisodes.mockResolvedValue({ data: pair });
    api.syncChapters.mockResolvedValue({ data: { started: true, runId: 'chapter-revision' } });
    getRun.mockResolvedValue({
        data: {
            id: 'chapter-revision',
            taskId: 'chapter-sync',
            input: { mediaItemId: 'old' },
            state: 'completed',
            result: { success: true },
        },
    });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    await screen.findByText('S01E01 — Old episode', { selector: 'span' });
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh chapters for linked item' }));
    await screen.findByRole('link', { name: 'View chapter refresh run' });
    api.getFileEpisodes.mockResolvedValueOnce({
        data: {
            ...pair,
            revision: 'e'.repeat(64),
            chapters: [{ name: 'New chapter', startMs: 30000 }],
        },
    });
    await vi.waitFor(() => expect(getRun).toHaveBeenCalled(), { timeout: 5000 });
    await screen.findByText(/Reloaded 1 saved library chapter records/, {}, { timeout: 5000 });
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() => expect(api.setFileEpisodes.mock.calls[0][2].revision).toBe('e'.repeat(64)));
});

it('blocks Save while chapter evidence reload is in flight, so its older revision cannot replace a later save', async () => {
    api.getFileEpisodes.mockResolvedValue({ data: pair });
    api.syncChapters.mockResolvedValue({ data: { started: true, runId: 'reload-race' } });
    getRun.mockResolvedValue({
        data: {
            id: 'reload-race',
            taskId: 'chapter-sync',
            input: { mediaItemId: 'old' },
            state: 'completed',
            result: { success: true },
        },
    });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    await screen.findByText('S01E01 — Old episode', { selector: 'span' });
    await fireEvent.click(screen.getByRole('button', { name: 'Refresh chapters for linked item' }));
    await screen.findByRole('link', { name: 'View chapter refresh run' });
    let finish: (value: unknown) => void = () => {};
    api.getFileEpisodes.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    await vi.waitFor(() => expect(getRun).toHaveBeenCalled(), { timeout: 5000 });
    await waitFor(() =>
        expect(
            (screen.getByRole('button', { name: 'Save links' }) as HTMLButtonElement).disabled,
        ).toBe(true),
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    expect(api.setFileEpisodes).not.toHaveBeenCalled();
    finish({ data: { ...pair, revision: 'e'.repeat(64) } });
    await screen.findByText(/Reloaded 2 saved library chapter records/, {}, { timeout: 5000 });
    api.setFileEpisodes.mockResolvedValue({ data: { ...pair, revision: 'f'.repeat(64) } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() => expect(api.setFileEpisodes.mock.calls[0][2].revision).toBe('e'.repeat(64)));
    await screen.findByText(
        'Saved and reloaded episode links. The order and windows below are now the saved mapping.',
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() => expect(api.setFileEpisodes.mock.calls[1][2].revision).toBe('f'.repeat(64)));
});

it('starts unlinked repair with deliberate series selection and no placeholder evidence request', async () => {
    render(FileEpisodesEditor, { fileId: 'unlinked-file', selectSeries: true, onClose: vi.fn() });
    await screen.findByRole('searchbox', { name: 'Search for a series' });
    expect(api.getFileEpisodes).not.toHaveBeenCalled();
    await chooseTarget();
    await waitFor(() =>
        expect(api.getFileEpisodes).toHaveBeenCalledWith('canonical', 'unlinked-file'),
    );
    expect(api.setFileEpisodes).not.toHaveBeenCalled();
});

it('renders unknown cut placeholders after adding an episode and keeps Save and preview disabled', async () => {
    api.getFileEpisodes.mockResolvedValue({ data: { ...pair, links: pair.links.slice(0, 1) } });
    const view = render(FileEpisodesEditor, {
        mediaId: 'source',
        fileId: 'file',
        onClose: vi.fn(),
    });
    const picker = await screen.findByRole('combobox', { name: 'Choose an episode…' });
    await fireEvent.change(picker, { target: { value: 'second' } });
    await fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(view.container.textContent).not.toContain('NaN');
    expect(screen.getAllByRole('listitem')[0].textContent).toContain('0:00–—');
    expect(screen.getByLabelText<HTMLInputElement>('Episode 2 starts at').value).toBe('');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Save links' }).disabled).toBe(
        true,
    );
    expect(
        screen.getByRole<HTMLButtonElement>('button', { name: 'Preview the boundary' }).disabled,
    ).toBe(true);
});

it('retains chapter milliseconds through editable text and saving', async () => {
    api.getFileEpisodes.mockResolvedValue({
        data: { ...pair, chapters: [{ name: 'Exact cut', startMs: 30123 }] },
    });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    await screen.findByLabelText('Episode 2 starts at');
    await fireEvent.click(screen.getByRole('button', { name: 'From chapters' }));
    const input = screen.getByLabelText<HTMLInputElement>('Episode 2 starts at');
    expect(input.value).toBe('0:30.123');
    await fireEvent.input(input, { target: { value: input.value } });
    await fireEvent.click(screen.getByRole('button', { name: 'Save links' }));
    await waitFor(() => expect(api.setFileEpisodes).toHaveBeenCalledOnce());
    expect(api.setFileEpisodes.mock.calls[0][2].episodes[0].endMs).toBe(30123);
    expect(api.setFileEpisodes.mock.calls[0][2].episodes[1].startMs).toBe(30123);
});

it('requires deliberate restoration of each selected dismissed episode and resets consent on evidence reload', async () => {
    const dismissed = {
        ...pair,
        episodes: pair.episodes.map((ep) => ({
            ...ep,
            isDismissed: true,
            dismissedAt: '2026-10-01',
        })),
    };
    api.getFileEpisodes.mockResolvedValue({ data: dismissed });
    api.setFileEpisodes.mockResolvedValueOnce({ data: null, status: 409 });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    const first = await screen.findByRole('checkbox', { name: /Restore dismissed episode S01E01/ });
    const second = screen.getByRole('checkbox', { name: /Restore dismissed episode S01E02/ });
    const save = screen.getByRole<HTMLButtonElement>('button', { name: 'Save links' });
    expect(save.disabled).toBe(true);
    await fireEvent.click(first);
    expect(save.disabled).toBe(true);
    await fireEvent.click(second);
    expect(save.disabled).toBe(false);
    await fireEvent.click(save);
    await screen.findByText(/The file or episode mapping changed/);
    expect(api.setFileEpisodes.mock.calls[0][2].restoreDismissedEpisodeIds).toEqual([
        'old',
        'second',
    ]);
    await fireEvent.click(screen.getByRole('button', { name: 'Reload episodes' }));
    await screen.findByText(/Current evidence reloaded/);
    expect(save.disabled).toBe(true);
    expect(
        screen.getByRole<HTMLInputElement>('checkbox', { name: /Restore dismissed episode S01E01/ })
            .checked,
    ).toBe(false);
});

it('restores the previous saved mapping through Undo and refreshes the visible episode', async () => {
    const undoId = '00000000-0000-4000-8000-000000000007';
    api.getFileEpisodes.mockResolvedValue({ data: { ...source, undoId } });
    const earlier = {
        ...source,
        links: [{ ...source.links[0], mediaItemId: 'earlier', title: 'Before the repair' }],
        episodes: [{ ...source.episodes[0], id: 'earlier', title: 'Before the repair' }],
    };
    api.undoFileEpisodes.mockResolvedValue({ data: earlier });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    const undo = await screen.findByRole('button', { name: 'Undo file mapping' });
    await waitFor(() => expect((undo as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.click(undo);
    await screen.findByText('S01E01 — Before the repair', { selector: 'span' });
    expect(api.undoFileEpisodes).toHaveBeenCalledExactlyOnceWith('source', 'file', undoId);
    expect(screen.queryByRole('button', { name: 'Undo file mapping' })).toBeNull();
});

it('protects an unsaved episode cut from being discarded by saved-mapping Undo', async () => {
    api.getFileEpisodes.mockResolvedValue({
        data: { ...pair, undoId: '00000000-0000-4000-8000-000000000008' },
    });
    render(FileEpisodesEditor, { mediaId: 'source', fileId: 'file', onClose: vi.fn() });
    const undo = await screen.findByRole('button', { name: 'Undo file mapping' });
    await waitFor(() => expect((undo as HTMLButtonElement).disabled).toBe(false));
    await fireEvent.input(screen.getByLabelText('Episode 2 starts at'), {
        target: { value: '0:20.0' },
    });
    expect((undo as HTMLButtonElement).disabled).toBe(true);
    await fireEvent.click(undo);
    expect(api.undoFileEpisodes).not.toHaveBeenCalled();
    expect((screen.getByLabelText('Episode 2 starts at') as HTMLInputElement).value).toBe('0:20.0');
});
