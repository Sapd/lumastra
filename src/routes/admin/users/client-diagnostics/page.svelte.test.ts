// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Wiring proof for the Client diagnostics admin page — same shape as the
 * deleted playback-incidents page test: drive the REAL page with mocked API
 * responses and assert on request URLs, rendered rows/detail, and button
 * behaviour, never on a formatter alone.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';
import { flushSync } from 'svelte';
import { createReactiveUrlBox } from './test-reactive-url.svelte.js';

vi.mock('$env/dynamic/public', () => ({ env: {} }));

// A real `$state` box (see test-reactive-url.svelte.ts for why) so that
// mutating it mid-test actually re-runs the page's own `$effect`/`$derived` —
// needed for the list-load race test, which simulates a real navigation.
// NOT `vi.hoisted` — that runs its callback before the `createReactiveUrlBox`
// import binding is initialized. The mock factory below is only a closure
// (registered, not invoked) at this point, so it can safely reference
// `urlBox` even though the `let` below is assigned after this call; by the
// time the factory actually runs (`+page.svelte` importing `$app/state`
// during module linking) is fine, and by the time its `page.url` getter is
// actually READ (component instantiation inside a test's `render()`), this
// module has long finished evaluating and `urlBox` is assigned.
let urlBox: ReturnType<typeof createReactiveUrlBox>;
vi.mock('$app/state', () => ({
    get page() {
        return { url: urlBox.value, data: {} };
    },
}));
urlBox = createReactiveUrlBox('http://localhost/admin/users/client-diagnostics');
vi.mock('$app/stores', () => ({
    page: readable({ url: new URL('http://localhost/admin/users/client-diagnostics') }),
    navigating: readable(null),
}));
const goto = vi.hoisted(() => vi.fn());
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto }));
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));
vi.mock('$lib/api/admin', () => ({ addNavPin: vi.fn(), removeNavPin: vi.fn() }));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

// The real ConfirmModal is rendered by a modal host mounted at the app
// layout, which this test does not render — capture the config `modals.open`
// was called with instead, and drive `onConfirm` directly, same as
// unit-testing any other callback prop.
const modals = vi.hoisted(() => ({ open: vi.fn(), close: vi.fn() }));
vi.mock('$lib/stores/modal.store', () => ({ modals }));

const apiGet = vi.hoisted(() => vi.fn());
const apiDelete = vi.hoisted(() => vi.fn());
vi.mock('$lib/api/client.js', () => ({ apiGet, apiDelete, apiPost: vi.fn() }));

import ClientDiagnosticsPage from './+page.svelte';
import type { PageData } from './$types';

const PLAYBACK_ROW = {
    id: 42,
    eventId: 'eeeeeeee-0000-0000-0000-000000000042',
    shortId: 'EEEE-0042',
    kind: 'playback_incident' as const,
    platform: 'ios' as const,
    userId: 'user-uuid-42',
    username: 'testuser',
    deviceId: 'device-42',
    deviceName: "Testuser's iPhone",
    appVersion: '1.2.3',
    osVersion: '18.0',
    deviceModel: 'iPhone16,1',
    playSessionId: 'session-42',
    mediaId: 'media-uuid-42',
    mediaTitle: 'Private Track',
    occurredAt: '2026-09-10T08:00:00.000Z',
    receivedAt: '2026-09-10T08:00:01.000Z',
    fingerprint: null,
    occurrences: 1,
    summary: 'decode failed',
    resolvedAt: null,
    hasBlob: false,
};

const CRASH_ROW = {
    id: 43,
    eventId: 'ffffffff-0000-0000-0000-000000000043',
    shortId: 'FFFF-0043',
    kind: 'crash' as const,
    platform: 'tvos' as const,
    userId: 'user-uuid-43',
    username: 'testmember',
    deviceId: 'device-43',
    deviceName: "Testmember's TV",
    appVersion: '1.2.3',
    osVersion: '18.0',
    deviceModel: 'AppleTV14,1',
    playSessionId: null,
    mediaId: null,
    mediaTitle: null,
    occurredAt: '2026-09-11T08:00:00.000Z',
    receivedAt: '2026-09-11T08:00:01.000Z',
    fingerprint: 'abc123',
    occurrences: 2,
    summary: 'EXC_CRASH',
    resolvedAt: null,
    hasBlob: false,
};

const LOG_BUNDLE_ROW = {
    id: 44,
    eventId: 'aaaaaaaa-0000-0000-0000-000000000044',
    shortId: 'AAAA-0044',
    kind: 'log_bundle' as const,
    platform: 'web' as const,
    userId: 'user-uuid-44',
    username: 'bob',
    deviceId: 'device-44',
    deviceName: "Bob's browser",
    appVersion: '1.2.3',
    osVersion: null,
    deviceModel: null,
    playSessionId: null,
    mediaId: null,
    mediaTitle: null,
    occurredAt: '2026-09-12T08:00:00.000Z',
    receivedAt: '2026-09-12T08:00:01.000Z',
    fingerprint: null,
    occurrences: 1,
    summary: 'user-requested bundle',
    resolvedAt: null,
    hasBlob: true,
};

const PLAYBACK_DETAIL_RESPONSE = {
    incident: {
        ...PLAYBACK_ROW,
        triggerType: 'error',
        errorType: 'media',
        stage: 'segment',
        httpStatus: 503,
        serverDiagnosticCode: 'session-expired',
        reconnectCause: null,
        message: 'decode failed',
        timeline: [{ t: 0, kind: 'seek' }],
        clientInfo: { userAgent: 'Mozilla/5.0 test-agent', playMethod: 'Transcode' },
    },
    correlatedTranscodeFailures: [],
};

function crashDetail() {
    return {
        ...CRASH_ROW,
        appBuild: '100',
        attemptId: null,
        payload: {
            source: 'metrickit',
            confidence: 'high',
            callStacks: [],
        },
        blob: null,
    };
}

function logBundleDetail() {
    return {
        ...LOG_BUNDLE_ROW,
        appBuild: null,
        attemptId: null,
        payload: {},
        blob: { contentBytes: 1024, uncompressedBytes: 4096, sha256: 'deadbeef' },
    };
}

function renderPage(): void {
    render(ClientDiagnosticsPage, {
        data: {
            isAdmin: true,
            roots: { libraryRoots: [], transcodeRoot: '/tmp/transcode' },
        } as unknown as PageData,
    });
}

describe('/admin/users/client-diagnostics', () => {
    beforeEach(() => {
        urlBox.set('http://localhost/admin/users/client-diagnostics');
    });

    afterEach(() => {
        cleanup();
        apiGet.mockReset();
        apiDelete.mockReset();
        goto.mockReset();
        toasts.success.mockReset();
        toasts.error.mockReset();
        modals.open.mockReset();
    });

    it('renders rows from the mocked list response with kind, summary, user, platform, occurred', async () => {
        apiGet.mockResolvedValue({
            data: {
                items: [PLAYBACK_ROW, CRASH_ROW],
                page: { limit: 50, offset: 0, hasMore: false },
            },
            error: null,
            status: 200,
        });

        renderPage();

        await waitFor(() => expect(screen.getAllByText('decode failed')[0]).toBeTruthy());
        // Each appears 3x: the Kind filter's <option>, the desktop table row and
        // the mobile card (table/card split is CSS-only — both exist in the DOM).
        expect(screen.getAllByText('Playback incident').length).toBe(3);
        expect(screen.getAllByText('Crash').length).toBe(3);
        expect(screen.getAllByText('testuser')[0]).toBeTruthy();
        expect(screen.getAllByText('testmember')[0]).toBeTruthy();
        expect(screen.getAllByText('iOS').length).toBeGreaterThan(0);
        expect(screen.getAllByText('tvOS').length).toBeGreaterThan(0);
    });

    it('reads kind and userId filters from the URL into the first request', async () => {
        urlBox.set(
            'http://localhost/admin/users/client-diagnostics?kind=playback_incident&userId=u1',
        );
        apiGet.mockResolvedValue({
            data: { items: [], page: { limit: 50, offset: 0, hasMore: false } },
            error: null,
            status: 200,
        });

        renderPage();

        await waitFor(() => expect(apiGet).toHaveBeenCalled());
        const firstCallUrl = apiGet.mock.calls[0][0] as string;
        expect(firstCallUrl).toContain('kind=playback_incident');
        expect(firstCallUrl).toContain('userId=u1');
    });

    it('opens a playback_incident row via the legacy detail endpoint and renders PlaybackIncidentDetail', async () => {
        apiGet.mockImplementation(async (url: string) => {
            if (url.includes('/playback-incidents/42')) {
                return { data: PLAYBACK_DETAIL_RESPONSE, error: null, status: 200 };
            }
            return {
                data: { items: [PLAYBACK_ROW], page: { limit: 50, offset: 0, hasMore: false } },
                error: null,
                status: 200,
            };
        });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('decode failed')[0]).toBeTruthy());

        await fireEvent.click(screen.getAllByText('decode failed')[0]);

        await waitFor(() =>
            expect(apiGet).toHaveBeenCalledWith(
                expect.stringContaining('/api/admin/playback-incidents/42'),
                expect.anything(),
            ),
        );
        // PlaybackIncidentDetail renders the incident's http status.
        await waitFor(() => expect(screen.getByText('503')).toBeTruthy());
    });

    it('opens a crash row via the generic diagnostics detail endpoint and renders ClientDiagnosticDetail', async () => {
        apiGet.mockImplementation(async (url: string) => {
            if (url.includes('/diagnostics/43')) {
                return { data: crashDetail(), error: null, status: 200 };
            }
            return {
                data: { items: [CRASH_ROW], page: { limit: 50, offset: 0, hasMore: false } },
                error: null,
                status: 200,
            };
        });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('EXC_CRASH')[0]).toBeTruthy());

        await fireEvent.click(screen.getAllByText('EXC_CRASH')[0]);

        await waitFor(() =>
            expect(apiGet).toHaveBeenCalledWith(
                expect.stringContaining('/api/admin/diagnostics/43'),
                expect.anything(),
            ),
        );
        // ClientDiagnosticDetail renders the shortId as "Reference".
        await waitFor(() => expect(screen.getByText('FFFF-0043')).toBeTruthy());
    });

    it('shows a download link to the blob endpoint for a log_bundle detail', async () => {
        apiGet.mockImplementation(async (url: string) => {
            if (url.includes('/diagnostics/44')) {
                return { data: logBundleDetail(), error: null, status: 200 };
            }
            return {
                data: { items: [LOG_BUNDLE_ROW], page: { limit: 50, offset: 0, hasMore: false } },
                error: null,
                status: 200,
            };
        });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('user-requested bundle')[0]).toBeTruthy());

        await fireEvent.click(screen.getAllByText('user-requested bundle')[0]);

        await waitFor(() => expect(screen.getByText('AAAA-0044')).toBeTruthy());
        const downloadLink = screen.getByText('Download .log.gz') as HTMLAnchorElement;
        expect(downloadLink.getAttribute('href')).toBe('/api/admin/diagnostics/44/blob');
    });

    it('removes q from the URL as soon as the search box is emptied', async () => {
        urlBox.set('http://localhost/admin/users/client-diagnostics?q=session-expired');
        apiGet.mockResolvedValue({
            data: { items: [PLAYBACK_ROW], page: { limit: 50, offset: 0, hasMore: false } },
            error: null,
            status: 200,
        });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('decode failed')[0]).toBeTruthy());

        const searchInput = screen.getByPlaceholderText(
            'Short id or error reference',
        ) as HTMLInputElement;
        await fireEvent.input(searchInput, { target: { value: '' } });

        await waitFor(() => expect(goto).toHaveBeenCalled());
        const [gotoUrl] = goto.mock.calls[goto.mock.calls.length - 1];
        expect(gotoUrl as string).not.toContain('q=');
    });

    it('clears all with all=true when no filter is active', async () => {
        apiGet.mockResolvedValue({
            data: { items: [PLAYBACK_ROW], page: { limit: 50, offset: 0, hasMore: false } },
            error: null,
            status: 200,
        });
        apiDelete.mockResolvedValue({ data: { cleared: 1 }, error: null, status: 200 });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('decode failed')[0]).toBeTruthy());

        await fireEvent.click(screen.getByRole('button', { name: /clear all/i }));

        await waitFor(() => expect(modals.open).toHaveBeenCalled());
        const [, config] = modals.open.mock.calls[0] as [
            unknown,
            { onConfirm: () => Promise<void> },
        ];
        await config.onConfirm();

        await waitFor(() => expect(apiDelete).toHaveBeenCalled());
        const [deleteUrl] = apiDelete.mock.calls[0];
        expect(deleteUrl as string).toContain('all=true');
    });

    it('disables "Clear all" while a search term is active', async () => {
        urlBox.set('http://localhost/admin/users/client-diagnostics?q=session-expired');
        apiGet.mockResolvedValue({
            data: { items: [PLAYBACK_ROW], page: { limit: 50, offset: 0, hasMore: false } },
            error: null,
            status: 200,
        });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('decode failed')[0]).toBeTruthy());

        const clearAllButton = screen.getByRole('button', {
            name: /clear all/i,
        }) as HTMLButtonElement;
        expect(clearAllButton.disabled).toBe(true);
    });

    it('sends exactly the active filters (and no all=true) when clearing a filtered set', async () => {
        urlBox.set('http://localhost/admin/users/client-diagnostics?kind=crash&userId=u1');
        apiGet.mockResolvedValue({
            data: { items: [CRASH_ROW], page: { limit: 50, offset: 0, hasMore: false } },
            error: null,
            status: 200,
        });
        apiDelete.mockResolvedValue({ data: { cleared: 3 }, error: null, status: 200 });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('EXC_CRASH')[0]).toBeTruthy());

        await fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
        await waitFor(() => expect(modals.open).toHaveBeenCalled());
        const [, config] = modals.open.mock.calls[0] as [
            unknown,
            { body: string; onConfirm: () => Promise<void> },
        ];

        // Confirm text states the scope being cleared.
        expect(config.body).toContain('kind "crash"');
        expect(config.body).toContain('user u1');

        await config.onConfirm();

        await waitFor(() => expect(apiDelete).toHaveBeenCalled());
        const [deleteUrl] = apiDelete.mock.calls[0];
        expect(deleteUrl as string).toContain('kind=crash');
        expect(deleteUrl as string).toContain('userId=u1');
        expect(deleteUrl as string).not.toContain('all=true');
    });

    it('states the unfiltered scope in the confirm body when clearing everything', async () => {
        apiGet.mockResolvedValue({
            data: { items: [PLAYBACK_ROW], page: { limit: 50, offset: 0, hasMore: false } },
            error: null,
            status: 200,
        });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('decode failed')[0]).toBeTruthy());

        await fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
        await waitFor(() => expect(modals.open).toHaveBeenCalled());
        const [, config] = modals.open.mock.calls[0] as [unknown, { body: string }];
        expect(config.body).toContain('every recorded diagnostic, for all users');
    });

    it('discards a stale detail response when a second row is opened first (detail-load race)', async () => {
        apiGet.mockResolvedValue({
            data: {
                items: [PLAYBACK_ROW, CRASH_ROW],
                page: { limit: 50, offset: 0, hasMore: false },
            },
            error: null,
            status: 200,
        });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('decode failed')[0]).toBeTruthy());

        let resolveSlow!: (value: unknown) => void;
        const slow = new Promise((resolve) => {
            resolveSlow = resolve;
        });

        apiGet.mockImplementation((url: string) => {
            if (url.includes('/playback-incidents/42')) return slow;
            if (url.includes('/diagnostics/43')) {
                return Promise.resolve({ data: crashDetail(), error: null, status: 200 });
            }
            return Promise.resolve({
                data: {
                    items: [PLAYBACK_ROW, CRASH_ROW],
                    page: { limit: 50, offset: 0, hasMore: false },
                },
                error: null,
                status: 200,
            });
        });

        // Click row A (slow), then row B (fast) before A resolves.
        await fireEvent.click(screen.getAllByText('decode failed')[0]);
        await fireEvent.click(screen.getAllByText('EXC_CRASH')[0]);

        // B's (fast) response lands and renders first.
        await waitFor(() => expect(screen.getByText('FFFF-0043')).toBeTruthy());

        // A's (slow) response now resolves — it must NOT overwrite B's panel.
        resolveSlow({ data: PLAYBACK_DETAIL_RESPONSE, error: null, status: 200 });
        await Promise.resolve();
        await Promise.resolve();

        expect(screen.getByText('FFFF-0043')).toBeTruthy();
        expect(screen.queryByText('503')).toBeNull();
    });

    it('discards a stale list response when the filter changes before it resolves (list-load race)', async () => {
        let resolveSlow!: (value: unknown) => void;
        const slow = new Promise((resolve) => {
            resolveSlow = resolve;
        });
        let callCount = 0;

        apiGet.mockImplementation(() => {
            callCount += 1;
            if (callCount === 1) return slow;
            return Promise.resolve({
                data: { items: [CRASH_ROW], page: { limit: 50, offset: 0, hasMore: false } },
                error: null,
                status: 200,
            });
        });

        renderPage();
        await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(1));

        // Change the filter before the first (slow) request resolves.
        urlBox.set('http://localhost/admin/users/client-diagnostics?kind=crash');
        flushSync();

        await waitFor(() => expect(screen.getAllByText('EXC_CRASH')[0]).toBeTruthy());

        // The stale first request now resolves with the OLD filter's rows —
        // it must not overwrite the newer, already-rendered result. Since
        // the correct (guarded) outcome is "nothing changes", there is no
        // event to `waitFor` — instead, explicitly drain the stale request's
        // continuation (it hops through `fetchListPage`'s own `await` before
        // `loadList` sees it) with a real macrotask flush, so this assertion
        // runs only after a buggy overwrite would have already landed.
        resolveSlow({
            data: { items: [PLAYBACK_ROW], page: { limit: 50, offset: 0, hasMore: false } },
            error: null,
            status: 200,
        });
        await slow;
        await new Promise((resolve) => setTimeout(resolve, 0));

        expect(screen.getAllByText('EXC_CRASH')[0]).toBeTruthy();
        expect(screen.queryByText('decode failed')).toBeNull();
    });

    it('deletes exactly the scope the modal showed, even if the filters change while it is open', async () => {
        urlBox.set('http://localhost/admin/users/client-diagnostics?kind=crash');
        apiGet.mockResolvedValue({
            data: { items: [CRASH_ROW], page: { limit: 50, offset: 0, hasMore: false } },
            error: null,
            status: 200,
        });
        apiDelete.mockResolvedValue({ data: { cleared: 1 }, error: null, status: 200 });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('EXC_CRASH')[0]).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: /clear all/i }));
        await waitFor(() => expect(modals.open).toHaveBeenCalled());
        const [, config] = modals.open.mock.calls[0] as [
            unknown,
            { onConfirm: () => Promise<void> },
        ];

        // Back button while the modal is open: every filter disappears.
        urlBox.set('http://localhost/admin/users/client-diagnostics');
        flushSync();
        await config.onConfirm();

        await waitFor(() => expect(apiDelete).toHaveBeenCalled());
        const [deleteUrl] = apiDelete.mock.calls[0];
        expect(deleteUrl as string).toContain('kind=crash');
        expect(deleteUrl as string).not.toContain('all=true');
    });

    it('treats a 404 on a single clear as already cleared: row removed, no error toast', async () => {
        apiGet.mockResolvedValue({
            data: { items: [CRASH_ROW], page: { limit: 50, offset: 0, hasMore: false } },
            error: null,
            status: 200,
        });
        apiDelete.mockResolvedValue({ data: null, error: 'Not found', status: 404 });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('EXC_CRASH')[0]).toBeTruthy());
        await fireEvent.click(screen.getAllByRole('button', { name: 'Clear diagnostic 43' })[0]);
        await waitFor(() => expect(modals.open).toHaveBeenCalled());
        const [, config] = modals.open.mock.calls[0] as [
            unknown,
            { onConfirm: () => Promise<void> },
        ];
        await config.onConfirm();

        await waitFor(() => expect(screen.queryByText('EXC_CRASH')).toBeNull());
        expect(toasts.error).not.toHaveBeenCalled();
        expect(toasts.success).toHaveBeenCalled();
    });

    it('drops rows already shown when Load more returns an overlapping page', async () => {
        apiGet
            .mockResolvedValueOnce({
                data: { items: [CRASH_ROW], page: { limit: 50, offset: 0, hasMore: true } },
                error: null,
                status: 200,
            })
            .mockResolvedValueOnce({
                // A new row arrived at the top in between: page 2 repeats CRASH_ROW.
                data: {
                    items: [CRASH_ROW, LOG_BUNDLE_ROW],
                    page: { limit: 50, offset: 1, hasMore: false },
                },
                error: null,
                status: 200,
            });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('EXC_CRASH')[0]).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

        await waitFor(() => expect(screen.getAllByText('user-requested bundle')[0]).toBeTruthy());
        // Table row + mobile card: two renderings per row, not four.
        expect(screen.getAllByText('EXC_CRASH').length).toBe(2);
    });

    it('says so when Load more fails instead of silently doing nothing', async () => {
        apiGet
            .mockResolvedValueOnce({
                data: { items: [CRASH_ROW], page: { limit: 50, offset: 0, hasMore: true } },
                error: null,
                status: 200,
            })
            .mockResolvedValueOnce({ data: null, error: 'boom', status: 500 });

        renderPage();
        await waitFor(() => expect(screen.getAllByText('EXC_CRASH')[0]).toBeTruthy());
        await fireEvent.click(screen.getByRole('button', { name: 'Load more' }));

        await waitFor(() => expect(toasts.error).toHaveBeenCalled());
    });
});
