// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { homeMusicSessions } from '$lib/api/home-active-sessions.fixture.js';
import { SessionsResponseSchema } from '$lib/schemas/api-playback-responses.js';

const mocks = vi.hoisted(() => ({
    visible: vi.fn(),
    languages: vi.fn(),
    disabled: vi.fn(),
    config: { FEATURE_SESSIONS: true },
    get: vi.fn(),
    context: vi.fn(),
    boundary: vi.fn(),
}));
vi.mock('$lib/server/utils/search-access-context.js', () => ({
    buildSearchAccessContext: mocks.context,
    searchAccessBoundary: mocks.boundary,
}));
vi.mock('./active-sessions-view.service.js', () => ({ getVisibleActiveSessions: mocks.visible }));
vi.mock('$lib/server/config.js', () => ({ config: mocks.config }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/utils/widget-guard.js', () => ({ isWidgetDisabled: mocks.disabled }));
vi.mock('$lib/server/utils/metadata-language-resolve.js', () => ({
    resolveViewerMetadataLanguages: mocks.languages,
}));
vi.mock('$app/environment', () => ({ version: 'test' }));
vi.mock('$lib/api/client.js', () => ({
    apiGet: mocks.get,
    apiPost: vi.fn(),
    apiPatch: vi.fn(),
    apiDelete: vi.fn(),
}));

import { getHomeActiveSessions as loadHomeSessions } from './home-active-sessions.service.js';
import { getHomeActiveSessions as refreshHomeSessions } from '$lib/api/playback.js';

const locals = {
    user: {
        userId: '11111111-1111-4111-8111-111111111111',
        username: 'alice',
        userGroups: ['watchers'],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
    },
    principal: { isAdmin: false },
} as App.Locals;
const langs = { titleLang: 'de', textLang: 'de' };

beforeEach(() => {
    vi.clearAllMocks();
    mocks.config.FEATURE_SESSIONS = true;
    mocks.disabled.mockReturnValue(false);
    mocks.languages.mockResolvedValue(langs);
    mocks.context.mockResolvedValue({ ctx: true });
    mocks.boundary.mockReturnValue({ library: { kind: 'all' }, age: { kind: 'any' } });
    mocks.visible.mockResolvedValue({
        visible: true,
        sessions: homeMusicSessions(),
        cacheTimestamp: 1000,
    });
});

describe('home active streams SSR / live contract', () => {
    it('keeps both covers, music metadata, codecs and the paused external session through the client parse', async () => {
        const initial = await loadHomeSessions(locals, langs);
        // The live endpoint uses this exact loader. Include a position change
        // so the comparison cannot pass by reusing the SSR data in the browser.
        const updated = homeMusicSessions();
        updated[0].playCurrentTime = 35;
        mocks.visible.mockResolvedValue({ visible: true, sessions: updated, cacheTimestamp: 2000 });
        const wire = JSON.parse(JSON.stringify(await loadHomeSessions(locals)));
        mocks.get.mockImplementation(async (_url: string, schema: z.ZodType) => ({
            data: schema.parse(wire),
            error: null,
        }));
        const live = (await refreshHomeSessions()).data!;

        expect(mocks.get).toHaveBeenCalledWith(
            '/api/home/active-sessions',
            SessionsResponseSchema,
            expect.objectContaining({ params: { _t: expect.any(Number) } }),
        );
        expect(live.sessions).toHaveLength(2);
        expect(live.sessions.map((s) => s.__id)).toEqual(initial.sessions.map((s) => s.__id));
        for (const [index, session] of live.sessions.entries()) {
            const seed = initial.sessions[index];
            expect(session.images?.primary?.href).toBe(seed.images?.primary?.href);
            expect(session.externalIds?.internal).toBe(seed.externalIds?.internal);
            expect(session.artistName).toBe(seed.artistName);
            expect(session.albumName).toBe(seed.albumName);
            expect(session.nextTrack).toEqual(seed.nextTrack);
            expect(session.playOriginalAudioCodec).toBe(seed.playOriginalAudioCodec);
            expect(session.playOriginalAudioBitrate).toBe(320_000);
            expect(session.userId).toBe(seed.userId);
        }
        expect(live.sessions[0].playCurrentTime).toBe(35);
        expect(live.sessions[1]).toMatchObject({ playIsPlaying: false, sessionSource: 'subsonic' });
        expect(live.cacheTimestamp).toBe(2000);
        expect(mocks.visible).toHaveBeenLastCalledWith({
            ...locals.user,
            isAdmin: false,
            metadataLangs: langs,
            access: { library: { kind: 'all' }, age: { kind: 'any' } },
        });
        expect(mocks.languages).toHaveBeenCalledExactlyOnceWith(
            expect.anything(),
            locals.user!.userId,
        );
    });

    it('hands the visibility service the viewer’s own access boundary (age + library)', async () => {
        const kid = { library: { kind: 'all' }, age: { kind: 'limit', maxAgeRating: 6 } };
        mocks.boundary.mockReturnValue(kid);
        await loadHomeSessions(locals, langs);
        expect(mocks.context).toHaveBeenCalledWith(expect.anything(), locals.user);
        expect(mocks.visible).toHaveBeenCalledWith(expect.objectContaining({ access: kid }));
    });

    it('honors the visibility service’s restricted-viewer result', async () => {
        mocks.visible.mockResolvedValue({
            visible: true,
            sessions: [homeMusicSessions()[0]],
            cacheTimestamp: 1000,
        });
        expect((await loadHomeSessions(locals)).sessions).toHaveLength(1);
        mocks.visible.mockResolvedValue({
            visible: false,
            sessions: homeMusicSessions(),
            cacheTimestamp: 1000,
        });
        expect((await loadHomeSessions(locals)).sessions).toEqual([]);
    });

    it('projects storage media types before validating the shared response', async () => {
        mocks.visible.mockResolvedValue({
            visible: true,
            sessions: [{ ...homeMusicSessions()[0], mediaType: 'tv' }],
            cacheTimestamp: 1000,
        });
        expect((await loadHomeSessions(locals)).sessions[0].mediaType).toBe('series');
    });

    it.each(['feature', 'widget'])('returns no streams when the %s is disabled', async (gate) => {
        mocks.config.FEATURE_SESSIONS = gate !== 'feature';
        mocks.disabled.mockReturnValue(gate === 'widget');
        expect((await loadHomeSessions(locals)).sessions).toEqual([]);
        expect(mocks.visible).not.toHaveBeenCalled();
    });
});
