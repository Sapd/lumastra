// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An admin's /j/Users list must report EACH listed user's own download
 * permission. The caller (an admin) is not the subject of any row, so a row
 * with a download override of false shows false while the others show true.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const cfg = vi.hoisted(() => ({
    FEATURE_MEDIA_DOWNLOAD: true,
    DOWNLOADS_ALLOWED_BY_DEFAULT: true,
    DOWNLOAD_GROUPS: [] as string[],
    UNRATED_CONTENT_VISIBLE: true,
    FEATURE_LIVETV: false,
    LIVETV_GROUPS: [] as string[],
    ARR_MANAGER_GROUPS: [] as string[],
}));
const overrides = vi.hoisted(() => new Map<string, boolean | null>());

vi.mock('$lib/server/config', () => ({ config: cfg }));
vi.mock('$lib/server/config.js', () => ({ config: cfg }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserAllowDownloads: async (_db: unknown, userId: string) => ({ allowDownloads: overrides.get(userId) ?? null, groups: [] }),
    listUsers: async () => [
        { id: 'useradmin', username: 'admin', is_admin: true, display_name: null },
        { id: 'useroff', username: 'bob', is_admin: false, display_name: null },
        { id: 'useron', username: 'alice', is_admin: false, display_name: null },
    ],
    getUserByUsername: async () => null,
}));
vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: unknown) => handler,
}));
vi.mock('$lib/server/jellyfin-compat/user-playback-preferences', () => ({
    loadUserPlaybackPreferences: vi.fn(async () => null),
}));

import { GET } from './+server.js';

function adminEvent(): RequestEvent {
    const url = new URL('http://localhost/j/Users');
    return {
        url,
        request: new Request(url),
        params: {},
        route: { id: null },
        locals: {
            user: { userId: 'useradmin', username: 'admin', ownerIsAdmin: true },
            principal: { isAdmin: true },
            authMethod: 'jellyfin_compat_session',
        },
    } as unknown as RequestEvent;
}

beforeEach(() => {
    overrides.clear();
    overrides.set('useroff', false);
});

describe('GET /j/Users (admin list): each row carries that user’s download permission', () => {
    it('shows false for the user with an override of false and true for the others', async () => {
        const res = await GET(adminEvent() as never);
        expect(res.status).toBe(200);
        const rows = (await res.json()) as Array<{
            Id: string;
            Policy: { EnableContentDownloading: boolean };
        }>;
        const byId = new Map(rows.map((r) => [r.Id, r.Policy.EnableContentDownloading]));
        expect(byId.get('useroff')).toBe(false);
        expect(byId.get('useron')).toBe(true);
        expect(byId.get('useradmin')).toBe(true);
    });
});
