// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: Apache-2.0

import type { FeatureDefinition } from './types.js';
import { PluginDefinitionError } from './errors.js';

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;

function fail(id: string, message: string): never {
    throw new PluginDefinitionError({
        id,
        message,
        phase: 'registration',
        contract: 'defineFeature',
    });
}

export function defineFeature(def: FeatureDefinition): FeatureDefinition {
    if (!def.id) fail('(unknown)', 'id is required');
    if (!ID_PATTERN.test(def.id)) {
        fail(def.id, `id must match /^[a-z][a-z0-9-]*$/, got: ${def.id}`);
    }
    if (!Array.isArray(def.routes) || def.routes.length === 0) {
        fail(def.id, 'routes must not be empty');
    }
    for (const route of def.routes) {
        if (!route || typeof route.path !== 'string' || !route.path) {
            fail(def.id, 'each route must have a non-empty path');
        }
        if (typeof route.handler !== 'function') {
            fail(def.id, `route '${route.path}' handler must be a function`);
        }
    }
    if (def.widgets && def.widgets.length > 0) {
        if (!def.capabilities?.browserUi) {
            fail(def.id, 'widgets require capabilities.browserUi: true');
        }
        for (const w of def.widgets) {
            if (!w || typeof w.id !== 'string' || !w.id) {
                fail(def.id, 'each widget must have a non-empty id');
            }
            if (typeof w.entry !== 'string' || !w.entry) {
                fail(def.id, `widget '${w.id}' must have a non-empty entry path`);
            }
            if (typeof w.title !== 'string' || !w.title) {
                fail(def.id, `widget '${w.id}' must have a non-empty title`);
            }
        }
    }
    if (def.pages && def.pages.length > 0) {
        // Same gate as widgets: a page executes plugin-authored JavaScript in
        // the host document, so it is the same disclosure.
        if (!def.capabilities?.browserUi) {
            fail(def.id, 'pages require capabilities.browserUi: true');
        }
        const seen = new Set<string>();
        for (const p of def.pages) {
            if (!p || typeof p.id !== 'string' || !/^[a-z][a-z0-9-]*$/.test(p.id)) {
                fail(def.id, `page id must be kebab-case, got: ${String(p?.id)}`);
            }
            if (seen.has(p.id)) {
                fail(def.id, `duplicate page id '${p.id}'`);
            }
            seen.add(p.id);
            if (typeof p.title !== 'string' || !p.title) {
                fail(def.id, `page '${p.id}' must have a non-empty title`);
            }
            if (typeof p.entry !== 'string' || !p.entry) {
                fail(def.id, `page '${p.id}' must have a non-empty entry path`);
            }
        }
    }
    return def;
}
