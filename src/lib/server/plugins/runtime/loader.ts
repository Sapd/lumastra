// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Plugin Loader
 *
 * Discovers and loads plugins from various sources:
 * - Built-in plugins (import.meta.glob at build time)
 * - External plugins (dynamic import at runtime)
 *
 * SECURITY CONSIDERATIONS:
 * External plugins are loaded via dynamic import() from PLUGINS_EXTERNAL_DIR.
 * This directory should be:
 * - Mounted read-only in production (Docker: :ro flag)
 * - Owned by root with restrictive permissions
 * - Only contain trusted, verified plugin code
 *
 * Plugin code has access to:
 * - Database connection (if capabilities.database is true)
 * - Cache system (if capabilities.cache is true)
 * - HTTP client (if capabilities.http is true, rate-limited)
 * - File system (limited to plugin's data directory)
 *
 * FUTURE: Consider implementing:
 * - Plugin signing/verification
 * - Sandboxed execution via vm2 or isolated-vm
 * - Resource limits (CPU/memory)
 * - Network domain whitelisting
 */

import { markTaskFromPlugin } from './task-origin.js';
import type postgres from 'postgres';
import {
    buildFieldAuthorityConfigFromDefinitions,
    loadProviderSettings,
} from './field-authority-loader.js';
import { setEffectiveFieldPriorities } from '../../database/queries/metadata-aggregation.queries.js';
import { registry as taskRegistry, ID_PATTERN } from '$lib/server/tasks/registry.js';
import {
    PLUGIN_SDK_ABI,
    defineTask,
    defineProvider,
    defineTrickplayProvider,
    defineWatchSync,
    defineFeature,
    defineIntegration,
    defineMediaSource,
    defineExternalService,
    defineSubtitleProvider,
    defineLyricsProvider,
    defineAuthProvider,
} from '@sapd/lumastra-plugin-sdk';
import type {
    ProviderDefinition,
    TaskDefinition,
    FeatureDefinition,
    IntegrationDefinition,
    TrickplayProviderDefinition,
    WatchSyncDefinition,
    MediaSourceDefinition,
    ExternalServiceDefinition,
    SubtitleProviderDefinition,
    LyricsProviderDefinition,
    AuthProviderDefinition,
} from '@sapd/lumastra-plugin-sdk';
import { registerProviderNormalizer, type NormalizerModule } from '../../providers/normalize.js';
import { registerProviderEncoder, type EncodeFn } from '../../providers/encode-id.js';
import { Logger } from '../../utils/logger.js';
import { config } from '../../config.js';
import { loadTimeCapabilityViolation } from '$lib/server/plugins/external-install/loaded-capabilities.js';
import { getExternalPlugin } from '../../database/queries/external-plugins.queries.js';
import { computeTreeDigest, computeTreeDigestFromFiles } from '../external-install/archive.js';
import { bundleLimitsFromConfig } from '../external-install/bundle-limits.js';
import { isInvalidBundle, type BundleArtifact } from '../external-install/bundle-artifact.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const logger = Logger.for('PluginLoader');
const reportedShadowedPlugins = new Set<string>();

// =============================================================================
// External Plugin Loading
// =============================================================================

/**
 * External plugin directory configuration.
 *
 * Read from `process.env` on EVERY call (not captured at module-eval time) so
 * the installer and tests can point the loader at a fresh staging dir without
 * a process restart. [review C7]
 */
export function externalPluginsDir(): string {
    return process.env.PLUGINS_EXTERNAL_DIR || '/app/plugins';
}

/**
 * Where the IMAGE ships its own first-party plugins, read-only at runtime.
 *
 * Separate from the install directory on purpose. They shared one path until
 * now, and that single decision caused two distinct problems:
 *
 *   - Persistence had to be solved for both at once. Mounting a volume over the
 *     shared path is what makes installs survive an image update, but a NAMED
 *     volume is seeded from the image only on FIRST use and never re-seeded —
 *     so from then on the operator's volume held a frozen copy of the bundled
 *     plugins, and a first-party plugin updated (or newly added) in a later
 *     image never appeared. The fix for one problem created the other.
 *
 *   - `PLUGINS_REQUIRE_REGISTRY=true` could not be recommended. Bundled plugins
 *     have no registry row, so strict mode silently disabled all four of them —
 *     which made the one setting that closes the unverified-drop-in hole
 *     unusable in practice.
 *
 * Splitting the directories resolves both: the image dir is authoritative for
 * what it ships and is always current, the install dir is a volume, and neither
 * constrains the other.
 */
export function bundledPluginsDir(): string {
    return process.env.PLUGINS_BUNDLED_DIR || '/app/plugins-bundled';
}

/**
 * Is the plugin directory backed by something that survives a new image?
 *
 * The default `/app/plugins` lives in the container's writable layer, so a
 * deployment that mounts nothing there loses every installed plugin on the next
 * image pull while the registry rows survive in Postgres. That is not
 * hypothetical: recreating the container took the plugin directories from 16 to
 * 4 on preprod, and the loader could not report it — it discovers by listing
 * directories, and one that is gone is simply never discovered.
 *
 * A mount boundary is a change of st_dev between a directory and its parent.
 * Cheap, no /proc parsing, and correct for both bind mounts and volumes.
 *
 * Returns null when the answer cannot be determined (path missing, stat fails,
 * or it is the filesystem root) — callers must treat null as "do not warn"
 * rather than as "not persistent", because a false alarm on every boot trains
 * operators to ignore the message that matters.
 */
export function pluginsDirIsPersistent(dir = externalPluginsDir()): boolean | null {
    try {
        const parent = path.dirname(dir);
        if (parent === dir) return null;
        if (!fs.existsSync(dir) || !fs.existsSync(parent)) return null;
        return fs.statSync(dir).dev !== fs.statSync(parent).dev;
    } catch {
        return null;
    }
}

/**
 * Warn once at boot when installs would not survive an image update.
 *
 * Checks the RESOLVED directory whether or not `PLUGINS_EXTERNAL_DIR` is set.
 * An earlier version returned early on an explicit env var, reasoning that an
 * operator who set it had chosen deliberately — but choosing the path and
 * choosing a non-persistent one are different decisions, and someone who points
 * the variable at a plain directory has exactly the problem this warns about.
 * Skipping them silenced the case most likely to be a mistake.
 *
 * It also made the warning untestable, since the fallback is a hardcoded
 * container path: the only reachable branch was the silent one.
 */
export function warnIfPluginsDirEphemeral(dir = externalPluginsDir()): void {
    if (pluginsDirIsPersistent(dir) !== false) return;
    logger.warn(
        `${dir} is not a mount point — installed plugins will be DELETED by the next image update`,
        {
            dir,
            fix: `mount a volume at ${dir}, or set PLUGINS_EXTERNAL_DIR to a path that is one`,
            note: 'registry rows survive, so the admin page keeps listing plugins whose files are gone',
        },
    );
}

/**
 * Per-plugin last load error, keyed by plugin **name** (on-disk dir basename).
 * Set on load throw / sdk-import error / validation error; cleared on a clean
 * load. Read by the install def GET list so the admin UI can show why a
 * registry-listed plugin isn't loaded. [review C12]
 */
export const lastLoadError = new Map<string, string>();

/**
 * Check if external plugins are enabled.
 */
export function isExternalPluginsEnabled(): boolean {
    return process.env.PLUGINS_ENABLED !== 'false';
}

/**
 * Discover external plugins under `$PLUGINS_EXTERNAL_DIR`. Each plugin lives
 * in its own subdirectory containing an `index.js` (or whatever path the
 * subdirectory's `package.json` `main` field points at — checked first;
 * `index.js` is the fallback). Directories without an entry point are
 * skipped silently.
 *
 * Registry-aware: a dir with a registry row is kept only when it is loadable
 * (`status='installed' AND enabled`); a registry-LESS dir is kept only when
 * `config.PLUGINS_REQUIRE_REGISTRY` is false (legacy drop-in). Dot-prefixed
 * dirs (`.tmp-*` / `.old-*` installer staging leftovers) are skipped outright
 * — their basename can never be a valid plugin id, so importing them would
 * bypass the signature/checksum gate and clash on the id. [Fable-3]
 *
 * Async + takes `sql` (was sync) so callers must `await` and pass a handle.
 */
export async function discoverExternalPlugins(sql: postgres.Sql): Promise<string[]> {
    if (!isExternalPluginsEnabled()) {
        logger.info('External plugins disabled');
        return [];
    }

    const discovered: string[] = [];
    const seen = new Set<string>();

    // BUNDLED FIRST, and it wins a name collision.
    //
    // The image dir is authoritative for the plugins it ships. An operator's
    // install volume can hold a frozen copy of those same plugins — a named
    // volume is seeded from the image on first use and never re-seeded — so
    // preferring the install dir would pin every first-party plugin to whatever
    // the image contained the day the volume was created. Scanning bundled
    // first means the shipped version is always the one that loads, and the
    // stale copy is inert rather than shadowing it.
    for (const scope of ['bundled', 'installed'] as const) {
        const baseDir = scope === 'bundled' ? bundledPluginsDir() : externalPluginsDir();
        if (!fs.existsSync(baseDir)) {
            logger.debug('Plugin directory does not exist', { path: baseDir, scope });
            continue;
        }

        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(baseDir, { withFileTypes: true });
        } catch (error) {
            logger.error('Failed to discover plugins', error as Error, { path: baseDir, scope });
            continue;
        }

        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            // Skip installer staging droppings (.tmp-*/.old-*): registry-less,
            // never a valid plugin id, must never reach the legacy import path.
            if (entry.name.startsWith('.')) continue;

            const pluginDir = path.join(baseDir, entry.name);

            if (seen.has(entry.name)) {
                // Only reachable for an installed dir shadowed by a bundled one.
                // Expected after bundling an installed plugin. Report each name
                // once per process, including across discovery/reload passes.
                if (!reportedShadowedPlugins.has(entry.name)) {
                    reportedShadowedPlugins.add(entry.name);
                    logger.info('Ignoring installed plugin shadowed by the bundled copy', {
                        name: entry.name,
                        ignored: pluginDir,
                        using: path.join(bundledPluginsDir(), entry.name),
                    });
                }
                continue;
            }

            if (scope === 'bundled') {
                // Bundled plugins are part of the verified application image, so
                // they are EXEMPT from PLUGINS_REQUIRE_REGISTRY. Shipping inside
                // the image is a stronger provenance guarantee than a registry
                // row, and without this exemption strict mode would silently
                // disable every first-party plugin — which is precisely why
                // enabling it could not be recommended before.
                if (!resolveEntryPoint(pluginDir)) continue;
            } else {
                const row = await getExternalPlugin(sql, entry.name);
                if (row) {
                    // Registry-managed: keep only if loadable.
                    if (row.status === 'uninstalled' || !row.enabled) continue;
                } else {
                    // Registry-less drop-in: skipped entirely in strict mode.
                    if (config.PLUGINS_REQUIRE_REGISTRY) continue;
                    if (!resolveEntryPoint(pluginDir)) continue;
                }
            }

            seen.add(entry.name);
            discovered.push(pluginDir);
            logger.debug('Discovered plugin', { name: entry.name, path: pluginDir, scope });
        }
    }

    return discovered;
}

/**
 * Resolve a plugin's entry-point file:
 *   1. If `package.json` exists and declares `main`, honour that.
 *   2. Otherwise fall back to `index.js`.
 *   3. Returns `null` if no entry point exists.
 */
function resolveEntryPoint(pluginDir: string): string | null {
    const packageJsonPath = path.join(pluginDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
                main?: string;
            };
            if (pkg.main) {
                const mainPath = path.join(pluginDir, pkg.main);
                const resolved = path.resolve(mainPath);
                const resolvedDir = path.resolve(pluginDir);
                if (resolved !== resolvedDir && !resolved.startsWith(resolvedDir + path.sep)) {
                    logger.error('Plugin package.json main escapes plugin dir', undefined, {
                        pluginDir,
                        main: pkg.main,
                        resolved,
                    });
                    return null;
                }
                if (fs.existsSync(resolved)) return resolved;
            }
        } catch {
            // Fall through to index.js
        }
    }
    // index.js FIRST: a plugin shipping source alongside its build must run the
    // build, because that is the artifact the signature and the treeDigest were
    // taken over. Falling back to source would put a transformation between the
    // hash and the executed code.
    const indexPath = path.join(pluginDir, 'index.js');
    if (fs.existsSync(indexPath)) return indexPath;

    // TypeScript source, run directly. Node 24 (the runtime image) strips types
    // on import, so this needs no build step from the author.
    //
    // STRIP-ONLY, which is a real limit rather than a footnote: constructs that
    // need code GENERATED rather than removed — `enum`, `namespace`, parameter
    // properties, decorators — throw at import with "not supported in strip-only
    // mode". Authors using those must compile, which is what shipping index.js
    // is for.
    const tsPath = path.join(pluginDir, 'index.ts');
    if (fs.existsSync(tsPath)) return tsPath;
    return null;
}

// ---------------------------------------------------------------------------
// SDK-definition detection
//
// External plugins export ONE of the eleven SDK contract shapes as their
// default export (either a plain object matching the shape, or the result of
// a `defineX(...)` call). The host detects which contract is implemented by
// duck-typing on required methods, then registers against the task registry.
//
// Detection ordering matters — more-specific shapes are checked first so a
// MediaSourceDefinition isn't mistaken for a ProviderDefinition just because
// both declare `isConfigured`.
// ---------------------------------------------------------------------------

type ExternalSdkDefinition =
    | { kind: 'task'; def: TaskDefinition }
    | { kind: 'provider'; def: ProviderDefinition }
    | { kind: 'trickplay'; def: TrickplayProviderDefinition }
    | { kind: 'watch-sync'; def: WatchSyncDefinition }
    | { kind: 'feature'; def: FeatureDefinition }
    | { kind: 'integration'; def: IntegrationDefinition }
    | { kind: 'media-source'; def: MediaSourceDefinition }
    | { kind: 'external-service'; def: ExternalServiceDefinition }
    | { kind: 'subtitle-provider'; def: SubtitleProviderDefinition }
    | { kind: 'lyrics-provider'; def: LyricsProviderDefinition }
    | { kind: 'auth-provider'; def: AuthProviderDefinition };

/** Method names that, if present, mean the export is NOT a settings-only external service. */
/**
 * Every method that means "this export is a contract, not an external service".
 *
 * The external-service branch accepts anything with an id and NO contract
 * method, so a name missing from this list is not a harmless omission — the
 * plugin is absorbed as an external service, registers cleanly as the wrong
 * kind, and its behaviour silently never runs. Add a method here whenever a
 * contract gains one, including optional ones that a plugin might legitimately
 * ship on their own.
 */
const CONTRACT_METHOD_KEYS = [
    'execute',
    'pushWatchState',
    'pullWatchState',
    'scan',
    'fullSync',
    'getStatus',
    'fetchParams',
    'handleWebhook',
    'sendNotification',
    'search',
    'detail',
    'childList',
    'download',
    'fetchLyrics',
    'verifyCredentials',
    'beginLogin',
    'completeLogin',
    // Optional integration/feature hooks. A plugin whose whole purpose is a
    // playback veto or a home row ships one of these and nothing else.
    'authorizePlayback',
    'homeSections',
    'decorateCards',
] as const;

function detectSdkDefinition(exported: unknown): ExternalSdkDefinition | null {
    if (!exported || typeof exported !== 'object') return null;
    // Wrap in try/catch — a Proxy that throws on property access (rare but
    // possible) shouldn't crash the loader; the plugin is just rejected.
    try {
        const e = exported as Record<string, unknown>;

        if (typeof e.execute === 'function' && e.inputSchema) {
            return { kind: 'task', def: e as unknown as TaskDefinition };
        }
        if (typeof e.pushWatchState === 'function' || typeof e.pullWatchState === 'function') {
            return {
                kind: 'watch-sync',
                def: e as unknown as WatchSyncDefinition,
            };
        }
        if (
            typeof e.scan === 'function' &&
            typeof e.fullSync === 'function' &&
            typeof e.getStatus === 'function'
        ) {
            return {
                kind: 'media-source',
                def: e as unknown as MediaSourceDefinition,
            };
        }
        if (typeof e.fetchParams === 'function') {
            return {
                kind: 'trickplay',
                def: e as unknown as TrickplayProviderDefinition,
            };
        }
        if (Array.isArray(e.routes)) {
            return { kind: 'feature', def: e as unknown as FeatureDefinition };
        }
        if (typeof e.handleWebhook === 'function' || typeof e.sendNotification === 'function') {
            return {
                kind: 'integration',
                def: e as unknown as IntegrationDefinition,
            };
        }
        // Unique method names, so no ordering hazard with the generic
        // provider branch — but checked early anyway, because misclassifying
        // an auth provider as anything else would silently drop its gates.
        if (typeof e.verifyCredentials === 'function' || typeof e.completeLogin === 'function') {
            return {
                kind: 'auth-provider',
                def: e as unknown as AuthProviderDefinition,
            };
        }
        if (typeof e.fetchLyrics === 'function') {
            return {
                kind: 'lyrics-provider',
                def: e as unknown as LyricsProviderDefinition,
            };
        }
        // BEFORE the metadata-provider branch: that one matches on `search`
        // alone, so a subtitle provider (search + download) would otherwise be
        // swallowed by it and registered as the wrong kind.
        if (typeof e.search === 'function' && typeof e.download === 'function') {
            return {
                kind: 'subtitle-provider',
                def: e as unknown as SubtitleProviderDefinition,
            };
        }
        if (typeof e.search === 'function' || typeof e.detail === 'function') {
            return {
                kind: 'provider',
                def: e as unknown as ProviderDefinition,
            };
        }
        // External-service: settings + isConfigured? only, with no contract
        // methods of any other shape present. The method-absence check makes
        // misclassification of a malformed plugin (e.g. a provider author who
        // forgot to add `search`/`detail`) impossible — they get rejected
        // outright instead of silently bound to the wrong kind.
        const hasAnyContractMethod = CONTRACT_METHOD_KEYS.some((k) => typeof e[k] === 'function');
        if (typeof e.id === 'string' && e.settings && !hasAnyContractMethod) {
            return {
                kind: 'external-service',
                def: e as unknown as ExternalServiceDefinition,
            };
        }
        return null;
    } catch (err) {
        logger.warn('detectSdkDefinition threw on property access', {
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * Contract-array keys of the SDK's `PluginDefinition` aggregate, paired with
 * the kind each array must resolve to. Order is the registration order, and is
 * also the order the admin DTO reports `kinds` in.
 */
const AGGREGATE_KEYS = [
    'tasks',
    'providers',
    'trickplayProviders',
    'watchSyncs',
    'features',
    'integrations',
    'mediaSources',
    'externalServices',
    'subtitleProviders',
    'lyricsProviders',
    'authProviders',
] as const;

/**
 * Detect EVERY contract carried by a plugin's default export.
 *
 * Two accepted shapes:
 *   - a bare single-contract def (any of the eleven `defineX` shapes) → a
 *     one-element list;
 *   - a `PluginDefinition` aggregate (`{ tasks: [], watchSyncs: [], … }`, what
 *     `definePlugin` returns) → one element per contract, in `AGGREGATE_KEYS`
 *     order.
 *
 * Returns `null` when the export matches neither — including an aggregate that
 * carries an element of no known shape, or one whose every array is empty. An
 * aggregate is recognised only when it carries no `id` of its own, so a
 * single-contract def can never be mistaken for one.
 *
 * The aggregate branch is checked LAST, after all eleven single shapes, so every
 * export that loads today keeps taking exactly the path it takes now.
 */
export function detectSdkDefinitions(exported: unknown): ExternalSdkDefinition[] | null {
    const single = detectSdkDefinition(exported);
    if (single) return [single];

    if (!exported || typeof exported !== 'object') return null;
    try {
        const e = exported as Record<string, unknown>;
        // An aggregate names no id of its own; the ids live on its elements.
        if ('id' in e) return null;

        const out: ExternalSdkDefinition[] = [];
        let sawArray = false;
        for (const key of AGGREGATE_KEYS) {
            const arr = e[key];
            if (arr === undefined) continue;
            if (!Array.isArray(arr)) return null;
            sawArray = true;
            for (const element of arr) {
                const detected = detectSdkDefinition(element);
                // One unrecognised element fails the WHOLE bundle: registering
                // the recognisable remainder would silently ship a plugin
                // missing part of itself, and there is no unload to undo it.
                if (!detected) return null;
                out.push(detected);
            }
        }
        if (!sawArray || out.length === 0) return null;
        return out;
    } catch (err) {
        logger.warn('detectSdkDefinitions threw on property access', {
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

/**
 * The SDK validator for each contract kind.
 *
 * A builtin gets these for free — it literally calls `defineTask(...)`. An
 * external plugin never did: the SDK is types-only at runtime, so an external
 * author exports a plain object that arrives here checked by nothing but the
 * duck-typing above. Every rule the contracts declare (mandatory fields, id
 * shape, `widgets` requiring `capabilities.browserUi`, watcher all-or-nothing,
 * …) was therefore enforced only against the population it was never written
 * for.
 *
 * All nine validate-then-return their input unchanged, EXCEPT
 * `defineWatchSync`, which returns a new object carrying synthesized
 * `__autoTasks` stubs. We call it for its checks and DISCARD the result: what
 * registers stays exactly what the plugin exported. Whether external
 * watch-syncs should also gain those stubs is a separate behavioural question,
 * not something to change silently while adding validation.
 */
const SDK_VALIDATORS: Record<ExternalSdkDefinition['kind'], (def: never) => unknown> = {
    task: defineTask,
    provider: defineProvider,
    trickplay: defineTrickplayProvider,
    'watch-sync': defineWatchSync,
    feature: defineFeature,
    integration: defineIntegration,
    'media-source': defineMediaSource,
    'external-service': defineExternalService,
    'subtitle-provider': defineSubtitleProvider,
    'lyrics-provider': defineLyricsProvider,
    'auth-provider': defineAuthProvider,
};

/**
 * The contract names an operator sees when nothing matched.
 *
 * Typed `Record<kind, …>`, so adding a contract without adding its name here is
 * a compile error. The previous hand-written sentence had already fallen two
 * contracts behind, telling an author whose lyrics or auth plugin failed
 * detection that those contracts did not exist. Not derived from the kind
 * strings — `trickplay` would come out as `defineTrickplay` — nor from
 * `Function.name`, which a bundler is free to mangle.
 */
const SDK_VALIDATOR_NAMES: Record<ExternalSdkDefinition['kind'], string> = {
    task: 'defineTask',
    provider: 'defineProvider',
    trickplay: 'defineTrickplayProvider',
    'watch-sync': 'defineWatchSync',
    feature: 'defineFeature',
    integration: 'defineIntegration',
    'media-source': 'defineMediaSource',
    'external-service': 'defineExternalService',
    'subtitle-provider': 'defineSubtitleProvider',
    'lyrics-provider': 'defineLyricsProvider',
    'auth-provider': 'defineAuthProvider',
};

function knownContractNames(): string {
    return Object.values(SDK_VALIDATOR_NAMES).join(' / ');
}

/**
 * Run the SDK's own validator over one detected definition. Returns the
 * operator-facing failure message, or null when the definition is valid.
 */
function sdkValidationError(detected: ExternalSdkDefinition): string | null {
    try {
        (SDK_VALIDATORS[detected.kind] as (def: unknown) => unknown)(detected.def);
        return null;
    } catch (err) {
        // PluginDefinitionError already reads as "defineFeature(id): reason",
        // which is exactly what an operator needs to fix it.
        return err instanceof Error ? err.message : String(err);
    }
}

function registerSdkDefinition(detected: ExternalSdkDefinition): void {
    switch (detected.kind) {
        case 'task':
            taskRegistry.registerTask(detected.def);
            break;
        case 'provider':
            taskRegistry.registerProvider(detected.def);
            break;
        case 'trickplay':
            taskRegistry.registerTrickplay(detected.def);
            break;
        case 'watch-sync':
            taskRegistry.registerWatchSync(detected.def);
            break;
        case 'feature':
            taskRegistry.registerFeature(detected.def);
            break;
        case 'integration':
            taskRegistry.registerIntegration(detected.def);
            break;
        case 'media-source':
            taskRegistry.registerMediaSource(detected.def);
            break;
        case 'external-service':
            taskRegistry.registerExternalService(detected.def);
            break;
        case 'subtitle-provider':
            taskRegistry.registerSubtitleProvider(detected.def);
            break;
        case 'lyrics-provider':
            taskRegistry.registerLyricsProvider(detected.def);
            break;
        case 'auth-provider':
            taskRegistry.registerAuthProvider(detected.def);
            break;
    }
}

/** Loader-aggregate result, exposed to admin UI / boot diagnostics. */
export interface LoadExternalPluginsResult {
    loaded: number;
    errors: number;
    /**
     * Number of plugins that failed specifically because they runtime-imported
     * the (types-only) SDK package. Surfaced separately from the generic
     * `errors` count so the admin UI can show an actionable hint
     * ("use `import type` / `@type` JSDoc instead of runtime import") rather
     * than a generic "failed to load" badge.
     */
    sdkImportErrors: number;
    discovered: number;
}

/**
 * Heuristic — is this error the Node `ERR_MODULE_NOT_FOUND` produced by a
 * plugin's runtime `import` of the (types-only) SDK package? Matches both
 * the published scoped name and the bare alias we accept in dev builds.
 */
function isSdkRuntimeImportError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    if (!err.message.includes('ERR_MODULE_NOT_FOUND')) return false;
    return (
        err.message.includes('@sapd/lumastra-plugin-sdk') ||
        err.message.includes('lumastra-plugin-sdk')
    );
}

/**
 * Side-channel set into which `loadExternalPlugin` records the plugin dir
 * whenever a load failed due to a runtime `import` of the (types-only) SDK
 * package. The aggregate (`loadExternalPlugins`) reads + clears this between
 * runs so it can expose a dedicated counter without changing the per-plugin
 * `Promise<boolean>` contract (used widely by existing tests).
 *
 * Concurrency note: `loadExternalPlugins` calls `loadExternalPlugin`
 * sequentially today, so a module-level set is safe. If we ever parallelize
 * loading, replace this with a result object on a per-call basis.
 */
const _sdkImportErrorDirs = new Set<string>();

/**
 * Single-flight gate for `reloadExternalPlugins`. Two concurrent admin
 * "Reload plugins" clicks otherwise race on the module-level
 * `_sdkImportErrorDirs.clear()` — each call wipes the other's accumulator
 * and the reported `sdkImportErrors` count is wrong. Gating to a single
 * in-flight reload makes the per-call accumulator semantics correct without
 * promoting the set to per-call state (which would ripple into
 * `loadExternalPlugin`'s signature).
 */
let _reloadInFlight: Promise<ReloadExternalPluginsResult> | null = null;

/**
 * Registry-less drop-in plugins: a directory under the plugins dir with no
 * `external_plugins` row.
 *
 * These predate signed install and are still the default install model
 * (`PLUGINS_REQUIRE_REGISTRY` is off by default), but every admin listing was
 * built from registry rows — so a deployment whose plugins are all drop-ins
 * showed an empty plugin page while running four of them.
 *
 * Discovery only. Loading, validation and registration are unchanged; this
 * reports what is ON DISK so the admin UI can show it, INCLUDING a drop-in that
 * failed to load, which is the case an operator most needs to see.
 */
export interface DropInPlugin {
    name: string;
    /** From the directory's package.json, when it declares one. */
    version?: string;
    /**
     * `bundled` — shipped in the image under `$PLUGINS_BUNDLED_DIR`: first-party
     * and current with the image. `drop-in` — hand-placed under the plugins
     * volume, no provenance.
     */
    origin: 'bundled' | 'drop-in';
    /**
     * Bundled only: a same-named directory also sits in the plugins volume
     * (typically a frozen copy from before the directories were split). The
     * loader ignores it — the bundled copy wins — but it is safe to delete.
     */
    shadowedCopy?: boolean;
}

function readDirVersion(dir: string): string | undefined {
    try {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8')) as { version?: unknown };
            if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
        }
    } catch {
        // A malformed package.json is not a reason to hide the plugin from the
        // operator — it is a reason to show it without a version.
    }
    return undefined;
}

function pluginDirs(baseDir: string): string[] {
    if (!fs.existsSync(baseDir)) return [];
    return fs
        .readdirSync(baseDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.')) // .tmp-*/.old-* staging
        .map((e) => e.name)
        .filter((name) => !!resolveEntryPoint(path.join(baseDir, name)));
}

/**
 * Plugins on disk that have no registry row: the image's bundled plugins and
 * hand-placed drop-ins.
 *
 * Bundled plugins used to be missing from this list entirely (only the plugins
 * volume was scanned), while a stale pre-split copy of them in that volume —
 * which the loader IGNORES, because the bundled directory wins a name
 * collision — was listed as an "unverified drop-in placed on disk". Every
 * install that ever ran an image from before the split showed its four
 * first-party plugins that way.
 */
export async function listDropInPlugins(sql: postgres.Sql): Promise<DropInPlugin[]> {
    if (!isExternalPluginsEnabled()) return [];

    const out: DropInPlugin[] = [];
    try {
        const bundledDir = bundledPluginsDir();
        const externalDir = externalPluginsDir();
        const bundled = pluginDirs(bundledDir);
        const bundledNames = new Set(bundled);
        // Strict mode refuses to load drop-ins, so listing them would advertise
        // something that cannot run. Bundled plugins are exempt from strict
        // mode (they ship inside the verified image), so they stay listed.
        const external = config.PLUGINS_REQUIRE_REGISTRY ? [] : pluginDirs(externalDir);
        const externalNames = new Set(pluginDirs(externalDir));

        for (const name of bundled) {
            // A registry row means it is managed, and the row-based listing
            // already covers it. Listing it here too would render two cards for
            // one plugin — and hand the {#each} two identical keys.
            if (await getExternalPlugin(sql, name)) continue;
            const version = readDirVersion(path.join(bundledDir, name));
            out.push({
                name,
                ...(version ? { version } : {}),
                origin: 'bundled',
                ...(externalNames.has(name) ? { shadowedCopy: true } : {}),
            });
        }
        for (const name of external) {
            if (bundledNames.has(name)) continue; // ignored by the loader; reported above
            if (await getExternalPlugin(sql, name)) continue;
            const version = readDirVersion(path.join(externalDir, name));
            out.push({ name, ...(version ? { version } : {}), origin: 'drop-in' });
        }
    } catch (error) {
        logger.error('Failed to list drop-in plugins', error as Error);
    }
    return out;
}

/**
 * Load an external plugin from a directory.
 *
 * The plugin's default export must match one of the nine SDK contract
 * shapes (defineTask / defineProvider / defineTrickplayProvider /
 * defineWatchSync / defineFeature / defineIntegration / defineMediaSource /
 * defineExternalService). The shape is detected via duck-typing on required
 * methods and registered against the task registry.
 *
 * Returns `true` on success, `false` on failure. Plugin authors who need to
 * register optional `normalizer` / `encoder` hooks can either export them
 * alongside the default (`export const normalizer = …; export const encoder = …;`)
 * — the loader wires them automatically — or call
 * `registerProviderNormalizer / registerProviderEncoder` directly as a
 * module-level side effect.
 */
export async function loadExternalPlugin(pluginDir: string): Promise<boolean> {
    const mainPath = resolveEntryPoint(pluginDir);
    if (!mainPath) {
        logger.error('External plugin has no entry point', undefined, {
            path: pluginDir,
        });
        return false;
    }
    const res = await importAndRegister(pluginDir, mainPath);
    return res.loaded;
}

/**
 * Optional pre-registration identity gate. When `expectedName` is supplied
 * (the installer path), the loader REFUSES — BEFORE `registerSdkDefinition`
 * and before any per-task worker starts — a bundle whose loaded def id/kind
 * mismatches, or that declares `isolation:'worker'`. Because there is no
 * runtime unload primitive, validating pre-registration is the only way a
 * rejected install can leave nothing registered and no worker running.
 * Registry-less drop-ins / legacy dirs pass no constraints and load
 * unconstrained (preserving the admin-vetted drop-in model). [Fable-1]
 */
export interface LoadConstraints {
    expectedName?: string;
    /** Single-contract manifests. Ignored when `expectedKinds` is supplied. */
    expectedKind?: string;
    /**
     * Multi-contract manifests (`kinds`). Compared as a SET against what the
     * bundle actually exported — declaration order in a manifest is not
     * meaningful, but the membership is signed and must match exactly.
     */
    expectedKinds?: string[];
    rejectWorkerIsolation?: boolean;
}

/** Outcome of loading a single plugin dir, richer than the legacy boolean. */
interface ImportAndRegisterResult {
    loaded: boolean;
    /** First contract's id/kind. For a single-contract plugin, the only one. */
    id?: string;
    kind?: string;
    /** Every contract the bundle registered, in registration order. */
    ids?: string[];
    kinds?: string[];
    /** True when ANY loaded def was a provider or task (informs later wiring). */
    addedProviderOrTask: boolean;
    /** Failure reason, when `loaded` is false. */
    error?: string;
    /**
     * True when the failure was a pre-registration identity/kind/isolation
     * constraint rejection (not an execute-time throw). Lets the installer map
     * these to a 400 while a genuine bundle throw maps to 422. [Fable-1]
     */
    constraintViolation?: boolean;
}

/**
 * Shared import → detect → register core, extracted from `loadExternalPlugin`
 * so both the legacy boolean wrapper and the registry-aware `loadOneDir` run
 * the exact same load logic. Does NOT touch `lastLoadError` — the caller owns
 * that policy — but DOES participate in the module-global `_sdkImportErrorDirs`
 * accumulator exactly as the pre-refactor `loadExternalPlugin` did.
 */
async function importAndRegister(
    pluginDir: string,
    mainPath: string,
    constraints?: LoadConstraints,
): Promise<ImportAndRegisterResult> {
    const pluginName = path.basename(pluginDir);
    try {
        logger.debug('Loading external plugin', { path: pluginDir });

        // Dynamic import using file:// URL (works on every platform), with a
        // cache-buster derived from the file itself.
        //
        // Node caches ES modules by URL for the life of the process, and an
        // install always lands at the same stable path. Without this, a failed
        // install that got as far as importing leaves its broken module cached
        // under the exact path the corrected reinstall uses: the tree-digest
        // gate verifies the NEW bytes and `import()` then returns the OLD
        // module, so a valid signed bundle refuses to install with an error
        // that no longer exists in the file — undiagnosable from the logs, and
        // unrecoverable short of a restart. It also means the code that runs is
        // not the artifact the digest was checked against.
        let cacheKey = '';
        try {
            const stat = fs.statSync(mainPath);
            cacheKey = `?v=${stat.mtimeMs}-${stat.size}`;
        } catch {
            // Unreadable stat is not a reason to refuse the load; the import
            // below will fail with a better message if the file is really gone.
        }
        const fileUrl = `file://${mainPath}${cacheKey}`;
        const module = (await import(/* @vite-ignore */ fileUrl)) as {
            default?: unknown;
            normalizer?: NormalizerModule;
            encoder?: EncodeFn;
        };

        const exported = module.default;
        if (!exported) {
            throw new Error('Plugin module must have a default export');
        }

        const detectedAll = detectSdkDefinitions(exported);
        if (!detectedAll) {
            throw new Error(
                'Plugin default export does not match any SDK contract shape ' +
                    `(expected one of: ${knownContractNames()} — or a definePlugin ` +
                    'aggregate carrying them)',
            );
        }
        const isAggregate = detectedAll.length > 1;
        const detected = detectedAll[0];

        // ── Phase 1: validate EVERY element before registering ANY of them ──
        // There is no runtime unload, so a bundle rejected halfway through
        // registration would leave contracts live that nothing can retract.
        // Every check below therefore runs to completion first.
        const ids: string[] = [];
        for (const d of detectedAll) {
            const id = (d.def as { id?: unknown }).id;
            if (typeof id !== 'string' || !ID_PATTERN.test(id)) {
                const message = 'Plugin ID is malformed (must match /^[a-z][a-z0-9-]*$/)';
                logger.error(message, undefined, { pluginDir, pluginId: id });
                return { loaded: false, addedProviderOrTask: false, error: message };
            }
            ids.push(id);
        }

        // Contract validation, for every element and BEFORE any registration.
        // A bundle whose second contract is invalid must not leave its first
        // one live — there is no unload.
        for (const d of detectedAll) {
            const invalid = sdkValidationError(d);
            if (invalid) {
                logger.error('External plugin failed SDK contract validation', undefined, {
                    pluginDir,
                    kind: d.kind,
                    reason: invalid,
                });
                return { loaded: false, addedProviderOrTask: false, error: invalid };
            }
        }

        if (isAggregate) {
            // Namespace + anchor rule. `pluginName` is the on-disk directory
            // basename, which for a managed install equals the signed manifest
            // name. Two invariants, both load-bearing:
            //
            //  1. every id is `<name>` or `<name>-…`, so a bundle can never
            //     register an id inside another plugin's namespace;
            //  2. one contract claims `<name>` exactly. The host answers "is
            //     this plugin loaded?" with `hasPluginRegistered(<dir name>)`
            //     — used to pick fresh-vs-upgrade at install, to skip already-
            //     loaded dirs on reload, and to draw the admin card's state.
            //     A bundle with no contract at `<name>` would read as unloaded
            //     to every one of those and get re-imported into a duplicate
            //     registration.
            const stray = ids.find((id) => id !== pluginName && !id.startsWith(`${pluginName}-`));
            if (stray !== undefined) {
                const message =
                    `contract id '${stray}' is outside this plugin's namespace — ` +
                    `every id must be '${pluginName}' or start with '${pluginName}-'`;
                logger.error(message, undefined, { pluginDir });
                return { loaded: false, addedProviderOrTask: false, error: message };
            }
            if (!ids.includes(pluginName)) {
                const message =
                    `no contract claims the plugin id '${pluginName}' — a multi-contract ` +
                    `plugin must have exactly one contract named after the plugin ` +
                    `(the others take '${pluginName}-…' ids)`;
                logger.error(message, undefined, { pluginDir });
                return { loaded: false, addedProviderOrTask: false, error: message };
            }

            const seen = new Set<string>();
            for (const id of ids) {
                if (seen.has(id)) {
                    const message =
                        `two contracts in this bundle both claim id '${id}' — ` +
                        'each contract in a multi-contract plugin needs its own id';
                    logger.error(message, undefined, { pluginDir });
                    return { loaded: false, addedProviderOrTask: false, error: message };
                }
                seen.add(id);
                // Pre-flight the cross-plugin collision the registry would
                // otherwise throw on mid-bundle. Aggregates only: for a
                // single-contract plugin "register throws" already means
                // "nothing registered", so the existing path stays untouched.
                if (taskRegistry.hasPluginRegistered(id)) {
                    const message = `id '${id}' is already registered by another plugin`;
                    logger.error(message, undefined, { pluginDir });
                    return { loaded: false, addedProviderOrTask: false, error: message };
                }
            }
        }

        // The plugin's canonical id. For an aggregate that is the anchor
        // contract (the one named after the plugin, enforced below), never
        // simply the first element — the anchor is what every "is this plugin
        // loaded / what kind is it" probe in the host looks up.
        const pluginId = isAggregate ? pluginName : ids[0];

        // Pre-registration identity/kind/isolation gate (installer path only —
        // fires solely when the caller supplies an expected name). Refusing
        // HERE, before `registerSdkDefinition` and before any worker starts,
        // guarantees a mismatched or worker-isolated bundle NEVER registers a
        // def and NEVER spins up a per-task worker — neither of which any
        // rollback could undo (unload is restart-only). Registry-less drop-ins
        // pass no constraints and load unconstrained. [Fable-1]
        const kinds = detectedAll.map((d) => d.kind);
        if (constraints?.expectedName !== undefined) {
            const expected = constraints.expectedName;
            // Identity rule differs by arity, and deliberately so:
            //   single-contract → id MUST equal the manifest name (the original,
            //     strictest gate — unchanged);
            //   aggregate       → every id must be `<name>` or `<name>-…`, the
            //     strongest rule available once several ids must coexist. It
            //     still confines a bundle to its own namespace, so one plugin
            //     can never register an id another plugin could claim.
            if (isAggregate) {
                // The namespace + anchor rules already ran above against the
                // on-disk directory name. Tying that name to the SIGNED
                // manifest name is what makes them a trust gate rather than a
                // self-consistency check.
                if (pluginName !== expected) {
                    return {
                        loaded: false,
                        addedProviderOrTask: false,
                        constraintViolation: true,
                        error: `plugin directory '${pluginName}' does not match manifest name '${expected}'`,
                    };
                }
            } else if (pluginId !== expected) {
                return {
                    loaded: false,
                    addedProviderOrTask: false,
                    constraintViolation: true,
                    error: `loaded def id '${pluginId}' does not match manifest name '${expected}'`,
                };
            }

            // Kind gate. `expectedKinds` (the multi-contract manifest field)
            // wins when present and is compared as a SET — declaration order in
            // a manifest carries no meaning. `expectedKind` keeps the exact
            // single-contract semantics it has today.
            if (constraints.expectedKinds !== undefined) {
                const declared = [...constraints.expectedKinds].sort();
                const actual = [...kinds].sort();
                if (declared.length !== actual.length || declared.some((k, i) => k !== actual[i])) {
                    return {
                        loaded: false,
                        addedProviderOrTask: false,
                        constraintViolation: true,
                        error: `loaded def kinds [${actual.join(', ')}] do not match manifest kinds [${declared.join(', ')}]`,
                    };
                }
            } else if (
                constraints.expectedKind !== undefined &&
                (isAggregate || detected.kind !== constraints.expectedKind)
            ) {
                return {
                    loaded: false,
                    addedProviderOrTask: false,
                    constraintViolation: true,
                    error: isAggregate
                        ? `bundle declares a single kind '${constraints.expectedKind}' but exports ${detectedAll.length} contracts — use the manifest's 'kinds' field`
                        : `loaded def kind '${detected.kind}' does not match manifest kind '${constraints.expectedKind}'`,
                };
            }
        }

        // Worker-isolation rejection, OUTSIDE the identity block on purpose: it
        // must run for every registry-managed load (boot, hot-reload, enable —
        // security review 2026-09-12, C18), which pass no `expectedName`, as
        // well as for the installer's fully constrained fresh install.
        if (constraints?.rejectWorkerIsolation) {
            const worker = detectedAll.find(
                (d) =>
                    d.kind === 'task' && (d.def as { isolation?: unknown }).isolation === 'worker',
            );
            if (worker) {
                return {
                    loaded: false,
                    addedProviderOrTask: false,
                    constraintViolation: true,
                    error: "isolation: 'worker' is not supported for external plugins",
                };
            }
        }

        // Deprecated fairness-lane classes still load (the registry folds them
        // onto their physical class), but an external author should migrate.
        // Emitted here rather than in the SDK's defineTask so the host's own
        // bundled tasks — which use the lanes deliberately — stay quiet.
        for (const d of detectedAll) {
            if (d.kind !== 'task') continue;
            const cls = (d.def as { resourceClass?: unknown }).resourceClass;
            const physical =
                cls === 'analysis' ? 'cpu' : cls === 'ingest' || cls === 'bulk' ? 'io' : null;
            if (physical) {
                logger.warn(
                    `Plugin '${pluginId}' task '${d.def.id}' uses deprecated resourceClass '${String(cls)}' — migrate to resourceClass '${physical}' + quotas.maxConcurrent`,
                );
            }
        }

        // Wire optional normalize / encode-id helpers BEFORE register so the
        // definition is fully wired when the registry first sees it. Roll the
        // helpers back if registration throws to avoid orphan associations.
        // Normalizer/encoder are PROVIDER helpers and are looked up by provider
        // id, so in a bundle they must bind to the provider's own id — which
        // need not be the anchor (a `trakt` bundle may carry a `trakt-meta`
        // provider). Falls back to the plugin id when the bundle has no single
        // unambiguous provider.
        const providerIds = detectedAll.filter((d) => d.kind === 'provider').map((d) => d.def.id);
        const helperId = providerIds.length === 1 ? providerIds[0] : pluginId;

        let normalizerRegistered = false;
        let encoderRegistered = false;
        if (module.normalizer) {
            registerProviderNormalizer(helperId, module.normalizer);
            normalizerRegistered = true;
            logger.debug('External plugin normalizer registered', {
                id: helperId,
            });
        }
        if (module.encoder) {
            registerProviderEncoder(helperId, module.encoder);
            encoderRegistered = true;
            logger.debug('External plugin encoder registered', {
                id: helperId,
            });
        }

        // ── Phase 2: register. Every element passed validation above, so the
        // only throw left here is a registry-internal one (e.g. a duplicate
        // `coversStages` claim). A bundle that trips it stops at that element;
        // earlier elements stay registered because no unload exists — the load
        // is still reported as failed so the installer rolls the files + row
        // back and the admin card shows why.
        try {
            for (const d of detectedAll) {
                registerSdkDefinition(d);
                if (d.kind === 'task') markTaskFromPlugin(d.def.id, pluginId);
            }
        } catch (err) {
            if (normalizerRegistered) {
                const { unregisterProviderNormalizer } =
                    await import('../../providers/normalize.js');
                unregisterProviderNormalizer(helperId);
            }
            if (encoderRegistered) {
                const { unregisterProviderEncoder } = await import('../../providers/encode-id.js');
                unregisterProviderEncoder(helperId);
            }
            throw err;
        }

        logger.info('External plugin loaded', {
            id: pluginId,
            kind: detected.kind,
            ...(isAggregate ? { ids, kinds } : {}),
        });
        return {
            loaded: true,
            id: pluginId,
            kind: detected.kind,
            ids,
            kinds,
            addedProviderOrTask: kinds.some((k) => k === 'provider' || k === 'task'),
        };
    } catch (error) {
        if (isSdkRuntimeImportError(error)) {
            // The SDK is shipped as types only; a runtime `import` against
            // `@sapd/lumastra-plugin-sdk` throws ERR_MODULE_NOT_FOUND at the
            // very first line of the plugin. This is by far the most common
            // author mistake, so surface a specific actionable hint rather
            // than the generic "failed to load" message. We still log the
            // underlying error object for diagnostics.
            _sdkImportErrorDirs.add(pluginDir);
            logger.error(
                `External plugin '${pluginName}' tried to runtime-import ` +
                    `'@sapd/lumastra-plugin-sdk'. The SDK is types-only — use ` +
                    `\`import type\` (TS) or \`@type\` JSDoc (JS) instead. ` +
                    `See packages/@sapd/lumastra-plugin-sdk/README.md for examples.`,
                error as Error,
                { path: pluginDir },
            );
            return {
                loaded: false,
                addedProviderOrTask: false,
                error: 'runtime-imported the types-only SDK package',
            };
        }
        logger.error('Failed to load external plugin', error as Error, {
            path: pluginDir,
        });
        return {
            loaded: false,
            addedProviderOrTask: false,
            error: error instanceof Error ? error.message : String(error),
        };
    }
}

/** Result of loading a single dir via {@link loadOneDir}. */
interface LoadOneDirResult {
    loaded: boolean;
    id?: string;
    kind?: string;
    /** Every contract the bundle registered (length 1 for single-contract). */
    ids?: string[];
    kinds?: string[];
    name: string;
    addedProviderOrTask: boolean;
    error?: string;
    /** Set when a pre-registration identity/kind/isolation constraint rejected the load. [Fable-1] */
    constraintViolation?: boolean;
}

/**
 * Load exactly one plugin directory and record its outcome in `lastLoadError`
 * (set on failure, cleared on a clean load). This is the single per-dir load
 * primitive that `loadAndWirePlugin` and `reloadExternalPlugins` share.
 *
 * Registry-aware: for a dir with an `external_plugins` row this (a) skips a
 * disabled / uninstalled row, (b) loads exactly `<dir>/index.js` ignoring
 * `package.json#main`, and (c) recomputes `sha256(index.js)` and refuses to
 * load on any mismatch with `row.checksum`. A registry-LESS dir still loads
 * honoring `package.json#main` unless `config.PLUGINS_REQUIRE_REGISTRY` is
 * set. Runs on every load path (boot, aggregate reload, enable, reload).
 * [Fable-3][review C2/C3]
 */
/**
 * True iff the on-disk tree digest matches the DB-listing digest for the
 * artifact. Recomputes the canonical digest from `artifact.files` (the DB source
 * of truth), asserts the stored `treeDigest` agrees with its own files (tampered
 * jsonb guard), then walks the on-disk tree (`computeTreeDigest` uses `lstat`,
 * refuses any non-regular/symlink entry, stays within `dir`, bounded by the
 * caps — THROWS on tamper) and compares. Any add/remove/modify of any extracted
 * file fails the compare.
 */
function bundleTreeVerified(dir: string, artifact: BundleArtifact): boolean {
    const expected = computeTreeDigestFromFiles(artifact.files);
    if (artifact.treeDigest !== expected) return false;
    const walked = computeTreeDigest(dir, bundleLimitsFromConfig());
    return walked.treeDigest === expected;
}

function withinRoot(root: string, p: string): boolean {
    const r = path.resolve(root);
    const rp = path.resolve(p);
    return rp === r || rp.startsWith(r + path.sep);
}

async function loadOneDir(
    dir: string,
    sql: postgres.Sql,
    constraints?: LoadConstraints,
    registryRow?: Awaited<ReturnType<typeof getExternalPlugin>>,
): Promise<LoadOneDirResult> {
    const name = path.basename(dir);
    const row = registryRow === undefined ? await getExternalPlugin(sql, name) : registryRow;

    let mainPath: string | null;
    if (row) {
        // Registry gate: never load a disabled or uninstalled plugin. Not an
        // error condition — no lastLoadError entry.
        if (row.status === 'uninstalled' || !row.enabled) {
            return { loaded: false, name, addedProviderOrTask: false };
        }
        // ABI gate. THE reason the ABI is persisted rather than only checked at
        // install: this plugin was admitted by whatever host version installed
        // it, and that host is not necessarily this one. A NULL predates the
        // column (migration 16.229.0) and can only have been built against ABI
        // 1. Refusing here turns a silent TypeError from inside third-party
        // code into a named, actionable per-plugin load error.
        const rowAbi = row.sdkAbi ?? 1;
        if (rowAbi !== PLUGIN_SDK_ABI) {
            const error =
                `built for SDK ABI ${rowAbi}, host is ABI ${PLUGIN_SDK_ABI} — ` +
                'reinstall a build for this ABI';
            lastLoadError.set(name, error);
            logger.error('External plugin ABI mismatch — refusing to load', undefined, {
                name,
                pluginAbi: rowAbi,
                hostAbi: PLUGIN_SDK_ABI,
            });
            return { loaded: false, name, addedProviderOrTask: false, error };
        }
        if (isInvalidBundle(row.bundle)) {
            // A stored bundle jsonb that failed BundleArtifactSchema — refuse
            // this one plugin's load (fail closed), exactly like a digest
            // mismatch. [§3.5]
            const error = 'bundle artifact unreadable';
            lastLoadError.set(name, error);
            logger.error('External plugin bundle artifact unreadable — refusing to load', { name });
            return { loaded: false, name, addedProviderOrTask: false, error };
        }
        if (row.bundle) {
            // BUNDLE: entry from the (validated) artifact, NOT package.json#main.
            // Re-verify the whole extracted tree against the DB-persisted listing
            // on EVERY load path so post-install tamper of ANY file is caught.
            const artifact = row.bundle;
            let ok: boolean;
            try {
                ok = bundleTreeVerified(dir, artifact);
            } catch (e) {
                const error = `bundle tree walk refused: ${
                    e instanceof Error ? e.message : String(e)
                }`;
                lastLoadError.set(name, error);
                logger.error('External plugin bundle tree walk refused', { name, error });
                return { loaded: false, name, addedProviderOrTask: false, error };
            }
            if (!ok) {
                const error = 'bundle tree digest mismatch on disk';
                lastLoadError.set(name, error);
                logger.error('External plugin bundle tree digest mismatch — refusing to load', {
                    name,
                });
                return { loaded: false, name, addedProviderOrTask: false, error };
            }
            const entryAbs = path.join(dir, artifact.entry);
            if (!withinRoot(dir, entryAbs) || !fs.existsSync(entryAbs)) {
                const error = 'bundle entry missing';
                lastLoadError.set(name, error);
                logger.error('External plugin bundle entry missing — refusing to load', { name });
                return { loaded: false, name, addedProviderOrTask: false, error };
            }
            mainPath = entryAbs;
        } else {
            // Managed dir (single-file): load exactly index.js, ignore
            // package.json#main. [review C2]
            const entry = path.join(dir, 'index.js');
            if (!fs.existsSync(entry)) {
                const error = 'no entry point';
                lastLoadError.set(name, error);
                logger.error('External plugin has no index.js', undefined, { path: dir });
                return { loaded: false, name, addedProviderOrTask: false, error };
            }
            // Re-verify the on-disk bytes against the checksum recorded at install
            // time. Runs on EVERY load path so tampering after install is caught.
            // [review C3]
            const actual = crypto.createHash('sha256').update(fs.readFileSync(entry)).digest('hex');
            if (actual !== row.checksum) {
                const error = 'checksum mismatch on disk';
                lastLoadError.set(name, error);
                logger.error('External plugin checksum mismatch — refusing to load', {
                    name,
                    expected: row.checksum,
                    actual,
                });
                return { loaded: false, name, addedProviderOrTask: false, error };
            }
            mainPath = entry;
        }
    } else {
        // Registry-less legacy drop-in: skipped entirely in strict mode.
        if (config.PLUGINS_REQUIRE_REGISTRY) {
            return { loaded: false, name, addedProviderOrTask: false };
        }
        mainPath = resolveEntryPoint(dir);
        if (!mainPath) {
            const error = 'no entry point';
            lastLoadError.set(name, error);
            logger.error('External plugin has no entry point', undefined, { path: dir });
            return { loaded: false, name, addedProviderOrTask: false, error };
        }
    }

    // Every registry-managed load rejects `isolation:'worker'` — boot
    // (`loadExternalPlugins`), hot-reload (`reloadExternalPlugins`) and `enable`
    // all reach `loadOneDir` with no constraints of their own, so before this
    // only the installer's fresh-install branch was ever gated, and a
    // worker-isolated task that reached the registry any other way (staged via
    // an upgrade, a hand-placed dir matching an existing row) loaded
    // unchallenged. Only the isolation rule is derived from the row: the
    // identity/kind rules need the SIGNED manifest, which the installer alone
    // has just verified — a registry row's `name` is the install directory,
    // which a legacy single-contract plugin's def id need not equal. A caller
    // that supplies constraints (the installer) keeps them, merged on top.
    // Security review 2026-09-12, C18.
    const effectiveConstraints: LoadConstraints | undefined = row
        ? { rejectWorkerIsolation: true, ...constraints }
        : constraints;

    const res = await importAndRegister(dir, mainPath, effectiveConstraints);

    // Signed capability bound, enforced on EVERY load of a registry-managed
    // plugin — which is the only place an upgrade is ever checked.
    //
    // `installer.ts` compares declared-vs-loaded capabilities only in its
    // FRESH-install branch. An upgrade stages for restart and never reaches
    // that comparison, and until now no load-time check existed either, so a
    // v2 whose signed manifest declared `{http:true}` while its code registered
    // `database:true` was admitted and ran unchallenged. The confirmation
    // dialog's promise — "the capabilities you approved are the ones it gets" —
    // was true for first installs only.
    //
    // Same fail-closed shape as the ABI and tree-digest gates above: refuse the
    // load, name the reason. The code has already executed by the time we can
    // read what it registered (the standing no-sandbox caveat), so this bounds
    // the STEADY state, not the first import.
    const capsViolation = loadTimeCapabilityViolation(row?.manifestMetadata, res);
    if (capsViolation) {
        const error = `declared capabilities exceeded: ${capsViolation}`;
        lastLoadError.set(name, error);
        logger.error('External plugin exceeded its signed capabilities', undefined, {
            plugin: name,
            violation: capsViolation,
        });
        return { loaded: false, name, addedProviderOrTask: false, error };
    }

    if (res.loaded) {
        lastLoadError.delete(name);
    } else if (res.error) {
        lastLoadError.set(name, res.error);
    }
    return {
        loaded: res.loaded,
        id: res.id,
        kind: res.kind,
        ids: res.ids,
        kinds: res.kinds,
        name,
        addedProviderOrTask: res.addedProviderOrTask,
        error: res.error,
        constraintViolation: res.constraintViolation,
    };
}

/**
 * Load all external plugins discovered under `$PLUGINS_EXTERNAL_DIR`.
 *
 * Returns aggregate counters including a dedicated `sdkImportErrors` field
 * the admin UI can surface as an actionable hint (see
 * {@link LoadExternalPluginsResult} for the semantics).
 */
export async function loadExternalPlugins(sql: postgres.Sql): Promise<LoadExternalPluginsResult> {
    warnIfPluginsDirEphemeral();
    const pluginDirs = await discoverExternalPlugins(sql);

    let loadedCount = 0;
    let errorCount = 0;
    _sdkImportErrorDirs.clear();

    // Use `loadOneDir` (not the legacy `loadExternalPlugin`) so the registry
    // gate + on-disk sha256 re-verify + managed-dir index.js-only rules apply
    // at boot exactly as they do on hot-load. [Fable-3][review C2/C3]
    for (const pluginDir of pluginDirs) {
        // Per-dir isolation: one bad dir (e.g. an invalid-bundle sentinel that
        // throws unexpectedly, or a tree-walk error) must never abort loading
        // the rest of the batch. Fail closed AND isolated. [§3.5]
        let res;
        try {
            res = await loadOneDir(pluginDir, sql);
        } catch (err) {
            lastLoadError.set(
                path.basename(pluginDir),
                err instanceof Error ? err.message : String(err),
            );
            errorCount++;
            continue;
        }
        if (res.loaded) loadedCount++;
        else errorCount++;
    }

    const sdkImportErrorCount = _sdkImportErrorDirs.size;

    logger.info('External plugins loaded', {
        loaded: loadedCount,
        errors: errorCount,
        sdkImportErrors: sdkImportErrorCount,
        discovered: pluginDirs.length,
    });

    return {
        loaded: loadedCount,
        errors: errorCount,
        sdkImportErrors: sdkImportErrorCount,
        discovered: pluginDirs.length,
    };
}

// =============================================================================
// Field-authority rewire — shared by boot + hot-load
// =============================================================================

/**
 * Re-wire field-authority priorities into the metadata aggregation layer from
 * the *current* set of registered ProviderDefinitions.
 *
 * Called at boot (via `loadAllPlugins`) and again on hot-load (via
 * `reloadExternalPlugins`) when a newly-loaded plugin registered a
 * ProviderDefinition — without this, the aggregation layer's effective
 * priorities table goes stale and operator-edited overrides from
 * `plugin_settings` aren't merged on top of the new provider's manifest
 * defaults.
 *
 * Best-effort: `loadProviderSettings` is internally resilient (returns an
 * empty map on DB failure and logs), so the priorities table always gets
 * something to consume.
 */
async function rebuildFieldAuthorityPriorities(sql: postgres.Sql, strict = false): Promise<void> {
    const providerDefinitions = taskRegistry.getAllProviders();
    const providerSettings = await loadProviderSettings(
        sql,
        providerDefinitions.map((d) => d.id),
        { strict },
    );
    const fieldAuthorityConfig = buildFieldAuthorityConfigFromDefinitions(
        providerDefinitions,
        providerSettings,
    );
    setEffectiveFieldPriorities(fieldAuthorityConfig.defaultPriorities);
}

// =============================================================================
// Post-load wiring (shared by aggregate reload + single-dir load)
// =============================================================================

/** Context that governs which conditional wiring steps run after a load pass. */
interface WireAfterLoadContext {
    /** Provider count captured BEFORE the load(s), to detect a new provider. */
    providerCountBefore: number;
    /** How many dirs actually loaded in this pass (gates audit + workers). */
    newlyLoadedCount: number;
}

/**
 * Run the post-load wiring pass EXACTLY ONCE after one or more dirs loaded:
 *   1. `taskRegistry.validateAt('reload')` — surfaced via `validationError`,
 *      never thrown (a bad plugin must not crash a running process).
 *   2. field-authority rewire — only when a new ProviderDefinition was added
 *      (avoids a DB round-trip on the common task/feature path).
 *   3. trigger audit + per-task worker startup — only when something loaded, so
 *      a hot-loaded task without a firing source surfaces and its jobs get a
 *      consumer.
 *
 * Extracted from the old `reloadExternalPlugins` body so `loadAndWirePlugin`
 * (single install/enable/reload) runs the identical wiring the aggregate reload
 * does. [review C13]
 */
async function wireAfterLoad(
    sql: postgres.Sql,
    ctx: WireAfterLoadContext,
): Promise<{ validationError: string | null }> {
    // Registry-wide validation — the same checks `loadBuiltins()` runs at boot
    // (ID format, processingVersion sanity, pipeline.after dangling-reference +
    // cycle detection, diamond-DAG rejection, feedsInto reference integrity),
    // re-run after every hot-load so a bad external plugin surfaces to the admin
    // UI immediately instead of quietly producing a broken pipeline the next
    // `startRun` — or worse, the next boot's `validateAt('startup')` — hits.
    // Unlike the boot path, a hot-load must NOT crash an already-running process
    // over one bad plugin: catch, log, and surface the message on the result.
    let validationError: string | null = null;
    try {
        taskRegistry.validateAt('reload');
    } catch (err) {
        validationError = err instanceof Error ? err.message : String(err);
        logger.error(
            'Hot-load: registry validation failed after reload — a newly loaded plugin may have left the registry in an inconsistent state',
            err instanceof Error ? err : new Error(validationError),
        );
    }

    // Only rebuild field-authority priorities when a NEW provider was added.
    // The vast majority of drop-in plugins are tasks/features/integrations, so
    // this avoids the DB round-trip on the common path.
    if (taskRegistry.getAllProviders().length > ctx.providerCountBefore) {
        try {
            await rebuildFieldAuthorityPriorities(sql);
        } catch (err) {
            logger.warn('Hot-load: field-authority rewire failed', {
                error: err instanceof Error ? err.message : String(err),
            });
        }
    }

    // Re-run the trigger audit + start per-task workers when at least one dir
    // loaded so a hot-loaded task without a declared firing mechanism surfaces
    // immediately (boot audit only catches builtins), and its jobs get a worker.
    if (ctx.newlyLoadedCount > 0) {
        try {
            const { auditTriggerCoverage } = await import('$lib/server/tasks/orchestrator.js');
            auditTriggerCoverage();
        } catch (err) {
            logger.error(
                'Hot-load: trigger audit threw — a newly loaded plugin may have no firing source',
                err instanceof Error ? err : new Error(String(err)),
            );
        }

        // Start a per-task BullMQ worker for any newly-registered task.
        // `TaskRunner.start()` enumerates the registry exactly ONCE at boot —
        // without this, a hot-loaded task's jobs enqueue into `bull:task:t:<id>`
        // with no consumer, forever. `getTaskRunner()` returns null when workers
        // haven't started on this replica yet — in that case the eventual
        // `TaskRunner.start()` walks the FULL registry (this task included), so
        // it self-heals without any action here.
        try {
            const { getTaskRunner } = await import('$lib/server/tasks/runner.js');
            const runner = getTaskRunner();
            if (runner) {
                await runner.ensureWorkersForRegisteredTasks();
            }
        } catch (err) {
            logger.error(
                'Hot-load: failed to start a worker for a newly loaded task — its jobs may sit unconsumed',
                err instanceof Error ? err : new Error(String(err)),
            );
        }
    }

    return { validationError };
}

// =============================================================================
// Single-flight queued mutex over hot loads
//
// The old `_reloadInFlight` is promise-COALESCING (a second caller gets the
// first call's result) — fine for reload-vs-reload (identical aggregate work),
// but WRONG for `loadAndWirePlugin`: an install racing an admin reload would
// receive the aggregate reload's result object, or its own dir would silently
// never load. So both paths await a REAL queued mutex that runs operations
// one-at-a-time in FIFO order, so reload and single-dir load never interleave
// `taskRegistry` / field-authority mutation. [review C13]
// =============================================================================

let _loadChain: Promise<unknown> = Promise.resolve();

function runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = _loadChain.then(fn, fn); // run regardless of prior outcome
    _loadChain = next.catch(() => {}); // never let a rejection poison the chain
    return next;
}

/**
 * Load a single plugin directory then run the post-load wiring pass, serialized
 * behind the queued mutex so it never interleaves with a concurrent reload or
 * another single-dir load. Used by the install / enable / reload handlers.
 */
export async function loadAndWirePlugin(
    dir: string,
    sql: postgres.Sql,
    constraints?: LoadConstraints,
): Promise<{
    loaded: boolean;
    id?: string;
    kind?: string;
    /** Every contract the bundle registered (length 1 for single-contract). */
    ids?: string[];
    kinds?: string[];
    error?: string;
    constraintViolation?: boolean;
    validationError: string | null;
}> {
    return runExclusive(async () => {
        const providerCountBefore = taskRegistry.getAllProviders().length;
        const res = await loadOneDir(dir, sql, constraints);
        const { validationError } = await wireAfterLoad(sql, {
            providerCountBefore,
            newlyLoadedCount: res.loaded ? 1 : 0,
        });
        return {
            loaded: res.loaded,
            id: res.id,
            kind: res.kind,
            ids: res.ids,
            kinds: res.kinds,
            error: res.error,
            constraintViolation: res.constraintViolation,
            validationError,
        };
    });
}

// =============================================================================
// Main Loading Function
// =============================================================================

let pluginsLoaded = false;
let bootInFlight: Promise<void> | undefined;
const bootDirectoryLoads = new Map<string, Promise<LoadOneDirResult>>();

/**
 * Discover + register external drop-in plugins, then wire field-authority
 * priorities into the aggregation layer.
 *
 * Idempotent: subsequent calls are no-ops once it's run. Builtins are loaded
 * separately by `loadBuiltins()` from `tasks/builtin/index.ts` in
 * hooks.server.ts before this; both routes register against `taskRegistry`.
 */
export function loadAllPlugins(sql: postgres.Sql): Promise<void> {
    if (pluginsLoaded) return Promise.resolve();
    bootInFlight ??= runExclusive(() => loadAllPluginsBody(sql)).finally(() => {
        bootInFlight = undefined;
    });
    return bootInFlight;
}

async function loadAllPluginsBody(sql: postgres.Sql): Promise<void> {
    warnIfPluginsDirEphemeral();
    // Admin install/reload shares this mutex. Resolve registry SQL BEFORE
    // retaining an admission attempt: a lookup outage is safe to retry, whereas
    // plugin imports may have irreversible or partially completed side effects.
    const dirs = await discoverExternalPlugins(sql);
    let lookupFailed = false;
    for (const dir of dirs) {
        let loading = bootDirectoryLoads.get(dir);
        if (!loading) {
            if (taskRegistry.hasPluginRegistered(derivePluginIdFromDir(dir))) continue;
            let row: Awaited<ReturnType<typeof getExternalPlugin>>;
            try {
                row = await getExternalPlugin(sql, path.basename(dir));
            } catch (err) {
                lookupFailed = true;
                lastLoadError.set(
                    path.basename(dir),
                    err instanceof Error ? err.message : String(err),
                );
                continue;
            }
            loading = loadOneDir(dir, sql, undefined, row);
            bootDirectoryLoads.set(dir, loading);
        }
        // Keep failed admissions retained to avoid replaying unknown partial
        // effects, while isolating that plugin from the rest of startup.
        try {
            await loading;
        } catch (err) {
            const name = path.basename(dir);
            const error = err instanceof Error ? err.message : String(err);
            lastLoadError.set(name, error);
            logger.warn('External plugin startup admission failed; skipping plugin', {
                name,
                error,
            });
        }
    }
    if (lookupFailed) throw new Error('External plugin registry lookup unavailable during startup');

    // Wire field priorities into the aggregation query layer from the
    // ProviderDefinition metadata declared on each native + drop-in
    // provider. Operator overrides from `plugin_settings` (priority /
    // fieldAuthorities keys) are merged on top of the manifest defaults so
    // admin UI edits take effect at boot, not just on the next admin PATCH.
    await rebuildFieldAuthorityPriorities(sql, true);

    logger.info('Plugins loaded', {
        metadataProviders: taskRegistry.getAllProviders().length,
        features: taskRegistry.getAllFeatures().length,
        integrations: taskRegistry.getAllIntegrations().length,
        trickplays: taskRegistry.getAllTrickplays().length,
        mediaSources: taskRegistry.getAllMediaSources().length,
        watchSyncs: taskRegistry.getAllWatchSyncs().length,
        externalServices: taskRegistry.getAllExternalServices().length,
        tasks: taskRegistry.getAllTasks().length,
    });

    pluginsLoaded = true;
}

// =============================================================================
// Hot-load (Variant A): bounded reload that ADDS new plugins only.
//
// Replace/unload semantics are intentionally NOT supported here — both require
// invalidating cached references held by the scheduler, runner, and field-
// authority resolver, and the side-effects of duplicate registration throw at
// the registry layer. Modifying or removing an existing plugin still requires
// a process restart.
//
// Multi-replica caveat: each replica owns its own filesystem and registry, so
// only the replica that receives the reload request loads the new plugin.
// Operators driving multiple replicas need the same files on each and must
// trigger the endpoint per replica (or rely on a coordinated rolling restart).
// =============================================================================

/**
 * Result of a hot-load attempt. Extends the boot-time `LoadExternalPluginsResult`
 * with two reload-specific fields so callers (admin API) can show "loaded N new,
 * skipped K already-known".
 */
export type ReloadExternalPluginsResult = LoadExternalPluginsResult & {
    /** Plugin ids that were loaded by this call (in the order they loaded). */
    newlyLoaded: string[];
    /** Plugin dirs that were skipped because their id was already registered. */
    skippedKnown: number;
    /**
     * Error message from `taskRegistry.validateAt('reload')` if the
     * post-reload registry state failed validation (bad `pipeline.after`
     * reference, cycle, diamond DAG, malformed id, etc.), else `null`. A
     * non-null value does NOT mean the reload failed outright — the newly
     * loaded plugin(s) are still registered — it flags that the registry is
     * now in a state that will misbehave at run time (or fail the next
     * boot's fail-fast `validateAt('startup')`) and needs operator attention.
     */
    validationError: string | null;
};

/**
 * Derive the plugin id that a directory would register as, without importing
 * the module. Mirrors how `loadExternalPlugin` picks an id:
 *   1. If `package.json#name` is present → use that.
 *   2. Otherwise fall back to the directory basename.
 *
 * The detection MUST stay consistent with the actual default export's `id`
 * field — for our drop-in plugins these agree (the SDK convention is to set
 * `id` to match the package name). If a plugin author diverges, the worst case
 * is a one-shot redundant load attempt followed by a duplicate-id error from
 * the registry, which `loadExternalPlugin` already converts to `false`.
 */
function derivePluginIdFromDir(pluginDir: string): string {
    const packageJsonPath = path.join(pluginDir, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
        try {
            const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8')) as {
                name?: string;
            };
            if (pkg.name && typeof pkg.name === 'string') return pkg.name;
        } catch {
            // fall through
        }
    }
    return path.basename(pluginDir);
}

/**
 * Reload the external-plugins directory and load only NOVEL plugin dirs
 * (those whose derived id is not yet registered against any contract kind).
 *
 * Does NOT replace or unload existing plugins — those require a process
 * restart. Re-runs the field-authority rewire only when at least one newly-
 * loaded plugin registered a ProviderDefinition, otherwise the aggregation
 * layer is untouched.
 *
 * @param sql - DB handle used by the field-authority rewire path.
 */
export async function reloadExternalPlugins(
    sql: postgres.Sql,
): Promise<ReloadExternalPluginsResult> {
    // Single-flight: two admin clicks otherwise race on the module-level
    // `_sdkImportErrorDirs.clear()` and report each other's accumulator as
    // their own. Returning the in-flight promise gives both callers the
    // same correct result. The body itself runs inside `runExclusive` so a
    // reload and a single-dir `loadAndWirePlugin` never interleave registry
    // mutation. [review C13]
    if (_reloadInFlight) return _reloadInFlight;

    _reloadInFlight = runExclusive(() => reloadExternalPluginsBody(sql)).finally(() => {
        // Reset via `.finally()` on the returned promise (never inside the body)
        // so it runs in a microtask strictly AFTER the synchronous
        // `_reloadInFlight = …` assignment completes — even when the body never
        // awaits — otherwise the reset could clobber `null` back to the resolved
        // promise and wedge `_reloadInFlight` non-null forever. [Promises/A+ 2.2.4]
        _reloadInFlight = null;
    });

    return _reloadInFlight;
}

/**
 * Aggregate hot-load body: discover novel dirs, `loadOneDir` each, then run
 * `wireAfterLoad` EXACTLY ONCE (never N×). Extracted so `reloadExternalPlugins`
 * can wrap it in `runExclusive` + the `_reloadInFlight` coalescing guard.
 */
async function reloadExternalPluginsBody(sql: postgres.Sql): Promise<ReloadExternalPluginsResult> {
    const pluginDirs = await discoverExternalPlugins(sql);

    const novelDirs: string[] = [];
    let skippedKnown = 0;
    for (const dir of pluginDirs) {
        const id = derivePluginIdFromDir(dir);
        if (taskRegistry.hasPluginRegistered(id)) {
            skippedKnown++;
            continue;
        }
        novelDirs.push(dir);
    }

    // Snapshot the provider count BEFORE loading so `wireAfterLoad` can decide
    // whether the field-authority rewire is needed afterwards. Cheaper + more
    // robust than inspecting the freshly-loaded module's shape.
    const providerCountBefore = taskRegistry.getAllProviders().length;

    let loadedCount = 0;
    let errorCount = 0;
    const newlyLoaded: string[] = [];
    _sdkImportErrorDirs.clear();

    for (const pluginDir of novelDirs) {
        const id = derivePluginIdFromDir(pluginDir);
        // Re-check registration immediately before loading: some other code
        // path may have registered this id between the initial novel-dir filter
        // and now. Treating that as `skippedKnown++` (not `errorCount++`) avoids
        // misreporting a successful concurrent registration as a load failure.
        if (taskRegistry.hasPluginRegistered(id)) {
            skippedKnown++;
            continue;
        }
        let res;
        try {
            res = await loadOneDir(pluginDir, sql);
        } catch (err) {
            lastLoadError.set(id, err instanceof Error ? err.message : String(err));
            errorCount++;
            continue;
        }
        if (res.loaded) {
            loadedCount++;
            newlyLoaded.push(id);
        } else {
            errorCount++;
        }
    }

    const sdkImportErrorCount = _sdkImportErrorDirs.size;

    // Post-load wiring — validate + (conditional) field-authority rewire +
    // (conditional) audit/worker startup — run EXACTLY ONCE after the loop.
    const { validationError } = await wireAfterLoad(sql, {
        providerCountBefore,
        newlyLoadedCount: newlyLoaded.length,
    });

    logger.info('External plugins reloaded', {
        discovered: pluginDirs.length,
        skippedKnown,
        newlyLoaded: newlyLoaded.length,
        errors: errorCount,
        sdkImportErrors: sdkImportErrorCount,
        validationError,
    });

    return {
        loaded: loadedCount,
        errors: errorCount,
        sdkImportErrors: sdkImportErrorCount,
        discovered: pluginDirs.length,
        newlyLoaded,
        skippedKnown,
        validationError,
    };
}
