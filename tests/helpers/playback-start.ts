// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID } from 'node:crypto';
import { sameOriginAdminTest, expect } from '../fixtures/auth';
import { TEST_MEDIA_ITEM_ID } from '../global-setup';
import {
    PlaybackStartResponseSchema,
    type PlaybackStartResponse,
} from '../../src/lib/schemas/playback-start';

export const playbackCapabilities = {
    containers: ['mp4', 'mkv'],
    videoCodecs: ['h264', 'hevc'],
    audioCodecs: ['aac', 'ac3', 'eac3'],
    subtitleFormats: ['vtt'],
    hdr: [] as string[],
};

export const grantTest = sameOriginAdminTest.extend<{
    accountHeaders: Record<string, string>;
    startPlayback: (mediaId?: string) => Promise<PlaybackStartResponse>;
}>({
    accountHeaders: async ({ request }, use) => {
        const response = await request.post('/api/me/pats', {
            data: { name: 'Playback grant contract', scopes: ['read', 'write'], expiresInDays: 1 },
        });
        expect(response.status(), await response.text()).toBe(201);
        const pat = (await response.json()) as { id: string; token: string };
        await use({
            Authorization: `Bearer ${pat.token}`,
            'X-Forwarded-User': '',
            'X-Forwarded-Groups': '',
        });
        await request.delete(`/api/me/pats/${pat.id}`);
    },
    startPlayback: async ({ request, accountHeaders }, use) => {
        const sessions: string[] = [];
        await use(async (mediaId = TEST_MEDIA_ITEM_ID) => {
            const response = await request.post('/api/v1/play-sessions', {
                headers: accountHeaders,
                data: {
                    mediaId,
                    deviceId: `grant-e2e-${randomUUID()}`,
                    capabilities: playbackCapabilities,
                },
            });
            expect(response.status(), await response.text()).toBe(201);
            const start = PlaybackStartResponseSchema.parse(await response.json());
            sessions.push(start.playbackSessionId);
            return start;
        });
        for (const id of sessions) await request.delete(`/api/play-sessions/${id}`, { data: {} });
    },
});
export { expect };
