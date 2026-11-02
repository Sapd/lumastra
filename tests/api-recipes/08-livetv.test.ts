// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
// Owners: packages 4/16. A package that changes this area updates this recipe in the same commit.
import { test, expect } from 'vitest';
import { clientFor, expectOk, records, reachable } from './client';
import { LIVETV_FAILURE_REASONS } from '../../src/shared/livetv-failure-reason';
// Live TV needs a user with Live TV access (RECIPES_LIVETV_TOKEN / RECIPES_LIVETV_FORWARD_USER).
const client = clientFor(process.env.RECIPES_LIVETV_TOKEN ?? process.env.RECIPES_TOKEN);
test('08 stations → guide → one station playback session → keepalive → stop', async (ctx) => {
    const stations = expectOk(
        'GET',
        '/livetv/stations',
        await client.GET('/api/v1/livetv/stations'),
    );
    const guide = expectOk(
        'GET',
        '/livetv/guide',
        await client.GET('/api/v1/livetv/guide', {
            params: {
                query: {
                    from: new Date().toISOString(),
                    to: new Date(Date.now() + 3600000).toISOString(),
                    limit: 20,
                },
            },
        }),
    );
    // Package 16 contract: ordered stations, each with its airings and a nowNext block, plus paging.
    expect(Array.isArray(guide.stations)).toBe(true);
    expect(guide.page).toHaveProperty('hasMore');
    for (const entry of guide.stations as unknown as Record<string, unknown>[]) {
        expect(entry).toHaveProperty('stationId');
        expect(entry).toHaveProperty('airings');
        expect(entry).toHaveProperty('nowNext');
    }
    const search = expectOk(
        'GET',
        '/livetv/programs/search',
        await client.GET('/api/v1/livetv/programs/search', {
            params: { query: { q: 'news', limit: 5 } },
        }),
    );
    // One item per airing, keyed by stationId (never a feed id), with a station summary.
    expect(search.page).toHaveProperty('hasMore');
    for (const item of search.items as unknown as Record<string, unknown>[]) {
        expect(item).toHaveProperty('stationId');
        expect(item).toHaveProperty('temporalStatus');
        expect(item).toHaveProperty('station');
        expect(item).not.toHaveProperty('channelId');
    }
    // Typed errors: an unknown station is a problem+json 404 with a code to switch on.
    const unknown = await client.POST('/api/v1/livetv/playback-sessions', {
        body: { stationId: crypto.randomUUID() },
    });
    expect(unknown.response.status).toBe(404);
    expect(unknown.response.headers.get('content-type')).toContain('application/problem+json');
    expect(unknown.error).toMatchObject({ code: 'not_found' });
    expect(typeof (unknown.error as Record<string, unknown>).error).toBe('string');
    const station = records(stations).find((r) => typeof r.id === 'string');
    if (!station) return ctx.skip('Instance has no Live TV stations');
    const stationId = String(station.id);
    const deadline = Date.now() + 25000;
    let playbackSessionId: string | undefined;
    // Arm cleanup before start: even a failed/timed-out start may allocate provider resources.
    try {
        const response = await client.POST('/api/v1/livetv/playback-sessions', {
            body: { stationId },
            signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
        });
        if (response.error) {
            // A real start that fails still speaks the taxonomy: a code from it and a boolean retryable.
            const problem = response.error as Record<string, unknown>;
            if ((LIVETV_FAILURE_REASONS as readonly string[]).includes(String(problem.code))) {
                expect(typeof problem.retryable).toBe('boolean');
            }
        }
        const start = expectOk('POST', '/livetv/playback-sessions', response);
        playbackSessionId = String(start.playbackSessionId);
        expect(String(start.delivery.url)).toContain('grant=');
        expect(String(start.delivery.url)).toContain('PlaySessionId=');
        await reachable(start.delivery.url, 'stream', Math.max(1, deadline - Date.now()));
        expectOk(
            'POST',
            '/livetv/playback-sessions/{playbackSessionId}/keepalive',
            await client.POST('/api/v1/livetv/playback-sessions/{playbackSessionId}/keepalive', {
                params: { path: { playbackSessionId } },
                signal: AbortSignal.timeout(Math.max(1, deadline - Date.now())),
            }),
        );
        expect(Date.now()).toBeLessThan(deadline);
    } finally {
        if (playbackSessionId) {
            const id = playbackSessionId;
            expectOk(
                'DELETE',
                '/livetv/playback-sessions/{playbackSessionId}',
                await client.DELETE('/api/v1/livetv/playback-sessions/{playbackSessionId}', {
                    params: { path: { playbackSessionId: id } },
                    signal: AbortSignal.timeout(4000),
                }),
            );
        }
    }
});
