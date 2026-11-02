// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetSql = vi.fn();
const mockGetSessionById = vi.fn();
const mockGetProgress = vi.fn();

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: () => mockGetSql() },
}));
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getSessionById: (...a: unknown[]) => mockGetSessionById(...a),
}));
vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: () => ({
        getPlayerTranscodeProgressMultiPod: (...a: unknown[]) => mockGetProgress(...a),
    }),
}));

import { def } from './transcode-progress.js';
import { TranscodeProgressResponseSchema } from '$lib/schemas/api-playback-responses.js';

const SESSION_ID = '00000000-0000-4000-a000-0000000000a1';

function invoke(userId: string | undefined) {
    const event = { locals: { user: userId ? { userId } : undefined } } as never;
    return def.handlers.GET!(event, { input: { params: { id: SESSION_ID } } } as never);
}

function session(overrides: Record<string, unknown> = {}) {
    return {
        id: SESSION_ID,
        user_id: 'uid-alice',
        status: 'ACTIVE',
        play_method: 'full_transcode',
        transcode_job_id: 'job-1',
        ...overrides,
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetSql.mockResolvedValue({});
});

describe('GET /play-sessions/{id}/transcode-progress', () => {
    it("returns the owner's transcode progress in the response schema's shape", async () => {
        mockGetSessionById.mockResolvedValue(session());
        mockGetProgress.mockResolvedValue({
            progressPercent: 40,
            segmentsReady: 40,
            totalSegments: 100,
            elapsedSeconds: 12,
            throttled: true,
            bufferAheadSeconds: 130,
        });

        const res = await invoke('uid-alice');

        expect(res.status).toBe(200);
        expect(res.headers.get('Cache-Control')).toBe('no-store');
        const body = TranscodeProgressResponseSchema.parse(await res.json());
        expect(body.transcode).toMatchObject({ throttled: true, bufferAheadSeconds: 130 });
        expect(mockGetProgress).toHaveBeenCalledWith(SESSION_ID);
    });

    it('answers 404, not the progress, for a session owned by someone else', async () => {
        mockGetSessionById.mockResolvedValue(session({ user_id: 'uid-bob' }));
        const res = await invoke('uid-alice');
        expect(res.status).toBe(404);
        expect(mockGetProgress).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown session and 401 without a user', async () => {
        mockGetSessionById.mockResolvedValue(null);
        expect((await invoke('uid-alice')).status).toBe(404);
        expect((await invoke(undefined)).status).toBe(401);
    });

    it('reports null for direct play without asking the transcode service', async () => {
        mockGetSessionById.mockResolvedValue(
            session({ play_method: 'direct', transcode_job_id: null }),
        );
        const res = await invoke('uid-alice');
        expect(await res.json()).toEqual({ transcode: null });
        expect(mockGetProgress).not.toHaveBeenCalled();
    });

    it.each(['CRASHED', 'COMPLETED', 'KILLED'])(
        'answers 404 for a %s session without reading progress',
        async (status) => {
            mockGetSessionById.mockResolvedValue(session({ status }));
            expect((await invoke('uid-alice')).status).toBe(404);
            expect(mockGetProgress).not.toHaveBeenCalled();
        },
    );

    it('reports null once the transcode is gone', async () => {
        mockGetSessionById.mockResolvedValue(session());
        mockGetProgress.mockResolvedValue(undefined);
        expect(await (await invoke('uid-alice')).json()).toEqual({ transcode: null });
    });
});
