// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Native (built-in) login orchestration: verifying credentials, provisioning the
 * first admin, changing passwords — coordinating the password store
 * (users.password_hash), the session store, and the AUTH_NATIVE_LOGIN_ENABLED
 * config flag. AGPL-core; never touches the proprietary `/j` password store.
 *
 * HTTP concerns (rate limiting, cookies, status codes) live in the route
 * handlers; this layer is pure logic so it can be unit/integration tested.
 */

import type postgres from 'postgres';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';
import { hashPassword, verifyPassword, needsRehash } from '$lib/server/crypto/password.js';
import { validatePasswordPolicy } from '$lib/shared/password-strength.js';
import { getSessionService } from '$lib/server/services/session.service.js';
import { revokeAllCredentialsForUser } from '$lib/server/services/credential-revocation.service.js';
import {
    adminExists,
    createNativeAdmin,
    getNativeLoginRecord,
    setUserPassword,
    rehashUserPassword,
    upsertUser,
    getUserByUsername,
    markSetupCompleted,
    FIRST_ADMIN_LOCK_KEY,
} from '$lib/server/database/queries/users.queries.js';
import { ensureUserProfileExists } from '$lib/server/database/queries/user-ratings.queries.js';
import { withUserCredentialLock } from './user-credential-lock.js';
import { inSavepoint, withTx } from '$lib/server/database/with-tx.js';
import { invalidateAdminExistsCache } from '$lib/server/middleware/forward-auth.js';
import { toUserId } from '$lib/shared/user-id.js';
import {
    recordIdentityBestEffort,
    PROVIDER_NATIVE,
    PROVIDER_FORWARD_AUTH,
} from '$lib/server/services/user-identity.service.js';
import { isReservedUsername } from '$lib/server/services/reserved-usernames.js';
import { invalidateGroupDerivedCaches } from '$lib/server/services/user-groups.service.js';

const logger = Logger.for('NativeAuth');

export interface SessionIssue {
    token: string;
    expiresAt: Date;
}

/** Acceptable username shape for a native account. */
const USERNAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{1,62}$/;

/**
 * Shared shape/reservation gate for every path that lets an operator pick a
 * native username outright (first-admin setup, admin-created users): shape
 * first, then reject a name reserved for an internal actor (`system`) so a
 * real account can never collide with a sentinel a security check treats
 * specially.
 */
export function validateUsername(username: string): string | null {
    if (!username || !USERNAME_RE.test(username)) {
        return 'Username must be 2–63 characters: letters, digits, dot, dash or underscore, starting with a letter or digit.';
    }
    if (isReservedUsername(username)) {
        return 'This username is reserved and cannot be used.';
    }
    return null;
}

/**
 * Verify a username/password and, on success, issue a fresh session (rotation on
 * login = a new token each time). Returns null on any failure WITHOUT revealing
 * whether the username or the password was wrong (no user enumeration).
 */
export async function attemptLogin(
    sql: postgres.Sql,
    params: { username: string; password: string; userAgent?: string | null; ip?: string | null },
): Promise<SessionIssue | null> {
    const record = await getNativeLoginRecord(sql, params.username);

    // Constant-ish work whether or not the user exists / has a password: always
    // run a verify so timing doesn't distinguish "no such user" from "wrong
    // password". When there's no stored hash we verify against a throwaway.
    const storedHash =
        record?.password_hash ??
        // A well-formed but non-matching hash so verifyPassword does real work.
        'scrypt$N=65536,r=8,p=1$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const ok = await verifyPassword(params.password, storedHash);

    // A disabled account is rejected with the SAME generic failure as a bad
    // password (no enumeration of suspended accounts). The verify above still ran,
    // so timing doesn't distinguish the cases.
    if (!record || !record.password_hash || !ok || record.disabled_at) {
        logger.warn('Native login failed', {
            username: params.username.toLowerCase(),
            disabled: Boolean(record?.disabled_at),
        });
        return null;
    }

    // Derive outside the lock; the verified hash is the password version.
    let upgraded: string | null = null;
    if (needsRehash(record.password_hash)) {
        try {
            upgraded = await hashPassword(params.password);
        } catch {
            // A KDF upgrade is best-effort; credential fencing is mandatory.
        }
    }
    const session = await withUserCredentialLock(sql, record.id, async (tx) => {
        const current = await getNativeLoginRecord(tx, record.username);
        if (
            !current ||
            current.id !== record.id ||
            current.disabled_at ||
            current.password_hash !== storedHash
        )
            return null;
        if (upgraded) {
            const upgradedHash = upgraded;
            // A failed optional write must not poison the issuance transaction.
            await inSavepoint(tx, (sp) =>
                rehashUserPassword(sp, record.id, storedHash, upgradedHash),
            );
        }
        return getSessionService().create(
            {
                userId: record.id,
                userAgent: params.userAgent ?? null,
                ip: params.ip ?? null,
            },
            tx,
        );
    });
    if (!session) return null;
    const { token, expiresAt } = session;
    // Record the native identity in the federation ledger (best-effort, additive).
    await recordIdentityBestEffort(sql, {
        provider: PROVIDER_NATIVE,
        subject: record.username.toLowerCase(),
        userId: record.id,
    });
    logger.info('Native login succeeded', { username: record.username });
    return { token, expiresAt };
}

export type SetupResult =
    | { ok: true; session: SessionIssue; oidcConfigDiscarded: boolean }
    | { ok: false; status: number; message: string };

/**
 * The OIDC settings `/api/setup/oidc-config` writes. That endpoint is public
 * while no admin exists, so whatever it saved may come from any visitor.
 */
const PRE_ADMIN_OIDC_KEYS = [
    'AUTH_OIDC_ENABLED',
    'AUTH_OIDC_ISSUER',
    'AUTH_OIDC_CLIENT_ID',
    'AUTH_OIDC_CLIENT_SECRET',
    'AUTH_OIDC_PROVIDER_NAME',
    'AUTH_OIDC_SCOPES',
    'AUTH_OIDC_GROUPS_CLAIM',
] as const;

/**
 * Setup finished WITHOUT single sign-on (built-in account or forward auth):
 * reset the OIDC settings written while no admin existed. Anyone who reached the
 * unonboarded instance could have saved their own identity provider there, and
 * it would outlive the operator's own setup: its next new user with an admin
 * group claim (`ADMIN_GROUPS` defaults to "admin") is provisioned as an admin.
 * Environment-set keys are the operator's and stay. Returns whether anything
 * was reset; the wizard tells the admin to set SSO up again in the settings.
 *
 * Runs after the admin row committed: `/api/setup/oidc-config` writes under
 * `FIRST_ADMIN_LOCK_KEY` and re-checks for an admin, so no write can land
 * after this reset.
 */
export async function discardPreAdminOidcConfig(): Promise<boolean> {
    try {
        const configService = await import('$lib/server/config/config.service.js');
        const { getSettingDefinition } = await import('$lib/config/schema.js');
        const resets: Record<string, unknown> = {};
        for (const key of PRE_ADMIN_OIDC_KEYS) {
            if (configService.isEnvOverridden(key)) continue;
            const defaultValue = getSettingDefinition(key)?.defaultValue;
            if (configService.get(key) !== defaultValue) resets[key] = defaultValue;
        }
        if (Object.keys(resets).length === 0) return false;
        await configService.saveConfig(resets);
        const { resetOidcConfigCache } = await import('$lib/server/services/oidc.service.js');
        resetOidcConfigCache();
        logger.warn(
            'Setup completed without single sign-on; removed the OIDC settings entered before an admin existed. Configure SSO again in Admin → Settings if you want it.',
            { keys: Object.keys(resets) },
        );
        return true;
    } catch (error) {
        logger.error('Could not remove OIDC settings entered before an admin existed', {
            error: String(error),
        });
        return false;
    }
}

/**
 * First-run: create the first native admin and issue a session. Enables native
 * login (AUTH_NATIVE_LOGIN_ENABLED) so subsequent unauthenticated visitors are
 * sent to /login. Guarded so it is a no-op once any admin exists.
 */
export async function completeNativeSetup(
    sql: postgres.Sql,
    params: { username: string; password: string; userAgent?: string | null; ip?: string | null },
): Promise<SetupResult> {
    if (await adminExists(sql, config.ADMIN_GROUPS)) {
        return { ok: false, status: 409, message: 'Setup has already been completed.' };
    }

    const usernameError = validateUsername(params.username);
    if (usernameError) return { ok: false, status: 400, message: usernameError };

    const passwordError = validatePasswordPolicy(params.password);
    if (passwordError) return { ok: false, status: 400, message: passwordError };

    const passwordHash = await hashPassword(params.password);
    const userId = await createNativeAdmin(sql, {
        username: params.username,
        passwordHash,
        groups: config.ADMIN_GROUPS,
        adminGroupNames: config.ADMIN_GROUPS,
    });

    if (!userId) {
        // Lost the race — another setup submission created the admin first.
        return { ok: false, status: 409, message: 'Setup has already been completed.' };
    }

    // createNativeAdmin writes is_admin/admin_pinned/groups (a fifth writer of
    // group-derived state, security review 5 MINOR 3 — it's a different query
    // than upsertUserGroups, so the no-restricted-imports rule and the
    // architecture test don't cover it) and has already committed by the time
    // this call returns (its own withTx). Invalidate the admin/max-age caches
    // it feeds so a same-username promote/demote race (the ON CONFLICT DO
    // UPDATE path) can't leave a stale cached value. Harmless on the common
    // fresh-insert path too, since nothing was cached for a brand-new user yet.
    invalidateGroupDerivedCaches(params.username);

    // First-run is over for everyone now.
    invalidateAdminExistsCache();

    // Ensure FK-dependent tables (ratings/watchlist) have a profile row.
    // user_profiles.user_id is the users.id UUID (mig 16.46.0).
    try {
        await ensureUserProfileExists(sql, toUserId(userId));
    } catch {
        // Best-effort; not fatal to setup.
    }

    // Turn on native login so unauthenticated visitors are routed to /login.
    await enableNativeLogin();
    const oidcConfigDiscarded = await discardPreAdminOidcConfig();

    await recordIdentityBestEffort(sql, {
        provider: PROVIDER_NATIVE,
        subject: params.username.toLowerCase(),
        userId,
    });

    const session = await getSessionService().create({
        userId,
        userAgent: params.userAgent ?? null,
        ip: params.ip ?? null,
    });
    logger.info('Native admin created via onboarding', { username: params.username.toLowerCase() });
    return { ok: true, session, oidcConfigDiscarded };
}

/** Forward-auth setup found the account pinned as a non-admin (rolled back). */
class PinnedNonAdminSetupError extends Error {
    constructor() {
        super('Account is pinned as a non-admin');
        this.name = 'PinnedNonAdminSetupError';
    }
}

/**
 * First-run: complete onboarding for a forward-auth deployment. Verifies the
 * trusted forward-auth identity is in the admin group and provisions the admin
 * user row so first-run is satisfied. Does NOT enable native login and issues no
 * cookie — the user is already authenticated by the proxy headers.
 */
export async function completeForwardAuthSetup(
    sql: postgres.Sql,
    identity: { username: string; groups: string[]; isAdmin: boolean },
): Promise<
    { ok: true; oidcConfigDiscarded: boolean } | { ok: false; status: number; message: string }
> {
    if (await adminExists(sql, config.ADMIN_GROUPS)) {
        return { ok: false, status: 409, message: 'Setup has already been completed.' };
    }
    // Same reservation every other provisioning path applies.
    if (isReservedUsername(identity.username)) {
        return { ok: false, status: 400, message: 'This username is reserved.' };
    }
    if (!identity.isAdmin) {
        return {
            ok: false,
            status: 403,
            message:
                'The first user must be a member of an admin group. Add your user to an admin group in your identity provider (see ADMIN_GROUPS), then try again.',
        };
    }

    const usernameLower = identity.username.toLowerCase();

    // SECURITY: same first-admin bootstrap TOCTOU as createNativeAdmin — the
    // adminExists() check above and the upsertUser() write are not atomic on
    // their own, so two concurrent first-run submissions (two forward-auth
    // identities, or one forward-auth + one native) could both see "no admin
    // yet" and both provision an admin. Share createNativeAdmin's advisory-lock
    // key so ANY first-run bootstrap path serializes against every other one,
    // then re-check adminExists INSIDE the lock before writing.
    // withTx (not raw sql.begin): `sql` here may already be a TransactionSql /
    // ReservedSql in some callers/tests, and postgres.js only attaches `.begin`
    // to the top-level handle — sql.begin would throw at runtime. withTx picks
    // begin/savepoint/manual-BEGIN by feature detection, keeping the lock +
    // adminExists re-check + upsert on one pinned connection.
    let provisioned: Awaited<ReturnType<typeof getUserByUsername>>;
    try {
        provisioned = await withTx(sql, async (tx) => {
            await tx`SELECT pg_advisory_xact_lock(hashtext(${FIRST_ADMIN_LOCK_KEY}))`;
            if (await adminExists(tx, config.ADMIN_GROUPS)) return null;
            // RULING (fix plan 6, C5, S-C5c): unlike `createNativeAdmin()` (which
            // sets `admin_pinned=true`), this forward-auth genesis admin is
            // deliberately left UNPINNED — `upsertUser()` writes an unpinned row
            // by default, and nothing here pins it. Pinning would make the
            // genesis admin immune to IdP-side demotion (an ordinary admin-group
            // removal at the IdP), silently stranding full admin + admin-scoped
            // token access on a departed operator. An IdP-side demotion or rename
            // CAN therefore leave zero admins; the setup lock written below
            // (ruling S-C5c-2) keeps the setup wizard closed when that happens.
            // Recovery is the operator's: restore the admin group at the IdP, or
            // `SETUP_UNLOCK` (see `setup-lock.service.ts`).
            await upsertUser(tx, { username: usernameLower, isAdmin: true });
            const row = await getUserByUsername(tx, usernameLower);
            // An existing row pinned as a non-admin keeps `is_admin = false`
            // (`upsertUser()`'s pin guard). Completing setup then would lock an
            // install that has no admin, so roll back instead.
            if (row?.is_admin !== true) throw new PinnedNonAdminSetupError();
            await markSetupCompleted(tx, row.id);
            return row;
        });
    } catch (error) {
        if (!(error instanceof PinnedNonAdminSetupError)) throw error;
        logger.warn('Forward-auth onboarding refused: the account is pinned as a non-admin', {
            username: usernameLower,
        });
        return {
            ok: false,
            status: 409,
            message:
                'This account is pinned as a non-admin in Lumastra, so it cannot complete setup. Unpin it (clear admin_pinned on its users row) or complete setup with another account.',
        };
    }

    if (!provisioned) {
        // Lost the race — another setup submission created the admin first.
        return { ok: false, status: 409, message: 'Setup has already been completed.' };
    }

    try {
        // user_profiles.user_id is the users.id UUID (mig 16.46.0).
        await ensureUserProfileExists(sql, toUserId(provisioned.id));
    } catch {
        /* best-effort */
    }
    // Record the forward-auth identity in the federation ledger (best-effort).
    await recordIdentityBestEffort(sql, {
        provider: PROVIDER_FORWARD_AUTH,
        subject: usernameLower,
        userId: provisioned.id,
    });
    invalidateAdminExistsCache();
    const oidcConfigDiscarded = await discardPreAdminOidcConfig();
    logger.info('Forward-auth onboarding completed', { username: identity.username.toLowerCase() });
    return { ok: true, oidcConfigDiscarded };
}

/**
 * Change the current native user's own password: verify the current password,
 * apply the new one, revoke all existing sessions, and issue a fresh session for
 * the current device. Returns the new session on success.
 */
export async function changeOwnPassword(
    sql: postgres.Sql,
    params: {
        username: string;
        currentPassword: string;
        newPassword: string;
        userAgent?: string | null;
        ip?: string | null;
    },
): Promise<{ ok: true; session: SessionIssue } | { ok: false; status: number; message: string }> {
    const record = await getNativeLoginRecord(sql, params.username);
    if (!record || !record.password_hash) {
        // Forward-auth / IdP-managed account has no native password to change.
        return {
            ok: false,
            status: 400,
            message:
                'Your account is managed by your identity provider and has no Lumastra password.',
        };
    }

    const ok = await verifyPassword(params.currentPassword, record.password_hash);
    if (!ok) {
        return { ok: false, status: 401, message: 'Current password is incorrect.' };
    }

    const policyError = validatePasswordPolicy(params.newPassword);
    if (policyError) return { ok: false, status: 400, message: policyError };

    const newHash = await hashPassword(params.newPassword);
    const session = await withUserCredentialLock(sql, record.id, async (tx) => {
        const current = await getNativeLoginRecord(tx, record.username);
        if (
            !current ||
            current.id !== record.id ||
            current.disabled_at ||
            current.password_hash !== record.password_hash
        )
            return null;
        if (!(await setUserPassword(tx, record.id, newHash))) return null;
        // Preserve the current-device session while revoking every other credential.
        const fresh = await getSessionService().create(
            {
                userId: record.id,
                userAgent: params.userAgent ?? null,
                ip: params.ip ?? null,
            },
            tx,
        );
        const { failedStores } = await revokeAllCredentialsForUser(tx, record.id, record.username, {
            keepSessionToken: fresh.token,
        });
        if (failedStores.length > 0) {
            logger.warn('Native password change: some credential stores failed to revoke', {
                username: record.username,
                failedStores,
            });
        }
        return fresh;
    });
    if (!session) return { ok: false, status: 401, message: 'Current password is incorrect.' };
    logger.info('Native password changed', { username: record.username });
    return { ok: true, session };
}

/** Persist AUTH_NATIVE_LOGIN_ENABLED=true via the config service. */
async function enableNativeLogin(): Promise<void> {
    try {
        const { saveConfig } = await import('$lib/server/config/config.service.js');
        await saveConfig({ AUTH_NATIVE_LOGIN_ENABLED: true });
    } catch (error) {
        // If config persistence fails the admin still exists and can log in via
        // the /login page directly; only the auto-redirect is affected. Warn.
        logger.warn('Failed to persist AUTH_NATIVE_LOGIN_ENABLED', { error: String(error) });
    }
}

/** Resolve a username to its user id (for change-password by session identity). */
export async function userIdForUsername(
    sql: postgres.Sql,
    username: string,
): Promise<string | null> {
    const user = await getUserByUsername(sql, username.toLowerCase());
    return user?.id ?? null;
}
