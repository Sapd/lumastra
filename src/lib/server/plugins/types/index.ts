// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin types barrel.
 *
 *   - `base-plugin.ts` — the `PluginContext` shape used by internal services
 *     and file-scanner helpers. Not a contract; just a typing handle for
 *     code that bundles `{ sql, logger, cache, … }` together.
 *   - `sync-plugin.ts` — re-export shim for the task-system execution types
 *     that live in `$lib/server/tasks/sync-context-types`.
 *
 * Domain types for metadata responses (MetadataCandidate / MediaMetadata /
 * EpisodeMetadata / etc.) live in `$lib/server/providers/types` and are
 * re-exported below. ScanResult / SyncResult / MediaSourceStatus come from
 * `@sapd/lumastra-plugin-sdk`.
 *
 * External plugins implement an SDK `defineX` contract from
 * `@sapd/lumastra-plugin-sdk` directly.
 */

export type {
    PluginManifest,
    PluginCapabilities,
    PluginCapabilityKey,
    PluginType,
    PluginContext,
    NamespacedCache,
    PluginHttpClient,
    PluginHttpOptions,
    PluginFFmpegClient,
    PluginLifecycle,
    BasePlugin,
    PluginSource,
    PluginRegistration,
    PluginStatus,
    PluginSettingsConfig,
    PluginSettingField,
} from './base-plugin.js';

export { PLUGIN_TYPES, PLUGIN_CAPABILITY_KEYS } from './base-plugin.js';

export type {
    PluginBacklogManifest,
    PluginBacklogStatus,
    SyncExecutionContext,
    SyncTaskResult,
    SyncTaskResultSerialized,
} from './sync-plugin.js';

// Media-source result types live in the SDK (`defineMediaSource`).
export type { ScanResult, SyncResult, MediaSourceStatus } from '@sapd/lumastra-plugin-sdk';

// Metadata domain types — see `$lib/server/providers/types`.
export type {
    MetadataCandidate,
    MediaMetadata,
    EpisodeMetadata,
    SeasonMetadata,
    SeriesChildrenResult,
} from '../../providers/types.js';
