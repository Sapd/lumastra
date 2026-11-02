// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { MediaSourceDefinition } from './types.js';
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
        contract: 'defineMediaSource',
    });
}

export function defineMediaSource(def: MediaSourceDefinition): MediaSourceDefinition {
    if (!def.id || typeof def.id !== 'string' || !def.id.trim()) {
        fail('(unknown)', 'id is required');
    }
    if (!ID_PATTERN.test(def.id)) {
        fail(
            def.id,
            `invalid id "${def.id}" — must be kebab-case (lowercase letter start, then lowercase letters/digits/hyphens)`,
        );
    }
    if (typeof def.scan !== 'function') {
        fail(def.id, 'scan is mandatory');
    }
    if (typeof def.fullSync !== 'function') {
        fail(def.id, 'fullSync is mandatory');
    }
    if (typeof def.getStatus !== 'function') {
        fail(def.id, 'getStatus is mandatory');
    }
    // Validate sourceConfig at definition time so JS callers that omit the
    // required field fail loudly here, not at first scan/admin-DTO read.
    if (!def.sourceConfig || typeof def.sourceConfig !== 'object') {
        fail(def.id, 'sourceConfig is required');
    }
    // Watcher methods are optional — if any are declared, all 4 must be declared
    // together (start/stop/getStatus/updateTargets). Either all four or none.
    const watcherKeys = [
        'startWatching',
        'stopWatching',
        'getWatcherStatus',
        'updateWatcherTargets',
    ] as const;
    const declaredWatchers = watcherKeys.filter((k) => typeof def[k] === 'function');
    if (declaredWatchers.length !== 0 && declaredWatchers.length !== 4) {
        fail(
            def.id,
            `watcher methods must be all-or-nothing — found ${declaredWatchers.length}/4. Either declare all of {${watcherKeys.join(', ')}} or none.`,
        );
    }
    return def;
}
