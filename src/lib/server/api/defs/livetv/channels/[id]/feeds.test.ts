// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * GET /livetv/stations/{id}/feeds through mount(): the setting, permission and
 * channel access gates, and the response shape. The query and the access rule
 * against real rows: livetv-channels.queries.integration.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { toUserId } from '$lib/shared/user-id.js';
import type { StationFeedRow } from '$lib/server/database/queries/livetv-channels.queries.js';

const { mockConfig, mockGetSql, mockGetStationFeeds, mockCanStream } = vi.hoisted(() => ({
    mockConfig: {
        FEATURE_LIVETV: true,
        LIVETV_VIEWER_FEED_CHOICE: true,
        LIVETV_SOURCE: 'standalone',
    },
    mockGetSql: vi.fn(),
    mockGetStationFeeds: vi.fn(),
    mockCanStream: vi.fn(),
}));

vi.mock('$lib/server/config.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get(target, property, receiver) {
                if (property in mockConfig) return mockConfig[property as keyof typeof mockConfig];
                return Reflect.get(target, property, receiver);
            },
        }),
    };
});
vi.mock('$lib/server/services/database.service.js', () => ({
    aiDbService: { getSql: (...args: unknown[]) => mockGetSql(...args) },
}));
vi.mock('$lib/server/database/queries/livetv-channels.queries.js', () => ({
    getStationFeeds: (...args: unknown[]) => mockGetStationFeeds(...args),
}));
vi.mock('$lib/server/services/livetv/station.service.js', () => ({
    resolveStation: async (stationId: string) => ({
        stationId,
        shownFeedId: '550e8400-e29b-41d4-a716-446655440000',
        groupId: null,
    }),
}));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: (...args: unknown[]) => mockCanStream(...args),
}));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

import { mount } from '$lib/server/api/mount.js';
import { def } from '../../stations/[stationId]/feeds.js';

const CHANNEL = '550e8400-e29b-41d4-a716-446655440000';
const GROUP = '6f1c2d3e-0000-4000-8000-000000000001';
const sql = { tag: 'sql' };

function event(opts: { hasLiveTvPermission?: boolean; id?: string } = {}): RequestEvent {
    const id = opts.id ?? GROUP;
    const url = `http://localhost/api/livetv/stations/${id}/feeds`;
    return {
        url: new URL(url),
        request: new Request(url),
        params: { stationId: id },
        route: { id: '/api/livetv/stations/[stationId]/feeds' as never },
        locals: {
            user: {
                userId: toUserId('00000000-0000-0000-0000-000000000001'),
                username: 'alice',
                groups: '',
                userGroups: [],
                hasWatchPermission: true,
                hasLiveTvPermission: opts.hasLiveTvPermission ?? true,
                hasRequestPermission: false,
                ownerIsAdmin: false,
                isModerator: false,
                maxAgeRating: null,
                isAgeRestricted: false,
                liveTvPriority: 'low',
            },
        },
        cookies: { get: vi.fn(), set: vi.fn() } as unknown as RequestEvent['cookies'],
        fetch: vi.fn(),
        getClientAddress: () => '127.0.0.1',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

function row(overrides: Partial<StationFeedRow>): StationFeedRow {
    return {
        id: crypto.randomUUID(),
        name: 'Station FHD',
        raw_name: 'Station FHD',
        quality_tier: 'fhd',
        is_visible: true,
        is_primary: false,
        is_shown: false,
        backup_group_id: GROUP,
        ...overrides,
    };
}

const { GET } = mount(def, { surface: 'internal' });

describe('GET /livetv/stations/{id}/feeds', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockConfig.LIVETV_VIEWER_FEED_CHOICE = true;
        mockConfig.LIVETV_SOURCE = 'standalone';
        mockGetSql.mockResolvedValue(sql);
        mockCanStream.mockResolvedValue(true);
    });

    it('lists the feeds, the default first, with degraded and hidden feeds marked', async () => {
        const primary = row({ name: 'Station FHD+', is_primary: true });
        const shown = row({ name: 'Station HD', quality_tier: 'hd', is_shown: true });
        const mobile = row({
            name: 'Station (Mobil)',
            raw_name: 'Station (Mobil)',
            quality_tier: 'sd',
            is_visible: false,
        });
        const odd = row({ name: 'Station ?', quality_tier: 'weird' });
        mockGetStationFeeds.mockResolvedValue([primary, shown, mobile, odd]);

        const res = await GET!(event());
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.stationId).toBe(GROUP);
        expect(body.backupGroupId).toBeUndefined();
        expect(body.feeds.map((f: { id: string }) => f.id)).toEqual([
            shown.id,
            primary.id,
            mobile.id,
            odd.id,
        ]);
        expect(body.feeds[0]).toEqual({
            id: shown.id,
            name: 'Station HD',
            qualityTier: 'hd',
            isDegraded: false,
            isPrimary: false,
            isVisible: true,
            isDefault: true,
        });
        expect(body.feeds[2]).toMatchObject({ isDegraded: true, isVisible: false });
        expect(body.feeds[3].qualityTier).toBeUndefined();
        expect(mockCanStream).toHaveBeenCalledWith(expect.anything(), CHANNEL);
        expect(mockGetStationFeeds).toHaveBeenCalledWith(sql, CHANNEL);
    });

    it('returns a channel without a backup group as its own default feed', async () => {
        mockGetStationFeeds.mockResolvedValue([row({ id: CHANNEL, backup_group_id: null })]);
        const body = await (await GET!(event({ id: CHANNEL }))).json();
        expect(body.stationId).toBe(CHANNEL);
        expect(body.backupGroupId).toBeUndefined();
        expect(body.feeds).toEqual([expect.objectContaining({ id: CHANNEL, isDefault: true })]);
    });

    it('refuses while feed choice is turned off, before touching the database', async () => {
        mockConfig.LIVETV_VIEWER_FEED_CHOICE = false;
        const res = await GET!(event());
        expect(res.status).toBe(403);
        expect(mockCanStream).not.toHaveBeenCalled();
        expect(mockGetStationFeeds).not.toHaveBeenCalled();
    });

    it('refuses outside the standalone provider (no backup groups there)', async () => {
        mockConfig.LIVETV_SOURCE = 'disabled';
        expect((await GET!(event())).status).toBe(403);
        expect(mockGetStationFeeds).not.toHaveBeenCalled();
    });

    it('refuses a user without Live TV permission', async () => {
        const res = await GET!(event({ hasLiveTvPermission: false }));
        expect(res.status).toBe(404);
        expect(mockGetStationFeeds).not.toHaveBeenCalled();
    });

    it('answers 404 for a channel the viewer may not stream, without listing its feeds', async () => {
        mockCanStream.mockResolvedValue(false);
        const res = await GET!(event());
        expect(res.status).toBe(404);
        expect(mockGetStationFeeds).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown channel', async () => {
        mockGetStationFeeds.mockResolvedValue([]);
        expect((await GET!(event())).status).toBe(404);
    });

    it('rejects a non-UUID id', async () => {
        expect((await GET!(event({ id: 'nope' }))).status).toBe(422);
    });
});
