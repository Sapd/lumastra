// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PagedSessionsResponseSchema } from '$lib/schemas/api-playback-responses.js';
import { buildPublicAuthor } from '$lib/shared/public-author';
import type { PartyStreamSnapshot } from '$lib/server/services/watch-party-stream-overlay.js';

const mocks = vi.hoisted(() => ({
    rows: vi.fn(),
    snapshots: vi.fn(),
    widgetDisabled: vi.fn(),
    watchTogether: true,
}));
vi.mock('$lib/server/services/image-descriptor/avatars.js', () => ({
    userImageSets: async () => new Map(),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/play-sessions.queries.js', () => ({
    getAllActiveSessionsWithMedia: mocks.rows,
}));
vi.mock('$lib/server/config.js', () => ({
    features: {
        get watchTogether() {
            return mocks.watchTogether;
        },
    },
}));
vi.mock('$lib/server/services/watch-together.service.js', () => ({
    getPartyStreamSnapshots: mocks.snapshots,
}));
vi.mock('$lib/server/utils/widget-guard.js', () => ({
    isWidgetDisabled: mocks.widgetDisabled,
}));
import { def } from './list.js';

const HOST = '11111111-1111-4111-8111-111111111111';
const GUEST = '22222222-2222-4222-8222-222222222222';
const OUTSIDER = '33333333-3333-4333-8333-333333333333';
const MEDIA = '44444444-4444-4444-8444-444444444444';

function row(userId: string, mediaId = MEDIA) {
    return {
        id: `play-${userId}-${mediaId}`,
        user_id: userId,
        media_id: mediaId,
        media_type: 'movie',
        status: 'ACTIVE',
        position_ms: 1000,
        runtime_ms: 5000,
        media_title: 'Movie',
        device_id: `device-${userId}`,
        client_name: 'Test',
        owner_username: 'secret-login-name',
        owner_display_name: userId === HOST ? 'Host' : null,
    };
}

function party(overrides: Partial<PartyStreamSnapshot> = {}): PartyStreamSnapshot {
    return {
        code: 'MOVIE-7X3K',
        visibility: 'listed',
        itemId: MEDIA,
        host: buildPublicAuthor(HOST, 'Host', 'internal'),
        hostClientId: 'host-client',
        isPlaying: false,
        playbackRate: 1,
        participants: [
            { userId: HOST, displayName: 'Host', clientId: 'host-client' },
            { userId: GUEST, displayName: 'Guest', clientId: 'guest-client' },
        ],
        positions: new Map(),
        stalledClientIds: new Set(),
        bufferCheckPending: false,
        ...overrides,
    };
}

async function get(userId = HOST, scope = 'mine', surface = 'v1', admin = false) {
    const response = await def.handlers.GET!(
        { locals: { user: { userId }, principal: { isAdmin: admin } } } as never,
        { input: { query: { scope } }, surface } as never,
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    const parsed = PagedSessionsResponseSchema.parse(body);
    // Check the wire response too: parsing alone would strip a leaked username.
    expect(body).toEqual(parsed);
    return parsed;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.watchTogether = true;
    mocks.widgetDisabled.mockReturnValue(false);
    mocks.snapshots.mockResolvedValue([party()]);
    mocks.rows.mockImplementation(async (_sql, filters: { userId?: string }) =>
        [row(HOST), row(GUEST), row(OUTSIDER)].filter(
            (session) => !filters.userId || session.user_id === filters.userId,
        ),
    );
});

describe('playback list watch parties', () => {
    it.each(['v1', 'internal'] as const)(
        'uses %s PublicAuthor identities for owners and hosts',
        async (surface) => {
            const { items } = await get(OUTSIDER, 'all', surface, true);
            expect(items[0].user).toEqual(buildPublicAuthor(HOST, 'Host', surface));
            expect(items[1].user).toEqual(buildPublicAuthor(GUEST, null, surface));
            expect(items[0].watchParty?.host).toEqual(buildPublicAuthor(HOST, 'Host', surface));
            expect(JSON.stringify(items)).not.toContain('secret-login-name');
            expect(items[0].watchParty).toMatchObject({
                code: 'MOVIE-7X3K',
                visibility: 'listed',
                isHost: true,
                participantCount: 2,
                viewerIsParticipant: false,
                syncState: 'paused',
            });
            expect(items[1].watchParty?.groupId).toBe(items[0].watchParty?.groupId);
            expect(items[1].watchParty?.isHost).toBe(false);
            expect(items[2].watchParty).toBeUndefined();
        },
    );

    it('keeps a missing host display name null without falling back to a login name', async () => {
        mocks.snapshots.mockResolvedValue([
            party({ host: buildPublicAuthor(HOST, null, 'internal') }),
        ]);
        expect((await get()).items[0].watchParty?.host).toEqual(
            buildPublicAuthor(HOST, null, 'v1'),
        );
    });

    it('returns only the caller’s sessions for mine, including their private party', async () => {
        mocks.snapshots.mockResolvedValue([party({ visibility: 'unlisted' })]);
        const { items } = await get(GUEST);
        expect(items).toHaveLength(1);
        expect(items[0].user?.userId).toBe(GUEST);
        expect(items[0].watchParty).toMatchObject({
            code: 'MOVIE-7X3K',
            visibility: 'unlisted',
            viewerIsParticipant: true,
        });
        expect(mocks.rows).toHaveBeenCalledWith(expect.anything(), {
            userId: GUEST,
            itemId: undefined,
        });
    });

    it('withholds private-party metadata from a nonparticipant admin listing all sessions', async () => {
        mocks.snapshots.mockResolvedValue([party({ visibility: 'unlisted' })]);
        const { items } = await get(OUTSIDER, 'all', 'v1', true);
        expect(items).toHaveLength(3);
        expect(items.every((item) => item.watchParty === undefined)).toBe(true);
    });

    it('includes private-party metadata for a participating admin listing all sessions', async () => {
        mocks.snapshots.mockResolvedValue([party({ visibility: 'unlisted' })]);
        const { items } = await get(GUEST, 'all', 'v1', true);
        expect(items[0].watchParty).toMatchObject({
            code: 'MOVIE-7X3K',
            viewerIsParticipant: true,
        });
        expect(items[1].watchParty?.groupId).toBe(items[0].watchParty?.groupId);
    });

    it('does not attach a party to another item played by the same user', async () => {
        mocks.rows.mockResolvedValue([row(HOST, '55555555-5555-4555-8555-555555555555')]);
        expect((await get()).items[0].watchParty).toBeUndefined();
    });

    it('hides listed-party join codes when listing is disabled, except for participants', async () => {
        mocks.widgetDisabled.mockReturnValue(true);
        const outsider = await get(OUTSIDER, 'all', 'v1', true);
        expect(outsider.items[0].watchParty).toBeDefined();
        expect(outsider.items[0].watchParty).not.toHaveProperty('code');
        expect((await get(GUEST)).items[0].watchParty?.code).toBe('MOVIE-7X3K');
    });

    it('serves sessions without enrichment when snapshots fail', async () => {
        mocks.snapshots.mockRejectedValue(new Error('Valkey unavailable'));
        const { items } = await get();
        expect(items).toHaveLength(1);
        expect(items[0].watchParty).toBeUndefined();
    });

    it('skips snapshot reads when Watch Together is disabled', async () => {
        mocks.watchTogether = false;
        expect((await get()).items[0].watchParty).toBeUndefined();
        expect(mocks.snapshots).not.toHaveBeenCalled();
    });

    it('skips snapshot reads for an empty session list', async () => {
        mocks.rows.mockResolvedValue([]);
        expect((await get()).items).toEqual([]);
        expect(mocks.snapshots).not.toHaveBeenCalled();
    });
});

describe('playback list page block', () => {
    it('reports the server page cap as page.limit, not the number of returned items', async () => {
        const { items, page } = await get(OUTSIDER, 'all', 'v1', true);
        expect(items).toHaveLength(3);
        expect(page).toMatchObject({ limit: 1000, offset: 0, hasMore: false });
    });
});

describe('playback list episode context and device name', () => {
    it('carries series title and season/episode numbers for an episode', async () => {
        mocks.rows.mockResolvedValue([
            {
                ...row(HOST),
                media_type: 'episode',
                media_title: 'Pilot',
                series_title: 'Example Show',
                season_number: 2,
                episode_number: 5,
            },
        ]);
        const [item] = (await get()).items;
        expect(item).toMatchObject({
            title: 'Pilot',
            seriesTitle: 'Example Show',
            seasonNumber: 2,
            episodeNumber: 5,
        });
    });

    it('leaves series and numbers null for a movie', async () => {
        const [item] = (await get()).items;
        expect(item).toMatchObject({
            title: 'Movie',
            seriesTitle: null,
            seasonNumber: null,
            episodeNumber: null,
        });
    });

    it('reports the registered device name, not the client application name', async () => {
        mocks.rows.mockResolvedValue([
            { ...row(HOST), device_name: 'Living Room TV', client_name: 'Lumastra tvOS' },
        ]);
        const [item] = (await get()).items;
        expect(item.device.name).toBe('Living Room TV');
        expect(item.device.name).toBe('Living Room TV');
        expect(item.device.client).toBe('Lumastra tvOS');
        expect(item.clientName).toBe('Lumastra tvOS');
    });

    it('falls back to the client application name only when the device is unnamed', async () => {
        mocks.rows.mockResolvedValue([{ ...row(HOST), device_name: null }]);
        const [item] = (await get()).items;
        expect(item.device.name).toBe('Test');
        expect(item.device.name).toBe('Test');
    });
});

it.each([true, false])(
    'serializes explicit CarPlay context %s without renaming the device',
    async (carPlay) => {
        mocks.rows.mockResolvedValue([
            {
                ...row(HOST),
                external_payload: { __lumastra_client_context: { carPlay, eventSeq: 1 } },
            },
        ]);
        const response = await get();
        expect(response.items[0].isCarPlay).toBe(carPlay);
        expect(response.items[0].device.id).toBe(`device-${HOST}`);
        expect(response.items[0].clientName).toBe('Test');
    },
);
