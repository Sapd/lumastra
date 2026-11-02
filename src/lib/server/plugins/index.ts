// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin system entry point.
 *
 * `loadAllPlugins(sql)` is the boot hook called from `hooks.server.ts`: it
 * drains `$PLUGINS_EXTERNAL_DIR` and wires field-authority priorities.
 * Every plugin (builtin native or external drop-in) registers against
 * `taskRegistry` (see `$lib/server/tasks/registry`) — external authors
 * implement an SDK `defineX` contract from `@sapd/lumastra-plugin-sdk`.
 *
 * The `PluginContext` shape re-exported below is the typing handle used by
 * internal services (file-scanner helpers etc.) that bundle a
 * `{ sql, logger, cache, … }` context together.
 */

export type {
    PluginCapabilities,
    PluginContext,
    PluginManifest,
    NamespacedCache,
    PluginHttpClient,
    PluginHttpOptions,
} from './types/base-plugin.js';

export {
    loadAllPlugins,
    loadExternalPlugins,
    loadExternalPlugin,
    discoverExternalPlugins,
    isExternalPluginsEnabled,
} from './runtime/index.js';
