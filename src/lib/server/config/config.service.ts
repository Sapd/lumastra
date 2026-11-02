// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Configuration Service
 *
 * Handles loading, saving, validating, and caching configuration values.
 * Priority order: ENV variable > JSON file > Schema default
 */

import { ConfigConflictError } from './config-conflict.js';
import { readFile, writeFile, mkdir, access, constants, rename, stat, unlink } from 'fs/promises';
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import {
    configSchema,
    configSections,
    getDefaultValues,
    validateSettingValue,
    validateSettingFormat,
    toList,
    type SettingDefinition,
    type SectionDefinition,
    type DefaultResolutionContext,
} from '$lib/config/schema.js';
import { normalizePublicBaseUrl } from '$lib/shared/public-base-url.js';
import { normalizeLanguageTag, isPrimaryLanguageTag } from '$lib/shared/metadata-language.js';
import { isRecord } from '$lib/utils/data-extraction';
import { isSecretSentinel } from '$lib/shared/secret-sentinel';
import { getCpuBudgetCores } from '$lib/server/utils/cpu-budget.js';
import {
    deriveMasterKey,
    sealSecret,
    openSecret,
    isSealed,
    isAadBound,
} from '$lib/server/crypto/secret-box.js';
import { resolveMasterKey } from '$lib/server/crypto/master-key.js';
import {
    IsolationWorkerKeyAccessError,
    isIsolationWorker,
} from '$lib/server/tasks/isolation/isolation-context.js';

/**
 * Build the context used to resolve environment-derived setting defaults
 * (currently: CPU-budget-aware task concurrency). Read once via the memoized
 * cgroup detector. Used everywhere defaults are produced or compared so seeding,
 * "reset to default", and the admin display all agree.
 */
function defaultResolutionContext(): DefaultResolutionContext {
    return { cpuCores: getCpuBudgetCores() };
}

/**
 * Coerces + normalizes a raw METADATA_ADDITIONAL_LANGUAGES value (either a
 * comma-separated string — the admin UI's ArrayInput shape — or a real
 * string[]) into a deduped set of canonical BCP-47 tags. Used on BOTH sides
 * of the settings-save diff below so a pure casing edit (`pt-br` → `pt-BR`)
 * or a re-save of the same set is recognized as "no new language" instead of
 * always diffing `[] !== []` (the bug this replaces) or over-triggering on
 * case-only churn.
 *
 * `primaryTag` (the TMDB_LANGUAGE in effect) excludes primary-equal entries
 * via the shared `isPrimaryLanguageTag` — the SAME exclusion the runtime
 * getter (`config.METADATA_ADDITIONAL_LANGUAGES`) applies. Without it the
 * diff below reasons about the RAW list while the getter serves the
 * EFFECTIVE list: with TMDB_LANGUAGE='en-US' and additional ['de'], a save
 * of 'de, en' would diff `addedLanguages=['en']` and fire a whole-catalog
 * re-enroll + TMDB re-fetch even though the effective config (['de']) never
 * changed.
 */
function normalizedLanguageSet(value: unknown, primaryTag?: string): string[] {
    const seen = new Set<string>();
    for (const raw of toList(value)) {
        const normalized = normalizeLanguageTag(raw);
        if (!normalized) continue;
        if (primaryTag !== undefined && isPrimaryLanguageTag(normalized, primaryTag)) continue;
        seen.add(normalized);
    }
    return [...seen];
}

// ============================================================================
// At-rest encryption for sensitive settings (F66 / Sec MED-8)
// ============================================================================
//
// Sensitive settings (uiHints.sensitive === true — service API keys, etc.) are
// persisted to settings.json as AES-256-GCM envelopes (`enc:v1:<base64>`) using
// the same LUMASTRA_MASTER_KEY mechanism as plugin secrets, instead of plaintext.
// Decryption is auto-detected on load via the envelope prefix, so an install
// that later sets a master key transparently upgrades plaintext values on the
// next save.
//
// LUMASTRA_MASTER_KEY is ENV-only (not a config-schema key) and is read from
// process.env directly here rather than importing the config.ts getter — that
// getter is mid-initialization while this service loads, and importing it would
// create a module-load cycle.

/**
 * Schema keys whose values must be encrypted at rest.
 *
 * Exported because it is also the authority for MASKING: the debug report
 * (`debug-report/redact.ts`) redacts config by this same flag. Regex-over-text
 * redaction cannot substitute for it — `stripSecrets`' `key=value` form never
 * matches a bare `JELLYFIN_API_KEY` key name — so "encrypted at rest" and
 * "masked in a shared report" must stay the same predicate, or a newly flagged
 * secret would be sealed on disk yet still printed into a GitHub issue.
 */
export function isSensitiveKey(key: string): boolean {
    const setting = configSchema.find((s) => s.key === key);
    return setting?.uiHints?.sensitive === true;
}

/**
 * Derive the master key from process.env.LUMASTRA_MASTER_KEY, or null when no
 * key is configured. Cached for the process lifetime (the env value cannot
 * change without a restart). Returning null lets callers fall back to plaintext
 * so installs without a master key keep working.
 */
let _cachedMasterKey: Buffer | null | undefined;
function getConfigMasterKey(): Buffer | null {
    // A plugin-isolation worker never holds the key (security boundary, B1):
    // resolveMasterKey() would throw there. Loading config in the worker still
    // has to work, so report "no key" — decryptLoadedConfig then drops sealed
    // values (the worker receives their decrypted form through the env the main
    // thread mirrors), and doSaveConfig refuses to write secrets.
    if (isIsolationWorker()) return null;
    if (_cachedMasterKey) return _cachedMasterKey;
    // Effective key: explicit env, else the file-backed key (auto-generated on
    // first use), so secrets are encrypted at rest by default.
    const envValue = resolveMasterKey();
    if (!envValue) {
        // Don't memoize the "no key yet" state — resolveMasterKey may succeed on a
        // later call (e.g. once the config dir is writable / the file is flushed),
        // and we must pick it up rather than store plaintext for the whole process.
        return null;
    }
    try {
        _cachedMasterKey = deriveMasterKey(envValue);
    } catch (error) {
        console.warn(
            `[ConfigService] LUMASTRA_MASTER_KEY is invalid — sensitive settings will be stored in plaintext: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
        return null;
    }
    return _cachedMasterKey;
}

/**
 * Test-only escape hatch: drop the memoized master key so a test that rotates
 * it (which mutates this process-wide singleton — see `rotateConfigSecrets`)
 * cannot leak that state into a later test in the same module instance.
 * Mirrors `__resetMasterKeyCacheForTests` in tasks/secrets.ts. Not used by
 * production code paths.
 */
export function __resetConfigMasterKeyCacheForTests(): void {
    _cachedMasterKey = undefined;
}

/**
 * Settings keys whose stored envelope could not be opened on the most recent
 * load. A dropped key means the running process is serving the SCHEMA DEFAULT
 * (or the ENV value) for a credential the operator believes is configured — an
 * API key that silently stopped being sent, not a cosmetic warning.
 *
 * security review 2026-09-12, C9: this used to be a `console.warn` per key and
 * nothing else, so the single most likely aftermath of a master-key change (the
 * key was swapped without rotating settings.json) left no durable signal
 * anywhere an operator looks. The names are kept here so a self-check rule can
 * report them; see docs/security/master-key-rotation.md.
 */
let undecryptableConfigKeys: string[] = [];

/**
 * Setting keys whose sealed value could not be decrypted at the last config
 * load, with repaired values removed after a successful save. Empty on a healthy install.
 */
export function getUndecryptableConfigKeys(): string[] {
    return [...undecryptableConfigKeys];
}

/**
 * Setting keys whose stored envelope is the OLD, unbound `enc:v1:` form
 * (security review 2026-09-13, C19), as of the last time this process read or
 * wrote settings.json.
 *
 * settings.json is a FILE, not a table, so the security self-check cannot count
 * these with a query the way it counts every other store — it asks this module
 * instead. Tracked exactly like {@link getUndecryptableConfigKeys}: recorded
 * when the file is loaded, and refreshed by the two paths that rewrite it
 * (`saveConfig`, `rotateConfigSecrets`) so the answer does not go stale until
 * the next restart.
 */
let legacyConfigEnvelopeKeys: string[] = [];

/** @see legacyConfigEnvelopeKeys */
export function getLegacyConfigEnvelopeKeys(): string[] {
    return [...legacyConfigEnvelopeKeys];
}

/** Re-derive {@link legacyConfigEnvelopeKeys} from a raw (still-sealed) config map. */
function recordLegacyEnvelopes(rawValues: ConfigValues): void {
    legacyConfigEnvelopeKeys = Object.entries(rawValues)
        .filter(([, v]) => typeof v === 'string' && isSealed(v) && !isAadBound(v))
        .map(([k]) => k);
}

/**
 * AAD context binding a sealed setting to its own key (security review
 * 2026-09-13, C19). Without it, the envelope for a low-value setting could be
 * swapped into a high-value one — or vice versa — by anyone who can write
 * settings.json, and the loader would decrypt it happily. The setting key is
 * the stable identity of the value for its whole life.
 */
function configSecretContext(key: string): string {
    return `settings.json:${key}`;
}

/**
 * Decrypt any encrypted-envelope values in a loaded JSON config in place.
 * Non-envelope (plaintext) values pass through unchanged. A value that fails to
 * decrypt is dropped (left absent) so the in-memory state never carries an
 * unreadable ciphertext string as a credential — but it is recorded in
 * {@link getUndecryptableConfigKeys} and logged at ERROR level, because a
 * dropped credential is a live configuration fault, not a warning.
 */
function decryptLoadedConfig(values: ConfigValues): ConfigValues {
    const masterKey = getConfigMasterKey();
    const result: ConfigValues = {};
    const dropped: string[] = [];
    for (const [key, value] of Object.entries(values)) {
        if (typeof value === 'string' && isSealed(value)) {
            if (!masterKey) {
                dropped.push(key);
                continue;
            }
            try {
                result[key] = openSecret(value, masterKey, configSecretContext(key));
            } catch (error) {
                dropped.push(key);
                console.error(
                    `[ConfigService] Failed to decrypt ${key}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        } else {
            result[key] = value;
        }
    }
    // In an isolation worker a sealed value is unreadable BY DESIGN, not a fault:
    // no ERROR log, and nothing recorded as "undecryptable" in this thread.
    if (isIsolationWorker()) {
        undecryptableConfigKeys = [];
        recordLegacyEnvelopes(values);
        return result;
    }
    undecryptableConfigKeys = dropped;
    recordLegacyEnvelopes(values);
    if (dropped.length > 0) {
        console.error(
            `[ConfigService] ${dropped.length} sensitive setting(s) could not be decrypted and are ` +
                `NOT in effect — the app is running on their defaults: ${dropped.join(', ')}. ` +
                (masterKey
                    ? 'The stored values were sealed under a different LUMASTRA_MASTER_KEY. Restore the ' +
                      'previous key and run the master-key rotation (POST /api/admin/secrets/rotate), or ' +
                      're-enter these settings. See docs/security/master-key-rotation.md.'
                    : 'LUMASTRA_MASTER_KEY is not set — set it to the key these values were sealed with.'),
        );
    }
    return result;
}

/**
 * Replace settings.json without ever leaving a half-written file behind: write
 * a sibling temp file, then rename it over the target. A plain writeFile
 * truncates first, so a crash mid-write left a cut-off file, and a replica
 * reloading on the config-changed event could read it mid-write (an
 * unparseable file used to reset that replica to defaults).
 *
 * A settings.json bind-mounted as a single file cannot be renamed over
 * (EBUSY/EXDEV); that layout falls back to the in-place write it always had.
 */
export async function writeConfigFileAtomic(filePath: string, content: string): Promise<void> {
    let mode = 0o600;
    try {
        mode = (await stat(filePath)).mode & 0o777;
    } catch {
        // New file: owner-only, it can hold plaintext secrets without a master key.
    }
    const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmpPath, content, { encoding: 'utf-8', mode });
    try {
        await rename(tmpPath, filePath);
    } catch (error) {
        await unlink(tmpPath).catch(() => {});
        const code = (error as { code?: string }).code;
        if (code !== 'EBUSY' && code !== 'EXDEV' && code !== 'EPERM') throw error;
        await writeFile(filePath, content, 'utf-8');
    }
}

/** settings.json exists but cannot be read or parsed. */
export class ConfigFileUnreadableError extends Error {
    constructor(filePath: string, cause: unknown) {
        super(
            `${filePath} could not be read (${
                cause instanceof Error ? cause.message : String(cause)
            }); fix or restore the file before saving settings`,
        );
        this.name = 'ConfigFileUnreadableError';
    }
}

/**
 * Re-seal every sensitive value in settings.json from `oldMasterKey` to
 * `newMasterKey` (security review 2026-09-12, C9).
 *
 * The rotation endpoint used to cover only the plugin secret tables, so an
 * operator who rotated and then swapped LUMASTRA_MASTER_KEY lost every
 * sensitive setting in this file: `decryptLoadedConfig` dropped them on the
 * next boot while the old ciphertext still opened with the retired key.
 *
 * Per-value and idempotent: a value that already opens under the NEW key is
 * counted as rotated and left alone, so re-running after a partial failure
 * finishes the job. The file is written ONCE, at the end, and only when
 * something actually changed — a run that re-seals nothing cannot damage a
 * file it could not read.
 *
 * Requires the config service to be initialised (the caller is an HTTP
 * handler, so it always is in a running server); an uninitialised service
 * reports "not rotated" rather than guessing at a file path.
 */
export async function rotateConfigSecrets(
    oldMasterKey: Buffer,
    newMasterKey: Buffer,
): Promise<{ rotated: number; skipped: number; reasons: string[]; legacyUpgraded: number }> {
    if (!configState) {
        return {
            rotated: 0,
            skipped: 0,
            legacyUpgraded: 0,
            reasons: ['config service is not initialised — settings.json was not rotated'],
        };
    }

    // Share saveConfig's write lock: a concurrent admin save must not read the
    // file between our read and our write and resurrect an old-key envelope.
    const prev = configWriteLock;
    let release!: () => void;
    configWriteLock = new Promise<void>((resolve) => (release = resolve));
    await prev.catch(() => {});
    try {
        const filePath = getConfigFilePath();
        if (!existsSync(filePath)) {
            return { rotated: 0, skipped: 0, reasons: [], legacyUpgraded: 0 };
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
        } catch (error) {
            return {
                rotated: 0,
                skipped: 0,
                legacyUpgraded: 0,
                reasons: [
                    `${filePath} could not be parsed: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                ],
            };
        }
        if (!isRecord(parsed)) return { rotated: 0, skipped: 0, reasons: [], legacyUpgraded: 0 };

        const content = parsed as ConfigValues;
        let rotated = 0;
        let skipped = 0;
        let legacyUpgraded = 0;
        let changed = false;
        const reasons: string[] = [];

        for (const [key, value] of Object.entries(content)) {
            if (typeof value !== 'string' || !isSealed(value)) continue;

            const context = configSecretContext(key);

            // Already under the new key AND already bound to its setting key:
            // a re-run of a partially-failed rotation has nothing to do here.
            let plain: string | null = null;
            try {
                plain = openSecret(value, newMasterKey, context);
                if (isAadBound(value)) {
                    rotated++;
                    continue;
                }
            } catch {
                // Not yet under the new key — fall through to the old-key path.
            }

            try {
                plain ??= openSecret(value, oldMasterKey, context);
                content[key] = sealSecret(plain, newMasterKey, context);
                if (!isAadBound(value)) legacyUpgraded++;
                rotated++;
                changed = true;
            } catch (error) {
                skipped++;
                reasons.push(
                    `settings.json ${key}: ${
                        error instanceof Error ? error.message : String(error)
                    }`,
                );
            }
        }

        if (changed) {
            await writeConfigFileAtomic(filePath, JSON.stringify(content, null, 2) + '\n');
            // The file on disk just changed under us; re-derive rather than let
            // the self-check keep reporting what was true before the rotation.
            recordLegacyEnvelopes(content);
            // Self-heal THIS process: saves made after the rotation must seal
            // under the new key, not the one cached at boot. Other replicas
            // still need the env swap and a restart — see
            // docs/security/master-key-rotation.md.
            _cachedMasterKey = newMasterKey;
        }

        return { rotated, skipped, reasons, legacyUpgraded };
    } finally {
        release();
    }
}

// ============================================================================
// Types
// ============================================================================

export interface ConfigValues {
    [key: string]: unknown;
}

export interface ConfigState {
    /** All current values (defaults + JSON + ENV) */
    values: ConfigValues;
    /** Keys that are overridden by ENV (locked) */
    envOverrides: Set<string>;
    /** Keys modified in JSON file (different from default) */
    jsonOverrides: Set<string>;
    /** Last load time */
    loadedAt: Date;
}

// ============================================================================
// Configuration
// ============================================================================

// Config file paths - check local first (dev), then Docker paths (production)
const LOCAL_CONFIG_PATH = './config/settings.json';
const DOCKER_CONFIG_PATH = '/config/settings.json';
const ALT_DOCKER_CONFIG_PATH = '/app/config/settings.json';

function resolveEnvConfigPath(): string | null {
    const configPath = process.env.CONFIG_PATH?.trim();
    if (configPath) return configPath;
    const configDir = process.env.CONFIG_DIR?.trim();
    if (configDir) return resolve(configDir, 'settings.json');
    return null;
}

// Determine which config path to use.
//
// Exported because builtin plugins (e.g. fribb-anime-sync) need to write
// their own keys into the same config file the runtime loads.
export function getConfigFilePath(): string {
    const envPath = resolveEnvConfigPath();
    if (envPath) {
        return envPath;
    }
    // In Docker/production, prefer /config/ (mounted volume) over ./config (baked into image)
    if (existsSync('/config')) {
        return DOCKER_CONFIG_PATH;
    }
    // In development, use local ./config/ directory
    if (existsSync(LOCAL_CONFIG_PATH) || existsSync('./config')) {
        return LOCAL_CONFIG_PATH;
    }
    // Alternate Docker path (e.g., when mounting full /app/config)
    if (existsSync('/app/config')) {
        return ALT_DOCKER_CONFIG_PATH;
    }
    // Default to local for new setups
    return LOCAL_CONFIG_PATH;
}

/**
 * Get the current config file path (for display in admin UI)
 */
export function getConfigPath(): string {
    return getConfigFilePath();
}

export interface ConfigStorageStatus {
    /** Current config file path */
    path: string;
    /** Whether the config directory exists */
    directoryExists: boolean;
    /** Whether the config directory is writable */
    isWritable: boolean;
    /** Whether this appears to be a Docker volume mount */
    isMounted: boolean;
    /** Whether settings will persist (directory exists + writable + mounted in Docker) */
    willPersist: boolean;
    /** Human-readable status message */
    message: string;
}

/**
 * Check the status of config storage.
 * Useful for admin UI to warn if settings won't persist.
 */
export async function getConfigStorageStatus(): Promise<ConfigStorageStatus> {
    const configPath = getConfigFilePath();
    const configDir = dirname(configPath);
    const absoluteDir = resolve(configDir);
    const isDockerPath =
        configPath === DOCKER_CONFIG_PATH ||
        configPath === ALT_DOCKER_CONFIG_PATH ||
        configPath.startsWith('/config/') ||
        configPath.startsWith('/app/config/');

    let directoryExists: boolean;
    let isWritable = false;
    let isMounted = false;

    // Check if directory exists
    directoryExists = existsSync(configDir);

    // Check if writable
    if (directoryExists) {
        try {
            await access(configDir, constants.W_OK);
            isWritable = true;
        } catch {
            // best-effort: W_OK probe — failure means the config dir isn't writable.
            isWritable = false;
        }
    }

    // Check if it's a mount point (Linux only, via /proc/mounts)
    if (isDockerPath && directoryExists) {
        try {
            const mounts = await readFile('/proc/mounts', 'utf-8');
            // Check if config directory is listed as a mount point
            isMounted = mounts.split('\n').some((line) => {
                const parts = line.split(' ');
                // Mount point is the second field
                return (
                    parts[1] === '/config' || parts[1] === '/app/config' || parts[1] === absoluteDir
                );
            });
        } catch {
            // /proc/mounts doesn't exist (not Linux) - assume mounted if directory exists
            isMounted = directoryExists;
        }
    } else if (!isDockerPath) {
        // Local development path - always "mounted" (it's local filesystem)
        isMounted = true;
    }

    // Determine if settings will persist
    const willPersist = directoryExists && isWritable && isMounted;

    // Generate human-readable message
    let message: string;
    if (!directoryExists) {
        message = isDockerPath
            ? 'Config directory /config does not exist. Mount a volume to persist settings.'
            : 'Config directory does not exist. It will be created when you save settings.';
    } else if (!isWritable) {
        message = 'Config directory exists but is not writable. Check permissions.';
    } else if (isDockerPath && !isMounted) {
        message =
            'Config directory exists but is not a mounted volume. Settings will be lost on container restart.';
    } else {
        message = 'Settings will persist.';
    }

    return {
        path: configPath,
        directoryExists,
        isWritable,
        isMounted,
        willPersist,
        message,
    };
}

// ============================================================================
// State
// ============================================================================

let configState: ConfigState | null = null;

/**
 * Valkey pub/sub channel announcing that the shared settings.json changed.
 * Payload is a JSON array of the keys touched by the save. A subscriber wired
 * at process startup (in another module) can react by calling reloadConfig().
 */
export const CONFIG_CHANGED_CHANNEL = 'config:changed';

// ============================================================================
// Core Functions
// ============================================================================

/**
 * What {@link mirrorToProcessEnv} last wrote into process.env, per key. A
 * reload reads the environment again; without this it could not tell our own
 * mirror from an operator's variable, so after the first reload (e.g. the
 * config-changed broadcast every save triggers) every mirrored setting was
 * flagged "ENV" — locked in the UI, skipped by saveConfig — and the stale
 * mirrored value beat the settings.json value it was copied from.
 */
// Shared through globalThis: the dev server can evaluate this module more than
// once (HMR, a second import specifier), and every instance mirrors into the
// ONE process.env — a per-instance map let a fresh instance read the other's
// mirror as operator variables (617 "env overrides" on a dev restart).
/**
 * The values this process started with for settings marked `requiresRestart`.
 * A saved change to one of them is stored at once but only takes effect after
 * a restart; comparing against this snapshot is how the admin UI can say "N
 * saved changes are waiting for a restart" — per process, so it is right on
 * every replica.
 */
let bootRestartSnapshot: Map<string, string> | null = null;

function snapshotRestartValues(values: ConfigValues): void {
    if (bootRestartSnapshot) return;
    bootRestartSnapshot = new Map(
        configSchema
            .filter((s) => s.requiresRestart)
            .map((s) => [s.key, JSON.stringify(values[s.key] ?? null)]),
    );
}

/** Restart-only settings whose value differs from what this process booted with. */
export function getPendingRestartKeys(): string[] {
    if (!configState || !bootRestartSnapshot) return [];
    const out: string[] = [];
    for (const [key, boot] of bootRestartSnapshot) {
        if (JSON.stringify(configState.values[key] ?? null) !== boot) out.push(key);
    }
    return out;
}

/**
 * Called after the config values change in this process: at init, after a
 * reload (every save broadcasts one to all replicas) and after a local save.
 * `changedKeys` is null when the whole config was (re)loaded.
 *
 * This is how code that captured a value once — a module-level client, an
 * interval period, a frozen `export let` in config.ts — picks up a saved
 * setting without a restart.
 */
export type ConfigChangeListener = (changedKeys: readonly string[] | null) => void;
const configChangeListeners = new Set<ConfigChangeListener>();

export function onConfigChange(listener: ConfigChangeListener): () => void {
    configChangeListeners.add(listener);
    return () => configChangeListeners.delete(listener);
}

function notifyConfigChange(changedKeys: readonly string[] | null): void {
    for (const listener of configChangeListeners) {
        try {
            listener(changedKeys);
        } catch (err) {
            console.warn('[ConfigService] config-change listener failed', err);
        }
    }
}

const MIRRORED_ENV_KEY = Symbol.for('lumastra.config.mirroredEnv');
const mirroredEnv: Map<string, string> = ((
    globalThis as unknown as Record<symbol, Map<string, string> | undefined>
)[MIRRORED_ENV_KEY] ??= new Map<string, string>());

/**
 * Keys renamed before v0.1. An install that still sets the old name, in the environment or
 * in settings.json, keeps working: the old value is used when the new key isn't set.
 */
const RENAMED_KEYS: Readonly<Record<string, string>> = {
    JELLYSEERRURL: 'SEERRURL',
    JELLYSEERRAPIKEY: 'SEERRAPIKEY',
};

export function withRenamedKeys<T>(source: Record<string, T>): Record<string, T> {
    const out: Record<string, T> = { ...source };
    for (const [oldKey, newKey] of Object.entries(RENAMED_KEYS)) {
        const legacy = out[oldKey];
        const current = out[newKey];
        if (legacy !== undefined && legacy !== '' && (current === undefined || current === '')) {
            out[newKey] = legacy;
        }
    }
    return out;
}

/** The environment minus the values this module mirrored into it. */
function withoutMirroredEnv(
    env: Record<string, string | undefined>,
): Record<string, string | undefined> {
    const out: Record<string, string | undefined> = { ...env };
    for (const [key, mirrored] of mirroredEnv) {
        if (out[key] === mirrored) delete out[key];
    }
    return out;
}

/**
 * settings.json values for `envOnlyEnforced` keys found at load: they are
 * skipped, and each key is logged once per process with the value that applies
 * instead, so an upgrade that moved a key to env-only never changes it silently.
 */
const loggedIgnoredEnvOnlyKeys = new Set<string>();

function logIgnoredEnvOnlyJsonValues(
    ignored: ReadonlyMap<string, unknown>,
    values: ConfigValues,
    envOverrides: ReadonlySet<string>,
): void {
    for (const [key, fileValue] of ignored) {
        if (loggedIgnoredEnvOnlyKeys.has(key)) continue;
        loggedIgnoredEnvOnlyKeys.add(key);
        const source = envOverrides.has(key) ? 'the environment' : 'the default';
        console.warn(
            `[ConfigService] settings.json sets ${key}=${JSON.stringify(fileValue)}, which is ignored: ` +
                `${key} can only be set as an environment variable. In effect: ${JSON.stringify(values[key])} from ${source}. ` +
                `Set ${key} in the environment (.env or the container environment) and remove it from settings.json.`,
        );
    }
}

/** Test hook: log ignored env-only settings.json values again. */
export function __resetIgnoredEnvOnlyLogForTests(): void {
    loggedIgnoredEnvOnlyKeys.clear();
}

// Legacy saved URLs were accepted without format validation. Runtime callers
// intentionally receive an empty URL for those values, but admins must know why.
// Never include the value: an old URL may contain embedded credentials.
let warnedInvalidPublicBaseUrl = false;
function warnInvalidPublicBaseUrl(value: unknown): void {
    if (
        !warnedInvalidPublicBaseUrl &&
        typeof value === 'string' &&
        value.trim() &&
        !normalizePublicBaseUrl(value)
    ) {
        warnedInvalidPublicBaseUrl = true;
        console.warn(
            '[ConfigService] Invalid PUBLIC_BASE_URL: the saved value cannot be used. Open Settings → Access and re-save Public Base URL as an http/https URL without credentials.',
        );
    }
}

/**
 * Initialize the config service SYNCHRONOUSLY.
 * Used at module load time by config.ts.
 * Only uses process.env (not SvelteKit's env which is async).
 */
export function initConfigServiceSync(rawEnv: Record<string, string | undefined>): ConfigState {
    const env = withRenamedKeys(withoutMirroredEnv(rawEnv));
    // 1. Start with schema defaults (CPU-budget-aware where a setting opts in;
    //    JSON + ENV applied below still override these).
    const values = getDefaultValues(defaultResolutionContext());
    const envOverrides = new Set<string>();
    const jsonOverrides = new Set<string>();
    const ignoredEnvOnly = new Map<string, unknown>();

    // 2. Load from JSON file (if exists) - SYNC
    const jsonValues = loadJsonConfigSync();
    if (jsonValues) {
        for (const [key, value] of Object.entries(withRenamedKeys(jsonValues))) {
            const setting = configSchema.find((s) => s.key === key);
            if (setting?.envOnlyEnforced) {
                ignoredEnvOnly.set(key, value);
                continue;
            }
            if (setting) {
                const validation = validateSettingValue(setting, value);
                if (validation.valid) {
                    values[key] = value;
                    jsonOverrides.add(key);
                } else {
                    console.warn(`[ConfigService] Invalid value for ${key}: ${validation.error}`);
                }
            }
        }
    }

    // 3. Apply ENV overrides (highest priority)
    for (const setting of configSchema) {
        const envValue = env[setting.key];
        if (envValue !== undefined && envValue !== '') {
            const parsed = parseEnvValue(envValue, setting);
            if (parsed !== undefined && isValidEnvValue(setting, parsed)) {
                values[setting.key] = parsed;
                envOverrides.add(setting.key);
            }
        }
    }

    logIgnoredEnvOnlyJsonValues(ignoredEnvOnly, values, envOverrides);
    warnInvalidPublicBaseUrl(values.PUBLIC_BASE_URL);

    configState = {
        values,
        envOverrides,
        jsonOverrides,
        loadedAt: new Date(),
    };

    mirrorToProcessEnv(Object.keys(values), values, envOverrides);
    snapshotRestartValues(values);
    notifyConfigChange(null);

    console.log('[ConfigService] Initialized successfully', {
        configPath: getConfigFilePath(),
        totalKeys: Object.keys(values).length,
        jsonOverrides: jsonOverrides.size,
        envOverrides: envOverrides.size,
        hasSidebarLinks: 'SIDEBAR_LINKS' in values,
        sidebarLinksCount: Array.isArray(values.SIDEBAR_LINKS) ? values.SIDEBAR_LINKS.length : 0,
    });

    return configState;
}

/**
 * Initialize the config service by loading values from all sources (ASYNC version).
 * Can be called for hot reload or if SvelteKit env is needed.
 */
export async function initConfigService(): Promise<ConfigState> {
    // 1. Start with schema defaults (CPU-budget-aware where a setting opts in;
    //    JSON + ENV applied below still override these).
    const values = getDefaultValues(defaultResolutionContext());
    const envOverrides = new Set<string>();
    const jsonOverrides = new Set<string>();
    const ignoredEnvOnly = new Map<string, unknown>();

    // 2. Load from JSON file (if exists)
    const jsonValues = await loadJsonConfig();
    if (jsonValues) {
        for (const [key, value] of Object.entries(withRenamedKeys(jsonValues))) {
            // Only apply if key exists in schema
            const setting = configSchema.find((s) => s.key === key);
            if (setting?.envOnlyEnforced) {
                ignoredEnvOnly.set(key, value);
                continue;
            }
            if (setting) {
                const validation = validateSettingValue(setting, value);
                if (validation.valid) {
                    values[key] = value;
                    jsonOverrides.add(key);
                } else {
                    console.warn(`[ConfigService] Invalid value for ${key}: ${validation.error}`);
                }
            }
        }
    }

    // 3. Apply ENV overrides (highest priority) — the operator's variables,
    //    not the copies mirrorToProcessEnv() made on an earlier load.
    const env = withRenamedKeys(withoutMirroredEnv(await getEnvVariables()));
    for (const setting of configSchema) {
        const envValue = env[setting.key];
        if (envValue !== undefined && envValue !== '') {
            const parsed = parseEnvValue(envValue, setting);
            if (parsed !== undefined && isValidEnvValue(setting, parsed)) {
                values[setting.key] = parsed;
                envOverrides.add(setting.key);
            }
        }
    }

    logIgnoredEnvOnlyJsonValues(ignoredEnvOnly, values, envOverrides);
    warnInvalidPublicBaseUrl(values.PUBLIC_BASE_URL);

    configState = {
        values,
        envOverrides,
        jsonOverrides,
        loadedAt: new Date(),
    };

    mirrorToProcessEnv(Object.keys(values), values, envOverrides);
    snapshotRestartValues(values);
    notifyConfigChange(null);

    return configState;
}

/**
 * Get a single config value by key
 */
export function get<T = unknown>(key: string): T {
    if (!configState) {
        throw new Error('[ConfigService] Not initialized. Call initConfigService() first.');
    }
    return configState.values[key] as T;
}

/**
 * Get all config values
 */
export function getAll(): ConfigValues {
    if (!configState) {
        throw new Error('[ConfigService] Not initialized. Call initConfigService() first.');
    }
    return { ...configState.values };
}

/**
 * Check if a key is overridden by ENV (locked)
 */
export function isEnvOverridden(key: string): boolean {
    if (!configState) {
        return false;
    }
    return configState.envOverrides.has(key);
}

/**
 * Get all ENV overridden keys
 */
export function getEnvOverriddenKeys(): string[] {
    if (!configState) {
        return [];
    }
    return Array.from(configState.envOverrides);
}

/**
 * Get the current config state
 */
export function getConfigState(): ConfigState | null {
    return configState;
}

/**
 * Get schema for UI generation
 */
export function getSchema(): {
    sections: SectionDefinition[];
    settings: SettingDefinition[];
} {
    return {
        sections: configSections.sort((a, b) => a.order - b.order),
        settings: configSchema,
    };
}

// Serializes saveConfig calls within this process. Because saveConfig now seeds
// from the existing file (read-modify-write), two concurrent calls could
// otherwise interleave and clobber each other's keys. A simple promise-chain
// mutex ensures one save completes its read+write before the next starts.
let configWriteLock: Promise<unknown> = Promise.resolve();

/**
 * Save config values to JSON file.
 * Additive: preserves previously-saved keys (seeds from the existing file).
 * Only writes values that differ from defaults; reverting to a default removes
 * the key. ENV-overridden keys are NOT persisted to file — ENV always wins at
 * runtime, so baking the current ENV snapshot into settings.json would strand a
 * stale value if the operator later removes the ENV var. Calls are serialized to
 * avoid read-modify-write races.
 */
export interface SaveConfigOptions {
    /**
     * Write these keys to settings.json even though an environment variable
     * owns them ("Save to config" on an ENV-locked setting). The environment
     * still wins at runtime, so in-memory values are untouched; the file copy
     * is what remains once the operator removes the variable.
     */
    persistEnvOverridden?: boolean;
    /**
     * Keep these keys in settings.json even when the value equals today's
     * default. For explicit choices made on the caller's own terms (the
     * instance profile's requested values, the setup wizard's answers): a
     * value dropped for matching the default would silently follow a later
     * release that changes that default, and the choice would be lost.
     * Without it, saving the default value means "follow the default".
     */
    pinKeys?: readonly string[];
    /**
     * Compare-and-swap: refuse the save with `ConfigConflictError` unless
     * `test` accepts the value settings.json holds for `key` right now. Checked
     * under the write lock against the file, not this process's memory, so it
     * also holds across replicas sharing the file.
     */
    expect?: { key: string; test: (fileValue: unknown) => boolean };
}

export async function saveConfig(
    updates: ConfigValues,
    options: SaveConfigOptions = {},
): Promise<void> {
    const prev = configWriteLock;
    let release!: () => void;
    configWriteLock = new Promise<void>((resolve) => (release = resolve));
    await prev.catch(() => {});
    try {
        await doSaveConfig(updates, options);
    } finally {
        release();
    }
}

async function doSaveConfig(updates: ConfigValues, options: SaveConfigOptions): Promise<void> {
    if (!configState) {
        throw new Error('[ConfigService] Not initialized. Call initConfigService() first.');
    }

    // Snapshot the pre-save language list BEFORE any mutation below — used
    // by the metadata-translations-seed trigger near the end of this
    // function to detect newly-ADDED languages only (not just "the key was
    // touched"), so an unrelated re-save of the same list doesn't re-enqueue
    // a whole-catalog backfill.
    //
    // Normalized through `normalizedLanguageSet` (not a bare `Array.isArray`
    // check) because the admin UI's ArrayInput always submits array settings
    // as a COMMA-SEPARATED STRING (parsing happens only at config-read time
    // via `getConfig('array')`) — an `Array.isArray` guard on either side of
    // this diff was always false for a real UI save, so the seed task never
    // fired from the Settings page. Normalizing both sides also means a
    // casing-only edit (`pt-br` → `pt-BR`) is NOT treated as a new language.
    //
    // Both diff sides are additionally filtered against the primary language
    // (see `normalizedLanguageSet`'s doc), so a primary-equal entry ('en'
    // under TMDB_LANGUAGE='en-US') can never register as an "added" language
    // — the runtime getter drops it, so no backfill work exists for it.
    // Primary resolution: the value this SAVE establishes (`updates`) wins
    // over the current state; `configState.values` always contains
    // TMDB_LANGUAGE (schema default 'en-US' is seeded at init, env
    // overrides applied on top), so the ?? chain is belt-and-braces. One
    // primary is used for BOTH sides deliberately: the diff asks "does the
    // set gain a language under the configuration being saved", and
    // filtering the prev side with an older primary would make a
    // simultaneous primary+additional change double-count. (A save that
    // changes ONLY TMDB_LANGUAGE never enters the hook below — languages
    // that become newly effective that way are picked up by the daily seed
    // schedule for new/missing items, as before.)
    const rawPrimaryForDiff =
        updates['TMDB_LANGUAGE'] ?? configState.values['TMDB_LANGUAGE'] ?? 'en-US';
    const primaryForDiff = typeof rawPrimaryForDiff === 'string' ? rawPrimaryForDiff : 'en-US';
    const prevMetadataLanguages: string[] = normalizedLanguageSet(
        configState.values['METADATA_ADDITIONAL_LANGUAGES'],
        primaryForDiff,
    );

    // Validate all values first (including ENV-overridden ones)
    for (const [key, value] of Object.entries(updates)) {
        const setting = configSchema.find((s) => s.key === key);
        if (!setting) {
            throw new Error(`Unknown setting: ${key}`);
        }
        // The settings page posts every value it loaded, so the value in effect
        // passes (and is never written below); a different one is refused.
        if (setting.envOnlyEnforced && !valueEqualsDefault(value, configState.values[key])) {
            throw new Error(`${key} can only be set as an environment variable`);
        }

        // The browser only ever sees a stored secret as this placeholder. A
        // writer that posts it back (any caller but the settings form action,
        // which already skips it) would otherwise store the literal placeholder
        // and silently destroy the real secret.
        if (isSensitiveKey(key) && isSecretSentinel(value)) {
            throw new Error(`${key}: the stored-secret placeholder cannot be saved as a value`);
        }

        const validation = validateSettingValue(setting, value);
        if (!validation.valid) {
            throw new Error(`Invalid value for ${key}: ${validation.error}`);
        }
        // Format rules gate only CHANGED values: the settings page posts every
        // value it loaded, and a legacy value that predates a rule must not
        // block saving an unrelated setting.
        if (
            value !== configState.values[key] &&
            !(setting.validation?.languageTag && isEnvOverridden(key))
        ) {
            const format = validateSettingFormat(setting, value);
            if (!format.valid) {
                throw new Error(`Invalid value for ${key}: ${format.error}`);
            }
        }
    }

    if (typeof updates.PUBLIC_BASE_URL === 'string') {
        const normalized = normalizePublicBaseUrl(updates.PUBLIC_BASE_URL);
        if (normalized || updates.PUBLIC_BASE_URL === '') {
            updates = { ...updates, PUBLIC_BASE_URL: normalized };
        }
    }

    // Build JSON content ADDITIVELY. saveConfig is frequently called with a
    // SINGLE key (license key, TMDB key, native-login flag, image settings); if
    // we wrote only this call's keys we'd clobber every other previously-saved
    // setting in the file. So we seed from the existing file content first, then
    // overlay this call's updates. Setting a value back to its default removes
    // the key (so it reverts to the default/env).
    // Use the SAME CPU-budget-aware context as seeding so "revert to default"
    // (drop the key) matches the value the runtime would fall back to.
    const defaults = getDefaultValues(defaultResolutionContext());
    const jsonContent: ConfigValues = {};

    // Seed from the currently-persisted file. Already-encrypted sensitive values
    // pass through verbatim (we don't decrypt+re-encrypt untouched secrets).
    const filePath = getConfigFilePath();
    if (existsSync(filePath)) {
        try {
            const existing: unknown = JSON.parse(readFileSync(filePath, 'utf-8'));
            if (isRecord(existing)) {
                for (const [k, v] of Object.entries(existing)) {
                    jsonContent[k] = v as ConfigValues[string];
                }
            }
        } catch (error) {
            // Writing just this call's keys over an unreadable file would wipe
            // every other saved setting and secret in it. Refuse instead.
            throw new ConfigFileUnreadableError(filePath, error);
        }
    }
    if (options.expect && !options.expect.test(jsonContent[options.expect.key])) {
        throw new ConfigConflictError(options.expect.key);
    }

    // A plugin-isolation worker holds no master key, so it can neither seal a
    // secret correctly nor may it fall back to plaintext. Refuse before writing
    // anything (B1: whatever a worker sealed landed under a second,
    // worker-generated key that the main process could not open).
    if (isIsolationWorker()) {
        const sensitive = Object.entries(updates)
            .filter(
                ([key, value]) => typeof value === 'string' && value !== '' && isSensitiveKey(key),
            )
            .map(([key]) => key);
        if (sensitive.length > 0) {
            throw new IsolationWorkerKeyAccessError(
                `Saving sensitive setting(s) ${sensitive.join(', ')}`,
            );
        }
    }

    const masterKey = getConfigMasterKey();
    for (const [key, value] of Object.entries(updates)) {
        // Never persist ENV-overridden keys to the file. ENV always wins at
        // runtime, so baking the *current* ENV snapshot into settings.json would
        // leave a stale value behind if the operator later removes the ENV var —
        // contradicting the UI promise that ENV takes priority. We also leave any
        // pre-existing file value for this key untouched (don't delete it) so we
        // don't silently mutate the persisted state of an ENV-shadowed key.
        if (configState.envOverrides.has(key) && !options.persistEnvOverridden) {
            continue;
        }
        // Env-only keys are never written, not even by persistEnvOverridden.
        const settingDef = configSchema.find((s) => s.key === key);
        if (settingDef?.envOnlyEnforced) continue;
        // Reverting to the default → drop the key so it falls back to default/env.
        // Use structural equality so object/array settings (navigation, widgets,
        // arrays) compare by content, not by reference — getDefaultValues()
        // returns fresh instances each call, so reference equality would never
        // match for non-primitives and the key would be rewritten verbatim.
        //
        // EXCEPTION: settings with a `dynamicDefault` (e.g. CPU-budget-aware task
        // concurrency) are ALWAYS persisted when explicitly saved, never dropped.
        // Their default is per-process (it depends on this node's detected CPU
        // budget), so dropping a value that merely equals THIS node's auto value
        // would let a sibling node with a different cap recompute a different
        // default for the same shared settings.json — and an explicit admin choice
        // that happened to match today's auto value would silently drift if the
        // budget later changed. Persisting keeps the explicit value authoritative
        // and identical across the cluster. (To go back to auto, clear the key.)
        if (
            !settingDef?.dynamicDefault &&
            !options.pinKeys?.includes(key) &&
            valueEqualsDefault(value, defaults[key])
        ) {
            delete jsonContent[key];
            continue;
        }
        // Encrypt sensitive settings (service API keys, etc.) at rest
        // (F66 / Sec MED-8). Non-empty string secrets become AES-256-GCM
        // envelopes; everything else is stored verbatim. Without a master
        // key we fall back to plaintext (with a warning) so installs that
        // never configured LUMASTRA_MASTER_KEY keep working.
        if (typeof value === 'string' && value !== '' && isSensitiveKey(key)) {
            if (masterKey) {
                jsonContent[key] = sealSecret(value, masterKey, configSecretContext(key));
            } else {
                console.warn(
                    `[ConfigService] Storing ${key} in plaintext — set LUMASTRA_MASTER_KEY to encrypt sensitive settings at rest.`,
                );
                jsonContent[key] = value;
            }
        } else {
            jsonContent[key] = value;
        }
    }

    // Ensure directory exists
    const dir = dirname(getConfigFilePath());
    if (!existsSync(dir)) {
        await mkdir(dir, { recursive: true });
    }

    // Write file
    await writeConfigFileAtomic(getConfigFilePath(), JSON.stringify(jsonContent, null, 2) + '\n');

    // A successful re-entry (or clearing) repairs this setting immediately.
    // Keep faults for untouched/ENV-skipped envelopes; do not wait for the
    // config-change subscriber or a restart to clear the attention warning.
    undecryptableConfigKeys = undecryptableConfigKeys.filter((key) => {
        const value = jsonContent[key];
        if (typeof value !== 'string' || !isSealed(value)) return false;
        if (!masterKey) return true;
        try {
            openSecret(value, masterKey, configSecretContext(key));
            return false;
        } catch {
            return true;
        }
    });

    // What the file now holds — the admin UI reads this to tell an ENV-locked
    // setting that is ALSO saved in settings.json from one that is not.
    configState.jsonOverrides = new Set(Object.keys(jsonContent));

    // Same reason as in rotateConfigSecrets: what we just wrote is now the
    // truth about which settings still carry an unbound envelope.
    recordLegacyEnvelopes(jsonContent);

    // Update in-memory state (but not for ENV-overridden keys - ENV still wins at runtime)
    for (const [key, value] of Object.entries(updates)) {
        if (!configState.envOverrides.has(key)) {
            configState.values[key] = value;
        }
    }

    mirrorToProcessEnv(Object.keys(updates), configState.values, configState.envOverrides);

    configState.loadedAt = new Date();

    // Cross-replica invalidation: this save only mutated THIS node's in-memory
    // configState. Other replicas keep serving their stale snapshot until they
    // independently reload. Fire-and-forget a notification on a shared Valkey
    // channel so a subscriber (wired at process startup, outside this module)
    // can call reloadConfig() and re-read the shared settings.json. Publishing
    // is best-effort and never blocks or fails the save.
    void publishConfigChanged(Object.keys(updates));

    // The Jellyfin API client memoizes its connection at first use, so changing
    // the URL/API key needs an explicit client reset to take effect without a
    // process restart (admin Settings save AND the first-run setup wizard both
    // land here). Dynamic import to avoid a static config↔jellyfin-client cycle.
    // Runs BEFORE the change notification: the Jellyfin connection lifecycle
    // (jellyfin/connection-lifecycle.ts) verifies the new settings from that
    // notification, and a reset after it would swap the client mid-check.
    if ('JELLYFINURL' in updates || 'JELLYFINAPIKEY' in updates) {
        try {
            const { resetJellyfinApi } = await import('$lib/server/jellyfin/base-client.js');
            resetJellyfinApi();
        } catch (err) {
            console.warn(
                '[ConfigService] Failed to reset Jellyfin API client after config save',
                err,
            );
        }
    }

    if ('IMAGE_CANDIDATE_PROVIDER_ORDER' in updates || 'EPISODE_THUMBNAIL_PREFERENCE' in updates) {
        const { getDb } = await import('$lib/server/database/connection.js');
        const sql = getDb();
        if (sql) {
            const { syncImageSelectionPolicy } =
                await import('$lib/server/services/image-candidates.service.js');
            await syncImageSelectionPolicy(sql);
        }
    }
    notifyConfigChange(Object.keys(updates));

    // Saving METADATA_ADDITIONAL_LANGUAGES with newly-added entries triggers
    // a one-shot backfill (Task 6 of the multilingual-metadata feature):
    // enqueue metadata-translations-seed with `reEnroll: true` — the
    // add-a-language-later path, which ADDITIONALLY re-enrolls completed
    // stage rows so already-translated items re-fetch the new language (the
    // scheduled 24h run deliberately never re-enrolls; this hook is the only
    // automatic trigger that does).
    // Diffed against the PRE-save snapshot (not just presence-checked like
    // the Jellyfin block above) so re-saving the same list — or removing a
    // language — doesn't re-trigger a whole-catalog backfill; the daily
    // `metadata-translations-seed` schedule is the fallback for installs
    // where this hook doesn't fire (e.g. a direct settings.json edit),
    // covering new/missing items only.
    // Dynamic import to avoid a static config↔tasks module cycle, same
    // rationale as the Jellyfin reset above. Fire-and-forget WITH .catch():
    // this function holds the config write mutex (saveConfig's
    // configWriteLock), so awaiting the task system here would let a hung
    // Valkey/queue dependency block — and serialize — every subsequent
    // settings save behind it.
    if ('METADATA_ADDITIONAL_LANGUAGES' in updates) {
        // Same normalization AND primary-exclusion as the pre-save snapshot
        // above (same `primaryForDiff`) — see those comments for why a bare
        // `Array.isArray` check never fired against a real admin-UI save
        // (ArrayInput submits a comma-separated string) and why
        // primary-equal entries must not count as additions.
        const nextMetadataLanguages: string[] = normalizedLanguageSet(
            updates['METADATA_ADDITIONAL_LANGUAGES'],
            primaryForDiff,
        );
        const addedLanguages = nextMetadataLanguages.filter(
            (lang) => !prevMetadataLanguages.includes(lang),
        );
        if (addedLanguages.length > 0) {
            void import('$lib/server/tasks/orchestrator.js')
                .then(({ orchestrator }) =>
                    orchestrator.startRun(
                        'metadata-translations-seed',
                        { reEnroll: true },
                        { trigger: { kind: 'in-process', sourceRoute: 'config.service' } },
                    ),
                )
                .then((result) => {
                    // A concurrent/in-flight run absorbed this trigger — the
                    // accepted race is otherwise invisible (startRun resolves
                    // successfully either way). Surface it so an operator
                    // debugging "the new language never backfilled" has a
                    // breadcrumb.
                    if (result?.deduped) {
                        console.warn(
                            '[ConfigService] metadata-translations-seed run was deduped after language change (an equivalent run was already in-flight)',
                            { addedLanguages, existingRunId: result.existingRunId },
                        );
                    }
                })
                .catch((err: unknown) => {
                    console.warn(
                        '[ConfigService] Failed to enqueue metadata-translations-seed after language change',
                        err,
                    );
                });
        }
    }
}

/**
 * Reload config from file (hot reload)
 */
export async function reloadConfig(): Promise<ConfigState> {
    return initConfigService();
}

/**
 * Get config for client-side (safe subset)
 * Returns values + metadata for admin UI
 */
export function getConfigForAdmin(): {
    values: ConfigValues;
    envOverrides: string[];
    /** Keys present in settings.json. */
    fileKeys: string[];
    schema: { sections: SectionDefinition[]; settings: SettingDefinition[] };
} {
    if (!configState) {
        throw new Error('[ConfigService] Not initialized. Call initConfigService() first.');
    }

    // Overlay the effective (CPU-budget-aware) default onto settings that resolve
    // it dynamically, so the admin UI shows the real default and does not flag an
    // auto-sized value as "modified". Strip the (non-serialisable) resolver fn.
    const ctx = defaultResolutionContext();
    const base = getSchema();
    const settings = base.settings.map((setting) => {
        if (!setting.dynamicDefault) return setting;
        const { dynamicDefault, ...rest } = setting;
        return { ...rest, defaultValue: dynamicDefault(ctx) };
    });

    return {
        values: { ...configState.values },
        envOverrides: Array.from(configState.envOverrides),
        fileKeys: Array.from(configState.jsonOverrides),
        schema: { sections: base.sections, settings },
    };
}

// ============================================================================
// Internal Helpers
// ============================================================================

/**
 * Decide whether a setting value equals its schema default.
 *
 * Primitives (string/number/boolean/null/undefined) compare with strict
 * equality. Objects and arrays (navigation, widgets, array settings) compare
 * structurally via JSON serialization because getDefaultValues() returns fresh
 * instances on every call — reference equality would never match for those
 * types, so "reset to default removes the key" would never fire and the value
 * would be rewritten verbatim on every save.
 */
function valueEqualsDefault(value: unknown, defaultValue: unknown): boolean {
    if (value === defaultValue) {
        return true;
    }
    // Only attempt structural comparison when both sides are non-null objects
    // (covers arrays and plain objects); otherwise the strict check above is
    // authoritative.
    if (
        typeof value === 'object' &&
        value !== null &&
        typeof defaultValue === 'object' &&
        defaultValue !== null
    ) {
        try {
            return JSON.stringify(value) === JSON.stringify(defaultValue);
        } catch {
            // Non-serializable (cycles, etc.) — fall through to "not equal".
            return false;
        }
    }
    return false;
}

/**
 * Fire-and-forget publish on the cross-replica config-changed channel.
 *
 * Mirrors the existing pipeline pub/sub pattern (PUBLISH via Valkey). Errors
 * are swallowed with a warning — a publish failure must never block or fail a
 * config save. Dynamic import avoids a static config↔valkey module cycle at
 * load time. NOTE: this only emits the event; the subscriber that calls
 * reloadConfig() must be wired separately at process startup.
 */
async function publishConfigChanged(keys: string[]): Promise<void> {
    try {
        // The task (coordination) Valkey, where subscribeToChannel listens:
        // a config save must reach the worker even with the cache down/unset.
        const { getCoordinationClient } = await import('$lib/server/cache/valkey.js');
        const client = getCoordinationClient();
        if (!client) return;
        const c = client as unknown as { customCommand: (cmd: string[]) => Promise<unknown> };
        await c.customCommand(['PUBLISH', CONFIG_CHANGED_CHANNEL, JSON.stringify(keys)]);
    } catch (err) {
        console.warn('[ConfigService] Failed to publish config-changed event', err);
    }
}

/** Process-lifetime unsubscribe handle for the config-changed subscription. */
let configChangeUnsub: (() => Promise<void>) | null = null;

/**
 * Subscribe this replica to cross-replica config-change notifications.
 *
 * When any replica saves config, doSaveConfig() PUBLISHes on
 * CONFIG_CHANGED_CHANNEL (see publishConfigChanged). Every replica that has
 * called this picks the event up and re-reads the shared config file via
 * reloadConfig(), so a post-save page load on another node serves fresh values
 * instead of stale in-memory config. This closes the subscriber side of the
 * cross-replica invalidation noted in publishConfigChanged.
 *
 * Idempotent and best-effort: a second call is a no-op, and a subscribe
 * failure is logged without throwing (config still works single-node). Wire
 * this once per process at startup. reloadConfig() is idempotent, so the
 * publishing node reacting to its own event simply re-derives the same state.
 */
export async function startConfigChangeSubscriber(): Promise<void> {
    if (configChangeUnsub) return;
    try {
        const { subscribeToChannel } = await import('$lib/server/cache/valkey.js');
        configChangeUnsub = await subscribeToChannel(CONFIG_CHANGED_CHANNEL, (message) => {
            void reloadConfig()
                .then(() => {
                    console.info('[ConfigService] Reloaded config after cross-replica change', {
                        keys: message,
                    });
                })
                .catch((err) => {
                    console.warn('[ConfigService] Failed to reload config on change event', err);
                });
        });
    } catch (err) {
        console.warn('[ConfigService] Failed to subscribe to config-changed channel', err);
    }
}

/**
 * Load JSON config file (async)
 */
async function loadJsonConfig(): Promise<ConfigValues | null> {
    if (!existsSync(getConfigFilePath())) {
        return null;
    }

    let parsed: unknown;
    try {
        const content = await readFile(getConfigFilePath(), 'utf-8');
        parsed = JSON.parse(content);
    } catch (error) {
        console.error(`[ConfigService] Failed to load config file: ${error}`);
        // A RELOAD must not swap a running process onto bare defaults (every
        // saved setting and secret gone, "reloaded" reported as success). Keep
        // the state already loaded; only a first load starts from defaults.
        if (configState) throw new ConfigFileUnreadableError(getConfigFilePath(), error);
        return null;
    }
    return isRecord(parsed) ? decryptLoadedConfig(parsed as ConfigValues) : null;
}

/**
 * Load JSON config file (sync - for initialization)
 */
function loadJsonConfigSync(): ConfigValues | null {
    if (!existsSync(getConfigFilePath())) {
        return null;
    }

    let parsed: unknown;
    try {
        const content = readFileSync(getConfigFilePath(), 'utf-8');
        parsed = JSON.parse(content);
    } catch (error) {
        console.error(`[ConfigService] Failed to load config file: ${error}`);
        return null;
    }
    return isRecord(parsed) ? decryptLoadedConfig(parsed as ConfigValues) : null;
}

/**
 * Get environment variables (SvelteKit or process.env fallback)
 */
async function getEnvVariables(): Promise<Record<string, string | undefined>> {
    try {
        type EnvModule = { env: Record<string, string | undefined> };
        const svelteEnv = (await import('$env/dynamic/private')) as EnvModule;
        return svelteEnv.env;
    } catch {
        // Fallback for standalone scripts
        return process.env as Record<string, string | undefined>;
    }
}

/**
 * Run an env-sourced number through the same schema validation settings.json
 * values get. An invalid env value is ignored the way an invalid JSON value
 * is: warn and keep the lower layer (JSON, else the schema default), so e.g.
 * `*_RETENTION_DAYS=0` can never prune everything. The key is then NOT
 * reported as env-overridden, because the env value is not in effect.
 */
function isValidEnvValue(setting: SettingDefinition, value: unknown): boolean {
    if (setting.type !== 'number') return true;
    const validation = validateSettingValue(setting, value);
    if (validation.valid) return true;
    console.warn(
        `[ConfigService] Ignoring invalid environment value for ${setting.key}: ${validation.error}`,
    );
    return false;
}

/**
 * Parse an ENV value to the correct type based on setting definition
 */
function parseEnvValue(value: string, setting: SettingDefinition): unknown {
    switch (setting.type) {
        case 'boolean':
            return value.toLowerCase() === 'true' || value === '1';

        case 'number': {
            const num = Number.parseFloat(value);
            return Number.isNaN(num) ? undefined : num;
        }

        case 'array':
            // Comma-separated string to array
            return value
                .split(',')
                .map((s) => s.trim())
                .filter(Boolean);

        case 'navigation':
            // JSON array of objects for navigation config
            try {
                const parsed: unknown = JSON.parse(value);
                return Array.isArray(parsed) ? parsed : [];
            } catch {
                console.warn(`[ConfigService] Failed to parse navigation JSON for ${setting.key}`);
                return [];
            }

        case 'widgets':
            // JSON object/array for complex widget configuration
            try {
                const parsed: unknown = JSON.parse(value);
                return parsed;
            } catch {
                console.warn(`[ConfigService] Failed to parse widgets JSON for ${setting.key}`);
                return setting.defaultValue;
            }

        case 'select':
            // Validate against options
            if (setting.validation?.options) {
                const validValues = setting.validation.options.map((o) => String(o.value));
                if (validValues.includes(value)) {
                    return value;
                }
            }
            return value;

        default:
            return value;
    }
}

/**
 * Mirror config values into process.env so external code paths that read
 * env vars directly (notably external plugins loaded as plain .js files,
 * which can't import the SvelteKit ConfigService) see UI-saved values.
 *
 * Skips keys that came from the real env to preserve operator intent: if
 * docker-compose sets MAL_CLIENT_ID, that value wins over a UI override.
 */
function mirrorToProcessEnv(
    keys: Iterable<string>,
    values: ConfigValues,
    envOverrides: Set<string>,
): void {
    for (const key of keys) {
        if (envOverrides.has(key)) continue;
        const setting = configSchema.find((s) => s.key === key);
        if (!setting) continue;
        // Skip complex types — JSON-stringified blobs in process.env are noise
        // and aren't readable by external plugins as env vars anyway.
        if (setting.type === 'navigation' || setting.type === 'widgets') continue;
        const value = values[key];
        if (value === undefined || value === null || value === '') {
            delete process.env[key];
            mirroredEnv.delete(key);
            continue;
        }
        const envString = valueToEnvString(value, setting);
        process.env[key] = envString;
        mirroredEnv.set(key, envString);
    }
}

/**
 * Convert a value back to ENV string format
 */
export function valueToEnvString(value: unknown, setting: SettingDefinition): string {
    if (value === undefined || value === null) {
        return '';
    }

    switch (setting.type) {
        case 'boolean':
            return value ? 'true' : 'false';

        case 'array':
            if (Array.isArray(value)) {
                return value.join(',');
            }
            return String(value);

        case 'navigation':
            // Navigation arrays are stored as JSON
            if (Array.isArray(value)) {
                return JSON.stringify(value);
            }
            return '[]';

        case 'widgets':
            // Complex widget configs are stored as JSON
            return JSON.stringify(value);

        default:
            return String(value);
    }
}
