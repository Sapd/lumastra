// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, fireEvent } from '@testing-library/svelte';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import ImageCandidates from './ImageCandidates.svelte';
import { getImageCandidates, curateImageCandidates } from '$lib/api/image-candidates.js';
vi.mock('$lib/api/image-candidates.js', () => ({
    getImageCandidates: vi.fn(),
    curateImageCandidates: vi.fn(),
}));
const candidate = {
    id: '11111111-1111-4111-8111-111111111111',
    media_item_id: '22222222-2222-4222-8222-222222222222',
    artwork_type: 'poster' as const,
    provider: 'tmdb' as const,
    provider_ref: '/cover.jpg',
    language: 'en',
    width: 500,
    height: 750,
    chosen_by: 'admin' as const,
    fetched_at: '2026-10-24T12:00:00Z',
    locked: false,
    selected: true,
    sort_order: 0,
    file_path: null,
    remote_url: null,
};
beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getImageCandidates).mockResolvedValue({
        status: 200,
        error: null,
        data: { candidates: [candidate], applied: false },
    });
});
describe('image provenance controls', () => {
    it('shows canonical selected backdrop positions but keeps singleton posters concise', async () => {
        const poster = { ...candidate, selection_order: 0 };
        const backdrops = [
            {
                ...candidate,
                id: '33333333-3333-4333-8333-333333333333',
                artwork_type: 'backdrop' as const,
                selection_order: 0,
            },
            {
                ...candidate,
                id: '44444444-4444-4444-8444-444444444444',
                artwork_type: 'backdrop' as const,
                selection_order: 1,
            },
        ];
        vi.mocked(getImageCandidates).mockResolvedValue({
            status: 200,
            error: null,
            data: { candidates: [poster, ...backdrops], applied: false },
        });
        render(ImageCandidates, { mediaId: candidate.media_item_id });

        expect(await screen.findByText('Poster · Selected')).toBeTruthy();
        expect(screen.getByText('Background image · Selected #1')).toBeTruthy();
        expect(screen.getByText('Background image · Selected #2')).toBeTruthy();
    });

    it('keeps a chosen image during updates and restores the prior choice with one Undo', async () => {
        const saved = vi.fn();
        const undoId = '55555555-5555-4555-8555-555555555555';
        vi.mocked(curateImageCandidates)
            .mockResolvedValueOnce({
                status: 200,
                error: null,
                data: { candidates: [{ ...candidate, locked: true }], applied: true, undoId },
            })
            .mockResolvedValueOnce({
                status: 200,
                error: null,
                data: { candidates: [candidate], applied: true },
            });
        render(ImageCandidates, { mediaId: candidate.media_item_id, onsaved: saved });
        await screen.findByText('Source: tmdb');
        await fireEvent.click(screen.getByRole('button', { name: 'Use this image', hidden: true }));
        expect(curateImageCandidates).toHaveBeenCalledWith(candidate.media_item_id, {
            action: 'select',
            candidateId: candidate.id,
            locked: true,
        });
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Undo artwork choice / show again' }),
        );
        expect(curateImageCandidates).toHaveBeenLastCalledWith(candidate.media_item_id, {
            action: 'undo',
            receiptId: undoId,
        });
        expect(saved).toHaveBeenCalledTimes(2);
    });
    it('hides a source across all image types in one recoverable action without a removal review', async () => {
        vi.mocked(curateImageCandidates).mockResolvedValue({
            status: 200,
            error: null,
            data: {
                candidates: [{ ...candidate, suppressed: true, selected: false }],
                applied: true,
                undoId: '55555555-5555-4555-8555-555555555555',
            },
        });
        render(ImageCandidates, { mediaId: candidate.media_item_id });
        await screen.findByText('Source: tmdb');
        await fireEvent.click(
            screen.getByRole('button', {
                name: 'Stop using tmdb for all pictures of this title',
                hidden: true,
            }),
        );
        expect(curateImageCandidates).toHaveBeenCalledExactlyOnceWith(candidate.media_item_id, {
            action: 'suppress-provider',
            provider: 'tmdb',
        });
        expect(
            await screen.findByRole('button', { name: 'Undo artwork choice / show again' }),
        ).toBeTruthy();
        expect(screen.queryByText('Apply removal')).toBeNull();
    });
    it('offers a saved receipt after reopening and reports a conflict without replaying the mutation', async () => {
        const undoId = '55555555-5555-4555-8555-555555555555';
        vi.mocked(getImageCandidates).mockResolvedValue({
            status: 200,
            error: null,
            data: { candidates: [candidate], applied: false, undoId },
        });
        vi.mocked(curateImageCandidates).mockResolvedValue({
            status: 409,
            error: 'Artwork changed',
            data: null,
        });
        render(ImageCandidates, { mediaId: candidate.media_item_id });
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Undo artwork choice / show again' }),
        );
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(curateImageCandidates).toHaveBeenCalledOnce();
    });
});
