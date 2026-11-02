// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import type postgres from 'postgres';
import type { ProviderDefinition } from '@sapd/lumastra-plugin-sdk';
import type { FieldAuthorityConfig } from './field-authority-resolver.js';
import { Logger } from '../../utils/logger.js';
import { publishMessage, subscribeToChannel } from '../../cache/valkey.js';
import { config } from '../../config.js';

const settingsLogger = Logger.for('ProviderSettingsLoader');

interface FieldAuthorityOverrideRow {
    field_name: string;
    provider: string;
    priority: number;
    is_anime?: boolean;
}

interface BuildOptions {
    adminOverrides?: FieldAuthorityOverrideRow[];
    animeOverrides?: FieldAuthorityOverrideRow[];
}

// ---------------------------------------------------------------------------
// New registry path — reads from ProviderDefinition (SDK contract)
// ---------------------------------------------------------------------------

/**
 * Per-provider operator settings that may override metadata defaults declared
 * in the ProviderDefinition. All fields are optional; absent fields fall back
 * to the definition's `metadata` field values.
 */
export interface ProviderSettings {
    /** Operator-supplied priority override. */
    priority?: number;
    /** Operator-supplied per-field authority overrides (merged on top of definition defaults). */
    fieldAuthorities?: Record<string, number>;
}

/**
 * Build a FieldAuthorityConfig from native ProviderDefinitions and optional
 * per-provider operator settings.
 *
 * Precedence rule per field authority:
 *   effective priority   = settings.priority ?? definition.metadata?.priority ?? 0
 *   effective fields     = { ...definition.metadata?.fieldAuthorities,
 *                             ...settings.fieldAuthorities }
 */
export function buildFieldAuthorityConfigFromDefinitions(
    definitions: ProviderDefinition[],
    settingsByProviderId: Map<string, ProviderSettings>,
    options?: BuildOptions,
): FieldAuthorityConfig {
    const fieldEntries: Record<string, Array<{ provider: string; priority: number }>> = {};

    for (const definition of definitions) {
        const settings = settingsByProviderId.get(definition.id);

        const effectivePriority = settings?.priority ?? definition.metadata?.priority ?? 0;

        const effectiveFieldAuthorities: Record<string, number> = {
            ...definition.metadata?.fieldAuthorities,
            ...settings?.fieldAuthorities,
        };

        for (const [field, weight] of Object.entries(effectiveFieldAuthorities)) {
            if (!fieldEntries[field]) fieldEntries[field] = [];
            fieldEntries[field].push({
                provider: definition.id,
                priority: weight,
            });
        }

        // If no per-field authorities, register the provider under a synthetic
        // __priority__ sentinel so callers that sort by global priority can
        // still rank this provider relative to others. The sentinel is not
        // exposed in defaultPriorities but is available for Phase 2 consumers
        // that need the full sorted provider list.
        if (Object.keys(effectiveFieldAuthorities).length === 0 && effectivePriority > 0) {
            const sentinel = '__priority__';
            if (!fieldEntries[sentinel]) fieldEntries[sentinel] = [];
            fieldEntries[sentinel].push({
                provider: definition.id,
                priority: effectivePriority,
            });
        }
    }

    const defaultPriorities: Record<string, string[]> = {};
    for (const [field, entries] of Object.entries(fieldEntries)) {
        if (field === '__priority__') continue;
        defaultPriorities[field] = entries
            .sort((a, b) => a.priority - b.priority)
            .map((e) => e.provider);
    }

    const adminOverrides = groupOverrides(options?.adminOverrides);
    const animeOverrides = groupOverrides(options?.animeOverrides);

    return {
        defaultPriorities,
        adminOverrides: Object.keys(adminOverrides).length > 0 ? adminOverrides : undefined,
        animeOverrides: Object.keys(animeOverrides).length > 0 ? animeOverrides : undefined,
    };
}

function groupOverrides(rows?: FieldAuthorityOverrideRow[]): Record<string, string[]> {
    if (!rows?.length) return {};

    const grouped: Record<string, Array<{ provider: string; priority: number }>> = {};

    for (const row of rows) {
        if (!grouped[row.field_name]) grouped[row.field_name] = [];
        grouped[row.field_name].push({
            provider: row.provider,
            priority: row.priority,
        });
    }

    const result: Record<string, string[]> = {};
    for (const [field, entries] of Object.entries(grouped)) {
        result[field] = entries.sort((a, b) => a.priority - b.priority).map((e) => e.provider);
    }

    return result;
}

// ---------------------------------------------------------------------------
// Operator-stored ProviderSettings loader (from plugin_settings table)
// ---------------------------------------------------------------------------

/**
 * Cache entry shape — the merged settings map plus the wall-clock timestamp at
 * which it was populated. We keep the timestamp here instead of using a
 * setTimeout so a sleeping process can't accidentally hand out fresh-looking
 * data after waking up.
 */
interface SettingsCacheEntry {
    settings: Map<string, ProviderSettings>;
    cachedAt: number;
}

const PROVIDER_SETTINGS_TTL_MS = 60_000;
const INVALIDATE_CHANNEL = 'lumastra:plugin-settings:invalidate';
let providerSettingsCache: SettingsCacheEntry | null = null;

/** Row shape from `plugin_settings`. `value` is JSONB so it's `unknown` here. */
interface PluginSettingsRow {
    plugin_id: string;
    key: string;
    value: unknown;
}

/**
 * Coerce a `plugin_settings.value` row into a number if possible. The JSONB
 * column can hold any JSON shape — operators (or buggy migrations) could store
 * a numeric string, an object, null, etc. We accept only `number` and numeric
 * strings; anything else is logged at debug and ignored.
 */
function coercePriority(value: unknown, pluginId: string): number | undefined {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
        // Number('') and Number('   ') both return 0 — would silently demote
        // a provider to priority 0 instead of rejecting the empty value. Force
        // the caller to supply a real digit before coercion.
        const trimmed = value.trim();
        if (trimmed.length === 0) {
            settingsLogger.debug('Ignoring empty-string priority override', {
                pluginId,
            });
            return undefined;
        }
        const parsed = Number(trimmed);
        if (Number.isFinite(parsed)) return parsed;
    }
    settingsLogger.debug('Ignoring non-numeric priority override', {
        pluginId,
        valueType: typeof value,
    });
    return undefined;
}

/**
 * Coerce a `plugin_settings.value` row into a `Record<string, number>` shaped
 * field-authorities object. Accepts only plain JSON objects whose values are
 * numbers (or numeric strings). Drops any non-numeric entries so a single bad
 * field can't poison the whole override.
 */
function coerceFieldAuthorities(
    value: unknown,
    pluginId: string,
): Record<string, number> | undefined {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        settingsLogger.debug('Ignoring non-object fieldAuthorities override', {
            pluginId,
            valueType: Array.isArray(value) ? 'array' : typeof value,
        });
        return undefined;
    }
    const out: Record<string, number> = {};
    for (const [field, raw] of Object.entries(value as Record<string, unknown>)) {
        const coerced = coercePriority(raw, pluginId);
        if (coerced !== undefined) out[field] = coerced;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Load operator-set per-provider settings from the `plugin_settings` table.
 *
 * Schema reminder (15.0.0_task_system_redesign):
 *   CREATE TABLE plugin_settings (
 *       plugin_id  TEXT NOT NULL,
 *       key        TEXT NOT NULL,
 *       value      JSONB NOT NULL,
 *       updated_at TIMESTAMPTZ DEFAULT NOW(),
 *       PRIMARY KEY (plugin_id, key)
 *   )
 *
 * Two reserved keys feed `ProviderSettings`:
 *   - `priority`         → number, overrides `definition.metadata.priority`
 *   - `fieldAuthorities` → object `{field: weight}`, merged into
 *                          `definition.metadata.fieldAuthorities`
 *
 * Other keys (provider-specific config like API endpoints, feature toggles)
 * are ignored here — they're consumed via `ctx.settings()` inside the plugin.
 *
 * Best-effort: returns an empty map on missing DB / query failure / no rows.
 * Callers fall back to manifest defaults in that case. Startup requests
 * strict mode so an outage can be retried before accepting those defaults.
 *
 * @param sql         Postgres handle. Pass `null` to short-circuit (returns empty map).
 * @param providerIds Optional whitelist — restrict the query to specific provider ids.
 *                    When omitted, all rows are scanned (typical for boot-time loads).
 */
export interface ProviderSettingsLoadOptions {
    /** Startup must retry SQL failure rather than permanently use manifest defaults. */
    strict?: boolean;
}

export async function loadProviderSettings(
    sql: postgres.Sql | null,
    providerIds?: string[],
    options: ProviderSettingsLoadOptions = {},
): Promise<Map<string, ProviderSettings>> {
    const out = new Map<string, ProviderSettings>();
    if (!sql) return out;
    if (providerIds && providerIds.length === 0) return out;

    try {
        const rows = providerIds
            ? await sql<PluginSettingsRow[]>`
                SELECT plugin_id, key, value
                FROM plugin_settings
                WHERE plugin_id = ANY(${sql.array(providerIds)}::text[])
                  AND key IN ('priority', 'fieldAuthorities')
            `
            : await sql<PluginSettingsRow[]>`
                SELECT plugin_id, key, value
                FROM plugin_settings
                WHERE key IN ('priority', 'fieldAuthorities')
            `;

        for (const row of rows) {
            const existing = out.get(row.plugin_id) ?? {};
            if (row.key === 'priority') {
                const coerced = coercePriority(row.value, row.plugin_id);
                if (coerced !== undefined) existing.priority = coerced;
            } else if (row.key === 'fieldAuthorities') {
                const coerced = coerceFieldAuthorities(row.value, row.plugin_id);
                if (coerced) existing.fieldAuthorities = coerced;
            }
            out.set(row.plugin_id, existing);
        }
    } catch (err) {
        if (options.strict) throw err;
        settingsLogger.warn('loadProviderSettings failed — falling back to manifest defaults', {
            err: err instanceof Error ? err.message : String(err),
        });
        return new Map();
    }

    return out;
}

/**
 * Cached variant of `loadProviderSettings`. The metadata-aggregation hot path
 * (CatalogService.getOrCreateByExternalId) hits this once per write — caching
 * at a 60s TTL bounds DB pressure while still letting admin PATCH propagate
 * through `invalidateProviderSettingsCache()`.
 *
 * The cache is process-local. In a multi-replica deployment, each replica
 * gets its own 60s drift window unless the admin PATCH is fanned out — that
 * trade-off matches every other in-memory config cache in the codebase.
 */
export async function loadProviderSettingsCached(
    sql: postgres.Sql | null,
): Promise<Map<string, ProviderSettings>> {
    const now = Date.now();
    if (providerSettingsCache && now - providerSettingsCache.cachedAt < PROVIDER_SETTINGS_TTL_MS) {
        // Hand back a copy so a caller that mutates the result doesn't
        // corrupt the shared cache. The Map is small (~5 entries) so the
        // shallow clone is cheap; values are kept by reference, which is
        // safe because ProviderSettings is treated as immutable by all
        // current consumers.
        return new Map(providerSettingsCache.settings);
    }
    const settings = await loadProviderSettings(sql);
    providerSettingsCache = { settings, cachedAt: now };
    return new Map(settings);
}

/**
 * Local-only cache drop — no cross-replica fanout. Used as the leaf behaviour
 * inside the subscriber callback so remote invalidation events don't loop back
 * through Valkey a second time.
 */
export function invalidateProviderSettingsCacheLocal(): void {
    providerSettingsCache = null;
}

/**
 * Drop the in-process cache and broadcast an invalidation event to all other
 * replicas via Valkey pub/sub. Wired into admin PATCH/PUT so operator changes
 * take effect on every replica without waiting for the 60s TTL.
 *
 * Degrades gracefully when Valkey is unavailable — the local invalidation
 * always runs; only the cross-replica fanout is skipped.
 */
export async function invalidateProviderSettingsCache(): Promise<void> {
    invalidateProviderSettingsCacheLocal();
    try {
        const published = await publishMessage(INVALIDATE_CHANNEL, config.INSTANCE_ID);
        if (!published) {
            settingsLogger.warn(
                'plugin-settings invalidate publish skipped — Valkey unavailable, local-only invalidation applied',
            );
        }
    } catch (err) {
        settingsLogger.warn('plugin-settings invalidate publish failed', {
            err: err instanceof Error ? err.message : String(err),
        });
    }
}

// Module-level guard so duplicate calls to startProviderSettingsCacheInvalidation
// don't accumulate retry timers if Valkey is unavailable. The Valkey-available
// path is idempotent in subscribeToChannel itself; only the retry-timer path
// needs this guard.
let retryTimerActive = false;

/**
 * Subscribe to the invalidation channel so this replica drops its cache when
 * another replica broadcasts a plugin-settings change. Idempotent —
 * `subscribeToChannel` deduplicates subscriptions per channel internally.
 *
 * Call once at server boot (hooks.server.ts). A null return from
 * `subscribeToChannel` means Valkey is not configured — we retry every
 * 30 seconds so a replica that booted during Valkey downtime picks the
 * subscription back up when Valkey recovers, instead of being permanently
 * degraded to local-TTL-only invalidation.
 */
export async function startProviderSettingsCacheInvalidation(): Promise<void> {
    const cleanup = await subscribeToChannel(INVALIDATE_CHANNEL, (senderId) => {
        // Skip self-messages — the publisher already called invalidateProviderSettingsCacheLocal()
        // before broadcasting, so re-running it here would be a redundant no-op on the originating
        // replica. Other replicas (different INSTANCE_ID) always proceed.
        if (senderId === config.INSTANCE_ID) return;
        invalidateProviderSettingsCacheLocal();
    });
    if (cleanup) return;

    if (retryTimerActive) return;
    retryTimerActive = true;

    settingsLogger.warn(
        'Failed to subscribe to plugin-settings invalidation channel — retrying every 30s until Valkey is available',
    );
    const retryTimer = setInterval(() => {
        void (async () => {
            try {
                const next = await subscribeToChannel(INVALIDATE_CHANNEL, (senderId) => {
                    if (senderId === config.INSTANCE_ID) return;
                    invalidateProviderSettingsCacheLocal();
                });
                if (next) {
                    clearInterval(retryTimer);
                    retryTimerActive = false;
                    settingsLogger.info(
                        'plugin-settings invalidation channel re-subscribed after Valkey recovery',
                    );
                }
            } catch (err) {
                // subscribeToChannel CAN throw on Valkey wire-protocol errors;
                // a void-promise rejection here is silent and obscures the
                // reason an operator's cluster never re-subscribes.
                settingsLogger.warn('plugin-settings invalidation retry attempt failed', {
                    error: err instanceof Error ? err.message : String(err),
                });
            }
        })();
    }, 30_000);
    if (typeof retryTimer.unref === 'function') retryTimer.unref();
}
