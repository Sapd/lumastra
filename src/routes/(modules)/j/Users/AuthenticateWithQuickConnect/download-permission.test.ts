// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * The Quick Connect login response's User.Policy.EnableContentDownloading is
 * the approved user's download permission. A Quick Connect session is never
 * admin for downloads (its principal sets sessionIsAdmin false), so the admin
 * flag does not grant the permission here.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

const cfg = vi.hoisted(() => ({
    FEATURE_MEDIA_DOWNLOAD: true,
    DOWNLOADS_ALLOWED_BY_DEFAULT: true,
    UNRATED_CONTENT_VISIBLE: true,
    FEATURE_LIVETV: false,
    LIVETV_GROUPS: [] as string[],
}));
const overrides = vi.hoisted(() => new Map<string, boolean | null>());

vi.mock('$lib/server/config', () => ({ config: cfg }));
vi.mock('$lib/server/config.js', () => ({ config: cfg }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => ({}) }));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserAllowDownloads: async (_db: unknown, userId: string) => overrides.get(userId) ?? null,
}));

vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({
    userAllowsLiveTv: vi.fn(async () => true),
}));
vi.mock('$lib/server/utils/logger', () => ({
    Logger: { for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }) },
}));

// The approved Quick Connect secret the route reads once from Valkey.
const qcData = vi.hoisted(() => ({ value: '' as string }));
vi.mock('$lib/server/cache/valkey', () => ({
    cacheGet: vi.fn(async () => qcData.value),
    cacheSet: vi.fn(async () => undefined),
    cacheDel: vi.fn(async () => 0),
    cacheExists: vi.fn(async () => false),
    expire: vi.fn(async () => true),
    sAdd: vi.fn(async () => 0),
    sRem: vi.fn(async () => 0),
    sMembers: vi.fn(async () => []),
    getCoordinationClient: vi.fn(() => null),
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
vi.mock('$lib/server/jellyfin-compat/auth', () => ({
    createSession: vi.fn(async () => 'faketoken'),
}));

import { POST } from './+server.js';

function makeEvent(peer: string): RequestEvent {
    const url = new URL('http://localhost/j/Users/AuthenticateWithQuickConnect');
    const request = new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ Secret: 'a'.repeat(32) }),
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

function approved(userId: string, username: string, isAdmin: boolean): string {
    return JSON.stringify({
        authenticated: true,
        code: 'c'.repeat(8),
        approvedBySessionToken: 'approver-token',
        userId,
        username,
        isAdmin,
        groups: [],
        displayName: username,
    });
}

beforeEach(() => {
    overrides.clear();
});

describe('AuthenticateWithQuickConnect: login User.Policy reports the approved user’s download permission', () => {
    it('is true for an approved user who may download', async () => {
        qcData.value = approved('useron', 'alice', false);
        const res = await POST(makeEvent('203.0.113.71'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.User.Policy.EnableContentDownloading).toBe(true);
    });

    it('is false for an approved user whose download override is false', async () => {
        overrides.set('useroff', false);
        qcData.value = approved('useroff', 'bob', false);
        const res = await POST(makeEvent('203.0.113.72'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.User.Policy.EnableContentDownloading).toBe(false);
    });

    it('does not grant an approved admin downloads through the admin flag (no admin session)', async () => {
        overrides.set('useradm', false);
        qcData.value = approved('useradm', 'carol', true);
        const res = await POST(makeEvent('203.0.113.73'));
        expect(res.status).toBe(200);
        const body = await res.json();
        expect(body.User.Policy.EnableContentDownloading).toBe(false);
    });
});
