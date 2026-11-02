// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Setup lock maintenance and operator recovery (security review 6, ruling
 * S-C5c-2).
 *
 * Once first-run setup completes, the `setup_lock` row keeps the public setup
 * surfaces closed even if every admin is later lost (an IdP demotion or rename
 * of the admin group, an `ADMIN_GROUPS` typo). Every admin-bootstrap path
 * writes the row inside `FIRST_ADMIN_LOCK_KEY` (users.queries.ts).
 *
 * The only way to remove it is `SETUP_UNLOCK=1` in the container environment
 * (applied at boot by `scripts/startup-migration.ts`) or
 * `scripts/setup-unlock.ts` run inside the container. Both prove host control,
 * and both apply only while no admin exists by the broad setup-gate predicate
 * (`adminExistsIgnoringSetupLock()`); with an admin present the request is
 * ignored. The next admin created by any bootstrap path writes the row again.
 */

import type postgres from 'postgres';
import { Logger } from '$lib/server/utils/logger.js';
import { withTx } from '$lib/server/database/with-tx.js';
import {
    countEffectiveAdmins,
    countOtherEffectiveAdmins,
} from '$lib/server/database/queries/access-groups.queries.js';
import {
    adminExistsIgnoringSetupLock,
    clearSetupLock,
    isSetupLocked,
    markSetupCompleted,
    FIRST_ADMIN_LOCK_KEY,
} from '$lib/server/database/queries/users.queries.js';

const logger = Logger.for('Auth');

/**
 * - `unlocked`: unlock requested, no admin exists, the lock was removed.
 * - `already-unlocked`: unlock requested, no admin exists, there was no lock.
 * - `unlock-ignored`: unlock requested, but an admin exists (the lock is kept,
 *   and written if it was missing).
 * - `relocked`: no unlock requested, an admin exists but the lock was missing,
 *   so it was written (an admin created by a path that did not write it, e.g.
 *   an IdP promotion after an unlock, or an admin created during a rolling
 *   upgrade before this code ran).
 * - `unchanged`: nothing to do.
 */
export type SetupLockOutcome =
    'unlocked' | 'already-unlocked' | 'unlock-ignored' | 'relocked' | 'unchanged';

/**
 * Bring the setup lock in line with the admin state, applying an operator
 * unlock when requested. Runs under `FIRST_ADMIN_LOCK_KEY`, so it serializes
 * against every admin-bootstrap path: an unlock can never remove a lock that a
 * concurrent first-run setup has just written.
 *
 * Throws when the admin predicate cannot be evaluated (blank `ADMIN_GROUPS`
 * with no column/capability admin); the lock is then left as it was.
 */
export async function reconcileSetupLock(
    sql: postgres.Sql,
    opts: { unlockRequested: boolean; adminGroupNames: readonly string[] },
): Promise<SetupLockOutcome> {
    return withTx(sql, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${FIRST_ADMIN_LOCK_KEY}))`;
        if (await adminExistsIgnoringSetupLock(tx, opts.adminGroupNames)) {
            const wasLocked = await isSetupLocked(tx);
            if (!wasLocked) await markSetupCompleted(tx, null);
            if (opts.unlockRequested) return 'unlock-ignored';
            return wasLocked ? 'unchanged' : 'relocked';
        }
        if (!opts.unlockRequested) return 'unchanged';
        return (await clearSetupLock(tx)) ? 'unlocked' : 'already-unlocked';
    });
}

/** Operator-facing log line for an outcome, or null when there is nothing to say. */
export function describeSetupLockOutcome(
    outcome: SetupLockOutcome,
): { level: 'warn' | 'info'; message: string } | null {
    switch (outcome) {
        case 'unlocked':
            return {
                level: 'warn',
                message:
                    'SETUP_UNLOCK: no admin exists, so the setup lock was removed. First-run setup at /setup is open to anyone who can reach it until an admin is created. Create the admin now, then remove SETUP_UNLOCK.',
            };
        case 'already-unlocked':
            return {
                level: 'warn',
                message:
                    'SETUP_UNLOCK: no admin exists and setup was not locked. First-run setup at /setup is open. Create the admin, then remove SETUP_UNLOCK.',
            };
        case 'unlock-ignored':
            return {
                level: 'warn',
                message:
                    'SETUP_UNLOCK is set but an admin exists; ignored. The setup lock stays in place. Remove SETUP_UNLOCK.',
            };
        case 'relocked':
            return {
                level: 'info',
                message: 'An admin exists but setup was not locked; the setup lock was written.',
            };
        case 'unchanged':
            return null;
    }
}

/**
 * Write the setup lock for an admin who became one outside the three
 * first-run bootstrap paths (an IdP promotion of an existing account, or a new
 * account provisioned as admin, while setup was open after an unlock).
 * Idempotent; the first completion is kept.
 */
export async function ensureSetupLocked(sql: postgres.Sql, byUserId: string): Promise<void> {
    await withTx(sql, async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(hashtext(${FIRST_ADMIN_LOCK_KEY}))`;
        await markSetupCompleted(tx, byUserId);
    });
}

/** Logged when an IdP sync leaves a locked install with no admin (quoted in the operator docs). */
export const LAST_ADMIN_DEMOTED_LOCKED_MESSAGE =
    "IdP group sync demoted the last admin; first-run setup stays locked. Restore the admin group at the identity provider (admin returns on that user's next forward-auth request or next OIDC sign-in), or set SETUP_UNLOCK=1 and restart to reopen /setup.";

/**
 * After an IdP sync demoted `username`, warn when no effective admin is left.
 * The install stays locked, so without this line an operator whose IdP change
 * removed the last admin sees only a missing admin menu. Callers run it only on
 * a demotion transition.
 *
 * `demotedUserId` excludes that user from the count: the OIDC login sync never
 * lowers the `is_admin` column (promote-only), so the demoted user can still
 * look like an admin to a column-reading count. Forward-auth writes the column
 * and passes no id.
 */
export async function warnIfLastAdminDemoted(
    sql: postgres.Sql,
    opts: {
        username: string;
        source: 'forward-auth' | 'oidc' | 'plugin';
        adminGroupNames: readonly string[];
        demotedUserId?: string;
    },
): Promise<void> {
    const remaining = opts.demotedUserId
        ? await countOtherEffectiveAdmins(sql, opts.demotedUserId, opts.adminGroupNames)
        : await countEffectiveAdmins(sql, opts.adminGroupNames);
    if (remaining > 0) return;
    const context = {
        username: opts.username,
        source: opts.source,
        adminGroups: opts.adminGroupNames,
    };
    if (await isSetupLocked(sql)) {
        logger.warn(LAST_ADMIN_DEMOTED_LOCKED_MESSAGE, context);
    } else {
        logger.warn(
            'IdP group sync demoted the last admin and setup is not locked; /setup is open until an admin exists.',
            context,
        );
    }
}
