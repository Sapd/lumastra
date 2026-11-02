// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * Wiring proof for the page-level "Copy for GitHub" button.
 *
 * `formatTranscodeIncidentsReport` is unit-tested in $lib/shared, but a pure
 * formatter nobody calls protects nothing — the failure modes here are a page
 * that renders an enabled button over a bundle whose path redaction is a
 * no-op (same guard as the diagnostics page), and a button whose scope drifts
 * from what is expanded on screen. So this drives the REAL page with mocked
 * API responses and asserts on the BUTTON STATE and on the CLIPBOARD TEXT.
 */

import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readable } from 'svelte/store';

vi.mock('$env/dynamic/public', () => ({ env: {} }));
vi.mock('$app/state', () => ({
    page: { url: new URL('http://localhost/admin/system/transcode-failures'), data: {} },
}));
vi.mock('$app/stores', () => ({
    page: readable({ url: new URL('http://localhost/admin/system/transcode-failures') }),
    navigating: readable(null),
}));
vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn(), goto: vi.fn() }));
vi.mock('$app/paths', () => ({ base: '', resolve: (p: string) => p }));
vi.mock('$lib/api/admin', () => ({ addNavPin: vi.fn(), removeNavPin: vi.fn() }));

const toasts = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('$lib/stores/toast.store', () => ({ toasts }));

const { apiGet, apiDelete, openModal } = vi.hoisted(() => ({
    apiGet: vi.fn(),
    apiDelete: vi.fn(),
    openModal: vi.fn(),
}));
vi.mock('$lib/api/client.js', () => ({ apiGet, apiDelete, apiPost: vi.fn() }));
vi.mock('$lib/stores/modal.store', () => ({ modals: { open: openModal } }));

import TranscodeFailuresPage from './+page.svelte';
import type { PageData } from './$types';
import { page } from '$app/state';

const INCIDENT = {
    category: 'gpu-failure',
    encoder: 'hevc_qsv',
    occurrences: 7,
    distinctFiles: 2,
    distinctSessions: 3,
    firstSeen: '2026-09-01T10:00:00.000Z',
    lastSeen: '2026-09-02T11:00:00.000Z',
};

const SESSION = {
    playSessionId: 'play-session-1',
    mediaId: 'media-uuid-1',
    fileId: 'file-uuid-1',
    mediaTitle: 'Private Film (2019)',
    attemptCount: 3,
    firstSeen: '2026-09-01T10:00:00.000Z',
    lastSeen: '2026-09-01T10:05:00.000Z',
    terminalOutcome: 'failed',
};

const writeText = vi.fn();

describe('/admin/system/transcode-failures — exact clear scope', () => {
    const older = { ...INCIDENT, lastSeen: '2026-10-07T10:00:00.123455Z' };
    const newer = {
        ...INCIDENT,
        category: 'decode-error',
        lastSeen: '2026-10-07T10:00:00.123456Z',
    };

    beforeEach(() => {
        apiDelete.mockResolvedValue({ data: { cleared: 1 }, error: null });
        openModal.mockReset();
    });

    afterEach(() => {
        cleanup();
        apiGet.mockReset();
        apiDelete.mockReset();
        openModal.mockReset();
        toasts.success.mockReset();
        toasts.error.mockReset();
        page.url.search = '';
    });

    function renderIncidents(truncated = false): void {
        apiGet.mockResolvedValue({
            data: { incidents: [older, newer], truncated, totalGroups: truncated ? 101 : 2 },
            error: null,
            status: 200,
        });
        render(TranscodeFailuresPage, {
            data: {
                isAdmin: true,
                roots: { libraryRoots: ['/data'], transcodeRoot: '/tmp/transcode' },
            } as unknown as PageData,
        });
    }

    async function confirm(): Promise<void> {
        expect(openModal).toHaveBeenCalledTimes(1);
        const props = openModal.mock.calls[0][1] as { onConfirm: () => Promise<void> };
        await props.onConfirm();
    }

    function deletedQueries(): URLSearchParams[] {
        return apiDelete.mock.calls.map(
            ([url]) => new URL(url as string, 'http://localhost').searchParams,
        );
    }

    it('clear-all preserves the greatest cutoff including its microseconds', async () => {
        renderIncidents();
        const button = await screen.findByRole('button', { name: 'Clear all' });
        await fireEvent.click(button);
        expect(apiDelete).not.toHaveBeenCalled();
        await confirm();
        expect(deletedQueries().map((q) => Object.fromEntries(q))).toEqual([
            {
                outcome: 'failed',
                before: newer.lastSeen,
            },
        ]);
    });

    it('clear-one preserves its own cutoff and the scope originally confirmed', async () => {
        renderIncidents();
        const buttons = await screen.findAllByTitle('Clear this incident');
        await fireEvent.click(buttons[0]);
        await fireEvent.click(screen.getByRole('tab', { name: 'Recovered' }));
        await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
        await confirm();
        expect(deletedQueries().map((q) => Object.fromEntries(q))).toEqual([
            {
                outcome: 'failed',
                category: older.category,
                encoder: older.encoder,
                before: older.lastSeen,
            },
        ]);
    });

    it.each(['filtered', 'truncated'] as const)(
        'clear-all keeps per-group cutoffs for a %s list',
        async (scope) => {
            if (scope === 'filtered') page.url.search = '?encoder=hevc_qsv';
            renderIncidents(scope === 'truncated');
            const button = await screen.findByRole('button', {
                name: scope === 'filtered' ? 'Clear filtered' : 'Clear all',
            });
            await fireEvent.click(button);
            await confirm();
            expect(deletedQueries().map((q) => Object.fromEntries(q))).toEqual(
                [older, newer].map((incident) => ({
                    outcome: 'failed',
                    category: incident.category,
                    encoder: incident.encoder,
                    before: incident.lastSeen,
                })),
            );
        },
    );

    it('clear-all keeps its original outcome and cutoff when the page changes before confirmation', async () => {
        renderIncidents();
        const button = await screen.findByRole('button', { name: 'Clear all' });
        await fireEvent.click(button);
        await fireEvent.click(screen.getByRole('tab', { name: 'Recovered' }));
        await waitFor(() => expect(apiGet).toHaveBeenCalledTimes(2));
        await confirm();
        expect(deletedQueries().map((q) => Object.fromEntries(q))).toEqual([
            {
                outcome: 'failed',
                before: newer.lastSeen,
            },
        ]);
    });
});

function renderWith(libraryRoots: string[]): void {
    apiGet.mockImplementation(async (url: string) => {
        if (url.includes('/incident-sessions?')) {
            return { data: { sessions: [SESSION] }, error: null, status: 200 };
        }
        return { data: { incidents: [INCIDENT] }, error: null, status: 200 };
    });
    render(TranscodeFailuresPage, {
        // `PageData` also carries the whole /admin layout payload (branding,
        // feature flags, …) that this page never reads — same cast the admin
        // media page test uses for the fields it does not exercise.
        data: {
            isAdmin: true,
            roots: { libraryRoots, transcodeRoot: '/tmp/transcode' },
        } as unknown as PageData,
    });
}

function copyButton(): HTMLButtonElement {
    return screen.getByRole('button', { name: /copy for github/i }) as HTMLButtonElement;
}

describe('/admin/system/transcode-failures — Copy for GitHub', () => {
    beforeEach(() => {
        writeText.mockReset().mockResolvedValue(undefined);
        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        });
    });

    afterEach(() => {
        cleanup();
        apiGet.mockReset();
        toasts.success.mockReset();
        toasts.error.mockReset();
    });

    it('disables the button and explains why when no library root is known', async () => {
        renderWith([]);

        await waitFor(() => expect(copyButton().disabled).toBe(true));
        expect(screen.getByText(/paths cannot be redacted/i)).toBeTruthy();
    });

    it('copies the visible list as a redacted table once a library root is known', async () => {
        renderWith(['/data/movies']);

        await waitFor(() => expect(copyButton().disabled).toBe(false));
        expect(screen.queryByText(/paths cannot be redacted/i)).toBeNull();

        await fireEvent.click(copyButton());

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        const text = writeText.mock.calls[0][0] as string;
        expect(text).toContain('### Transcode failures — failed (1 incident)');
        expect(text).toContain('| `gpu-failure` | `hevc_qsv` | 7 | 2 | 3 |');
        expect(toasts.success).toHaveBeenCalledWith(expect.stringContaining('the visible list'));
    });

    it("scopes the copy to the expanded incident and omits its sessions' media identity", async () => {
        renderWith(['/data/movies']);
        await waitFor(() => expect(copyButton().disabled).toBe(false));

        // Expanding a row fetches the incident's sessions; the page renders
        // their media titles — the copy must not. The category cell now shows
        // a humanized label (see $lib/components/admin/transcode-failures/format.ts),
        // so the row is located by the raw category id kept in its `title`.
        await fireEvent.click(screen.getByTitle('gpu-failure'));
        await waitFor(() => expect(screen.getByText('Private Film (2019)')).toBeTruthy());

        await fireEvent.click(copyButton());

        await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
        const text = writeText.mock.calls[0][0] as string;
        expect(text).toContain('### Transcode failure — `gpu-failure` on `hevc_qsv` (failed)');
        expect(text).toContain('| Distinct files | 2 |');
        expect(text).toContain('**Sessions (1)**');
        expect(text).toContain('| 1 | 3 | `failed` |');
        expect(text).not.toContain('Private Film');
        expect(text).not.toContain('play-session-1');
        expect(text).not.toContain('file-uuid-1');
        expect(toasts.success).toHaveBeenCalledWith(
            expect.stringContaining('the expanded incident'),
        );
    });
});

describe('/admin/system/transcode-failures — overlapping requests', () => {
    afterEach(() => {
        cleanup();
        apiGet.mockReset();
    });

    type Resolver = (value: unknown) => void;

    it('a slow Failed-tab response does not replace the Recovered tab it was superseded by', async () => {
        const RECOVERED = { ...INCIDENT, category: 'decode-error', encoder: 'h264_vaapi' };
        let resolveFailed: Resolver = () => {};
        apiGet.mockImplementation((url: string) => {
            if (url.includes('outcome=failed')) {
                return new Promise((r) => (resolveFailed = r));
            }
            return Promise.resolve({ data: { incidents: [RECOVERED] }, error: null, status: 200 });
        });
        render(TranscodeFailuresPage, {
            data: {
                isAdmin: true,
                roots: { libraryRoots: ['/data'], transcodeRoot: '/tmp/transcode' },
            } as unknown as PageData,
        });

        await fireEvent.click(screen.getByRole('tab', { name: 'Recovered' }));
        await waitFor(() => expect(screen.getByTitle('decode-error')).toBeTruthy());

        resolveFailed({ data: { incidents: [INCIDENT] }, error: null, status: 200 });
        await new Promise((r) => setTimeout(r, 0));

        expect(screen.queryByTitle('gpu-failure')).toBeNull();
        expect(screen.getByTitle('decode-error')).toBeTruthy();
    });

    it("an older incident's sessions do not land under the row expanded after it", async () => {
        const OTHER = { ...INCIDENT, category: 'decode-error', encoder: 'h264_vaapi' };
        const pending: Resolver[] = [];
        apiGet.mockImplementation((url: string) => {
            if (url.includes('/incident-sessions?')) {
                if (url.includes('category=gpu-failure')) {
                    return new Promise((r) => pending.push(r));
                }
                return Promise.resolve({
                    data: { sessions: [{ ...SESSION, mediaTitle: 'Other Film' }] },
                    error: null,
                    status: 200,
                });
            }
            return Promise.resolve({
                data: { incidents: [INCIDENT, OTHER] },
                error: null,
                status: 200,
            });
        });
        render(TranscodeFailuresPage, {
            data: {
                isAdmin: true,
                roots: { libraryRoots: ['/data'], transcodeRoot: '/tmp/transcode' },
            } as unknown as PageData,
        });

        await waitFor(() => expect(screen.getByTitle('gpu-failure')).toBeTruthy());
        await fireEvent.click(screen.getByTitle('gpu-failure'));
        await fireEvent.click(screen.getByTitle('decode-error'));
        await waitFor(() => expect(screen.getByText('Other Film')).toBeTruthy());

        pending[0]({ data: { sessions: [SESSION] }, error: null, status: 200 });
        await new Promise((r) => setTimeout(r, 0));

        expect(screen.queryByText('Private Film (2019)')).toBeNull();
        expect(screen.getByText('Other Film')).toBeTruthy();
    });
});
