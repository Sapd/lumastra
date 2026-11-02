// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { LyricsProviderDefinition } from './types.js';
import { PluginDefinitionError } from './errors.js';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function fail(id: string, message: string): never {
    throw new PluginDefinitionError({
        id,
        message,
        phase: 'registration',
        contract: 'defineLyricsProvider',
    });
}

export function defineLyricsProvider(def: LyricsProviderDefinition): LyricsProviderDefinition {
    if (!def.id) fail('(unknown)', 'id is required');
    if (!ID_PATTERN.test(def.id)) {
        fail(def.id, `id must match /^[a-z][a-z0-9-]*$/, got: ${def.id}`);
    }
    if (typeof def.fetchLyrics !== 'function') {
        fail(def.id, 'fetchLyrics is mandatory');
    }
    return def;
}
