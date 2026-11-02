// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for JellyfinUserIdResolver (DB-mapping aware).
 *
 * Resolution tiers:
 *   L1: in-memory Map (per-process)
 *   DB: users.jellyfin_user_id (cached UUID) / jellyfin_username (login override)
 *   API: Jellyfin getUserByName fallback (then persist the UUID)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mock dependencies ─────────────────────────────────────────────────────────

vi.mock('$lib/server/jellyfin/user.service.js', () => ({
    jellyfinUserService: { getUserByName: vi.fn() },
}));

vi.mock('$lib/server/operation-mode.js', () => ({
    operationMode: { isJellyfinEnabled: true },
}));

vi.mock('$lib/server/config.js', () => ({
    features: { jellyfinSync: true },
}));

vi.mock('./database.service.js', () => ({
    aiDbService: { getSql: vi.fn() },
}));

vi.mock('../database/queries/users.queries.js', () => ({
    getJellyfinMapping: vi.fn(),
    cacheJellyfinUserId: vi.fn(),
}));

// ── Import after mocks ────────────────────────────────────────────────────────

import {
    resolveJellyfinUserId,
    invalidateJellyfinUserIdCache,
} from './jellyfin-user-id-resolver.js';
import { jellyfinUserService } from '$lib/server/jellyfin/user.service.js';
import { operationMode } from '$lib/server/operation-mode.js';
import { features } from '$lib/server/config.js';
import { aiDbService } from './database.service.js';
import { getJellyfinMapping, cacheJellyfinUserId } from '../database/queries/users.queries.js';

const mockGetUserByName = vi.mocked(jellyfinUserService.getUserByName);
const mockGetSql = vi.mocked(aiDbService.getSql);
const mockGetMapping = vi.mocked(getJellyfinMapping);
const mockCacheId = vi.mocked(cacheJellyfinUserId);

const jfUser = (id: string) =>
    ({ Id: id }) as ReturnType<typeof jellyfinUserService.getUserByName> extends Promise<infer T>
        ? T
        : never;

const dummySql = {} as Parameters<typeof getJellyfinMapping>[0];

describe('resolveJellyfinUserId', () => {
    const USER = 'testuser';
    const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    beforeEach(() => {
        invalidateJellyfinUserIdCache(USER);
        vi.clearAllMocks();
        vi.mocked(operationMode).isJellyfinEnabled = true;
        vi.mocked(features).jellyfinSync = true;
        mockGetSql.mockResolvedValue(dummySql);
        mockGetMapping.mockResolvedValue({ jellyfin_username: null, jellyfin_user_id: null });
        mockCacheId.mockResolvedValue();
    });

    afterEach(() => invalidateJellyfinUserIdCache(USER));

    it('returns undefined immediately when Jellyfin is disabled', async () => {
        vi.mocked(operationMode).isJellyfinEnabled = false;
        expect(await resolveJellyfinUserId(USER)).toBeUndefined();
        expect(mockGetSql).not.toHaveBeenCalled();
        expect(mockGetUserByName).not.toHaveBeenCalled();
    });

    it('returns undefined when sync is disabled', async () => {
        vi.mocked(features).jellyfinSync = false;
        expect(await resolveJellyfinUserId(USER)).toBeUndefined();
        expect(mockGetUserByName).not.toHaveBeenCalled();
    });

    it('returns a cached jellyfin_user_id authoritatively (no API call)', async () => {
        mockGetMapping.mockResolvedValueOnce({ jellyfin_username: null, jellyfin_user_id: UUID });
        expect(await resolveJellyfinUserId(USER)).toBe(UUID);
        expect(mockGetUserByName).not.toHaveBeenCalled();
    });

    it('resolves by the Lumastra username by default and persists the UUID', async () => {
        mockGetUserByName.mockResolvedValueOnce(jfUser(UUID));
        expect(await resolveJellyfinUserId(USER)).toBe(UUID);
        expect(mockGetUserByName).toHaveBeenCalledWith(USER);
        expect(mockCacheId).toHaveBeenCalledWith(dummySql, USER, UUID);
    });

    it('resolves by the jellyfin_username override when set', async () => {
        mockGetMapping.mockResolvedValueOnce({
            jellyfin_username: 'jf_other',
            jellyfin_user_id: null,
        });
        mockGetUserByName.mockResolvedValueOnce(jfUser(UUID));
        expect(await resolveJellyfinUserId(USER)).toBe(UUID);
        expect(mockGetUserByName).toHaveBeenCalledWith('jf_other');
    });

    it('hits L1 on a second resolution (no DB or API call)', async () => {
        mockGetUserByName.mockResolvedValueOnce(jfUser(UUID));
        await resolveJellyfinUserId(USER);
        vi.clearAllMocks();
        expect(await resolveJellyfinUserId(USER)).toBe(UUID);
        expect(mockGetSql).not.toHaveBeenCalled();
        expect(mockGetUserByName).not.toHaveBeenCalled();
    });

    it('returns undefined (no persist) when the Jellyfin user is not found', async () => {
        mockGetUserByName.mockResolvedValueOnce(null);
        expect(await resolveJellyfinUserId(USER)).toBeUndefined();
        expect(mockCacheId).not.toHaveBeenCalled();
    });

    it('returns undefined and never throws when the Jellyfin API errors', async () => {
        mockGetUserByName.mockRejectedValueOnce(new Error('Jellyfin unreachable'));
        await expect(resolveJellyfinUserId(USER)).resolves.toBeUndefined();
    });

    it('degrades to a same-name API lookup when the DB is unavailable', async () => {
        mockGetSql.mockResolvedValueOnce(null);
        mockGetUserByName.mockResolvedValueOnce(jfUser(UUID));
        expect(await resolveJellyfinUserId(USER)).toBe(UUID);
        expect(mockGetUserByName).toHaveBeenCalledWith(USER);
        expect(mockCacheId).not.toHaveBeenCalled();
    });
});

describe('invalidateJellyfinUserIdCache', () => {
    const USER = 'cacheuser';
    const UUID = '11111111-2222-3333-4444-555555555555';

    beforeEach(() => {
        invalidateJellyfinUserIdCache(USER);
        vi.clearAllMocks();
        vi.mocked(operationMode).isJellyfinEnabled = true;
        vi.mocked(features).jellyfinSync = true;
        mockGetSql.mockResolvedValue(dummySql);
        mockGetMapping.mockResolvedValue({ jellyfin_username: null, jellyfin_user_id: null });
        mockCacheId.mockResolvedValue();
    });

    afterEach(() => invalidateJellyfinUserIdCache(USER));

    it('clears the L1 entry so the next resolve re-queries', async () => {
        mockGetUserByName.mockResolvedValue(jfUser(UUID));
        await resolveJellyfinUserId(USER);

        invalidateJellyfinUserIdCache(USER);
        vi.clearAllMocks();
        mockGetSql.mockResolvedValue(dummySql);
        mockGetMapping.mockResolvedValue({ jellyfin_username: null, jellyfin_user_id: UUID });

        expect(await resolveJellyfinUserId(USER)).toBe(UUID);
        expect(mockGetMapping).toHaveBeenCalled();
    });
});
