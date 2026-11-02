// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin runtime — external drop-in loader + boot wiring.
 *
 * All builtin and external plugins register against `taskRegistry`
 * (`$lib/server/tasks/registry`); see `loader.ts` for the SDK shape
 * detection that routes a default export to the right registry method.
 */

export {
    loadAllPlugins,
    loadExternalPlugins,
    loadExternalPlugin,
    discoverExternalPlugins,
    isExternalPluginsEnabled,
} from './loader.js';
