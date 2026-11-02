// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Service manager for admin-facing external-plugin operations. Orchestrates the
 * registry query module + task registry + loader; performs NO route SQL. The
 * read join and the lifecycle wrappers are the single source consumed by BOTH
 * the internal admin BFF and the v1 defs (DRY).
 *
 * TRUST: reads only. Trusted keys / gate flags are ENV-only and resolved via the
 * shipped trust-anchors module; this manager never touches ConfigService.
 */
import type postgres from 'postgres';
import path from 'node:path';
import fs from 'node:fs';
import {
    listExternalPluginsIncludingPendingRemoval,
    getExternalPlugin,
    setExternalPluginEnabled,
    markExternalPluginUninstalled,
} from '$lib/server/database/queries/external-plugins.queries.js';
import type { ExternalPluginRow } from '$lib/server/database/queries/external-plugins.queries.js';
import { registry as taskRegistry, ID_PATTERN } from '$lib/server/tasks/registry.js';
import {
    externalPluginsDir,
    lastLoadError,
    listDropInPlugins,
    loadAndWirePlugin,
} from '$lib/server/plugins/runtime/loader.js';
import {
    buildEffectiveTrustedKeys,
    classifyKeyId,
} from '$lib/server/plugins/external-install/trust-anchors.js';
import { isInvalidBundle } from '$lib/server/plugins/external-install/bundle-artifact.js';
import { auditLog, type AuditActor } from '$lib/server/utils/audit-log.js';
import { isRecord } from '$lib/utils/data-extraction.js';
import type {
    ExternalPluginCapabilities,
    ExternalPluginListItem,
} from '$lib/schemas/api-external-plugins.js';

export interface ExternalPluginListResult {
    items: ExternalPluginListItem[];
    trustedKeysConfigured: boolean;
}

/** Permissive, never-throwing coercion of the persisted capabilities jsonb. */
function coerceCapabilities(
    raw: Record<string, unknown> | null,
): ExternalPluginCapabilities | undefined {
    if (raw === null) return undefined;
    return isRecord(raw) ? raw : undefined;
}

/**
 * Canonical kind badge, derived LIVE from whichever registry getter resolves the
 * id (undefined when the plugin is not currently loaded). Order is fixed; the
 * mapping is pinned to the v1 schema's `kind` vocabulary.
 */
/**
 * Which contract an installed plugin registered as, for the admin card's badge.
 *
 * EVERY family must be listed. A missing one does not degrade gracefully — the
 * card renders with a blank kind, so a plugin that installed and loaded
 * perfectly looks half-broken to the operator inspecting it. The registry's own
 * getters are the source of truth for what exists; this list has to keep up
 * with them.
 */
function registeredKindOf(id: string): string | undefined {
    if (taskRegistry.getTask(id)) return 'task';
    if (taskRegistry.getProvider(id)) return 'provider';
    if (taskRegistry.getTrickplay(id)) return 'trickplay';
    if (taskRegistry.getWatchSync(id)) return 'watch-sync';
    if (taskRegistry.getFeature(id)) return 'feature';
    if (taskRegistry.getIntegration(id)) return 'integration';
    if (taskRegistry.getExternalService(id)) return 'external-service';
    if (taskRegistry.getMediaSource(id)) return 'media-source';
    if (taskRegistry.getSubtitleProvider(id)) return 'subtitle-provider';
    if (taskRegistry.getLyricsProvider(id)) return 'lyrics-provider';
    if (taskRegistry.getAuthProvider(id)) return 'auth-provider';
    return undefined;
}

/**
 * The version a plugin actually declared, from whichever contract registered it.
 *
 * The DEFINITION is the authority: it is what loaded, whereas a package.json
 * sitting beside it is metadata that can be stale or — for a drop-in — absent
 * entirely. Reading only package.json is why every drop-in on the production
 * box displayed as "vunknown" despite most contracts requiring a version.
 *
 * `FeatureDefinition` and `IntegrationDefinition` gained an optional `version`
 * alongside this; before that they had no field at all, which is the other half
 * of the same gap.
 */
function registeredVersionOf(id: string): string | undefined {
    const def =
        taskRegistry.getTask(id) ??
        taskRegistry.getProvider(id) ??
        taskRegistry.getTrickplay(id) ??
        taskRegistry.getWatchSync(id) ??
        taskRegistry.getFeature(id) ??
        taskRegistry.getIntegration(id) ??
        taskRegistry.getExternalService(id) ??
        taskRegistry.getMediaSource(id) ??
        taskRegistry.getSubtitleProvider(id) ??
        taskRegistry.getLyricsProvider(id) ??
        taskRegistry.getAuthProvider(id);
    const version = (def as { version?: unknown } | undefined)?.version;
    return typeof version === 'string' && version ? version : undefined;
}

/**
 * A managed plugin is "installed" per the registry but has no directory on disk.
 *
 * This is not hypothetical. `PLUGINS_EXTERNAL_DIR` defaults to `/app/plugins`,
 * which in the reference container lives in the IMAGE layer rather than on a
 * volume, so a routine image update deletes every installed plugin while its
 * registry row survives in Postgres. The loader cannot report it, because it
 * discovers plugins by listing directories — one that is absent is simply never
 * discovered, and the boot log honestly says `errors: 0`.
 *
 * Without this check the operator sees "installed, enabled, not loaded, no
 * error", which is exactly what a pending restart looks like. Silent data loss
 * that mimics a normal state is the worst version of this bug, so name it.
 *
 * Only consulted when the plugin is NOT loaded: a loaded plugin's files were
 * necessarily there at import time, and this is a per-row stat on a read path.
 */
function missingDirError(r: ExternalPluginRow, loaded: boolean): string | undefined {
    if (loaded || r.status !== 'installed') return undefined;
    const dir = path.join(externalPluginsDir(), r.name);
    if (fs.existsSync(dir)) return undefined;
    return `plugin files are missing from ${dir} — the registry still lists this plugin as installed, but its directory is gone. If PLUGINS_EXTERNAL_DIR is not on a persistent volume, an image update deletes it. Reinstall, and mount that directory.`;
}

function toItem(
    r: ExternalPluginRow,
    loaded: boolean,
    effective: ReturnType<typeof buildEffectiveTrustedKeys>,
): ExternalPluginListItem {
    return {
        id: r.name,
        name: r.name,
        version: r.version,
        kind: registeredKindOf(r.name),
        enabled: r.enabled,
        status: r.status,
        loaded,
        // A recorded load error wins: it is the more specific diagnosis.
        error: lastLoadError.get(r.name) ?? missingDirError(r, loaded),
        restartRequired: (r.enabled && !loaded) || (!r.enabled && loaded),
        source: 'registry',
        capabilities: coerceCapabilities(r.capabilities),
        sdkAbi: r.sdkAbi ?? 1,
        ...(r.manifestMetadata ? { manifestMetadata: r.manifestMetadata } : {}),
        signingKeyId: r.signingKeyId ?? undefined,
        signingKeySource: classifyKeyId(r.signingKeyId, effective),
        isBundle: r.bundle !== null && !isInvalidBundle(r.bundle),
        bundleInvalid: isInvalidBundle(r.bundle),
        installedAt: r.installedAt,
        updatedAt: r.updatedAt,
    };
}

export async function listExternalPluginsWithState(
    sql: postgres.Sql,
): Promise<ExternalPluginListResult> {
    const rows = await listExternalPluginsIncludingPendingRemoval(sql);
    // Built ONCE per call — not per row — so a collision/malformed WARN is not
    // re-emitted N times and both consumers share one effective build.
    const effective = buildEffectiveTrustedKeys();
    const items = rows
        .map((r) => toItem(r, taskRegistry.hasPluginRegistered(r.name), effective))
        // Drop rows that are BOTH uninstalled AND no longer loaded — genuinely gone.
        .filter((i) => !(i.status === 'uninstalled' && !i.loaded));

    // Registry-less drop-ins. They have no row, so the query above cannot see
    // them — which meant a deployment running only drop-ins (still the default
    // install model) showed an EMPTY plugin page. Listed read-only: with no row
    // there is nothing for enable/disable/uninstall to act on.
    const seen = new Set(items.map((i) => i.id));
    for (const d of await listDropInPlugins(sql)) {
        if (seen.has(d.name)) continue;
        const loaded = taskRegistry.hasPluginRegistered(d.name);
        items.push({
            id: d.name,
            name: d.name,
            // Definition first, then package.json, then nothing. Never a
            // placeholder: '1.0.0' would be a fabrication and 'unknown' renders
            // as "vunknown". Absence is the UI's problem to present, not the
            // data layer's to paper over.
            version: registeredVersionOf(d.name) ?? d.version ?? '',
            kind: registeredKindOf(d.name),
            // Its only "off" switch is removing the directory, so it is enabled
            // exactly when it is on disk.
            enabled: true,
            status: 'installed',
            loaded,
            error: lastLoadError.get(d.name),
            // Nothing to toggle, so nothing can be pending a restart.
            restartRequired: false,
            sdkAbi: undefined,
            isBundle: false,
            bundleInvalid: false,
            installedAt: '',
            updatedAt: '',
            source: d.origin,
            ...(d.shadowedCopy ? { shadowedCopy: true } : {}),
        });
    }

    return { items, trustedKeysConfigured: effective.length > 0 };
}

// ── lifecycle wrappers (v1 parity — extracted byte-for-byte from the shipped
//    v1 [id] handler bodies so the internal BFF and the v1 defs call ONE
//    implementation). Each returns {status, body} instead of a Response. The
//    null-DB 500 stays in the def (sql here is non-null).

export interface LifecycleResult {
    status: number; // 200 | 404 | 500
    body:
        | { id: string; enabled: true; loaded: boolean; error?: string; restartRequired: boolean }
        | { id: string; enabled: false; restartRequired: true }
        | { id: string; reloaded: boolean; version?: string; restartRequired: boolean }
        | { id: string; uninstalled: true; restartRequired: true; warning?: string }
        | { error: string };
}

export async function enableExternalPlugin(
    sql: postgres.Sql,
    id: string,
    actor: AuditActor | null,
): Promise<LifecycleResult> {
    if (!ID_PATTERN.test(id)) return { status: 404, body: { error: 'unknown plugin' } };
    const row = await getExternalPlugin(sql, id);
    if (!row) return { status: 404, body: { error: 'unknown plugin' } };
    // NOTE (preserved quirk): enabling an 'uninstalled' row yields enabled:true +
    // status:'uninstalled'; the next restart will NOT load it (listLoadable requires
    // status='installed'). Byte-for-byte with the shipped handler — a guard is a
    // deferred follow-up (spec §7), NOT a fix to make here.
    await setExternalPluginEnabled(sql, row.name, true);
    const dir = path.join(externalPluginsDir(), row.name);
    auditLog('plugin.external.enable', row.name, actor);
    if (taskRegistry.hasPluginRegistered(row.name)) {
        return {
            status: 200,
            body: { id: row.name, enabled: true, loaded: true, restartRequired: false },
        };
    }
    // A bundle's entry is whatever the SIGNED manifest declared — `main.js`,
    // `dist/index.js`, anything the path rules allow. Hardcoding index.js meant
    // such a plugin never attempted the hot-load and always reported "restart
    // required", even when enabling it would have worked: the single-file
    // convention applied to the bundle path, where it does not hold.
    const entry =
        row.bundle !== null && !isInvalidBundle(row.bundle) && typeof row.bundle.entry === 'string'
            ? row.bundle.entry
            : 'index.js';
    if (!fs.existsSync(path.join(dir, entry))) {
        return {
            status: 200,
            body: { id: row.name, enabled: true, loaded: false, restartRequired: true },
        };
    }
    const wired = await loadAndWirePlugin(dir, sql);
    return {
        status: 200,
        body: {
            id: row.name,
            enabled: true,
            loaded: wired.loaded,
            error: wired.loaded ? undefined : lastLoadError.get(row.name),
            restartRequired: !wired.loaded,
        },
    };
}

export async function disableExternalPlugin(
    sql: postgres.Sql,
    id: string,
    actor: AuditActor | null,
): Promise<LifecycleResult> {
    if (!ID_PATTERN.test(id)) return { status: 404, body: { error: 'unknown plugin' } };
    const row = await getExternalPlugin(sql, id);
    if (!row) return { status: 404, body: { error: 'unknown plugin' } };
    await setExternalPluginEnabled(sql, row.name, false);
    auditLog('plugin.external.disable', row.name, actor);
    // Always restartRequired:true — unload is restart-only (preserved byte-for-byte,
    // even when the plugin was never loaded; the card badge uses list-truth instead).
    return { status: 200, body: { id: row.name, enabled: false, restartRequired: true } };
}

export async function reloadExternalPlugin(
    sql: postgres.Sql,
    id: string,
    actor: AuditActor | null,
): Promise<LifecycleResult> {
    if (!ID_PATTERN.test(id)) return { status: 404, body: { error: 'unknown plugin' } };
    const row = await getExternalPlugin(sql, id);
    if (!row) return { status: 404, body: { error: 'unknown plugin' } };
    if (taskRegistry.hasPluginRegistered(row.name)) {
        auditLog('plugin.external.reload', row.name, actor, { reloaded: false });
        // [Fable-6] honest no-op: unload is restart-only, cannot swap in place. No
        // `version` on this branch (matches the shipped handler — keep it absent).
        return { status: 200, body: { id: row.name, reloaded: false, restartRequired: true } };
    }
    const wired = await loadAndWirePlugin(path.join(externalPluginsDir(), row.name), sql);
    auditLog('plugin.external.reload', row.name, actor, { reloaded: wired.loaded });
    return {
        status: 200,
        body: {
            id: row.name,
            reloaded: wired.loaded,
            version: row.version,
            restartRequired: !wired.loaded,
        },
    };
}

export async function uninstallExternalPlugin(
    sql: postgres.Sql,
    id: string,
    actor: AuditActor | null,
): Promise<LifecycleResult> {
    if (!ID_PATTERN.test(id)) return { status: 404, body: { error: 'unknown plugin' } };
    const row = await getExternalPlugin(sql, id);
    if (!row) return { status: 404, body: { error: 'unknown plugin' } };
    await markExternalPluginUninstalled(sql, row.name);
    auditLog('plugin.external.uninstall', row.name, actor);
    try {
        fs.rmSync(path.join(externalPluginsDir(), row.name), { recursive: true, force: true });
    } catch (err) {
        // Dir-removal failure → soft 500, row already updated. [review — uninstall drift]
        return {
            status: 500,
            body: {
                id: row.name,
                uninstalled: true,
                restartRequired: true,
                warning: `dir removal failed: ${String(err)}`,
            },
        };
    }
    return { status: 200, body: { id: row.name, uninstalled: true, restartRequired: true } };
}

// Install is already a service call — re-export it so both surfaces import from
// the manager (no new install logic here).
export {
    installExternalPlugin,
    type InstallInput,
    type InstallResult,
} from '$lib/server/plugins/external-install/installer.js';
