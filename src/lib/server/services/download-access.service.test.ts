// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({
    FEATURE_MEDIA_DOWNLOAD: true,
    DOWNLOADS_ALLOWED_BY_DEFAULT: true,
    DOWNLOAD_GROUPS: [] as string[],
}));
const getUserAllowDownloads = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/config.js', () => ({ config: cfg }));
const dbHolder = vi.hoisted(() => ({ db: {} as object | null }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => dbHolder.db }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({ getUserAllowDownloads }));

import {
    canDownload,
    explainDownloadAccess,
    userMayDownload,
    invalidateDownloadAccess,
} from './download-access.service.js';

const mockRow = (allowDownloads: boolean | null, groups: string[] = []) =>
    getUserAllowDownloads.mockResolvedValue({ allowDownloads, groups });

let n = 0;
const user = (isAdmin = false) => ({ userId: `u${++n}`, username: `name${n}`, isAdmin });

describe('userMayDownload (no master switch)', () => {
    beforeEach(() => {
        cfg.FEATURE_MEDIA_DOWNLOAD = false;
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = true;
        cfg.DOWNLOAD_GROUPS = [];
        getUserAllowDownloads.mockReset();
        mockRow(null);
    });

    it('ignores FEATURE_MEDIA_DOWNLOAD', async () => {
        expect(await userMayDownload(user())).toBe(true);
        expect(await userMayDownload(user(true))).toBe(true);
        expect(await canDownload(user())).toBe(false);
    });

    it('an admin whose row is disabled or deleted may not download', async () => {
        getUserAllowDownloads.mockResolvedValue(undefined); // the query hides disabled / deleted rows
        expect(await userMayDownload(user(true))).toBe(false);
        cfg.FEATURE_MEDIA_DOWNLOAD = true;
        expect(await canDownload(user(true))).toBe(false);
    });

    it('an active admin ignores a per-user override and the group rule', async () => {
        mockRow(false);
        cfg.DOWNLOAD_GROUPS = ['family'];
        expect(await userMayDownload(user(true))).toBe(true);
    });

    it('is false without a user or userId, true for admins', async () => {
        expect(await userMayDownload(null)).toBe(false);
        expect(await userMayDownload({ username: 'x' })).toBe(false);
        expect(await userMayDownload({ username: 'x', isAdmin: true })).toBe(true);
    });

    it('override false beats default true; override true beats default false', async () => {
        mockRow(false);
        expect(await userMayDownload(user())).toBe(false);
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = false;
        mockRow(true);
        expect(await userMayDownload(user())).toBe(true);
        getUserAllowDownloads.mockResolvedValue(undefined);
        expect(await userMayDownload(user())).toBe(false);
    });
});

describe('canDownload', () => {
    beforeEach(() => {
        cfg.FEATURE_MEDIA_DOWNLOAD = true;
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = true;
        cfg.DOWNLOAD_GROUPS = [];
        getUserAllowDownloads.mockReset();
        mockRow(null);
    });

    it('is false when the feature is off, even for admins', async () => {
        cfg.FEATURE_MEDIA_DOWNLOAD = false;
        expect(await canDownload(user(true))).toBe(false);
        expect(await canDownload(user())).toBe(false);
    });

    it('is false without a user', async () => {
        expect(await canDownload(null)).toBe(false);
        expect(await canDownload(undefined)).toBe(false);
    });

    it('is true for an active admin (the row is still checked: disabled admins are refused)', async () => {
        mockRow(null);
        expect(await canDownload(user(true))).toBe(true);
        expect(getUserAllowDownloads).toHaveBeenCalledTimes(1);
    });

    it('is false for a user without userId unless admin', async () => {
        expect(await canDownload({ username: 'x' })).toBe(false);
        expect(await canDownload({ username: 'x', isAdmin: true })).toBe(true);
    });

    it('override false beats default true', async () => {
        mockRow(false);
        expect(await canDownload(user())).toBe(false);
    });

    it('override null uses the default', async () => {
        expect(await canDownload(user())).toBe(true);
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = false;
        expect(await canDownload(user())).toBe(false);
    });

    it('default false plus override true is true', async () => {
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = false;
        mockRow(true);
        expect(await canDownload(user())).toBe(true);
    });

    it('is false when the user row is gone', async () => {
        getUserAllowDownloads.mockResolvedValue(undefined);
        expect(await canDownload(user())).toBe(false);
    });

    it('caches per user id for 5 s and invalidation forces a re-query', async () => {
        vi.useFakeTimers();
        try {
            const u = user();
            await canDownload(u);
            await canDownload(u);
            expect(getUserAllowDownloads).toHaveBeenCalledTimes(1);
            invalidateDownloadAccess(u.userId);
            await canDownload(u);
            expect(getUserAllowDownloads).toHaveBeenCalledTimes(2);
            vi.advanceTimersByTime(5001);
            await canDownload(u);
            expect(getUserAllowDownloads).toHaveBeenCalledTimes(3);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('download groups', () => {
    beforeEach(() => {
        cfg.FEATURE_MEDIA_DOWNLOAD = true;
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = true;
        cfg.DOWNLOAD_GROUPS = ['family'];
        getUserAllowDownloads.mockReset();
    });

    it('user in the group, no override -> true even when default is false', async () => {
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = false;
        mockRow(null, ['family']);
        expect(await userMayDownload(user())).toBe(true);
    });

    it('user not in the group -> false even with default true', async () => {
        mockRow(null, ['kids']);
        expect(await userMayDownload(user())).toBe(false);
        mockRow(null, []);
        expect(await userMayDownload(user())).toBe(false);
    });

    it('override true beats a group miss; override false beats a group hit', async () => {
        mockRow(true, ['kids']);
        expect(await userMayDownload(user())).toBe(true);
        mockRow(false, ['family']);
        expect(await userMayDownload(user())).toBe(false);
    });

    it('empty DOWNLOAD_GROUPS falls back to the default', async () => {
        cfg.DOWNLOAD_GROUPS = [];
        mockRow(null, ['kids']);
        expect(await userMayDownload(user())).toBe(true);
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = false;
        expect(await userMayDownload(user())).toBe(false);
    });

    it('an active admin outside the group is allowed', async () => {
        mockRow(null, ['other']);
        expect(await userMayDownload(user(true))).toBe(true);
    });

    it('group match is case-insensitive like hasGroupPermission', async () => {
        cfg.DOWNLOAD_GROUPS = [' Family '];
        mockRow(null, ['FAMILY']);
        expect(await userMayDownload(user())).toBe(true);
    });

    it('applies a group change after the cache expires or is invalidated', async () => {
        const u = user();
        mockRow(null, ['kids']);
        expect(await canDownload(u)).toBe(false);
        mockRow(null, ['family']);
        invalidateDownloadAccess(u.userId);
        expect(await canDownload(u)).toBe(true);
    });
});

describe('explainDownloadAccess', () => {
    beforeEach(() => {
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = true;
        cfg.DOWNLOAD_GROUPS = [];
    });

    it('reports admin, override, group and default', () => {
        expect(explainDownloadAccess({ allowDownloads: false, groups: [] }, true)).toEqual({
            allowed: true,
            reason: 'admin',
        });
        expect(explainDownloadAccess({ allowDownloads: false, groups: ['x'] }, false)).toEqual({
            allowed: false,
            reason: 'override',
        });
        cfg.DOWNLOAD_GROUPS = ['family'];
        expect(explainDownloadAccess({ allowDownloads: null, groups: ['family'] }, false)).toEqual({
            allowed: true,
            reason: 'group',
        });
        expect(explainDownloadAccess({ allowDownloads: null, groups: [] }, false)).toEqual({
            allowed: false,
            reason: 'group',
        });
        cfg.DOWNLOAD_GROUPS = [];
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = false;
        expect(explainDownloadAccess({ allowDownloads: null, groups: ['family'] }, false)).toEqual({
            allowed: false,
            reason: 'default',
        });
    });

    it('treats a null groups column as no groups', () => {
        cfg.DOWNLOAD_GROUPS = ['family'];
        expect(explainDownloadAccess({ allowDownloads: null, groups: null }, false).allowed).toBe(
            false,
        );
    });
});

describe('fail closed and blank groups', () => {
    beforeEach(() => {
        cfg.FEATURE_MEDIA_DOWNLOAD = true;
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = true;
        cfg.DOWNLOAD_GROUPS = [];
        dbHolder.db = {};
        getUserAllowDownloads.mockReset();
    });

    it('is false when there is no database, without querying', async () => {
        dbHolder.db = null;
        expect(await userMayDownload(user())).toBe(false);
        expect(getUserAllowDownloads).not.toHaveBeenCalled();
    });

    it('ignores empty / whitespace DOWNLOAD_GROUPS entries', async () => {
        cfg.DOWNLOAD_GROUPS = ['', '  '];
        mockRow(null, ['kids']);
        expect(await userMayDownload(user())).toBe(true);
        expect(explainDownloadAccess({ allowDownloads: null, groups: [] }, false).reason).toBe(
            'default',
        );
    });
});
