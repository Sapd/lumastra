// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';

const cfg = vi.hoisted(() => ({ groups: [] as string[], byDefault: true }));
vi.mock('$lib/server/config.js', () => ({
    config: {
        get DOWNLOAD_GROUPS() {
            return cfg.groups;
        },
        get DOWNLOADS_ALLOWED_BY_DEFAULT() {
            return cfg.byDefault;
        },
    },
}));
vi.mock('$lib/server/auth.js', () => ({
    hasGroupPermission: (have: string[], want: string[]) => want.some((g) => have.includes(g)),
}));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => undefined }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserAllowDownloads: vi.fn(),
}));

import { mapUserToApi, type UserRow } from './user.mapper.js';

function row(over: Partial<UserRow> = {}): UserRow {
    return {
        id: 'u1',
        username: 'alice',
        is_admin: false,
        admin_pinned: false,
        max_age_rating: null,
        age_rating_pinned: false,
        display_name: null,
        email: null,
        hide_streams: false,
        groups: ['family'],
        groups_updated_at: null,
        created_at: new Date('2026-01-01T00:00:00Z'),
        last_seen_at: null,
        disabled_at: null,
        ...over,
    };
}

describe('mapUserToApi downloadAccess', () => {
    it('explains the effective value for the "Default" choice', () => {
        cfg.groups = [];
        cfg.byDefault = true;
        expect(mapUserToApi(row({ allow_downloads: null })).downloadAccess).toEqual({
            allowed: true,
            reason: 'default',
        });
        cfg.byDefault = false;
        expect(mapUserToApi(row({ allow_downloads: null })).downloadAccess).toEqual({
            allowed: false,
            reason: 'default',
        });
    });

    it('reports a group match', () => {
        cfg.groups = ['family'];
        expect(mapUserToApi(row()).downloadAccess).toEqual({ allowed: true, reason: 'group' });
        cfg.groups = ['staff'];
        expect(mapUserToApi(row()).downloadAccess).toEqual({ allowed: false, reason: 'group' });
    });

    it('reports an explicit override and admins', () => {
        cfg.groups = [];
        expect(mapUserToApi(row({ allow_downloads: false })).downloadAccess).toEqual({
            allowed: false,
            reason: 'override',
        });
        expect(mapUserToApi(row({ is_admin: true })).downloadAccess).toEqual({
            allowed: true,
            reason: 'admin',
        });
    });
});
