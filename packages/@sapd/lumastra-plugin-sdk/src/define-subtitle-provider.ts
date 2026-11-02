// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { SubtitleProviderDefinition } from './types.js';
import { PluginDefinitionError } from './errors.js';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function fail(id: string, message: string): never {
    throw new PluginDefinitionError({
        id,
        message,
        phase: 'registration',
        contract: 'defineSubtitleProvider',
    });
}

export function defineSubtitleProvider(
    def: SubtitleProviderDefinition,
): SubtitleProviderDefinition {
    if (!def.id) fail('(unknown)', 'id is required');
    if (!ID_PATTERN.test(def.id)) {
        fail(def.id, `id must match /^[a-z][a-z0-9-]*$/, got: ${def.id}`);
    }
    if (typeof def.search !== 'function') {
        fail(def.id, 'search is mandatory');
    }
    // A provider that can list subtitles but not deliver one is a dead end for
    // the user: the picker would offer results that cannot be installed.
    if (typeof def.download !== 'function') {
        fail(def.id, 'download is mandatory');
    }
    return def;
}
