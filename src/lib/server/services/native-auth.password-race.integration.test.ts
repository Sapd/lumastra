// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { randomUUID, scryptSync } from 'node:crypto';
import postgres from 'postgres';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { getTestDatabaseUrl } from '../../../../tests/integration/setup/test-database.js';

// Keep password/session SQL real; isolate unrelated identity/cache/provider work.
vi.mock('$lib/server/middleware/forward-auth.js', () => ({ invalidateAdminExistsCache: vi.fn() }));
vi.mock('$lib/server/services/user-identity.service.js', () => ({
    recordIdentityBestEffort: vi.fn(),
    PROVIDER_NATIVE: 'native',
    PROVIDER_FORWARD_AUTH: 'forward-auth',
}));
vi.mock('$lib/server/services/credential-revocation.service.js', async () => {
    const { revokeAllUserSessions, revokeAllUserSessionsExcept } =
        await import('../database/queries/user-sessions.queries.js');
    const { createHash } = await import('node:crypto');
    return {
        revokeAllCredentialsForUser: async (
            sql: postgres.Sql,
            id: string,
            _username: string,
            opts: { keepSessionToken?: string } = {},
        ) => {
            if (opts.keepSessionToken)
                await revokeAllUserSessionsExcept(
                    sql,
                    id,
                    createHash('sha256').update(opts.keepSessionToken).digest('hex'),
                );
            else await revokeAllUserSessions(sql, id);
            return { failedStores: [], counts: {} };
        },
    };
});
vi.mock('../database/connection.js', () => ({
    Database: class {
        getSql() {
            return loginSql;
        }
    },
}));
import * as password from '../crypto/password.js';
import { attemptLogin, changeOwnPassword } from './native-auth.service.js';
import { resetPassword } from './admin-user.service.js';
import { rehashUserPassword } from '../database/queries/users.queries.js';
import { getSessionService } from './session.service.js';

let loginSql: postgres.Sql;
let resetSql: postgres.Sql;
let observerSql: postgres.Sql;
const resetApp = `pwreset_${randomUUID()}`;
const ids: string[] = [];
const OLD = 'Old!Passphrase-for-race-2026';
const NEW = 'New!Passphrase-for-race-2026';

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
async function user(legacy = false) {
    const username = `race_${randomUUID()}`;
    const salt = Buffer.alloc(16, 7);
    const hash = legacy
        ? `scrypt$N=16384,r=8,p=1$${salt.toString('base64')}$${scryptSync(OLD, salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`
        : await password.hashPassword(OLD);
    const [row] = await resetSql<
        { id: string }[]
    >`INSERT INTO users (username, password_hash) VALUES (${username}, ${hash}) RETURNING id`;
    ids.push(row.id);
    return { username, id: row.id };
}

beforeAll(() => {
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
    await resetSql`DELETE FROM users WHERE id IN ${resetSql(ids)}`;
    await Promise.all([loginSql.end(), resetSql.end(), observerSql.end()]);
});

describe('password reset fences concurrent password logins (real PostgreSQL)', () => {
    it('rejects a login paused after reading the old hash, after reset and revocation complete', async () => {
        const account = await user();
        const existing = await attemptLogin(loginSql, {
            username: account.username,
            password: OLD,
        });
        expect(existing).not.toBeNull();
        const pause = gate();
        const verify = password.verifyPassword;
        vi.spyOn(password, 'verifyPassword').mockImplementationOnce(async (...args) => {
            await pause.hook();
            return verify(...args);
        });
        const pending = attemptLogin(loginSql, { username: account.username, password: OLD });
        await pause.paused;
        try {
            expect(
                (
                    await resetPassword(resetSql, {
                        targetUsername: account.username,
                        newPassword: NEW,
                    })
                ).ok,
            ).toBe(true);
        } finally {
            pause.resume();
        }
        const stale = await pending;
        expect(stale && (await getSessionService().validate(stale.token))).toBeNull();
        expect(await getSessionService().validate(existing!.token)).toBeNull();
        expect(
            await attemptLogin(loginSql, { username: account.username, password: NEW }),
        ).not.toBeNull();
    });

    it('a delayed opportunistic rehash cannot overwrite the reset password', async () => {
        const account = await user(true);
        const pause = gate();
        const hash = password.hashPassword;
        vi.spyOn(password, 'hashPassword').mockImplementationOnce(async (plain) => {
            await pause.hook();
            return hash(plain);
        });
        const pending = attemptLogin(loginSql, { username: account.username, password: OLD });
        await pause.paused;
        try {
            expect(
                (
                    await resetPassword(resetSql, {
                        targetUsername: account.username,
                        newPassword: NEW,
                    })
                ).ok,
            ).toBe(true);
        } finally {
            pause.resume();
        }
        const stale = await pending;
        const [row] = await resetSql<
            { password_hash: string }[]
        >`SELECT password_hash FROM users WHERE id = ${account.id}`;
        expect(await password.verifyPassword(NEW, row.password_hash)).toBe(true);
        expect(await password.verifyPassword(OLD, row.password_hash)).toBe(false);
        expect(stale && (await getSessionService().validate(stale.token))).toBeNull();
    });

    it('rejects a stale current-password change after an admin reset', async () => {
        const account = await user();
        const pause = gate();
        const verify = password.verifyPassword;
        vi.spyOn(password, 'verifyPassword').mockImplementationOnce(async (...args) => {
            await pause.hook();
            return verify(...args);
        });
        const pending = changeOwnPassword(loginSql, {
            username: account.username,
            currentPassword: OLD,
            newPassword: 'Other!Passphrase-for-race-2026',
        });
        await pause.paused;
        try {
            await resetPassword(resetSql, { targetUsername: account.username, newPassword: NEW });
        } finally {
            pause.resume();
        }
        expect((await pending).ok).toBe(false);
    });
    it('holds the user lock through session insertion so a later reset revokes the issued session', async () => {
        const account = await user();
        const pause = gate();
        const sessions = getSessionService();
        const create = sessions.create.bind(sessions);
        vi.spyOn(sessions, 'create').mockImplementationOnce(async (...args) => {
            await pause.hook();
            return create(...args);
        });
        const pending = attemptLogin(loginSql, { username: account.username, password: OLD });
        await pause.paused;
        const resetting = resetPassword(resetSql, {
            targetUsername: account.username,
            newPassword: NEW,
        });
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
        const issued = await pending;
        expect(issued).not.toBeNull();
        expect((await resetting).ok).toBe(true);
        expect(await sessions.validate(issued!.token)).toBeNull();
    });

    it('upgrades a legacy password without replacing a newer hash (CAS control)', async () => {
        const account = await user(true);
        const [before] = await resetSql<
            { password_hash: string }[]
        >`SELECT password_hash FROM users WHERE id = ${account.id}`;
        expect(
            await attemptLogin(loginSql, { username: account.username, password: OLD }),
        ).not.toBeNull();
        const [after] = await resetSql<
            { password_hash: string }[]
        >`SELECT password_hash FROM users WHERE id = ${account.id}`;
        expect(password.needsRehash(after.password_hash)).toBe(false);
        expect(await password.verifyPassword(OLD, after.password_hash)).toBe(true);
        expect(
            await rehashUserPassword(resetSql, account.id, before.password_hash, 'stale-upgrade'),
        ).toBe(false);
        expect(
            await attemptLogin(loginSql, { username: account.username, password: OLD }),
        ).not.toBeNull();
        expect(
            await attemptLogin(loginSql, {
                username: account.username,
                password: 'wrong-password',
            }),
        ).toBeNull();
    });

    it('keeps the new current-device session and revokes the old one on a normal password change', async () => {
        const account = await user();
        const oldSession = await attemptLogin(loginSql, {
            username: account.username,
            password: OLD,
        });
        const changed = await changeOwnPassword(loginSql, {
            username: account.username,
            currentPassword: OLD,
            newPassword: NEW,
        });
        expect(changed.ok).toBe(true);
        if (!changed.ok) throw new Error('password change failed');
        expect(await getSessionService().validate(changed.session.token)).not.toBeNull();
        expect(await getSessionService().validate(oldSession!.token)).toBeNull();
    });
});
