// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * `MusicInteractionManager`'s track-feedback writes (like/dislike/removeLike/
 * removeDislike/skip/complete) must answer 404 for a trackId that does not
 * exist, matching every def's documented contract.
 *
 * `checkMediaAccess` short-circuits to "allowed" for an unrestricted,
 * non-age-restricted caller without ever looking the id up, so a deleted or
 * malformed trackId only surfaces at the write itself as a Postgres
 * foreign-key violation (23503) or an invalid-uuid cast (22P02). Before this
 * fix nothing translated that into the `MediaAccessDeniedError` every def
 * already catches and maps to 404 — it propagated as an unhandled 500 on a
 * route documenting 404. These tests pin the translation at the one place
 * (the manager) all six writes now share it, so a future method added here
 * cannot ship without it.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';

vi.mock('$lib/server/database/queries/media-type-cache.queries.js', () => ({
    getMediaType: vi.fn().mockResolvedValue('track'),
}));

const mockRecordTrackLike = vi.fn();
const mockRecordTrackDislike = vi.fn();
const mockRecordTrackSkip = vi.fn();
const mockRecordTrackComplete = vi.fn();
const mockClearTrackLike = vi.fn();
const mockClearTrackDislike = vi.fn();

vi.mock('$lib/server/database/queries/music-interactions.queries.js', () => ({
    recordTrackLike: (...a: unknown[]) => mockRecordTrackLike(...a),
    recordTrackDislike: (...a: unknown[]) => mockRecordTrackDislike(...a),
    recordTrackSkip: (...a: unknown[]) => mockRecordTrackSkip(...a),
    recordTrackComplete: (...a: unknown[]) => mockRecordTrackComplete(...a),
    clearTrackLike: (...a: unknown[]) => mockClearTrackLike(...a),
    clearTrackDislike: (...a: unknown[]) => mockClearTrackDislike(...a),
}));
vi.mock('$lib/server/database/queries/music-tracking.queries.js', () => ({
    claimMusicPlayStart: vi.fn().mockResolvedValue(true),
    recordPlayStart: vi.fn(),
    recordPlayEnd: vi.fn(),
    recordPlayEndNoTiming: vi.fn(),
    isRecordedListenEvent: vi.fn().mockResolvedValue(false),
    insertListenEvent: vi.fn(),
}));
vi.mock('./database.service.js', () => ({
    aiDbService: {
        getSql: () => Promise.resolve({ begin: (cb: (tx: unknown) => unknown) => cb({}) }),
    },
}));
vi.mock('$lib/server/cache', () => ({
    cacheInvalidation: { onRatingCacheChanged: vi.fn() },
}));
vi.mock('$lib/server/cache/valkey.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/server/cache/valkey.js')>()),
    setIfNotExists: vi.fn(() => Promise.resolve(true)),
    getValkeyClient: vi.fn(() => null),
    subscribeToChannel: vi.fn(() => Promise.resolve()),
}));
// Unrestricted caller — mirrors the real short-circuit that never looks the
// trackId up (isMediaAccessible's getDeniedLibraryGroups → null → true).
vi.mock('$lib/server/middleware/media-access.js', () => ({ checkMediaAccess: vi.fn(() => true) }));

const { musicInteractionManager, MusicInteractionAccessDeniedError } =
    await import('./music-interaction-manager.service.js');

const USER = 'u1' as never;
const TRACK = '11111111-2222-3333-4444-555555555555';
const USER_CTX = { userId: USER, isAgeRestricted: false } as never;

function fkViolation(): Error {
    return Object.assign(new Error('insert or update on table violates foreign key constraint'), {
        code: '23503',
    });
}

function invalidUuid(): Error {
    return Object.assign(new Error('invalid input syntax for type uuid'), { code: '22P02' });
}

beforeEach(() => {
    vi.clearAllMocks();
});

describe.each([
    {
        name: 'like',
        call: () => musicInteractionManager.like(USER, TRACK, USER_CTX),
        mock: mockRecordTrackLike,
    },
    {
        name: 'dislike',
        call: () => musicInteractionManager.dislike(USER, TRACK, USER_CTX),
        mock: mockRecordTrackDislike,
    },
    {
        name: 'removeLike',
        call: () => musicInteractionManager.removeLike(USER, TRACK, USER_CTX),
        mock: mockClearTrackLike,
    },
    {
        name: 'removeDislike',
        call: () => musicInteractionManager.removeDislike(USER, TRACK, USER_CTX),
        mock: mockClearTrackDislike,
    },
    {
        name: 'skip',
        call: () => musicInteractionManager.skip(USER, TRACK, USER_CTX),
        mock: mockRecordTrackSkip,
    },
    {
        name: 'complete',
        call: () => musicInteractionManager.complete(USER, TRACK, USER_CTX),
        mock: mockRecordTrackComplete,
    },
])('$name — missing-track translation', ({ call, mock }) => {
    test('a foreign-key violation (23503) becomes MediaAccessDeniedError', async () => {
        mock.mockRejectedValueOnce(fkViolation());
        await expect(call()).rejects.toBeInstanceOf(MusicInteractionAccessDeniedError);
    });

    test('an invalid-uuid cast (22P02) becomes MediaAccessDeniedError', async () => {
        mock.mockRejectedValueOnce(invalidUuid());
        await expect(call()).rejects.toBeInstanceOf(MusicInteractionAccessDeniedError);
    });

    test('an unrelated failure propagates unchanged, not as a 404', async () => {
        const boom = new Error('connection reset');
        mock.mockRejectedValueOnce(boom);
        await expect(call()).rejects.toBe(boom);
    });
});
