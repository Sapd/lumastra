// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Repro test for F24 — ImageProxyService internal methods bypass injected sql.
 *
 * Finding: fetchGravatarBuffer() and getUserAvatar() call getDb() directly
 * for user lookups, even when the instance was constructed with task-pool sql.
 * This undermines the workaround used by provider-artwork-materialization.
 *
 * Citations: src/lib/server/services/image-proxy/service.ts:1522,1609
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGetDb = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: mockGetDb,
}));

const mockLogger = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: vi.fn(() => mockLogger),
    },
}));

const mockGetUserByUsername = vi.hoisted(() => vi.fn());
const mockGetUserAvatar = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserByUsername: mockGetUserByUsername,
    getUserAvatar: mockGetUserAvatar,
}));

describe('F24 — ImageProxyService user lookups must use injected sql', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReturnValue(null);
    });

    it('fetchGravatarBuffer uses the injected task-pool sql, not getDb()', async () => {
        const { ImageProxyService } = await import('$lib/server/services/image-proxy/service.js');

        // Construct the service with a task-pool sql handle
        const taskPoolSql = vi.fn() as unknown as import('postgres').Sql;
        const service = new ImageProxyService(taskPoolSql);

        mockGetUserByUsername.mockResolvedValue({ email: 'test@example.com' });

        await service['fetchGravatarBuffer']('testuser', false, 80);

        // CORRECT behavior: fetchGravatarBuffer should use this.sql (the
        // injected task-pool handle) for all database lookups.
        // BUG: It ignores this.sql and calls getDb() directly.
        expect(mockGetDb).not.toHaveBeenCalled();
        expect(mockGetUserByUsername).toHaveBeenCalledWith(taskPoolSql, 'testuser');
    });

    it('getUserAvatar path uses the injected sql instead of getDb()', async () => {
        const { ImageProxyService } = await import('$lib/server/services/image-proxy/service.js');

        const taskPoolSql = vi.fn() as unknown as import('postgres').Sql;
        const service = new ImageProxyService(taskPoolSql);

        mockGetUserAvatar.mockResolvedValue({
            avatar_data: Buffer.from('fake-avatar'),
            avatar_content_type: 'image/png',
        });

        await service['fetchCustomAvatarBuffer']('user-uuid', false, 80);

        // CORRECT behavior: The custom avatar lookup should use this.sql.
        // BUG: It falls back to getDb() rather than using the constructor sql.
        expect(mockGetDb).not.toHaveBeenCalled();
        expect(mockGetUserAvatar).toHaveBeenCalledWith(taskPoolSql, 'user-uuid', {
            includeIdp: expect.any(Boolean),
        });
    });
});
