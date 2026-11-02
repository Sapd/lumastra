// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

/**
 * Security review 2026-09-13, C2 — end-to-end coverage that
 * `POST /j/Users/AuthenticateByName` refuses a DISABLED user even when the
 * password is correct. Unlike `server.test.ts` (which mocks `validatePassword`
 * entirely to isolate the C24 rate-limit behaviour), this file drives the
 * REAL `validatePassword` and the real route handler — only the DB query
 * module is faked, reproducing the real join's
 * `AND u.disabled_at IS NULL` filter, so the seam under test is the same one
 * production hits: a correct scrypt verify that the query never gets the
 * chance to reach because the row was excluded.
 */

vi.mock('$lib/server/services/user-credential-lock', () => ({
    withUserCredentialLock: async (
        sql: unknown,
        _id: string,
        work: (tx: unknown) => Promise<unknown>,
    ) => work(sql),
}));

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RequestEvent } from '@sveltejs/kit';

process.env.LUMASTRA_MASTER_KEY = 'e'.repeat(64);

vi.mock('$lib/server/auth/livetv-user-policy.js', () => ({
    userAllowsLiveTv: vi.fn().mockResolvedValue(true),
}));

vi.mock('$lib/server/utils/logger', () => ({
    Logger: {
        for: () => ({ warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
    },
}));

// Same in-memory-fallback shape as server.test.ts (C24) so the real
// valkey-rate-limit middleware runs without a live Valkey connection.
vi.mock('$lib/server/cache/valkey', () => ({
    cacheSet: vi.fn(async () => undefined),
    cacheGet: vi.fn(async () => null),
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

vi.mock('$lib/server/proprietary/jellyfin-compat/middleware', () => ({
    parseEmbyAuthHeader: () => ({}),
}));

vi.mock('$lib/server/auth', () => ({
    hasGroupPermission: () => false,
}));

vi.mock('$lib/server/config', () => ({
    config: { LIVETV_GROUPS: [] },
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/user-playback-preferences', () => ({
    loadUserPlaybackPreferences: vi.fn(async () => null),
}));
vi.mock('$lib/server/proprietary/jellyfin-compat/serializers/user', () => ({
    serializeUser: (u: { id: string; username: string }) => ({ Id: u.id, Name: u.username }),
}));

vi.mock('$lib/server/proprietary/jellyfin-compat/playback-utils', () => ({
    clampJellyfinDeviceId: (raw: unknown) => (typeof raw === 'string' ? raw : ''),
}));

// Security review 2026-09-16, C5: createSession() (called after a successful
// validatePassword) now ALSO re-checks disabled_at/deleted_at via
// resolveTokenUserAccess — this file's own seam under test is
// validatePassword's DB-level exclusion (the disabled case never reaches
// createSession at all), so resolveTokenUserAccess is mocked to
// unconditionally report an active account, matching this route's OWN
// pre-existing `$lib/server/auth` mock (which only stubs hasGroupPermission,
// not the buildUserPermissions resolveTokenUserAccess needs).
vi.mock('$lib/server/auth/resolve-token-user-access', () => ({
    resolveTokenUserAccess: async () => ({
        userGroups: [] as string[],
        disabled: false,
        deleted: false,
        permissions: {} as never,
    }),
}));

// Avoids dragging the task-system module graph in for a route the rotation
// task doesn't touch — validatePassword never calls either export.
vi.mock('$lib/server/tasks/secrets', () => ({
    jellyfinClientPasswordContext: (userId: string) => userId,
    rotateJellyfinClientPasswords: vi.fn(),
}));

vi.mock('$lib/server/database/connection', () => ({
    Database: class {
        getSql() {
            return null;
        }
    },
}));

interface StoredRow {
    id: number;
    user_id: string;
    password_hash: string;
    password_sealed: string | null;
    created_at: Date;
    last_used_at: Date | null;
    native_password_hash?: string | null;
    username: string;
    is_admin: boolean;
    display_name: string | null;
    groups: string[] | null;
    disabled: boolean;
}

const { rows } = vi.hoisted(() => ({ rows: new Map<string, StoredRow>() }));

vi.mock('$lib/server/database/queries/jellyfin-client-passwords.queries', () => ({
    getPasswordByUserId: {
        one: async (_sql: unknown, { userId }: { userId: string }) => rows.get(userId) ?? null,
    },
    // Mirrors the real query's `JOIN users u ... AND u.disabled_at IS NULL`.
    getPasswordByUsername: {
        one: async (_sql: unknown, { username }: { username: string }) =>
            Array.from(rows.values()).find((r) => r.username === username && !r.disabled) ?? null,
    },
    upsertPassword: {
        execute: async (
            _sql: unknown,
            {
                userId,
                passwordHash,
                passwordSealed,
            }: { userId: string; passwordHash: string; passwordSealed: string | null },
        ) => {
            const existing = rows.get(userId);
            rows.set(userId, {
                id: 1,
                user_id: userId,
                password_hash: passwordHash,
                password_sealed: passwordSealed,
                created_at: new Date(0),
                last_used_at: null,
                native_password_hash: null,
                username: existing?.username ?? 'gatekept',
                is_admin: existing?.is_admin ?? false,
                display_name: existing?.display_name ?? null,
                groups: existing?.groups ?? [],
                disabled: existing?.disabled ?? false,
            });
            return [{ id: 1 }];
        },
    },
    updateLastUsed: { execute: async () => [] },
    deletePassword: { execute: async () => [] },
    getUsersWithPasswords: { all: async () => [] },
}));

const { getOrCreatePassword } = await import('$lib/server/proprietary/jellyfin-compat/auth.js');
const { POST } = await import('./+server.js');

function makeEvent(opts: { username: string; password: string }): RequestEvent {
    const url = new URL('http://localhost/j/Users/AuthenticateByName');
    const headers = new Headers({ 'content-type': 'application/json' });
    const body = JSON.stringify({ Username: opts.username, Pw: opts.password });
    const request = new Request(url, { method: 'POST', headers, body });

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
        getClientAddress: () => '203.0.113.10',
        platform: undefined,
        isDataRequest: false,
        isSubRequest: false,
        setHeaders: vi.fn(),
    } as unknown as RequestEvent;
}

beforeEach(() => {
    rows.clear();
    vi.clearAllMocks();
});

describe('POST /j/Users/AuthenticateByName: disabled user rejected end-to-end (C2)', () => {
    it('refuses login for a disabled user even with the correct password', async () => {
        const pin = await getOrCreatePassword('u1');
        rows.get('u1')!.disabled = true;

        const response = await POST(makeEvent({ username: 'gatekept', password: pin }));

        expect(response.status).toBe(401);
    });

    it('accepts the SAME password once the user is NOT disabled (control)', async () => {
        const pin = await getOrCreatePassword('u1');

        const response = await POST(makeEvent({ username: 'gatekept', password: pin }));

        expect(response.status).toBe(200);
    });
});
