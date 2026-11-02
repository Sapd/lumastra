// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

import { render, fireEvent, screen } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Credit review has its own component/API coverage; isolate title-confirmation guards.
vi.mock('./ArtistCreditsEditor.svelte', () => ({ default: () => undefined }));
vi.mock('$app/navigation', () => ({ beforeNavigate: vi.fn() }));
const updateMediaMetadata = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/admin', () => ({ updateMediaMetadata }));
import OverviewTab from './OverviewTab.svelte';

const props = {
    mediaId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    title: 'Glass Harbour',
    titleSource: 'filename',
    year: 2011,
    overview: 'Keep this overview',
    locked: false,
    mediaType: 'track',
    status: 'active',
};

beforeEach(() => {
    vi.clearAllMocks();
    updateMediaMetadata.mockResolvedValue({ data: { locked: true }, error: null, status: 200 });
});

describe('reviewed filename title confirmation', () => {
    it('keeps provenance in an optional disclosure and confirms the exact unchanged title without sending other metadata', async () => {
        const onsaved = vi.fn();
        render(OverviewTab, { props: { ...props, onsaved } });
        expect(document.querySelector('details')?.open).toBe(false);
        await fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Save Changes' }).disabled,
        ).toBe(true);
        await fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        await vi.waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1));
        expect(updateMediaMetadata).toHaveBeenCalledExactlyOnceWith(props.mediaId, {
            confirmFilenameTitle: { title: 'Glass Harbour', source: 'filename', locked: false },
        });
        expect(screen.queryByRole('button', { name: 'Keep this title' })).toBeNull();
        expect(screen.getByText('Glass Harbour')).toBeTruthy();
    });

    it.each([
        { mediaType: 'movie' },
        { status: 'deleted' },
        { titleSource: 'tag' },
        { titleSource: undefined },
        { dismissed: true },
        { canonicalId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' },
    ])('offers no action for an ineligible detail %#', (override) => {
        render(OverviewTab, { props: { ...props, ...override } });
        expect(screen.queryByRole('button', { name: 'Keep this title' })).toBeNull();
    });

    it('never submits in-progress normal edits as confirmation', async () => {
        render(OverviewTab, { props });
        await fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
        await fireEvent.input(document.querySelector('input#edit-title')!, {
            target: { value: 'Unsaved title' },
        });
        expect(screen.queryByRole('button', { name: 'Keep this title' })).toBeNull();
        expect(updateMediaMetadata).not.toHaveBeenCalled();
    });

    it('disables pending actions and submits only once', async () => {
        let resolve!: (value: object) => void;
        updateMediaMetadata.mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        render(OverviewTab, { props });
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        const pending = screen.getByRole<HTMLButtonElement>('button', { name: 'Confirming…' });
        expect(pending.disabled).toBe(true);
        expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Edit$/ }).disabled).toBe(
            true,
        );
        await fireEvent.click(pending);
        expect(updateMediaMetadata).toHaveBeenCalledTimes(1);
        resolve({ data: { locked: true }, error: null, status: 200 });
        await vi.waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Confirming…' })).toBeNull(),
        );
    });

    it('retains filename provenance as disclosure for an already protected title without asking to keep it again', () => {
        render(OverviewTab, {
            props: { ...props, locked: true, lockedBy: 'earlier curator', lockedAt: '1' },
        });
        expect(screen.getByText(/This title came from the filename/)).toBeTruthy();
        expect(screen.queryByText('Keep this title')).toBeNull();
        expect(updateMediaMetadata).not.toHaveBeenCalled();
    });

    it('shows a conflict and requires reload before a fresh review can be submitted', async () => {
        updateMediaMetadata.mockResolvedValueOnce({ data: null, error: 'conflict', status: 409 });
        const onsaved = vi.fn();
        const { rerender } = render(OverviewTab, { props: { ...props, onsaved } });
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        await vi.waitFor(() =>
            expect(screen.getByRole('alert').textContent).toContain('protection changed'),
        );
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Keep this title' }).disabled,
        ).toBe(true);
        expect(onsaved).not.toHaveBeenCalled();
        onsaved.mockImplementation(async () => {
            await rerender({ ...props, title: 'New reviewed title', onsaved });
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Reload title' }));
        await vi.waitFor(() =>
            expect(
                screen.getByRole<HTMLButtonElement>('button', { name: 'Keep this title' }).disabled,
            ).toBe(false),
        );
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        expect(updateMediaMetadata).toHaveBeenLastCalledWith(props.mediaId, {
            confirmFilenameTitle: {
                title: 'New reviewed title',
                source: 'filename',
                locked: false,
            },
        });
    });

    it.each(['denied', 'network', 'unprotected'] as const)(
        'shows a truthful %s failure without claiming protection or reloading',
        async (kind) => {
            if (kind === 'denied')
                updateMediaMetadata.mockResolvedValueOnce({
                    data: null,
                    error: 'denied',
                    status: 403,
                });
            else if (kind === 'unprotected')
                updateMediaMetadata.mockResolvedValueOnce({
                    data: { locked: false },
                    error: null,
                    status: 200,
                });
            else updateMediaMetadata.mockRejectedValueOnce(new Error('network'));
            const onsaved = vi.fn();
            render(OverviewTab, { props: { ...props, onsaved } });
            document.querySelectorAll('details').forEach((detail) => {
                detail.open = true;
            });
            await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
            await vi.waitFor(() =>
                expect(screen.getByRole('alert').textContent).toContain('Could not confirm'),
            );
            expect(onsaved).not.toHaveBeenCalled();
            expect(screen.queryByText(/Metadata is locked/)).toBeNull();
            expect(
                screen.getByRole<HTMLButtonElement>('button', { name: 'Keep this title' }).disabled,
            ).toBe(true);
        },
    );

    it('reports a failed refresh after persistence and does not resubmit the saved confirmation', async () => {
        const onsaved = vi.fn().mockRejectedValue(new Error('reload failed'));
        render(OverviewTab, { props: { ...props, onsaved } });
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        await vi.waitFor(() =>
            expect(screen.getByRole('alert').textContent).toContain('page could not reload'),
        );
        expect(screen.queryByRole('button', { name: 'Keep this title' })).toBeNull();
        onsaved.mockResolvedValue(undefined);
        await fireEvent.click(screen.getByRole('button', { name: 'Reload title' }));
        await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
        expect(updateMediaMetadata).toHaveBeenCalledTimes(1);
    });

    it('labels a manual reload truthfully and blocks confirmation until it finishes', async () => {
        updateMediaMetadata.mockResolvedValueOnce({ data: null, error: 'conflict', status: 409 });
        let finishReload!: () => void;
        const onsaved = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishReload = resolve;
                }),
        );
        render(OverviewTab, { props: { ...props, onsaved } });
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        await vi.waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: 'Reload title' }));
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Loading...' }).disabled).toBe(
            true,
        );
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Keep this title' }).disabled,
        ).toBe(true);
        expect(screen.queryByRole('button', { name: 'Confirming…' })).toBeNull();
        finishReload();
        await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    it('clears an old confirmation conflict after an ordinary save and successful reload', async () => {
        updateMediaMetadata.mockResolvedValueOnce({ data: null, error: 'conflict', status: 409 });
        render(OverviewTab, { props: { ...props, onsaved: vi.fn() } });
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        await vi.waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
        await fireEvent.input(
            document.querySelector('input#edit-overview, textarea#edit-overview')!,
            { target: { value: 'New note' } },
        );
        await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
        await vi.waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    });

    it('keeps save and confirmation interlocked until the committed save refresh settles', async () => {
        let done!: () => void;
        const onsaved = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    done = resolve;
                }),
        );
        render(OverviewTab, { props: { ...props, onsaved } });
        await fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
        await fireEvent.input(document.querySelector('textarea#edit-overview')!, {
            target: { value: 'New overview' },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
        await vi.waitFor(() => expect(onsaved).toHaveBeenCalledTimes(1));
        expect(screen.queryByText('Keep this title')).toBeNull();
        expect(screen.getByRole<HTMLButtonElement>('button', { name: /^Edit$/ }).disabled).toBe(
            true,
        );
        done();
    });

    it('does not let Reload race an ordinary save', async () => {
        updateMediaMetadata.mockResolvedValueOnce({ data: null, error: 'conflict', status: 409 });
        let completeSave!: (value: object) => void;
        const onsaved = vi.fn();
        render(OverviewTab, { props: { ...props, onsaved } });
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        await vi.waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
        await fireEvent.input(document.querySelector('textarea#edit-overview')!, {
            target: { value: 'New overview' },
        });
        updateMediaMetadata.mockReturnValueOnce(
            new Promise((resolve) => {
                completeSave = resolve;
            }),
        );
        await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
        const reload = screen.getByRole<HTMLButtonElement>('button', { name: 'Reload title' });
        expect(reload.disabled).toBe(true);
        await fireEvent.click(reload);
        expect(onsaved).not.toHaveBeenCalled();
        completeSave({ data: { locked: true }, error: null, status: 200 });
    });

    it('never attributes a committed confirmation to the previous actor after refresh failure', async () => {
        render(OverviewTab, {
            props: {
                ...props,
                locked: false,
                lockedBy: 'previous-admin',
                onsaved: vi.fn().mockRejectedValue(new Error('reload')),
            },
        });
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        await vi.waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
        expect(screen.queryByText(/previous-admin/)).toBeNull();
    });
    it('requires a successful reload after an uncertain confirmation and a failed reload', async () => {
        updateMediaMetadata.mockRejectedValueOnce(new Error('lost response'));
        const onsaved = vi.fn().mockRejectedValueOnce(new Error('reload failed'));
        render(OverviewTab, { props: { ...props, onsaved } });
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        await vi.waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: 'Reload title' }));
        await vi.waitFor(() =>
            expect(screen.getByRole('alert').textContent).toContain('page could not reload'),
        );
        expect(
            screen.getByRole<HTMLButtonElement>('button', { name: 'Keep this title' }).disabled,
        ).toBe(true);
        document.querySelectorAll('details').forEach((detail) => {
            detail.open = true;
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Keep this title' }));
        expect(updateMediaMetadata).toHaveBeenCalledTimes(1);
        onsaved.mockResolvedValue(undefined);
        await fireEvent.click(screen.getByRole('button', { name: 'Reload title' }));
        await vi.waitFor(() =>
            expect(
                screen.getByRole<HTMLButtonElement>('button', { name: 'Keep this title' }).disabled,
            ).toBe(false),
        );
    });

    it('blocks confirmation after a committed ordinary save until its failed refresh is recovered', async () => {
        const onsaved = vi.fn().mockRejectedValueOnce(new Error('reload failed'));
        render(OverviewTab, { props: { ...props, onsaved } });
        await fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
        await fireEvent.input(document.querySelector('textarea#edit-overview')!, {
            target: { value: 'New overview' },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
        await vi.waitFor(() =>
            expect(screen.getByRole('alert').textContent).toContain('page could not reload'),
        );
        expect(screen.queryByText('Keep this title')).toBeNull();
        expect(updateMediaMetadata).toHaveBeenCalledTimes(1);
        onsaved.mockResolvedValue(undefined);
        await fireEvent.click(screen.getByRole('button', { name: 'Reload title' }));
        await vi.waitFor(() => expect(screen.queryByText('Keep this title')).toBeNull());
    });
    it.each(['network', 'rejected'] as const)(
        'keeps an uncertain ordinary %s save blocked from confirmation until reload',
        async (kind) => {
            if (kind === 'network')
                updateMediaMetadata.mockRejectedValueOnce(new Error('lost response'));
            else
                updateMediaMetadata.mockResolvedValueOnce({
                    data: null,
                    error: 'unavailable',
                    status: 503,
                });
            const onsaved = vi.fn();
            render(OverviewTab, { props: { ...props, onsaved } });
            await fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
            await fireEvent.input(document.querySelector('textarea#edit-overview')!, {
                target: { value: 'New overview' },
            });
            await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
            await vi.waitFor(() =>
                expect(screen.getByRole('alert').textContent).toContain('Failed to save metadata'),
            );
            await fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
            expect(
                screen.getByRole<HTMLButtonElement>('button', { name: 'Keep this title' }).disabled,
            ).toBe(true);
            await fireEvent.click(screen.getByRole('button', { name: 'Reload title' }));
            await vi.waitFor(() =>
                expect(
                    screen.getByRole<HTMLButtonElement>('button', { name: 'Keep this title' })
                        .disabled,
                ).toBe(false),
            );
            expect(updateMediaMetadata).toHaveBeenCalledTimes(1);
        },
    );
});
