// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import { toUserId } from '$lib/shared/user-id.js';
const { presence, playback, channel, allowed } = vi.hoisted(() => ({
    presence: vi.fn(),
    allowed: vi.fn(),
    playback: vi.fn(),
    channel: vi.fn(),
}));
vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({ userAllowsLiveTv: allowed }));
vi.mock('$lib/server/services/database.service.js', () => ({ aiDbService: { getSql: vi.fn() } }));
vi.mock('$lib/server/services/livetv/livetv-session.service.js', () => ({
    getLiveTvSessionService: () => ({ getSession: presence, getViewerPlaybackSession: playback }),
}));
vi.mock('$lib/server/database/queries/livetv-channels.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/livetv-channels.queries.js')>()),
    getChannelWithSource: channel,
}));
vi.mock('$lib/server/database/queries/user-devices.queries.js', () => ({
    getDeviceIdForSession: vi.fn(),
}));
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getActiveSessionsForUser: vi.fn(),
}));
import { projectNowPlaying } from './device-state-projection.js';
const user = { userId: toUserId('550e8400-e29b-41d4-a716-446655440000'), username: 'alice' };
const sql = {} as postgres.Sql;
beforeEach(() => {
    vi.resetAllMocks();
    allowed.mockResolvedValue(true);
    presence.mockResolvedValue({ channelId: 'feed', viewerKey: 'alice:device:d' });
    channel.mockResolvedValue({ name: 'News', backup_group_id: 'group', logo_url: null });
    playback.mockResolvedValue(null);
});
describe('Live TV device projection', () => {
    it('projects legacy presence as a station with a separate feed', async () => {
        expect(await projectNowPlaying(sql, user, 'd')).toMatchObject({
            sessionId: 'livetv:group',
            livetv: { stationId: 'group', feedId: 'feed' },
        });
    });
    it('uses the accepted session station even when its stored feed row is gone', async () => {
        channel.mockResolvedValue(null);
        playback.mockResolvedValue({
            state: 'active',
            stationId: 'stable-station',
            feedId: 'feed',
        });
        expect(await projectNowPlaying(sql, user, 'd')).toMatchObject({
            sessionId: 'livetv:stable-station',
            livetv: { stationId: 'stable-station', feedId: 'feed' },
        });
    });
    it('ungrouped legacy feeds keep their own station identity', async () => {
        channel.mockResolvedValue({ name: 'News', backup_group_id: null });
        expect(await projectNowPlaying(sql, user, 'd')).toMatchObject({
            sessionId: 'livetv:feed',
            livetv: { stationId: 'feed', feedId: 'feed' },
        });
    });
});

it('hides own Live TV channel name and logo when the user is disallowed', async () => {
    allowed.mockResolvedValue(false);
    channel.mockResolvedValue({ name: 'News', logo_url: 'https://example.test/news.png' });
    expect(await projectNowPlaying(sql, user, 'd')).toBeNull();
    expect(channel).not.toHaveBeenCalled();
});
