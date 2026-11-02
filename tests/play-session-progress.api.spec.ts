// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Play-session progress API tests — PUT /api/play-sessions/{id}
 *
 * The player reports progress and completion through its play session
 * (play-session-reporter.ts). This replaced /api/playback/{id}/lumastra-progress,
 * which is gone; the old spec accepted 404 everywhere and passed vacuously.
 *
 * Covers, end to end through the HTTP surface:
 * - Combined-file completion: a session opened on EP1 of a two-episode file and
 *   completed past EP2's window marks BOTH watched (watch-manager fan-out).
 * - Forward-only control: a session opened on EP4 (second episode of another
 *   combined file) never marks EP3, which was skipped past, not watched.
 * - Body validation: missing or negative positionMs → 422 validation_failed.
 * - A caller with no identity cannot write to someone's session.
 *
 * global-setup.ts seeds EP1/EP2 and EP3/EP4 as two combined files, each with
 * windows [0, 600 s) and [600 s, 1200 s), and clears their watch state, so both
 * completion tests start from a known-unwatched baseline with no event history.
 */

import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { sameOriginAdminTest as test, expect } from './fixtures/auth';
import {
    TEST_EP1_ID,
    TEST_EP2_ID,
    TEST_EP3_ID,
    TEST_EP4_ID,
    TEST_MEDIA_ITEM_ID,
} from './global-setup';

const PAST_BOTH_WINDOWS_MS = 1_190_000;

async function startSession(request: APIRequestContext, mediaId: string): Promise<string> {
    const r = await request.post('/api/play-sessions', {
        data: {
            mediaId,
            deviceId: 'e2e-play-session-progress',
            capabilities: {
                containers: ['mp4', 'mkv'],
                videoCodecs: ['h264', 'hevc'],
                audioCodecs: ['aac', 'ac3', 'eac3'],
                subtitleFormats: ['vtt'],
                hdr: [],
            },
        },
    });
    expect(r.status(), await r.text()).toBe(201);
    return ((await r.json()) as { playbackSessionId: string }).playbackSessionId;
}

async function cancelSession(request: APIRequestContext, sessionId: string): Promise<void> {
    await request
        .delete(`/api/play-sessions/${sessionId}`, {
            headers: { 'Content-Type': 'application/json' },
        })
        .catch(() => {});
}

async function isWatched(request: APIRequestContext, itemId: string): Promise<boolean> {
    const r = await request.get(`/api/watched/${itemId}`);
    expect(r.status(), await r.text()).toBe(200);
    return ((await r.json()) as { watched: boolean }).watched;
}

function completeAt(positionMs: number) {
    return {
        positionMs,
        status: 'COMPLETED',
        eventSeq: 1,
        sessionElapsedMs: positionMs,
        endReason: 'completion',
    };
}

test.describe('PUT /api/play-sessions/{id} — progress and completion', () => {
    test('completing a combined file opened on EP1 marks EP1 and EP2 watched', async ({
        request,
    }) => {
        expect(await isWatched(request, TEST_EP1_ID)).toBe(false);
        expect(await isWatched(request, TEST_EP2_ID)).toBe(false);

        const sessionId = await startSession(request, TEST_EP1_ID);
        try {
            const r = await request.put(`/api/play-sessions/${sessionId}`, {
                data: completeAt(PAST_BOTH_WINDOWS_MS),
            });
            expect(r.status(), await r.text()).toBe(204);

            expect(await isWatched(request, TEST_EP1_ID)).toBe(true);
            expect(await isWatched(request, TEST_EP2_ID)).toBe(true);
        } finally {
            await cancelSession(request, sessionId);
        }
    });

    test('completing a combined file opened on EP4 does not mark the skipped EP3', async ({
        request,
    }) => {
        expect(await isWatched(request, TEST_EP3_ID)).toBe(false);
        expect(await isWatched(request, TEST_EP4_ID)).toBe(false);

        const sessionId = await startSession(request, TEST_EP4_ID);
        try {
            const r = await request.put(`/api/play-sessions/${sessionId}`, {
                data: completeAt(PAST_BOTH_WINDOWS_MS),
            });
            expect(r.status(), await r.text()).toBe(204);

            expect(await isWatched(request, TEST_EP4_ID)).toBe(true);
            expect(await isWatched(request, TEST_EP3_ID)).toBe(false);
        } finally {
            await cancelSession(request, sessionId);
        }
    });

    test('a missing or negative positionMs is rejected with 422', async ({ request }) => {
        const sessionId = await startSession(request, TEST_MEDIA_ITEM_ID);
        try {
            const missing = await request.put(`/api/play-sessions/${sessionId}`, {
                data: { status: 'ACTIVE', eventSeq: 1, sessionElapsedMs: 0 },
            });
            expect(missing.status(), await missing.text()).toBe(422);

            const negative = await request.put(`/api/play-sessions/${sessionId}`, {
                data: { positionMs: -1, status: 'ACTIVE', eventSeq: 2, sessionElapsedMs: 0 },
            });
            expect(negative.status(), await negative.text()).toBe(422);

            // Control: the same session accepts a well-formed heartbeat.
            const valid = await request.put(`/api/play-sessions/${sessionId}`, {
                data: { positionMs: 1_000, status: 'ACTIVE', eventSeq: 3, sessionElapsedMs: 0 },
            });
            expect(valid.status(), await valid.text()).toBe(200);
        } finally {
            await cancelSession(request, sessionId);
        }
    });

    test('a caller with no identity cannot complete another user session', async ({ request }) => {
        const sessionId = await startSession(request, TEST_MEDIA_ITEM_ID);
        try {
            const anonymous = await request.put(`/api/play-sessions/${sessionId}`, {
                data: completeAt(60_000),
                headers: { 'X-Forwarded-User': '', 'X-Forwarded-Groups': '' },
            });
            expect(anonymous.status(), await anonymous.text()).toBe(401);

            // Nothing landed: the session was not stopped, so its owner's next
            // heartbeat is an ordinary ack rather than a kill or a 404.
            const owner = await request.put(`/api/play-sessions/${sessionId}`, {
                data: { positionMs: 1_000, status: 'ACTIVE', eventSeq: 1, sessionElapsedMs: 0 },
            });
            expect(owner.status(), await owner.text()).toBe(200);
            expect(((await owner.json()) as { action?: string }).action).toBeUndefined();
        } finally {
            await cancelSession(request, sessionId);
        }
    });

    test('an unknown session id returns 404', async ({ request }) => {
        const r = await request.put(`/api/play-sessions/${randomUUID()}`, {
            data: { positionMs: 1_000, status: 'ACTIVE', eventSeq: 1, sessionElapsedMs: 0 },
        });
        expect(r.status(), await r.text()).toBe(404);
    });
});
