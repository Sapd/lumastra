// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for dismissals service
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { toUserId } from '$lib/shared/user-id.js';
import { getDismissalsForUser, upsertDismissal } from './dismissals';

type DbQueryFn = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<unknown[]>;

// A stable UUID for 'testuser' — minted once and used wherever the service
// resolves 'testuser' → UUID via getUserIdByUsername.
const TESTUSER_UID = toUserId('bbbbbbbb-0000-4000-b000-000000000001');

const { mockGetDb, mockQueryFn, mockGetUserIdByUsername } = vi.hoisted(() => {
    const mockQueryFn = vi.fn<() => Promise<unknown[]>>();
    const mockGetDb = vi.fn<() => DbQueryFn | null>();
    const mockGetUserIdByUsername = vi.fn<() => Promise<ReturnType<typeof toUserId> | null>>();
    return { mockGetDb, mockQueryFn, mockGetUserIdByUsername };
});

vi.mock('$lib/server/database/connection.js', () => ({
    getDb: mockGetDb,
}));

// Mock the users query so the service's username→UUID resolution is controllable.
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserIdByUsername: mockGetUserIdByUsername,
}));

vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: {
        for: () => ({
            warn: vi.fn(),
            error: vi.fn(),
            debug: vi.fn(),
            info: vi.fn(),
        }),
    },
}));

describe('getDismissalsForUser', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReset();
        mockQueryFn.mockReset();
        mockGetUserIdByUsername.mockReset();
    });

    it('returns empty array when database is not available', async () => {
        mockGetDb.mockReturnValue(null);
        const result = await getDismissalsForUser('testuser');
        expect(result).toEqual([]);
    });

    it('maps user_media_flags rows to {id, dismissedAt}', async () => {
        // After migration 16.108.0, dismissals live in user_media_flags.
        // The query returns target_id + created_at (not composite_key / dismissed_at).
        const rows = [
            {
                target_id: 'tmdb:123:movie',
                created_at: new Date('2024-01-15T10:00:00Z'),
            },
            {
                target_id: 'tmdb:456:tv',
                created_at: new Date('2024-01-15T11:00:00Z'),
            },
        ];

        mockGetUserIdByUsername.mockResolvedValue(TESTUSER_UID);
        mockQueryFn.mockReturnValue(Promise.resolve(rows));
        mockGetDb.mockReturnValue(mockQueryFn);

        const result = await getDismissalsForUser('testuser');

        expect(result).toEqual([
            {
                id: 'tmdb:123:movie',
                dismissedAt: '2024-01-15T10:00:00.000Z',
            },
            { id: 'tmdb:456:tv', dismissedAt: '2024-01-15T11:00:00.000Z' },
        ]);
    });

    it('returns empty array on database error', async () => {
        mockGetUserIdByUsername.mockResolvedValue(TESTUSER_UID);
        mockQueryFn.mockReturnValue(Promise.reject(new Error('DB error')));
        mockGetDb.mockReturnValue(mockQueryFn);
        const result = await getDismissalsForUser('testuser');
        expect(result).toEqual([]);
    });
});

describe('upsertDismissal', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mockGetDb.mockReset();
        mockQueryFn.mockReset();
        mockGetUserIdByUsername.mockReset();
    });

    it('returns error when database is not available', async () => {
        mockGetDb.mockReturnValue(null);
        const result = await upsertDismissal('testuser', { tmdb: '123' }, 'movie');
        expect(result).toEqual({
            success: false,
            error: 'Database not available',
        });
    });

    it('returns error when no external IDs are usable', async () => {
        mockGetDb.mockReturnValue(mockQueryFn);
        const result = await upsertDismissal('testuser', {}, 'movie');
        expect(result).toEqual({
            success: false,
            error: 'Cannot identify media',
        });
        expect(mockQueryFn).not.toHaveBeenCalled();
    });

    it('returns success with server timestamp on insert', async () => {
        // After migration 16.108.0, the INSERT returns created_at (not dismissed_at).
        mockGetUserIdByUsername.mockResolvedValue(TESTUSER_UID);
        mockQueryFn.mockReturnValue(
            Promise.resolve([{ created_at: new Date('2024-01-15T10:00:00Z') }]),
        );
        mockGetDb.mockReturnValue(mockQueryFn);

        const result = await upsertDismissal('testuser', { tmdb: '123' }, 'movie');

        expect(result).toEqual({
            success: true,
            dismissedAt: '2024-01-15T10:00:00.000Z',
        });
    });

    it('excludes UUIDs from composite key when both external and internal IDs present', async () => {
        // Regression: pending-sync rebuilds requests from Jellyseerr with TMDB
        // only. If a notification carries {tmdb, internal} at dismiss time, the
        // composite key MUST be 'tmdb:550:movie' — not the raw UUID — or the
        // dismissal silently misses on the next sync.
        const captured: string[] = [];
        const captureFn = ((..._args: unknown[]) => {
            for (const v of _args) {
                if (typeof v === 'string' && v.includes(':')) {
                    captured.push(v);
                }
            }
            return Promise.resolve([{ dismissed_at: new Date('2024-01-15T10:00:00Z') }]);
        }) as unknown as DbQueryFn;

        mockGetUserIdByUsername.mockResolvedValue(TESTUSER_UID);
        mockGetDb.mockReturnValue(captureFn);

        await upsertDismissal(
            'testuser',
            {
                tmdb: '550',
                internal: 'a3f5e8c7-1234-5678-90ab-cdef12345678',
            },
            'movie',
        );

        expect(captured).toContain('tmdb:550:movie');
        expect(captured).not.toContain('a3f5e8c7-1234-5678-90ab-cdef12345678');
    });

    it('returns error when insert returns no rows', async () => {
        mockGetUserIdByUsername.mockResolvedValue(TESTUSER_UID);
        mockQueryFn.mockReturnValue(Promise.resolve([]));
        mockGetDb.mockReturnValue(mockQueryFn);

        const result = await upsertDismissal('testuser', { tmdb: '123' }, 'movie');

        expect(result).toEqual({
            success: false,
            error: 'Failed to save dismissal',
        });
    });

    it('returns error on database failure', async () => {
        mockGetUserIdByUsername.mockResolvedValue(TESTUSER_UID);
        mockQueryFn.mockReturnValue(Promise.reject(new Error('DB error')));
        mockGetDb.mockReturnValue(mockQueryFn);

        const result = await upsertDismissal('testuser', { tmdb: '123' }, 'movie');

        expect(result).toEqual({ success: false, error: 'Database error' });
    });
});
