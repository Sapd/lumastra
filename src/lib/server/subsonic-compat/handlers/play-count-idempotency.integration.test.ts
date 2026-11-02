// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, describe, expect, it } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb } from '../../../../../tests/integration/setup/test-database.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../tests/integration/fixtures/user.fixtures.js';
import { createAndInsertTestMusicHierarchy } from '../../../../../tests/integration/fixtures/music.fixtures.js';
import { connectValkey } from '$lib/server/cache/valkey.js';
import type { SubsonicAuthContext } from '../types.js';
import { handleScrobble } from './ratings.js';
import { handleReportPlayback } from './playback.js';

function event(params: Record<string, string>): RequestEvent {
    const url = new URL('http://localhost/subsonic/rest/scrobble');
    url.search = new URLSearchParams(params).toString();
    return { url, request: new Request(url), locals: {} } as RequestEvent;
}

describe('Subsonic play counters', () => {
    beforeAll(async () => {
        expect(await connectValkey()).toBe(true);
    });

    it.each([
        ['scrobble', 'start'],
        ['scrobble', 'end'],
        ['playback', 'start'],
        ['playback', 'end'],
    ] as const)('%s %s retries count once', async (surface, stage) => {
        const sql = getTestDb();
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const {
            trackIds: [trackId],
        } = await createAndInsertTestMusicHierarchy(sql, { trackCount: 1 });
        const auth: SubsonicAuthContext = {
            userId,
            username: userId,
            ownerIsAdmin: true,
            displayName: null,
            clientName: 'dedup-test',
            format: 'json',
            userGroups: [],
            maxAgeRating: null,
            isAgeRestricted: false,
        };
        const start = (): Promise<Response> =>
            surface === 'scrobble'
                ? handleScrobble(event({ id: trackId, submission: 'false' }), auth, sql)
                : handleReportPlayback(
                      event({
                          mediaId: trackId,
                          mediaType: 'song',
                          positionMs: '0',
                          state: 'starting',
                      }),
                      auth,
                      sql,
                  );
        const stop = (): Promise<Response> =>
            surface === 'scrobble'
                ? handleScrobble(event({ id: trackId, submission: 'true' }), auth, sql)
                : handleReportPlayback(
                      event({
                          mediaId: trackId,
                          mediaType: 'song',
                          positionMs: '200000',
                          state: 'stopped',
                      }),
                      auth,
                      sql,
                  );
        await start();
        if (stage === 'start') await start();
        const [started] = await sql<{ play_count: number }[]>`
            SELECT play_count FROM user_music_state WHERE user_id = ${userId} AND track_id = ${trackId}
        `;
        expect(started.play_count).toBe(1);
        await stop();
        await stop();
        const [ended] = await sql<{ play_count: number; complete_count: number }[]>`
            SELECT play_count, complete_count FROM user_music_state WHERE user_id = ${userId} AND track_id = ${trackId}
        `;
        expect(ended).toEqual({ play_count: 1, complete_count: 1 });
    });
});
