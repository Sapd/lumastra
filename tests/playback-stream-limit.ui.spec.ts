// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Stream limit — what the viewer sees when their account is already at its
 * concurrent-stream limit.
 *
 * Real server path, nothing intercepted: the test user gets a per-user policy
 * of ONE stream, a second "device" holds that slot through the normal
 * `POST /api/play-sessions`, and then the browser opens the player. The
 * refusal can arrive at either seam — the HLS manifest gate (429) or the
 * session start (422 `stream_limit_exceeded`) — depending on which request
 * wins; both must end in the same specific sentence, never a raw code
 * ("Stream not allowed: …"), a generic error or an endless spinner.
 */

import { randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { sameOriginAdminTest as test, expect } from './fixtures/auth';
import { TEST_MEDIA_ITEM_ID } from './global-setup';
import { cancelPlaySession } from './helpers/play-sessions';

// The policy table is keyed by the login handle; global-setup stores it lowercased.
const POLICY_USER = (process.env.TEST_USER || 'TestUser').toLowerCase();

/**
 * Own the precondition "no other active stream": earlier specs in the same run
 * (the dev server and its database live for the whole run) leave ACTIVE play
 * sessions on this account, which count against the one-stream cap and refuse
 * the setup request with `stream_limit_exceeded active:5 limit:1`. Ends them
 * the way the owner would; a spec cannot rely on the order it runs in.
 */
async function endLeftoverSessions(
    request: APIRequestContext,
    baseURL: string | undefined,
): Promise<void> {
    const list = await request.get('/api/admin/play-sessions');
    expect(list.ok(), await list.text()).toBe(true);
    const { sessions } = (await list.json()) as {
        sessions: Array<{ __id: string; username: string }>;
    };
    const mine = sessions.filter((s) => s.username.toLowerCase() === POLICY_USER);
    await Promise.all(mine.map((s) => cancelPlaySession(request, baseURL, s.__id)));
    await expect
        .poll(async () => {
            const again = await request.get('/api/admin/play-sessions');
            const body = (await again.json()) as { sessions: Array<{ username: string }> };
            return body.sessions.filter((s) => s.username.toLowerCase() === POLICY_USER).length;
        })
        .toBe(0);
}

test.describe('Stream limit refusal', () => {
    test('a viewer at their stream limit is told so in plain words', async ({ page, baseURL }) => {
        test.setTimeout(120_000);
        const request = page.request;
        let otherSessionId: string = randomUUID();

        await endLeftoverSessions(request, baseURL);

        const policy = await request.put(`/api/admin/users/${POLICY_USER}/stream-policy`, {
            data: { max_concurrent_streams: 1 },
        });
        expect(policy.ok(), await policy.text()).toBe(true);

        try {
            // Another device of the same account takes the only slot.
            const other = await request.post('/api/play-sessions', {
                data: {
                    mediaId: TEST_MEDIA_ITEM_ID,
                    deviceId: 'e2e-stream-limit-other-device',
                    clientInfo: { client: 'E2E other device' },
                    capabilities: {
                        containers: ['mp4', 'mkv'],
                        videoCodecs: ['h264'],
                        audioCodecs: ['aac'],
                        subtitleFormats: ['vtt'],
                        hdr: [],
                    },
                },
            });
            expect(other.status(), await other.text()).toBe(201);
            otherSessionId = ((await other.json()) as { playbackSessionId: string })
                .playbackSessionId;

            await page.goto(`/watch/${TEST_MEDIA_ITEM_ID}`);

            // A cold dev server can re-optimise deps during the first /watch load;
            // the client then fails to fetch its route chunks ("Failed to fetch
            // dynamically imported module") and SvelteKit renders its 500 page.
            // That is the harness, not the feature — reload once and carry on.
            const player = page.getByRole('application', { name: 'Video player' });
            const coldStartError = page.getByRole('heading', { name: 'Internal Error' });
            await expect(player.or(coldStartError)).toBeVisible({ timeout: 90_000 });
            if (await coldStartError.isVisible()) await page.reload();

            // The dev server compiles /watch on demand (first /info measured at
            // up to ~27 s cold in CI — see playback-diagnostics.ui.spec.ts).
            // The same sentence is also toasted; the player's own error panel is
            // the surface that must carry it.
            await expect(
                player.getByText(
                    "You're already watching on as many devices as your account allows",
                ),
            ).toBeVisible({ timeout: 90_000 });
            await expect(page.getByText(/Stream not allowed|stream_limit_exceeded/)).toHaveCount(0);
        } finally {
            await cancelPlaySession(request, baseURL, otherSessionId);
            const reset = await request.delete(`/api/admin/users/${POLICY_USER}/stream-policy`);
            expect(reset.status(), await reset.text()).toBe(204);
        }
    });
});
