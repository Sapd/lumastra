// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

// Unit tests for the Live TV branch of /j/Items/[itemId]/PlaybackInfo.
//
// The source's concurrent-stream cap is the ordinary reason a tune is refused
// (for example, a 2-stream IPTV package). That refusal used to fall into the catch and
// come back as HTTP 500, so jellyfin-androidtv showed "This item cannot be
// played" — indistinguishable from a broken server. Jellyfin's own contract is
// a 200 carrying PlaybackErrorCode, which the client turns into a real message.

import type { RequestEvent, RequestHandler } from '@sveltejs/kit';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const liveFeature = vi.hoisted(() => ({ enabled: true }));
vi.mock('$lib/server/config.js', async (original) => {
    const actual = await original<typeof import('$lib/server/config.js')>();
    return {
        ...actual,
        config: new Proxy(actual.config, {
            get(target, key, receiver) {
                return key === 'FEATURE_LIVETV'
                    ? liveFeature.enabled
                    : Reflect.get(target, key, receiver);
            },
        }),
    };
});

const {
    mockGetChannel,
    mockGetStreamInfo,
    mockGetMediaItemById,
    mockIssuePlayToken,
    mockRevokePlayTokenBySession,
    mockBuildStreamLimitPlaybackInfo,
} = vi.hoisted(() => ({
    mockBuildStreamLimitPlaybackInfo: vi.fn(),
    mockGetChannel: vi.fn(),
    mockGetStreamInfo: vi.fn(),
    mockGetMediaItemById: vi.fn(),
    mockIssuePlayToken: vi.fn(),
    mockRevokePlayTokenBySession: vi.fn(),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: RequestHandler) => handler,
}));

// The Live TV channel access gate has its own tests (channel-access.test.ts).
vi.mock('$lib/server/services/livetv/channel-access.js', () => ({
    canStreamLiveTvChannel: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/database', () => ({ getDb: vi.fn(() => ({})) }));

vi.mock('$lib/server/database/queries/catalog-operations.queries', () => ({
    getMediaItemById: mockGetMediaItemById,
}));

vi.mock('$lib/server/database/queries/media-files.queries', () => ({
    getOwnerItemForFile: vi.fn().mockResolvedValue(null),
    getFilesForMediaItem: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/media-streams.queries', () => ({
    getStreamsForMediaItem: vi.fn().mockResolvedValue([]),
    getStreamsForFile: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/database/queries/external-subtitles.queries', () => ({
    getExternalSubtitlesForFile: vi.fn().mockResolvedValue([]),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/services/livetv/index.js', () => ({
    getLiveTvProvider: vi.fn().mockResolvedValue({
        getChannel: mockGetChannel,
        getStreamInfo: mockGetStreamInfo,
    }),
}));

vi.mock('$lib/server/services/livetv/livetv-viewer-key.js', () => ({
    deriveLiveTvViewerKey: vi.fn(() => 'aleks:jf-play:deadbeef'),
    liveTvCredentialFingerprint: vi.fn((kind: string, cred: string) => `${kind}:${cred}`),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/play-token', () => ({
    issuePlayToken: mockIssuePlayToken,
    issueFileToken: vi.fn().mockResolvedValue('file-token'),
    validatePlayToken: vi.fn().mockResolvedValue(null),
    revokePlayTokenBySession: mockRevokePlayTokenBySession,
}));

// The free-tier cap decision has its own suite (stream-limit.test.ts); here the
// install is uncapped.
vi.mock('$lib/server/proprietary/jellyfin-compat/stream-limit-notice', () => ({
    freshPlaySessionId: vi.fn(async (id?: string) => id ?? 'fresh-session'),
    buildStreamLimitPlaybackInfo: mockBuildStreamLimitPlaybackInfo,
    noticeLanguage: vi.fn(() => 'en'),
    rateLimitedPlaybackInfo: (id: string) => ({
        PlaySessionId: id,
        MediaSources: [],
        ErrorCode: 'RateLimitExceeded',
    }),
}));

// `hasLiveTvPermission` is kept REAL via importOriginal — it is a pure
// predicate over the fixture user object, and faking it here would let the
// 403 assertions below drift from what the route actually calls (the exact
// risk a reviewer flagged: two near-duplicate implementations of the same
// check). Only `getJfToken` needs a stub — it reads `locals.jfToken`, which
// this file's fixtures don't set up.
vi.mock('$lib/server/proprietary/jellyfin-compat/utils', async (importOriginal) => {
    const actual =
        await importOriginal<typeof import('$lib/server/proprietary/jellyfin-compat/utils')>();
    return {
        ...actual,
        getJfToken: vi.fn(() => 'jf-token'),
    };
});

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
    },
}));

import { StreamLimitError } from '$lib/server/services/livetv/standalone-livetv-provider';
import { POST } from './+server';

const CHANNEL_ID = 'ea217dde-39e3-42c3-97b7-1e67249b99a1';

function makeEvent(opts: { hasLiveTvPermission?: boolean } = {}): RequestEvent {
    return {
        params: { itemId: CHANNEL_ID },
        url: new URL(`https://example.test/j/Items/${CHANNEL_ID}/PlaybackInfo`),
        request: new Request(`https://example.test/j/Items/${CHANNEL_ID}/PlaybackInfo`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ PlaySessionId: 'session-1' }),
        }),
        locals: {
            user: {
                userId: '00000000-0000-0000-0000-000000000001',
                username: 'aleks',
                hasLiveTvPermission: opts.hasLiveTvPermission ?? true,
            },
        },
        cookies: { get: vi.fn(), set: vi.fn() },
    } as unknown as RequestEvent;
}

const callPost = (opts?: { hasLiveTvPermission?: boolean }) =>
    (POST as unknown as (event: RequestEvent) => Promise<Response>)(makeEvent(opts));

describe('/j/Items/[itemId]/PlaybackInfo — Live TV refusals', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetMediaItemById.mockResolvedValue(null);
        mockGetChannel.mockResolvedValue({
            id: CHANNEL_ID,
            name: 'Orb Sport Mix HD',
            images: {},
            sortOrder: 17,
            isVisible: true,
        });
        mockIssuePlayToken.mockResolvedValue('play-token');
        mockRevokePlayTokenBySession.mockResolvedValue(undefined);
        mockGetStreamInfo.mockResolvedValue({});
        // No clip by default (no ffmpeg in a unit test) → the plain refusal.
        mockBuildStreamLimitPlaybackInfo.mockResolvedValue(null);
    });

    it('answers a provider stream-limit refusal with the "all TV streams in use" clip', async () => {
        mockGetStreamInfo.mockRejectedValue(new StreamLimitError(2, [], 'source-A'));
        const clip = {
            PlaySessionId: 'n'.repeat(32),
            MediaSources: [{ Id: 'n'.repeat(32), Name: 'All TV streams in use' }],
        };
        mockBuildStreamLimitPlaybackInfo.mockResolvedValue(clip);

        const response = await callPost();

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual(clip);
        expect(mockBuildStreamLimitPlaybackInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                kind: 'livetv_source',
                cap: 2,
                userId: '00000000-0000-0000-0000-000000000001',
                itemId: CHANNEL_ID,
            }),
        );
        // The real stream token is still revoked.
        expect(mockRevokePlayTokenBySession).toHaveBeenCalledWith('session-1');
    });

    it('a successful tune never builds a clip', async () => {
        await callPost();
        expect(mockBuildStreamLimitPlaybackInfo).not.toHaveBeenCalled();
    });

    it('answers a stream-limit refusal with RateLimitExceeded when no clip can be made', async () => {
        mockGetStreamInfo.mockRejectedValue(
            new StreamLimitError(
                2,
                [{ channelId: 'other', channelName: 'ZAVO 2 HD', viewers: 1 }],
                'source-A',
            ),
        );

        const response = await callPost();

        // 200 on purpose: the Jellyfin SDK only reads ErrorCode off a parsed body,
        // and turns it into the toast the user actually sees.
        expect(response.status).toBe(200);
        const body = (await response.json()) as Record<string, unknown>;
        expect(body.ErrorCode).toBe('RateLimitExceeded');
        expect(body.MediaSources).toEqual([]);
    });

    it('revokes the stream token it issued when the tune is refused', async () => {
        // The viewer key is derived from the token, so the token must exist before
        // the join. A refused join must not leave a usable one behind.
        mockGetStreamInfo.mockRejectedValue(new StreamLimitError(2, [], 'source-A'));

        await callPost();

        expect(mockRevokePlayTokenBySession).toHaveBeenCalledWith('session-1');
    });

    it('keeps the token when the tune succeeds', async () => {
        await callPost();

        expect(mockRevokePlayTokenBySession).not.toHaveBeenCalled();
    });

    it('still returns a playable source when the tune is allowed', async () => {
        const response = await callPost();

        expect(response.status).toBe(200);
        const body = (await response.json()) as {
            ErrorCode?: string;
            MediaSources: Array<{ TranscodingUrl: string }>;
        };
        expect(body.ErrorCode).toBeUndefined();
        expect(body.MediaSources).toHaveLength(1);
        expect(body.MediaSources[0].TranscodingUrl).toContain(`/Videos/${CHANNEL_ID}/live.m3u8`);
    });
});

// ---------------------------------------------------------------------------
// C6 — hasLiveTvPermission gate on both branches of this handler.
//
// Every fixture in the describe block above sets `hasLiveTvPermission: true`
// (`makeEvent`'s default), so none of those tests exercise the denial path —
// the real `hasLiveTvPermission` (kept real via `importOriginal` above) was
// proven to run, but only on the allow side. This block is the negative
// control that file never had: a user WITHOUT the permission must get 403
// from both gated branches, matching the pre-existing behaviour this task
// did not change. Each branch also keeps an explicit 200 allow-path case
// alongside its 403 case so the test discriminates on the permission flag,
// not on some other difference between the two fixtures.
// ---------------------------------------------------------------------------

describe('/j/Items/[itemId]/PlaybackInfo — hasLiveTvPermission gate (C6)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetChannel.mockResolvedValue({
            id: CHANNEL_ID,
            name: 'Orb Sport Mix HD',
            images: {},
            sortOrder: 17,
            isVisible: true,
        });
        mockIssuePlayToken.mockResolvedValue('play-token');
        mockRevokePlayTokenBySession.mockResolvedValue(undefined);
        mockGetStreamInfo.mockResolvedValue({});
    });

    describe('branch :277 — channel fallback (no media_items row, resolved via the Live TV provider)', () => {
        beforeEach(() => {
            mockGetMediaItemById.mockResolvedValue(null);
        });

        it('404 for a user without hasLiveTvPermission', async () => {
            const response = await callPost({ hasLiveTvPermission: false });

            expect(response.status).toBe(404);
        });

        it('200 for a user with hasLiveTvPermission (control)', async () => {
            const response = await callPost({ hasLiveTvPermission: true });

            expect(response.status).toBe(200);
        });
        it('disabled Live TV and a disallowed user produce the same unconfigured response', async () => {
            try {
                liveFeature.enabled = false;
                const absent = await callPost({ hasLiveTvPermission: true });
                liveFeature.enabled = true;
                const denied = await callPost({ hasLiveTvPermission: false });
                expect(absent.status).toBe(404);
                expect(denied.status).toBe(absent.status);
                expect(await denied.json()).toEqual(await absent.json());
            } finally {
                liveFeature.enabled = true;
            }
        });
    });

    describe('branch :347 — existing tvchannel media_items row', () => {
        beforeEach(() => {
            mockGetMediaItemById.mockResolvedValue({
                id: CHANNEL_ID,
                media_type: 'tvchannel',
            });
        });

        it('404 for a user without hasLiveTvPermission', async () => {
            const response = await callPost({ hasLiveTvPermission: false });

            expect(response.status).toBe(404);
        });

        it('200 for a user with hasLiveTvPermission (control)', async () => {
            const response = await callPost({ hasLiveTvPermission: true });

            expect(response.status).toBe(200);
        });
        it('disabled Live TV and a disallowed user produce the same unconfigured response', async () => {
            try {
                liveFeature.enabled = false;
                const absent = await callPost({ hasLiveTvPermission: true });
                liveFeature.enabled = true;
                const denied = await callPost({ hasLiveTvPermission: false });
                expect(absent.status).toBe(404);
                expect(denied.status).toBe(absent.status);
                expect(await denied.json()).toEqual(await absent.json());
            } finally {
                liveFeature.enabled = true;
            }
        });
    });
});
