// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    update: vi.fn(),
    kill: vi.fn(),
    owner: 'listener',
    mediaType: 'audiobook',
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => ({}) },
}));
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getSessionById: async () => ({
        user_id: mocks.owner,
        media_type: mocks.mediaType,
        play_method: 'direct',
    }),
}));
vi.mock('$lib/server/services/play-session-lifecycle.service.js', () => ({
    getPlaySessionLifecycleService: () => ({ update: mocks.update }),
}));
vi.mock('$lib/server/services/ffmpeg-transcode.service.js', () => ({
    getFFmpegTranscodeService: vi.fn(),
}));
vi.mock('$lib/server/services/adaptive-playback-state.service.js', () => ({
    clearClientAdaptiveReport: vi.fn(async () => undefined),
    recordClientAdaptiveReport: vi.fn(),
}));
vi.mock('$lib/server/services/session-kill.service.js', () => ({ killSessionUnified: mocks.kill }));
vi.mock('$lib/server/utils/audit-log.js', () => ({
    auditLog: vi.fn(),
    auditActor: () => ({ username: 'listener' }),
}));
import { mount } from '$lib/server/api/mount.js';
import { PlaybackReportSchema } from '$lib/schemas/session-update.js';
import { def as put } from './[id].js';
import { def as beacon } from './[id]/beacon.js';
beforeEach(() => {
    vi.clearAllMocks();
    mocks.owner = 'listener';
    mocks.mediaType = 'audiobook';
});
describe.each(['PUT', 'beacon'])('%s audiobook outcomes', (transport) => {
    it.each([
        { sessionLost: true },
        { action: 'superseded', reason: 'superseded', sessionLost: true },
    ])('preserves the outcome without converting loss to kill: %j', async (outcome) => {
        mocks.update.mockResolvedValue({
            resume_anchor: null,
            wrote_to_durable: false,
            ...outcome,
        });
        const event = { locals: { user: { userId: 'listener' } } } as never;
        const ctx = {
            input: { params: { id: 'session' }, body: { status: 'COMPLETED' } },
        } as never;
        const response =
            transport === 'PUT'
                ? await put.handlers.PUT!(event, ctx)
                : await beacon.handlers.POST!(event, ctx);
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toMatchObject(outcome);
        expect(body.action).not.toBe('kill');
    });
});

describe.each(['PUT', 'beacon'])('%s applicability and ownership', (transport) => {
    const invoke = async (fields: Record<string, unknown>) => {
        const event = { locals: { user: { userId: 'listener' } } } as never;
        const ctx = {
            input: {
                params: { id: 'session' },
                body: PlaybackReportSchema.parse({
                    status: 'COMPLETED',
                    positionMs: 0,
                    eventSeq: 1,
                    sessionElapsedMs: 0,
                    ...fields,
                }),
            },
        } as never;
        return transport === 'PUT'
            ? put.handlers.PUT!(event, ctx)
            : beacon.handlers.POST!(event, ctx);
    };
    it.each([
        { finished: true },
        { listenedTotalMs: 1 },
        { crossfade: null },
        { nextMediaId: '00000000-0000-4000-8000-000000000001' },
    ])('video ignores inapplicable audio fields %j without losing the report', async (fields) => {
        mocks.mediaType = 'movie';
        mocks.update.mockResolvedValue({ resume_anchor: null, wrote_to_durable: false });
        expect((await invoke(fields)).status).toBe(204);
        expect(mocks.update).toHaveBeenCalledWith(
            'session',
            expect.objectContaining({
                finished: undefined,
                listened_ms: undefined,
                crossfade: undefined,
                next_media_id: undefined,
            }),
            expect.anything(),
        );
    });
    it('accepts a tvOS-like video heartbeat with forward-compatible fields', async () => {
        mocks.mediaType = 'movie';
        mocks.update.mockResolvedValue({ resume_anchor: 30000, wrote_to_durable: true });
        const response = await invoke({
            status: 'ACTIVE',
            positionMs: 30000,
            sessionElapsedMs: 25000,
            listenedTotalMs: 25000,
            playMethod: 'direct',
            bitrateBps: 8000000,
            bufferHealthMs: 5000,
            clientVersion: 'tvOS-next',
        });
        expect(response.status).toBe(transport === 'PUT' ? 200 : 204);
        expect(mocks.update).toHaveBeenCalledWith(
            'session',
            expect.objectContaining({
                position_ms: 30000,
                session_elapsed_ms: 25000,
                bitrate_kbps: 8000,
                listened_ms: undefined,
            }),
            expect.anything(),
        );
    });
    it('returns the same structured stream-limit refusal on promotion for either transport', async () => {
        mocks.mediaType = 'track';
        mocks.update.mockResolvedValue({
            policyError: { kind: 'stream_limit_exceeded', active: 1, limit: 1 },
            resume_anchor: null,
            wrote_to_durable: false,
        });
        const response = await invoke({ status: 'ACTIVE' });
        expect(response.status).toBe(422);
        expect(await response.json()).toMatchObject({
            code: 'stream_limit',
            details: { active: 1, limit: 1 },
        });
    });

    it('still rejects invalid known report fields', () => {
        expect(() =>
            PlaybackReportSchema.parse({
                positionMs: -1,
                status: 'ACTIVE',
                eventSeq: 1,
                sessionElapsedMs: 0,
            }),
        ).toThrow();
    });
    it('foreign session returns 404 before lifecycle changes', async () => {
        mocks.owner = 'someone-else';
        expect((await invoke({})).status).toBe(404);
        expect(mocks.update).not.toHaveBeenCalled();
    });
});

describe('merged session resource request validation', () => {
    const id = '00000000-0000-4000-8000-000000000001';
    const body = { positionMs: 30000, status: 'ACTIVE', eventSeq: 1, sessionElapsedMs: 25000 };
    function event(method: string, payload?: unknown) {
        const url = new URL(`http://localhost/api/v1/play-sessions/${id}`);
        return {
            url,
            params: { id },
            route: { id: '/api/v1/play-sessions/[id]' },
            locals: {
                user: { userId: 'listener', username: 'listener' },
                principal: {
                    kind: 'session',
                    username: 'listener',
                    scopes: ['media:write'],
                    isAdmin: false,
                },
            },
            request: new Request(url, {
                method,
                ...(payload === undefined
                    ? {}
                    : {
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                      }),
            }),
        } as Parameters<NonNullable<ReturnType<typeof mount>['PUT']>>[0];
    }
    it('mounts DELETE without validating a report body', async () => {
        mocks.kill.mockResolvedValue({ killed: true });
        const response = await mount(put, { surface: 'v1' }).DELETE!(event('DELETE'));
        expect(response.status).toBe(204);
        expect(mocks.kill).toHaveBeenCalledWith(expect.anything(), id, 'listener');
        expect(mocks.update).not.toHaveBeenCalled();
    });
    it('keeps required and known PUT report fields validated before lifecycle work', async () => {
        for (const payload of [{}, { ...body, positionMs: -1 }, { ...body, listenedTotalMs: -1 }]) {
            const response = await mount(put, { surface: 'v1' }).PUT!(event('PUT', payload));
            expect(response.status).toBe(422);
        }
        expect(mocks.update).not.toHaveBeenCalled();
    });
    it.each(['PUT', 'beacon'])(
        'mount accepts a tvOS-like %s report and strips future fields',
        async (transport) => {
            mocks.mediaType = 'movie';
            mocks.update.mockResolvedValue({ resume_anchor: 30000, wrote_to_durable: true });
            const handler =
                transport === 'PUT'
                    ? mount(put, { surface: 'v1' }).PUT!
                    : mount(beacon, { surface: 'v1' }).POST!;
            const response = await handler(
                event(transport === 'PUT' ? 'PUT' : 'POST', {
                    ...body,
                    listenedTotalMs: 25000,
                    clientVersion: 'tvOS-next',
                }),
            );
            expect(response.status).toBe(transport === 'PUT' ? 200 : 204);
            expect(mocks.update).toHaveBeenCalledWith(
                id,
                expect.objectContaining({ position_ms: 30000, listened_ms: undefined }),
                expect.anything(),
            );
            expect(mocks.update.mock.calls[0][1]).not.toHaveProperty('clientVersion');
        },
    );
});
