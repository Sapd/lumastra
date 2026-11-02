// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for resolve-and-gate
 *
 * Tests external ID resolution → UUID + access check,
 * and correct error classes for failure paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Sql } from 'postgres';
import type { UserContext } from '$lib/server/types.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    resolveAndGate,
    MediaAccessDeniedError,
    MediaNotResolvableError,
} from './resolve-and-gate';

const mockResolveExternalIdsToMediaId = vi.fn();
const mockCheckMediaAccess = vi.fn();

vi.mock('$lib/server/utils/media-resolution.js', () => ({
    resolveExternalIdsToMediaId: (...args: unknown[]) => mockResolveExternalIdsToMediaId(...args),
}));

vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: (...args: unknown[]) => mockCheckMediaAccess(...args),
}));

describe('resolveAndGate', () => {
    const sql = {} as unknown as Sql;
    const user: UserContext = {
        userId: toUserId('00000000-0000-0000-0000-000000000001'),
        username: 'TestUser',
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    };
    const externalIds = { tmdb: '12345' };

    beforeEach(() => {
        mockResolveExternalIdsToMediaId.mockReset();
        mockCheckMediaAccess.mockReset();
    });

    it('resolves IDs and returns mediaId when access is allowed', async () => {
        mockResolveExternalIdsToMediaId.mockResolvedValue('media-uuid-1');
        mockCheckMediaAccess.mockResolvedValue(true);

        const result = await resolveAndGate(sql, externalIds, 'movie', user);

        expect(result).toEqual({ mediaId: 'media-uuid-1' });
        expect(mockResolveExternalIdsToMediaId).toHaveBeenCalledWith(
            sql,
            externalIds,
            'movie',
            undefined,
        );
        expect(mockCheckMediaAccess).toHaveBeenCalledWith(sql, 'media-uuid-1', user);
    });

    it('passes title to resolver when provided', async () => {
        mockResolveExternalIdsToMediaId.mockResolvedValue('media-uuid-2');
        mockCheckMediaAccess.mockResolvedValue(true);

        await resolveAndGate(sql, externalIds, 'tv', user, 'My Show');

        expect(mockResolveExternalIdsToMediaId).toHaveBeenCalledWith(
            sql,
            externalIds,
            'tv',
            'My Show',
        );
    });

    it('throws MediaAccessDeniedError when user is null', async () => {
        await expect(
            resolveAndGate(sql, externalIds, 'movie', null as unknown as UserContext),
        ).rejects.toThrow(MediaAccessDeniedError);
    });

    it('throws MediaAccessDeniedError when user is undefined', async () => {
        await expect(
            resolveAndGate(sql, externalIds, 'movie', undefined as unknown as UserContext),
        ).rejects.toThrow(MediaAccessDeniedError);
    });

    it('throws MediaNotResolvableError when IDs do not resolve', async () => {
        mockResolveExternalIdsToMediaId.mockResolvedValue(null);

        await expect(resolveAndGate(sql, externalIds, 'movie', user)).rejects.toThrow(
            MediaNotResolvableError,
        );

        expect(mockCheckMediaAccess).not.toHaveBeenCalled();
    });

    it('throws MediaAccessDeniedError when access is denied', async () => {
        mockResolveExternalIdsToMediaId.mockResolvedValue('media-uuid-1');
        mockCheckMediaAccess.mockResolvedValue(false);

        await expect(resolveAndGate(sql, externalIds, 'movie', user)).rejects.toThrow(
            MediaAccessDeniedError,
        );
    });

    it('throws MediaAccessDeniedError when checkMediaAccess throws', async () => {
        mockResolveExternalIdsToMediaId.mockResolvedValue('media-uuid-1');
        mockCheckMediaAccess.mockRejectedValue(new Error('DB timeout'));

        await expect(resolveAndGate(sql, externalIds, 'movie', user)).rejects.toThrow(
            MediaAccessDeniedError,
        );
    });

    it('error instances have correct names', async () => {
        const denied = new MediaAccessDeniedError();
        expect(denied.name).toBe('MediaAccessDeniedError');
        expect(denied.message).toBe('Media not accessible');

        const notResolvable = new MediaNotResolvableError();
        expect(notResolvable.name).toBe('MediaNotResolvableError');
        expect(notResolvable.message).toBe('No valid external IDs provided');
    });
});
