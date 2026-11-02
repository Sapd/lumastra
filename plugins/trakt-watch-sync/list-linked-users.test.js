// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only
import { describe, it, expect } from 'vitest';
import plugin from './index.js';

// listLinkedUsers() is the per-user pull seam (Task 4): the engine calls it
// to discover which Lumastra users have this provider linked, ahead of a
// scoped (`onlyUserIds`) pull. Membership test MUST be the same as
// getAllLinkedUsers() internally uses — listUsersWithKey('access_token').
describe('trakt listLinkedUsers', () => {
    it('returns the userIds reported by listUsersWithKey(access_token)', async () => {
        const ctx = {
            sql: async () => [],
            logger: { info() {}, warn() {}, debug() {}, error() {} },
            secrets: {},
            userCredentials: {
                listUsersWithKey: async (key) => {
                    expect(key).toBe('access_token');
                    return ['u1', 'u2'];
                },
            },
            // listLinkedUsers() makes no HTTP calls, but initFromCtx() requires
            // ctx.http to be present (capabilities.http: true) — see C22 fix
            // round 1's ctx.http migration.
            http: { get: async () => new Response(null), post: async () => new Response(null) },
        };
        await expect(plugin.listLinkedUsers(ctx)).resolves.toEqual(['u1', 'u2']);
    });
});
