// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { AuthProviderDefinition } from './types.js';
import { PluginDefinitionError } from './errors.js';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function fail(id: string, message: string): never {
    throw new PluginDefinitionError({
        id,
        message,
        phase: 'registration',
        contract: 'defineAuthProvider',
    });
}

/**
 * Validate an auth provider.
 *
 * Stricter than every other contract, because this is the one where a mistake
 * is an authentication mistake. Two refusals are worth calling out:
 *
 * `database` — identity mapping is the host's job. A verifier with raw SQL
 * could write `users` and `user_sessions` directly, which is precisely the
 * arrangement this contract exists to replace.
 *
 * `browserUi` — no third-party JavaScript renders on the pre-auth login page,
 * ever. A plugin that could script `/login` could harvest the native password
 * field of an operator who never intended to use that plugin.
 */
export function defineAuthProvider(def: AuthProviderDefinition): AuthProviderDefinition {
    if (!def.id) fail('(unknown)', 'id is required');
    if (!ID_PATTERN.test(def.id)) {
        fail(def.id, `id must match /^[a-z][a-z0-9-]*$/, got: ${def.id}`);
    }
    if (typeof def.name !== 'string' || !def.name) {
        fail(def.id, 'name is mandatory — it labels the login button');
    }
    if (typeof def.version !== 'string' || !def.version) {
        fail(def.id, 'version is mandatory');
    }

    const caps = def.capabilities as Record<string, unknown> | undefined;
    if (caps?.database === true) {
        fail(def.id, 'capabilities.database is not permitted for an auth provider');
    }
    if (caps?.browserUi === true) {
        fail(def.id, 'capabilities.browserUi is not permitted for an auth provider');
    }

    const isCredentials = typeof def.verifyCredentials === 'function';
    const isRedirect =
        typeof def.beginLogin === 'function' && typeof def.completeLogin === 'function';

    if (isCredentials && isRedirect) {
        fail(def.id, 'declare EITHER verifyCredentials OR beginLogin+completeLogin, not both');
    }
    if (!isCredentials && !isRedirect) {
        fail(def.id, 'must declare verifyCredentials, or both beginLogin and completeLogin');
    }
    // Half a redirect flow is worse than none: the host would offer a login
    // button that dead-ends at the callback.
    if (!isCredentials && (!def.beginLogin || !def.completeLogin)) {
        fail(def.id, 'a redirect provider needs BOTH beginLogin and completeLogin');
    }

    return def;
}
