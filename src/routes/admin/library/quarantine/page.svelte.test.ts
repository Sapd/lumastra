// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import { tick } from 'svelte';
import { page } from '$app/state';
import { modals } from '$lib/stores/modal.store';
vi.mock('$lib/stores/modal.store', () => ({ modals: { open: vi.fn() } }));
const api = vi.hoisted(() => ({
    listQuarantineSeriesGroups: vi.fn(),
    resolveQuarantineSeriesGroup: vi.fn(),
    listReconciliationMoves: vi.fn(),
    undoReconciliationMove: vi.fn(),
    listReconciliationProposals: vi.fn(),
    inspectQuarantineGroup: vi.fn(),
    resolveQuarantineEntry: vi.fn(),
}));
vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/state', async () => {
    const { fromStore, writable } = await import('svelte/store');
    const state = fromStore(writable<App.PageState>({}));
    return {
        page: {
            url: new URL('http://localhost:3000/admin/library/quarantine'),
            data: {},
            get state(): App.PageState {
                return state.current;
            },
            set state(value: App.PageState) {
                state.current = value;
            },
        },
    };
});
vi.mock('$app/stores', () => ({
    page: readable({ url: new URL('http://localhost/admin/library/quarantine'), data: {} }),
    navigating: readable(null),
}));
vi.mock('$app/navigation', async () => {
    const { page } = await import('$app/state');
    return {
        goto: vi.fn(),
        invalidateAll: vi.fn(),
        pushState: vi.fn(),
        replaceState: vi.fn((target: URL, state: App.PageState): void => {
            window.history.replaceState(state, '', target);
            page.state = state;
        }),
    };
});
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));
vi.mock('$lib/api/admin', async (actualImport) => ({
    ...(await actualImport<Record<string, unknown>>()),
    ...api,
}));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn(), warning: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));
import Page from './+page.svelte';
const seriesId = '12345678-1234-4234-8234-123456789abc';
const eligible = {
    id: seriesId,
    fingerprint: 'a'.repeat(64),
    episodeId: seriesId,
    currentTitle: 'Old',
    currentTmdbEpisodeId: '1',
    title: 'New',
    tmdbEpisodeId: '2',
    seasonNumber: 1,
    episodeNumber: 1,
};
const continuation = '12345678-1234-4234-8234-123456789abd';
const group = {
    fingerprint: 'd'.repeat(32),
    seriesId,
    parentTmdbId: null,
    seriesTitle: 'Decisions',
    totalUnresolved: 1005,
    reasonCounts: { 'reconcile-backfill:matched': 1005 },
    oldestCreatedAt: '2026-10-24T00:00:00Z',
    newestCreatedAt: '2026-10-24T00:00:00Z',
};
beforeEach(() => {
    vi.clearAllMocks();
    page.url = new URL('/admin/library/quarantine', window.location.origin) as typeof page.url;
    page.state = {};
    window.history.replaceState({}, '', page.url);
    api.listQuarantineSeriesGroups.mockResolvedValue({ data: { groups: [group] } });
    api.listReconciliationMoves.mockResolvedValue({ data: { moves: [] } });
    api.listReconciliationProposals.mockResolvedValue({ data: { proposals: [] } });
});
afterEach(cleanup);
describe('quarantine page recheck wiring', () => {
    it('submits recheck, displays partial totals and explicitly continues from the returned cursor', async () => {
        api.resolveQuarantineSeriesGroup
            .mockResolvedValueOnce({
                data: {
                    action: 'recheck',
                    examined: 250,
                    resolved: 20,
                    retained: 230,
                    continuation,
                },
            })
            .mockResolvedValueOnce({
                data: { action: 'recheck', examined: 5, resolved: 0, retained: 5 },
            });
        render(Page);
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Recheck completed decisions' }),
        );
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toContain(
                '250 examined, 20 already applied, 230 retained',
            ),
        );
        expect(api.resolveQuarantineSeriesGroup).toHaveBeenNthCalledWith(1, {
            action: 'recheck',
            seriesId,
            after: undefined,
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Continue recheck' }));
        await waitFor(() =>
            expect(api.resolveQuarantineSeriesGroup).toHaveBeenNthCalledWith(2, {
                action: 'recheck',
                seriesId,
                after: continuation,
            }),
        );
        expect(
            await screen.findByRole('button', { name: 'Recheck completed decisions' }),
        ).toBeTruthy();
    });
    it('recovers from a request error and keeps a continuation for retry', async () => {
        api.resolveQuarantineSeriesGroup
            .mockResolvedValueOnce({
                data: {
                    action: 'recheck',
                    examined: 250,
                    resolved: 0,
                    retained: 250,
                    continuation,
                },
            })
            .mockRejectedValueOnce(new Error('network'));
        render(Page);
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Recheck completed decisions' }),
        );
        await fireEvent.click(await screen.findByRole('button', { name: 'Continue recheck' }));
        await waitFor(() => expect(toasts.error).toHaveBeenCalled());
        expect(
            (screen.getByRole('button', { name: 'Continue recheck' }) as HTMLButtonElement)
                .disabled,
        ).toBe(false);
        expect(toasts.success).not.toHaveBeenCalled();
        expect(
            screen.getAllByRole('status').some((el) => el.textContent?.includes('250 examined')),
        ).toBe(true);
    });
    it('shows the completed batch result when refreshing removes the final group', async () => {
        api.resolveQuarantineSeriesGroup.mockResolvedValue({
            data: { action: 'recheck', examined: 1, resolved: 1, retained: 0 },
        });
        render(Page);
        const button = await screen.findByRole('button', { name: 'Recheck completed decisions' });
        api.listQuarantineSeriesGroups.mockResolvedValueOnce({ data: { groups: [] } });
        await fireEvent.click(button);
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toContain('1 already applied'),
        );
        expect(screen.queryByRole('button', { name: 'Recheck completed decisions' })).toBeNull();
    });

    it('attributes concurrent reverse-completion results to their own series', async () => {
        const other = {
            ...group,
            seriesId: '12345678-1234-4234-8234-123456789abe',
            seriesTitle: 'Other Series',
        };
        api.listQuarantineSeriesGroups.mockResolvedValue({ data: { groups: [group, other] } });
        let finishFirst!: (value: unknown) => void;
        let finishSecond!: (value: unknown) => void;
        api.resolveQuarantineSeriesGroup
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishFirst = resolve;
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        finishSecond = resolve;
                    }),
            );
        render(Page);
        const buttons = await screen.findAllByRole('button', {
            name: 'Recheck completed decisions',
        });
        await fireEvent.click(buttons[0]);
        await fireEvent.click(buttons[1]);
        finishSecond({ data: { action: 'recheck', examined: 2, resolved: 2, retained: 0 } });
        await waitFor(() =>
            expect(screen.getByRole('status').textContent).toContain(
                'Other Series: This batch: 2 examined',
            ),
        );
        finishFirst({ data: { action: 'recheck', examined: 3, resolved: 1, retained: 2 } });
        await waitFor(() => expect(screen.getAllByRole('status')).toHaveLength(2));
        expect(screen.getAllByRole('status').map((el) => el.textContent?.trim())).toEqual(
            expect.arrayContaining([
                expect.stringContaining(
                    'Decisions: This batch: 3 examined, 1 already applied, 2 retained',
                ),
                expect.stringContaining(
                    'Other Series: This batch: 2 examined, 2 already applied, 0 retained',
                ),
            ]),
        );
    });

    it('previews the reviewed component before Accept, preserves cursors and results on failed requests, and resets after dismissal', async () => {
        const reviewedPage = { ids: [continuation], fingerprint: 'b'.repeat(64), continuation };
        const reviewed = [
            {
                id: continuation,
                fingerprint: 'a'.repeat(64),
                episodeId: seriesId,
                currentTitle: 'Before',
                currentTmdbEpisodeId: '870099',
                title: 'The Decision',
                tmdbEpisodeId: '870001',
                seasonNumber: 1,
                episodeNumber: 1,
            },
        ];
        api.resolveQuarantineSeriesGroup
            .mockResolvedValueOnce({
                data: {
                    action: 'recheck',
                    examined: 250,
                    resolved: 0,
                    retained: 250,
                    continuation,
                },
            })
            .mockResolvedValueOnce({
                data: {
                    reviewedPage,
                    action: 'preview-accept',
                    resolved: 0,
                    review: reviewed,
                    blocked: 0,
                },
            })
            .mockResolvedValueOnce({
                data: {
                    action: 'accept',
                    examined: 250,
                    resolved: 1,
                    blocked: 0,
                    skipped: 249,
                    continuation,
                },
            })
            .mockResolvedValueOnce({
                data: {
                    reviewedPage,
                    action: 'preview-accept',
                    resolved: 0,
                    review: reviewed,
                    blocked: 0,
                },
            })
            .mockRejectedValueOnce(new Error('interrupted'))
            .mockResolvedValueOnce({ data: { action: 'dismiss', resolved: 1005 } });
        render(Page);
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Recheck completed decisions' }),
        );
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Review and accept batch' }),
        );
        await waitFor(() => expect(modals.open).toHaveBeenCalled());
        expect(api.resolveQuarantineSeriesGroup).toHaveBeenNthCalledWith(2, {
            action: 'preview-accept',
            seriesId,
            after: undefined,
        });
        const confirm = async (): Promise<void> => {
            const options = vi.mocked(modals.open).mock.calls.at(-1)?.[1] as {
                body: string;
                onConfirm: () => Promise<void>;
            };
            await options.onConfirm();
        };
        expect((vi.mocked(modals.open).mock.calls.at(-1)?.[1] as { body: string }).body).toContain(
            'The Decision',
        );
        await confirm();
        expect(api.resolveQuarantineSeriesGroup).toHaveBeenNthCalledWith(3, {
            action: 'accept',
            seriesId,
            after: undefined,
            reviewed: [{ id: continuation, fingerprint: 'a'.repeat(64) }],
            reviewedPage,
        });
        await fireEvent.click(await screen.findByRole('button', { name: 'Continue accepting' }));
        await waitFor(() => expect(modals.open).toHaveBeenCalledTimes(2));
        await confirm();
        expect(api.resolveQuarantineSeriesGroup).toHaveBeenNthCalledWith(5, {
            action: 'accept',
            seriesId,
            after: continuation,
            reviewed: [{ id: continuation, fingerprint: 'a'.repeat(64) }],
            reviewedPage,
        });
        expect(screen.getByRole('button', { name: 'Continue accepting' })).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Continue recheck' })).toBeTruthy();
        expect(
            screen.getAllByRole('status').some((el) => el.textContent?.includes('250 examined')),
        ).toBe(true);
        await fireEvent.click(screen.getByRole('button', { name: 'Hide current warnings' }));
        await waitFor(() =>
            expect(api.resolveQuarantineSeriesGroup).toHaveBeenLastCalledWith({
                action: 'dismiss',
                groupKey: seriesId,
                groupFingerprint: group.fingerprint,
            }),
        );
        expect(modals.open).toHaveBeenCalledTimes(2);
        expect(
            await screen.findByRole('button', { name: 'Recheck completed decisions' }),
        ).toBeTruthy();
        expect(screen.getByRole('button', { name: 'Review and accept batch' })).toBeTruthy();
    });

    it('reports a refresh failure after a completed batch without an all-fixed message', async () => {
        api.resolveQuarantineSeriesGroup.mockResolvedValue({
            data: { action: 'recheck', examined: 1, resolved: 1, retained: 0 },
        });
        render(Page);
        const button = await screen.findByRole('button', { name: 'Recheck completed decisions' });
        api.listQuarantineSeriesGroups.mockResolvedValueOnce({
            error: { message: 'reload failed' },
        });
        await fireEvent.click(button);
        expect(await screen.findByRole('alert')).toBeTruthy();
        expect(toasts.success).not.toHaveBeenCalled();
    });
    it('binds confirmation to the cursor captured by its preview even after another completion', async () => {
        const reviewedPage = { ids: [continuation], fingerprint: 'c'.repeat(64) };
        api.resolveQuarantineSeriesGroup
            .mockResolvedValueOnce({
                data: { action: 'preview-accept', resolved: 0, review: [eligible], reviewedPage },
            })
            .mockResolvedValue({
                data: {
                    action: 'accept',
                    resolved: 0,
                    examined: 1,
                    blocked: 1,
                    skipped: 0,
                    continuation,
                },
            });
        render(Page);
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Review and accept batch' }),
        );
        await waitFor(() => expect(modals.open).toHaveBeenCalled());
        const callback = (
            vi.mocked(modals.open).mock.calls.at(-1)?.[1] as { onConfirm: () => Promise<void> }
        ).onConfirm;
        await callback();
        await callback();
        expect(api.resolveQuarantineSeriesGroup).toHaveBeenLastCalledWith({
            action: 'accept',
            seriesId,
            after: undefined,
            reviewed: [{ id: eligible.id, fingerprint: eligible.fingerprint }],
            reviewedPage,
        });
        expect(screen.getByRole('status').textContent).toContain(
            '1 examined, 0 accepted, 1 blocked, 0 skipped',
        );
    });

    it('keeps successful Accept results per group through reverse completion and a failed next page', async () => {
        const other = {
            ...group,
            seriesId: '12345678-1234-4234-8234-123456789abe',
            seriesTitle: 'Other Series',
        };
        api.listQuarantineSeriesGroups.mockResolvedValue({ data: { groups: [group, other] } });
        const finish = new Map<string, (value: unknown) => void>();
        api.resolveQuarantineSeriesGroup.mockImplementation(
            (body: { action: string; seriesId: string }) => {
                if (body.action === 'preview-accept')
                    return Promise.resolve({
                        data: {
                            action: body.action,
                            resolved: 0,
                            review: [eligible],
                            reviewedPage: { ids: [], fingerprint: 'd'.repeat(64) },
                        },
                    });
                return new Promise((resolve) => {
                    finish.set(body.seriesId, resolve);
                });
            },
        );
        render(Page);
        const buttons = await screen.findAllByRole('button', { name: 'Review and accept batch' });
        await fireEvent.click(buttons[0]);
        await waitFor(() => expect(modals.open).toHaveBeenCalledTimes(1));
        const first = (
            vi.mocked(modals.open).mock.calls[0][1] as { onConfirm: () => Promise<void> }
        ).onConfirm;
        await fireEvent.click(buttons[1]);
        await waitFor(() => expect(modals.open).toHaveBeenCalledTimes(2));
        const second = (
            vi.mocked(modals.open).mock.calls[1][1] as { onConfirm: () => Promise<void> }
        ).onConfirm;
        const firstPending = first();
        const secondPending = second();
        finish.get(other.seriesId)!({
            data: { action: 'accept', resolved: 2, examined: 3, skipped: 1, blocked: 0 },
        });
        await secondPending;
        finish.get(seriesId)!({
            data: {
                action: 'accept',
                resolved: 1,
                examined: 4,
                skipped: 1,
                blocked: 2,
                continuation,
            },
        });
        await firstPending;
        expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual(
            expect.arrayContaining([
                expect.stringContaining('Other Series: Accept batch: 3 examined, 2 accepted'),
                expect.stringContaining(
                    'Decisions: Accept batch: 4 examined, 1 accepted, 2 blocked',
                ),
            ]),
        );
        api.resolveQuarantineSeriesGroup.mockRejectedValueOnce(new Error('next preview failed'));
        await fireEvent.click(screen.getByRole('button', { name: 'Continue accepting' }));
        await waitFor(() => expect(toasts.error).toHaveBeenCalled());
        expect(screen.getByRole('button', { name: 'Continue accepting' })).toBeTruthy();
        expect(screen.getAllByRole('status').map((el) => el.textContent)).toEqual(
            expect.arrayContaining([
                expect.stringContaining(
                    'Decisions: Accept batch: 4 examined, 1 accepted, 2 blocked',
                ),
            ]),
        );
    });

    it('retains the cursor and displays a changed-page result until re-preview or restart', async () => {
        api.resolveQuarantineSeriesGroup
            .mockResolvedValueOnce({
                data: {
                    action: 'preview-accept',
                    resolved: 0,
                    review: [eligible],
                    reviewedPage: { ids: [eligible.id], fingerprint: 'e'.repeat(64) },
                },
            })
            .mockResolvedValueOnce({
                data: {
                    action: 'accept',
                    resolved: 0,
                    examined: 0,
                    skipped: 0,
                    blocked: 0,
                    pageChanged: true,
                },
            });
        render(Page);
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Review and accept batch' }),
        );
        await waitFor(() => expect(modals.open).toHaveBeenCalled());
        await (
            vi.mocked(modals.open).mock.calls[0][1] as { onConfirm: () => Promise<void> }
        ).onConfirm();
        expect(screen.getByRole('status').textContent).toContain('traversal did not advance');
        expect(screen.getByRole('button', { name: 'Reload and restart review' })).toBeTruthy();
    });
    it('supplies scrollBody and displays every exact before/after field and each retained reason', async () => {
        const decisions = [1, 2].map((number) => ({
            id: `12345678-1234-4234-8234-123456789ab${number}`,
            fingerprint: String(number).repeat(64),
            episodeId: `12345678-1234-4234-8234-123456789ac${number}`,
            currentTitle: `Current title ${number}`,
            currentTmdbEpisodeId: `87100${number}`,
            title: `Target title ${number}`,
            tmdbEpisodeId: `87200${number}`,
            seasonNumber: number,
            episodeNumber: number + 10,
            overview: `Exact overview ${number}`,
            stillPath: `/still-${number}.jpg`,
        }));
        const reasons = [
            ['oversized-component', 'exceeds the 1,000-decision review limit'],
            ['batch-capacity', 'does not fit in the remaining batch'],
            ['unreviewable-dependency', 'no eligible reviewable proposal'],
            ['protected-or-inactive', 'protected, inactive or inconsistent'],
            ['changed-proposal', 'differs from the historical warning'],
            ['ineligible', 'no eligible ordinary episode proposal'],
        ];
        api.resolveQuarantineSeriesGroup.mockResolvedValue({
            data: {
                action: 'preview-accept',
                review: decisions,
                inspectableEpisodeIds: [
                    ...decisions.map((row) => row.episodeId),
                    seriesId,
                    continuation,
                ],
                reviewedPage: { ids: decisions.map((row) => row.id), fingerprint: 'c'.repeat(64) },
                blockedReview: reasons.map(([reason]) => ({
                    episodeId: seriesId,
                    title: 'Retained',
                    target: '1',
                    reason,
                    blockingEpisodeId: continuation,
                })),
                blocked: reasons.length,
            },
        });
        render(Page);
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Review and accept batch' }),
        );
        await waitFor(() => expect(modals.open).toHaveBeenCalledOnce());
        const options = vi.mocked(modals.open).mock.calls[0][1] as {
            body: string;
            scrollBody: boolean;
            reviewLinks: { href: string; label: string }[];
        };
        expect(options.scrollBody).toBe(true);
        expect(options.body).toContain(
            'An absent provider overview or still (—) preserves the existing value; a present provider value may be stored.',
        );
        expect(options.body).toContain(
            'Accepting sets the title binding to identity, excluding the episode from later automatic title reconciliation until its binding is deliberately changed.',
        );
        expect(options.reviewLinks).toEqual([
            {
                href: `/admin/library/media/${decisions[0].episodeId}`,
                label: 'Open Current title 1',
            },
            {
                href: `/admin/library/media/${decisions[1].episodeId}`,
                label: 'Open Current title 2',
            },
            { href: `/admin/library/media/${seriesId}`, label: 'Open Retained' },
            { href: `/admin/library/media/${continuation}`, label: 'Open Episode' },
        ]);
        for (const row of decisions) {
            expect(options.body).toContain(row.episodeId);
            for (const value of [
                row.currentTitle,
                row.currentTmdbEpisodeId,
                row.title,
                row.tmdbEpisodeId,
                row.overview,
                row.stillPath,
            ])
                expect(options.body).toContain(value);
            expect(options.body).toContain(`S${row.seasonNumber}E${row.episodeNumber}`);
        }
        for (const [, text] of reasons) expect(options.body).toContain(text);
    });
    it.each([false, true])(
        'keeps a zero-eligible preview read-only (continuation %s)',
        async (hasNext) => {
            api.resolveQuarantineSeriesGroup.mockResolvedValueOnce({
                data: {
                    action: 'preview-accept',
                    resolved: 0,
                    review: [],
                    blocked: 1,
                    blockedReview: [
                        {
                            episodeId: seriesId,
                            title: 'Held',
                            target: '2',
                            reason: 'identity-bound',
                        },
                    ],
                    ...(hasNext ? { continuation } : {}),
                },
            });
            render(Page);
            await fireEvent.click(
                await screen.findByRole('button', { name: 'Review and accept batch' }),
            );
            expect(await screen.findByText('No eligible decisions in this preview')).toBeTruthy();
            expect(modals.open).not.toHaveBeenCalled();
            expect(
                screen.queryByRole('button', { name: 'Inspect next preview page' }) !== null,
            ).toBe(hasNext);
            if (hasNext) {
                api.resolveQuarantineSeriesGroup.mockResolvedValueOnce({
                    data: {
                        action: 'preview-accept',
                        review: [eligible],
                        reviewedPage: { ids: [eligible.id], fingerprint: 'c'.repeat(64) },
                    },
                });
                await fireEvent.click(
                    screen.getByRole('button', { name: 'Inspect next preview page' }),
                );
                await waitFor(() => expect(modals.open).toHaveBeenCalledTimes(1));
                expect(api.resolveQuarantineSeriesGroup).toHaveBeenLastCalledWith({
                    action: 'preview-accept',
                    seriesId,
                    after: continuation,
                });
            }
            expect(
                api.resolveQuarantineSeriesGroup.mock.calls.every(
                    ([body]) => body.action === 'preview-accept',
                ),
            ).toBe(true);
        },
    );
    it('offers group inspection for unknown and below-threshold groups', async () => {
        api.listQuarantineSeriesGroups.mockResolvedValue({
            data: {
                groups: [
                    {
                        ...group,
                        seriesId: null,
                        seriesTitle: null,
                        reasonCounts: { 'reconcile-backfill:below-threshold': 1 },
                    },
                ],
            },
        });
        api.inspectQuarantineGroup.mockResolvedValue({ data: { items: [], total: 1 } });
        render(Page);
        expect(await screen.findByText('Needs a better match: 1')).toBeTruthy();
        await fireEvent.click(await screen.findByRole('button', { name: 'Inspect' }));
        await waitFor(() =>
            expect(api.inspectQuarantineGroup).toHaveBeenCalledWith('unknown', undefined),
        );
        expect(screen.queryByRole('button', { name: 'Review and accept batch' })).toBeNull();
    });
    it('does not invent links from blocked UUIDs in zero-eligible or mixed previews', async () => {
        const missing = '12345678-1234-4234-8234-123456789aff';
        api.resolveQuarantineSeriesGroup.mockResolvedValueOnce({
            data: {
                review: [],
                blocked: 1,
                blockedReview: [
                    {
                        episodeId: missing,
                        title: 'Deleted',
                        target: '1',
                        reason: 'unreviewable-dependency',
                    },
                ],
                inspectableEpisodeIds: [],
            },
        });
        render(Page);
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Review and accept batch' }),
        );
        await screen.findByText('No eligible decisions in this preview');
        expect(document.querySelector(`a[href="/admin/library/media/${missing}"]`)).toBeNull();
        api.resolveQuarantineSeriesGroup.mockResolvedValueOnce({
            data: {
                review: [eligible],
                blocked: 1,
                blockedReview: [
                    {
                        episodeId: missing,
                        title: 'Deleted',
                        target: '1',
                        reason: 'unreviewable-dependency',
                    },
                ],
                inspectableEpisodeIds: [eligible.episodeId],
            },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Review and accept batch' }));
        await waitFor(() => expect(modals.open).toHaveBeenCalledOnce());
        const props = vi.mocked(modals.open).mock.calls[0][1] as {
            reviewLinks: { href: string }[];
        };
        expect(props.reviewLinks).toEqual([
            {
                href: `/admin/library/media/${eligible.episodeId}`,
                label: 'Open Old',
            },
        ]);
    });
    it('preserves real shallow history state for keyset pages, close/reopen and back/forward while page.url stays unchanged', async () => {
        const next = '12345678-1234-4234-8234-123456789abe';
        page.url = new URL(
            `/admin/library/quarantine?inspect=${seriesId}&after=${continuation}`,
            window.location.origin,
        ) as typeof page.url;
        const routeUrl = page.url;
        page.state = { modalPreviousUrl: '/retained-context' };
        window.history.replaceState(page.state, '', routeUrl);
        api.inspectQuarantineGroup.mockResolvedValue({
            data: { items: [], total: 2, continuation: next },
        });
        const restore = (event: PopStateEvent): void => {
            page.state = (event.state ?? {}) as App.PageState;
        };
        window.addEventListener('popstate', restore);
        try {
            render(Page);
            await waitFor(() =>
                expect(api.inspectQuarantineGroup).toHaveBeenCalledWith(seriesId, continuation),
            );
            await fireEvent.click(await screen.findByRole('button', { name: 'Next warnings' }));
            await waitFor(() =>
                expect(api.inspectQuarantineGroup).toHaveBeenCalledWith(seriesId, next),
            );
            const saved = { ...page.state };
            expect(page.url).toBe(routeUrl);
            expect(new URL(saved.adminWorkspaceUrl!).searchParams.get('after')).toBe(next);
            expect(saved.modalPreviousUrl).toBe('/retained-context');
            await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
            await waitFor(() =>
                expect(
                    screen.queryByRole('region', { name: 'Inspect retained warnings' }),
                ).toBeNull(),
            );
            expect(new URL(page.state.adminWorkspaceUrl!).searchParams.has('inspect')).toBe(false);
            expect(new URL(page.state.adminWorkspaceUrl!).searchParams.has('after')).toBe(false);
            await fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
            await waitFor(() =>
                expect(api.inspectQuarantineGroup).toHaveBeenCalledWith(seriesId, undefined),
            );
            expect(new URL(page.state.adminWorkspaceUrl!).searchParams.has('after')).toBe(false);
            window.history.pushState(saved, '', saved.adminWorkspaceUrl);
            page.state = saved;
            await tick();
            await waitFor(() =>
                expect(api.inspectQuarantineGroup).toHaveBeenLastCalledWith(seriesId, next),
            );
            const traverse = async (direction: 'back' | 'forward'): Promise<void> => {
                await new Promise<void>((resolve) => {
                    window.addEventListener('popstate', () => resolve(), { once: true });
                    window.history[direction]();
                });
                await tick();
            };
            await traverse('back');
            await waitFor(() =>
                expect(api.inspectQuarantineGroup).toHaveBeenLastCalledWith(seriesId, undefined),
            );
            await traverse('forward');
            await waitFor(() =>
                expect(api.inspectQuarantineGroup).toHaveBeenLastCalledWith(seriesId, next),
            );
            expect(page.url).toBe(routeUrl);
            expect(page.state.modalPreviousUrl).toBe('/retained-context');
        } finally {
            window.removeEventListener('popstate', restore);
        }
    });
});

describe('warning history', () => {
    it('shows durable history and restores only its original batch across bounded requests', async () => {
        const batchId = '12345678-1234-4234-8234-123456789abf';
        api.listQuarantineSeriesGroups.mockResolvedValue({
            data: {
                groups: [],
                history: {
                    items: [
                        {
                            batchId,
                            kind: 'no-proposal',
                            count: 1005,
                            restorable: 1005,
                            seriesTitle: 'The Paper Lighthouse',
                            actor: 'integrity-scanner',
                            createdAt: '2026-10-28T12:00:00Z',
                        },
                    ],
                },
            },
        });
        api.resolveQuarantineSeriesGroup
            .mockResolvedValueOnce({
                data: { action: 'restore', resolved: 0, restored: 1000, changed: 0, continuation },
            })
            .mockResolvedValueOnce({
                data: { action: 'restore', resolved: 0, restored: 4, changed: 1 },
            });
        render(Page);
        await fireEvent.click(await screen.findByText('Warning history', { exact: true }));
        await fireEvent.click(await screen.findByRole('button', { name: 'Show again' }));
        await waitFor(() => expect(api.resolveQuarantineSeriesGroup).toHaveBeenCalledTimes(2));
        expect(api.resolveQuarantineSeriesGroup).toHaveBeenNthCalledWith(1, {
            action: 'restore',
            batchId,
            after: undefined,
        });
        expect(api.resolveQuarantineSeriesGroup).toHaveBeenNthCalledWith(2, {
            action: 'restore',
            batchId,
            after: continuation,
        });
        expect(
            await screen.findByText('Shown again: 1004. Changed warnings left untouched: 1.'),
        ).toBeTruthy();
        expect(modals.open).not.toHaveBeenCalled();
    });
    it('undoes a recorded move in one click with recovery limits visible', async () => {
        api.listReconciliationMoves.mockResolvedValueOnce({
            data: {
                moves: [
                    {
                        id: continuation,
                        seriesId,
                        seriesTitle: 'The Paper Lighthouse',
                        episodeId: seriesId,
                        episodeTitle: 'The Paper Crossing',
                        service: 'filename-title',
                        tmdbEpisodeId: '9900001',
                        fromSeason: 1,
                        fromEpisode: 1,
                        toSeason: 1,
                        toEpisode: 2,
                        appliedAt: '2026-10-28T12:00:00Z',
                    },
                ],
            },
        });
        api.undoReconciliationMove.mockResolvedValue({
            data: { moveId: continuation, episodeId: seriesId, seasonNumber: 1, episodeNumber: 1 },
        });
        render(Page);
        expect(
            await screen.findByText(/Merged watch state, ratings and playlists stay combined/),
        ).toBeTruthy();
        await fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
        await waitFor(() =>
            expect(api.undoReconciliationMove).toHaveBeenCalledExactlyOnceWith(continuation),
        );
        expect(modals.open).not.toHaveBeenCalled();
    });
    it('keeps ordinary accept behind its existing preview confirmation', async () => {
        api.resolveQuarantineSeriesGroup.mockResolvedValue({
            data: {
                action: 'preview-accept',
                resolved: 0,
                examined: 1,
                blocked: 0,
                review: [{ ...eligible }],
                reviewedPage: { ids: [seriesId], fingerprint: 'a'.repeat(64) },
            },
        });
        render(Page);
        await fireEvent.click(
            await screen.findByRole('button', { name: 'Review and accept batch' }),
        );
        await waitFor(() => expect(modals.open).toHaveBeenCalledOnce());
        expect(api.resolveQuarantineSeriesGroup).toHaveBeenCalledTimes(1);
        expect(api.resolveQuarantineSeriesGroup).toHaveBeenCalledWith({
            action: 'preview-accept',
            seriesId,
            after: undefined,
        });
    });
});
