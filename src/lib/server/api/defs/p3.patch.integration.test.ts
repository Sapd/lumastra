// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { createTestUser } from '../../../../../tests/integration/helpers/users.js';
import { createAndInsertTestSeries } from '../../../../../tests/integration/fixtures/index.js';
import { toUserId } from '$lib/shared/user-id.js';
import { config } from '$lib/server/config.js';
import { mount } from '$lib/server/api/mount.js';
import {
    upsertPlaybackPreferences,
    getPlaybackPreferences,
} from '$lib/server/database/queries/user-preferences.queries.js';

vi.mock('$lib/server/database/connection.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/connection.js')>()),
    getDb: () => getTestDb(),
}));
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: async () => getTestDb() },
}));
// Exercise the real state fan-out and SQL, with UUID resolution and access tested separately.
vi.mock('$lib/server/middleware/id-resolution.js', () => ({
    withIdResolution: (handler: unknown) => handler,
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: async () => true }));

import { def as preferences } from './user/playback-preferences.js';
import { def as playlist } from './playlists/[id]/index.js';
import { def as watchState } from './watch-state/[id].js';

function event(path: string, user: { id: string; username: string }, body: unknown): RequestEvent {
    const url = new URL(`http://localhost${path}`);
    return {
        url,
        request: new Request(url, {
            method: 'PATCH',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
        }),
        params: { id: path.split('/').pop()! },
        route: { id: null },
        locals: {
            user: {
                userId: toUserId(user.id),
                username: user.username,
                userGroups: [],
                groups: '',
                ownerIsAdmin: false,
                maxAgeRating: null,
            },
        },
        getClientAddress: () => '127.0.0.1',
    } as unknown as RequestEvent;
}

describe('P3 mounted PATCH persistence', () => {
    beforeAll(() => {
        vi.spyOn(config, 'FEATURE_PLAYLISTS', 'get').mockReturnValue(true);
    });
    afterAll(async () => {
        vi.restoreAllMocks();
        await closeTestDb();
    });

    it.each(['internal', 'v1'] as const)(
        '%s preferences preserve omitted fields and explicit false/null',
        async (surface) => {
            const sql = getTestDb();
            const user = await createTestUser(sql);
            await upsertPlaybackPreferences(sql, toUserId(user.id), {
                audioLanguage: 'de',
                subtitlesEnabled: true,
                musicShowBpm: false,
            });
            const path =
                surface === 'v1'
                    ? '/api/v1/me/playback-preferences'
                    : '/api/me/playback-preferences';
            const response = await mount(preferences, { surface }).PATCH!(
                event(path, user, { subtitlesEnabled: false, audioLanguage: null }),
            );
            expect(response.status).toBe(200);
            const row = await getPlaybackPreferences.one(sql, { userId: toUserId(user.id) });
            expect(row).toMatchObject({
                audio_language: null,
                subtitles_enabled: false,
                music_show_bpm: false,
            });
        },
    );

    it.each(['internal', 'v1'] as const)(
        '%s playlist PATCH uses the parsed body and preserves omitted metadata',
        async (surface) => {
            const sql = getTestDb();
            const user = await createTestUser(sql);
            const [created] = await sql<
                { id: number }[]
            >`INSERT INTO playlists (user_id, name, description, visibility, playlist_type) VALUES (${user.id}::uuid, 'Before', 'Keep this', 'private', 'general') RETURNING id`;
            const prefix = surface === 'v1' ? '/api/v1' : '/api';
            const response = await mount(playlist, { surface }).PATCH!(
                event(`${prefix}/playlists/${created.id}`, user, { name: 'After' }),
            );
            expect(response.status).toBe(200);
            const [row] =
                await sql`SELECT name, description, visibility, playlist_type FROM playlists WHERE id = ${created.id}`;
            expect(row).toMatchObject({
                name: 'After',
                description: 'Keep this',
                visibility: 'private',
                playlist_type: 'general',
            });
        },
    );

    it.each(['series', 'season'] as const)(
        'PATCH watched cascades through a real %s and preserves the other season',
        async (kind) => {
            const sql = getTestDb();
            const user = await createTestUser(sql);
            const series = await createAndInsertTestSeries(sql, {
                seasonCount: 2,
                episodesPerSeason: 2,
            });
            const seasons = await sql<
                { id: string; season_number: number }[]
            >`SELECT id, season_number FROM media_items WHERE parent_id = ${series.seriesId}::uuid ORDER BY season_number`;
            const id = kind === 'series' ? series.seriesId : seasons[0].id;
            const response = await mount(watchState, { surface: 'v1' }).PATCH!(
                event(`/api/v1/watch-state/${id}`, user, { watched: true }),
            );
            expect(response.status).toBe(200);
            const episodes = await sql<
                { season_number: number; is_watched: boolean | null }[]
            >`SELECT ep.season_number, s.is_watched FROM media_items ep JOIN media_items season ON ep.parent_id = season.id LEFT JOIN user_media_state s ON s.media_id = ep.id AND s.user_id = ${user.id}::uuid WHERE season.parent_id = ${series.seriesId}::uuid AND ep.media_type = 'episode' ORDER BY ep.season_number, ep.episode_number`;
            expect(episodes).toHaveLength(4);
            expect(episodes.filter((ep) => ep.is_watched).length).toBe(kind === 'series' ? 4 : 2);
            expect(
                episodes.filter((ep) => ep.season_number === 1).every((ep) => ep.is_watched),
            ).toBe(true);
        },
    );
});
