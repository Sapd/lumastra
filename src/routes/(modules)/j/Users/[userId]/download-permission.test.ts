// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * An admin reading ANOTHER user through /j/Users/{userId} must get that
 * target's own download permission in Policy.EnableContentDownloading, not the
 * admin's.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const cfg = vi.hoisted(() => ({
    FEATURE_MEDIA_DOWNLOAD: true,
    DOWNLOADS_ALLOWED_BY_DEFAULT: true,
    UNRATED_CONTENT_VISIBLE: true,
    FEATURE_LIVETV: false,
    LIVETV_GROUPS: [] as string[],
    ARR_MANAGER_GROUPS: [] as string[],
}));
const overrides = vi.hoisted(() => new Map<string, boolean | null>());
const targets = vi.hoisted(() => new Map<string, Record<string, unknown>>());

vi.mock('$lib/server/config', () => ({ config: cfg }));
vi.mock('$lib/server/config.js', () => ({ config: cfg }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database', () => ({
    // getUserById issues a tagged-template query; answer it from the target map.
    getDb: () =>
        Object.assign(async (_strings: TemplateStringsArray, ...values: unknown[]) => {
            const row = targets.get(String(values[0]));
            return row ? [row] : [];
        }, {}),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserAllowDownloads: async (_db: unknown, userId: string) => overrides.get(userId) ?? null,
    getUserByUsername: async () => ({
        id: 'useradmin',
        username: 'admin',
        is_admin: true,
        display_name: null,
    }),
}));
vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    withJellyfinAuth: (handler: unknown) => handler,
}));
vi.mock('$lib/server/jellyfin-compat/user-playback-preferences', () => ({
    loadUserPlaybackPreferences: vi.fn(async () => null),
}));
vi.mock('$lib/server/auth', () => ({ hasGroupPermission: () => false }));

import { GET } from './+server.js';

const TARGET_OFF = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TARGET_ON = '11111111-2222-4333-8444-555555555555';

function row(id: string, username: string) {
    return { id, username, is_admin: false, display_name: null, groups: [] };
}

function adminEvent(userId: string): RequestEvent {
    const url = new URL(`http://localhost/j/Users/${userId}`);
    return {
        url,
        request: new Request(url),
        params: { userId },
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
    targets.clear();
    targets.set(TARGET_OFF, row(TARGET_OFF, 'bob'));
    targets.set(TARGET_ON, row(TARGET_ON, 'alice'));
    overrides.set(TARGET_OFF, false);
});

describe('GET /j/Users/{userId} (admin reads another user): the target’s permission', () => {
    it('is false when the target has a download override of false', async () => {
        const res = await GET(adminEvent(TARGET_OFF) as never);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { Policy: { EnableContentDownloading: boolean } };
        expect(body.Policy.EnableContentDownloading).toBe(false);
    });

    it('is true when the target may download', async () => {
        const res = await GET(adminEvent(TARGET_ON) as never);
        expect(res.status).toBe(200);
        const body = (await res.json()) as { Policy: { EnableContentDownloading: boolean } };
        expect(body.Policy.EnableContentDownloading).toBe(true);
    });
});
