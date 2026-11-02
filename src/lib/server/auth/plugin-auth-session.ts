// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Verified claims → a host session, for every auth-provider kind.
 *
 * This is one function on purpose. A credentials login and a redirect login
 * differ only in HOW the provider convinced itself of who someone is;
 * everything after that — account linking, the refusal to provision before an
 * admin exists, the suspension check, the session mint — must be identical, and
 * the way to guarantee that is to have a single place it happens rather than
 * two that agree today.
 *
 * The suspension check in particular lives HERE rather than inside
 * `resolvePluginIdentity`, so that a future caller of the identity mapper
 * cannot reach a session without passing it.
 */

import type { RequestEvent } from '@sveltejs/kit';
import type { AuthProviderIdentity } from '@sapd/lumastra-plugin-sdk';
import { getDb } from '$lib/server/database/connection.js';
import { resolvePluginIdentity } from '$lib/server/services/plugin-auth.service.js';
import { adminExists, getUserById } from '$lib/server/database/queries/users.queries.js';
import { config } from '$lib/server/config.js';
import {
    resolveUserIdByIdentity,
    provisionUserWithIdentity,
} from '$lib/server/services/user-identity.service.js';
import { getSessionService } from '$lib/server/services/session.service.js';
import { syncPluginLoginGroups } from '$lib/server/services/plugin-auth-group-sync.js';
import { setSessionCookie, sessionMaxAgeSeconds } from './native-session.js';
import { getClientIp } from '$lib/server/utils/client-ip.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PluginAuthSession');

export type PluginSessionResult =
    | { kind: 'ok'; userId: string }
    /** Authenticated by the provider, but no host account is linked to them. */
    | { kind: 'not-linked' }
    /** The account exists and is suspended, or vanished mid-flight. */
    | { kind: 'account-refused' }
    /** A host-side problem: no database, or provisioning refused. */
    | { kind: 'unavailable' };

export async function establishPluginSession(
    event: RequestEvent,
    pluginId: string,
    identity: AuthProviderIdentity,
): Promise<PluginSessionResult> {
    const sql = getDb();
    if (!sql) return { kind: 'unavailable' };

    const outcome = await resolvePluginIdentity(sql, pluginId, identity, {
        resolveUserIdByIdentity,
        provisionUserWithIdentity,
        anAdminExists: (s) => adminExists(s, config.ADMIN_GROUPS),
        syncReturningIdentityGroups: syncPluginLoginGroups,
    });
    if (outcome.kind === 'not-linked') return { kind: 'not-linked' };
    if (outcome.kind === 'refused') return { kind: 'unavailable' };

    // The provider proved WHO this is; it does not get to decide whether that
    // account may log in. A suspension is the host's word.
    const user = await getUserById(sql, outcome.userId);
    if (!user || user.disabled_at) {
        logger.warn('refused a plugin login for a suspended or missing account', {
            provider: pluginId,
        });
        return { kind: 'account-refused' };
    }

    const session = await getSessionService().create({
        userId: outcome.userId,
        userAgent: event.request.headers.get('user-agent'),
        ip: getClientIp(event),
    });
    setSessionCookie(event.cookies, session.token, sessionMaxAgeSeconds(session.expiresAt));

    logger.info('plugin auth login succeeded', { provider: pluginId });
    return { kind: 'ok', userId: outcome.userId };
}
