// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { LyricsResponseSchema } from '$lib/schemas/music';
import { getTrackDetail } from '$lib/server/database/queries/music.queries.js';
import { checkMediaAccess } from '$lib/server/middleware/media-access.js';
import { readStoredLyrics } from '$lib/server/services/music/lyrics.service.js';
import { def } from './lyrics';

vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: vi.fn(async () => ({})) },
}));
vi.mock('$lib/server/database/queries/music.queries.js', () => ({
    getTrackDetail: vi.fn(async () => ({ id: 'track-1' })),
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));
vi.mock('$lib/server/services/music/lyrics.service.js', () => ({
    readStoredLyrics: vi.fn(() => null),
    saveUserLyrics: vi.fn(),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) },
}));

beforeEach(() => vi.clearAllMocks());

function eventFor(id: string): RequestEvent {
    return {
        params: { id },
        locals: { user: { userId: 'user', username: 'listener' } },
        url: new URL(`https://example.test/api/v1/music/tracks/${id}/lyrics`),
    } as unknown as RequestEvent;
}

async function getLyrics(id = 'track-1') {
    return def.handlers.GET!(eventFor(id), {} as never);
}

describe('GET /music/tracks/{id}/lyrics', () => {
    it('answers 200 with lyrics and parsed synced lines when the track has lyrics', async () => {
        vi.mocked(readStoredLyrics).mockReturnValueOnce({
            plain: 'Hello',
            synced: '[00:01.00]Hello',
            source: 'user',
            fetchedAt: null,
        });
        const response = await getLyrics();
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(LyricsResponseSchema.parse(body)).toEqual(body);
        expect(body.lyrics).toMatchObject({ plain: 'Hello', synced: '[00:01.00]Hello' });
        expect(body.syncedLines.map((line: { text: string }) => line.text)).toEqual(['Hello']);
    });

    it('answers 200 with lyrics: null (no syncedLines) for a known track without lyrics', async () => {
        vi.mocked(readStoredLyrics).mockReturnValueOnce(null);
        const response = await getLyrics();
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body).toEqual({ lyrics: null });
        expect(LyricsResponseSchema.parse(body)).toEqual(body);
    });

    it('answers 404 when the track does not exist', async () => {
        vi.mocked(getTrackDetail).mockResolvedValueOnce(null as never);
        const response = await getLyrics('missing');
        expect(response.status).toBe(404);
        expect(readStoredLyrics).not.toHaveBeenCalled();
    });

    it('answers 404 when the caller cannot access the track', async () => {
        vi.mocked(checkMediaAccess).mockResolvedValueOnce(false);
        const response = await getLyrics();
        expect(response.status).toBe(404);
        expect(readStoredLyrics).not.toHaveBeenCalled();
    });
});
