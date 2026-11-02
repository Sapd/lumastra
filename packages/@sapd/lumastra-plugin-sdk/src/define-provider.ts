// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { ProviderDefinition } from './types.js';
import { PluginDefinitionError } from './errors.js';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function fail(id: string, message: string): never {
    throw new PluginDefinitionError({
        id,
        message,
        phase: 'registration',
        contract: 'defineProvider',
    });
}

export function defineProvider<P, I>(def: ProviderDefinition<P, I>): ProviderDefinition<P, I> {
    if (!def.id || !def.id.trim()) fail('(unknown)', 'id must not be blank');
    if (!def.name || !def.name.trim()) fail(def.id, 'name must not be blank');
    if (!def.version || !def.version.trim()) fail(def.id, 'version must not be blank');
    if (!ID_PATTERN.test(def.id)) {
        fail(def.id, `id must match /^[a-z][a-z0-9-]*$/, got: ${def.id}`);
    }
    if (typeof def.isConfigured !== 'function') {
        fail(def.id, 'isConfigured is mandatory');
    }
    if (typeof def.detail !== 'function') {
        fail(def.id, 'detail is mandatory');
    }
    return def;
}
