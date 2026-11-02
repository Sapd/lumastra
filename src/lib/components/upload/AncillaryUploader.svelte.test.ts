// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/svelte';
import { it, expect, vi, afterEach } from 'vitest';
const api = vi.hoisted(() => ({ upload: vi.fn(), undo: vi.fn() }));
vi.mock('$lib/api/admin.js', () => ({
    uploadAncillaryFile: api.upload,
    undoUploadedChapterFile: api.undo,
}));
import AncillaryUploader from './AncillaryUploader.svelte';
afterEach(cleanup);
it('offers chapter recovery and sends the exact receipt in the original upload context', async () => {
    api.upload.mockResolvedValue({
        data: {
            path: '/library/Lantern.chapters.json',
            type: 'chapter',
            undoId: 'chapter-receipt',
        },
    });
    api.undo.mockResolvedValue({
        data: { path: '/library/Lantern.chapters.json', type: 'chapter' },
    });
    const complete = vi.fn();
    render(AncillaryUploader, {
        libraryPathId: 'library',
        mediaItemId: 'episode',
        uploadId: 'session',
        onComplete: complete,
    });
    const type = screen.getByLabelText('File type') as HTMLSelectElement;
    type.selectedIndex = 1;
    await fireEvent.change(type);
    await fireEvent.change(screen.getByLabelText('File'), {
        target: {
            files: [new File(['[]'], 'Lantern.chapters.json', { type: 'application/json' })],
        },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Attach' }));
    await screen.findByRole('button', { name: 'Undo chapter changes' });
    await fireEvent.click(screen.getByRole('button', { name: 'Attach another file' }));
    await fireEvent.click(screen.getByRole('button', { name: 'Undo chapter changes' }));
    await waitFor(() =>
        expect(api.undo).toHaveBeenCalledWith('library', 'episode', 'chapter-receipt', 'session'),
    );
    await waitFor(() => expect(complete).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Undo chapter changes' })).toBeNull();
});
