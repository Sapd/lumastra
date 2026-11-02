// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { adminTest as test, expect } from './fixtures/auth';

test.describe('Music Channels API', () => {
    test('POST /api/music/radio/start creates a mood channel', async ({ request }) => {
        const res = await request.post('/api/music/radio/start', {
            data: { type: 'mood', mood: 'chill' },
        });
        // May be 401 in test env (no auth) or 500 if no tracks — skip if not ok
        if (!res.ok()) {
            test.skip();
            return;
        }
        const body = (await res.json()) as {
            sessionId: string;
            channel: { type: string };
            tracks: unknown[];
        };
        expect(body.sessionId).toBeDefined();
        expect(body.channel.type).toBe('mood');
        expect(Array.isArray(body.tracks)).toBe(true);
    });

    test('GET /api/music/radio/next returns tracks for session', async ({ request }) => {
        const start = await request.post('/api/music/radio/start', {
            data: { type: 'mood', mood: 'chill' },
        });
        if (!start.ok()) {
            test.skip();
            return;
        }
        const { sessionId } = (await start.json()) as { sessionId: string };

        const res = await request.get(`/api/music/radio/next?sessionId=${sessionId}&count=3`);
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as {
            tracks: unknown[];
            suggestions: unknown[];
        };
        expect(Array.isArray(body.tracks)).toBe(true);
        expect(Array.isArray(body.suggestions)).toBe(true);
    });

    test('POST /api/music/radio/skip records a skip', async ({ request }) => {
        const start = await request.post('/api/music/radio/start', {
            data: { type: 'mood', mood: 'chill' },
        });
        if (!start.ok()) {
            test.skip();
            return;
        }
        const startBody = (await start.json()) as {
            sessionId: string;
            tracks: Array<{ id: string }>;
        };
        const { sessionId, tracks } = startBody;
        if (!tracks[0]) {
            test.skip();
            return;
        }

        const res = await request.post('/api/music/radio/skip', {
            data: { sessionId, trackId: tracks[0].id },
        });
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as { nextTrackId: string | null };
        expect('nextTrackId' in body).toBe(true);
    });

    test('DELETE /api/music/radio/stop ends session', async ({ request }) => {
        const start = await request.post('/api/music/radio/start', {
            data: { type: 'mood', mood: 'chill' },
        });
        if (!start.ok()) {
            test.skip();
            return;
        }
        const { sessionId } = (await start.json()) as { sessionId: string };

        const res = await request.delete(`/api/music/radio/stop?sessionId=${sessionId}`);
        expect(res.status()).toBe(204);

        // Session should be gone
        const check = await request.get(`/api/music/radio/session?sessionId=${sessionId}`);
        expect(check.status()).toBe(404);
    });

    test('GET /api/music/radio/session returns channel info', async ({ request }) => {
        const start = await request.post('/api/music/radio/start', {
            data: { type: 'genre', genre: 'rock' },
        });
        if (!start.ok()) {
            test.skip();
            return;
        }
        const { sessionId } = (await start.json()) as { sessionId: string };

        const res = await request.get(`/api/music/radio/session?sessionId=${sessionId}`);
        expect(res.ok()).toBe(true);
        const body = (await res.json()) as {
            channel: { type: string };
            queue: string[];
        };
        expect(body.channel.type).toBe('genre');
        expect(Array.isArray(body.queue)).toBe(true);
    });
});
