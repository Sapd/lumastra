// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: LicenseRef-Lumastra-Proprietary
// Proprietary and source-available — not licensed under AGPL. See LICENSING.md.

import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTestDatabaseUrl } from '../../../../../tests/integration/setup/test-database.js';

vi.mock('$lib/server/database/connection', () => ({
    Database: class {
        getSql() {
            return loginSql;
        }
    },
}));

vi.mock('$lib/server/middleware/forward-auth.js', () => ({ invalidateAdminExistsCache: vi.fn() }));
vi.mock('$lib/server/services/user-identity.service.js', () => ({
    recordIdentityBestEffort: vi.fn(),
    PROVIDER_NATIVE: 'native',
    PROVIDER_FORWARD_AUTH: 'forward-auth',
}));
vi.mock('$lib/server/services/credential-revocation.service.js', () => ({
    revokeAllCredentialsForUser: async (sql: postgres.Sql, id: string) => {
        const { revokeAllUserSessions } =
            await import('$lib/server/database/queries/user-sessions.queries.js');
        const { revokeSessionsForUser } = await import('./auth');
        await revokeAllUserSessions(sql, id);
        await revokeSessionsForUser(id);
        return { failedStores: [], counts: {} };
    },
}));
import * as valkey from '$lib/server/cache/valkey';
import { connectValkey, disconnectValkey } from '$lib/server/cache/valkey';
import { resetPassword as resetNativePassword } from '$lib/server/services/admin-user.service.js';
import { getPasswordByUsername } from '$lib/server/database/queries/jellyfin-client-passwords.queries';
import {
    getOrCreatePassword,
    validatePassword,
    createSession,
    validateSession,
    revokeSessionsForUser,
    resetPassword as resetClientPassword,
} from './auth';
import type { JellyfinSession } from './auth';

let loginSql: postgres.Sql;
let resetSql: postgres.Sql;
let observerSql: postgres.Sql;
const resetApp = `jfpwreset_${randomUUID()}`;
const accounts: string[] = [];
function gate() {
    let reached!: () => void;
    let resume!: () => void;
    const paused = new Promise<void>((r) => {
        reached = r;
    });
    const released = new Promise<void>((r) => {
        resume = r;
    });
    return {
        paused,
        resume,
        hook: async () => {
            reached();
            await released;
        },
    };
}
function session(user: NonNullable<Awaited<ReturnType<typeof validatePassword>>>): JellyfinSession {
    return {
        ...user,
        deviceId: 'race-device',
        deviceName: 'race',
        clientName: 'test',
        clientVersion: '1',
        createdAt: new Date().toISOString(),
    };
}
beforeAll(async () => {
    expect(await connectValkey()).toBe(true);
    loginSql = postgres(getTestDatabaseUrl(), { max: 1 });
    resetSql = postgres(getTestDatabaseUrl(), {
        max: 1,
        connection: { application_name: resetApp },
    });
    observerSql = postgres(getTestDatabaseUrl(), { max: 1 });
});

afterEach(() => {
    vi.restoreAllMocks();
});
afterAll(async () => {
    for (const id of accounts) await revokeSessionsForUser(id);
    await resetSql`DELETE FROM users WHERE id IN ${resetSql(accounts)}`;
    await Promise.all([loginSql.end(), resetSql.end(), observerSql.end()]);
    await disconnectValkey();
});

// Native password replacement, session SQL and the /j Valkey sweep are real.
// Unrelated credential stores are isolated above.
async function nativeReset(id: string): Promise<void> {
    const [user] = await observerSql<
        { username: string }[]
    >`SELECT username FROM users WHERE id = ${id}`;
    expect(
        (
            await resetNativePassword(resetSql, {
                targetUsername: user.username,
                newPassword: 'Replacement!Passphrase-for-race-2026',
            })
        ).ok,
    ).toBe(true);
}
async function account() {
    const username = `jfrace_${randomUUID()}`;
    const [row] = await resetSql<
        { id: string }[]
    >`INSERT INTO users (username) VALUES (${username}) RETURNING id`;
    accounts.push(row.id);
    return { id: row.id, username, pin: await getOrCreatePassword(row.id) };
}

describe('/j password issuance vs credential replacement (real Postgres and Valkey)', () => {
    it('does not mint a usable session from a hash read before native reset + revocation', async () => {
        const user = await account();
        const pause = gate();
        const read = getPasswordByUsername.one;
        vi.spyOn(getPasswordByUsername, 'one').mockImplementationOnce(async (...args) => {
            const row = await read(...args);
            await pause.hook();
            return row;
        });
        const pending = validatePassword(user.username, user.pin);
        await pause.paused;
        try {
            await nativeReset(user.id);
        } finally {
            pause.resume();
        }
        const verified = await pending;
        expect(verified).not.toBeNull();
        // The second argument binds issuance to the verified snapshot.
        const token = await createSession(session(verified!), verified!);
        expect(token && (await validateSession(token, '/j/Users/Me'))).toBeNull();
        const fresh = await validatePassword(user.username, user.pin);
        expect(await createSession(session(fresh!), fresh!)).not.toBeNull();
    });

    it('does not mint from a replaced client password; the new password still works', async () => {
        const user = await account();
        const verified = await validatePassword(user.username, user.pin);
        const next = await resetClientPassword(user.id);
        const token = await createSession(session(verified!), verified!);
        expect(token && (await validateSession(token, '/j/Users/Me'))).toBeNull();
        const fresh = await validatePassword(user.username, next);
        expect(await createSession(session(fresh!), fresh!)).not.toBeNull();
    });
    it('holds the lock through the Valkey mint so a later reset sweeps the new session', async () => {
        const user = await account();
        const verified = await validatePassword(user.username, user.pin);
        const pause = gate();
        const write = valkey.cacheSet;
        vi.spyOn(valkey, 'cacheSet').mockImplementationOnce(async (...args) => {
            await pause.hook();
            return write(...args);
        });
        const pending = createSession(session(verified!), verified!);
        await pause.paused;
        const resetting = nativeReset(user.id);
        try {
            await expect
                .poll(
                    async () => {
                        const [row] = await observerSql<{ waiting: boolean }[]>`
                    SELECT EXISTS (SELECT 1 FROM pg_stat_activity
                        WHERE application_name = ${resetApp} AND wait_event = 'advisory') AS waiting
                `;
                        return row.waiting;
                    },
                    { timeout: 5000 },
                )
                .toBe(true);
        } finally {
            pause.resume();
        }
        const token = await pending;
        expect(token).not.toBeNull();
        await resetting;
        expect(await validateSession(token!, '/j/Users/Me')).toBeNull();
    });
});
