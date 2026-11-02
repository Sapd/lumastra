// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
const { state } = vi.hoisted(() => ({ state: vi.fn() }));
vi.mock('../database/queries/user-media-state.queries.js', () => ({ getState: { one: state } }));
import { readAudiobookResume } from './audiobook-resume.service.js';

describe('audiobook resume clock tolerance', () => {
    beforeEach(() => {
        state.mockReset();
    });
    it.each([-250, -1000])('arbitrates a local timestamp %i ms relative to ABS', async (delta) => {
        state.mockResolvedValue({
            resume_position_ms: 12000,
            is_watched: true,
            last_event_at: new Date(10000 + delta).toISOString(),
        });
        const getMeAs = vi.fn(async () => ({
            id: 'user',
            username: 'listener',
            mediaProgress: [
                {
                    id: 'progress',
                    libraryItemId: 'book',
                    episodeId: null,
                    currentTime: 5,
                    duration: 60,
                    progress: 0,
                    isFinished: false,
                    lastUpdate: 10000,
                    startedAt: null,
                    finishedAt: null,
                },
            ],
        }));
        const result = await readAudiobookResume({
            sql: vi.fn() as never,
            userId: toUserId('aaaaaaaa-0000-4000-8000-000000000001'),
            mediaId: 'media',
            absItemId: 'book',
            apiKey: 'key',
            client: { getMeAs },
            fallbackPositionMs: 0,
        });
        expect(result).toEqual(
            delta === -250
                ? { positionMs: 12000, localIsNewest: true, isFinished: true }
                : { positionMs: 5000, localIsNewest: false, isFinished: false },
        );
    });
});
