// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The login response's User.Policy.EnableContentDownloading is the logging-in
 * user's own download permission (canDownload with the master switch), not
 * false and not the caller's. Drives the real route and the real serializer and
 * download service; only the DB, Valkey and password modules are faked.
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
}));
const overrides = vi.hoisted(() => new Map<string, boolean | null>());

vi.mock('$lib/server/config', () => ({ config: cfg }));
vi.mock('$lib/server/config.js', () => ({ config: cfg }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserAllowDownloads: async (_db: unknown, userId: string) => ({
        allowDownloads: overrides.get(userId) ?? null,
        groups: [],
    }),
}));

const { mockAllowsLiveTv } = vi.hoisted(() => ({
    mockAllowsLiveTv: vi.fn().mockResolvedValue(true),
}));
vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({ userAllowsLiveTv: mockAllowsLiveTv }));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

vi.mock('$lib/server/cache/valkey', () => ({
    cacheSet: vi.fn(async () => undefined),
    cacheGet: vi.fn(async () => null),
    getValkeyClient: vi.fn(() => null),
    connectValkey: vi.fn(async () => true),
    isValkeyReady: vi.fn(() => false),
    getKeysByPattern: vi.fn(async () => []),
    del: vi.fn(async () => undefined),
}));

vi.mock('$lib/server/jellyfin-compat/middleware', () => ({
    parseEmbyAuthHeader: () => ({}),
}));
vi.mock('$lib/server/auth', () => ({ hasGroupPermission: () => false }));
vi.mock('$lib/server/jellyfin-compat/user-playback-preferences', () => ({
    loadUserPlaybackPreferences: vi.fn(async () => null),
}));
vi.mock('$lib/server/jellyfin-compat/playback-utils', () => ({
    clampJellyfinDeviceId: () => '',
}));

const mockValidatePassword = vi.fn();
vi.mock('$lib/server/jellyfin-compat/auth', () => ({
    validatePassword: (...args: unknown[]) =>
        (mockValidatePassword as unknown as (...a: unknown[]) => unknown)(...args),
    createSession: vi.fn(async () => 'faketoken'),
}));

import { POST } from './+server.js';

function makeEvent(username: string, password: string, peer: string): RequestEvent {
    const url = new URL('http://localhost/j/Users/AuthenticateByName');
    const request = new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Username: username, Pw: password }),
    });
    return {
        url,
        request,
        params: {},
        route: { id: null },
        locals: {},
        cookies: {
            get: () => undefined,
            getAll: () => [],
            set: vi.fn(),
            delete: vi.fn(),
            serialize: vi.fn(),
        },
        fetch: vi.fn(),
        getClientAddress: () => peer,
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    overrides.clear();
    mockAllowsLiveTv.mockReset().mockResolvedValue(true);
});

describe('AuthenticateByName: login User.Policy reports the logging-in user’s download permission', () => {
    it('is true for a user who may download', async () => {
        mockValidatePassword.mockResolvedValue({
            userId: 'useron',
            username: 'alice',
            isAdmin: false,
            groups: [],
            displayName: 'Alice',
        });
        const res = await POST(makeEvent('alice', 'pw', '203.0.113.61'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.User.Policy.EnableContentDownloading).toBe(true);
    });

    it('is false for a user whose download override is false', async () => {
        overrides.set('useroff', false);
        mockValidatePassword.mockResolvedValue({
            userId: 'useroff',
            username: 'bob',
            isAdmin: false,
            groups: [],
            displayName: 'Bob',
        });
        const res = await POST(makeEvent('bob', 'pw', '203.0.113.62'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.User.Policy.EnableContentDownloading).toBe(false);
    });
});
