// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Fault-isolation contract for `buildAccessContext`.
 *
 * `/feed` composes N sections and drops just the failing one — that is its
 * documented invariant. But `buildAccessContext` runs BEFORE the per-section
 * try/catch, so anything that throws in there escapes section isolation and
 * 500s the WHOLE aggregate response.
 *
 * Two reads live in that pre-isolation window, and they must behave
 * DIFFERENTLY on failure:
 *
 *   - the metadata-language preferences read is COSMETIC (which localized
 *     title to prefer) → must degrade to the no-overlay default;
 *   - `getDeniedLibraryGroups` is an ACCESS BOUNDARY → must keep propagating,
 *     because failing it open would serve titles from denied library groups.
 *
 * This file pins both directions. It lives apart from recommender.test.ts on
 * purpose: the config/permissions mocks it needs would otherwise leak into
 * that suite's `runRecommender` tests.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserId } from '$lib/shared/user-id.js';

const {
    mockGetDb,
    mockGetDeniedLibraryGroups,
    mockGetPlaybackPreferencesOne,
    mockResolveMetadataLanguage,
    mockIsUnavailableMediaVisible,
    mockWarn,
} = vi.hoisted(() => ({
    mockGetDb: vi.fn(() => ({}) as unknown),
    mockGetDeniedLibraryGroups: vi.fn(async () => null as string[] | null),
    mockGetPlaybackPreferencesOne: vi.fn(async () => ({}) as unknown),
    mockResolveMetadataLanguage: vi.fn(() => ({ titleLang: 'de', textLang: 'de' })),
    mockIsUnavailableMediaVisible: vi.fn(() => false),
    mockWarn: vi.fn(),
}));

vi.mock('$lib/server/database/connection.js', () => ({ getDb: mockGetDb }));

vi.mock('$lib/server/config.js', () => ({
    // Non-empty: this is what gates the preferences read at all.
    config: { METADATA_ADDITIONAL_LANGUAGES: ['de'], UNRATED_CONTENT_VISIBLE: true },
    isUnavailableMediaVisible: mockIsUnavailableMediaVisible,
}));

vi.mock('$lib/server/cache/library-group-permissions-cache.js', () => ({
    getDeniedLibraryGroups: mockGetDeniedLibraryGroups,
    toLibraryAccessUser: (u: unknown) => u,
}));

vi.mock('$lib/server/database/queries/user-preferences.queries.js', () => ({
    getPlaybackPreferences: { one: mockGetPlaybackPreferencesOne },
}));

vi.mock('$lib/server/utils/metadata-language-resolve.js', () => ({
    resolveMetadataLanguage: mockResolveMetadataLanguage,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: (...a: unknown[]) => mockWarn(...a),
            error: vi.fn(),
            info: vi.fn(),
            debug: vi.fn(),
        }),
    },
}));

import { buildAccessContext } from './recommender.js';

const USER_ID = 'usr_00000000-0000-0000-0000-000000000001' as UserId;

function makeEvent(): RequestEvent {
    return {
        locals: {
            principal: { userId: USER_ID, username: 'alice', isAdmin: false, userGroups: [] },
            user: {
                userId: USER_ID,
                username: 'alice',
                userGroups: [],
                ownerIsAdmin: false,
                mediaAccessIsAdmin: false,
                maxAgeRating: null,
                isAgeRestricted: false,
            },
        },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    vi.clearAllMocks();
    mockGetDb.mockReturnValue({});
    mockGetDeniedLibraryGroups.mockResolvedValue(null);
    mockGetPlaybackPreferencesOne.mockResolvedValue({});
    mockResolveMetadataLanguage.mockReturnValue({ titleLang: 'de', textLang: 'de' });
    mockIsUnavailableMediaVisible.mockReturnValue(false);
});

describe('buildAccessContext — pre-isolation fault contract', () => {
    it('fails closed when a non-admin principal has no live age profile', async () => {
        const event = makeEvent();
        Reflect.deleteProperty(event.locals, 'user');
        expect(await buildAccessContext(event)).toBeNull();
        expect(mockGetDeniedLibraryGroups).not.toHaveBeenCalled();
    });

    it('fails closed when an admin principal has no live profile', async () => {
        const event = makeEvent();
        event.locals.principal!.isAdmin = true;
        Reflect.deleteProperty(event.locals, 'user');
        expect(await buildAccessContext(event)).toBeNull();
        expect(mockGetDeniedLibraryGroups).not.toHaveBeenCalled();
    });

    it("keeps a low-scope principal from restoring its admin owner's library bypass", async () => {
        const event = makeEvent();
        event.locals.user!.ownerIsAdmin = true;
        event.locals.user!.mediaAccessIsAdmin = true;
        await buildAccessContext(event);
        expect(mockGetDeniedLibraryGroups).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({ isAdmin: false }),
        );
    });
    it('keeps the live age profile when a bearer principal is also populated', async () => {
        const event = makeEvent();
        event.locals.user = {
            userId: USER_ID,
            username: 'alice',
            groups: '',
            userGroups: [],
            ownerIsAdmin: false,
            mediaAccessIsAdmin: false,
            maxAgeRating: 12,
            isAgeRestricted: true,
            hasWatchPermission: true,
            hasLiveTvPermission: false,
            hasRequestPermission: false,
            isModerator: false,
            liveTvPriority: 'low',
        };
        const ctx = await buildAccessContext(event);
        expect(ctx?.maxAgeRating).toBe(12);
        expect(ctx?.isAgeRestricted).toBe(true);
    });
    it('applies the metadata-language overlay on the happy path', async () => {
        const ctx = await buildAccessContext(makeEvent());

        expect(ctx).not.toBeNull();
        expect(ctx?.langs).toEqual({ titleLang: 'de', textLang: 'de' });
        expect(mockGetPlaybackPreferencesOne).toHaveBeenCalledTimes(1);
    });

    it('degrades to no overlay — and does NOT throw — when the preferences read rejects', async () => {
        mockGetPlaybackPreferencesOne.mockRejectedValueOnce(new Error('connection terminated'));

        // The whole point: this must resolve, not reject. A rejection here is a
        // 500 on every section of /feed, not just the localized-title path.
        const ctx = await buildAccessContext(makeEvent());

        expect(ctx).not.toBeNull();
        expect(ctx?.langs).toEqual({ titleLang: null, textLang: null });
        // The rest of the context is still fully populated — the failure is
        // contained to the overlay, it does not blank out access fields.
        expect(ctx?.userId).toBe(USER_ID);
        expect(ctx?.allowUnrated).toBe(true);
        expect(mockWarn).toHaveBeenCalledTimes(1);
    });

    it('degrades when resolveMetadataLanguage itself throws on a malformed row', async () => {
        mockResolveMetadataLanguage.mockImplementationOnce(() => {
            throw new TypeError("Cannot read properties of null (reading 'toLowerCase')");
        });

        const ctx = await buildAccessContext(makeEvent());

        expect(ctx?.langs).toEqual({ titleLang: null, textLang: null });
        expect(mockWarn).toHaveBeenCalledTimes(1);
    });

    it('still PROPAGATES a denied-library-groups failure — access boundaries fail closed', async () => {
        mockGetDeniedLibraryGroups.mockRejectedValueOnce(new Error('permissions cache down'));

        // Deliberately NOT swallowed: serving a feed without the deny filter
        // would leak titles from library groups this user cannot see.
        await expect(buildAccessContext(makeEvent())).rejects.toThrow('permissions cache down');
        // And the cosmetic read must not have papered over it.
        expect(mockWarn).not.toHaveBeenCalled();
    });

    it('returns null for an unauthenticated event without touching the DB', async () => {
        const ctx = await buildAccessContext({ locals: {} } as unknown as RequestEvent);

        expect(ctx).toBeNull();
        expect(mockGetPlaybackPreferencesOne).not.toHaveBeenCalled();
    });
});
