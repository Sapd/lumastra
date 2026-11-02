// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type { APIRequestContext } from '@playwright/test';
import { test, expect, missingFfmpeg, ffmpegSkipReason } from './fixtures';
import {
    api,
    control,
    feedIds,
    fixtureState,
    json,
    expectStatus,
    start,
    keepalive,
    sample,
    decode,
    startFailing,
    waitForSlots,
} from './harness';
import { identityHeaders } from './env';
import { expectHydrated } from '../helpers/hydration';
import type { FailureProblem, Station } from './harness';

function station(prefix: string): Station {
    const found = fixtureState().stations.find((item) => item.name.startsWith(prefix));
    if (!found) throw new Error(`Station ${prefix} missing`);
    return found;
}

// Nothing about the provider's address may reach a viewer-visible body.
function expectNoProviderLocation(text: string): void {
    const { port, hostname, host } = new URL(fixtureState().provider.baseUrl);
    expect(text).not.toContain(host);
    expect(text).not.toContain(`${hostname}:${port}`);
    expect(text).not.toMatch(/\/stream\/[a-z-]+\.ts/);
}

interface AdminChannel {
    id: string;
    health?: {
        state: string;
        consecutiveFailures: number;
        lastReason?: string;
    };
}

async function adminChannels(admin: APIRequestContext): Promise<AdminChannel[]> {
    const data = await json<{ categories: { channels: AdminChannel[] }[] }>(
        await admin.get('/api/admin/livetv/channels'),
    );
    return data.categories.flatMap((category) => category.channels);
}

test.describe('real Live TV failure modes @livetv', (): void => {
    test.skip(missingFfmpeg, ffmpegSkipReason);
    // Tests run in order on one worker (playwright.livetv.config.ts); a failure must not skip the rest.

    test.afterEach(async ({ actors }): Promise<void> => {
        await control({ feed: '*', mode: 'ok' });
        // Provider slots free once the fixture closes the actors' sessions (it waits for 0).
        await expectStatus(
            await actors.admin.request.put(`/api/admin/livetv/sources/${fixtureState().sourceId}`, {
                data: { maxStreams: 1 },
            }),
            200,
        );
    });

    test('401 from the provider gives provider_auth_failed without leaking the provider', async ({
        actors,
    }): Promise<void> => {
        const news = station('News One');
        await control({ feed: 'news-one', mode: 'status:401', body: 'Unauthorized' });

        const normal = await startFailing(actors.alice.request, news);
        expect(normal.status).toBe(502);
        expect(normal.body).toMatchObject({
            code: 'provider_auth_failed',
            failure: { retryable: false },
        });
        expect(normal.body.failure?.feedsTried, 'feedsTried is admin-only').toBeUndefined();
        expectNoProviderLocation(normal.text);

        const admin = await startFailing(actors.admin.request, news);
        expect(admin.body.code).toBe('provider_auth_failed');
        const [feed] = await feedIds(actors.admin.request, news);
        expect(admin.body.failure?.feedsTried).toEqual([
            expect.objectContaining({ feedId: feed, upstreamStatus: 401 }),
        ]);
        expectNoProviderLocation(admin.text);
    });

    for (const mode of ['end', 'status:404'] as const) {
        test(`source ${mode} at start gives channel_offline`, async ({ actors }): Promise<void> => {
            await control({ feed: 'news-one', mode });
            const result = await startFailing(actors.alice.request, station('News One'));
            expect(result.body.code).toBe('channel_offline');
            expect(typeof result.body.failure?.retryable).toBe('boolean');
            expectNoProviderLocation(result.text);
        });
    }

    for (const mode of ['end', 'stall'] as const) {
        test(`mid-stream ${mode} gives upstream_stalled on keepalive, state and media`, async ({
            actors,
        }): Promise<void> => {
            const client = actors.alice.request;
            const session = await start(client, station('News One'));
            const media = await sample(client, session.delivery.url);
            await decode(media);
            await control({ feed: 'news-one', mode });

            // Bounds: `end` makes FFmpeg exit (next 1 s health check, immediate failover);
            // `stall` needs the proxy's 30 s stale-segment detection, then the 5 s degraded
            // window from playwright.livetv.config.ts, plus health-check and probe slack.
            const bound = mode === 'end' ? 45_000 : 90_000;
            // The HLS 410 is what a media-only player sees. A keepalive in every round keeps the
            // proxy viewer alive: playlist reads alone expire it after the 12 s viewer timeout,
            // before the 30 s stale-segment detection of a stall can fire.
            let gone: { status: number; text: string } | undefined;
            await expect
                .poll(
                    async (): Promise<number> => {
                        const response = await client.get(media.playlistUrl);
                        gone = { status: response.status(), text: await response.text() };
                        if (response.status() !== 410) {
                            const beat = await keepalive(client, session);
                            expect([204, 410], await beat.text()).toContain(beat.status());
                        }
                        return response.status();
                    },
                    {
                        timeout: bound,
                        intervals: [1000],
                        message: `media playlist 410 within ${bound} ms`,
                    },
                )
                .toBe(410);
            expect(JSON.parse(gone?.text ?? '{}')).toMatchObject({ code: 'upstream_stalled' });
            expectNoProviderLocation(gone?.text ?? '');

            const response = await keepalive(client, session);
            expect(response.status(), await response.text()).toBe(410);
            const ended = (await response.json()) as FailureProblem;
            expect(ended).toMatchObject({
                code: 'upstream_stalled',
                error: 'playback_session_ended',
                reason: 'failed',
            });
            expect(typeof ended.failure?.retryable).toBe('boolean');

            const current = await json<{
                state: string;
                endReason?: string;
                failure?: { code: string };
            }>(await client.get(`${api}/playback-sessions/${session.playbackSessionId}`));
            expect(current).toMatchObject({
                state: 'ended',
                endReason: 'failed',
                failure: { code: 'upstream_stalled' },
            });
        });
    }

    test('second provider connection gives provider_connection_limit', async ({
        actors,
    }): Promise<void> => {
        // Our own limit must not refuse first; the provider still allows one connection.
        await expectStatus(
            await actors.admin.request.put(`/api/admin/livetv/sources/${fixtureState().sourceId}`, {
                data: { maxStreams: 2 },
            }),
            200,
        );
        const [a, b] = fixtureState().stations;
        const first = await start(actors.alice.request, a);
        await decode(await sample(actors.alice.request, first.delivery.url));
        await waitForSlots(1);
        const refused = await startFailing(actors.bob.request, b);
        expect(refused.status).toBe(503);
        expect(refused.body).toMatchObject({
            code: 'provider_connection_limit',
            failure: { retryable: true },
            retryAfter: 30,
        });
        expectNoProviderLocation(refused.text);
    });

    test('grouped station with every feed failing gives all_feeds_failed', async ({
        actors,
    }): Promise<void> => {
        const kids = station('Kids Four');
        await control({ feed: 'kids-four-hd', mode: 'status:404' });
        await control({ feed: 'kids-four-sd', mode: 'status:404' });
        const ids = await feedIds(actors.admin.request, kids);
        expect(ids).toHaveLength(2);

        const admin = await startFailing(actors.admin.request, kids);
        expect(admin.body.code).toBe('all_feeds_failed');
        expect(admin.body.failure?.feedsTried?.map((entry) => entry.feedId).sort()).toEqual(
            [...ids].sort(),
        );
        expectNoProviderLocation(admin.text);

        const normal = await startFailing(actors.alice.request, kids);
        expect(normal.body.code).toBe('all_feeds_failed');
        expect(normal.body.failure?.feedsTried).toBeUndefined();
    });

    test('admin channel health records the failure and reset clears it', async ({
        actors,
    }): Promise<void> => {
        const news = station('News One');
        const admin = actors.admin.request;
        const [feed] = await feedIds(admin, news);
        await control({ feed: 'news-one', mode: 'status:404' });
        const failed = await startFailing(actors.alice.request, news);
        expect(failed.body.code).toBe('channel_offline');

        // Health comes from the proxy's failure events, moved to PostgreSQL by a 60 s drain
        // timer in the web process (livetv-failure-drain.ts); allow one full interval plus slack.
        await expect
            .poll(async () => (await adminChannels(admin)).find((c) => c.id === feed)?.health, {
                timeout: 100_000,
                intervals: [1000, 2000],
            })
            .toMatchObject({ lastReason: 'channel_offline' });
        const health = (await adminChannels(admin)).find((c) => c.id === feed)?.health;
        expect(['failing', 'offline']).toContain(health?.state);
        expect(health?.consecutiveFailures).toBeGreaterThan(0);

        const reset = await json<{ state: string }>(
            await admin.post(`/api/admin/livetv/channels/${feed}/health/reset`),
        );
        expect(reset.state).toBe('ok');
        const after = (await adminChannels(admin)).find((c) => c.id === feed)?.health;
        expect(after === undefined || after.state === 'ok').toBe(true);
    });

    test('watch page shows the failure card with Try another channel', async ({
        browser,
        baseURL,
    }): Promise<void> => {
        const news = station('News One');
        await control({ feed: 'news-one', mode: 'status:404' });
        const context = await browser.newContext({
            baseURL,
            extraHTTPHeaders: identityHeaders('alice'),
            locale: 'en-US',
        });
        try {
            const page = await context.newPage();
            await page.goto(`/watch/${news.id}`);
            await expectHydrated(page);
            await expect(page.getByText("This channel isn't broadcasting right now.")).toBeVisible({
                timeout: 60_000,
            });
            await expect(page.getByRole('button', { name: 'Try another channel' })).toBeVisible();
            // No spinner once the card is shown.
            await expect(page.getByRole('progressbar')).toHaveCount(0);
        } finally {
            await context.close();
        }
    });
});
