// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit test — turning an auth provider's claims into a host identity.
 *
 * Every test here is a refusal or a strip. The contract's whole defence is that
 * a buggy-but-honest provider cannot escalate, so these pin the boundaries that
 * make that true.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockConfig = vi.hoisted(() => ({
    AUTH_PLUGIN_PROVIDERS: [] as string[],
    AUTH_PLUGIN_PROVISION: [] as string[],
    AUTH_PLUGIN_ADMIN_ASSERT: [] as string[],
    ADMIN_GROUPS: ['admin'],
}));
vi.mock('$lib/server/config.js', () => ({ config: mockConfig }));
vi.mock('$lib/server/utils/logger.js', () => ({
    Logger: { for: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }) },
}));

import {
    pluginProviderKey,
    isAuthProviderEnabled,
    mayProvision,
    stripAdminGroups,
    normalizeVerdict,
    resolvePluginIdentity,
    type PluginAuthDeps,
} from './plugin-auth.service.js';

const sql = {} as never;

function deps(over: Partial<PluginAuthDeps> = {}): PluginAuthDeps {
    return {
        resolveUserIdByIdentity: async () => null,
        provisionUserWithIdentity: async () => ({ userId: 'new-user', username: 'someone' }),
        anAdminExists: async () => true,
        syncReturningIdentityGroups: async () => undefined,
        ...over,
    };
}

beforeEach(() => {
    mockConfig.AUTH_PLUGIN_PROVIDERS = [];
    mockConfig.AUTH_PLUGIN_PROVISION = [];
    mockConfig.AUTH_PLUGIN_ADMIN_ASSERT = [];
    mockConfig.ADMIN_GROUPS = ['admin'];
});

describe('the env gates', () => {
    it('leaves an installed provider INERT by default', () => {
        // The condition under which this contract is defensible: installing an
        // auth plugin changes nothing until an operator names it.
        expect(isAuthProviderEnabled('ldap')).toBe(false);
        expect(mayProvision('ldap')).toBe(false);
    });

    it('enables only the ids an operator listed', () => {
        mockConfig.AUTH_PLUGIN_PROVIDERS = ['ldap'];
        expect(isAuthProviderEnabled('ldap')).toBe(true);
        expect(isAuthProviderEnabled('discord')).toBe(false);
    });

    it('namespaces the ledger key so a plugin cannot impersonate a first-party provider', () => {
        expect(pluginProviderKey('native')).toBe('plugin:native');
    });
});

describe('stripAdminGroups', () => {
    it('removes admin-conferring groups by default', () => {
        expect(stripAdminGroups('ldap', ['users', 'admin'])).toEqual(['users']);
    });

    it('is case-insensitive — a group name is not a password', () => {
        expect(stripAdminGroups('ldap', ['Admin'])).toEqual([]);
    });

    it('keeps them only when the operator granted admin assertion', () => {
        mockConfig.AUTH_PLUGIN_ADMIN_ASSERT = ['ldap'];
        expect(stripAdminGroups('ldap', ['users', 'admin'])).toEqual(['users', 'admin']);
    });

    it('leaves every non-admin group alone, so LDAP mapping still works', () => {
        expect(stripAdminGroups('ldap', ['staff', 'livetv'])).toEqual(['staff', 'livetv']);
    });
});

describe('normalizeVerdict', () => {
    it('accepts a well-formed success', () => {
        const v = normalizeVerdict({ ok: true, identity: { subject: 'uid-1', groups: ['staff'] } });
        expect(v).toEqual({
            ok: true,
            identity: expect.objectContaining({ subject: 'uid-1', groups: ['staff'] }),
        });
    });

    it('REFUSES a success with no stable subject', () => {
        // The subject is the only key the ledger may bind to. Inventing one
        // from a username would reintroduce the mutable-key bug this codebase
        // has already been burned by.
        expect(normalizeVerdict({ ok: true, identity: { username: 'alice' } })).toEqual({
            ok: false,
            reason: 'unavailable',
        });
    });

    it.each([[null], [undefined], ['yes'], [42], [{}], [{ ok: 'true' }]])(
        'treats malformed verdict %p as unavailable rather than interpreting it',
        (raw) => {
            expect(normalizeVerdict(raw).ok).toBe(false);
        },
    );

    it('preserves invalid_credentials so lockout can count it', () => {
        expect(normalizeVerdict({ ok: false, reason: 'invalid_credentials' })).toEqual({
            ok: false,
            reason: 'invalid_credentials',
        });
    });

    it('maps an unrecognised reason to unavailable', () => {
        expect(normalizeVerdict({ ok: false, reason: 'because' })).toEqual({
            ok: false,
            reason: 'unavailable',
        });
    });

    it('ignores non-string groups rather than passing them through', () => {
        const v = normalizeVerdict({
            ok: true,
            identity: { subject: 's', groups: ['ok', 42, null] },
        });
        expect(v.ok && v.identity.groups).toEqual(['ok']);
    });
});

describe('resolvePluginIdentity', () => {
    const identity = { subject: 'uid-1', username: 'alice', groups: ['staff'] };

    it('returns the linked user for a known subject', async () => {
        const out = await resolvePluginIdentity(
            sql,
            'ldap',
            identity,
            deps({ resolveUserIdByIdentity: async () => 'existing-user' }),
        );
        expect(out).toEqual({ kind: 'user', userId: 'existing-user' });
    });

    it('does NOT create an account when provisioning is off', async () => {
        // The sharpest edge: auto-provisioning would make installing a plugin
        // equivalent to granting accounts.
        const provision = vi.fn();
        const out = await resolvePluginIdentity(
            sql,
            'ldap',
            identity,
            deps({ provisionUserWithIdentity: provision as never }),
        );
        expect(out).toEqual({ kind: 'not-linked' });
        expect(provision).not.toHaveBeenCalled();
    });

    it('provisions when the operator enabled it for that provider', async () => {
        mockConfig.AUTH_PLUGIN_PROVISION = ['ldap'];
        const out = await resolvePluginIdentity(sql, 'ldap', identity, deps());
        expect(out).toEqual({ kind: 'user', userId: 'new-user' });
    });

    it('REFUSES to provision before an admin exists', async () => {
        // A third-party contract must never mint the first admin — the setup
        // wizard is the only first-run door.
        mockConfig.AUTH_PLUGIN_PROVISION = ['ldap'];
        const out = await resolvePluginIdentity(
            sql,
            'ldap',
            identity,
            deps({ anAdminExists: async () => false }),
        );
        expect(out.kind).toBe('refused');
    });

    it('never provisions an admin, even with admin assertion granted', async () => {
        mockConfig.AUTH_PLUGIN_PROVISION = ['ldap'];
        mockConfig.AUTH_PLUGIN_ADMIN_ASSERT = ['ldap'];
        const provision = vi.fn(async (_sql: never, _params: Record<string, unknown>) => ({
            userId: 'u',
            username: 'alice',
        }));
        await resolvePluginIdentity(
            sql,
            'ldap',
            { ...identity, groups: ['admin'] },
            deps({ provisionUserWithIdentity: provision as never }),
        );
        // The first account a plugin creates is never the one that administers
        // the server, whatever it claimed.
        expect(provision.mock.calls[0][1]).toMatchObject({ isAdmin: false });
    });

    it('strips admin groups from a provisioned account', async () => {
        mockConfig.AUTH_PLUGIN_PROVISION = ['ldap'];
        const provision = vi.fn(async (_sql: never, _params: Record<string, unknown>) => ({
            userId: 'u',
            username: 'alice',
        }));
        await resolvePluginIdentity(
            sql,
            'ldap',
            { ...identity, groups: ['staff', 'admin'] },
            deps({ provisionUserWithIdentity: provision as never }),
        );
        expect(provision.mock.calls[0][1]).toMatchObject({ groups: ['staff'] });
    });

    it('falls back to a namespaced username when the provider offers none', async () => {
        mockConfig.AUTH_PLUGIN_PROVISION = ['ldap'];
        const provision = vi.fn(async (_sql: never, _params: Record<string, unknown>) => ({
            userId: 'u',
            username: 'x',
        }));
        await resolvePluginIdentity(
            sql,
            'ldap',
            { subject: 'uid-9' },
            deps({ provisionUserWithIdentity: provision as never }),
        );
        expect(provision.mock.calls[0][1]).toMatchObject({ baseUsername: 'ldap-uid-9' });
    });
});

describe('resolvePluginIdentity — returning login re-sync (security review 7)', () => {
    const known = { resolveUserIdByIdentity: async () => 'existing-user' };

    it('re-syncs the reported groups of a returning account, admin names stripped by default', async () => {
        const sync = vi.fn(async () => undefined);
        await resolvePluginIdentity(
            sql,
            'ldap',
            { subject: 'uid-1', groups: ['staff', 'Admin'] },
            deps({ ...known, syncReturningIdentityGroups: sync }),
        );
        expect(sync).toHaveBeenCalledWith(sql, 'existing-user', ['staff']);
    });

    it('writes an EMPTY reported list — a revocation at the IdP reaches users.groups', async () => {
        mockConfig.AUTH_PLUGIN_ADMIN_ASSERT = ['ldap'];
        const sync = vi.fn(async () => undefined);
        await resolvePluginIdentity(
            sql,
            'ldap',
            { subject: 'uid-1', groups: [] },
            deps({ ...known, syncReturningIdentityGroups: sync }),
        );
        expect(sync).toHaveBeenCalledWith(sql, 'existing-user', []);
    });

    it('leaves the stored groups alone when the provider reported none (absent ≠ empty)', async () => {
        const sync = vi.fn(async () => undefined);
        await resolvePluginIdentity(
            sql,
            'ldap',
            { subject: 'uid-1' },
            deps({ ...known, syncReturningIdentityGroups: sync }),
        );
        expect(sync).not.toHaveBeenCalled();
    });

    it('keeps an asserted admin group under AUTH_PLUGIN_ADMIN_ASSERT once setup is complete', async () => {
        mockConfig.AUTH_PLUGIN_ADMIN_ASSERT = ['ldap'];
        const sync = vi.fn(async () => undefined);
        await resolvePluginIdentity(
            sql,
            'ldap',
            { subject: 'uid-1', groups: ['admin', 'staff'] },
            deps({ ...known, syncReturningIdentityGroups: sync }),
        );
        expect(sync).toHaveBeenCalledWith(sql, 'existing-user', ['admin', 'staff']);
    });

    it('drops an asserted admin group, even under AUTH_PLUGIN_ADMIN_ASSERT, while setup is not complete', async () => {
        mockConfig.AUTH_PLUGIN_ADMIN_ASSERT = ['ldap'];
        const sync = vi.fn(async () => undefined);
        await resolvePluginIdentity(
            sql,
            'ldap',
            { subject: 'uid-1', groups: ['admin', 'staff'] },
            deps({ ...known, anAdminExists: async () => false, syncReturningIdentityGroups: sync }),
        );
        expect(sync).toHaveBeenCalledWith(sql, 'existing-user', ['staff']);
    });
});

describe('normalizeVerdict — groups', () => {
    it('keeps an ABSENT groups list absent, not []', () => {
        const v = normalizeVerdict({ ok: true, identity: { subject: 's' } });
        expect(v.ok && v.identity.groups).toBeUndefined();
    });
});
