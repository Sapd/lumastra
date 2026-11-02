// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

// @vitest-environment happy-dom

/**
 * The delivery evidence spec Part 1/Part 2 put on the wire had no consumer: the
 * per-user response already carried `deliveryP10Bps`/`deliveryP50Bps` and the
 * user's own `speedTests`, and this drawer — the only thing that renders a
 * session list — showed neither. These tests pin what an operator must be able
 * to read off a row.
 *
 * The pair is rendered as "worst / typical" rather than as an average on
 * purpose: the signature this whole feature exists to catch is a link that is
 * normally ample and periodically collapses, which an average erases. So the
 * load-bearing assertions are that BOTH numbers appear, and that a missing one
 * reads as `—` rather than as 0.0 Mbit/s (a very different claim).
 */

import { render, screen, cleanup, fireEvent } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import SessionDetailDrawer from './SessionDetailDrawer.svelte';
import type { SpeedTestResultResponse } from '$lib/schemas/api-network-responses.js';

vi.mock('$lib/paraglide/messages', async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    const copy: Record<string, string> = {
        admin_redesign_sessions_live_title: 'Watching now',
        admin_redesign_sessions_status_filter: 'Filter sessions by playback state',
        admin_redesign_sessions_all: 'All sessions',
        admin_redesign_sessions_attention: 'Needs attention',
        admin_redesign_sessions_paused: 'Paused',
        admin_redesign_sessions_search: 'Find a session',
        admin_redesign_sessions_search_hint: 'Viewer, title, device or session ID',
        admin_redesign_sessions_media: 'Media',
        admin_redesign_sessions_music: 'Music & radio',
        admin_redesign_sessions_video: 'Video',
        admin_redesign_sessions_clear: 'Clear filters',
        admin_redesign_sessions_filter_note:
            'Reported playback problems appear first. Filters apply to tracked sessions; broadcasts still reach all active sessions.',
        admin_redesign_sessions_unavailable: 'Session data is unavailable. Refresh to try again.',
        admin_redesign_sessions_no_matches: 'No sessions match these filters.',
        admin_redesign_sessions_diagnostics: 'Diagnostics & playback plan',
        admin_redesign_sessions_description:
            'See who is watching, investigate playback problems and manage active streams.',
        admin_redesign_sessions_refresh_failed:
            'Some data could not be refreshed. Previously loaded details may be out of date; unavailable counts are shown as —.',
        admin_redesign_sessions_status_unknown: 'Playback state not reported',
        admin_redesign_sessions_buffering: 'Buffering',
        admin_redesign_sessions_close: 'Close session detail',
        admin_redesign_sessions_detail_for: 'Session detail for {label}',
        admin_redesign_sessions_detail_title: 'Playback diagnostics',
        admin_redesign_sessions_detail_note:
            'Recent session evidence for this viewer or device. Missing measurements are unavailable, not a sign of healthy playback.',
        admin_redesign_sessions_loading: 'Loading sessions…',
        admin_redesign_sessions_recent: 'Recent sessions',
        admin_redesign_sessions_with_issues: 'Sessions with reported issues',
        admin_redesign_sessions_delivery_percentiles: 'Delivery percentiles',
        admin_redesign_sessions_samples: '{count} samples',
        admin_redesign_sessions_no_history: 'No sessions found.',
        admin_redesign_sessions_score_unavailable: 'Quality score unavailable',
        admin_redesign_sessions_delivery: 'Delivery (worst / typical)',
        admin_redesign_sessions_windows: 'over {count} windows',
        admin_redesign_sessions_overdue: '{count} overdue',
        admin_redesign_sessions_root_cause: 'Root cause:',
        admin_redesign_sessions_device: 'Device type',
        admin_redesign_sessions_speed_tests: 'Recent speed tests',
        admin_redesign_sessions_speed_note:
            'Measurements started by this user, shown alongside session delivery evidence.',
        admin_redesign_sessions_detail_failed: 'Failed to load session detail',
        admin_redesign_sessions_retry: 'Try again',
    };
    return {
        ...actual,
        ...Object.fromEntries(
            Object.entries(copy).map(([key, value]) => [
                key,
                (params: Record<string, string | number> = {}) =>
                    value.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? '')),
            ]),
        ),
    };
});

/**
 * Declared here rather than imported from the component: a `.ts` file resolves
 * `*.svelte` through the ambient default-export declaration, so the module
 * script's named type exports are invisible to it (they are only visible from
 * another `.svelte` file, via svelte2tsx). These mirror the drawer's own
 * `<script module>` interfaces — structurally, which is all the props need.
 */
interface PlaybackQualitySessionDetail {
    sessionId: string;
    startedAt: string;
    healthScore?: number | null;
    playMethod?: string | null;
    deviceType?: string | null;
    issues?: string[] | null;
    rootCause?: string | null;
    scoringModelVersion?: number | null;
    deliveryP10Bps?: number | null;
    deliveryP50Bps?: number | null;
    deliveryWindows?: number | null;
    deliveryOverdue?: number | null;
}

interface SessionDetailResponse {
    sessions: PlaybackQualitySessionDetail[];
    speedTests?: SpeedTestResultResponse[] | null;
}

function session(
    overrides: Partial<PlaybackQualitySessionDetail> = {},
): PlaybackQualitySessionDetail {
    return {
        sessionId: '4b7e3d0e-7f4d-4f1a-9f1a-0f2a3b4c5d6e',
        startedAt: '2026-09-12T10:00:00.000Z',
        healthScore: 62,
        ...overrides,
    };
}

/** Serves one canned body to the drawer's own `fetch`. */
function serve(body: SessionDetailResponse): void {
    vi.stubGlobal(
        'fetch',
        vi.fn(() =>
            Promise.resolve({
                ok: true,
                status: 200,
                json: () => Promise.resolve(body),
            } as Response),
        ),
    );
}

function mount(): void {
    render(SessionDetailDrawer, {
        endpoint: '/api/admin/playback-quality/user/u1',
        label: 'alice',
        onclose: () => {},
    });
}

describe('SessionDetailDrawer — delivery evidence', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    afterEach(() => {
        cleanup();
        vi.unstubAllGlobals();
    });

    it('keeps a missing quality score explicitly unavailable', async () => {
        serve({ sessions: [session({ healthScore: null })] });
        mount();
        expect(await screen.findByText('Quality score unavailable')).toBeTruthy();
    });

    it('retries failed diagnostics without dismissing the drawer', async () => {
        const fetchMock = vi
            .fn()
            .mockResolvedValueOnce({ ok: false, status: 503 })
            .mockResolvedValueOnce({ ok: true, json: async () => ({ sessions: [] }) });
        vi.stubGlobal('fetch', fetchMock);
        mount();
        await fireEvent.click(await screen.findByRole('button', { name: 'Try again' }));
        expect(await screen.findByText('No sessions found.')).toBeTruthy();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('focuses the close control, closes on Escape and aborts on unmount', async () => {
        serve({ sessions: [] });
        const onclose = vi.fn();
        const view = render(SessionDetailDrawer, {
            endpoint: '/api/admin/playback-quality/user/u1',
            label: 'alice',
            onclose,
        });
        await screen.findByText('No sessions found.');
        const close = screen.getByRole('dialog').querySelector('button');
        expect(document.activeElement).toBe(close);
        await fireEvent.keyDown(window, { key: 'Escape' });
        expect(onclose).toHaveBeenCalledOnce();
        const signal = vi.mocked(fetch).mock.calls[0][1]?.signal;
        view.unmount();
        expect(signal?.aborted).toBe(true);
    });

    it('renders p10/p50 as worst / typical in Mbit/s next to the health score', async () => {
        serve({
            sessions: [
                session({
                    deliveryP10Bps: 4_000_000,
                    deliveryP50Bps: 20_000_000,
                    deliveryWindows: 6,
                }),
            ],
        });
        mount();

        expect(await screen.findByText(/Delivery \(worst \/ typical\)/)).toBeTruthy();
        // 4 Mbit/s collapse beside a 20 Mbit/s median — the shape an average hides.
        expect(screen.getByText(/4\.0 \/ 20\.0 Mbit\/s/)).toBeTruthy();
        expect(screen.getByText(/over 6 windows/)).toBeTruthy();
    });

    it('reads an absent percentile as — , never as 0.0 Mbit/s', async () => {
        serve({
            sessions: [session({ deliveryP10Bps: null, deliveryP50Bps: null, deliveryWindows: 2 })],
        });
        mount();

        expect(await screen.findByText(/— \/ — Mbit\/s/)).toBeTruthy();
        expect(screen.queryByText(/0\.0 \/ 0\.0 Mbit\/s/)).toBeNull();
    });

    it('surfaces the native overdue count when the player reported any', async () => {
        serve({
            sessions: [
                session({
                    deliveryP10Bps: 1_000_000,
                    deliveryP50Bps: 2_000_000,
                    deliveryOverdue: 7,
                }),
            ],
        });
        mount();

        expect(await screen.findByText(/7 overdue/)).toBeTruthy();
    });

    it('says nothing about delivery for a session that reported no windows', async () => {
        serve({ sessions: [session()] });
        mount();

        // Wait for the list itself before asserting the absence, or this passes
        // against the loading state.
        expect(await screen.findByRole('heading', { name: /Recent sessions/ })).toBeTruthy();
        expect(screen.queryByText(/Delivery \(worst \/ typical\)/)).toBeNull();
    });

    it('renders the speed-test strip under the session list', async () => {
        serve({
            sessions: [session()],
            speedTests: [
                {
                    id: 11,
                    mode: 'single' as const,
                    requestCount: 1,
                    maxTtfbMs: null,
                    minRequestBps: null,
                    throughputBps: 18_400_000,
                    ttfbMs: 42,
                    minBucketBps: 900_000,
                    stallMs: 500,
                    bytesReceived: 16_777_216,
                    durationMs: 7300,
                    aborted: true,
                    createdAt: '2026-09-12T09:58:00.000Z',
                },
            ],
        });
        mount();

        expect(await screen.findByText('Recent speed tests')).toBeTruthy();
        // `single` is labelled "quick" — the client calls the same profile that.
        expect(screen.getByText('quick')).toBeTruthy();
        expect(screen.getByText(/18\.4 Mbit\/s/)).toBeTruthy();
        expect(screen.getByText(/first byte 42 ms/)).toBeTruthy();
        expect(screen.getByText(/slowest ¼ s 0\.9 Mbit\/s/)).toBeTruthy();
        expect(screen.getByText(/stalled 500 ms/)).toBeTruthy();
        expect(screen.getByText(/gave up early/)).toBeTruthy();
    });

    it('labels the profile and swaps the bucket figures out for a cadence run', async () => {
        serve({
            sessions: [session()],
            speedTests: [
                {
                    id: 12,
                    mode: 'cadence' as const,
                    requestCount: 8,
                    maxTtfbMs: 910,
                    minRequestBps: 4_200_000,
                    throughputBps: 24_800_000,
                    ttfbMs: 38,
                    // A cadence run records no buckets at all, so there is no
                    // slowest quarter-second and no stall to report.
                    minBucketBps: null,
                    stallMs: 0,
                    bytesReceived: 33_554_432,
                    durationMs: 31_000,
                    aborted: false,
                    createdAt: '2026-09-13T09:58:00.000Z',
                },
            ],
        });
        mount();

        expect(await screen.findByText('cadence')).toBeTruthy();
        expect(screen.getByText(/24\.8 Mbit\/s/)).toBeTruthy();
        expect(screen.getByText(/worst segment 4\.2 Mbit\/s/)).toBeTruthy();
        // Label is "worst first byte" since the strip went through Paraglide,
        // matching the plain "first byte" label beside it.
        expect(screen.getByText(/worst first byte 910 ms/)).toBeTruthy();
        // The bucket-based pair would read as 0.0 Mbit/s and 0 ms here — a very
        // different claim from "not measured this way".
        expect(screen.queryByText(/slowest ¼ s/)).toBeNull();
        expect(screen.queryByText(/stalled/)).toBeNull();
    });

    it('omits the strip entirely on the per-device endpoint, which carries no speedTests', async () => {
        serve({ sessions: [session()] });
        mount();

        expect(await screen.findByRole('heading', { name: /Recent sessions/ })).toBeTruthy();
        expect(screen.queryByText('Recent speed tests')).toBeNull();
    });
});
