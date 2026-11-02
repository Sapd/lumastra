// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An unauthenticated caller must not be able to tell a live audiobook playback
 * session (401) from a missing/ended/foreign one (404), and the session's media
 * id compares case-insensitively like the grant path does.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

type Row = Record<string, unknown> | null;
let row: Row = null;
const mockAuth = vi.fn(
    async (): Promise<
        | { ok: true; userId: string; absApiKey: string; absItemId: string }
        | { ok: false; status: number; reason: string }
    > => ({ ok: false, status: 401, reason: 'missing_token' }),
);
vi.mock('./audiobook-stream-auth.js', () => ({
    authenticateAudiobookStream: () => mockAuth(),
    extractStreamToken: () => null,
}));
vi.mock('../database/queries/play-sessions.queries.js', () => ({
    getSessionById: async () => row,
}));
vi.mock('../database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('../config.js', () => ({ config: { AUDIOURL: 'http://abs.example/' } }));
vi.mock('../utils/logger.js', () => ({
    Logger: { for: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));
vi.mock('./audiobook-byte-proxy.service.js', () => ({
    absFilePath: () => '/x',
    absHlsPath: () => '/x',
    AudiobookProxyError: class extends Error {},
    proxyAudiobookBytes: vi.fn(async () => new Response('audio', { status: 200 })),
}));

const { handleAudiobookFile } = await import('./audiobook-stream-routes.js');

const MEDIA = 'ABCDEF01-1111-4111-8111-111111111111';
function makeEvent(mediaId: string): RequestEvent {
    const url = new URL(
        `http://lumastra.test/api/v1/audiobooks/${mediaId}/files/1?PlaySessionId=11111111-1111-4111-8111-111111111111`,
    );
    return {
        params: { mediaId, trackIndex: '1' },
        url,
        request: new Request(url),
        getClientAddress: () => '203.0.113.7',
        locals: {},
    } as unknown as RequestEvent;
}
const liveRow = (): Row => ({
    user_id: 'owner',
    media_id: MEDIA,
    source: 'audiobookshelf',
    source_session_id: 'abs-1',
    status: 'ACTIVE',
    device_capabilities: { audiobookTracks: [{ index: 1, ino: 'ino1' }] },
});

beforeEach(() => {
    vi.clearAllMocks();
    row = null;
    mockAuth.mockImplementation(async () => ({ ok: false, status: 401, reason: 'missing_token' }));
});

describe('audiobook file route — session existence oracle', () => {
    it('answers an unauthenticated caller 401 for a live session', async () => {
        row = liveRow();
        expect((await handleAudiobookFile(makeEvent(MEDIA))).status).toBe(401);
    });
    it('answers an unauthenticated caller 401 for a missing session too', async () => {
        row = null;
        expect((await handleAudiobookFile(makeEvent(MEDIA))).status).toBe(401);
    });
    it('answers an unauthenticated caller 401 for an ended or foreign-media session', async () => {
        row = { ...liveRow(), status: 'ENDED' };
        expect((await handleAudiobookFile(makeEvent(MEDIA))).status).toBe(401);
        row = { ...liveRow(), media_id: '22222222-2222-4222-8222-222222222222' };
        expect((await handleAudiobookFile(makeEvent(MEDIA))).status).toBe(401);
    });
    it('keeps 404 for an authenticated caller with a missing session', async () => {
        row = null;
        mockAuth.mockImplementation(async () => ({
            ok: true,
            userId: 'owner',
            absApiKey: 'k',
            absItemId: 'i',
        }));
        expect((await handleAudiobookFile(makeEvent(MEDIA))).status).toBe(404);
    });
});

describe('audiobook file route — media id comparison', () => {
    it('matches the session media id case-insensitively', async () => {
        row = liveRow();
        mockAuth.mockImplementation(async () => ({
            ok: true,
            userId: 'owner',
            absApiKey: 'k',
            absItemId: 'i',
        }));
        const res = await handleAudiobookFile(makeEvent(MEDIA.toLowerCase()));
        expect(res.status).toBe(200);
    });
});
