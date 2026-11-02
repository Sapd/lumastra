// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Turning an auth provider's claims into a host identity.
 *
 * The provider says "these are the claims I verified". Everything after that —
 * which user this is, whether one may be created, which groups survive, whether
 * the account is allowed to log in at all — is decided here, by the host.
 *
 * Three env-only gates stand in front of all of it, and all three default to
 * empty. An installed auth plugin is inert until an operator names it, which is
 * what keeps "who can log in" a deploy-time decision rather than a consequence
 * of installing a plugin.
 *
 * FAILS CLOSED, and deliberately the opposite of `authorizePlayback`: a
 * playback veto fails open because a broken plugin refusing every stream is an
 * outage, whereas an auth check that fails open is an authentication bypass.
 */

import type postgres from 'postgres';
import type { AuthProviderIdentity, AuthProviderVerdict } from '@sapd/lumastra-plugin-sdk';
import { config } from '$lib/server/config.js';
import { Logger } from '$lib/server/utils/logger.js';

const logger = Logger.for('PluginAuth');

/**
 * Ledger provider key for a plugin, alongside `native` / `forward_auth` /
 * `oidc:<issuer>`. Namespaced so a plugin can never collide with a first-party
 * provider or with another plugin.
 */
export function pluginProviderKey(pluginId: string): string {
    return `plugin:${pluginId}`;
}

/** Is this provider permitted to be a login method at all? */
export function isAuthProviderEnabled(pluginId: string): boolean {
    return config.AUTH_PLUGIN_PROVIDERS.includes(pluginId);
}

/** May this provider CREATE an account for an unknown subject? */
export function mayProvision(pluginId: string): boolean {
    return config.AUTH_PLUGIN_PROVISION.includes(pluginId);
}

/** May this provider's asserted groups confer admin? */
export function mayAssertAdmin(pluginId: string): boolean {
    return config.AUTH_PLUGIN_ADMIN_ASSERT.includes(pluginId);
}

/**
 * Remove admin-conferring groups from a provider's claims.
 *
 * Applied to EVERY successful login unless the operator separately granted this
 * provider admin assertion. Group mapping — watch permissions, Live TV, age
 * cohorts — keeps working; admin simply does not flow.
 *
 * The point is that no configuration an operator reaches by "just enabling the
 * plugin" can yield plugin-asserted admin. Granting it is one deliberate,
 * auditable env line.
 */
export function stripAdminGroups(pluginId: string, groups: string[]): string[] {
    if (mayAssertAdmin(pluginId)) return groups;
    return dropAdminGroups(pluginId, groups);
}

function isAdminGroupName(group: string): boolean {
    return config.ADMIN_GROUPS.some((g) => g.toLowerCase() === group.toLowerCase());
}

/** `groups` without any `ADMIN_GROUPS` name (case-insensitive), whatever the gates say. */
function dropAdminGroups(pluginId: string, groups: string[]): string[] {
    const kept = groups.filter((g) => !isAdminGroupName(g));
    if (kept.length !== groups.length) {
        logger.warn('stripped admin-conferring groups from an auth provider', {
            plugin: pluginId,
            stripped: groups.length - kept.length,
        });
    }
    return kept;
}

/**
 * Validate a verdict that arrived from third-party code.
 *
 * Anything malformed becomes `unavailable` rather than being interpreted. The
 * one shape that must never be inferred is success: a verdict the host cannot
 * fully understand is not a login.
 */
export function normalizeVerdict(raw: unknown): AuthProviderVerdict {
    if (!raw || typeof raw !== 'object') return { ok: false, reason: 'unavailable' };
    const v = raw as Record<string, unknown>;

    if (v.ok === true) {
        const identity = v.identity as Record<string, unknown> | undefined;
        // A success with no stable subject is unusable: the subject is the only
        // key the ledger may bind to, and inventing one from a username would
        // reintroduce exactly the mutable-key bug this codebase has already
        // been burned by.
        if (!identity || typeof identity.subject !== 'string' || !identity.subject) {
            logger.warn('auth provider returned success with no usable subject');
            return { ok: false, reason: 'unavailable' };
        }
        // ABSENT stays absent (undefined), distinct from an empty list: the
        // SDK's `groups` is optional ("as the external system reports them"),
        // and a returning login re-syncs `users.groups` only from a list the
        // provider actually reported. Reading "not reported" as `[]` would wipe
        // an age cohort — lifting a child's cap — on any login path that omits
        // groups.
        const groups = Array.isArray(identity.groups)
            ? identity.groups.filter((g): g is string => typeof g === 'string')
            : undefined;
        return {
            ok: true,
            identity: {
                subject: identity.subject,
                username: typeof identity.username === 'string' ? identity.username : undefined,
                displayName:
                    typeof identity.displayName === 'string' ? identity.displayName : undefined,
                email: typeof identity.email === 'string' ? identity.email : undefined,
                emailVerified: identity.emailVerified === true,
                groups,
            },
        };
    }

    return {
        ok: false,
        reason: v.reason === 'invalid_credentials' ? 'invalid_credentials' : 'unavailable',
    };
}

export type ResolveOutcome =
    { kind: 'user'; userId: string } | { kind: 'not-linked' } | { kind: 'refused'; reason: string };

export interface PluginAuthDeps {
    resolveUserIdByIdentity(
        sql: postgres.Sql,
        provider: string,
        subject: string,
    ): Promise<string | null>;
    provisionUserWithIdentity(
        sql: postgres.Sql,
        params: {
            baseUsername: string;
            isAdmin: boolean;
            groups: string[];
            email?: string | null;
            emailVerified?: boolean;
            displayName?: string | null;
            identity: { provider: string; subject: string };
        },
    ): Promise<{ userId: string; username: string }>;
    anAdminExists(sql: postgres.Sql): Promise<boolean>;
    /**
     * Rewrite a returning account's `users.groups` from this login's (already
     * stripped) groups and apply the admin transition that follows
     * (`plugin-auth-group-sync.ts`).
     */
    syncReturningIdentityGroups(sql: postgres.Sql, userId: string, groups: string[]): Promise<void>;
}

/**
 * Map verified claims onto a host user, provisioning only if permitted.
 *
 * Never creates an admin: provisioned accounts get admin-stripped groups and
 * `isAdmin: false` regardless of what the provider asserted, because a
 * third-party contract must never be able to mint the account that administers
 * the server.
 *
 * A RETURNING login re-syncs `users.groups` from the reported groups (security
 * review 7, the plugin admin-assert cohort). Before this, the groups written at
 * provision were never rewritten: a provider in `AUTH_PLUGIN_ADMIN_ASSERT`
 * whose IdP later revoked the admin group left the account admin for good, and
 * a revoked age cohort or Live TV group stuck the same way. Two limits:
 * - the re-sync runs only when the provider REPORTED groups (see
 *   `normalizeVerdict`); an absent list leaves the stored projection alone;
 * - while setup is not complete (no setup lock and no admin — reachable only
 *   after `SETUP_UNLOCK` with zero admins), admin-conferring names are dropped
 *   even under `AUTH_PLUGIN_ADMIN_ASSERT`, so a plugin login is never the
 *   thing that creates the first admin. The setup wizard is the only door.
 *
 * It takes effect at the next plugin login. A session minted earlier keeps
 * reading the stored row until then (`native-session.ts`), so an operator who
 * needs a revocation to bite now still pins the account or ends its sessions.
 */
export async function resolvePluginIdentity(
    sql: postgres.Sql,
    pluginId: string,
    identity: AuthProviderIdentity,
    deps: PluginAuthDeps,
): Promise<ResolveOutcome> {
    const provider = pluginProviderKey(pluginId);

    const existing = await deps.resolveUserIdByIdentity(sql, provider, identity.subject);
    if (existing) {
        if (identity.groups !== undefined) {
            let groups = stripAdminGroups(pluginId, identity.groups);
            if (groups.some(isAdminGroupName) && !(await deps.anAdminExists(sql))) {
                logger.warn('dropping plugin-asserted admin groups: setup is not complete', {
                    plugin: pluginId,
                });
                groups = dropAdminGroups(pluginId, groups);
            }
            await deps.syncReturningIdentityGroups(sql, existing, groups);
        }
        return { kind: 'user', userId: existing };
    }

    if (!mayProvision(pluginId)) {
        // Actionable rather than generic: this one IS the operator's
        // configuration talking, not a credential failure, and telling the user
        // "ask an admin to link your account" is the whole point.
        return { kind: 'not-linked' };
    }

    // A third-party contract must never mint the first admin. The setup wizard
    // is the only first-run door.
    if (!(await deps.anAdminExists(sql))) {
        logger.warn('refused plugin provisioning before an admin exists', { plugin: pluginId });
        return { kind: 'refused', reason: 'no administrator exists yet' };
    }

    const groups = stripAdminGroups(pluginId, identity.groups ?? []);
    const baseUsername = identity.username?.trim() || `${pluginId}-${identity.subject}`;

    const created = await deps.provisionUserWithIdentity(sql, {
        baseUsername,
        // Never, regardless of claims or of AUTH_PLUGIN_ADMIN_ASSERT: the
        // column stays false. Under AUTH_PLUGIN_ADMIN_ASSERT an asserted admin
        // group still makes the account admin through `users.groups` (Formula A
        // reads the groups of an unpinned row), but only once setup is complete
        // (the anAdminExists check above), so the first account a plugin
        // creates is never the one that administers the box.
        isAdmin: false,
        groups,
        email: identity.email ?? null,
        emailVerified: identity.emailVerified === true,
        displayName: identity.displayName ?? null,
        identity: { provider, subject: identity.subject },
    });

    logger.info('provisioned a user from an auth provider', {
        plugin: pluginId,
        username: created.username,
    });
    return { kind: 'user', userId: created.userId };
}
