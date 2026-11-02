// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { cleanup, fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { page } from '$app/state';
import { replaceState } from '$app/navigation';
import ActivePlaySessionsPanel from './ActivePlaySessionsPanel.svelte';
import type { AdminPlaySession } from '$lib/schemas/api-admin-responses';
import type { FFmpegJobInfo } from '$lib/types/admin-metrics';
import * as m from '$lib/paraglide/messages';
import { sendSessionMessage } from '$lib/api/admin';
import { toasts } from '$lib/stores/toast.store';

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

vi.mock('$app/state', async () => {
    const { SvelteURL } = await import('svelte/reactivity');
    const { writable, fromStore } = await import('svelte/store');
    const state = fromStore(writable<App.PageState>({}));
    return {
        page: {
            url: new SvelteURL('http://localhost/admin/users/sessions'),
            get state() {
                return state.current;
            },
            set state(value: App.PageState) {
                state.current = value;
            },
        },
    };
});
vi.mock('$app/navigation', async () => {
    const { page } = await import('$app/state');
    return {
        pushState: vi.fn(),
        replaceState: vi.fn((_url: URL, state: App.PageState) => {
            page.state = state;
        }),
    };
});
vi.mock('$lib/utils/modal-utils', () => ({ openMediaModalFromUrl: vi.fn() }));
vi.mock('$lib/api/admin', () => ({
    sendSessionMessage: vi.fn(),
    getAdminPlaybackPlan: vi.fn(),
}));

function session(id: string, overrides: Partial<AdminPlaySession> = {}): AdminPlaySession {
    return {
        __id: id,
        username: id,
        title: 'Title ' + id,
        clientname: 'Web',
        browsername: 'Safari',
        source: 'lumastra',
        media_type: 'movie',
        playIsPlaying: true,
        ...overrides,
    };
}
function props(sessions: AdminPlaySession[]) {
    return {
        sessions,
        loading: false,
        proxyStatus: null,
        liveTvError: false,
        isStandalone: false,
        jobsBySession: new Map<string, FFmpegJobInfo[]>(),
        killingSessionId: null,
        killingChannelId: null,
        stoppingJobId: null,
        onKillSession: vi.fn(),
        onKillChannel: vi.fn(),
        onStopJob: vi.fn(),
        messageUsersHref: '/admin/notifications',
        urlFilters: true,
    };
}
beforeEach(() => {
    page.state = {};
    page.url.search = '';
    vi.clearAllMocks();
});
afterEach(cleanup);

describe('session artwork', () => {
    it('fits channel logos without cropping and replaces missing logos with an icon', async () => {
        const { container } = render(
            ActivePlaySessionsPanel,
            props([
                session('live', { media_type: 'tvchannel', media_id: 'feed-id' }),
                session('movie', { media_id: 'movie-id' }),
                session('episode', {
                    media_type: 'episode',
                    media_id: 'episode-id',
                    series_id: 'series-id',
                }),
            ]),
        );
        const logo = container.querySelector<HTMLImageElement>('img[src*="/feed-id/"]')!;
        expect(logo).not.toBeNull();
        expect(logo.src).toContain('fallback=none');
        expect(logo.classList.contains('object-contain')).toBe(true);
        expect(
            container.querySelector('img[src*="/movie-id/"]')?.classList.contains('object-cover'),
        ).toBe(true);
        expect(container.querySelector('img[src*="/series-id/"]')).not.toBeNull();
        expect(container.querySelector('img[src*="/episode-id/"]')).toBeNull();
        await fireEvent.error(logo);
        expect(container.querySelector('img[src*="/feed-id/"]')).toBeNull();
        expect(screen.getByText('Title live')).toBeTruthy();
    });

    it('shows a logo beside the relay channel and handles a missing logo', async () => {
        const { container } = render(ActivePlaySessionsPanel, {
            ...props([]),
            isStandalone: true,
            proxyStatus: {
                healthy: true,
                uptime: 60,
                ffmpegAvailable: true,
                totalViewers: 1,
                activeChannels: 1,
                perSourceLimits: [],
                channels: [
                    {
                        channelId: 'relay-feed',
                        channelName: 'DAZN 2',
                        viewers: 1,
                        sourceId: 'source',
                        ffmpegHealthy: true,
                        startedAt: new Date().toISOString(),
                    },
                ],
            },
        });
        const logo = container.querySelector<HTMLImageElement>('img[src*="/relay-feed/"]')!;
        expect(logo).not.toBeNull();
        expect(logo.src).toContain('fallback=none');
        expect(logo.classList.contains('object-contain')).toBe(true);
        await fireEvent.error(logo);
        expect(container.querySelector('img[src*="/relay-feed/"]')).toBeNull();
        expect(screen.getByText('DAZN 2')).toBeTruthy();
    });
});

describe('active session operations', () => {
    it('shows CarPlay only for a reported connected context and clears after disconnect', async () => {
        const rendered = render(ActivePlaySessionsPanel, {
            props: props([session('phone', { isCarPlay: true })]),
        });
        expect(screen.getByText('CarPlay')).toBeTruthy();
        await rendered.rerender({ ...props([session('phone', { isCarPlay: false })]) });
        expect(screen.queryByText('CarPlay')).toBeNull();
    });

    it('puts reported problems first and keeps paused sessions out of attention', async () => {
        render(ActivePlaySessionsPanel, {
            props: props([
                session('paused', { playIsPlaying: false }),
                session('watching'),
                session('buffering', { isBuffering: true }),
                session('crashed', { status: 'CRASHED' }),
            ]),
        });
        expect(
            screen
                .getByText('Title buffering')
                .compareDocumentPosition(screen.getByText('Title watching')) &
                Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        await fireEvent.click(screen.getByRole('button', { name: /^Needs attention/ }));
        expect(screen.queryByText('Title paused')).toBeNull();
        expect(screen.queryByText('Title watching')).toBeNull();
        expect(screen.getByText('Title buffering')).toBeTruthy();
        expect(screen.getByText('Title crashed')).toBeTruthy();
        expect(new URL(page.state.adminWorkspaceUrl!).searchParams.get('health')).toBe('attention');
        expect(page.url.search).toBe('');
    });

    it('restores URL filters, includes radio under music, and preserves unrelated parameters', async () => {
        page.url.search = '?media=music&q=radio&keep=yes';
        render(ActivePlaySessionsPanel, {
            props: props([session('radio', { media_type: 'radio' }), session('movie')]),
        });
        expect(screen.getByText('Title radio')).toBeTruthy();
        expect(screen.queryByText('Title movie')).toBeNull();
        await fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
        expect(screen.getByText('Title movie')).toBeTruthy();
        expect(new URL(page.state.adminWorkspaceUrl!).search).toBe('?keep=yes');
        expect(replaceState).toHaveBeenCalled();
    });

    it('searches without narrowing the message audience or duplicating session controls', async () => {
        const callbacks = props([session('alice'), session('bob')]);
        render(ActivePlaySessionsPanel, { props: callbacks });
        await fireEvent.input(screen.getByRole('searchbox'), { target: { value: 'alice' } });
        expect(screen.queryByText('Title bob')).toBeNull();
        expect(screen.getAllByRole('button', { name: 'Terminate session' })).toHaveLength(1);
        await fireEvent.click(screen.getByRole('button', { name: 'Terminate session' }));
        expect(callbacks.onKillSession).toHaveBeenCalledWith('alice', 'alice', 'Title alice');
        // Messaging everyone lives on the Message users page now; the header links there.
        expect(screen.getByRole('link', { name: 'Message users' }).getAttribute('href')).toContain(
            '/admin/notifications?kind=live',
        );
        expect(
            screen
                .getByRole('button', { name: /This client can't display messages/ })
                .hasAttribute('disabled'),
        ).toBe(true);
    });

    it('distinguishes unavailable data from an empty live session list', () => {
        render(ActivePlaySessionsPanel, { props: { ...props([]), loadError: true } });
        expect(screen.getByRole('status').textContent).toContain('Session data is unavailable');
        expect(screen.queryByText('No active sessions right now')).toBeNull();
    });

    it('does not label missing playback telemetry as playing', async () => {
        render(ActivePlaySessionsPanel, {
            props: props([session('unknown', { playIsPlaying: undefined })]),
        });
        // Playback state lives in the row's expansion; the summary shows no "playing" claim either.
        await fireEvent.click(screen.getByRole('button', { name: /^Show or hide details for/ }));
        expect(screen.getByText('Playback state not reported')).toBeTruthy();
    });

    it('keeps diagnostics collapsed until the row is opened', async () => {
        render(ActivePlaySessionsPanel, { props: props([session('alice')]) });
        const toggle = screen.getByRole('button', { name: /^Show or hide details for/ });
        expect(toggle.getAttribute('aria-expanded')).toBe('false');
        expect(screen.queryByText('Diagnostics & playback plan')).toBeNull();
        await fireEvent.click(toggle);
        expect(toggle.getAttribute('aria-expanded')).toBe('true');
    });

    it('falls back to all sessions for unrecognized URL filters', () => {
        page.url.search = '?media=invalid&health=invalid';
        render(ActivePlaySessionsPanel, { props: props([session('alice')]) });
        expect(screen.getByText('Title alice')).toBeTruthy();
        expect(
            screen.getByRole('button', { name: /^All sessions/ }).getAttribute('aria-pressed'),
        ).toBe('true');
        expect((screen.getByRole('combobox') as HTMLSelectElement).value).toBe('all');
    });

    it('flags a session whose encode cannot keep up, and says why in the hint', () => {
        const job = {
            jobId: 'j1',
            playSessionId: 'alice',
            itemId: 'i1',
            username: 'alice',
            deviceId: 'd1',
            status: 'running',
            mode: 'full',
            startedAt: new Date().toISOString(),
            elapsedSeconds: 60,
            lastAccessedAt: new Date().toISOString(),
            lastAccessedSecondsAgo: 0,
            lastProgressAt: new Date().toISOString(),
            lastProgressSecondsAgo: 0,
            segmentsReady: 5,
            segmentOffset: 0,
            totalSegments: 100,
            progressPercent: 5,
            masterPlaylistReady: true,
            isSeeking: false,
            seekCount: 0,
            audioTrackCount: 0,
            audioTracks: [],
            subtitleTrackCount: 0,
            subtitles: [],
            processRunning: true,
            outputDir: '/tmp/x',
            slowReason: 'gpu_busy',
            softwareFallbackFrom: 'hevc_nvenc',
        } as FFmpegJobInfo;
        const base = props([session('alice', { playMethod: 'transcode' })]);
        render(ActivePlaySessionsPanel, {
            props: { ...base, jobsBySession: new Map([['alice', [job]]]) },
        });
        const badge = screen.getByTestId('session-slow-transcode');
        expect(badge.textContent?.trim()).toBe(m.admin_sessions_slow_gpu_busy());
        const hinted = badge.closest('[title]');
        expect(hinted?.getAttribute('title')).toContain(
            m.admin_sessions_software_fallback_hint({ encoder: 'hevc_nvenc' }),
        );
    });

    it('sends an admin message as a ui.message command capped at 280 characters', async () => {
        vi.mocked(sendSessionMessage).mockResolvedValue({
            data: { delivery: 'toast' },
            error: null,
            status: 202,
        });
        const success = vi.spyOn(toasts, 'success').mockImplementation(() => 0);
        render(ActivePlaySessionsPanel, {
            props: props([session('alice', { clientFeatures: ['admin_message'] })]),
        });
        await fireEvent.click(screen.getByRole('button', { name: /Send message to this session/ }));
        const box = screen.getByPlaceholderText('Enter message…') as HTMLTextAreaElement;
        expect(box.maxLength).toBe(280);
        expect(screen.queryByText('seconds')).toBeNull();
        await fireEvent.input(box, { target: { value: 'Restart in five minutes' } });
        await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await vi.waitFor(() => expect(sendSessionMessage).toHaveBeenCalled());
        expect(sendSessionMessage).toHaveBeenCalledWith('alice', {
            text: 'Restart in five minutes',
            severity: 'info',
        });
        await vi.waitFor(() =>
            expect(success).toHaveBeenCalledWith(m.admin_session_message_sent()),
        );
        success.mockRestore();
    });

    it('reports the failure when the message cannot be sent', async () => {
        vi.mocked(sendSessionMessage).mockResolvedValue({ data: null, error: 'Nope', status: 500 });
        const failure = vi.spyOn(toasts, 'error').mockImplementation(() => 0);
        render(ActivePlaySessionsPanel, {
            props: props([session('alice', { clientFeatures: ['admin_message'] })]),
        });
        await fireEvent.click(screen.getByRole('button', { name: /Send message to this session/ }));
        await fireEvent.input(screen.getByPlaceholderText('Enter message…'), {
            target: { value: 'Hello' },
        });
        await fireEvent.click(screen.getByRole('button', { name: 'Send' }));
        await vi.waitFor(() => expect(failure).toHaveBeenCalledWith('Nope'));
        failure.mockRestore();
    });
});

it('shows the client build beside the app name in active sessions', () => {
    render(ActivePlaySessionsPanel, {
        props: props([
            session('apple', {
                clientname: 'Apple',
                clientVersion: '1.0.1 (2610140823)',
                browsername: 'Apple',
            }),
        ]),
    });
    expect(screen.getAllByText('Apple 1.0.1 (2610140823)').length).toBeGreaterThan(0);
});

it('keeps the app label readable when an older session has no build', () => {
    render(ActivePlaySessionsPanel, {
        props: props([
            session('old', {
                clientname: 'LegacyApp',
                browsername: 'LegacyApp',
            }),
        ]),
    });
    expect(screen.getAllByText('LegacyApp').length).toBeGreaterThan(0);
});
