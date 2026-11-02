// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { render, screen, fireEvent } from '@testing-library/svelte';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readable, writable, type Writable } from 'svelte/store';
import { tick } from 'svelte';
import type { PageData } from './$types';
import * as m from '$lib/paraglide/messages';

const { updateMediaMetadata, unlockMediaMetadata, invalidateAll, successToast, errorToast } =
    vi.hoisted(() => ({
        updateMediaMetadata: vi.fn(),
        unlockMediaMetadata: vi.fn(),
        invalidateAll: vi.fn(),
        successToast: vi.fn(),
        errorToast: vi.fn(),
    }));
vi.mock('$app/navigation', () => ({
    goto: vi.fn(),
    beforeNavigate: vi.fn(),
    afterNavigate: vi.fn(),
    replaceState: vi.fn(),
    invalidateAll,
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$lib/stores/toast.store', () => ({
    toasts: { success: successToast, error: errorToast },
}));
vi.mock('$app/stores', () => ({
    page: writable({
        url: new URL('http://localhost/admin/library/media/aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'),
        data: {},
    }),
    navigating: readable(null),
}));
vi.mock('$lib/api/admin', async (original) => ({
    ...(await original<typeof import('$lib/api/admin')>()),
    updateMediaMetadata,
    unlockMediaMetadata,
}));
vi.mock(
    '$lib/components/admin/media/MusicHierarchySidebar.svelte',
    () => import('../__fixtures__/EmptyComponent.svelte'),
);
vi.mock(
    '$lib/components/admin/media/MediaHierarchySidebar.svelte',
    () => import('../__fixtures__/EmptyComponent.svelte'),
);
// This suite exercises Overview/header operation ownership. The credit editor
// has its own API and busy-state suites; mounting it here introduces unrelated
// real network reads and alerts during navigation and deferred saves.
vi.mock(
    '$lib/components/admin/media/ArtistCreditsEditor.svelte',
    () => import('../__fixtures__/EmptyComponent.svelte'),
);
import { page as routePage } from '$app/stores';
import { replaceState } from '$app/navigation';
import DetailPage from './+page.svelte';

const id = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const data = {
    mediaItem: {
        id,
        title: 'Glass Harbour',
        titleSource: 'filename',
        status: 'active',
        mediaType: 'track',
        dismissed: false,
    },
    lockStatus: { locked: false, lockedBy: null, lockedAt: null },
    parentChain: [],
    externalIds: {},
    issues: [],
    fileIssues: [],
    fileSummary: { count: 1, totalBytes: 123 },
    fileSummaryDetermined: true,
    sidebarEntryCount: 1,
    healthStatus: 'healthy',
    healthDetail: null,
    childCounts: null,
    activeRuns: [],
    maxImageUploadMb: 10,
} as unknown as PageData;

const lockedData = {
    ...data,
    lockStatus: { locked: true, lockedBy: 'previous-admin', lockedAt: '1792845296.123456' },
} as PageData;

function keepTitleButton(): HTMLButtonElement {
    const details = screen
        .getByText(m.media_overview_confirm_explanation(), { selector: 'summary' })
        .closest('details');
    if (!details) throw new Error('Missing optional title choice');
    details.open = true;
    return screen.getByRole<HTMLButtonElement>('button', {
        name: m.media_overview_confirm_title(),
    });
}

function setRouteUrl(href: string): void {
    (routePage as unknown as Writable<{ url: URL; data: object }>).set({
        url: new URL(href),
        data: {},
    });
}
beforeEach(() => {
    vi.clearAllMocks();
    setRouteUrl(`http://localhost/admin/library/media/${id}`);
    updateMediaMetadata.mockResolvedValue({ data: { locked: true }, error: null, status: 200 });
    unlockMediaMetadata.mockResolvedValue({ data: { locked: false }, error: null });
    invalidateAll.mockResolvedValue(undefined);
});

describe('real detail page and Overview confirmation wiring', () => {
    it('submits the unlocked snapshot and blocks both Unlock controls while the committed refresh settles', async () => {
        let complete!: (value: object) => void;
        let refreshed!: () => void;
        updateMediaMetadata.mockReturnValue(
            new Promise((resolve) => {
                complete = resolve;
            }),
        );
        invalidateAll.mockReturnValue(
            new Promise<void>((resolve) => {
                refreshed = resolve;
            }),
        );
        const view = render(DetailPage, { props: { data } });
        await fireEvent.click(keepTitleButton());
        expect(updateMediaMetadata).toHaveBeenCalledExactlyOnceWith(id, {
            confirmFilenameTitle: { title: 'Glass Harbour', source: 'filename', locked: false },
        });
        complete({ data: { locked: true }, error: null, status: 200 });
        await vi.waitFor(() => expect(invalidateAll).toHaveBeenCalledTimes(1));
        // Fresh lock data can arrive while invalidateAll is still pending.
        await view.rerender({ data: lockedData });
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Unlock' }).disabled).toBe(
            true,
        );
        await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        let headerUnlock = screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Unlock' });
        expect(headerUnlock.disabled).toBe(true);
        await fireEvent.click(headerUnlock);
        expect(unlockMediaMetadata).not.toHaveBeenCalled();
        headerUnlock.disabled = false;
        await fireEvent.click(headerUnlock);
        expect(unlockMediaMetadata).not.toHaveBeenCalled();
        await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        headerUnlock = screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Unlock' });
        expect(headerUnlock.disabled).toBe(true);
        refreshed();
        await vi.waitFor(() => expect(headerUnlock.disabled).toBe(false));
        await fireEvent.click(headerUnlock);
        await vi.waitFor(() => expect(unlockMediaMetadata).toHaveBeenCalledExactlyOnceWith(id));
    });

    it('does not offer Keep title for an already protected title', () => {
        render(DetailPage, { props: { data: lockedData } });
        expect(
            screen.queryByText(m.media_overview_confirm_title(), { selector: 'button' }),
        ).toBeNull();
    });

    it.each([{ dismissed: true }, { canonicalId: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' }])(
        'does not offer confirmation for actual ineligible page data %#',
        (extra) => {
            render(DetailPage, {
                props: { data: { ...data, mediaItem: { ...data.mediaItem, ...extra } } },
            });
            expect(
                screen.queryByText(m.media_overview_confirm_title(), { selector: 'button' }),
            ).toBeNull();
        },
    );
    it.each([
        ['confirm', false],
        ['confirm', true],
        ['save', false],
        ['save', true],
        ['reload', false],
        ['reload', true],
    ] as const)(
        'releases the original %s owner after A → B and ignores its late failure=%s result',
        async (operation, fails) => {
            let complete!: (value: object) => void;
            let reject!: (reason: Error) => void;
            const pending = new Promise<object>((resolve, fail) => {
                complete = resolve;
                reject = fail;
            });
            const page = render(DetailPage, {
                props: { data: operation === 'save' ? lockedData : data },
            });
            if (operation === 'reload') {
                updateMediaMetadata.mockResolvedValueOnce({
                    data: null,
                    error: 'conflict',
                    status: 409,
                });
                await fireEvent.click(keepTitleButton());
                await vi.waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
                invalidateAll.mockReturnValueOnce(pending);
                await fireEvent.click(screen.getByRole('button', { name: 'Reload title' }));
            } else {
                updateMediaMetadata.mockReturnValueOnce(pending);
                if (operation === 'save') {
                    await fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
                    await fireEvent.input(document.querySelector('textarea#edit-overview')!, {
                        target: { value: 'A changed overview' },
                    });
                    await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
                } else await fireEvent.click(keepTitleButton());
            }
            const other = {
                ...data,
                mediaItem: {
                    ...data.mediaItem,
                    id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                    title: 'Other track',
                },
                lockStatus: { locked: false, lockedBy: null },
            } as PageData;
            await page.rerender({ data: other });
            const refreshes = invalidateAll.mock.calls.length;
            const successes = successToast.mock.calls.length;
            const errors = errorToast.mock.calls.length;
            if (fails) reject(new Error('late A failure'));
            else complete({ data: { locked: true }, error: null, status: 200 });
            await pending.catch(() => undefined);
            await tick();
            expect(screen.getByText('Other track', { selector: 'h2' })).toBeTruthy();
            expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
            expect(screen.queryByText(/previous-admin/)).toBeNull();
            expect(screen.queryByRole('alert')).toBeNull();
            expect(invalidateAll).toHaveBeenCalledTimes(refreshes);
            expect(successToast).toHaveBeenCalledTimes(successes);
            expect(errorToast).toHaveBeenCalledTimes(errors);
            await page.rerender({ data: lockedData });
            await vi.waitFor(() =>
                expect(
                    screen.getByRole<HTMLButtonElement>('button', { name: 'Unlock' }).disabled,
                ).toBe(false),
            );
            await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
            expect(
                screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Unlock' }).disabled,
            ).toBe(false);
            page.unmount();
        },
    );

    it.each(['confirm', 'save'] as const)(
        'releases an abandoned %s while its committed refresh settles',
        async (operation) => {
            let finish!: () => void;
            let reject!: (reason: Error) => void;
            const pending = new Promise<void>((resolve, fail) => {
                finish = resolve;
                reject = fail;
            });
            invalidateAll.mockReturnValueOnce(pending);
            const page = render(DetailPage, {
                props: { data: operation === 'save' ? lockedData : data },
            });
            if (operation === 'save') {
                await fireEvent.click(screen.getByRole('button', { name: /^Edit$/ }));
                await fireEvent.input(document.querySelector('textarea#edit-overview')!, {
                    target: { value: 'A changed overview' },
                });
                await fireEvent.click(screen.getByRole('button', { name: 'Save Changes' }));
            } else await fireEvent.click(keepTitleButton());
            await vi.waitFor(() => expect(invalidateAll).toHaveBeenCalledTimes(1));
            await page.rerender({
                data: {
                    ...data,
                    mediaItem: {
                        ...data.mediaItem,
                        id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                        title: 'Other track',
                    },
                    lockStatus: { locked: false },
                } as PageData,
            });
            const successes = successToast.mock.calls.length;
            if (operation === 'save') finish();
            else reject(new Error('late refresh'));
            await pending.catch(() => undefined);
            await tick();
            expect(successToast).toHaveBeenCalledTimes(successes);
            expect(screen.queryByRole('alert')).toBeNull();
            expect(screen.queryByRole('button', { name: 'Unlock' })).toBeNull();
            await page.rerender({ data: lockedData });
            await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
            expect(
                screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Unlock' }).disabled,
            ).toBe(false);
        },
    );

    it('keeps each item busy when A and B operations overlap across navigation', async () => {
        let finishA!: (value: object) => void;
        let finishB!: (value: object) => void;
        const pendingA = new Promise<object>((resolve) => {
            finishA = resolve;
        });
        const pendingB = new Promise<object>((resolve) => {
            finishB = resolve;
        });
        updateMediaMetadata.mockReturnValueOnce(pendingA).mockReturnValueOnce(pendingB);
        const page = render(DetailPage, { props: { data } });
        await fireEvent.click(keepTitleButton());
        const other = {
            ...data,
            mediaItem: {
                ...data.mediaItem,
                id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee',
                title: 'Other track',
            },
        } as PageData;
        await page.rerender({ data: other });
        await fireEvent.click(keepTitleButton());
        await page.rerender({ data: lockedData });
        expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Unlock' }).disabled).toBe(
            true,
        );
        await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
        expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Unlock' }).disabled).toBe(
            true,
        );
        finishA({ data: { locked: true }, error: null, status: 200 });
        await pendingA;
        await tick();
        expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Unlock' }).disabled).toBe(
            false,
        );
        await page.rerender({ data: { ...other, lockStatus: lockedData.lockStatus } });
        expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Unlock' }).disabled).toBe(
            true,
        );
        finishB({ data: { locked: true }, error: null, status: 200 });
        await pendingB;
        await tick();
        expect(screen.getByRole<HTMLButtonElement>('menuitem', { name: 'Unlock' }).disabled).toBe(
            false,
        );
        expect(screen.queryByRole('alert')).toBeNull();
        expect(successToast).not.toHaveBeenCalled();
        expect(invalidateAll).not.toHaveBeenCalled();
    });
});

it('consumes quick edit once and ignores the previous track edit URL while the next album data arrives', async () => {
    setRouteUrl(`http://localhost/admin/library/media/${id}?tab=overview&edit=1&tracks_q=Harbour`);
    const view = render(DetailPage, { data });
    expect(await screen.findByRole('button', { name: 'Save Changes' })).toBeTruthy();
    expect(replaceState).toHaveBeenCalledTimes(1);
    await view.rerender({
        data: { ...data, mediaItem: { ...data.mediaItem, title: 'Refreshed Track' } },
    });
    await tick();
    expect(replaceState).toHaveBeenCalledTimes(1);
    const albumId = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
    const album = {
        ...data,
        mediaItem: {
            ...data.mediaItem,
            id: albumId,
            title: 'Harbour Collection',
            mediaType: 'album',
            titleSource: 'manual',
        },
    } as PageData;
    // Data flushes before $page: the old edit=1 still names the track.
    await view.rerender({ data: album });
    await tick();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
    expect(replaceState).toHaveBeenCalledTimes(1);
    setRouteUrl(`http://localhost/admin/library/media/${albumId}?tab=overview&tracks_q=Harbour`);
    await tick();
    expect(screen.queryByRole('button', { name: 'Save Changes' })).toBeNull();
    // A subsequent explicit request for this item is still allowed.
    setRouteUrl(
        `http://localhost/admin/library/media/${albumId}?tab=overview&edit=1&tracks_q=Harbour`,
    );
    expect(await screen.findByRole('button', { name: 'Save Changes' })).toBeTruthy();
    expect(replaceState).toHaveBeenCalledTimes(2);
});

describe('series header health badge', () => {
    const series = {
        ...data,
        mediaItem: {
            id,
            title: 'Invented Series',
            status: 'active',
            mediaType: 'tv',
            dismissed: false,
        },
        lockStatus: { locked: false, lockedBy: null, lockedAt: null },
        healthStatus: 'healthy',
        healthDetail: {
            episodeCountLocal: 3,
            episodeCountProvider: 3,
            seasonCountLocal: 1,
            seasonCountProvider: 1,
        },
        episodeCoverage: null,
        seasonCoverage: [],
        childCounts: { seasons: 1, episodes: 3 },
    } as unknown as PageData;

    it('says Healthy when counts match and no file has a finding', () => {
        render(DetailPage, { props: { data: series } });
        expect(screen.getByText('All aired, identified episodes have files')).toBeTruthy();
    });

    it('does not say Healthy next to open file findings', () => {
        const withIssue = {
            ...series,
            fileIssues: [
                {
                    fileId: 'f1',
                    filePath: '/media/Invented Series/S01E03.mkv',
                    mediaItemId: 'e3',
                    mediaTitle: 'Third',
                    seasonNumber: 1,
                    episodeNumber: 3,
                    issues: [{ type: 'duration_mismatch', detected_at: '2026-10-26T00:00:00Z' }],
                },
            ],
        } as unknown as PageData;
        render(DetailPage, { props: { data: withIssue } });
        expect(screen.queryByText('All aired, identified episodes have files')).toBeNull();
        expect(screen.getByText('Needs attention')).toBeTruthy();
    });
});
