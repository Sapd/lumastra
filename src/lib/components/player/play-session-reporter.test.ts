// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API module so startPlaySession does not make real network calls
const mockStartPlaySession = vi.fn();
vi.mock('$lib/api/playback.js', () => ({
    startPlaySession: (...args: unknown[]) => mockStartPlaySession(...args),
}));

// Mock the admin event handler module
const mockHandleAdminEvent = vi.fn();
vi.mock('$lib/services/sse/admin-event-handler.js', () => ({
    handleAdminEvent: (...args: unknown[]) => mockHandleAdminEvent(...args),
}));

// Mock apiPut from the typed API client — PlaySessionReporter.update() calls apiPut
// (which goes through monitoredFetch), not the raw global fetch. Global fetch is
// only used for the bare SSE subscription in subscribeToKillEvents.
const mockApiPut = vi.fn();
const mockApiGet = vi.fn();
vi.mock('$lib/api/client.js', () => ({
    apiPut: (...args: unknown[]) => mockApiPut(...args),
    apiGet: (...args: unknown[]) => mockApiGet(...args),
}));

// Mock fetch globally for bare fetch calls (SSE /api/play-sessions/:id/events)
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import { playbackStartFixture } from '$lib/utils/playback-start.fixture.js';

import { PlaySessionReporter } from './play-session-reporter.js';

describe('PlaySessionReporter', () => {
    beforeEach(() => {
        mockFetch.mockReset().mockResolvedValue({ ok: false });
        mockStartPlaySession.mockReset();
        mockApiPut.mockReset().mockResolvedValue({ data: null, error: null, status: 204 });
    });

    describe('adaptive (ABR) block', () => {
        const report = { variant_id: '720p4m', height: 720, switches: 2, rebuffers: 0 };
        function reporterWith(getAdaptiveReport: () => typeof report | undefined) {
            mockApiPut.mockResolvedValue({ data: { action: undefined }, error: null, status: 200 });
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
                getAdaptiveReport,
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-abr';
            return reporter;
        }
        function sentBody(): Record<string, unknown> {
            return mockApiPut.mock.calls.at(-1)?.[2] as Record<string, unknown>;
        }

        it('rides the heartbeat', async () => {
            const reporter = reporterWith(() => report);
            await reporter.report('progress', makeData());
            expect(sentBody().adaptive).toEqual(report);
        });

        it('is left out of the final stop', async () => {
            const getAdaptiveReport = vi.fn(() => report);
            const reporter = reporterWith(getAdaptiveReport);
            await reporter.report('stop', makeData());
            expect(sentBody().status).toBe('COMPLETED');
            expect(sentBody().adaptive).toBeUndefined();
        });

        it('a throwing provider still sends the heartbeat', async () => {
            const reporter = reporterWith(() => {
                throw new Error('hls gone');
            });
            await reporter.report('progress', makeData());
            expect(mockApiPut).toHaveBeenCalledOnce();
            expect(sentBody().adaptive).toBeUndefined();
        });
    });

    it.each([
        { fileId: undefined, subtitleStreamIndex: 2, subtitleId: undefined, expected: 'none' },
        { fileId: 'file', subtitleStreamIndex: null, subtitleId: undefined, expected: 'none' },
        { fileId: 'file', subtitleStreamIndex: 2, subtitleId: undefined, expected: 'file:2' },
        {
            fileId: undefined,
            subtitleStreamIndex: 2,
            subtitleId: 'descriptor',
            expected: 'descriptor',
        },
    ])(
        'starts with a valid subtitle id: %j',
        async ({ fileId, subtitleStreamIndex, subtitleId, expected }) => {
            mockStartPlaySession.mockResolvedValueOnce({ data: null, status: 500 });
            const reporter = new PlaySessionReporter({ mediaId: 'm', deviceId: 'd', fileId });
            await reporter.report('start', { ...makeData(), subtitleStreamIndex, subtitleId });
            expect(mockStartPlaySession).toHaveBeenCalledWith(
                expect.objectContaining({ subtitleId: expected }),
            );
        },
    );

    describe('auth loss', () => {
        afterEach(() => {
            mockApiPut.mockReset();
            mockApiGet.mockReset();
            mockStartPlaySession.mockReset();
        });

        it('calls onAuthLost when the session start answers 401', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: null,
                error: 'Authentication required',
                status: 401,
            });
            const onAuthLost = vi.fn();
            const reporter = new PlaySessionReporter({ mediaId: 'm', deviceId: 'd', onAuthLost });

            expect(await reporter.report('start', makeData())).toBe(false);
            expect(onAuthLost).toHaveBeenCalledTimes(1);
        });

        it('calls onAuthLost when a heartbeat answers 401', async () => {
            mockApiPut.mockResolvedValue({
                data: null,
                error: 'Authentication required',
                status: 401,
            });
            // Any restart attempt fails without a 401, so the call can only
            // come from the heartbeat itself.
            mockStartPlaySession.mockResolvedValue({ data: null, error: 'boom', status: 500 });
            const onAuthLost = vi.fn();
            const reporter = new PlaySessionReporter({ mediaId: 'm', deviceId: 'd', onAuthLost });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            await reporter.report('progress', makeData());
            expect(onAuthLost).toHaveBeenCalledTimes(1);
        });

        it('does not call onAuthLost when a final stop answers 401', async () => {
            mockApiPut.mockResolvedValue({
                data: null,
                error: 'Authentication required',
                status: 401,
            });
            mockStartPlaySession.mockResolvedValue({ data: null, error: 'boom', status: 500 });
            const onAuthLost = vi.fn();
            const reporter = new PlaySessionReporter({ mediaId: 'm', deviceId: 'd', onAuthLost });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            await reporter.report('stop', makeData());
            expect(mockApiPut).toHaveBeenCalledWith(
                '/api/play-sessions/sess-1',
                expect.anything(),
                expect.objectContaining({ status: 'COMPLETED' }),
            );
            expect(onAuthLost).not.toHaveBeenCalled();
        });

        it('calls onAuthLost when the transcode-progress poll answers 401', async () => {
            mockApiGet.mockResolvedValueOnce({
                data: null,
                error: 'Authentication required',
                status: 401,
            });
            const onAuthLost = vi.fn();
            const reporter = new PlaySessionReporter({ mediaId: 'm', deviceId: 'd', onAuthLost });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            await (
                reporter as unknown as { pollTranscodeProgress(): Promise<void> }
            ).pollTranscodeProgress();
            expect(mockApiGet).toHaveBeenCalledWith(
                '/api/play-sessions/sess-1/transcode-progress',
                expect.anything(),
            );
            expect(onAuthLost).toHaveBeenCalledTimes(1);
        });

        it('does not call onAuthLost for other failures', async () => {
            mockApiPut.mockResolvedValueOnce({ data: null, error: 'Forbidden', status: 403 });
            const onAuthLost = vi.fn();
            const reporter = new PlaySessionReporter({ mediaId: 'm', deviceId: 'd', onAuthLost });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            await reporter.report('progress', makeData());
            expect(onAuthLost).not.toHaveBeenCalled();
        });
    });

    describe('report start', () => {
        it('POSTs to /api/play-sessions and stores session_id', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'test-uuid'),
                error: null,
                status: 200,
            });
            // SSE fetch (returns a never-resolving response)
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);

            const reporter = new PlaySessionReporter({
                mediaId: 'media-uuid',
                deviceId: 'dev-1',
            });

            const result = await reporter.report('start', makeData());
            expect(result).toBe(true);
            expect(mockStartPlaySession).toHaveBeenCalledWith(
                expect.objectContaining({ mediaId: 'media-uuid' }),
            );
        });

        it('sends the entry on every start (restarts included)', async () => {
            mockStartPlaySession.mockResolvedValue({
                data: playbackStartFixture('media-1', 'test-uuid'),
                error: null,
                status: 200,
            });
            mockFetch.mockResolvedValue({
                ok: true,
                body: { getReader: () => ({ read: () => new Promise(() => {}) }) },
            } as unknown as Response);
            let entry: 'next_up' | 'explicit' = 'next_up';
            const reporter = new PlaySessionReporter({
                mediaId: 'media-uuid',
                deviceId: 'dev-1',
                getEntry: () => entry,
            });

            await reporter.report('start', makeData());
            expect(mockStartPlaySession).toHaveBeenLastCalledWith(
                expect.objectContaining({ entry: 'next_up' }),
            );
            reporter.setSessionId(undefined);
            entry = 'explicit';
            await reporter.report('start', makeData());
            expect(mockStartPlaySession).toHaveBeenLastCalledWith(
                expect.objectContaining({ entry: 'explicit' }),
            );
        });

        it('returns false if POST fails', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: null,
                error: 'Stream slot limit reached',
                code: 'stream_limit',
                status: 422,
            });

            const reporter = new PlaySessionReporter({
                mediaId: 'media-uuid',
                deviceId: 'dev-1',
            });

            const result = await reporter.report('start', makeData());
            expect(result).toBe(false);
        });

        it('calls onPolicyBlocked with a friendly message on 422 stream_limit_exceeded (with detail)', async () => {
            // Real shape: the play-sessions route JSON.stringifies its detail
            // object into problem+json's `details` field (see
            // ApiResponses.unprocessableEntity), and the typed client passes
            // that string through verbatim on ApiResult.details.
            mockStartPlaySession.mockResolvedValueOnce({
                data: null,
                error: 'Stream slot limit reached',
                code: 'stream_limit',
                status: 422,
                details: { active: 2, limit: 2 },
            });

            const onPolicyBlocked = vi.fn();
            const onError = vi.fn();
            const reporter = new PlaySessionReporter({
                mediaId: 'media-uuid',
                deviceId: 'dev-1',
                onPolicyBlocked,
                onError,
            });

            const result = await reporter.report('start', makeData());

            expect(result).toBe(false);
            expect(onError).not.toHaveBeenCalled();
            expect(onPolicyBlocked).toHaveBeenCalledTimes(1);
            const info = onPolicyBlocked.mock.calls[0][0] as { kind: string; message: string };
            expect(info.kind).toBe('stream_limit');
            expect(info.message).toContain('2 of 2');
        });

        it('falls back to onError when onPolicyBlocked is not provided', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: null,
                error: 'Stream slot limit reached',
                code: 'stream_limit',
                status: 422,
                details: { active: 2, limit: 2 },
            });

            const onError = vi.fn();
            const reporter = new PlaySessionReporter({
                mediaId: 'media-uuid',
                deviceId: 'dev-1',
                onError,
            });

            const result = await reporter.report('start', makeData());

            expect(result).toBe(false);
            expect(onError).toHaveBeenCalledTimes(1);
            expect(onError.mock.calls[0][0]).toContain('2 of 2');
        });
    });

    describe('report progress (heartbeat)', () => {
        it('PUTs to the session endpoint', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            const result = await reporter.report('progress', makeData());
            expect(result).toBe(true);
            expect(mockApiPut).toHaveBeenCalledWith(
                '/api/play-sessions/sess-1',
                expect.anything(),
                expect.any(Object),
            );
        });

        it('sends ACTIVE status for playing', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            await reporter.report('progress', makeData());
            const body = mockApiPut.mock.calls[0][2] as { status: string };
            expect(body.status).toBe('ACTIVE');
        });

        it('sends PAUSED status when paused', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            await reporter.report('progress', {
                ...makeData(),
                isPaused: true,
            });
            const body = mockApiPut.mock.calls[0][2] as { status: string };
            expect(body.status).toBe('PAUSED');
        });

        it('returns false if no session started yet', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            const result = await reporter.report('progress', makeData());
            expect(result).toBe(false);
        });

        it('restarts the play session when progress finds no local session', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'new-sess'),
                error: null,
                status: 201,
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);
            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });

            const result = await reporter.report('progress', makeData());

            expect(result).toBe(true);
            expect(mockStartPlaySession).toHaveBeenCalledTimes(1);
            expect(mockApiPut).toHaveBeenCalledWith(
                '/api/play-sessions/new-sess',
                expect.anything(),
                expect.any(Object),
            );
        });

        it('restarts the play session when a stale heartbeat is rejected', async () => {
            mockApiPut.mockResolvedValueOnce({
                data: { action: 'kill', reason: 'session_ended' },
                error: null,
                status: 200,
            });
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'revived-sess'),
                error: null,
                status: 201,
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);
            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            const onKill = vi.fn();
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
                onKill,
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'stale-sess';

            const result = await reporter.report('progress', makeData());

            expect(result).toBe(true);
            expect(onKill).not.toHaveBeenCalled();
            expect(mockStartPlaySession).toHaveBeenCalledTimes(1);
            expect(mockApiPut).toHaveBeenLastCalledWith(
                '/api/play-sessions/revived-sess',
                expect.anything(),
                expect.any(Object),
            );
        });

        it('restarts the play session when progress returns 404', async () => {
            mockApiPut.mockResolvedValueOnce({ data: null, error: 'Not Found', status: 404 });
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'replacement-sess'),
                error: null,
                status: 201,
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);
            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'missing-sess';

            const result = await reporter.report('progress', makeData());

            expect(result).toBe(true);
            expect(mockStartPlaySession).toHaveBeenCalledTimes(1);
            expect(mockApiPut).toHaveBeenLastCalledWith(
                '/api/play-sessions/replacement-sess',
                expect.anything(),
                expect.any(Object),
            );
        });

        it('an audio-only start disables subtitles explicitly', async () => {
            const reporter = new PlaySessionReporter({ mediaId: 'media-uuid', deviceId: 'dev-1' });
            reporter.setRequestedMethod('audio_only');
            await reporter.report('start', {
                ...makeData(),
                subtitleStreamIndex: 3,
                subtitleId: 'stable-subtitle',
            });
            expect(mockStartPlaySession).toHaveBeenCalledWith(
                expect.objectContaining({ requestedMethod: 'audio_only', subtitleId: 'none' }),
            );
        });

        it('forwards subtitleMethod to the heartbeat body', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            await reporter.report('progress', {
                ...makeData(),
                subtitleStreamIndex: 2,
                subtitleLanguage: 'ger',
                subtitleMethod: 'external_vtt' as const,
            });
            const body = mockApiPut.mock.calls[0][2] as { subtitleMethod?: string };
            expect(body.subtitleMethod).toBe('external_vtt');
        });

        it('carries the selected play method on the heartbeat body', async () => {
            // Switching into audio-only happens mid-playback via a quality
            // restart that never re-runs startSession, so play_method can
            // only reach the row through the heartbeat. Without this, the
            // row keeps whatever method the session started with.
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';
            reporter.setSelectedMethod('audio_only');

            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            await reporter.report('progress', makeData());
            const body = mockApiPut.mock.calls[0][2] as { playMethod?: string };
            expect(body.playMethod).toBe('audio_only');
        });
    });

    describe('report stop', () => {
        it('PUTs with COMPLETED status', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            const result = await reporter.report('stop', makeData());
            expect(result).toBe(true);
            expect(mockApiPut).toHaveBeenCalledWith(
                '/api/play-sessions/sess-1',
                expect.anything(),
                expect.any(Object),
            );
            const body = mockApiPut.mock.calls[0][2] as { status: string; endReason: string };
            expect(body.status).toBe('COMPLETED');
            expect(body.endReason).toBe('user');
        });

        it('does NOT call /stop endpoint', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            await reporter.report('stop', makeData());
            const url = mockApiPut.mock.calls[0][0] as string;
            expect(url).not.toContain('/stop');
        });

        // These three mirror the "restarts the play session when progress ..."
        // cases above — a completion report must not be silently dropped just
        // because the session it targets is already gone. Without retrying
        // stop through session recovery, a heartbeat-reaped session (e.g. a
        // container restart mid-episode) leaves the episode's watch state
        // frozen at the last successful heartbeat forever, since nothing else
        // ever fires the terminal COMPLETED write.
        it('restarts the play session when stop finds no local session', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'new-sess'),
                error: null,
                status: 201,
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);
            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });

            const result = await reporter.report('stop', makeData());

            expect(result).toBe(true);
            expect(mockStartPlaySession).toHaveBeenCalledTimes(1);
            expect(mockApiPut).toHaveBeenCalledWith(
                '/api/play-sessions/new-sess',
                expect.anything(),
                expect.any(Object),
            );
            const body = mockApiPut.mock.calls[0][2] as { status: string };
            expect(body.status).toBe('COMPLETED');
        });

        it('restarts the play session when stop hits an already-reaped session (404)', async () => {
            mockApiPut.mockResolvedValueOnce({ data: null, error: 'Not Found', status: 404 });
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'replacement-sess'),
                error: null,
                status: 201,
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);
            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'crashed-sess';

            const result = await reporter.report('stop', makeData());

            expect(result).toBe(true);
            expect(mockStartPlaySession).toHaveBeenCalledTimes(1);
            expect(mockApiPut).toHaveBeenLastCalledWith(
                '/api/play-sessions/replacement-sess',
                expect.anything(),
                expect.any(Object),
            );
            const body = mockApiPut.mock.calls[1][2] as { status: string; endReason: string };
            expect(body.status).toBe('COMPLETED');
            expect(body.endReason).toBe('user');
        });

        it('does not retry stop when the session was superseded (kill result already succeeded)', async () => {
            mockApiPut.mockResolvedValueOnce({
                data: { action: 'kill', reason: 'admin' },
                error: null,
                status: 200,
            });

            const onKill = vi.fn();
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
                onKill,
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            const result = await reporter.report('stop', makeData());

            expect(result).toBe(true);
            expect(onKill).toHaveBeenCalledWith('admin');
            expect(mockStartPlaySession).not.toHaveBeenCalled();
        });
    });

    describe('kill action handling', () => {
        it('calls onKill when 200 response with kill action', async () => {
            const onKill = vi.fn();
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
                onKill,
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({
                data: { action: 'kill', reason: 'admin' },
                error: null,
                status: 200,
            });

            await reporter.report('progress', makeData());
            expect(onKill).toHaveBeenCalledWith('admin');
        });
    });

    describe('onHeartbeatAck callback', () => {
        it('fires onHeartbeatAck on a 200 heartbeat-success body', async () => {
            const onHeartbeatAck = vi.fn();
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
                onHeartbeatAck,
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({
                data: { resumeAnchorAt: new Date(42000).toISOString(), progressSaved: true },
                error: null,
                status: 200,
            });

            await reporter.report('progress', makeData());
            expect(onHeartbeatAck).toHaveBeenCalledWith({
                resume_anchor_epoch_ms: 42000,
                wrote_to_durable: true,
            });
        });

        it('does not fire onHeartbeatAck when the 200 body has superseded: true', async () => {
            const onHeartbeatAck = vi.fn();
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
                onHeartbeatAck,
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({
                data: { superseded: true, progressSaved: false },
                error: null,
                status: 200,
            });

            await reporter.report('progress', makeData());
            expect(onHeartbeatAck).not.toHaveBeenCalled();
        });

        it('clears sessionId on a COMPLETED stop that returns 200 (kill-on-stop path)', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-kill';

            mockApiPut.mockResolvedValueOnce({
                data: { action: 'kill', reason: 'admin' },
                error: null,
                status: 200,
            });

            await reporter.report('stop', makeData());

            // sessionId is private — verify via observable behaviour: a
            // subsequent update() call must short-circuit (no apiPut issued)
            // because sessionId is null after the kill response.
            mockApiPut.mockReset();
            await reporter.report('progress', makeData());
            expect(mockApiPut).not.toHaveBeenCalled();
        });
    });

    describe('updateViaBeacon', () => {
        it('sends to /beacon endpoint via sendBeacon', () => {
            vi.stubGlobal('navigator', {
                sendBeacon: vi.fn().mockReturnValue(true),
            });

            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            const result = reporter.updateViaBeacon({
                position_ms: 60000,
                status: 'COMPLETED',
                end_reason: 'unload',
                session_elapsed_ms: 0, // unrelated to this test's assertions (endpoint + Blob body)
            });

            expect(result).toBe(true);
            expect(navigator.sendBeacon).toHaveBeenCalledWith(
                '/api/play-sessions/sess-1/beacon',
                expect.any(Blob),
            );

            vi.unstubAllGlobals();
            vi.stubGlobal('fetch', mockFetch);
        });
    });

    describe('setLumastraContext', () => {
        it('selects the probed file without turning display state into an override', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'test-uuid'),
                error: null,
                status: 200,
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);

            const reporter = new PlaySessionReporter({
                mediaId: 'media-uuid',
                deviceId: 'dev-1',
            });

            reporter.setLumastraContext({
                fileId: 'file-abc',
            });
            reporter.setSelectedMethod('full_transcode');

            await reporter.report('start', makeData());

            expect(mockStartPlaySession).toHaveBeenCalledWith(
                expect.objectContaining({
                    mediaId: 'media-uuid',
                    fileId: 'file-abc',
                }),
            );
            const body = mockStartPlaySession.mock.calls[0][0] as {
                requestedMethod: string;
            };
            expect(body.requestedMethod).toBeUndefined();
        });

        // `audio_only` is included deliberately: `toPlayMethodOrDefault` had no
        // arm for it and fell back to `'direct'`, so an audio-only session was
        // recorded as DIRECT PLAY — a quietly wrong row rather than a failure.
        it('preserves explicit user or playback-error overrides on the wire', async () => {
            for (const method of ['full_transcode', 'audio_transcode', 'audio_only'] as const) {
                mockStartPlaySession.mockReset();
                mockFetch.mockReset();
                mockStartPlaySession.mockResolvedValueOnce({
                    data: playbackStartFixture('media-1', 'sid'),
                    error: null,
                    status: 200,
                });
                mockFetch.mockResolvedValueOnce({
                    ok: true,
                    body: {
                        getReader: () => ({ read: () => new Promise(() => {}) }),
                    },
                } as unknown as Response);

                const reporter = new PlaySessionReporter({
                    mediaId: 'm',
                    deviceId: 'd',
                });
                reporter.setRequestedMethod(method);

                await reporter.report('start', makeData());

                const body = mockStartPlaySession.mock.calls[0][0] as {
                    requestedMethod: string;
                };
                expect(body.requestedMethod).toBe(method);
            }
        });
    });

    describe('planner authority on ordinary starts', () => {
        it.each([undefined, 'remux', 'full_transcode'])(
            'does not infer requestedMethod from display method %s',
            async (selectedMethod) => {
                mockStartPlaySession.mockResolvedValueOnce({
                    data: playbackStartFixture(),
                    error: null,
                    status: 201,
                });
                const reporter = new PlaySessionReporter({
                    mediaId: 'media',
                    deviceId: 'web',
                    selectedMethod,
                });
                expect(
                    await reporter.report('start', { ...makeData(), playMethod: 'Transcode' }),
                ).toBe(true);
                expect(mockStartPlaySession.mock.calls[0][0]).not.toHaveProperty('requestedMethod');
                reporter.cleanup();
            },
        );
    });

    describe('effective start position', () => {
        it('retains a delivered zero when a heartbeat recreates an established session', async () => {
            mockStartPlaySession.mockResolvedValue({
                data: playbackStartFixture(),
                error: null,
                status: 201,
            });
            const reporter = new PlaySessionReporter({ mediaId: 'media', deviceId: 'web' });
            await reporter.report('start', { ...makeData(), currentTime: 60 });
            mockApiPut.mockResolvedValueOnce({ data: null, error: 'Expired', status: 410 });
            await reporter.report('progress', { ...makeData(), currentTime: 0 });
            expect(mockStartPlaySession.mock.calls.at(-1)?.[0].startPositionMs).toBe(0);
            reporter.cleanup();
        });
        it('lets the server choose an episode entry point for an implicit zero', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture(),
                error: null,
                status: 201,
            });
            const reporter = new PlaySessionReporter({ mediaId: 'media', deviceId: 'web' });
            await reporter.report('start', { ...makeData(), currentTime: 0 });
            expect(mockStartPlaySession.mock.calls[0][0].startPositionMs).toBeUndefined();
            reporter.cleanup();
        });
        it('sends an explicit zero after clamping and does not reuse it on a later restart', async () => {
            mockStartPlaySession.mockResolvedValue({
                data: playbackStartFixture(),
                error: null,
                status: 201,
            });
            const reporter = new PlaySessionReporter({ mediaId: 'media', deviceId: 'web' });
            reporter.setStartPosition(0);
            await reporter.report('start', { ...makeData(), currentTime: 90 });
            expect(mockStartPlaySession.mock.calls[0][0].startPositionMs).toBe(0);
            reporter.setSessionId(undefined);
            await reporter.report('start', { ...makeData(), currentTime: 50 });
            expect(mockStartPlaySession.mock.calls[1][0].startPositionMs).toBe(50_000);
            reporter.cleanup();
        });
    });

    describe('setItemIdentity', () => {
        it('repoints media_id on the next startSession call', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'sess-1'),
                error: null,
                status: 200,
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);

            const reporter = new PlaySessionReporter({
                mediaId: 'old-media-uuid',
                deviceId: 'dev-1',
            });

            reporter.setItemIdentity({ mediaId: 'new-media-uuid' });

            await reporter.report('start', makeData());

            expect(mockStartPlaySession).toHaveBeenCalledWith(
                expect.objectContaining({ mediaId: 'new-media-uuid' }),
            );
        });

        it('overrides jellyfin_media_source_id ahead of the data.mediaSourceId fallback', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'sess-1'),
                error: null,
                status: 200,
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);

            const reporter = new PlaySessionReporter({
                mediaId: 'media-uuid',
                deviceId: 'dev-1',
            });

            reporter.setItemIdentity({
                mediaId: 'media-uuid',
                jellyfinMediaSourceId: 'jf-source-2',
            });

            // makeData().mediaSourceId is 'src-1' — without setItemIdentity that
            // value would flow through as the fallback (see startSession()'s
            // `this.config.jellyfinMediaSourceId ?? data.mediaSourceId`).
            await reporter.report('start', makeData());

            expect(mockStartPlaySession).toHaveBeenCalledWith(
                expect.objectContaining({ mediaId: 'media-uuid', deviceId: 'dev-1' }),
            );
        });

        it('does not affect the media_id of an already-started session', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'sess-1'),
                error: null,
                status: 200,
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);

            const reporter = new PlaySessionReporter({
                mediaId: 'episode-1',
                deviceId: 'dev-1',
            });
            await reporter.report('start', makeData());
            expect(mockStartPlaySession).toHaveBeenCalledWith(
                expect.objectContaining({ mediaId: 'episode-1' }),
            );

            // Ordering contract from setItemIdentity's own doc comment: callers
            // must end the current session before switching identity. Simulate
            // that here — a stop that clears sessionId (204/COMPLETED) — then
            // repoint and start a fresh session for the new item.
            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });
            await reporter.report('stop', makeData());
            expect(reporter.getSessionId()).toBeNull();

            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'sess-2'),
                error: null,
                status: 200,
            });
            reporter.setItemIdentity({ mediaId: 'episode-2' });
            await reporter.report('start', makeData());

            expect(mockStartPlaySession).toHaveBeenLastCalledWith(
                expect.objectContaining({ mediaId: 'episode-2' }),
            );
        });
    });

    describe('admin SSE events', () => {
        function makeSSEStream(dataLine: string): Response {
            const encoder = new TextEncoder();
            const chunk = encoder.encode(`data: ${dataLine}\n\n`);
            let consumed = false;
            return {
                ok: true,
                body: {
                    getReader: () => ({
                        read: () => {
                            if (!consumed) {
                                consumed = true;
                                return Promise.resolve({
                                    done: false,
                                    value: chunk,
                                });
                            }
                            return new Promise(() => {});
                        },
                    }),
                },
            } as unknown as Response;
        }

        beforeEach(() => {
            mockHandleAdminEvent.mockReset();
        });

        it('dispatches admin_message events to handleAdminEvent', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'sess-admin'),
                error: null,
                status: 200,
            });
            const payload = {
                type: 'admin_message',
                severity: 'warning',
                message: 'Test warning',
                sentBy: 'admin',
                sentAt: Date.now(),
            };
            mockFetch.mockResolvedValueOnce(makeSSEStream(JSON.stringify(payload)));

            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            await reporter.report('start', makeData());

            // Wait for the async SSE reader to process the chunk
            await new Promise((r) => setTimeout(r, 50));
            // Second argument is the targeting context: this reader IS the
            // session channel, so it can tell a message addressed to THIS play
            // session from one addressed to another of the same user's clients.
            expect(mockHandleAdminEvent).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'admin_message' }),
                expect.objectContaining({ deviceId: 'd' }),
            );
        });

        it('dispatches maintenance_notice events to handleAdminEvent', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'sess-maint'),
                error: null,
                status: 200,
            });
            const payload = {
                type: 'maintenance_notice',
                id: 'notice-1',
                message: 'Scheduled maintenance',
                endsAt: Date.now() + 60_000,
                createdBy: 'admin',
                createdAt: Date.now(),
            };
            mockFetch.mockResolvedValueOnce(makeSSEStream(JSON.stringify(payload)));

            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            await reporter.report('start', makeData());

            await new Promise((r) => setTimeout(r, 50));
            // Second argument is the targeting context: this reader IS the
            // session channel, so it can tell a message addressed to THIS play
            // session from one addressed to another of the same user's clients.
            expect(mockHandleAdminEvent).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'maintenance_notice' }),
                expect.objectContaining({ deviceId: 'd' }),
            );
        });

        it('dispatches maintenance_cleared events to handleAdminEvent', async () => {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'sess-cleared'),
                error: null,
                status: 200,
            });
            const payload = { type: 'maintenance_cleared' };
            mockFetch.mockResolvedValueOnce(makeSSEStream(JSON.stringify(payload)));

            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            await reporter.report('start', makeData());

            await new Promise((r) => setTimeout(r, 50));
            // Second argument is the targeting context: this reader IS the
            // session channel, so it can tell a message addressed to THIS play
            // session from one addressed to another of the same user's clients.
            expect(mockHandleAdminEvent).toHaveBeenCalledWith(
                expect.objectContaining({ type: 'maintenance_cleared' }),
                expect.objectContaining({ deviceId: 'd' }),
            );
        });
    });

    describe('post-resume heartbeat', () => {
        it('sends the resumed position in position_ms when currentTime reflects the seek destination', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            const RESUME_POSITION_S = 600; // 10 minutes
            await reporter.report('progress', {
                ...makeData(),
                currentTime: RESUME_POSITION_S,
            });

            const body = mockApiPut.mock.calls[0][2] as { positionMs: number; status: string };
            expect(body.positionMs).toBe(RESUME_POSITION_S * 1000);
            expect(body.status).toBe('ACTIVE');
        });
    });

    describe('cleanup', () => {
        it('closes SSE reader without throwing', () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            expect(() => reporter.cleanup()).not.toThrow();
        });
    });

    describe('eventSeq', () => {
        it('increments event_seq on each progress report', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValue({ data: null, error: null, status: 204 });

            await reporter.report('progress', makeData());
            await reporter.report('progress', makeData());

            const body1 = mockApiPut.mock.calls[0][2] as { eventSeq: number };
            const body2 = mockApiPut.mock.calls[1][2] as { eventSeq: number };
            expect(body1.eventSeq).toBe(1);
            expect(body2.eventSeq).toBe(2);
        });

        it('sends COMPLETED with end_reason on stop', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';

            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

            await reporter.report('stop', {
                ...makeData(),
                endReason: 'completion',
            });

            const body = mockApiPut.mock.calls[0][2] as {
                status: string;
                endReason: string;
                eventSeq: number;
            };
            expect(body.status).toBe('COMPLETED');
            expect(body.endReason).toBe('completion');
            expect(body.eventSeq).toBe(1);
        });

        it('resets eventSeq when setSessionId is called (quality restart path)', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';
            (reporter as unknown as { eventSeq: number }).eventSeq = 7;

            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('m', 'server-id'),
                error: null,
                status: 201,
            });
            reporter.setSessionId('new-pre-generated-id');

            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });
            await reporter.report('progress', makeData());

            expect(mockApiPut.mock.calls[0][2]).toMatchObject({ status: 'COMPLETED', eventSeq: 8 });
            const body = mockApiPut.mock.calls[1][2] as { eventSeq: number };
            expect(body.eventSeq).toBe(1);
        });

        it('does not advance event_seq when report() is called before setSessionId()', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });

            // No sessionId set yet — report() must return false WITHOUT
            // advancing the seq counter (otherwise the server sees a gap).
            const r1 = await reporter.report('progress', makeData());
            expect(r1).toBe(false);

            // Now set the session and report again — first event must be seq=1.
            (reporter as unknown as { sessionId: string }).sessionId = 's1';
            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });
            await reporter.report('progress', makeData());

            const body = mockApiPut.mock.calls[0][2] as { eventSeq: number };
            expect(body.eventSeq).toBe(1);
        });

        it('resets eventSeq on a new session start', async () => {
            const reporter = new PlaySessionReporter({
                mediaId: 'm',
                deviceId: 'd',
            });
            (reporter as unknown as { sessionId: string }).sessionId = 'sess-1';
            (reporter as unknown as { eventSeq: number }).eventSeq = 5;

            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'new-sess'),
                error: null,
                status: 200,
            });
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);

            reporter.setSessionId(undefined);
            await reporter.report('start', makeData());

            // After start, sessionId is 'new-sess' and eventSeq reset to 0.
            // First progress should produce event_seq = 1.
            mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });
            await reporter.report('progress', makeData());

            expect(mockApiPut.mock.calls[0]).toEqual([
                '/api/play-sessions/sess-1',
                expect.anything(),
                expect.objectContaining({ status: 'COMPLETED', eventSeq: 6 }),
            ]);
            expect(mockApiPut.mock.calls[1]).toEqual([
                '/api/play-sessions/new-sess',
                expect.anything(),
                expect.objectContaining({ status: 'ACTIVE', eventSeq: 1 }),
            ]);
        });
    });

    // ───────────────────────────────────────────────────────────────────────
    // Supersede latch — once superseded the reporter must NOT recreate
    // a session via any subsequent event. Regression guard for codex P1.
    // ───────────────────────────────────────────────────────────────────────
    describe('supersede terminal latch', () => {
        async function startThenSupersede(): Promise<{
            reporter: PlaySessionReporter;
            onSupersede: ReturnType<typeof vi.fn>;
        }> {
            mockStartPlaySession.mockResolvedValueOnce({
                data: playbackStartFixture('media-1', 'sess-old'),
                error: null,
                status: 200,
            });
            // SSE keepalive
            mockFetch.mockResolvedValueOnce({
                ok: true,
                body: {
                    getReader: () => ({ read: () => new Promise(() => {}) }),
                },
            } as unknown as Response);

            const onSupersede = vi.fn();
            const reporter = new PlaySessionReporter({
                mediaId: 'media-1',
                deviceId: 'dev-1',
                onSupersede,
            });
            await reporter.report('start', makeData());

            // Simulate a heartbeat that comes back with action: 'superseded'
            mockApiPut.mockResolvedValueOnce({
                data: { action: 'superseded', reason: 'superseded' },
                error: null,
                status: 200,
            });
            await reporter.report('progress', makeData());

            return { reporter, onSupersede };
        }

        it('fires onSupersede on the first supersede signal', async () => {
            const { onSupersede } = await startThenSupersede();
            expect(onSupersede).toHaveBeenCalledTimes(1);
        });

        it('a subsequent progress event does NOT POST a fresh start', async () => {
            // Critical: the displaced tab's pause/keepalive will keep
            // calling report('progress'). Without the latch, the reporter
            // would treat sessionId=null as a cue to restartSessionFromProgress,
            // POST /api/play-sessions, and steal ownership back.
            const { reporter } = await startThenSupersede();
            mockStartPlaySession.mockClear();
            mockFetch.mockClear();
            mockApiPut.mockClear();

            const result = await reporter.report('progress', makeData());

            expect(result).toBe(false);
            expect(mockStartPlaySession).not.toHaveBeenCalled();
            expect(mockApiPut).not.toHaveBeenCalled();
        });

        it('a subsequent stop event is also a no-op', async () => {
            const { reporter } = await startThenSupersede();
            mockStartPlaySession.mockClear();
            mockFetch.mockClear();
            mockApiPut.mockClear();

            const result = await reporter.report('stop', makeData());

            expect(result).toBe(false);
            expect(mockApiPut).not.toHaveBeenCalled();
        });

        it('a subsequent start event is also a no-op', async () => {
            const { reporter } = await startThenSupersede();
            mockStartPlaySession.mockClear();
            mockFetch.mockClear();
            mockApiPut.mockClear();

            const result = await reporter.report('start', makeData());

            expect(result).toBe(false);
            expect(mockStartPlaySession).not.toHaveBeenCalled();
        });
    });
});

function makeData() {
    return {
        itemId: 'item-1',
        mediaSourceId: 'src-1',
        currentTime: 60,
        isPaused: false,
        isMuted: false,
        volume: 1,
        playMethod: 'direct',
        playSessionId: 'play-sess-1',
        audioStreamIndex: null,
        subtitleStreamIndex: null,
    };
}

// ─── hasReportedRealPosition gate tests ───────────────────────────────────────
//
// The gate lives in PlayerController.reportProgress (not in PlaySessionReporter).
// These tests replicate the gate condition in a thin shim so the logic can be
// verified without instantiating the full Svelte 5 controller class.

describe('hasReportedRealPosition gate', () => {
    /**
     * Minimal shim that mirrors the gate in PlayerController.reportProgress:
     *   if (eventType === 'progress' && !hasReportedRealPosition) return;
     */
    class GatedReporter {
        hasReportedRealPosition = false;
        readonly calls: Array<{ eventType: string }> = [];

        async reportProgress(eventType: 'start' | 'progress' | 'stop'): Promise<void> {
            if (eventType === 'progress' && !this.hasReportedRealPosition) {
                return;
            }
            this.calls.push({ eventType });
        }

        openGate(): void {
            this.hasReportedRealPosition = true;
        }

        resetGate(): void {
            this.hasReportedRealPosition = false;
        }
    }

    it('drops progress events while hasReportedRealPosition is false', async () => {
        const r = new GatedReporter();
        await r.reportProgress('progress');
        await r.reportProgress('progress');
        expect(r.calls).toHaveLength(0);
    });

    it('allows start events through while gate is closed', async () => {
        const r = new GatedReporter();
        await r.reportProgress('start');
        expect(r.calls).toHaveLength(1);
        expect(r.calls[0]?.eventType).toBe('start');
    });

    it('allows stop events through while gate is closed', async () => {
        const r = new GatedReporter();
        await r.reportProgress('stop');
        expect(r.calls).toHaveLength(1);
        expect(r.calls[0]?.eventType).toBe('stop');
    });

    it('allows progress events once hasReportedRealPosition is set', async () => {
        const r = new GatedReporter();
        await r.reportProgress('progress'); // dropped
        r.openGate();
        await r.reportProgress('progress'); // flows
        await r.reportProgress('progress'); // flows
        expect(r.calls).toHaveLength(2);
        expect(r.calls.every((c) => c.eventType === 'progress')).toBe(true);
    });

    it('gate is sticky — never re-blocks after being opened', async () => {
        const r = new GatedReporter();
        r.openGate();
        // Simulate backward seek: smaller currentTime should not re-block
        for (let i = 0; i < 5; i++) {
            await r.reportProgress('progress');
        }
        expect(r.calls).toHaveLength(5);
    });

    it('reset restores the closed state for the next session', async () => {
        const r = new GatedReporter();
        r.openGate();
        await r.reportProgress('progress'); // flows (gate open)
        r.resetGate();
        await r.reportProgress('progress'); // dropped (gate reset)
        expect(r.calls).toHaveLength(1);
    });
});

// ============================================================================
// eventSeq must survive a same-id re-registration
// ============================================================================
//
// Prod 2026-07-29: the server logged "Rejected stale lumastra-player progress
// event {incomingSeq: 1, currentSeq: 39}". report() calls
// restartSessionAndResend() whenever update() fails for ANY reason (transient
// 5xx, 404/410 on a reaped session). That re-POSTs `start` under the SAME
// pre-generated session id but reset eventSeq to 0 — and the server keeps
// last_event_seq per session and drops anything not ahead of it. So one blipped
// heartbeat silently wedged progress reporting until the counter climbed back
// past its old value (~38 heartbeats), losing resume-position updates the whole
// time. A genuinely NEW session id must still start from 0.
describe('PlaySessionReporter — eventSeq across re-registration', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        mockStartPlaySession.mockReset();
        mockApiPut.mockReset().mockResolvedValue({ data: null, error: null, status: 204 });
    });

    function seqOf(call: unknown): number {
        return (call as { eventSeq: number }).eventSeq;
    }

    it('keeps counting when the SAME session id is re-registered after a failure', async () => {
        const reporter = new PlaySessionReporter({
            mediaId: 'm',
            deviceId: 'd',
            sessionId: 'same-id',
        });
        (reporter as unknown as { sessionId: string }).sessionId = 'same-id';

        // Two good heartbeats -> seq 1, 2
        mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });
        await reporter.report('progress', makeData());
        mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });
        await reporter.report('progress', makeData());
        expect(seqOf(mockApiPut.mock.calls[1][2])).toBe(2);

        // Third heartbeat fails -> restartSessionAndResend re-registers 'same-id'
        mockApiPut.mockResolvedValueOnce({ data: null, error: { x: 1 }, status: 503 });
        mockStartPlaySession.mockResolvedValueOnce({
            data: playbackStartFixture('media-1', 'same-id'),
            error: null,
            status: 200,
        });
        mockFetch.mockResolvedValue({
            ok: true,
            body: { getReader: () => ({ read: () => new Promise(() => {}) }) },
        });
        mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });

        await reporter.report('progress', makeData());

        // The resent event must be AHEAD of 2, not back at 1 — otherwise the
        // server rejects it (and everything after it) as stale.
        const resent = seqOf(mockApiPut.mock.calls[mockApiPut.mock.calls.length - 1][2]);
        expect(resent).toBeGreaterThan(2);
    });

    it('still restarts the sequence for a genuinely NEW session id', async () => {
        const reporter = new PlaySessionReporter({
            mediaId: 'm',
            deviceId: 'd',
            sessionId: 'old-id',
        });
        (reporter as unknown as { sessionId: string }).sessionId = 'old-id';

        mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });
        await reporter.report('progress', makeData());

        // A quality restart mints a new playSessionId.
        reporter.setSessionId('new-id');
        (reporter as unknown as { sessionId: string }).sessionId = 'new-id';

        mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });
        await reporter.report('progress', makeData());

        expect(seqOf(mockApiPut.mock.calls[1][2])).toBe(1);
    });
});

// A session the server no longer has (reaped, expired, ended) is re-registered
// on the next event; the watch page re-checks the series marker then.
describe('PlaySessionReporter — onSessionRestarted', () => {
    beforeEach(() => {
        mockFetch.mockReset();
        mockStartPlaySession.mockReset();
        mockApiPut.mockReset();
        mockFetch.mockResolvedValue({
            ok: true,
            body: { getReader: () => ({ read: () => new Promise(() => {}) }) },
        });
    });

    function restartedReporter(onSessionRestarted: () => void): PlaySessionReporter {
        const reporter = new PlaySessionReporter({
            mediaId: 'm',
            deviceId: 'd',
            sessionId: 'sid',
            onSessionRestarted,
        });
        (reporter as unknown as { sessionId: string }).sessionId = 'sid';
        mockApiPut.mockResolvedValueOnce({ data: null, error: { x: 1 }, status: 410 });
        mockStartPlaySession.mockResolvedValueOnce({
            data: playbackStartFixture('media-1', 'sid'),
            error: null,
            status: 200,
        });
        mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });
        return reporter;
    }

    it('fires when a failed heartbeat re-registers the session', async () => {
        const onSessionRestarted = vi.fn();
        await restartedReporter(onSessionRestarted).report('progress', makeData());
        expect(onSessionRestarted).toHaveBeenCalledTimes(1);
    });

    it("does not fire for a stop's carrier session", async () => {
        const onSessionRestarted = vi.fn();
        await restartedReporter(onSessionRestarted).report('stop', makeData());
        expect(onSessionRestarted).not.toHaveBeenCalled();
    });

    it('does not fire for a healthy heartbeat', async () => {
        const onSessionRestarted = vi.fn();
        const reporter = new PlaySessionReporter({
            mediaId: 'm',
            deviceId: 'd',
            sessionId: 'sid',
            onSessionRestarted,
        });
        (reporter as unknown as { sessionId: string }).sessionId = 'sid';
        mockApiPut.mockResolvedValueOnce({ data: null, error: null, status: 204 });
        await reporter.report('progress', makeData());
        expect(onSessionRestarted).not.toHaveBeenCalled();
    });
});

describe('PlaySessionReporter — transcode progress polling', () => {
    const moving = {
        progressPercent: 40,
        segmentsReady: 40,
        totalSegments: 100,
        elapsedSeconds: 20,
    };

    beforeEach(() => {
        vi.useFakeTimers();
        mockApiPut.mockReset();
        mockApiGet.mockReset();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    function heartbeatingReporter(onTranscodeProgress: (p: unknown) => void): PlaySessionReporter {
        const reporter = new PlaySessionReporter({
            mediaId: 'm',
            deviceId: 'd',
            sessionId: 'sid',
            onTranscodeProgress,
        });
        (reporter as unknown as { sessionId: string }).sessionId = 'sid';
        return reporter;
    }

    it('polls between heartbeats while the transcode is moving, and stops once it is done', async () => {
        const onTranscodeProgress = vi.fn();
        const reporter = heartbeatingReporter(onTranscodeProgress);
        mockApiPut.mockResolvedValueOnce({
            data: { resumeAnchorAt: null, progressSaved: false, transcode: moving },
            error: null,
            status: 200,
        });
        await reporter.report('progress', makeData());
        expect(onTranscodeProgress).toHaveBeenLastCalledWith(moving);

        const done = { ...moving, progressPercent: 100 };
        mockApiGet.mockResolvedValueOnce({ data: { transcode: done }, error: null, status: 200 });
        await vi.advanceTimersByTimeAsync(4_000);
        expect(mockApiGet).toHaveBeenCalledWith(
            '/api/play-sessions/sid/transcode-progress',
            expect.anything(),
        );
        expect(onTranscodeProgress).toHaveBeenLastCalledWith(done);

        await vi.advanceTimersByTimeAsync(20_000);
        expect(mockApiGet).toHaveBeenCalledTimes(1);
        reporter.cleanup();
    });

    it('keeps polling a finished transcode the throttle has paused', async () => {
        const reporter = heartbeatingReporter(vi.fn());
        const paused = { ...moving, progressPercent: 100, throttled: true };
        mockApiPut.mockResolvedValueOnce({
            data: { resumeAnchorAt: null, progressSaved: false, transcode: paused },
            error: null,
            status: 200,
        });
        await reporter.report('progress', makeData());
        mockApiGet.mockResolvedValue({ data: { transcode: paused }, error: null, status: 200 });
        await vi.advanceTimersByTimeAsync(8_000);
        expect(mockApiGet).toHaveBeenCalledTimes(2);
        reporter.cleanup();
        await vi.advanceTimersByTimeAsync(8_000);
        expect(mockApiGet).toHaveBeenCalledTimes(2);
    });

    it('clears the readout when a heartbeat no longer carries a transcode', async () => {
        const onTranscodeProgress = vi.fn();
        const reporter = heartbeatingReporter(onTranscodeProgress);
        mockApiPut.mockResolvedValueOnce({
            data: { resumeAnchorAt: null, progressSaved: false },
            error: null,
            status: 200,
        });
        await reporter.report('progress', makeData());
        expect(onTranscodeProgress).toHaveBeenLastCalledWith(null);
        await vi.advanceTimersByTimeAsync(10_000);
        expect(mockApiGet).not.toHaveBeenCalled();
    });

    it('stops on 401/403 and backs off on other failures', async () => {
        const reporter = heartbeatingReporter(vi.fn());
        mockApiPut.mockResolvedValue({
            data: { resumeAnchorAt: null, progressSaved: false, transcode: moving },
            error: null,
            status: 200,
        });
        await reporter.report('progress', makeData());
        mockApiGet.mockResolvedValue({ data: null, error: 'boom', status: 503 });
        await vi.advanceTimersByTimeAsync(4_000); // 1st poll fails
        await vi.advanceTimersByTimeAsync(4_000); // backed off to 8 s — not yet
        expect(mockApiGet).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(mockApiGet).toHaveBeenCalledTimes(2);

        mockApiGet.mockResolvedValue({ data: null, error: 'Unauthorized', status: 401 });
        await vi.advanceTimersByTimeAsync(16_000);
        expect(mockApiGet).toHaveBeenCalledTimes(3);
        await vi.advanceTimersByTimeAsync(60_000);
        expect(mockApiGet).toHaveBeenCalledTimes(3);
    });

    it('skips requests while the tab is hidden but resumes right after', async () => {
        const reporter = heartbeatingReporter(vi.fn());
        mockApiPut.mockResolvedValueOnce({
            data: { resumeAnchorAt: null, progressSaved: false, transcode: moving },
            error: null,
            status: 200,
        });
        await reporter.report('progress', makeData());
        const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
        mockApiGet.mockResolvedValue({ data: { transcode: moving }, error: null, status: 200 });
        await vi.advanceTimersByTimeAsync(12_000);
        expect(mockApiGet).not.toHaveBeenCalled();
        hidden.mockReturnValue(false);
        await vi.advanceTimersByTimeAsync(4_000);
        expect(mockApiGet).toHaveBeenCalledTimes(1);
        hidden.mockRestore();
        reporter.cleanup();
    });

    it('drops a poll response that a newer heartbeat reading overtook', async () => {
        const onTranscodeProgress = vi.fn();
        const reporter = heartbeatingReporter(onTranscodeProgress);
        mockApiPut.mockResolvedValueOnce({
            data: { resumeAnchorAt: null, progressSaved: false, transcode: moving },
            error: null,
            status: 200,
        });
        await reporter.report('progress', makeData());

        let answer!: (v: unknown) => void;
        mockApiGet.mockReturnValueOnce(new Promise((r) => (answer = r)));
        await vi.advanceTimersByTimeAsync(4_000); // poll in flight

        const newer = { ...moving, progressPercent: 55 };
        mockApiPut.mockResolvedValueOnce({
            data: { resumeAnchorAt: null, progressSaved: false, transcode: newer },
            error: null,
            status: 200,
        });
        await reporter.report('progress', makeData());
        answer({
            data: { transcode: { ...moving, progressPercent: 41 } },
            error: null,
            status: 200,
        });
        await vi.advanceTimersByTimeAsync(0);

        expect(onTranscodeProgress).toHaveBeenLastCalledWith(newer);
        reporter.cleanup();
    });

    it('stops polling when the session is gone (404)', async () => {
        const reporter = heartbeatingReporter(vi.fn());
        mockApiPut.mockResolvedValueOnce({
            data: { resumeAnchorAt: null, progressSaved: false, transcode: moving },
            error: null,
            status: 200,
        });
        await reporter.report('progress', makeData());
        mockApiGet.mockResolvedValue({ data: null, error: 'Not found', status: 404 });
        await vi.advanceTimersByTimeAsync(20_000);
        expect(mockApiGet).toHaveBeenCalledTimes(1);
    });
});

describe('pending session context ownership R02', () => {
    it.each(['file', 'media', 'session'])(
        'retires an old pending %s start before starting a new context and never adopts its resources',
        async (kind) => {
            mockStartPlaySession.mockReset();
            mockApiPut.mockReset();
            mockApiPut.mockResolvedValue({ data: null, error: null, status: 204 });
            let release!: (value: unknown) => void;
            mockStartPlaySession.mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        release = resolve;
                    }),
            );
            const oldStart = playbackStartFixture(
                '11111111-1111-4111-8111-111111111111',
                '22222222-2222-4222-8222-222222222222',
            );
            const newStart = playbackStartFixture(
                '33333333-3333-4333-8333-333333333333',
                '44444444-4444-4444-8444-444444444444',
            );
            mockStartPlaySession.mockResolvedValueOnce({
                data: newStart,
                status: 201,
                error: null,
            });
            const onDelivery = vi.fn();
            const reporter = new PlaySessionReporter({
                mediaId: oldStart.mediaId,
                fileId: 'old-file',
                deviceId: 'web',
                onDelivery,
            });
            const old = reporter.report('progress', makeData());
            const same = reporter.report('start', makeData());
            expect(mockStartPlaySession).toHaveBeenCalledTimes(1);
            if (kind === 'file') reporter.setLumastraContext({ fileId: 'new-file' });
            else if (kind === 'media') reporter.setItemIdentity({ mediaId: newStart.mediaId });
            else reporter.setSessionId('new-session');
            const current = reporter.report('start', { ...makeData(), audioStreamIndex: 4 });
            expect(mockStartPlaySession).toHaveBeenCalledTimes(1);
            release({ data: oldStart, status: 201, error: null });
            expect(await old).toBe(false);
            expect(await same).toBe(false);
            expect(await current).toBe(true);
            expect(mockApiPut).toHaveBeenCalledWith(
                `/api/play-sessions/${oldStart.playbackSessionId}`,
                expect.anything(),
                expect.objectContaining({ status: 'COMPLETED', endReason: 'switch' }),
            );
            expect(mockStartPlaySession).toHaveBeenCalledTimes(2);
            expect(mockStartPlaySession.mock.calls[1][0].audioStreamIndex).toBe(4);
            expect(onDelivery).toHaveBeenCalledExactlyOnceWith(newStart);
            expect(reporter.getStartResult()).toBe(newStart);
            reporter.cleanup();
        },
    );
});

it('retires a pending created session after cleanup without reviving delivery, grants or SSE', async () => {
    mockStartPlaySession.mockReset();
    mockApiPut.mockReset();
    mockFetch.mockReset();
    mockApiPut.mockResolvedValue({ data: null, error: null, status: 204 });
    let release!: (value: unknown) => void;
    mockStartPlaySession.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    const onDelivery = vi.fn();
    const reporter = new PlaySessionReporter({
        mediaId: '11111111-1111-4111-8111-111111111111',
        deviceId: 'web',
        onDelivery,
    });
    const pending = reporter.report('start', makeData());
    reporter.cleanup();
    const response = playbackStartFixture(
        '11111111-1111-4111-8111-111111111111',
        '22222222-2222-4222-8222-222222222222',
    );
    release({ data: response, status: 201, error: null });
    expect(await pending).toBe(false);
    expect(reporter.getSessionId()).toBeNull();
    expect(reporter.getStartResult()).toBeNull();
    expect(onDelivery).not.toHaveBeenCalled();
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockApiPut).toHaveBeenCalledExactlyOnceWith(
        `/api/play-sessions/${response.playbackSessionId}`,
        expect.anything(),
        expect.objectContaining({ status: 'COMPLETED' }),
    );
});

it('retires active context ownership before replacing it and ignores the old SSE reader', async () => {
    mockStartPlaySession.mockReset();
    mockApiPut.mockReset();
    mockFetch.mockReset();
    const first = playbackStartFixture('media-1', 'old-session');
    const next = playbackStartFixture('media-1', 'new-session');
    mockStartPlaySession
        .mockResolvedValueOnce({ data: first, status: 201, error: null })
        .mockResolvedValueOnce({ data: next, status: 201, error: null });
    mockApiPut.mockResolvedValue({ data: null, error: null, status: 204 });
    let deliverOld!: (value: { done: boolean; value: Uint8Array }) => void;
    mockFetch
        .mockResolvedValueOnce({
            ok: true,
            body: {
                getReader: () => ({
                    read: () =>
                        new Promise((resolve) => {
                            deliverOld = resolve;
                        }),
                }),
            },
        })
        .mockResolvedValue({ ok: false });
    const onSupersede = vi.fn();
    const reporter = new PlaySessionReporter({
        mediaId: 'media-1',
        deviceId: 'web',
        fileId: 'file-a',
        onSupersede,
    });
    await reporter.report('start', makeData());
    await vi.waitFor(() => expect(deliverOld).toBeTypeOf('function'));
    const oldSignal = mockFetch.mock.calls[0][1].signal as AbortSignal;
    reporter.setLumastraContext({ fileId: 'file-b' });
    expect(oldSignal.aborted).toBe(true);
    await reporter.report('start', makeData());
    expect(mockApiPut).toHaveBeenCalledWith(
        '/api/play-sessions/old-session',
        expect.anything(),
        expect.objectContaining({ status: 'COMPLETED' }),
    );
    expect(mockApiPut.mock.invocationCallOrder[0]).toBeLessThan(
        mockStartPlaySession.mock.invocationCallOrder[1],
    );
    deliverOld({
        done: false,
        value: new TextEncoder().encode(
            'data: {"type":"session_terminated","reason":"superseded"}\n\n',
        ),
    });
    await Promise.resolve();
    expect(onSupersede).not.toHaveBeenCalled();
    expect(reporter.getSessionId()).toBe('new-session');
    expect(await reporter.report('progress', makeData())).toBe(true);
    reporter.cleanup();
});

it('retains a failed stale-created retirement and bounds retries before allowing a new start', async () => {
    mockStartPlaySession.mockReset();
    mockApiPut.mockReset();
    mockFetch.mockReset().mockResolvedValue({ ok: false });
    let release!: (value: unknown) => void;
    mockStartPlaySession.mockImplementationOnce(
        () =>
            new Promise((resolve) => {
                release = resolve;
            }),
    );
    const reporter = new PlaySessionReporter({
        mediaId: 'media-1',
        deviceId: 'web',
        fileId: 'old-file',
    });
    const pending = reporter.report('start', makeData());
    reporter.setLumastraContext({ fileId: 'new-file' });
    mockApiPut.mockResolvedValue({ data: null, error: 'Unavailable', status: 503 });
    release({ data: playbackStartFixture('media-1', 'stale-created'), status: 201, error: null });
    expect(await pending).toBe(false);
    expect(mockApiPut).toHaveBeenCalledTimes(3);
    expect(mockStartPlaySession).toHaveBeenCalledTimes(1);
    mockApiPut.mockResolvedValue({ data: null, error: null, status: 204 });
    mockStartPlaySession.mockResolvedValueOnce({
        data: playbackStartFixture('media-1', 'fresh'),
        status: 201,
        error: null,
    });
    expect(await reporter.report('start', makeData())).toBe(true);
    expect(mockApiPut.mock.calls[3][0]).toBe('/api/play-sessions/stale-created');
    expect(mockApiPut.mock.invocationCallOrder[3]).toBeLessThan(
        mockStartPlaySession.mock.invocationCallOrder[1],
    );
    reporter.cleanup();
});
