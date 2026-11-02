// SPDX-License-Identifier: Apache-2.0
/**
 * Sample: defineAuthProvider — verify a login against an external directory.
 *
 * INERT until an operator names this id in AUTH_PLUGIN_PROVIDERS. Installing it
 * opens nothing: the login endpoint 404s and this function is never called.
 *
 * `subject` is the ONLY field the host binds an account to. It must be stable
 * for the life of that person's account and never reused — a directory's
 * immutable id, not a username or email, both of which people change.
 *
 * `database` and `browserUi` capabilities are REFUSED for this contract.
 * Fails CLOSED: a throw, a timeout or a malformed verdict is a failed login.
 *
 * @type {import('@sapd/lumastra-plugin-sdk').AuthProviderDefinition}
 */
export default {
    id: 'sample-auth-provider',
    name: 'Sample Directory',
    version: '1.0.0',
    capabilities: {},
    async verifyCredentials(_ctx, { username, password }) {
        if (password !== 'correct-horse') return { ok: false, reason: 'invalid_credentials' };
        return {
            ok: true,
            identity: { subject: `sample-uid-${username}`, username, groups: ['staff'] },
        };
    },
};
