// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AlbumMergePreview } from '$lib/schemas/album-merge.js';
import AlbumMerge from './AlbumMerge.svelte';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('$lib/api/client.js', () => ({ apiGet: get, apiPost: post }));
const source = '10000000-0000-4000-8000-000000000001';
const target = '10000000-0000-4000-8000-000000000002';
function preview(locked = false): AlbumMergePreview {
    const album = (id: string) => ({
        id,
        title: id === source ? 'Source' : 'Target',
        createdAt: '2026-01-01T00:00:00Z',
        parentId: null,
        parentTitle: 'Artist',
        trackCount: 2,
        metadataLocked: locked,
    });
    return {
        keepId: target,
        mergeId: source,
        survivor: album(target),
        removed: album(source),
        tracksToMove: [
            { id: source, title: 'Moving song', albumId: source, disc: '1', number: '1' },
        ],
        trackCount: 1,
        resultingTrackCount: 3,
        resultingTitle: 'Target',
        duplicateCandidates: [],
        parentArtist: { id: null, title: 'Artist', various: false, source: 'album-tag' },
        selectedImages: [],
        metadataKeys: { filled: [], conflicts: [] },
        albumData: [],
        locks: { requiresOverride: locked, overridden: false, resultingLocked: locked },
        previewToken: 'a'.repeat(64),
    };
}
beforeEach(() => {
    get.mockReset();
    post.mockReset();
});
afterEach(cleanup);
describe('album merge flow', () => {
    it('searches albums, previews a target, then sends the exact preview token only on confirmation', async () => {
        const onmerged = vi.fn();
        get.mockResolvedValue({
            data: {
                results: [
                    { id: target, title: 'Target', mediaType: 'album', parentTitle: 'Artist' },
                ],
            },
            error: null,
        });
        post.mockResolvedValueOnce({
            data: { applied: false, preview: preview() },
            error: null,
        }).mockResolvedValueOnce({ data: { applied: true, preview: preview() }, error: null });
        render(AlbumMerge, { albumId: source, onmerged });
        await fireEvent.click(screen.getByRole('button', { name: 'Merge into…' }));
        await fireEvent.input(screen.getByRole('textbox'), { target: { value: 'Target' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Search target album' }));
        await fireEvent.click(await screen.findByRole('button', { name: /Target · Artist/ }));
        await screen.findByText('Resulting album artist: Artist');
        expect(post).toHaveBeenCalledTimes(1);
        expect(post.mock.calls[0][2]).toMatchObject({
            mode: 'preview',
            keepId: source,
            mergeId: target,
        });
        expect(onmerged).not.toHaveBeenCalled();
        await fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed/ }));
        await fireEvent.input(
            screen.getByRole('textbox', { name: 'Type the removed album title to confirm' }),
            { target: { value: 'Source' } },
        );
        await fireEvent.click(screen.getByRole('button', { name: 'Confirm album merge' }));
        await waitFor(() => expect(onmerged).toHaveBeenCalledWith(target));
        expect(post.mock.calls[1][2]).toMatchObject({
            mode: 'apply',
            keepId: source,
            mergeId: target,
            previewToken: 'a'.repeat(64),
        });
    });
    it('opens health-check pairs directly and refreshes the preview for an explicit lock override', async () => {
        post.mockResolvedValue({ data: { applied: false, preview: preview(true) }, error: null });
        render(AlbumMerge, { albumId: source, initialTarget: target, onmerged: vi.fn() });
        const button = await screen.findByRole('button', { name: 'Confirm album merge' });
        expect((button as HTMLButtonElement).disabled).toBe(true);
        await fireEvent.click(
            screen.getByRole('checkbox', { name: 'Override metadata locks for this merge' }),
        );
        await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
        expect(post.mock.calls[1][2]).toMatchObject({ mode: 'preview', overrideLocks: true });
    });
    it('changes the survivor by refreshing the plan and disables confirmation after a stale apply', async () => {
        post.mockResolvedValueOnce({ data: { applied: false, preview: preview() }, error: null })
            .mockResolvedValueOnce({ data: { applied: false, preview: preview() }, error: null })
            .mockResolvedValueOnce({
                data: null,
                error: 'The albums changed. Preview the merge again',
                status: 409,
            });
        const onmerged = vi.fn();
        render(AlbumMerge, { albumId: source, initialTarget: target, onmerged });
        const select = await screen.findByRole('combobox');
        await fireEvent.change(select, { target: { value: source } });
        await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
        expect(post.mock.calls[1][2]).toMatchObject({ survivorId: source, mode: 'preview' });
        await screen.findByRole('button', { name: 'Confirm album merge' });
        await fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed/ }));
        await fireEvent.input(
            screen.getByRole('textbox', { name: 'Type the removed album title to confirm' }),
            { target: { value: 'Source' } },
        );
        await fireEvent.click(screen.getByRole('button', { name: 'Confirm album merge' }));
        await screen.findByRole('alert');
        expect(screen.queryByRole('button', { name: 'Confirm album merge' })).toBeNull();
        expect(onmerged).not.toHaveBeenCalled();
    });
});

it('can hide its standalone trigger while keeping explicit and deep-link opening available', async () => {
    const view = render(AlbumMerge, { albumId: source, hideTrigger: true, onmerged: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Merge into…' })).toBeNull();
    view.component.show();
    expect(await screen.findByRole('region', { name: 'Merge into…' })).toBeTruthy();
});

it('resets acknowledgment on new preview and ignores an apply response after route replacement', async () => {
    let finish!: (value: unknown) => void;
    post.mockResolvedValueOnce({
        data: { preview: preview(), applied: false },
    }).mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                finish = resolve;
            }),
    );
    const onmerged = vi.fn();
    const view = render(AlbumMerge, { albumId: source, initialTarget: target, onmerged });
    await screen.findByRole('button', { name: 'Confirm album merge' });
    await fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed/ }));
    await fireEvent.input(
        screen.getByRole('textbox', { name: 'Type the removed album title to confirm' }),
        { target: { value: 'Source' } },
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Confirm album merge' }));
    await view.rerender({ albumId: target, initialTarget: target, onmerged });
    finish({ data: { applied: true, preview: preview() } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onmerged).not.toHaveBeenCalled();
    expect(screen.queryByRole('checkbox', { name: /I reviewed/ })).toBeNull();
});

it('clears typed title and acknowledgment when override refreshes a preview with the same removed title', async () => {
    post.mockResolvedValue({ data: { applied: false, preview: preview(true) } });
    render(AlbumMerge, { albumId: source, initialTarget: target, onmerged: vi.fn() });
    await screen.findByRole('button', { name: 'Confirm album merge' });
    await fireEvent.click(screen.getByRole('checkbox', { name: /I reviewed/ }));
    await fireEvent.input(
        screen.getByRole('textbox', { name: 'Type the removed album title to confirm' }),
        { target: { value: 'Source' } },
    );
    await fireEvent.click(
        screen.getByRole('checkbox', { name: 'Override metadata locks for this merge' }),
    );
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await waitFor(() =>
        expect(
            (screen.getByRole('checkbox', { name: /I reviewed/ }) as HTMLInputElement).checked,
        ).toBe(false),
    );
    expect(
        (
            screen.getByRole('textbox', {
                name: 'Type the removed album title to confirm',
            }) as HTMLInputElement
        ).value,
    ).toBe('');
    expect(
        (screen.getByRole('button', { name: 'Confirm album merge' }) as HTMLButtonElement).disabled,
    ).toBe(true);
});

it('runs the target search when Enter is pressed in the search field', async () => {
    get.mockResolvedValue({ data: { results: [] }, error: null });
    render(AlbumMerge, { albumId: source, onmerged: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Merge into…' }));
    const user = userEvent.setup();
    await user.type(screen.getByRole('textbox', { name: 'Search target album' }), 'Target{Enter}');
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    expect(get.mock.calls[0][0]).toContain('q=Target');
});

it('scrolls the opened merge panel into view and focuses its search field', async () => {
    Element.prototype.scrollIntoView ??= vi.fn();
    const scroll = vi.spyOn(Element.prototype, 'scrollIntoView');
    render(AlbumMerge, { albumId: source, onmerged: vi.fn() });
    await fireEvent.click(screen.getByRole('button', { name: 'Merge into…' }));
    const input = screen.getByRole('textbox', { name: 'Search target album' });
    await waitFor(() => expect(document.activeElement).toBe(input));
    expect(scroll).toHaveBeenCalledWith({ block: 'nearest' });
    expect(scroll.mock.contexts).toContain(screen.getByRole('region', { name: 'Merge into…' }));
});

it('shows a many-album release preview with no many-way Apply or mutation', async () => {
    get.mockResolvedValue({
        data: {
            groups: [
                {
                    albums: [
                        { id: source, title: 'Invented Collection', artistTitle: 'Cedar' },
                        { id: target, title: 'Invented Collection', artistTitle: 'Lumen' },
                        {
                            id: '10000000-0000-4000-8000-000000000003',
                            title: 'Invented Collection',
                            artistTitle: 'Sable',
                        },
                    ],
                    trackCount: 18,
                },
            ],
            skipped: [],
            truncated: false,
        },
    });
    const onmerged = vi.fn();
    render(AlbumMerge, { albumId: source, onmerged });
    await fireEvent.click(screen.getByRole('button', { name: 'Merge into…' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Preview albums from this release' }));
    expect(await screen.findByText('18 tracks would belong to this release.')).toBeTruthy();
    expect(screen.getAllByRole('link', { name: 'Invented Collection' })).toHaveLength(3);
    expect(screen.queryByRole('button', { name: 'Confirm album merge' })).toBeNull();
    expect(post).not.toHaveBeenCalled();
    expect(onmerged).not.toHaveBeenCalled();
});
