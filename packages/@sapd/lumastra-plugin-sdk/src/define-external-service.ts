// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { ExternalServiceDefinition } from './types.js';
import { PluginDefinitionError } from './errors.js';

// Must match registry.ts ID_PATTERN — registry's startup validator (`validateAt`)
// runs the same regex across every plugin type, so a definition that passes
// here but fails there would crash boot for any digit-prefixed id.
const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function fail(id: string, message: string): never {
    throw new PluginDefinitionError({
        id,
        message,
        phase: 'registration',
        contract: 'defineExternalService',
    });
}

export function defineExternalService(def: ExternalServiceDefinition): ExternalServiceDefinition {
    if (!def.id || typeof def.id !== 'string' || !def.id.trim()) {
        fail('(unknown)', 'id is required');
    }
    if (!ID_PATTERN.test(def.id)) {
        fail(
            def.id,
            `invalid id "${def.id}" — must be kebab-case (lowercase letter start, then lowercase letters/digits/hyphens)`,
        );
    }
    return def;
}
