// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for the LiveTV endpoint defs.
 *
 * These tests verify auth, structural properties, and key response contracts
 * of the defs — NOT full proxy/DB behaviour (that lives in integration tests
 * under tests/integration/).
 *
 * Key properties under test:
 *   - Feature flag gate: `FEATURE_LIVETV=false` → 404 not_found
 *   - Unauthenticated → 401 unauthorized
 *   - No hasLiveTvPermission → 404 not_found
 *   - channels GET: paginate() envelope, logoUrl rewrite
 *   - keepalive POST: 204 success, 410 gone on kicked, 404 on expired session
 *   - leave POST/DELETE: 204 idempotent
 *   - stream GET: 503 stream_limit on stream limit, 502 on stream failure, streamUrl rewrite
 */

import { channelImageSet } from '$lib/server/services/image-descriptor/resources.js';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import { config } from '$lib/server/config.js';
import { toUserId } from '$lib/shared/user-id.js';

const deviceMetadata = vi.hoisted(() => ({ id: vi.fn(), device: vi.fn() }));
vi.mock('$lib/server/database/queries/user-devices.queries.js', () => ({
    getDeviceIdForSession: deviceMetadata.id,
    getUserDeviceByDeviceId: deviceMetadata.device,
}));

// ── Hoisted mocks (must be declared BEFORE vi.mock calls) ────────────────────

const { mockGetChannels, mockGetCategories, mockGetStreamInfo, mockSearchPrograms } = vi.hoisted(
    () => ({
        mockSearchPrograms: vi.fn(),
        mockGetChannels: vi.fn(),
        mockGetCategories: vi.fn(),
        mockGetStreamInfo: vi.fn(),
    }),
);

const { mockSessionService } = vi.hoisted(() => ({
    mockSessionService: {
        startPlaybackSession: vi
            .fn()
            .mockResolvedValue({ sessionId: '550e8400-e29b-41d4-a716-446655440001' }),
        getPlaybackSession: vi.fn().mockResolvedValue({
            sessionId: '550e8400-e29b-41d4-a716-446655440000',
            stationId: '550e8400-e29b-41d4-a716-446655440000',
            feedId: '550e8400-e29b-41d4-a716-446655440000',
            viewerKey: 'testuser:test:device',
            username: 'testuser',
            sourceId: '550e8400-e29b-41d4-a716-446655440000',
            state: 'active',
        }),
        endPlaybackSession: vi.fn().mockResolvedValue(undefined),
        releasePlaybackSession: vi.fn().mockResolvedValue(true),
        refreshPlaybackSession: vi.fn().mockResolvedValue(undefined),
        registerSession: vi.fn().mockResolvedValue(undefined),
        refreshSession: vi.fn().mockResolvedValue(true),
        removeSession: vi.fn().mockResolvedValue(undefined),
        removeSessionIfChannel: vi.fn().mockResolvedValue(true),
        getSession: vi.fn().mockResolvedValue(null),
        endViewerPlaybackSession: vi.fn().mockResolvedValue(undefined),
        getSourceViewers: vi.fn().mockResolvedValue([]),
        markKicked: vi.fn().mockResolvedValue(undefined),
        checkKicked: vi.fn().mockResolvedValue({ kicked: false }),
        consumeKicked: vi.fn().mockResolvedValue({ kicked: false }),
        clearKicked: vi.fn().mockResolvedValue(undefined),
    },
}));

const { mockProxyClient } = vi.hoisted(() => ({
    mockProxyClient: {
        heartbeat: vi.fn().mockResolvedValue({ success: true }),
        leaveChannel: vi.fn().mockResolvedValue(undefined),
    },
}));

const { mockPriorityService } = vi.hoisted(() => ({
    mockPriorityService: {
        checkAndEnforcePriority: vi.fn().mockResolvedValue({ allowed: false }),
        confirmEviction: vi.fn().mockResolvedValue(undefined),
    },
}));

vi.mock('$lib/server/middleware/media-access', () => ({ checkMediaAccess: vi.fn() }));
vi.mock('$lib/server/auth/resolve-token-user-access', () => ({ resolveTokenUserAccess: vi.fn() }));
const mintGrant = vi.hoisted(() => vi.fn());
vi.mock('$lib/server/services/playback-grant.js', async (original) => ({
    ...(await original<typeof import('$lib/server/services/playback-grant.js')>()),
    mintPlaybackGrant: mintGrant,
}));
beforeEach(() => {
    mintGrant.mockReset().mockImplementation(async (params) => ({
        id: '550e8400-e29b-41d4-a716-446655440099',
        token: 'stream_live_secret',
        param: 'grant',
        mediaId: params.mediaId,
        kind: params.kind,
        playbackSessionId: params.playbackSessionId,
        expiresAt: new Date('2026-10-18T00:00:00Z'),
        renewAfter: new Date('2026-10-17T23:55:00Z'),
        renewHref: `/api${params.surface === 'v1' ? '/v1' : ''}/playback/grants/grant-id/renew`,
        ipPinned: true,
    }));
});

// ── Module mocks ─────────────────────────────────────────────────────────────

vi.mock('$lib/server/services/livetv/availability.service.js', () => ({
    getLiveTvAvailability: vi.fn().mockResolvedValue({
        observedAt: new Date().toISOString(),
        evidenceUnavailable: false,
        sources: [],
        channels: {},
        suppressedChannelIds: [],
    }),
}));
vi.mock('$lib/server/config.js', () => ({
    config: {
        FEATURE_LIVETV: true,
        LIVETV_ADAPTIVE_LADDER_ENABLED: true,
        LIVETV_DEFAULT_QUALITY: 'server',
        LIVETV_ADAPTIVE_INCLUDE_ORIGINAL: false,
        LIVETV_CAP_FALLBACK: 'refuse',
        LIVETV_SHOW_ACTIVE_STREAMS: false,
    },
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

vi.mock('$lib/server/tasks/api-auth.js', async (importOriginal) => {
    const actual = await importOriginal<typeof import('$lib/server/tasks/api-auth.js')>();
    return { ...actual };
});

vi.mock('$lib/server/oauth/pat.service.js', () => ({
    getPatService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/oauth/service-token.service.js', () => ({
    getServiceTokenService: () => ({ validate: vi.fn().mockResolvedValue(null) }),
}));
vi.mock('$lib/server/auth.js', () => ({
    isUserAdmin: () => false,
}));
vi.mock('$lib/server/cache/valkey.js', () => ({
    getCoordinationClient: () => ({}),
    acquireLock: vi.fn().mockResolvedValue('lock'),
    releaseLock: vi.fn().mockResolvedValue(true),
    connectValkey: vi.fn().mockResolvedValue(true),
    isValkeyReady: vi.fn().mockReturnValue(true),
    setEx: vi.fn().mockResolvedValue(true),
    cacheGet: vi.fn().mockResolvedValue(null),
    getValkeyClient: vi.fn().mockReturnValue(null),
}));
vi.mock('$lib/server/database/queries/livetv-channels.queries.js', async (original) => ({
    ...(await original<typeof import('$lib/server/database/queries/livetv-channels.queries.js')>()),
    recordChannelWatch: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('$lib/server/database/connection.js', () => ({
    getDb: vi.fn().mockReturnValue(null),
}));
vi.mock('$lib/server/oauth/jellyfin-token.service.js', () => ({
    getJellyfinTokenService: vi.fn().mockReturnValue({
        getActiveTokensForUser: vi.fn().mockResolvedValue([]),
        revoke: vi.fn().mockResolvedValue(false),
    }),
}));
vi.mock('$lib/server/database/queries/oauth-refresh-tokens.queries.js', () => ({
    getActiveRefreshTokens: vi.fn().mockResolvedValue([]),
    revokeRefreshToken: vi.fn().mockResolvedValue(0),
}));

// ── Service mocks (livetv-specific) ──────────────────────────────────────────

const { mockGetChannel, mockGetGuidePrograms, mockGetPrograms } = vi.hoisted(() => ({
    mockGetChannel: vi.fn(),
    mockGetGuidePrograms: vi.fn(),
    mockGetPrograms: vi.fn(),
}));

vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({
        getChannels: mockGetChannels,
        getCategories: mockGetCategories,
        getChannel: mockGetChannel,
        getStreamInfo: mockGetStreamInfo,
        getGuidePrograms: mockGetGuidePrograms,
        getPrograms: mockGetPrograms,
        searchPrograms: mockSearchPrograms,
    }),
}));

const { mockHideOffline } = vi.hoisted(() => ({
    mockHideOffline: vi.fn(async (channels: unknown[]) => channels),
}));
vi.mock('$lib/server/services/livetv/channel-health.service.js', async (original) => ({
    ...(await original<typeof import('$lib/server/services/livetv/channel-health.service.js')>()),
    hideOfflineStations: (channels: unknown[]) => mockHideOffline(channels),
}));

const { mockCanStream, mockCanRead, mockMapFeeds } = vi.hoisted(() => ({
    mockCanStream: vi.fn(),
    mockMapFeeds: vi.fn(),
    mockCanRead: vi.fn(),
}));
vi.mock('$lib/server/services/livetv/station.service.js', async (original) => ({
    ...(await original<typeof import('$lib/server/services/livetv/station.service.js')>()),
    readStationSchedules: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, []]))),
    readStationNowNext: vi.fn(async () => pickNowNext(await mockGetPrograms(), Date.now())),
    readStationAirings: vi.fn(async (ids: string[]) => {
        const programs = await mockGetGuidePrograms();
        return new Map(ids.map((id) => [id, programs[id] ?? []]));
    }),
    mapFeedStations: mockMapFeeds,
    resolveStation: async (stationId: string) => ({
        stationId,
        shownFeedId: stationId,
        groupId: null,
    }),
}));
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: mockCanStream,
    canReadLiveTvChannelStream: mockCanRead,
}));

vi.mock('$lib/server/services/livetv/livetv-session.service.js', () => ({
    getLiveTvSessionService: () => mockSessionService,
}));

vi.mock('$lib/server/services/livetv/stream-proxy-client.js', () => ({
    getStreamProxyClient: () => mockProxyClient,
}));

vi.mock('$lib/server/services/livetv/livetv-priority.service.js', () => ({
    getLiveTvPriorityService: () => mockPriorityService,
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import { getDb } from '$lib/server/database/connection.js';
import { recordChannelWatch } from '$lib/server/database/queries/livetv-channels.queries.js';
import { mount } from '$lib/server/api/mount.js';
import { def as availabilityDef } from '../availability.js';
import { def as channelsDef } from '../stations/index.js';
import { def as channelDef } from '../stations/[stationId].js';
import { pickNowNext } from '$lib/shared/livetv-now-next.js';
import { def as guideDef } from '../guide.js';
import { def as programSearchDef } from '../programs/search.js';
import { def as stationProgramsDef } from '../stations/[stationId]/programs.js';
import { def as currentProgramDef } from '../stations/[stationId]/current-program.js';
import { readStationSchedules } from '$lib/server/services/livetv/station.service.js';
import { def as keepaliveDef } from '../playback-sessions/[playbackSessionId]/keepalive.js';
import { def as leaveDef } from '../playback-sessions/[playbackSessionId]/leave.js';
import { def as sessionDef } from '../playback-sessions/[playbackSessionId].js';
import { def as streamDef } from '../playback-sessions/index.js';
import {
    LiveTvFailureError,
    StreamLimitError,
    StreamFailureError,
} from '$lib/server/services/livetv/standalone-livetv-provider.js';

// ── Test helpers ──────────────────────────────────────────────────────────────

const VALID_CHANNEL_UUID = '550e8400-e29b-41d4-a716-446655440000';

function makeUser(opts: { hasLiveTvPermission?: boolean; priority?: 'high' | 'low' } = {}) {
    return {
        userId: toUserId('00000000-0000-0000-0000-000000000001'),
        username: 'testuser',
        groups: '',
        userGroups: [] as string[],
        hasWatchPermission: true,
        hasLiveTvPermission: opts.hasLiveTvPermission ?? true,
        hasRequestPermission: false,
        isAdmin: false,
        isModerator: false,
        maxAgeRating: null as null | number,
        isAgeRestricted: false,
        liveTvPriority: (opts.priority ?? 'low') as 'high' | 'low',
    };
}

function makeEvent(
    opts: {
        authed?: boolean;
        hasLiveTvPermission?: boolean;
        priority?: 'high' | 'low';
        params?: Record<string, string>;
        method?: string;
        url?: string;
    } = {},
): RequestEvent {
    const user =
        opts.authed !== false
            ? makeUser({
                  hasLiveTvPermission: opts.hasLiveTvPermission ?? true,
                  priority: opts.priority,
              })
            : null;

    return {
        url: new URL(opts.url ?? 'http://localhost/api/v1/livetv/stations'),
        request: new Request(opts.url ?? 'http://localhost/api/v1/livetv/stations', {
            method: opts.method ?? 'GET',
        }),
        params: { ...opts.params, playbackSessionId: opts.params?.id },
        route: { id: '/api/v1/livetv/stations' as const },
        locals: {
            user,
            liveTvCredentialId: 'test:device',
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

function makeStartEvent(opts: Parameters<typeof makeEvent>[0] = {}): RequestEvent {
    const event = makeEvent(opts);
    event.url = new URL(`http://localhost/api/v1/livetv/playback-sessions${event.url.search}`);
    const query = Object.fromEntries(event.url.searchParams);
    event.request = new Request(event.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
            stationId: opts.params?.id ?? VALID_CHANNEL_UUID,
            ...query,
            ...(query.maxBitrateBps ? { maxBitrateBps: Number(query.maxBitrateBps) } : {}),
        }),
    });
    return event;
}

// These MUST mirror the real mounts in src/routes — a fixture that drifts from
// the route file is how the v1 channel-logo 404 shipped unnoticed (the
// '/api/v1/image/*' proxy was deleted, the test was patched to '/api/image',
// but the route kept passing '/api/v1/image').
//   src/routes/api/v1/livetv/channels/+server.ts → imageBase: '/api/v1/image'
//   src/routes/api/livetv/channels/+server.ts    → imageBase: '/api/image'
const CTX_V1 = { surface: 'v1' as const };
const CTX_INTERNAL = { surface: 'internal' as const };

async function parseJson(res: Response) {
    return res.clone().json() as Promise<Record<string, unknown>>;
}

// ── channels/ (GET) ───────────────────────────────────────────────────────────

describe('defs/livetv/stations (GET)', () => {
    const CATEGORY_UUID = '660e8400-e29b-41d4-a716-446655440111';
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetChannels.mockResolvedValue([
            {
                id: VALID_CHANNEL_UUID,
                name: 'Channel 1',
                sortOrder: 0,
                isVisible: true,
                categoryId: CATEGORY_UUID,
                category: 'Free TV',
                // Real shape emitted by standalone-livetv-provider's proxyLogoUrl()
                // → getCatalogPosterUrl(channelId, { size: 'thumb' }).
                images: channelImageSet('internal', VALID_CHANNEL_UUID, 'https://logo/channel.png'),
                // Real provider emits `currentProgram: undefined` (omitted on the
                // wire) and no `nextProgram` field — mirror that so the fixture
                // matches LiveTvChannelSchema.
                currentProgram: undefined,
            },
        ]);
        mockGetCategories.mockResolvedValue([
            { id: CATEGORY_UUID, name: 'Free TV', sortOrder: 5, isVisible: true },
        ]);
        mockSessionService.checkKicked.mockResolvedValue({ kicked: false });
    });

    it('exports GET only', () => {
        const { GET, POST, PUT, DELETE, PATCH } = mount(channelsDef, CTX_V1);
        expect(typeof GET).toBe('function');
        expect(POST).toBeUndefined();
        expect(PUT).toBeUndefined();
        expect(DELETE).toBeUndefined();
        expect(PATCH).toBeUndefined();
    });

    it('returns 401 when unauthenticated', async () => {
        const { GET } = mount(channelsDef, CTX_V1);
        const event = makeEvent({ authed: false });
        const res = await GET!(event);
        expect(res.status).toBe(401);
        const body = await parseJson(res);
        expect(body.code).toBe('unauthorized');
    });

    it('hides Live TV when user lacks permission', async () => {
        const { GET } = mount(channelsDef, CTX_V1);
        const event = makeEvent({ hasLiveTvPermission: false });
        const res = await GET!(event);
        expect(res.status).toBe(404);
        const body = await parseJson(res);
        expect(body.code).toBe('not_found');
    });

    it('returns paginate envelope with items', async () => {
        const { GET } = mount(channelsDef, CTX_V1);
        const event = makeEvent();
        const res = await GET!(event);
        expect(res.status).toBe(200);
        const body = await parseJson(res);
        expect(Array.isArray(body.items)).toBe(true);
        expect(body.page).toBeDefined();
        const items = body.items as Array<Record<string, unknown>>;
        expect(items).toHaveLength(1);
    });

    it('still returns stations with null now/next when the schedule read rejects', async () => {
        vi.mocked(readStationSchedules).mockRejectedValueOnce(new Error('schedule unavailable'));
        const { GET } = mount(channelsDef, CTX_V1);
        const response = await GET!(makeEvent());
        expect(response.status).toBe(200);
        expect(readStationSchedules).toHaveBeenCalledWith([VALID_CHANNEL_UUID]);
        expect(await parseJson(response)).toMatchObject({
            items: [{ id: VALID_CHANNEL_UUID, nowNext: { current: null, next: null } }],
            page: { hasMore: false },
        });
    });

    it('emits a v1-servable logoUrl (entity-image path, not the BFF-only /catalog/ path)', async () => {
        const { GET } = mount(channelsDef, CTX_V1);
        const res = await GET!(makeEvent());
        const body = await parseJson(res);
        const items = body.items as Array<Record<string, unknown>>;
        // `/api/v1/image/**` has NO route (deleted in 6dee55dc5). The only v1 path
        // that serves a catalog image is the entity route
        // /api/v1/media/{id}/images/{role}, which is auth:'public' so a Bearer PAT
        // (or no cookie at all) works — that is what native clients need.
        expect(items[0].images).toEqual(
            channelImageSet('v1', VALID_CHANNEL_UUID, 'https://logo/channel.png'),
        );
        expect(items[0]).not.toHaveProperty('logoUrl');
    });

    it('emits the internal entity-image path on the BFF surface', async () => {
        const { GET } = mount(channelsDef, CTX_INTERNAL);
        const event = makeEvent();
        const res = await GET!(event);
        const body = await parseJson(res);
        const items = body.items as Array<Record<string, unknown>>;
        expect(items[0].images).toEqual(
            channelImageSet('internal', VALID_CHANNEL_UUID, 'https://logo/channel.png'),
        );
    });

    it('leaves logoUrl undefined when the channel has no logo', async () => {
        mockGetChannels.mockResolvedValueOnce([
            {
                id: VALID_CHANNEL_UUID,
                name: 'Channel 1',
                sortOrder: 0,
                isVisible: true,
                images: {},
                // Real provider emits `currentProgram: undefined` (omitted on the
                // wire) and no `nextProgram` field — mirror that so the fixture
                // matches LiveTvChannelSchema.
                currentProgram: undefined,
            },
        ]);
        const { GET } = mount(channelsDef, CTX_V1);
        const res = await GET!(makeEvent());
        const body = await parseJson(res);
        const items = body.items as Array<Record<string, unknown>>;
        expect(items[0].images).toEqual({});
    });

    it('annotates channels with a dense channelNumber and the category sortOrder', async () => {
        const { GET } = mount(channelsDef, CTX_V1);
        const res = await GET!(makeEvent());
        const body = await parseJson(res);
        const items = body.items as Array<Record<string, unknown>>;
        // Single channel → dense lineup position 1; categorySortOrder mirrors the
        // channel's category (Free TV, sortOrder 5).
        expect(items[0].channelNumber).toBe(1);
        expect(items[0].categorySortOrder).toBe(5);
    });

    it('passes the stored, stable channel numbers through instead of lineup positions', async () => {
        mockGetChannels.mockResolvedValueOnce([
            {
                id: VALID_CHANNEL_UUID,
                name: 'Channel 1',
                images: {},
                sortOrder: 0,
                isVisible: true,
                channelNumber: 42,
            },
            {
                id: crypto.randomUUID(),
                name: 'Channel 2',
                images: {},
                sortOrder: 1,
                isVisible: true,
                channelNumber: 7,
            },
        ]);
        const { GET } = mount(channelsDef, CTX_V1);
        const res = await GET!(makeEvent());
        const body = await parseJson(res);
        const items = body.items as Array<Record<string, unknown>>;
        expect(items.map((item) => item.channelNumber)).toEqual([42, 7]);
    });

    it('still returns channels (no lineup fields) when the category read fails', async () => {
        mockGetCategories.mockRejectedValueOnce(new Error('category cache down'));
        const { GET } = mount(channelsDef, CTX_V1);
        const res = await GET!(makeEvent());
        expect(res.status).toBe(200);
        const body = await parseJson(res);
        const items = body.items as Array<Record<string, unknown>>;
        expect(items).toHaveLength(1);
        // Degraded: still numbered flat (uncategorized), but no category order.
        expect(items[0].channelNumber).toBe(1);
        expect(items[0].categorySortOrder).toBeUndefined();
    });

    it('returns 503 when provider throws', async () => {
        mockGetChannels.mockRejectedValueOnce(new Error('provider down'));
        const { GET } = mount(channelsDef, CTX_V1);
        const res = await GET!(makeEvent());
        expect(res.status).toBe(503);
        const body = await parseJson(res);
        expect(body.code).toBe('dependency_unavailable');
    });
});

// ── channels/{id} (GET) ──────────────────────────────────────────────────────

function program(id: string, start: string, end: string, title = `Show ${id}`) {
    return {
        id,
        stationId: VALID_CHANNEL_UUID,
        title,
        startTime: start,
        endTime: end,
    };
}

describe('defs/livetv/channels/[id] (GET)', () => {
    const NOW = new Date('2026-03-04T20:10:00Z');

    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(NOW);
        mockCanStream.mockResolvedValue(true);
        mockGetChannel.mockResolvedValue({
            id: VALID_CHANNEL_UUID,
            name: 'Harbour One',
            images: {},
            sortOrder: 0,
            isVisible: true,
            currentProgram: undefined,
        });
        mockGetPrograms.mockResolvedValue([
            program('p1', '2026-03-04T19:30:00Z', '2026-03-04T20:30:00Z', 'Evening Tide'),
            program('p2', '2026-03-04T20:30:00Z', '2026-03-04T21:15:00Z', 'Lighthouse Stories'),
            program('p3', '2026-03-04T21:15:00Z', '2026-03-04T22:00:00Z'),
        ]);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('returns the current and next programme from the guide', async () => {
        const { GET } = mount(channelDef, CTX_V1);
        const res = await GET!(makeEvent({ params: { stationId: VALID_CHANNEL_UUID } }));
        expect(res.status).toBe(200);
        const body = await parseJson(res);
        expect((body.nowNext as { current: { title: string } }).current.title).toBe('Evening Tide');
        expect((body.nowNext as { next: { title: string } }).next.title).toBe('Lighthouse Stories');
        expect(body).not.toHaveProperty('currentProgram');
        expect(body).not.toHaveProperty('nextProgram');
    });

    it('still returns the channel when the guide read fails', async () => {
        mockGetPrograms.mockRejectedValue(new Error('guide down'));
        const { GET } = mount(channelDef, CTX_V1);
        const res = await GET!(makeEvent({ params: { stationId: VALID_CHANNEL_UUID } }));
        expect(res.status).toBe(200);
        const body = await parseJson(res);
        expect(body.name).toBe('Harbour One');
        expect(body.nowNext).toEqual({ current: null, next: null });
    });

    it('returns 404 for a channel the viewer may not open, without reading the guide', async () => {
        mockCanStream.mockResolvedValue(false);
        const { GET } = mount(channelDef, CTX_V1);
        const res = await GET!(makeEvent({ params: { stationId: VALID_CHANNEL_UUID } }));
        expect(res.status).toBe(404);
        expect(mockGetPrograms).not.toHaveBeenCalled();
    });
});

describe('pickNowNext', () => {
    const at = new Date('2026-03-04T20:10:00Z');

    it('picks the programme after the current one, skipping nothing in between', () => {
        const { current, next } = pickNowNext(
            [
                program('a', '2026-03-04T20:00:00Z', '2026-03-04T20:30:00Z'),
                program('b', '2026-03-04T20:30:00Z', '2026-03-04T21:00:00Z'),
            ],
            at.getTime(),
        );
        expect(current?.id).toBe('a');
        expect(next?.id).toBe('b');
    });

    it('without a current programme, next is the first to start later (a guide gap)', () => {
        const { current, next } = pickNowNext(
            [program('c', '2026-03-04T20:45:00Z', '2026-03-04T21:30:00Z')],
            at.getTime(),
        );
        expect(current).toBeNull();
        expect(next?.id).toBe('c');
    });

    it('treats the end time as exclusive', () => {
        const { current, next } = pickNowNext(
            [
                program('d', '2026-03-04T19:40:00Z', '2026-03-04T20:10:00Z'),
                program('e', '2026-03-04T20:10:00Z', '2026-03-04T20:40:00Z'),
            ],
            at.getTime(),
        );
        expect(current?.id).toBe('e');
        expect(next).toBeNull();
    });
});

// ── channels/{id}/keepalive (POST) ────────────────────────────────────────────

describe('defs/livetv/playback-sessions/[playbackSessionId]/keepalive (POST)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockSessionService.checkKicked.mockResolvedValue({ kicked: false });
        mockSessionService.consumeKicked.mockResolvedValue({ kicked: false });
        mockProxyClient.heartbeat.mockResolvedValue({ success: true });
        mockCanRead.mockResolvedValue(true);
    });

    it('returns 404 and does not heartbeat a channel the viewer may not stream', async () => {
        mockCanRead.mockResolvedValue(false);
        const { POST } = mount(keepaliveDef, CTX_V1);
        const event = makeEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(404);
        expect(mockCanRead).toHaveBeenCalledWith(event.locals, VALID_CHANNEL_UUID);
        expect(mockProxyClient.heartbeat).not.toHaveBeenCalled();
        expect(mockSessionService.refreshSession).not.toHaveBeenCalled();
    });

    it('exports POST only', () => {
        const { POST, GET, DELETE } = mount(keepaliveDef, CTX_V1);
        expect(typeof POST).toBe('function');
        expect(GET).toBeUndefined();
        expect(DELETE).toBeUndefined();
    });

    it('returns 401 when unauthenticated', async () => {
        const { POST } = mount(keepaliveDef, CTX_V1);
        const event = makeEvent({ authed: false, params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(401);
    });

    it('hides Live TV when user lacks permission', async () => {
        const { POST } = mount(keepaliveDef, CTX_V1);
        const event = makeEvent({ hasLiveTvPermission: false, params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(404);
    });

    it('returns 422 when id is not a valid UUID', async () => {
        const { POST } = mount(keepaliveDef, CTX_V1);
        const event = makeEvent({ params: { id: 'not-a-uuid' } });
        const res = await POST!(event);
        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 204 on successful keepalive', async () => {
        const { POST } = mount(keepaliveDef, CTX_V1);
        const event = makeEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(204);
        expect(mockSessionService.refreshPlaybackSession).toHaveBeenCalledWith(
            expect.objectContaining({ viewerKey: 'testuser:test:device' }),
        );
    });

    it('returns 410 when viewer was kicked', async () => {
        mockSessionService.consumeKicked.mockResolvedValue({
            kicked: true,
            reason: 'priority_eviction',
        });
        const { POST } = mount(keepaliveDef, CTX_V1);
        const event = makeEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(410);
        const body = await parseJson(res);
        expect(body.code).toBe('gone');
        // The flag is taken atomically for this channel, so the client can try again
        expect(mockSessionService.consumeKicked).toHaveBeenCalledWith(
            'testuser:test:device',
            VALID_CHANNEL_UUID,
        );
    });

    it('returns 404 when proxy heartbeat returns unsuccessful', async () => {
        mockProxyClient.heartbeat.mockResolvedValue({ success: false });
        const { POST } = mount(keepaliveDef, CTX_V1);
        const event = makeEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(404);
        const body = await parseJson(res);
        expect(body.code).toBe('not_found');
    });

    it('returns 503 when proxy heartbeat throws a non-404 error', async () => {
        mockProxyClient.heartbeat.mockRejectedValueOnce(new Error('proxy down'));
        const { POST } = mount(keepaliveDef, CTX_V1);
        const event = makeEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(503);
        const body = await parseJson(res);
        expect(body.code).toBe('dependency_unavailable');
    });

    it('returns 404 when proxy heartbeat throws a Proxy 404 error', async () => {
        mockProxyClient.heartbeat.mockRejectedValueOnce(new Error('Proxy 404: viewer not found'));
        const { POST } = mount(keepaliveDef, CTX_V1);
        const event = makeEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(404);
        const body = await parseJson(res);
        expect(body.code).toBe('not_found');
    });
});

// ── channels/{id}/leave (POST + DELETE) ───────────────────────────────────────

describe('defs/livetv/playback-sessions/[playbackSessionId]/leave (POST + DELETE)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockProxyClient.leaveChannel.mockResolvedValue(undefined);
        mockSessionService.getSession.mockResolvedValue(null);
    });

    it('exports POST and DELETE', () => {
        const { POST, GET } = mount(leaveDef, CTX_V1);
        const { DELETE } = mount(sessionDef, CTX_V1);
        expect(typeof POST).toBe('function');
        expect(typeof DELETE).toBe('function');
        expect(GET).toBeUndefined();
    });

    it('POST returns 401 when unauthenticated', async () => {
        const { POST } = mount(leaveDef, CTX_V1);
        const event = makeEvent({
            authed: false,
            params: { id: VALID_CHANNEL_UUID },
            method: 'POST',
        });
        const res = await POST!(event);
        expect(res.status).toBe(401);
    });

    it('hides a playback session after Live TV permission is revoked', async () => {
        const { POST } = mount(leaveDef, CTX_V1);
        const event = makeEvent({
            hasLiveTvPermission: false,
            params: { playbackSessionId: VALID_CHANNEL_UUID },
            method: 'POST',
        });
        const res = await POST!(event);
        expect(res.status).toBe(404);
    });

    it('POST returns 422 for non-UUID id', async () => {
        const { POST } = mount(leaveDef, CTX_V1);
        const event = makeEvent({ params: { id: 'bad-id' }, method: 'POST' });
        const res = await POST!(event);
        expect(res.status).toBe(422);
    });

    it('POST returns 204 on successful leave', async () => {
        const { POST } = mount(leaveDef, CTX_V1);
        const event = makeEvent({ params: { id: VALID_CHANNEL_UUID }, method: 'POST' });
        const res = await POST!(event);
        expect(res.status).toBe(204);
        expect(mockProxyClient.leaveChannel).toHaveBeenCalledWith(
            VALID_CHANNEL_UUID,
            'testuser:test:device',
            expect.any(AbortSignal),
        );
    });

    it('DELETE returns 204 on successful leave', async () => {
        const { DELETE } = mount(sessionDef, CTX_V1);
        const event = makeEvent({ params: { id: VALID_CHANNEL_UUID }, method: 'DELETE' });
        const res = await DELETE!(event);
        expect(res.status).toBe(204);
    });

    it('uses stored sourceId from session when available', async () => {
        const storedSourceId = 'source-999';
        mockSessionService.getSession.mockResolvedValue({
            sourceId: storedSourceId,
            channelId: VALID_CHANNEL_UUID,
        });
        const { POST } = mount(leaveDef, CTX_V1);
        const event = makeEvent({ params: { id: VALID_CHANNEL_UUID }, method: 'POST' });
        await POST!(event);
        expect(mockSessionService.removeSessionIfChannel).toHaveBeenCalledWith(
            'testuser:test:device',
            storedSourceId,
            VALID_CHANNEL_UUID,
        );
    });

    it('falls back to channelId when session is not found', async () => {
        mockSessionService.getSession.mockResolvedValue(null);
        const { POST } = mount(leaveDef, CTX_V1);
        const event = makeEvent({ params: { id: VALID_CHANNEL_UUID }, method: 'POST' });
        await POST!(event);
        expect(mockSessionService.removeSessionIfChannel).toHaveBeenCalledWith(
            'testuser:test:device',
            VALID_CHANNEL_UUID,
            VALID_CHANNEL_UUID,
        );
    });
});

// ── channels/{id}/stream (GET) ────────────────────────────────────────────────

describe('defs/livetv/playback-sessions (POST)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockCanStream.mockResolvedValue(true);
        mockSessionService.checkKicked.mockResolvedValue({ kicked: false });
        mockGetStreamInfo.mockResolvedValue({
            streamUrl: '/api/livetv/channels/' + VALID_CHANNEL_UUID + '/stream/master.m3u8',
            sourceId: 'src-1',
            requiresProxy: true,
            maxStreams: 2,
            rungId: null,
            requestedMaxBitrateBps: null,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
            reason: null,
        });
    });

    it('records exactly one watch only for an accepted start', async () => {
        vi.mocked(getDb).mockReturnValue({} as NonNullable<ReturnType<typeof getDb>>);
        try {
            const { POST } = mount(streamDef, CTX_V1);
            expect((await POST!(makeStartEvent())).status).toBe(201);
            expect(recordChannelWatch).toHaveBeenCalledTimes(1);
            mockCanStream.mockResolvedValue(false);
            expect((await POST!(makeStartEvent())).status).toBe(404);
            expect(recordChannelWatch).toHaveBeenCalledTimes(1);
        } finally {
            vi.mocked(getDb).mockReturnValue(null);
        }
    });

    it('exports POST only', () => {
        const { POST, GET, PUT } = mount(streamDef, CTX_V1);
        expect(typeof POST).toBe('function');
        expect(GET).toBeUndefined();
        expect(PUT).toBeUndefined();
    });

    it('returns 401 when unauthenticated', async () => {
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ authed: false, params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(401);
    });

    it('hides Live TV when user lacks permission', async () => {
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({
            hasLiveTvPermission: false,
            params: { id: VALID_CHANNEL_UUID },
        });
        const res = await POST!(event);
        expect(res.status).toBe(404);
    });

    it('returns 422 for non-UUID channel id', async () => {
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ params: { id: 'not-a-uuid' } });
        const res = await POST!(event);
        expect(res.status).toBe(422);
        const body = await parseJson(res);
        expect(body.code).toBe('validation_failed');
    });

    it('returns 404 for a channel the viewer may not stream, before any join', async () => {
        mockCanStream.mockResolvedValue(false);
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(404);
        expect(mockCanStream).toHaveBeenCalledWith(event.locals, VALID_CHANNEL_UUID);
        expect(mockGetStreamInfo).not.toHaveBeenCalled();
    });

    it('a refused high-priority viewer evicts nobody', async () => {
        mockCanStream.mockResolvedValue(false);
        const { POST } = mount(streamDef, CTX_V1);
        const res = await POST!(
            makeStartEvent({ priority: 'high', params: { id: VALID_CHANNEL_UUID } }),
        );
        expect(res.status).toBe(404);
        expect(mockPriorityService.checkAndEnforcePriority).not.toHaveBeenCalled();
        expect(mockSessionService.registerSession).not.toHaveBeenCalled();
    });

    it('returns 410 when viewer was kicked', async () => {
        mockSessionService.checkKicked.mockResolvedValue({ kicked: true, reason: 'high_priority' });
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(410);
        const body = await parseJson(res);
        expect(body.code).toBe('gone');
    });

    it.each(['internal', 'v1'] as const)(
        '%s start keepalive href reaches the owned session',
        async (surface) => {
            const response = await mount(streamDef, { surface }).POST!(
                makeStartEvent({ params: { id: VALID_CHANNEL_UUID } }),
            );
            expect(response.status).toBe(201);
            const body = await response.json();
            const href = new URL(body.reporting.href, 'http://localhost');
            const sessionId = href.pathname.split('/').at(-2)!;
            expect(sessionId).toBe(body.playbackSessionId);
            mockSessionService.getPlaybackSession.mockResolvedValueOnce({
                sessionId,
                stationId: VALID_CHANNEL_UUID,
                feedId: VALID_CHANNEL_UUID,
                viewerKey: 'testuser:test:device',
                username: 'testuser',
                sourceId: VALID_CHANNEL_UUID,
                state: 'active',
            });
            const keepalive = await mount(keepaliveDef, { surface }).POST!(
                makeEvent({ method: 'POST', url: href.toString(), params: { id: sessionId } }),
            );
            expect(keepalive.status).toBe(204);
            expect(mockSessionService.refreshPlaybackSession).toHaveBeenCalledWith(
                expect.objectContaining({ sessionId }),
            );
        },
    );

    it('returns 200 with delivery.url rewritten to v1 prefix', async () => {
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(201);
        const body = await parseJson(res);
        const delivery = body.delivery as { url: string };
        expect(typeof delivery.url).toBe('string');
        expect(delivery.url.startsWith('/api/v1/livetv/')).toBe(true);
        expect((body.reporting as { href: string }).href).toBe(
            `/api/v1/livetv/playback-sessions/${body.playbackSessionId}/keepalive`,
        );
        const href = new URL(delivery.url, 'http://localhost');
        expect(href.searchParams.get('grant')).toBe('stream_live_secret');
        expect(href.searchParams.get('PlaySessionId')).toBe(body.playbackSessionId);
        expect(body.grant).toMatchObject({
            token: 'stream_live_secret',
            param: 'grant',
            ipPinned: true,
        });
        expect(href.searchParams.has('api_key')).toBe(false);
        expect(href.searchParams.has('stream_token')).toBe(false);
        expect(mintGrant).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'live',
                mediaId: VALID_CHANNEL_UUID,
                clientIp: '127.0.0.1',
                surface: 'v1',
            }),
        );
    });

    it('releases the admitted viewer and ends the session when grant minting fails', async () => {
        mintGrant.mockRejectedValueOnce(new Error('Grant storage unavailable'));
        mockSessionService.removeSessionIfChannel.mockRejectedValueOnce(
            new Error('Presence store unavailable'),
        );
        const { POST } = mount(streamDef, CTX_V1);
        const response = await POST!(makeStartEvent({ params: { id: VALID_CHANNEL_UUID } }));
        expect(response.status).toBe(503);
        expect(mockProxyClient.leaveChannel).toHaveBeenCalledWith(
            VALID_CHANNEL_UUID,
            'testuser:test:device',
            expect.any(AbortSignal),
        );
        expect(mockSessionService.endViewerPlaybackSession).toHaveBeenCalledWith(
            'testuser:test:device',
            VALID_CHANNEL_UUID,
            'expired',
        );
        expect(mockSessionService.removeSessionIfChannel).toHaveBeenCalled();
    });

    it('mints with the request credential context and never emits the account token', async () => {
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID } });
        event.locals.authMethod = 'pat';
        event.locals.accessToken = 'account-secret';
        event.locals.deviceSessionId = 'device-session';
        event.locals.principal = { isAdmin: true } as App.Locals['principal'];
        event.request = new Request(event.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stationId: VALID_CHANNEL_UUID, castTarget: true }),
        });
        const response = await POST!(event);
        expect(response.status).toBe(201);
        expect(await response.text()).not.toContain('account-secret');
        expect(mintGrant).toHaveBeenCalledWith(
            expect.objectContaining({
                castTarget: true,
                deviceSessionId: 'device-session',
                mintedByAdmin: true,
                parentTokenHash: 'a9b0ce902e64512edfe3cc7c6e266779987e1b6183e5a503e807e64d9a970872',
            }),
        );
    });

    it('snaps maxBitrate down and returns the applied rung contract', async () => {
        mockGetStreamInfo.mockResolvedValueOnce({
            streamUrl: `/api/livetv/channels/${VALID_CHANNEL_UUID}/stream/r/540p2m/master.m3u8`,
            sourceId: 'src-1',
            requiresProxy: true,
            maxStreams: 2,
            rungId: '540p2m',
            requestedMaxBitrateBps: 3_000_000,
            appliedMaxBitrateBps: 2_000_000,
            appliedMaxHeight: 540,
            reason: null,
        });
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({
            params: { id: VALID_CHANNEL_UUID },
            url: `http://localhost/api/v1/livetv/channels/${VALID_CHANNEL_UUID}/stream?maxBitrateBps=3000000`,
        });

        const res = await POST!(event);
        expect(res.status).toBe(201);
        expect(mockGetStreamInfo).toHaveBeenCalledWith(
            VALID_CHANNEL_UUID,
            'testuser:test:device',
            {
                rung: {
                    id: '540p2m',
                    height: 540,
                    maxBitrate: 2_000_000,
                    codec: 'h264',
                },
                requestedMaxBitrate: 3_000_000,
                belowLadder: false,
                pinned: false,
                fallback: 'refuse',
            },
            undefined,
            undefined,
            { awaitReady: true, onFeedsSent: expect.any(Function) },
        );
        expect(await parseJson(res)).toMatchObject({
            delivery: {
                rungId: '540p2m',
                appliedMaxBitrateBps: 2_000_000,
                appliedMaxHeight: 540,
            },
        });
    });

    it.each(['0', '-1', 'not-a-number'])('rejects invalid maxBitrate=%s', async (value) => {
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({
            params: { id: VALID_CHANNEL_UUID },
            url: `http://localhost/api/v1/livetv/channels/${VALID_CHANNEL_UUID}/stream?maxBitrateBps=${value}`,
        });
        expect((await POST!(event)).status).toBe(422);
        expect(mockGetStreamInfo).not.toHaveBeenCalled();
    });

    it('returns 200 with delivery.url unchanged for internal surface', async () => {
        const { POST } = mount(streamDef, CTX_INTERNAL);
        const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(201);
        const body = await parseJson(res);
        const delivery = body.delivery as { url: string };
        expect(delivery.url.startsWith('/api/livetv/')).toBe(true);
        expect((body.reporting as { href: string }).href).toBe(
            `/api/livetv/playback-sessions/${body.playbackSessionId}/keepalive`,
        );
    });

    it('registers session after successful join', async () => {
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID } });
        await POST!(event);
        expect(mockSessionService.registerSession).toHaveBeenCalledWith(
            'testuser:test:device',
            'testuser',
            VALID_CHANNEL_UUID,
            'src-1',
            'low',
        );
    });

    it('returns 503 stream_limit on StreamLimitError', async () => {
        const limitErr = new StreamLimitError(2, [], VALID_CHANNEL_UUID);
        mockGetStreamInfo.mockRejectedValueOnce(limitErr);
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(503);
        const body = await parseJson(res);
        expect(body.code).toBe('stream_limit');
    });

    it('maps a legacy spawn_failed StreamFailureError to encoder_failed 500', async () => {
        const failErr = new StreamFailureError(
            'spawn_failed',
            VALID_CHANNEL_UUID,
            'stream init failed',
        );
        mockGetStreamInfo.mockRejectedValueOnce(failErr);
        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID } });
        const res = await POST!(event);
        expect(res.status).toBe(500);
        const body = await parseJson(res);
        expect(body.code).toBe('encoder_failed');
        expect(body).toMatchObject({ failure: { retryable: true } });
    });

    it('high priority viewer triggers eviction attempt on StreamLimitError', async () => {
        const limitErr = new StreamLimitError(2, [], VALID_CHANNEL_UUID);
        // First call throws StreamLimitError; eviction refused; propagates as 503 stream_limit
        mockGetStreamInfo.mockRejectedValueOnce(limitErr);
        mockPriorityService.checkAndEnforcePriority.mockResolvedValueOnce({ allowed: false });

        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID }, priority: 'high' });
        const res = await POST!(event);
        expect(res.status).toBe(503);
        expect(mockPriorityService.checkAndEnforcePriority).toHaveBeenCalled();
    });

    it('high priority viewer succeeds when eviction allows a slot', async () => {
        const limitErr = new StreamLimitError(2, [], VALID_CHANNEL_UUID);
        // First call raises StreamLimitError; eviction allowed; second call succeeds
        mockGetStreamInfo.mockRejectedValueOnce(limitErr).mockResolvedValueOnce({
            streamUrl: '/api/livetv/channels/' + VALID_CHANNEL_UUID + '/stream/master.m3u8',
            sourceId: 'src-2',
            requiresProxy: true,
            maxStreams: 2,
            rungId: null,
            requestedMaxBitrateBps: null,
            appliedMaxBitrateBps: null,
            appliedMaxHeight: null,
            reason: null,
        });
        mockPriorityService.checkAndEnforcePriority.mockResolvedValueOnce({ allowed: true });

        const { POST } = mount(streamDef, CTX_V1);
        const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID }, priority: 'high' });
        const res = await POST!(event);
        expect(res.status).toBe(201);
        expect(mockGetStreamInfo).toHaveBeenCalledTimes(2);
    });

    const joined = {
        streamUrl: '/api/livetv/channels/' + VALID_CHANNEL_UUID + '/stream/master.m3u8',
        sourceId: 'src-2',
        requiresProxy: true,
        maxStreams: 2,
        rungId: null,
        requestedMaxBitrateBps: null,
        appliedMaxBitrateBps: null,
        appliedMaxHeight: null,
        reason: null,
    };
    const evicted = [{ viewerKey: 'low:device:x', channelId: 'other-channel' }];

    it('flags the evicted viewers kicked only after the retry join succeeded', async () => {
        mockGetStreamInfo
            .mockRejectedValueOnce(new StreamLimitError(1, [], 'src-2'))
            .mockResolvedValueOnce(joined);
        mockPriorityService.checkAndEnforcePriority.mockResolvedValueOnce({
            allowed: true,
            evicted,
        });
        const { POST } = mount(streamDef, CTX_V1);
        const res = await POST!(
            makeStartEvent({ params: { id: VALID_CHANNEL_UUID }, priority: 'high' }),
        );
        expect(res.status).toBe(201);
        expect(mockPriorityService.confirmEviction).toHaveBeenCalledWith(evicted);
    });

    it('does not flag the evicted viewers kicked when the retry join fails', async () => {
        mockGetStreamInfo
            .mockRejectedValueOnce(new StreamLimitError(1, [], 'src-2'))
            .mockRejectedValueOnce(new StreamLimitError(1, [], 'src-2'));
        mockPriorityService.checkAndEnforcePriority.mockResolvedValueOnce({
            allowed: true,
            evicted,
        });
        const { POST } = mount(streamDef, CTX_V1);
        const res = await POST!(
            makeStartEvent({ params: { id: VALID_CHANNEL_UUID }, priority: 'high' }),
        );
        expect(res.status).toBe(503);
        expect(mockPriorityService.confirmEviction).not.toHaveBeenCalled();
    });

    it('answers a provider connection limit on the retry join as a typed 503 and evicts nobody', async () => {
        mockGetStreamInfo
            .mockRejectedValueOnce(new StreamLimitError(1, [], 'src-2'))
            .mockRejectedValueOnce(
                new LiveTvFailureError('provider_connection_limit', VALID_CHANNEL_UUID, 'x', {
                    retryable: true,
                    retryAfterMs: 30_000,
                }),
            );
        mockPriorityService.checkAndEnforcePriority.mockResolvedValueOnce({
            allowed: true,
            evicted,
        });
        const { POST } = mount(streamDef, CTX_V1);
        const res = await POST!(
            makeStartEvent({ params: { id: VALID_CHANNEL_UUID }, priority: 'high' }),
        );
        expect(res.status).toBe(503);
        expect(await res.json()).toMatchObject({
            code: 'provider_connection_limit',
            failure: { retryable: true },
            retryAfter: 30,
        });
        expect(mockPriorityService.confirmEviction).not.toHaveBeenCalled();
    });

    it('persists the owning user, stable device, client and fixed-quality output for the inventory', async () => {
        vi.mocked(getDb).mockReturnValue({} as NonNullable<ReturnType<typeof getDb>>);
        try {
            deviceMetadata.id.mockResolvedValueOnce('stable-device');
            deviceMetadata.device.mockResolvedValueOnce({
                custom_name: 'Living Room',
                reported_name: 'TV',
                client_id: 'lumastra-tvos',
            });
            mockGetStreamInfo.mockResolvedValueOnce({
                ...joined,
                rungId: '720p4m',
                appliedMaxHeight: 720,
                appliedMaxBitrateBps: 4000000,
            });
            const event = makeStartEvent({ params: { id: VALID_CHANNEL_UUID } });
            event.locals.deviceSessionId = 'oauth-session';
            event.request = new Request(event.request, {
                headers: { 'content-type': 'application/json', 'user-agent': 'Lumastra TV Test' },
            });
            const { POST } = mount(streamDef, CTX_V1);
            expect((await POST!(event)).status).toBe(201);
            expect(deviceMetadata.id).toHaveBeenCalledWith(
                expect.anything(),
                event.locals.user!.userId,
                'oauth-session',
            );
            expect(mockSessionService.startPlaybackSession).toHaveBeenCalledWith(
                expect.objectContaining({
                    userId: event.locals.user!.userId,
                    deviceId: 'stable-device',
                    deviceSessionId: 'oauth-session',
                    deviceName: 'Living Room',
                    clientName: 'lumastra-tvos',
                    userAgent: 'Lumastra TV Test',
                    rungId: '720p4m',
                    appliedMaxHeight: 720,
                    appliedMaxBitrateBps: 4000000,
                }),
            );
        } finally {
            vi.mocked(getDb).mockReturnValue(null);
        }
    });

    it('asks a normal start to wait for the first segment and stores the feeds it sent', async () => {
        const sentFeeds = [
            { id: VALID_CHANNEL_UUID, name: 'Primary' },
            { id: 'backup-feed', name: 'Backup' },
        ];
        mockGetStreamInfo.mockImplementationOnce(async (...args: unknown[]) => {
            (args[5] as { onFeedsSent?: (f: typeof sentFeeds) => void }).onFeedsSent?.(sentFeeds);
            return joined;
        });
        const { POST } = mount(streamDef, CTX_V1);
        const res = await POST!(makeStartEvent({ params: { id: VALID_CHANNEL_UUID } }));
        expect(res.status).toBe(201);
        expect(mockGetStreamInfo.mock.calls[0][5]).toMatchObject({ awaitReady: true });
        expect(mockSessionService.startPlaybackSession).toHaveBeenCalledWith(
            expect.objectContaining({ feeds: sentFeeds }),
        );
        // The stored feeds never reach the client.
        expect(JSON.stringify(await res.json())).not.toContain('backup-feed');
    });

    it('does not ask a hover preview to wait for the first segment', async () => {
        mockGetStreamInfo.mockResolvedValueOnce(joined);
        const { POST } = mount(streamDef, CTX_V1);
        const res = await POST!(
            makeStartEvent({
                params: { id: VALID_CHANNEL_UUID },
                url: 'http://localhost/api/v1/livetv/playback-sessions?purpose=preview',
            }),
        );
        expect(res.status).toBe(201);
        expect(mockGetStreamInfo.mock.calls[0][5]).toMatchObject({ awaitReady: false });
    });

    it('does not try to evict when the stream limit names no source', async () => {
        mockGetStreamInfo.mockRejectedValueOnce(new StreamLimitError(1, []));
        const { POST } = mount(streamDef, CTX_V1);
        const res = await POST!(
            makeStartEvent({ params: { id: VALID_CHANNEL_UUID }, priority: 'high' }),
        );
        expect(res.status).toBe(503);
        expect(mockPriorityService.checkAndEnforcePriority).not.toHaveBeenCalled();
    });
});

describe('Live TV availability endpoint', () => {
    it('permission gates both surfaces and never removes browsing channels', async () => {
        for (const ctx of [CTX_V1, CTX_INTERNAL]) {
            const { GET } = mount(availabilityDef, ctx);
            expect((await GET!(makeEvent({ hasLiveTvPermission: false }))).status).toBe(404);
        }
    });
    it('returns sanitized observed state with no provider secrets and no shared response cache', async () => {
        mockGetChannels.mockResolvedValue([
            { id: VALID_CHANNEL_UUID, name: 'Channel', sortOrder: 0, isVisible: true, images: {} },
        ]);
        const { GET } = mount(availabilityDef, CTX_V1);
        const response = await GET!(makeEvent());
        expect(response.status).toBe(200);
        const body = await parseJson(response);
        expect(body).toHaveProperty('sources');
        expect(JSON.stringify(body)).not.toContain('streamUrl');
        expect(response.headers.get('cache-control')).toContain('no-store');
    });
});

// ── guide (GET) stationIds scoping ──────────────────────────────────────────

describe('livetv guide — stationIds', () => {
    const from = '2026-10-15T10:00:00.000Z';
    const to = '2026-10-15T14:00:00.000Z';
    const prog = (title: string) => ({
        id: `p-${title}`,
        stationId: title.toLowerCase(),
        title,
        startTime: from,
        endTime: to,
    });

    beforeEach(() => {
        mockGetChannels.mockResolvedValue(
            ['a', 'b', 'c'].map((id) => ({
                id,
                name: id,
                images: {},
                sortOrder: 0,
                isVisible: true,
            })),
        );
        mockGetGuidePrograms.mockReset().mockResolvedValue({
            a: [prog('A')],
            b: [prog('B')],
            c: [prog('C')],
        });
    });

    async function get(query: string) {
        const { GET } = mount(guideDef, CTX_INTERNAL);
        const url = `http://localhost/api/livetv/guide?from=${from}&to=${to}${query}`;
        const res = await GET!(makeEvent({ url }));
        return { status: res.status, body: await parseJson(res) };
    }

    it('returns every channel without the parameter', async () => {
        const { status, body } = await get('');
        expect(status).toBe(200);
        expect((body.stations as { stationId: string }[]).map((s) => s.stationId).sort()).toEqual([
            'a',
            'b',
            'c',
        ]);
    });

    it('returns only the requested channels, deduplicated, ignoring unknown and prototype keys', async () => {
        const { status, body } = await get('&stationIds=b,a,b,zzz,__proto__,constructor');
        expect(status).toBe(200);
        expect((body.stations as { stationId: string }[]).map((s) => s.stationId).sort()).toEqual([
            'a',
            'b',
        ]);
        expect(body.unknownStationIds).toEqual(['zzz', '__proto__', 'constructor']);
    });

    it('treats a present but empty parameter as an empty scope, not the whole guide', async () => {
        const { body } = await get('&stationIds=');
        expect(body.stations).toEqual([]);
    });

    it('pages in lineup order and returns a terminal cursor', async () => {
        const first = await get('&limit=2');
        expect(first.status).toBe(200);
        expect(first.body.stations).toMatchObject([{ stationId: 'a' }, { stationId: 'b' }]);
        const page = first.body.page as { hasMore: boolean; nextCursor: string };
        expect(page.hasMore).toBe(true);
        expect(JSON.parse(Buffer.from(page.nextCursor, 'base64url').toString('utf8'))).toEqual({
            v: 1,
            stationId: 'b',
        });
        // An insertion before the cursor must not repeat the last station on page one.
        mockGetChannels.mockResolvedValue(
            ['inserted', 'a', 'b', 'c'].map((id) => ({
                id,
                name: id,
                images: {},
                sortOrder: 0,
                isVisible: true,
            })),
        );
        const second = await get(`&limit=2&cursor=${page.nextCursor}`);
        expect(second.status).toBe(200);
        expect(second.body.stations).toMatchObject([{ stationId: 'c' }]);
        expect(second.body.page).toEqual({ limit: 2, nextCursor: null, hasMore: false });
    });

    it('continues after the cursor when its station went offline between two pages', async () => {
        const first = await get('&limit=2');
        const page = first.body.page as { nextCursor: string };
        expect(first.body.stations).toMatchObject([{ stationId: 'a' }, { stationId: 'b' }]);
        // Station b is hidden (offline) before page two is requested.
        mockHideOffline.mockImplementationOnce(async (channels) =>
            (channels as { id: string }[]).filter((c) => c.id !== 'b'),
        );
        const second = await get(`&limit=2&cursor=${page.nextCursor}`);
        expect(second.status).toBe(200);
        expect(second.body.stations).toMatchObject([{ stationId: 'c' }]);
        expect(second.body.page).toEqual({ limit: 2, nextCursor: null, hasMore: false });
    });

    it('does not skip stations when the hidden cursor station sat in the middle', async () => {
        mockGetChannels.mockResolvedValue(
            ['a', 'b', 'c', 'd'].map((id) => ({
                id,
                name: id,
                images: {},
                sortOrder: 0,
                isVisible: true,
            })),
        );
        mockGetGuidePrograms.mockResolvedValue({});
        const cursor = Buffer.from(JSON.stringify({ v: 1, stationId: 'b' })).toString('base64url');
        mockHideOffline.mockImplementationOnce(async (channels) =>
            (channels as { id: string }[]).filter((c) => c.id !== 'b'),
        );
        const page = await get(`&limit=5&cursor=${cursor}`);
        expect(page.status).toBe(200);
        expect(
            (page.body.stations as { stationId: string }[]).map((station) => station.stationId),
        ).toEqual(['c', 'd']);
    });

    it('rejects a well-formed cursor for an unknown station', async () => {
        const cursor = Buffer.from(JSON.stringify({ v: 1, stationId: 'removed' })).toString(
            'base64url',
        );
        const { status, body } = await get(`&limit=2&cursor=${cursor}`);
        expect(status).toBe(422);
        expect(body).toMatchObject({ code: 'validation_failed' });
    });

    it('excludes hidden stations and lists duplicate feeds of a station only once', async () => {
        mockGetChannels.mockResolvedValue(
            [
                { id: 'feed-a', backupGroupId: 'a', isVisible: true },
                { id: 'hidden', isVisible: false },
                { id: 'feed-b', backupGroupId: 'a', isVisible: true },
                { id: 'c', isVisible: true },
            ].map((feed) => ({ name: feed.id, images: {}, sortOrder: 0, ...feed })),
        );
        const { status, body } = await get('&limit=2');
        expect(status).toBe(200);
        expect(
            (body.stations as { stationId: string }[]).map((station) => station.stationId),
        ).toEqual(['a', 'c']);
        expect(body.page).toEqual({ limit: 2, nextCursor: null, hasMore: false });
        const scoped = await get('&stationIds=hidden,a');
        expect(scoped.status).toBe(200);
        expect(scoped.body.stations).toMatchObject([{ stationId: 'a' }]);
        expect(scoped.body.stations).toHaveLength(1);
        expect(scoped.body.unknownStationIds).toEqual(['hidden']);
    });

    it('defaults to 50 stations on a large lineup', async () => {
        mockGetChannels.mockResolvedValue(
            Array.from({ length: 12000 }, (_, index) => ({
                id: `station-${index}`,
                name: `Station ${index}`,
                images: {},
                sortOrder: index,
                isVisible: true,
            })),
        );
        const { body } = await get('');
        expect(body.stations).toHaveLength(50);
        expect(body.page).toMatchObject({ limit: 50, hasMore: true });
    });

    it('rejects mixed scope/paging, invalid cursors and invalid limits', async () => {
        for (const query of [
            '&stationIds=a&cursor=invalid',
            '&stationIds=a&limit=2',
            '&cursor=invalid',
            '&limit=201',
            '&limit=0',
            '&limit=1.5',
        ]) {
            expect((await get(query)).status).toBe(422);
        }
    });

    it('reports 24-hour span details and rejects local datetimes', async () => {
        const { GET } = mount(guideDef, CTX_INTERNAL);
        const tooLong = await GET!(
            makeEvent({
                url: `http://localhost/api/livetv/guide?from=${from}&to=2026-10-16T10:00:01Z`,
            }),
        );
        expect(tooLong.status).toBe(422);
        expect(await parseJson(tooLong)).toMatchObject({ details: { maxSpanSeconds: 86400 } });
        const local = await GET!(
            makeEvent({
                url: 'http://localhost/api/livetv/guide?from=2026-10-15T10:00:00&to=2026-10-15T12:00:00Z',
            }),
        );
        expect(local.status).toBe(422);
    });

    it('refuses more than 200 channel ids', async () => {
        const ids = Array.from({ length: 201 }, (_, i) => `ch${i}`).join(',');
        const { status } = await get(`&stationIds=${ids}`);
        expect(status).toBe(422);
    });
});

describe('station schedule response contracts', () => {
    const from = '2026-03-04T20:00:00Z';
    const to = '2026-03-05T08:00:00Z';
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-03-05T09:00:00Z'));
        mockCanStream.mockResolvedValue(true);
        mockGetGuidePrograms.mockResolvedValue({
            [VALID_CHANNEL_UUID]: [program('p', from, '2026-03-04T21:00:00Z')],
        });
    });
    afterEach(() => {
        vi.useRealTimers();
    });
    it('returns the station window, airings and nowNext for a 12-hour program request', async () => {
        const { GET } = mount(stationProgramsDef, CTX_INTERNAL);
        const response = await GET!(
            makeEvent({
                params: { stationId: VALID_CHANNEL_UUID },
                url: `http://localhost/api/livetv/stations/${VALID_CHANNEL_UUID}/programs?from=${from}&to=${to}`,
            }),
        );
        expect(response.status).toBe(200);
        expect(await parseJson(response)).toMatchObject({
            stationId: VALID_CHANNEL_UUID,
            window: {
                from: new Date(from).toISOString(),
                to: new Date(to).toISOString(),
                asOf: expect.any(String),
            },
            airings: [{ id: 'p', stationId: VALID_CHANNEL_UUID }],
            nowNext: { current: null, next: null },
        });
    });
    it('requires a window even if an old view/day mode is supplied', async () => {
        const { GET } = mount(stationProgramsDef, CTX_INTERNAL);
        const response = await GET!(
            makeEvent({
                params: { stationId: VALID_CHANNEL_UUID },
                url: `http://localhost/api/livetv/stations/${VALID_CHANNEL_UUID}/programs?view=day&day=2026-03-04`,
            }),
        );
        expect(response.status).toBe(422);
    });
    it('returns current and next together with their observation time', async () => {
        const current = program('live', '2026-03-05T08:00:00Z', '2026-03-05T10:00:00Z');
        const next = program('next', '2026-03-05T10:00:00Z', '2026-03-05T11:00:00Z');
        vi.mocked(readStationSchedules).mockResolvedValueOnce(
            new Map([[VALID_CHANNEL_UUID, [next, current]]]),
        );
        const { GET } = mount(currentProgramDef, CTX_INTERNAL);
        const response = await GET!(makeEvent({ params: { stationId: VALID_CHANNEL_UUID } }));
        expect(response.status).toBe(200);
        expect(await parseJson(response)).toEqual({
            nowNext: { current, next },
            asOf: '2026-03-05T09:00:00.000Z',
        });
    });
    it('returns explicit nulls and asOf for an empty current-program schedule', async () => {
        vi.mocked(readStationSchedules).mockResolvedValueOnce(new Map([[VALID_CHANNEL_UUID, []]]));
        const { GET } = mount(currentProgramDef, CTX_INTERNAL);
        const response = await GET!(makeEvent({ params: { stationId: VALID_CHANNEL_UUID } }));
        expect(response.status).toBe(200);
        expect(await parseJson(response)).toEqual({
            nowNext: { current: null, next: null },
            asOf: expect.any(String),
        });
    });
});

describe('livetv program search', () => {
    const airing = (id: string, stationId: string) => ({
        id,
        stationId,
        title: 'Quizshow',
        startTime: '2026-10-15T10:00:00.000Z',
        endTime: '2026-10-15T11:00:00.000Z',
        temporalStatus: 'live' as const,
    });

    beforeEach(() => {
        mockSearchPrograms.mockReset();
        mockGetChannels.mockResolvedValue(
            ['a', 'b'].map((id) => ({
                id,
                name: `Station ${id}`,
                images: {},
                sortOrder: 0,
                isVisible: true,
            })),
        );
    });

    async function get(query: string) {
        const { GET } = mount(programSearchDef, CTX_INTERNAL);
        const res = await GET!(
            makeEvent({ url: `http://localhost/api/livetv/programs/search${query}` }),
        );
        return { status: res.status, body: await parseJson(res) };
    }

    it('returns one item per airing keyed by stationId with a station summary', async () => {
        mockSearchPrograms.mockResolvedValue([airing('x1', 'a'), airing('x2', 'b')]);
        const { status, body } = await get('?q=quiz&limit=5');
        expect(status).toBe(200);
        expect(mockSearchPrograms).toHaveBeenCalledWith('quiz', 6, 0);
        const items = body.items as {
            id: string;
            stationId: string;
            station: { id: string; name: string };
        }[];
        expect(items.map((i) => [i.id, i.stationId, i.station.id, i.station.name])).toEqual([
            ['x1', 'a', 'a', 'Station a'],
            ['x2', 'b', 'b', 'Station b'],
        ]);
        expect(items[0]).not.toHaveProperty('channelId');
        expect(body.page).toEqual({ limit: 5, offset: 0, hasMore: false });
    });

    it('reports hasMore and passes the offset through', async () => {
        mockSearchPrograms.mockResolvedValue([
            airing('x1', 'a'),
            airing('x2', 'b'),
            airing('x3', 'a'),
        ]);
        const { body } = await get('?q=quiz&limit=2&offset=4');
        expect(mockSearchPrograms).toHaveBeenCalledWith('quiz', 3, 4);
        expect((body.items as unknown[]).length).toBe(2);
        expect(body.page).toEqual({ limit: 2, offset: 4, hasMore: true });
    });

    it('drops airings of stations outside the lineup and rejects short queries', async () => {
        mockSearchPrograms.mockResolvedValue([airing('x1', 'gone'), airing('x2', 'a')]);
        const { body } = await get('?q=quiz');
        expect((body.items as { id: string }[]).map((i) => i.id)).toEqual(['x2']);
        expect((await get('?q=a')).status).toBe(422);
    });

    it('maps a provider failure to 503', async () => {
        mockSearchPrograms.mockRejectedValue(new Error('down'));
        expect((await get('?q=quiz')).status).toBe(503);
    });
});

it.each(['internal', 'v1'] as const)(
    '%s Live start reports POST cadence outside delivery',
    async (surface) => {
        const response = await mount(streamDef, { surface }).POST!(makeStartEvent());
        expect(response.status).toBe(201);
        const body = await response.json();
        expect(body.reporting).toEqual({
            kind: 'keepalive',
            method: 'POST',
            playbackSessionId: body.playbackSessionId,
            intervalMs: 10000,
            href: `/api${surface === 'v1' ? '/v1' : ''}/livetv/playback-sessions/${body.playbackSessionId}/keepalive`,
        });
        expect(body.delivery).not.toHaveProperty('keepaliveHref');
        expect(body.delivery).not.toHaveProperty('heartbeatIntervalMs');
    },
);

it('preserves requested quality and exposes the disabled ladder outcome', async () => {
    Reflect.set(config, 'LIVETV_ADAPTIVE_LADDER_ENABLED', false);
    try {
        const event = makeStartEvent();
        event.request = new Request(event.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stationId: VALID_CHANNEL_UUID, quality: '720p4m' }),
        });
        const response = await mount(streamDef, CTX_V1).POST!(event);
        expect(response.status).toBe(201);
        expect((await response.json()).delivery).toMatchObject({
            requestedQuality: '720p4m',
            appliedQuality: 'original',
            reason: 'ladder_disabled',
            requestedMaxBitrateBps: 4000000,
        });
    } finally {
        Reflect.set(config, 'LIVETV_ADAPTIVE_LADDER_ENABLED', true);
    }
});

it('joins the chosen feed only when it belongs to the requested station', async () => {
    const feedId = '00000000-0000-4000-8000-000000000099';
    mockMapFeeds.mockResolvedValue(new Map([[feedId, VALID_CHANNEL_UUID]]));
    const event = () => {
        const e = makeStartEvent();
        e.request = new Request(e.url, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ stationId: VALID_CHANNEL_UUID, feedId }),
        });
        return e;
    };
    const response = await mount(streamDef, CTX_V1).POST!(event());
    expect(response.status).toBe(201);
    expect((await response.json()).delivery.feedId).toBe(feedId);
    expect(mockSessionService.startPlaybackSession).toHaveBeenCalledWith(
        expect.objectContaining({ stationId: VALID_CHANNEL_UUID, feedId }),
    );
    mockMapFeeds.mockResolvedValue(new Map());
    expect((await mount(streamDef, CTX_V1).POST!(event())).status).toBe(404);
});
