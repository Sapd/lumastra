// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cfg = vi.hoisted(() => ({
    FEATURE_MEDIA_DOWNLOAD: true,
    DOWNLOADS_ALLOWED_BY_DEFAULT: true,
}));
const getUserAllowDownloads = vi.hoisted(() => vi.fn());

vi.mock('$lib/server/config.js', () => ({ config: cfg }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({ getUserAllowDownloads }));

import {
    canDownload,
    userMayDownload,
    invalidateDownloadAccess,
} from './download-access.service.js';

let n = 0;
const user = (isAdmin = false) => ({ userId: `u${++n}`, username: `name${n}`, isAdmin });

describe('userMayDownload (no master switch)', () => {
    beforeEach(() => {
        cfg.FEATURE_MEDIA_DOWNLOAD = false;
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = true;
        getUserAllowDownloads.mockReset();
        getUserAllowDownloads.mockResolvedValue(null);
    });

    it('ignores FEATURE_MEDIA_DOWNLOAD', async () => {
        expect(await userMayDownload(user())).toBe(true);
        expect(await userMayDownload(user(true))).toBe(true);
        expect(await canDownload(user())).toBe(false);
    });

    it('is false without a user or userId, true for admins', async () => {
        expect(await userMayDownload(null)).toBe(false);
        expect(await userMayDownload({ username: 'x' })).toBe(false);
        expect(await userMayDownload({ username: 'x', isAdmin: true })).toBe(true);
    });

    it('override false beats default true; override true beats default false', async () => {
        getUserAllowDownloads.mockResolvedValue(false);
        expect(await userMayDownload(user())).toBe(false);
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = false;
        getUserAllowDownloads.mockResolvedValue(true);
        expect(await userMayDownload(user())).toBe(true);
        getUserAllowDownloads.mockResolvedValue(undefined);
        expect(await userMayDownload(user())).toBe(false);
    });
});

describe('canDownload', () => {
    beforeEach(() => {
        cfg.FEATURE_MEDIA_DOWNLOAD = true;
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = true;
        getUserAllowDownloads.mockReset();
        getUserAllowDownloads.mockResolvedValue(null);
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

    it('is true for admins without a query', async () => {
        expect(await canDownload(user(true))).toBe(true);
        expect(getUserAllowDownloads).not.toHaveBeenCalled();
    });

    it('is false for a user without userId unless admin', async () => {
        expect(await canDownload({ username: 'x' })).toBe(false);
        expect(await canDownload({ username: 'x', isAdmin: true })).toBe(true);
    });

    it('override false beats default true', async () => {
        getUserAllowDownloads.mockResolvedValue(false);
        expect(await canDownload(user())).toBe(false);
    });

    it('override null uses the default', async () => {
        expect(await canDownload(user())).toBe(true);
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = false;
        expect(await canDownload(user())).toBe(false);
    });

    it('default false plus override true is true', async () => {
        cfg.DOWNLOADS_ALLOWED_BY_DEFAULT = false;
        getUserAllowDownloads.mockResolvedValue(true);
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
