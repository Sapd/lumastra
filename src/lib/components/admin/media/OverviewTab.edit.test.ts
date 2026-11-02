// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, fireEvent, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';

vi.mock('$app/navigation', () => ({ goto: vi.fn(), beforeNavigate: vi.fn() }));
const updateMediaMetadata = vi.hoisted(() => vi.fn(async () => ({ data: {}, error: null })));
vi.mock('$lib/api/admin', () => ({ updateMediaMetadata }));

import OverviewTab from './OverviewTab.svelte';

const props = {
    mediaId: 'abc-123',
    title: 'The Great Movie',
    year: 1999,
    overview: 'Once upon a time.',
    locked: false,
    mediaType: 'movie',
};

/** Triage spec §7: metadata is read-only until the operator clicks Edit. */
describe('OverviewTab read-only by default', () => {
    it('shows the values as text and no form until Edit', async () => {
        render(OverviewTab, { props });
        expect(screen.getByText('The Great Movie')).toBeTruthy();
        expect(screen.getByText('Once upon a time.')).toBeTruthy();
        expect(document.querySelector('input#edit-title')).toBeNull();
        expect(screen.queryByText('Save Changes')).toBeNull();

        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        expect(document.querySelector<HTMLInputElement>('input#edit-title')?.value).toBe(
            'The Great Movie',
        );
        expect(screen.getByText('Save Changes')).toBeTruthy();
    });

    it('Cancel leaves edit mode and discards the change', async () => {
        render(OverviewTab, { props });
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        const input = document.querySelector<HTMLInputElement>('input#edit-title')!;
        await fireEvent.input(input, { target: { value: 'Changed' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
        expect(document.querySelector('input#edit-title')).toBeNull();
        expect(screen.getByText('The Great Movie')).toBeTruthy();
        expect(updateMediaMetadata).not.toHaveBeenCalled();
    });

    it('Save sends the change and returns to read-only', async () => {
        render(OverviewTab, { props });
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        const input = document.querySelector<HTMLInputElement>('input#edit-title')!;
        await fireEvent.input(input, { target: { value: 'New Title' } });
        await fireEvent.click(screen.getByText('Save Changes'));
        await vi.waitFor(() => expect(updateMediaMetadata).toHaveBeenCalled());
        await vi.waitFor(() => expect(document.querySelector('input#edit-title')).toBeNull());
    });

    it('does not turn an untouched null overview into an empty-string update', async () => {
        updateMediaMetadata.mockClear();
        render(OverviewTab, { props: { ...props, overview: null } });
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await fireEvent.input(document.querySelector<HTMLInputElement>('input#edit-title')!, {
            target: { value: 'Renamed' },
        });
        await fireEvent.click(screen.getByText('Save Changes'));

        await vi.waitFor(() => expect(updateMediaMetadata).toHaveBeenCalledTimes(1));
        expect(updateMediaMetadata).toHaveBeenCalledWith(
            'abc-123',
            expect.not.objectContaining({ overview: expect.anything() }),
        );
        expect(updateMediaMetadata).toHaveBeenCalledWith(
            'abc-123',
            expect.objectContaining({ title: 'Renamed', releaseYear: 1999 }),
        );
    });

    it('sends a deliberate overview edit, including clearing existing text', async () => {
        updateMediaMetadata.mockClear();
        render(OverviewTab, { props });
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await fireEvent.input(document.querySelector<HTMLTextAreaElement>('#edit-overview')!, {
            target: { value: '' },
        });
        await fireEvent.input(document.querySelector<HTMLInputElement>('input#edit-title')!, {
            target: { value: 'Renamed' },
        });
        await fireEvent.click(screen.getByText('Save Changes'));

        await vi.waitFor(() => expect(updateMediaMetadata).toHaveBeenCalledTimes(1));
        expect(updateMediaMetadata).toHaveBeenCalledWith(
            'abc-123',
            expect.objectContaining({ title: 'Renamed', overview: '' }),
        );
    });

    it('shows a populated synopsis without the empty-overview message', () => {
        render(OverviewTab, { props });
        expect(screen.getByText('Once upon a time.')).toBeTruthy();
        expect(screen.queryByText('No description yet. Add one with Edit metadata.')).toBeNull();
    });
});

describe('OverviewTab keeps edits in progress', () => {
    function titleInput(): HTMLInputElement {
        return document.querySelector<HTMLInputElement>('input#edit-title')!;
    }

    it('a props refresh while editing (e.g. after an unlock) keeps the typed text', async () => {
        const { rerender } = render(OverviewTab, { props });
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await fireEvent.input(titleInput(), { target: { value: 'Half typed' } });

        await rerender({ ...props, locked: true, lockedBy: 'admin' });

        expect(titleInput().value).toBe('Half typed');
    });

    it('text typed while the save runs stays open and unsaved', async () => {
        let resolveSave!: (value: { data: object; error: null }) => void;
        updateMediaMetadata.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveSave = resolve;
                }),
        );
        render(OverviewTab, { props });
        await fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
        await fireEvent.input(titleInput(), { target: { value: 'Sent' } });
        await fireEvent.click(screen.getByText('Save Changes'));
        await fireEvent.input(titleInput(), { target: { value: 'Sent and more' } });

        resolveSave({ data: {}, error: null });

        await vi.waitFor(() => expect(updateMediaMetadata).toHaveBeenCalled());
        await new Promise((r) => setTimeout(r, 0));
        expect(titleInput().value).toBe('Sent and more');
        expect(updateMediaMetadata).toHaveBeenLastCalledWith(
            'abc-123',
            expect.objectContaining({ title: 'Sent' }),
        );
    });
});
