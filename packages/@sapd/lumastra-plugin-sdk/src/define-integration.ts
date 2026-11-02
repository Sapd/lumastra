// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { IntegrationDefinition } from './types.js';
import { PluginDefinitionError } from './errors.js';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function fail(id: string, message: string): never {
    throw new PluginDefinitionError({
        id,
        message,
        phase: 'registration',
        contract: 'defineIntegration',
    });
}

export function defineIntegration(def: IntegrationDefinition): IntegrationDefinition {
    if (!def.id) fail('(unknown)', 'id is required');
    if (!ID_PATTERN.test(def.id)) {
        fail(def.id, `id must match /^[a-z][a-z0-9-]*$/, got: ${def.id}`);
    }
    if (def.handleWebhook !== undefined && typeof def.handleWebhook !== 'function') {
        fail(def.id, 'handleWebhook must be a function');
    }
    if (def.sendNotification !== undefined && typeof def.sendNotification !== 'function') {
        fail(def.id, 'sendNotification must be a function');
    }
    if (def.handleWebhook === undefined && def.sendNotification === undefined) {
        fail(def.id, 'at least one of handleWebhook or sendNotification is required');
    }
    return def;
}
