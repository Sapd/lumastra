// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { normalizePublicBaseUrl } from '$lib/shared/public-base-url.js';
import { parseWorkerMode, resolveTaskProcessRole, type WorkerMode } from './task-role.js';

// Use process.env directly — works in both SvelteKit runtime and standalone scripts.
// In adapter-node, $env/dynamic/private just proxies process.env anyway, and using
// top-level awaits to import it causes circular dependency deadlocks with Rolldown (Vite 8).
const env: Record<string, string | undefined> = { ...process.env };
export const dev: boolean = process.env.NODE_ENV !== 'production';

// Whether in-development ("dev only") features and settings are exposed. True on
// local dev (NODE_ENV !== 'production') OR when ALLOW_DEV_FEATURES is explicitly
// enabled on a non-prod deployment (e.g. preprod). Production leaves it unset, so
// such features are force-disabled AND hidden from the admin UI there.
//
// Read straight from the environment — NOT via ConfigService — so the gate itself
// can never be flipped on through stored admin config in production.
export const devFeaturesEnabled: boolean = dev || parseBoolEnv(process.env.ALLOW_DEV_FEATURES);

// Enterprise/showcase training surfaces are only exposed in enterprise builds.
// This is deliberately build-time, not an admin/env setting, so standard builds
// do not advertise enterprise-only configuration that is not meant for them.
export const enterpriseFeaturesBuildEnabled: boolean = false;

// License-enforcement gate. OFF: Lumastra is AGPL-3.0 with no paid parts, so an
// install with no key (or any key) gets every feature: unlimited /j streams, the
// AI assistant, operator branding. The gate machinery (entitlements registry,
// licence module) is being removed step by step; this constant is the switch it
// hangs off until it is gone. Guard: licensing/free-install.guard.test.ts.
export const LICENSE_ENFORCEMENT_BUILD_DEFAULT: boolean = false;

// ============================================================================
// Config Service Integration
// ============================================================================
// Initialize the config service FIRST so we can read merged values (JSON + ENV)
// This ensures settings from the admin UI (settings.json) are respected.

import * as crypto from 'node:crypto';
import { initConfigServiceSync, get as configServiceGet, onConfigChange } from './config/index.js';
import { deriveSubSecret } from './crypto/secret-box.js';
import { resolveMasterKey } from './crypto/master-key.js';
import { isIsolationWorker } from './tasks/isolation/isolation-context.js';
import { Logger } from './utils/logger.js';
import {
    cpuClassConcurrencyDefault,
    ioClassConcurrencyDefault,
    outboxDrainConcurrencyDefault,
    musicTranscodeConcurrencyDefault,
    musicTranscodePerUserDefault,
    videoTranscodeConcurrencyDefault,
} from '$lib/config/schema.js';
import { getCpuBudgetCores } from './utils/cpu-budget.js';
import { isPlaceholderValue, noteIgnoredPlaceholder } from './utils/config-placeholders.js';
import { isCorsOrigin } from '$lib/shared/cors-origins.js';
import { normalizeLanguageTag, isPrimaryLanguageTag } from '$lib/shared/metadata-language.js';
import { deriveBuildInfo, type BuildInfo } from './build-info.js';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

// Default JWT signing secret derived deterministically from the master key when
// JWT_SECRET is not explicitly set. Computed once and cached. resolveMasterKey()
// returns the explicit env key, the file-backed key, or an auto-generated one, so
// the derived secret is the same on every replica and across restarts (tokens
// stay valid). Empty only when no master key can be resolved or written.
let _derivedJwtSecret: string | null = null;
function derivedJwtSecret(): string {
    // A plugin-isolation worker holds no master key (security boundary), so it
    // cannot derive the default secret — and it must not throw here either:
    // this module's own startup check reads `config.JWT_SECRET` while it loads,
    // so a throw failed EVERY isolated task at import (B1 follow-up). Report
    // "not configured" instead; every signing consumer (signed-url,
    // stream-token, oauth/jwt, music-transcode token) fails closed on ''. An
    // operator-set JWT_SECRET env is unaffected (the getter returns it first).
    if (isIsolationWorker()) return '';
    // Only memoize a NON-EMPTY secret: if the master key isn't resolvable yet
    // (transient), recompute on the next call rather than locking in an empty
    // secret for the process lifetime (which would diverge from a sibling replica
    // that did resolve the key).
    if (_derivedJwtSecret) return _derivedJwtSecret;
    const derived = deriveSubSecret(resolveMasterKey(), 'lumastra-jwt-secret-v1');
    if (derived) _derivedJwtSecret = derived;
    return derived;
}

let configServiceReady = false;

try {
    initConfigServiceSync(env);
    configServiceReady = true;
} catch {
    // ConfigService initialization failed - this is expected when running
    // standalone scripts (migrations) outside SvelteKit context.
    // Fall back to env-only config below.
}

/**
 * Example names are fictional; production shapes and measurements are retained.
 * Get a config value with priority: ConfigService (JSON + ENV) > ENV > default
 * The ConfigService already handles ENV > JSON > schema defaults internally.
 * Type-aware helper with overloads for type safety.
 */
function getConfig(
    type: 'string',
    key: string,
    envFallback: string | undefined,
    defaultValue: string,
): string;
// eslint-disable-next-line no-redeclare
function getConfig(
    type: 'boolean',
    key: string,
    envFallback: string | undefined,
    defaultValue: boolean,
): boolean;
// eslint-disable-next-line no-redeclare
function getConfig(
    type: 'number' | 'float',
    key: string,
    envFallback: string | undefined,
    defaultValue: number,
): number;
// eslint-disable-next-line no-redeclare
function getConfig(
    type: 'array',
    key: string,
    envFallback: string | undefined,
    defaultValue: string,
): string[];
// eslint-disable-next-line no-redeclare
function getConfig(
    type: 'string' | 'boolean' | 'number' | 'float' | 'array',
    key: string,
    envFallback: string | undefined,
    defaultValue: string | boolean | number,
): string | boolean | number | string[] {
    // Three-step precedence: ConfigService (live) -> env var -> default value
    if (configServiceReady) {
        const val = configServiceGet(key);
        if (val !== undefined && val !== null) {
            if (type === 'array') {
                if (Array.isArray(val)) return val as string[];
                if (typeof val === 'string') return parseList(val, defaultValue as string);
            }
            return val as string | boolean | number;
        }
    }

    // NOTE: an explicitly-EMPTY env var is treated the same as unset — the
    // default wins. For group-list keys this means `LIVETV_GROUPS=` yields the
    // default ('livetv,admin'), not "nobody"; the fallback fails toward the
    // admin-only default, never open. A config that must distinguish unset from
    // set-to-empty needs its own parser (see parseAuthoritativeStageIds).
    if (envFallback === undefined || envFallback === '') {
        if (type === 'array') return parseList(defaultValue as string, '');
        return defaultValue;
    }

    switch (type) {
        case 'string':
            return envFallback;
        case 'boolean':
            return parseBoolEnv(envFallback);
        case 'number': {
            const num = Number.parseInt(envFallback, 10);
            return Number.isNaN(num) ? (defaultValue as number) : num;
        }
        case 'float': {
            const num = Number.parseFloat(envFallback);
            return Number.isNaN(num) ? (defaultValue as number) : num;
        }
        case 'array':
            return parseList(envFallback, defaultValue as string);
    }
}

// ============================================================================
// Live bindings for module-level settings
// ============================================================================

/**
 * Re-evaluators for the `export let` settings created with {@link live}. They
 * run on every config change (see the `onConfigChange` registration at the
 * end of this file).
 */
const liveRefreshers: Array<() => void> = [];

/** Setting keys exported as live bindings (see {@link live}) — read by the schema-consistency test. */
export const LIVE_SETTING_KEYS = new Set<string>();

/**
 * A module-level setting that follows saved changes. `export const X =
 * getNumber(...)` read the store once at import, so every consumer kept the
 * boot value and the schema had to say "requires restart". With
 * `export let X = live(() => getNumber(...), (v) => { X = v; })` the value is
 * re-read on each config change and ES-module live bindings hand importers the
 * new value — no consumer changes. Only for values consumers read at use time;
 * one baked into a long-lived object at boot still needs a restart.
 */
function live<T>(key: string, compute: () => T, assign: (value: T) => void): T {
    LIVE_SETTING_KEYS.add(key);
    liveRefreshers.push(() => assign(compute()));
    return compute();
}

// Backward-compatible wrappers
const getString = (key: string, envFallback: string | undefined, defaultValue: string) =>
    getConfig('string', key, envFallback, defaultValue);
const getBool = (key: string, envFallback: string | undefined, defaultValue: boolean) =>
    getConfig('boolean', key, envFallback, defaultValue);
const getNumber = (key: string, envFallback: string | undefined, defaultValue: number) =>
    getConfig('number', key, envFallback, defaultValue);
const getFloat = (key: string, envFallback: string | undefined, defaultValue: number) =>
    getConfig('float', key, envFallback, defaultValue);
const getArray = (key: string, envFallback: string | undefined, defaultValue: string) =>
    getConfig('array', key, envFallback, defaultValue);

/**
 * Like {@link getString}, but for optional integration keys/URLs: a resolved
 * value that still looks like an unedited `.env.example` sample
 * (`your_tmdb_api_key`, `https://kavita.example.com`, …) is treated as unset
 * and falls back to `defaultValue`, with a single boot warning listing every
 * key this happened for. See `config-placeholders.ts` for why.
 */
const getOptionalIntegrationString = (
    key: string,
    envFallback: string | undefined,
    defaultValue: string,
) => {
    const value = getString(key, envFallback, defaultValue);
    if (value && isPlaceholderValue(value)) {
        noteIgnoredPlaceholder(key, (msg) => console.warn(msg));
        return defaultValue;
    }
    return value;
};

// Enum keys we already warned about, so a misconfigured value logs once per
// process instead of on every getter access.
const warnedEnumKeys = new Set<string>();

/**
 * Union-typed string setting: resolves via the normal precedence chain, then
 * normalizes (trim + lowercase) and validates against the allowed set. An
 * invalid value falls back to the default with a one-time warning — never a
 * blind `as` cast, so a typo'd env var can't leak a garbage value typed as
 * the union into consumers. Allowed values must be lowercase canonical forms.
 */
function getEnum<T extends string>(
    key: string,
    envFallback: string | undefined,
    allowed: readonly T[],
    defaultValue: T,
): T {
    const raw = getString(key, envFallback, defaultValue).trim().toLowerCase();
    if ((allowed as readonly string[]).includes(raw)) return raw as T;
    if (!warnedEnumKeys.has(key)) {
        warnedEnumKeys.add(key);
        console.warn(
            `[config] ${key}='${raw}' is not one of [${allowed.join(', ')}] — using '${defaultValue}'`,
        );
    }
    return defaultValue;
}

/**
 * Canonical env-boolean parse: true for '1'/'true'/'yes'/'on' (trimmed,
 * case-insensitive), false for anything else. The single dialect for flags
 * read straight from the environment (killswitches, per-node identity flags);
 * ConfigService-backed booleans go through getBool instead.
 */
function parseBoolEnv(value: string | undefined): boolean {
    return ['1', 'true', 'yes', 'on'].includes((value ?? '').trim().toLowerCase());
}

/**
 * Inverse dialect for DEFAULT-ON env flags: enabled unless explicitly disabled
 * with 'false'/'0'/'no'/'off' (trimmed, case-insensitive). Unknown values keep
 * the safe default (on).
 */
function envNotDisabled(value: string | undefined): boolean {
    return !['false', '0', 'no', 'off'].includes((value ?? '').trim().toLowerCase());
}

const pluginTrustLogger = Logger.for('PluginTrust');

export interface TrustedKey {
    keyId: string;
    publicKey: crypto.KeyObject;
    source: 'official' | 'operator';
}

/**
 * Parse a newline/comma-separated `keyId:base64Spki` list into Ed25519
 * KeyObjects. WARN-drops any malformed entry OR any key whose
 * asymmetricKeyType !== 'ed25519' (crypto.verify(null, …) only works for
 * Ed25519/Ed448 — an RSA/EC key would throw at install time). [Fable-1][review C11]
 *
 * `source` tags every parsed key so a matched key can be attributed
 * (`official` = baked anchor, `operator` = env). Defaults to `operator` so the
 * existing `PLUGIN_TRUSTED_KEYS` getter keeps compiling and env keys stay tagged
 * operator.
 */
/**
 * Parse a comma-separated plugin-id allowlist. Empty/unset ⇒ empty list, which
 * for every consumer of these lists means "nothing is permitted".
 */
function parseIdList(raw: string | undefined): string[] {
    if (!raw) return [];
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

export function parseTrustedKeys(
    raw: string | undefined,
    source: 'official' | 'operator' = 'operator',
): TrustedKey[] {
    if (!raw) return [];
    const out: TrustedKey[] = [];
    for (const entry of raw
        .split(/[\n,]+/)
        .map((s) => s.trim())
        .filter(Boolean)) {
        const idx = entry.indexOf(':');
        if (idx <= 0) {
            pluginTrustLogger.warn('Dropping malformed trusted plugin key (no keyId:base64)', {
                entry: entry.slice(0, 12),
            });
            continue;
        }
        const keyId = entry.slice(0, idx).trim();
        const b64 = entry.slice(idx + 1).trim();
        try {
            const publicKey = crypto.createPublicKey({
                key: Buffer.from(b64, 'base64'),
                format: 'der',
                type: 'spki',
            });
            if (publicKey.asymmetricKeyType !== 'ed25519') {
                pluginTrustLogger.warn('Dropping non-ed25519 trusted plugin key', {
                    keyId,
                    type: publicKey.asymmetricKeyType,
                });
                continue;
            }
            out.push({ keyId, publicKey, source });
        } catch (err) {
            pluginTrustLogger.warn('Dropping unparseable trusted plugin key', {
                keyId,
                err: String(err),
            });
        }
    }
    return out;
}

// Import parseList for flexible group parsing (supports comma and pipe separators)
// Use relative path to work in both SvelteKit and standalone tsx/Node.js contexts
import { parseList } from './utils/string-utils.js';

/**
 * Characters allowed in an INSTANCE_ID: alphanumerics, dot, underscore, hyphen.
 * Any colon, newline, whitespace, or control character is rejected because the
 * value is embedded in Valkey keys (separator is `:`) and shown in admin UI
 * labels. Values up to 64 chars keep keys short; co-located replicas still get
 * the hostname + suffix fallback.
 */
const INSTANCE_ID_REGEX = /^[a-zA-Z0-9._-]{1,64}$/;

/**
 * Generate a fallback instance id: `${hostname}-${6-char-suffix}`. The suffix
 * prevents Valkey key collision when the same hostname restarts with a new
 * container.
 */
function generateFallbackInstanceId(): string {
    const hostname = process.env.HOSTNAME ?? 'node';
    const suffix =
        typeof crypto !== 'undefined'
            ? crypto.randomUUID().slice(0, 6)
            : Math.random().toString(36).slice(2, 8);
    return `${hostname}-${suffix}`;
}

/**
 * Resolve and validate the INSTANCE_ID. Accepts a user-provided env value
 * when it matches {@link INSTANCE_ID_REGEX}; falls back to
 * `generateFallbackInstanceId()` otherwise.
 *
 * N-INSTANCE-ID: The raw env value was previously used verbatim, so colons,
 * newlines, and whitespace could slip into Valkey keys and admin UI labels.
 * Log the decision so operators can diagnose fallbacks in CI/dev.
 */
export function resolveInstanceId(raw: string | undefined): string {
    if (raw === undefined || raw === '') return generateFallbackInstanceId();
    if (INSTANCE_ID_REGEX.test(raw)) return raw;
    const fallback = generateFallbackInstanceId();
    console.warn(
        `[config] INSTANCE_ID='${raw}' is invalid (allowed: ${INSTANCE_ID_REGEX.source}); falling back to '${fallback}'`,
    );
    return fallback;
}

// package.json `version`, read once at module load. Last-resort fallback below
// for a build with no APP_VERSION and no git (e.g. a Docker build with no
// build-args — `.dockerignore` excludes `.git` from the context, so
// git-describe never runs there either). Never throws: an unreadable
// package.json must not break config load.
const __pkgVersion: string = (() => {
    try {
        const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8')) as {
            version?: string;
        };
        return typeof pkg.version === 'string' && pkg.version ? pkg.version : 'unknown';
    } catch {
        return 'unknown';
    }
})();

// Best-effort `git`, for the same reason vite.config.ts has one: harmless when
// there is no `.git` (Docker) or no `git` binary — caught and treated as unset.
const __runGit = (args: string): string => {
    try {
        return execSync(`git ${args}`, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'ignore'] })
            .toString()
            .trim();
    } catch {
        return '';
    }
};

// Runtime identity — resolved at runtime from process.env.
//   - Prod/container: APP_* env vars set from CI Docker build-args (git describe + SHA).
//   - Dev: APP_* injected into process.env by vite.config.ts at config-load (git describe).
//   - Fallback: npm_package_version (npm run dev) → git describe (if a repo happens to be
//     present) → package.json `version` (+ `+<shortSha>` when a commit is separately known)
//     → 'unknown'. See deriveBuildInfo() for the exact resolution order/rationale.
// `version` is the git-describe string: clean tag = official release; `-N-g<sha>` = dev build.
const resolvedBuildInfo: BuildInfo = deriveBuildInfo({
    env: { ...env, APP_VERSION: env.APP_VERSION || env.npm_package_version },
    runGit: __runGit,
    pkgVersion: __pkgVersion,
});

export const config = {
    // NOTE: Settings use getString/getBool/getNumber/getArray helpers to read from
    // ConfigService (settings.json + ENV) so that admin UI settings are respected.

    // Filesystem config/data directory root (e.g., "/config" or "/data" — see
    // docker-compose.example.yml). NOT a URL prefix — svelte.config.js's
    // `paths.base` (subfolder installs) is a separate env var, URL_BASE_PATH, via
    // scripts/resolve-url-base-path.js. Never interpolate this value into a URL.
    BASE_PATH: env.BASE_PATH || '',

    PORT: env.PORT || 3000,

    // Core infrastructure (REQUIRED)
    DATABASE_URL: env.DATABASE_URL || '',
    CACHE_URL: env.CACHE_URL || '',
    // Required persistent noeviction task instance, distinct from CACHE_URL.
    // Validated at runtime startup and before opening task/cache connections.
    TASK_CACHE_URL: env.TASK_CACHE_URL || '',

    // Full build identity (version/commit/commitShort/buildTime/branch). See
    // resolvedBuildInfo above for resolution order.
    buildInfo: resolvedBuildInfo,
    // Back-compat string alias — same value as buildInfo.version. Existing readers
    // (cluster heartbeat, layout, admin) keep working unchanged.
    APP_VERSION: resolvedBuildInfo.version,
    HOSTNAME: env.HOSTNAME ?? 'unknown',

    // Comma-separated list of additional CORS origins (e.g. your Jellyfin URL).
    // Appended to the built-in allowlist. Jellyfin dev origin (localhost:8096) is
    // added automatically in non-production builds.
    get CORS_ALLOWED_ORIGINS(): string[] {
        return getArray('CORS_ALLOWED_ORIGINS', env.CORS_ALLOWED_ORIGINS, '');
    },
    // Forward auth is opt-in. Off: USERHEADER/GROUPHEADER/NAMEHEADER are ignored
    // even from a TRUSTED_PROXY_IPS peer, because TRUSTED_PROXY_IPS is also set
    // just to get real client IPs and no proxy strips these headers by default
    // (an anonymous `X-Forwarded-User: <admin>` was signed in as that admin).
    // On: they are read from TRUSTED_PROXY_IPS peers only. See forward-auth.ts
    // `identityHeaderVerdict`.
    get FORWARD_AUTH_ENABLED(): boolean {
        return getBool('FORWARD_AUTH_ENABLED', env.FORWARD_AUTH_ENABLED, false);
    },
    get USERHEADER(): string {
        return getString('USERHEADER', env.USERHEADER, 'X-Forwarded-User');
    },
    get GROUPHEADER(): string {
        return getString('GROUPHEADER', env.GROUPHEADER, 'X-Forwarded-Groups');
    },
    // Optional companion to USERHEADER: the human-readable name the IdP knows the
    // user by, used to populate users.display_name. Defaults to Authentik's
    // conventional header; a proxy that doesn't send it leaves display_name NULL
    // and every surface falls back to the username, exactly as before.
    get NAMEHEADER(): string {
        return getString('NAMEHEADER', env.NAMEHEADER, 'x-authentik-name');
    },
    // The operator's statement that the forward-auth proxy sends GROUPHEADER on
    // every authenticated request. nginx drops a header whose value is empty, so
    // behind an nginx `auth_request` edge a user with NO IdP groups arrives with
    // the username header and no groups header at all. On: a trusted request
    // with USERHEADER but no GROUPHEADER is read as "no groups" (clears
    // users.groups, demotes an unpinned admin). Off: an absent header never
    // writes, the safe default for a proxy that omits it (it would otherwise
    // drop age-cap groups). See forward-auth.ts `groupsHeaderPresent`.
    get FORWARD_AUTH_GROUPS_ALWAYS_SENT(): boolean {
        return getBool(
            'FORWARD_AUTH_GROUPS_ALWAYS_SENT',
            env.FORWARD_AUTH_GROUPS_ALWAYS_SENT,
            false,
        );
    },
    get WATCH_PERMISSION_GROUPS(): string[] {
        return getArray(
            'WATCH_PERMISSION_GROUPS',
            env.WATCH_PERMISSION_GROUPS,
            'admin,stream-monitors',
        );
    },
    get ADMIN_GROUPS(): string[] {
        return getArray('ADMIN_GROUPS', env.ADMIN_GROUPS, 'admin');
    },
    // SETUP_UNLOCK=1: operator recovery for a locked install with no admin
    // (ruling S-C5c-2, see setup-lock.service.ts). Read from `process.env`
    // directly and never registered in the settings schema, like
    // AUTH_PLUGIN_PROVIDERS below: the settings store is writable from the
    // admin UI, and reopening setup must require control of the host.
    get SETUP_UNLOCK(): boolean {
        return parseBoolEnv(process.env.SETUP_UNLOCK);
    },
    // Commercial license key (offline signed-key). Storage only — verification lives
    // in the proprietary modules (see LICENSING.md). Blank = free, AGPL-only config.
    get LICENSE_KEY(): string {
        return getString('LICENSE_KEY', env.LICENSE_KEY, '');
    },
    // Master gate for license verification + entitlement enforcement.
    //
    // Build-time constant, OFF (no paid parts, see LICENSE_ENFORCEMENT_BUILD_DEFAULT).
    // With it off the entitlements shim returns UNLIMITED_ENTITLEMENTS.
    get LICENSE_ENFORCEMENT_ENABLED(): boolean {
        return LICENSE_ENFORCEMENT_BUILD_DEFAULT;
    },
    // NOTE: the licensing SERVER URL is deliberately not here either — it is a
    // hardcoded constant next to the signing public key it is coupled to, in
    // server/proprietary/licensing/license-server.ts. Keys only verify against
    // that baked-in key, so a configurable URL could only break auto-enrolment.
    get LIVETV_GROUPS(): string[] {
        return getArray('LIVETV_GROUPS', env.LIVETV_GROUPS, 'livetv,admin');
    },
    // Groups that can request media via Jellyseerr (empty = all users allowed)
    get REQUEST_GROUPS(): string[] {
        return getArray('REQUEST_GROUPS', env.REQUEST_GROUPS, '');
    },
    // Groups that can create/edit community reviews in media modals (empty = all users allowed)
    get SOCIAL_REVIEW_GROUPS(): string[] {
        return getArray('SOCIAL_REVIEW_GROUPS', env.SOCIAL_REVIEW_GROUPS, '');
    },
    // Groups that can view/create player community annotations: pins and chat (empty = all users allowed)
    get MEDIA_ANNOTATION_GROUPS(): string[] {
        return getArray('MEDIA_ANNOTATION_GROUPS', env.MEDIA_ANNOTATION_GROUPS, '');
    },
    // The designated trust circle(s) for listening-progress sharing.
    //
    // Reads the OPPOSITE way round from every other *_GROUPS key here: empty
    // does NOT mean "all users allowed", it means the feature is DARK. Sharing
    // where you are in a 30-hour book is ambient-awareness data that only makes
    // sense inside a circle someone deliberately drew, so an unconfigured
    // instance shares nothing rather than everything. Do not "fix" this into the
    // usual empty-means-everyone shape.
    //
    // Two users see each other only if they SHARE a group named here (see
    // buildSocialVisibilityFilter). Membership is therefore symmetric by
    // construction — there is no lurker tier. Names are matched
    // case-insensitively and resolve against BOTH users.groups (IdP) and the
    // in-app access_groups tables, so this works on a standalone install where
    // users.groups is never written.
    get SOCIAL_TRUST_GROUPS(): string[] {
        return getArray('SOCIAL_TRUST_GROUPS', env.SOCIAL_TRUST_GROUPS, '');
    },
    get DEFAULT_ACTIVITY_SHARING(): boolean {
        return getBool('DEFAULT_ACTIVITY_SHARING', env.DEFAULT_ACTIVITY_SHARING, true);
    },
    // 'auto' | 'household' | 'groups'. Resolve with `resolveSocialAudienceMode()`
    // rather than reading this raw — 'auto' is not a mode the visibility predicate
    // can act on.
    get SOCIAL_DEFAULT_AUDIENCE(): string {
        return getString('SOCIAL_DEFAULT_AUDIENCE', env.SOCIAL_DEFAULT_AUDIENCE, 'auto');
    },
    get ARR_MANAGER_GROUPS(): string[] {
        return getArray('ARR_MANAGER_GROUPS', env.ARR_MANAGER_GROUPS, 'arrmanager,admin');
    },
    // Prefix for IdP groups that set age restrictions (e.g. "age-" matches "age-12").
    // Users in matching groups are restricted to content rated at or below the number.
    get AGE_RATING_GROUP_PREFIX(): string {
        return getString('AGE_RATING_GROUP_PREFIX', env.AGE_RATING_GROUP_PREFIX, 'age-');
    },
    // When true, content without an age rating is visible to age-restricted users.
    // When false (default), unrated content is hidden for safety.
    get UNRATED_CONTENT_VISIBLE(): boolean {
        return getBool('UNRATED_CONTENT_VISIBLE', env.UNRATED_CONTENT_VISIBLE, false);
    },
    // When true, catalog/discovery titles that have no local files
    // (has_files = false) appear on the discovery surfaces: Trending and For You.
    // Default false: a media server should show the operator's library unless
    // they explicitly opt into the request-storefront experience (Jellyfin/Plex
    // expectation — fresh installs were surprised by movies they don't own).
    // Even when true, the display surfaces additionally require a configured
    // request path (features.requestsConfigured) — see
    // isUnavailableMediaVisible() below — because un-requestable ghosts are
    // pure dead ends. Exception: the release-calendar's monitored gap-fill
    // reads this RAW toggle (arr-monitored titles arrive regardless of
    // request config).
    // /browse is NOT governed by this flag — it is always library-local
    // (has_files = true) by design. Search has its own gate,
    // SHOW_UNAVAILABLE_MEDIA_IN_SEARCH (default false), because search already
    // exposes unavailable titles through the dedicated "anfragen" (requests)
    // category, so the inline result list stays library-only by default.
    // Read per-request via SearchAccessContext — no restart required.
    get SHOW_UNAVAILABLE_MEDIA(): boolean {
        return getBool('SHOW_UNAVAILABLE_MEDIA', env.SHOW_UNAVAILABLE_MEDIA, false);
    },
    // When true, catalog/discovery titles with no local files (has_files = false)
    // appear inline in the main search results. Default false: search results are
    // library-only, since unavailable titles are already reachable via the
    // separate "anfragen" (requests) category in search. Independent of
    // SHOW_UNAVAILABLE_MEDIA, which governs Trending/For You.
    // Read per-request — no restart required.
    get SHOW_UNAVAILABLE_MEDIA_IN_SEARCH(): boolean {
        return getBool(
            'SHOW_UNAVAILABLE_MEDIA_IN_SEARCH',
            env.SHOW_UNAVAILABLE_MEDIA_IN_SEARCH,
            false,
        );
    },
    // When false (default) the daily never-owned-media-gc task only previews:
    // it reports which never-owned movies/series it would delete and deletes
    // nothing, whatever its run input says.
    get NEVER_OWNED_MEDIA_GC_ENABLED(): boolean {
        return getBool('NEVER_OWNED_MEDIA_GC_ENABLED', env.NEVER_OWNED_MEDIA_GC_ENABLED, false);
    },
    // Minimum age (created_at) of a never-owned movie/series before the GC may delete it.
    get NEVER_OWNED_MEDIA_GC_MIN_AGE_DAYS(): number {
        // Clamped to the schema minimum: an env value cannot shorten the grace period below it.
        return Math.max(
            7,
            getNumber(
                'NEVER_OWNED_MEDIA_GC_MIN_AGE_DAYS',
                env.NEVER_OWNED_MEDIA_GC_MIN_AGE_DAYS,
                30,
            ),
        );
    },
    // When true (default), adding a new episode updates the series library_added_at,
    // so the series resurfaces in Recently Added. Set to false to freeze series
    // timestamps at the date the first episode was ever added.
    get RECENTLY_ADDED_PROPAGATE_TO_SERIES(): boolean {
        return getBool(
            'RECENTLY_ADDED_PROPAGATE_TO_SERIES',
            env.RECENTLY_ADDED_PROPAGATE_TO_SERIES,
            true,
        );
    },
    // Additional groups available in navigation permission dropdowns
    get NAVIGATION_AVAILABLE_GROUPS(): string[] {
        return getArray('NAVIGATION_AVAILABLE_GROUPS', env.NAVIGATION_AVAILABLE_GROUPS, '');
    },
    get DEFAULT_USER(): string {
        return getString('DEFAULT_USER', env.DEFAULT_USER, 'admin');
    },

    // Native (built-in) username/password login. Coexists with forward auth.
    // Default false preserves the exact forward-auth-only behavior for existing
    // deployments; it is flipped to true when the first admin is created via the
    // native onboarding path. When true, unauthenticated browser requests are
    // redirected to /login instead of the forward-auth setup page.
    get AUTH_NATIVE_LOGIN_ENABLED(): boolean {
        return getBool('AUTH_NATIVE_LOGIN_ENABLED', env.AUTH_NATIVE_LOGIN_ENABLED, false);
    },
    // Lifetime (days) of a native-login session cookie before it expires and the
    // user must log in again. Sessions are rotated on login and revoked on
    // logout / password change regardless of this value.
    get NATIVE_AUTH_SESSION_TTL_DAYS(): number {
        return getNumber('NATIVE_AUTH_SESSION_TTL_DAYS', env.NATIVE_AUTH_SESSION_TTL_DAYS, 30);
    },

    // ── OIDC (OpenID Connect) login — app acts as a Relying Party ──────────────
    // Optional federated SSO that coexists with native login and forward auth.
    // Default OFF; a single provider in v1. Mints a normal lumastra_session, so it
    // rides the existing session-cookie path with zero per-request hot code.
    //
    // When enabled, AUTH_OIDC_ISSUER + AUTH_OIDC_CLIENT_ID (+ usually SECRET) must
    // be set or login is refused with a clear config error.
    get AUTH_OIDC_ENABLED(): boolean {
        return getBool('AUTH_OIDC_ENABLED', env.AUTH_OIDC_ENABLED, false);
    },
    // Issuer / discovery base URL (e.g. https://idp.example.com/application/o/lumastra/).
    // Discovery appends /.well-known/openid-configuration.
    get AUTH_OIDC_ISSUER(): string {
        return getString('AUTH_OIDC_ISSUER', env.AUTH_OIDC_ISSUER, '').trim();
    },
    get AUTH_OIDC_CLIENT_ID(): string {
        return getString('AUTH_OIDC_CLIENT_ID', env.AUTH_OIDC_CLIENT_ID, '').trim();
    },
    // Derived: can OIDC actually render a sign-in control? Enabled ALONE is not
    // enough — without an issuer + client id /login has no button to show.
    //
    // Single source of truth for that question, because the call sites must
    // agree or a visitor ping-pongs: the forward-auth gate redirects anonymous
    // page loads to /login, and /login redirects straight back when it can
    // render nothing. Derived here on `config` (which every caller already
    // imports) rather than reusing isOidcConfigured() from oidc.service, so the
    // every-request middleware and the boot preflight don't drag openid-client
    // into their import graph.
    //
    // Both inputs are .trim()ed above, so a whitespace-only value reads as unset.
    get AUTH_OIDC_LOGIN_AVAILABLE(): boolean {
        return (
            this.AUTH_OIDC_ENABLED &&
            this.AUTH_OIDC_ISSUER.length > 0 &&
            this.AUTH_OIDC_CLIENT_ID.length > 0
        );
    },
    // Confidential-client secret. Sensitive — masked in the admin UI. Empty is
    // allowed for a public client using PKCE only.
    get AUTH_OIDC_CLIENT_SECRET(): string {
        return getString('AUTH_OIDC_CLIENT_SECRET', env.AUTH_OIDC_CLIENT_SECRET, '');
    },
    // Space-separated scopes; must include `openid`.
    get AUTH_OIDC_SCOPES(): string {
        return getString('AUTH_OIDC_SCOPES', env.AUTH_OIDC_SCOPES, 'openid profile email').trim();
    },
    // Claim carrying the user's group membership (Authentik `groups`, Entra
    // `roles`, Keycloak may nest it). Read every login and synced to users.groups.
    get AUTH_OIDC_GROUPS_CLAIM(): string {
        return getString('AUTH_OIDC_GROUPS_CLAIM', env.AUTH_OIDC_GROUPS_CLAIM, 'groups').trim();
    },
    // Auto-link an OIDC login to an existing account when the IdP asserts a
    // VERIFIED email matching exactly one account. NEVER links on an unverified
    // email (admin-takeover guard). Disable to require sub-based links only.
    get AUTH_OIDC_LINK_BY_VERIFIED_EMAIL(): boolean {
        return getBool(
            'AUTH_OIDC_LINK_BY_VERIFIED_EMAIL',
            env.AUTH_OIDC_LINK_BY_VERIFIED_EMAIL,
            true,
        );
    },
    // Auto-link an OIDC login to an existing account whose USERNAME matches the
    // one derived from the token (preferred_username / email local-part). Default
    // OFF and LESS SAFE than email linking: a username is not a verified proof of
    // identity, so only enable when your IdP administratively controls usernames
    // (users cannot freely set preferred_username) — otherwise a user could claim
    // another account by choosing its username. Intended for native→OIDC migration.
    get AUTH_OIDC_LINK_BY_USERNAME(): boolean {
        return getBool('AUTH_OIDC_LINK_BY_USERNAME', env.AUTH_OIDC_LINK_BY_USERNAME, false);
    },
    // Display name for the SSO button ("Sign in with <name>").
    get AUTH_OIDC_PROVIDER_NAME(): string {
        return getString('AUTH_OIDC_PROVIDER_NAME', env.AUTH_OIDC_PROVIDER_NAME, 'Single Sign-On');
    },
    // Fetch the UserInfo endpoint and merge its claims when the groups/email claim
    // isn't present in the ID token. Off by default (one fewer request per login).
    get AUTH_OIDC_USERINFO(): boolean {
        return getBool('AUTH_OIDC_USERINFO', env.AUTH_OIDC_USERINFO, false);
    },
    // Use the IdP's `picture` claim as the user's avatar when they have not
    // uploaded one (upload → IdP → Jellyfin → Gravatar). The picture is fetched
    // server-side after sign-in and stored, so browsers never contact the IdP or
    // Gravatar for it. Off = the stored copy is ignored, not deleted.
    get AUTH_OIDC_SYNC_AVATAR(): boolean {
        return getBool('AUTH_OIDC_SYNC_AVATAR', env.AUTH_OIDC_SYNC_AVATAR, true);
    },
    // Optional explicit redirect URI. Empty = derive `<origin>/auth/oidc/callback`
    // from the request (set ORIGIN/PROTOCOL_HEADER behind a TLS proxy). Must match
    // a redirect URI registered at the IdP.
    get AUTH_OIDC_REDIRECT_URI(): string {
        return getString('AUTH_OIDC_REDIRECT_URI', env.AUTH_OIDC_REDIRECT_URI, '').trim();
    },
    // DANGER: allow a non-HTTPS issuer/token endpoint. ONLY for local development
    // against a plain-HTTP test IdP. Never enable in production.
    get AUTH_OIDC_ALLOW_INSECURE(): boolean {
        return getBool('AUTH_OIDC_ALLOW_INSECURE', env.AUTH_OIDC_ALLOW_INSECURE, false);
    },
    // OIDC Back-Channel Logout: when a logout_token identifies the user by `sub`
    // only (no `sid` — "this user logged out everywhere"), also revoke their
    // refresh + Jellyfin device tokens, mirroring POST /logout. Default OFF: a
    // sub-scoped OP logout kills the browser session(s) but leaves separately
    // authorized device tokens (TV/mobile via the OAuth device flow) on their own
    // lifecycle. NEVER applies to a `sid`-scoped logout (one specific session).
    get AUTH_OIDC_BACKCHANNEL_LOGOUT_CASCADE(): boolean {
        return getBool(
            'AUTH_OIDC_BACKCHANNEL_LOGOUT_CASCADE',
            env.AUTH_OIDC_BACKCHANNEL_LOGOUT_CASCADE,
            false,
        );
    },

    // Logging level: 'debug' | 'info' | 'warn' | 'error'
    // Default: 'debug' in development, 'info' in production
    get LOG_LEVEL(): 'debug' | 'info' | 'warn' | 'error' {
        return getEnum(
            'LOG_LEVEL',
            env.LOG_LEVEL,
            ['debug', 'info', 'warn', 'error'],
            process.env.NODE_ENV === 'production' ? 'info' : 'debug',
        );
    },

    // Force a specific locale for the UI (overrides browser detection)
    // Valid values: 'en', 'de' (or leave empty for browser detection)
    get FORCE_LOCALE(): 'en' | 'de' | '' {
        return getEnum('FORCE_LOCALE', env.FORCE_LOCALE, ['en', 'de', ''], '');
    },

    // Date formatting locale (BCP 47 language tag, e.g., 'en-US', 'de-AT')
    // Used for formatting release dates and other date displays. Neutral default
    // so a fresh install doesn't render every date in the maintainer's locale;
    // operators set their own in Settings → Branding/Display.
    get DATE_LOCALE(): string {
        return getString('DATE_LOCALE', env.DATE_LOCALE, 'en-US');
    },

    // Timezone for date formatting (IANA timezone, e.g., 'UTC', 'America/New_York').
    // Default UTC is neutral and unambiguous; operators set their local zone.
    get DATE_TIMEZONE(): string {
        return getString('DATE_TIMEZONE', env.DATE_TIMEZONE, 'UTC');
    },

    // =========================================================================
    // Branding
    // =========================================================================
    get APP_NAME(): string {
        return getString('APP_NAME', env.APP_NAME, 'Lumastra');
    },
    get APP_DESCRIPTION(): string {
        return getString('APP_DESCRIPTION', env.APP_DESCRIPTION, 'Media Dashboard');
    },

    // PWA / browser-chrome colors (CSS hex). theme_color tints the installed PWA
    // titlebar + the mobile browser address bar; background_color is the splash
    // screen shown while the app boots. Defaults are the bundled Lumastra purple
    // (#7c3aed) and slate-900 (#0f172a) — operators set their own accent here so
    // the install splash/titlebar matches their logo. Consumed by the dynamic
    // /manifest.json route and the app.html theme-color meta tag.
    get APP_THEME_COLOR(): string {
        return getString('APP_THEME_COLOR', env.APP_THEME_COLOR, '#7c3aed');
    },
    get APP_BACKGROUND_COLOR(): string {
        return getString('APP_BACKGROUND_COLOR', env.APP_BACKGROUND_COLOR, '#0f172a');
    },

    // "Get the app" hint shown to Safari on iPhone/iPad (HTTPS only), pointing at
    // the native app's TestFlight. Off = never shown. See AppInstallHint.svelte.
    get WEB_APP_INSTALL_HINT(): boolean {
        return getBool('WEB_APP_INSTALL_HINT', env.WEB_APP_INSTALL_HINT, true);
    },

    // Logo paths (relative to /static/ or absolute URLs)
    // Users should provide their own logos for custom branding
    get APP_LOGO_SMALL(): string {
        return getString('APP_LOGO_SMALL', env.APP_LOGO_SMALL, '');
    },
    get APP_LOGO_FULL(): string {
        return getString('APP_LOGO_FULL', env.APP_LOGO_FULL, '');
    },
    get APP_LOGO_PLAY(): string {
        return getString('APP_LOGO_PLAY', env.APP_LOGO_PLAY, '');
    },

    // Operator-supplied rating-provider logos. The app ships text labels
    // ("IMDb"/"RT") by default because IMDb and Rotten Tomatoes restrict use of
    // their marks; an operator who has their own permission can mount a logo
    // file (same /custom/ mount as APP_LOGO_*) and point these at it to render
    // the logo instead.
    get RATING_LOGO_IMDB(): string {
        return getString('RATING_LOGO_IMDB', env.RATING_LOGO_IMDB, '');
    },
    get RATING_LOGO_ROTTEN_TOMATOES(): string {
        return getString('RATING_LOGO_ROTTEN_TOMATOES', env.RATING_LOGO_ROTTEN_TOMATOES, '');
    },

    // Background image (optional). Empty by default so the body wallpaper
    // is provided exclusively by app.css's bundled asset — the layout's
    // backgroundImage effect only overrides the body bg when the operator
    // configures a custom URL, avoiding a duplicate fetch of the same image.
    get APP_BACKGROUND_IMAGE(): string {
        return getString('APP_BACKGROUND_IMAGE', env.APP_BACKGROUND_IMAGE, '');
    },

    // Active theme id served to visitors without a saved theme cookie. Resolved
    // against the enabled themes (built-ins + valid APPEARANCE_CUSTOM_THEMES);
    // callers fall back to 'warp' when this names an unknown theme. The custom
    // themes array (APPEARANCE_CUSTOM_THEMES) is a JSON/navigation setting read
    // via the config service directly (see $lib/server/theme/enabled-themes).
    get APPEARANCE_DEFAULT_THEME(): string {
        return getString('APPEARANCE_DEFAULT_THEME', env.APPEARANCE_DEFAULT_THEME, 'warp');
    },

    // =========================================================================
    // AI Assistant Customization
    // =========================================================================

    // AI Assistant display name shown in UI
    get ASSISTANT_NAME(): string {
        return getString('ASSISTANT_NAME', env.ASSISTANT_NAME, 'Assistant');
    },

    // AI Assistant persona/character description (used in system prompt)
    // Leave empty for a generic helpful assistant, or provide a custom character
    get ASSISTANT_PERSONA(): string {
        return getString('ASSISTANT_PERSONA', env.ASSISTANT_PERSONA, '');
    },

    // AI Assistant conversational tone (used in system prompt). Normalized to
    // the allowed set so the union type is true at runtime — a typo'd env var
    // or a cleared select (stored "") falls back to 'balanced' rather than
    // leaking an invalid value into the prompt.
    get ASSISTANT_TONE(): 'concise' | 'balanced' | 'warm' {
        return getEnum(
            'ASSISTANT_TONE',
            env.ASSISTANT_TONE,
            ['concise', 'balanced', 'warm'],
            'balanced',
        );
    },

    // Whether the assistant may volunteer light, data-backed observations
    // ("you've watched a lot of sci-fi lately"). Off unless explicitly 'light'.
    get ASSISTANT_PROACTIVITY(): 'off' | 'light' {
        return getEnum('ASSISTANT_PROACTIVITY', env.ASSISTANT_PROACTIVITY, ['off', 'light'], 'off');
    },

    // Custom AI Assistant avatar URL (optional - uses default icon if not set)
    get ASSISTANT_AVATAR(): string {
        return getString('ASSISTANT_AVATAR', env.ASSISTANT_AVATAR, '');
    },

    // Daily message limit for regular users (default: 20)
    get ASSISTANT_DAILY_LIMIT_USER(): number {
        return getNumber('ASSISTANT_DAILY_LIMIT_USER', env.ASSISTANT_DAILY_LIMIT_USER, 20);
    },

    // Daily message limit for admin users (default: 100)
    get ASSISTANT_DAILY_LIMIT_ADMIN(): number {
        return getNumber('ASSISTANT_DAILY_LIMIT_ADMIN', env.ASSISTANT_DAILY_LIMIT_ADMIN, 100);
    },

    // Daily TOKEN budget for the AI assistant (gate is by tokens, not messages).
    // A tool-calling message can cost several times a simple one, so a token
    // budget limits fairly regardless of how heavy each message is.
    get ASSISTANT_DAILY_TOKEN_LIMIT_USER(): number {
        return getNumber(
            'ASSISTANT_DAILY_TOKEN_LIMIT_USER',
            env.ASSISTANT_DAILY_TOKEN_LIMIT_USER,
            250000,
        );
    },
    get ASSISTANT_DAILY_TOKEN_LIMIT_ADMIN(): number {
        return getNumber(
            'ASSISTANT_DAILY_TOKEN_LIMIT_ADMIN',
            env.ASSISTANT_DAILY_TOKEN_LIMIT_ADMIN,
            2000000,
        );
    },

    // Max concurrent in-flight assistant runs per user (Valkey INCR/DECR gate).
    // Closes the check-then-record budget race pragmatically; fails OPEN when
    // Valkey is unavailable (availability over strictness).
    get ASSISTANT_MAX_CONCURRENT(): number {
        return getNumber('ASSISTANT_MAX_CONCURRENT', env.ASSISTANT_MAX_CONCURRENT, 2);
    },

    // Per-user requests-per-minute cap for the assistant (fixed-window limiter).
    get ASSISTANT_REQUESTS_PER_MINUTE(): number {
        return getNumber('ASSISTANT_REQUESTS_PER_MINUTE', env.ASSISTANT_REQUESTS_PER_MINUTE, 10);
    },

    // Server-side conversation-history budget. The assistant keeps the most
    // recent turns that fit BOTH caps (never splitting a turn; always ≥2 turns).
    get ASSISTANT_HISTORY_MAX_TURNS(): number {
        return getNumber('ASSISTANT_HISTORY_MAX_TURNS', env.ASSISTANT_HISTORY_MAX_TURNS, 20);
    },
    get ASSISTANT_HISTORY_MAX_CHARS(): number {
        return getNumber('ASSISTANT_HISTORY_MAX_CHARS', env.ASSISTANT_HISTORY_MAX_CHARS, 24000);
    },
    // How dropped turns are handled: 'truncate' (drop oldest) or 'summarize'
    // (one cheap LLM call condenses them into a synthetic summary turn).
    get ASSISTANT_HISTORY_COMPACTION(): 'truncate' | 'summarize' {
        return getEnum(
            'ASSISTANT_HISTORY_COMPACTION',
            env.ASSISTANT_HISTORY_COMPACTION,
            ['truncate', 'summarize'],
            'truncate',
        );
    },

    // =========================================================================
    // Feature Flags - Enable/disable optional features
    // =========================================================================
    // NOTE: These use getBool() to read from ConfigService (settings.json + ENV)
    // so that admin UI settings are respected.

    // AI-powered recommendations (requires DATABASE_URL, OPENAI_API_KEY or VOYAGE_API_KEY)
    get FEATURE_AI_RECOMMENDATIONS(): boolean {
        return getBool('FEATURE_AI_RECOMMENDATIONS', env.FEATURE_AI_RECOMMENDATIONS, true);
    },

    // Multi-mode taste clustering for Music Quick Picks (k-means on embeddings).
    // When false, falls back to the legacy single-centroid taste-similar query.
    get FEATURE_MUSIC_CLUSTERING(): boolean {
        return getBool('FEATURE_MUSIC_CLUSTERING', env.FEATURE_MUSIC_CLUSTERING, true);
    },

    // Music Alchemy — the mixing-desk brew surface (/music/alchemy route + POST
    // /api/music/alchemy/brew). Default OFF: the feature requires the music
    // library acoustic data (bpm/energy/danceability/mood_tags) to be useful
    // and surfaces a new UI area that operators must consciously enable.
    // Compose with INSTANCE_PRIMARY_MODE: both are independent axes.
    get FEATURE_MUSIC_ALCHEMY(): boolean {
        return getBool('FEATURE_MUSIC_ALCHEMY', env.FEATURE_MUSIC_ALCHEMY, false);
    },

    // Sonic embeddings — MSCLAP (Microsoft CLAP '2023', 1024-dim) audio-level
    // embedding pipeline for sound-based similarity ("sounds like"). Default OFF.
    // Requires the sonic-embedder Python CLI on a CPU or CUDA worker. When off, the
    // backfill task no-ops and the /api/v1/music/{albums,artists}/{id}/similar routes return 404 (tracks fall back to metadata).
    get FEATURE_MUSIC_SONIC(): boolean {
        return getBool('FEATURE_MUSIC_SONIC', env.FEATURE_MUSIC_SONIC, false);
    },

    // Music Map — interactive 2D starfield of the audio-embedding space (/music/map).
    // Requires FEATURE_MUSIC_SONIC (MSCLAP embeddings must exist) and the umap-learn
    // Python script to have been run to populate media_audio_map_coords. Default OFF.
    get FEATURE_MUSIC_MAP(): boolean {
        return getBool('FEATURE_MUSIC_MAP', env.FEATURE_MUSIC_MAP, false);
    },

    // Lyrics Search — semantic search over song lyrics via text embeddings of .lrc
    // sidecar files. Requires an AI provider (VOYAGE_API_KEY or OPENAI_API_KEY) and
    // FEATURE_AI_RECOMMENDATIONS to be on. Default OFF.
    get FEATURE_MUSIC_LYRICS_SEARCH(): boolean {
        return getBool('FEATURE_MUSIC_LYRICS_SEARCH', env.FEATURE_MUSIC_LYRICS_SEARCH, false);
    },

    // Sonic Clustering — KMeans auto-playlists over the MSCLAP 1024-dim audio-embedding
    // space. Runs the 'sonic-clustering' task (spawns cluster.py, stores assignments in
    // media_audio_clusters). Exposes GET /api/music/sonic-mixes and the /music/collections
    // UI. Requires FEATURE_MUSIC_SONIC (sonicEmbeddings). Default OFF.
    get FEATURE_MUSIC_CLUSTERS(): boolean {
        return getBool('FEATURE_MUSIC_CLUSTERS', env.FEATURE_MUSIC_CLUSTERS, false);
    },

    // Text-to-Sound Search — uses the MSCLAP joint text+audio embedding space to find
    // tracks matching a natural-language query ("calm piano", "aggressive metal").
    // Spawns embed_text.py (the CLAP text encoder) to produce a 1024-dim text vector
    // then runs kNN over media_audio_embeddings. Exposes GET /api/music/text-search
    // and the /music/text-search UI. Requires FEATURE_MUSIC_SONIC (sonicEmbeddings).
    // Default OFF.
    get FEATURE_MUSIC_TEXT_SOUND(): boolean {
        return getBool('FEATURE_MUSIC_TEXT_SOUND', env.FEATURE_MUSIC_TEXT_SOUND, false);
    },

    // Sonic Taste Profile — on-demand Rocchio centroid in the MSCLAP 1024-dim vector
    // space, built from user_ratings (up/down votes) and user_music_state (play/skip
    // counts). Drives a 'sonic-taste' bucket in Music Quick Picks when enabled.
    // Requires FEATURE_MUSIC_SONIC (sonicEmbeddings) — the same media_audio_embeddings
    // table is used for kNN. Default OFF: cold-start users get the metadata taste path
    // until they have enough signal, and sonic must be explicitly turned on first.
    get FEATURE_MUSIC_SONIC_TASTE(): boolean {
        return getBool('FEATURE_MUSIC_SONIC_TASTE', env.FEATURE_MUSIC_SONIC_TASTE, false);
    },

    // Sonic Smart Queue — blended MSCLAP + taste-vector + mood next-track picker.
    // When enabled AND sonic embeddings are active, the smart-queue /api/music/recommendations
    // endpoint uses a blended query vector (queue-context centroid + Rocchio taste +
    // mood seed) over media_audio_embeddings rather than the metadata embedding path.
    // Default OFF: safe cold-start fallback to existing metadata-embedding logic.
    get FEATURE_MUSIC_SONIC_QUEUE(): boolean {
        return getBool('FEATURE_MUSIC_SONIC_QUEUE', env.FEATURE_MUSIC_SONIC_QUEUE, false);
    },

    // Base URL of the sonic-embedder HTTP sidecar (workers/sonic-embedder/server.py).
    // When set (e.g. 'http://sonic-embedder:8000'), Node calls the sidecar over HTTP
    // instead of spawning a subprocess — the model stays warm and text-search requests
    // are fast. Empty (default) preserves the existing execFile subprocess path so
    // local dev is unchanged. Infrastructure-only — never surfaced in the admin UI.
    get SONIC_EMBEDDER_URL(): string {
        return getString('SONIC_EMBEDDER_URL', env.SONIC_EMBEDDER_URL, '');
    },

    // Path to the Python interpreter used to run the sonic-embedder CLI.
    // Set to a virtualenv or conda python that has msclap + torch installed.
    get SONIC_EMBEDDER_PYTHON(): string {
        return getString('SONIC_EMBEDDER_PYTHON', env.SONIC_EMBEDDER_PYTHON, 'python3');
    },

    // Absolute path to workers/sonic-embedder/embed.py (or a user override).
    get SONIC_EMBEDDER_SCRIPT(): string {
        return getString(
            'SONIC_EMBEDDER_SCRIPT',
            env.SONIC_EMBEDDER_SCRIPT,
            'workers/sonic-embedder/embed.py',
        );
    },

    // Absolute path to workers/sonic-embedder/embed_text.py (or a user override).
    // Produces a 1024-dim CLAP text vector for text-to-sound search.
    get SONIC_EMBEDDER_TEXT_SCRIPT(): string {
        return getString(
            'SONIC_EMBEDDER_TEXT_SCRIPT',
            env.SONIC_EMBEDDER_TEXT_SCRIPT,
            'workers/sonic-embedder/embed_text.py',
        );
    },

    // Absolute path to workers/sonic-embedder/project_map.py (or a user override).
    // Defaults to the sibling script next to SONIC_EMBEDDER_SCRIPT.
    get SONIC_MAP_PROJECTION_SCRIPT(): string {
        return getString(
            'SONIC_MAP_PROJECTION_SCRIPT',
            env.SONIC_MAP_PROJECTION_SCRIPT,
            'workers/sonic-embedder/project_map.py',
        );
    },

    // Absolute path to workers/sonic-embedder/cluster.py (or a user override).
    // Called by the sonic-clustering task to assign KMeans labels.
    get SONIC_CLUSTER_SCRIPT(): string {
        return getString(
            'SONIC_CLUSTER_SCRIPT',
            env.SONIC_CLUSTER_SCRIPT,
            'workers/sonic-embedder/cluster.py',
        );
    },

    // Number of KMeans clusters for the sonic-clustering task.
    // Passed to cluster.py as SONIC_CLUSTER_K environment variable.
    get SONIC_CLUSTER_K(): number {
        return getNumber('SONIC_CLUSTER_K', env.SONIC_CLUSTER_K, 12);
    },

    // Number of audio file paths sent to the Python CLI in a single spawn.
    // Larger batches amortize Python startup cost; smaller batches surface
    // partial progress sooner. GPU memory is the main constraint — 16 is
    // conservative for a 6 GB GPU.
    get SONIC_EMBEDDER_BATCH_SIZE(): number {
        return getNumber('SONIC_EMBEDDER_BATCH_SIZE', env.SONIC_EMBEDDER_BATCH_SIZE, 16);
    },

    // Music-analysis engine selector.
    // 'essentia' (DEFAULT — the 2015 Essentia static binary; zero behavior change)
    // or 'sidecar' (POST /analyze on the Python sonic-embedder; raw librosa+pyloudnorm
    // features, all derivation stays in essentia-analysis.service.ts). Prod flips this
    // in /config/settings.json. Any unknown value falls back to 'essentia'.
    get MUSIC_ANALYSIS_ENGINE(): 'essentia' | 'sidecar' {
        return getEnum(
            'MUSIC_ANALYSIS_ENGINE',
            env.MUSIC_ANALYSIS_ENGINE,
            ['essentia', 'sidecar'],
            'essentia',
        );
    },

    // Base URL of the sonic-embedder /analyze sidecar. Defaults to SONIC_EMBEDDER_URL
    // so one sidecar serves both /embed and /analyze. Empty → analyzeTrack falls back
    // to the binary even when MUSIC_ANALYSIS_ENGINE=sidecar. Infrastructure-only —
    // never surfaced in the admin UI.
    get SONIC_ANALYZE_URL(): string {
        return getString('SONIC_ANALYZE_URL', env.SONIC_ANALYZE_URL, this.SONIC_EMBEDDER_URL);
    },

    // Maximum number of concurrent /analyze HTTP calls to the sidecar. The sidecar
    // runs a single-worker uvicorn + librosa (threads=6 each), so sending
    // getCpuBudgetCores()-2 concurrent requests (e.g. 10 on a 12-core host) spawns
    // ~60 librosa threads against ~12 cores — CPU starvation → fetch timeouts →
    // transient failures that were incorrectly tombstoned as permanent. Cap at 3 by
    // default (conservative: 3 × 6 = 18 threads on ~12 cores still leaves headroom
    // for the serving path). Operators can raise this if the sidecar is beefy.
    // Infrastructure-only — not surfaced in the admin UI.
    get MUSIC_ANALYSIS_SIDECAR_CONCURRENCY(): number {
        return getNumber(
            'MUSIC_ANALYSIS_SIDECAR_CONCURRENCY',
            env.MUSIC_ANALYSIS_SIDECAR_CONCURRENCY,
            3,
        );
    },

    // Tracks longer than this many minutes are skipped by music-analysis (stamped
    // `skipped` / 'track-too-long', never `failed`). DJ mixes and full-album rips
    // are the population: on prod every 60m+ file came back `essentia-empty-result`
    // while 10–30m extended mixes analysed fine, so the default sits at 30.
    // 0 disables the cap. Live — raising it re-admits the skipped tracks.
    get MUSIC_ANALYSIS_MAX_DURATION_MINUTES(): number {
        return getNumber(
            'MUSIC_ANALYSIS_MAX_DURATION_MINUTES',
            env.MUSIC_ANALYSIS_MAX_DURATION_MINUTES,
            30,
        );
    },

    // Music-First mode — when enabled, '/' redirects to '/music' and the sidebar
    // re-orders to put music navigation at the top. Orthogonal to the alchemy
    // capability flag. Default OFF (standard VOD-first mode).
    get FEATURE_MUSIC_FIRST(): boolean {
        return getBool('FEATURE_MUSIC_FIRST', env.FEATURE_MUSIC_FIRST, false);
    },

    // Instance primary mode: controls the content-mode axis of the UI.
    //   'vod'        — default; film/TV-first layout, music is a secondary tab
    //   'music'      — music-first layout (also requires FEATURE_MUSIC_FIRST to gate
    //                  the '/' redirect; kept separate so the mode is declarative even
    //                  when the redirect is not yet desired)
    //   'mixed'      — balanced layout; neither VOD nor music is primary
    //   'enterprise' — enterprise/home-&-training mode: libraries-first, no external metadata
    //   'showcase'   — product showcase mode: public /showcase surface + internal product library
    // Normalised to the allowed set so a misconfigured env var falls back to 'vod'.
    get INSTANCE_PRIMARY_MODE(): 'vod' | 'music' | 'mixed' | 'enterprise' | 'showcase' {
        return getEnum(
            'INSTANCE_PRIMARY_MODE',
            env.INSTANCE_PRIMARY_MODE,
            ['vod', 'music', 'mixed', 'enterprise', 'showcase'],
            'vod',
        );
    },
    get INSTANCE_LANDING_PATH(): string {
        return getString('INSTANCE_LANDING_PATH', env.INSTANCE_LANDING_PATH, '') as string;
    },
    get INSTANCE_USE_CASES(): string[] {
        return getArray('INSTANCE_USE_CASES', env.INSTANCE_USE_CASES, '') as string[];
    },
    get INSTANCE_PROFILE_APPLIED(): string {
        return getString('INSTANCE_PROFILE_APPLIED', env.INSTANCE_PROFILE_APPLIED, '') as string;
    },

    // ─────────────────── Product Showcase public surface ───────────────────────
    // Master switch. When OFF the /showcase route 404s. Reads live (no restart needed).
    get FEATURE_PUBLIC_SHOWCASE(): boolean {
        return getBool('FEATURE_PUBLIC_SHOWCASE', env.FEATURE_PUBLIC_SHOWCASE, false);
    },

    // UUID of the library_groups row whose items are publicly visible on /showcase.
    // Empty = nothing is public even when FEATURE_PUBLIC_SHOWCASE is on.
    get SHOWCASE_PUBLIC_LIBRARY_GROUP_ID(): string {
        return getString(
            'SHOWCASE_PUBLIC_LIBRARY_GROUP_ID',
            env.SHOWCASE_PUBLIC_LIBRARY_GROUP_ID,
            '',
        ) as string;
    },

    // When ON, the /showcase route sets a permissive frame-ancestors CSP.
    // Requires SHOWCASE_EMBED_ALLOWED_ORIGINS to be non-empty (otherwise rejected).
    get SHOWCASE_ALLOW_EMBED(): boolean {
        return getBool('SHOWCASE_ALLOW_EMBED', env.SHOWCASE_ALLOW_EMBED, false);
    },

    // Allow-list of origins for frame-ancestors CSP when SHOWCASE_ALLOW_EMBED is ON.
    // Must be non-empty when SHOWCASE_ALLOW_EMBED=true to prevent wildcarded frame-ancestors.
    get SHOWCASE_EMBED_ALLOWED_ORIGINS(): string[] {
        return getArray(
            'SHOWCASE_EMBED_ALLOWED_ORIGINS',
            env.SHOWCASE_EMBED_ALLOWED_ORIGINS,
            '',
        ) as string[];
    },

    // Display-only: hides nav chrome, auto-advances/loops playback for showroom screens.
    get SHOWCASE_KIOSK_MODE(): boolean {
        return getBool('SHOWCASE_KIOSK_MODE', env.SHOWCASE_KIOSK_MODE, false);
    },

    // When ON, the /showcase public route additionally requires a valid signed-URL token.
    // Default ON (link-shared mode; explicit opt-out for fully-open).
    get SHOWCASE_REQUIRE_TOKEN(): boolean {
        return getBool('SHOWCASE_REQUIRE_TOKEN', env.SHOWCASE_REQUIRE_TOKEN, true);
    },

    // Deployment-wide hard ceiling on concurrent showcase ffmpeg transcodes
    // (enforced by one shared Valkey admission across every web replica — see
    // showcase-transcode-cap.ts). Must be the SAME value on every replica.
    get SHOWCASE_MAX_CONCURRENT_TRANSCODES(): number {
        return getNumber(
            'SHOWCASE_MAX_CONCURRENT_TRANSCODES',
            env.SHOWCASE_MAX_CONCURRENT_TRANSCODES,
            4,
        );
    },
    // ───────────────────────────────────────────────────────────────────────────

    // ─────────────────── Enterprise: Training Assignments ─────────────────────
    // Master switch for the training assignment + completion-tracking layer.
    // When OFF, /my/trainings 404s, /admin/trainings 404s, and the nav entries
    // are hidden. Default OFF for non-enterprise installs.
    get FEATURE_TRAINING_ASSIGNMENTS(): boolean {
        return getBool('FEATURE_TRAINING_ASSIGNMENTS', env.FEATURE_TRAINING_ASSIGNMENTS, false);
    },
    // ───────────────────────────────────────────────────────────────────────────

    // ─────────────────────── Enterprise: Assessment ───────────────────────────
    // Master switch for the native quiz + certificate-of-completion layer
    // (Phase A). When OFF, /learn 404s, /admin/courses 404s, certificate
    // routes 404, and the nav "Learn" entry is hidden. Default OFF for
    // non-enterprise installs.
    get FEATURE_ASSESSMENT(): boolean {
        return getBool('FEATURE_ASSESSMENT', env.FEATURE_ASSESSMENT, false);
    },
    // ───────────────────────────────────────────────────────────────────────────

    // RAG-powered AI assistant
    get FEATURE_AI_ASSISTANT(): boolean {
        return getBool('FEATURE_AI_ASSISTANT', env.FEATURE_AI_ASSISTANT, true);
    },

    // Hybrid tool-calling (agentic RAG) for the AI assistant. When enabled AND
    // the configured chat model is tool-capable, the assistant chooses from
    // typed, access-scoped tools instead of single-shot RAG. Falls back to
    // single-shot automatically for non-tool models (safe default for OSS
    // users plugging in weak/local LLMs).
    get FEATURE_ASSISTANT_TOOLS(): boolean {
        return getBool('FEATURE_ASSISTANT_TOOLS', env.FEATURE_ASSISTANT_TOOLS, true);
    },
    // Escape hatch: force tool-calling on regardless of model-name detection,
    // for custom OpenAI-compatible endpoints whose tool-capable model name we
    // don't recognise. Off by default.
    get ASSISTANT_TOOLS_FORCE(): boolean {
        return getBool('ASSISTANT_TOOLS_FORCE', env.ASSISTANT_TOOLS_FORCE, false);
    },
    // Whether the assistant may CHANGE the user's own data (watchlist, ratings,
    // watched state, requests) rather than only read it. Off by default: a model
    // that writes is a different risk profile from one that answers, and an
    // operator should opt into it deliberately. Individual actions are gated
    // further per caller in the tool registry.
    get FEATURE_ASSISTANT_WRITES(): boolean {
        return getBool('FEATURE_ASSISTANT_WRITES', env.FEATURE_ASSISTANT_WRITES, false);
    },
    // Cross-user watch history is deliberately a separate, opt-in assistant
    // capability. FEATURE_SOCIAL controls existing social UI; this controls
    // whether the AI may read consented peer history at all.
    get FEATURE_ASSISTANT_SHARED_HISTORY(): boolean {
        return getBool(
            'FEATURE_ASSISTANT_SHARED_HISTORY',
            env.FEATURE_ASSISTANT_SHARED_HISTORY,
            false,
        );
    },
    // Empty means nobody may invoke shared-history tools. This is unlike some
    // older *_GROUPS settings on purpose: cross-user viewing data must fail closed.
    get ASSISTANT_SHARED_HISTORY_GROUPS(): string[] {
        return getArray('ASSISTANT_SHARED_HISTORY_GROUPS', env.ASSISTANT_SHARED_HISTORY_GROUPS, '');
    },
    // Which chat backend the assistant uses: 'openai' | 'anthropic' | 'auto'.
    // 'auto' (default) picks anthropic when only ANTHROPIC_API_KEY is set,
    // otherwise openai. Explicit values force a backend regardless of keys.
    get ASSISTANT_PROVIDER(): 'openai' | 'anthropic' | 'auto' {
        return getEnum(
            'ASSISTANT_PROVIDER',
            env.ASSISTANT_PROVIDER,
            ['openai', 'anthropic', 'auto'],
            'auto',
        );
    },
    // Enable Claude adaptive thinking for the assistant (Anthropic backend only;
    // ignored by OpenAI). On by default. The reasoning summary is surfaced to
    // the chat UI and logged.
    get ASSISTANT_THINKING(): boolean {
        return getBool('ASSISTANT_THINKING', env.ASSISTANT_THINKING, true);
    },
    // Reasoning/effort cap for the assistant on effort-capable Claude models
    // (Opus 4.5+, Sonnet 4.6, Fable). Controls thinking depth + overall token
    // spend; 'medium' balances quality and output-token cost. Ignored by models
    // without effort support (Haiku, Sonnet 4.5) and by OpenAI.
    get ASSISTANT_EFFORT(): 'low' | 'medium' | 'high' | 'xhigh' | 'max' {
        return getEnum(
            'ASSISTANT_EFFORT',
            env.ASSISTANT_EFFORT,
            ['low', 'medium', 'high', 'xhigh', 'max'],
            'medium',
        );
    },
    // Whether the assistant's recommended-cards section may include
    // requestable-but-not-yet-available titles (Jellyseerr "Request" cards).
    // Off by default: cards show only titles the user can watch now. The model
    // can still mention requestable titles in its text reply.
    get FEATURE_ASSISTANT_INCLUDE_REQUESTABLE(): boolean {
        return getBool(
            'FEATURE_ASSISTANT_INCLUDE_REQUESTABLE',
            env.FEATURE_ASSISTANT_INCLUDE_REQUESTABLE,
            false,
        );
    },

    // Live TV support. Single on/off gate for the feature. Off by default — Live TV
    // is opt-in: it needs a dedicated stream-proxy container + IPTV sources, which
    // most installs won't have. Turn this on to enable (LIVETV_SOURCE already
    // defaults to 'standalone', the only mode).
    get FEATURE_LIVETV(): boolean {
        return getBool('FEATURE_LIVETV', env.FEATURE_LIVETV, false);
    },

    // Audiobookshelf integration
    get FEATURE_AUDIOBOOKS(): boolean {
        return getBool('FEATURE_AUDIOBOOKS', env.FEATURE_AUDIOBOOKS, true);
    },

    // Kavita book/manga integration
    get FEATURE_KAVITA(): boolean {
        return getBool('FEATURE_KAVITA', env.FEATURE_KAVITA, true);
    },

    // Sonarr/Radarr calendar integration
    get FEATURE_CALENDAR(): boolean {
        return getBool('FEATURE_CALENDAR', env.FEATURE_CALENDAR, true);
    },

    // Streaming sessions monitoring
    get FEATURE_SESSIONS(): boolean {
        return getBool('FEATURE_SESSIONS', env.FEATURE_SESSIONS, true);
    },

    // Sessions cache refresh intervals (in milliseconds)
    // Server-side: how often to refresh sessions from Jellyfin
    get SESSIONS_REFRESH_INTERVAL_MS(): number {
        return getNumber('SESSIONS_REFRESH_INTERVAL_MS', env.SESSIONS_REFRESH_INTERVAL_MS, 5000);
    },
    // Client-side: how often browser polls for session updates
    get SESSIONS_POLL_INTERVAL_MS(): number {
        return getNumber('SESSIONS_POLL_INTERVAL_MS', env.SESSIONS_POLL_INTERVAL_MS, 5000);
    },

    // Continue Watching thresholds
    // Minimum seconds watched before an item appears in Continue Watching
    get CONTINUE_WATCHING_MIN_SECONDS(): number {
        return Math.max(
            0,
            Math.min(
                600,
                getNumber('CONTINUE_WATCHING_MIN_SECONDS', env.CONTINUE_WATCHING_MIN_SECONDS, 30),
            ),
        );
    },
    // Minimum percentage of runtime watched before appearing in Continue Watching (0-100)
    get CONTINUE_WATCHING_MIN_PERCENT(): number {
        return Math.max(
            0,
            Math.min(
                100,
                getNumber('CONTINUE_WATCHING_MIN_PERCENT', env.CONTINUE_WATCHING_MIN_PERCENT, 10),
            ),
        );
    },
    // Threshold above which an in-progress CW item is considered "substantial"
    // enough to win the anchor-rule contest against a Next Up candidate even
    // when the CW episode is at-or-ahead of the last completed episode.
    // Below this, ahead-of-sequence CW items are treated as phantom scrubs
    // and lose to Next Up after the staleness window.
    get CONTINUE_WATCHING_SUBSTANTIAL_PERCENT(): number {
        return Math.max(
            0,
            Math.min(
                100,
                getNumber(
                    'CONTINUE_WATCHING_SUBSTANTIAL_PERCENT',
                    env.CONTINUE_WATCHING_SUBSTANTIAL_PERCENT,
                    20,
                ),
            ),
        );
    },
    // How long a low-progress ahead-of-sequence CW item is allowed to win over
    // Next Up before being treated as a stale phantom. Recent brief plays still
    // win (they might be real intent); after this window, Next Up takes over.
    get CONTINUE_WATCHING_PHANTOM_STALENESS_DAYS(): number {
        return Math.max(
            0,
            getNumber(
                'CONTINUE_WATCHING_PHANTOM_STALENESS_DAYS',
                env.CONTINUE_WATCHING_PHANTOM_STALENESS_DAYS,
                3,
            ),
        );
    },
    // Hard age cutoff for Continue Watching: rows whose last_event_at is older
    // than this many days are dropped from CW regardless of position/percent.
    // Only meaningful once watch-sync writes occurred_at = real LastPlayedDate
    // (rather than pull-time NOW()) — otherwise every row looks fresh after
    // every pull. 180 days reads as a sensible compromise between movies
    // (which users may resume months later) and shows (which usually go
    // stale within weeks). 0 disables the cutoff (legacy behaviour).
    get CONTINUE_WATCHING_MAX_AGE_DAYS(): number {
        return Math.max(
            0,
            getNumber('CONTINUE_WATCHING_MAX_AGE_DAYS', env.CONTINUE_WATCHING_MAX_AGE_DAYS, 180),
        );
    },
    // Progress bar visibility threshold for episode thumbnails (0-100).
    // The bar is shown when playedPercentage is above 0 and below this value.
    // At or above this percentage the episode is considered visually complete
    // and only the watched checkmark is shown.
    get EPISODE_PROGRESS_BAR_THRESHOLD(): number {
        return Math.max(
            0,
            Math.min(
                100,
                getNumber('EPISODE_PROGRESS_BAR_THRESHOLD', env.EPISODE_PROGRESS_BAR_THRESHOLD, 90),
            ),
        );
    },
    // Drop "next up" suggestions for series whose latest watched episode
    // is older than this many days. Default 60 — shorter than CW because
    // an unfinished resume is a stronger signal than "you watched ep 1
    // months ago, here's ep 2." 0 disables the filter.
    get NEXT_UP_MAX_AGE_DAYS(): number {
        return Math.max(0, getNumber('NEXT_UP_MAX_AGE_DAYS', env.NEXT_UP_MAX_AGE_DAYS, 60));
    },

    // ── Homepage hero ────────────────────────────────────────────────
    get HERO_AUTOPLAY_ENABLED(): boolean {
        return getBool('HERO_AUTOPLAY_ENABLED', env.HERO_AUTOPLAY_ENABLED, true);
    },
    get HERO_AUTOPLAY_INTERVAL_MS(): number {
        const val = getNumber('HERO_AUTOPLAY_INTERVAL_MS', env.HERO_AUTOPLAY_INTERVAL_MS, 10000);
        return Math.max(3000, Math.min(60000, val)); // Clamp: 3s–60s
    },
    get HERO_TRANSITION_MS(): number {
        const val = getNumber('HERO_TRANSITION_MS', env.HERO_TRANSITION_MS, 500);
        return Math.max(0, Math.min(2000, val)); // Clamp: 0–2s
    },
    get HERO_MAX_SLIDES(): number {
        const val = getNumber('HERO_MAX_SLIDES', env.HERO_MAX_SLIDES, 5);
        return Math.max(1, Math.min(15, val)); // Clamp: 1–15
    },
    get HERO_FALLBACK_SOURCE(): 'trending' | 'random' {
        return getEnum(
            'HERO_FALLBACK_SOURCE',
            env.HERO_FALLBACK_SOURCE,
            ['trending', 'random'],
            'trending',
        );
    },

    // LiveTV program info refresh interval
    get LIVETV_REFRESH_INTERVAL_MS(): number {
        return getNumber('LIVETV_REFRESH_INTERVAL_MS', env.LIVETV_REFRESH_INTERVAL_MS, 13000);
    },

    // LiveTV provider source: 'standalone' | 'disabled'. Defaults to 'standalone'
    // (the only real mode) so FEATURE_LIVETV alone gates Live TV on/off. 'disabled'
    // remains a secondary off-switch (e.g. keep the feature flag on but the source off).
    get LIVETV_SOURCE(): 'standalone' | 'disabled' {
        return getEnum(
            'LIVETV_SOURCE',
            env.LIVETV_SOURCE,
            ['standalone', 'disabled'],
            'standalone',
        );
    },

    // Strip quality/feed tags (FHD/HD/UHD/SD, *, superscripts ¹²³, WEB) from the
    // user-facing channel name for a clean display (e.g. "Channel One FHD" -> "Channel One").
    // On by default; per-channel admin renames always take precedence.
    get LIVETV_HIDE_QUALITY_TAGS(): boolean {
        return getBool('LIVETV_HIDE_QUALITY_TAGS', env.LIVETV_HIDE_QUALITY_TAGS, true);
    },

    // Stream proxy URL (e.g., http://lumastra-proxy:3000)
    get STREAM_PROXY_URL(): string {
        return getString('STREAM_PROXY_URL', env.STREAM_PROXY_URL, '');
    },

    // Start process as stream proxy instead of SvelteKit
    get STREAM_PROXY_MODE(): boolean {
        return getBool('STREAM_PROXY_MODE', env.STREAM_PROXY_MODE, false);
    },

    // Shared secret for proxy auth (X-Proxy-Secret header)
    get STREAM_PROXY_SECRET(): string {
        return getString('STREAM_PROXY_SECRET', env.STREAM_PROXY_SECRET, '');
    },

    // Disable SSRF private IP blocking for trusted networks
    get LIVETV_ALLOW_PRIVATE_URLS(): boolean {
        return getBool('LIVETV_ALLOW_PRIVATE_URLS', env.LIVETV_ALLOW_PRIVATE_URLS, false);
    },

    // Synchronized multi-variant Live TV ladder. Kept separate from the VOD
    // FEATURE_PLAYER_AUTO_QUALITY experiment because native HLS clients consume
    // this server-authored ladder directly.
    get LIVETV_ADAPTIVE_LADDER_ENABLED(): boolean {
        return getBool('LIVETV_ADAPTIVE_LADDER_ENABLED', env.LIVETV_ADAPTIVE_LADDER_ENABLED, false);
    },
    get LIVETV_DEFAULT_QUALITY():
        'adaptive' | 'original' | '1080p8m' | '720p4m' | '540p2m' | '360p1m' {
        return getEnum(
            'LIVETV_DEFAULT_QUALITY',
            env.LIVETV_DEFAULT_QUALITY,
            ['adaptive', 'original', '1080p8m', '720p4m', '540p2m', '360p1m'],
            'adaptive',
        );
    },
    get LIVETV_ADAPTIVE_INCLUDE_ORIGINAL(): boolean {
        return getBool(
            'LIVETV_ADAPTIVE_INCLUDE_ORIGINAL',
            env.LIVETV_ADAPTIVE_INCLUDE_ORIGINAL,
            false,
        );
    },
    /**
     * What to do when a requested quality ceiling cannot be produced.
     *
     * Defaults to 'source', NOT 'refuse'. This is a *quality preference*, and the
     * failure modes are ordinary rather than exotic: a source ffprobe could not read
     * inside LIVETV_PROBE_TIMEOUT_MS (ingest itself tolerates this and falls back to
     * always-transcode), an HDR channel, a sub-540p channel with fewer than two rungs
     * beneath it, or an encoder budget already spent by another channel. Failing
     * closed on any of those turns "you get the unencoded stream" into "Live TV is
     * broken", which is the worse answer for something the viewer never asked to
     * fail. Operators who genuinely need the ceiling enforced can still pick 'refuse'.
     */
    get LIVETV_CAP_FALLBACK(): 'refuse' | 'source' {
        return getEnum(
            'LIVETV_CAP_FALLBACK',
            env.LIVETV_CAP_FALLBACK,
            ['refuse', 'source'],
            'source',
        );
    },

    // Forward HTTP-CONNECT proxy for ALL outbound LiveTV→provider traffic
    // (M3U/XMLTV import, channel logos, stream playback). Empty = direct
    // connections (feature off). Inline credentials → Proxy-Authorization: Basic.
    // NOTE: distinct from STREAM_PROXY_URL (our own transcode container's URL).
    get LIVETV_UPSTREAM_PROXY_URL(): string {
        return getString('LIVETV_UPSTREAM_PROXY_URL', env.LIVETV_UPSTREAM_PROXY_URL, '');
    },

    // Heartbeat timeout before considering viewer disconnected (seconds)
    get LIVETV_VIEWER_TIMEOUT_SECONDS(): number {
        return getNumber('LIVETV_VIEWER_TIMEOUT_SECONDS', env.LIVETV_VIEWER_TIMEOUT_SECONDS, 30);
    },

    // Hide a station from viewers when every feed failed this many times in a row (0 = off)
    get LIVETV_HIDE_OFFLINE_AFTER_FAILURES(): number {
        return getNumber(
            'LIVETV_HIDE_OFFLINE_AFTER_FAILURES',
            env.LIVETV_HIDE_OFFLINE_AFTER_FAILURES,
            0,
        );
    },

    // How long to keep FFmpeg running after the last viewer leaves (seconds)
    get LIVETV_GRACE_PERIOD_SECONDS(): number {
        return getNumber('LIVETV_GRACE_PERIOD_SECONDS', env.LIVETV_GRACE_PERIOD_SECONDS, 30);
    },

    // Show active streams to users when stream limit is reached
    get LIVETV_SHOW_ACTIVE_STREAMS(): boolean {
        return getBool('LIVETV_SHOW_ACTIVE_STREAMS', env.LIVETV_SHOW_ACTIVE_STREAMS, true);
    },
    // Viewers may pick another feed of a station's backup group (incl. hidden feeds)
    get LIVETV_VIEWER_FEED_CHOICE(): boolean {
        return getBool('LIVETV_VIEWER_FEED_CHOICE', env.LIVETV_VIEWER_FEED_CHOICE, true);
    },
    // Hidden channels keep their (unpinned) channel number reserved
    get LIVETV_KEEP_HIDDEN_CHANNEL_NUMBERS(): boolean {
        return getBool(
            'LIVETV_KEEP_HIDDEN_CHANNEL_NUMBERS',
            env.LIVETV_KEEP_HIDDEN_CHANNEL_NUMBERS,
            false,
        );
    },
    get LIVETV_HIGH_PRIORITY_GROUPS(): string[] {
        return getArray('LIVETV_HIGH_PRIORITY_GROUPS', env.LIVETV_HIGH_PRIORITY_GROUPS, 'admin');
    },
    get LIVETV_KICK_POLICY(): 'shortest' | 'longest' {
        return getEnum(
            'LIVETV_KICK_POLICY',
            env.LIVETV_KICK_POLICY,
            ['shortest', 'longest'],
            'shortest',
        );
    },

    // Watch Together functionality
    get FEATURE_WATCH_TOGETHER(): boolean {
        return getBool('FEATURE_WATCH_TOGETHER', env.FEATURE_WATCH_TOGETHER, true);
    },

    // Sidebar with external service links
    get FEATURE_SIDEBAR(): boolean {
        return getBool('FEATURE_SIDEBAR', env.FEATURE_SIDEBAR, true);
    },

    // Social features - show who watched/rated content in modals and components
    // When disabled, users only see their own watch history and ratings
    get FEATURE_SOCIAL(): boolean {
        return getBool('FEATURE_SOCIAL', env.FEATURE_SOCIAL, true);
    },
    // Community reviews - written reviews visible in the Friends' Watch Activity section
    // Requires FEATURE_SOCIAL to be enabled
    get FEATURE_SOCIAL_REVIEWS(): boolean {
        return getBool('FEATURE_SOCIAL_REVIEWS', env.FEATURE_SOCIAL_REVIEWS, true);
    },

    /**
     * User comments and emoji reactions on media, playlists and people
     * (`interactions` / `interaction_reactions`, twelve endpoints on /api/v1).
     *
     * **Defaults OFF, and the default is the point.** These endpoints shipped
     * with no flag at all, so an operator could not turn them off short of a
     * code change — on an install whose users do not know each other, that is
     * twelve unmoderated free-text endpoints with no report path, no edit, and
     * no content filtering. `social-sharing.md` is explicit that the absence of
     * moderation tooling rests on "the admin knows every user personally", and
     * publishing the project makes that assumption false somewhere.
     *
     * Off rather than on because the feature is provably unused: zero rows in
     * `interactions` and `interaction_reactions` on the production instance
     * after 3,425 play sessions (measured 2026-08-11). There is no consumer to
     * break — no first-party UI calls these endpoints — so defaulting off costs
     * nothing an operator cannot undo with one switch.
     */
    get FEATURE_COMMENTS(): boolean {
        return getBool('FEATURE_COMMENTS', env.FEATURE_COMMENTS, false);
    },

    // Per-user outbound notification webhook (ntfy / Gotify / Discord shaped).
    // When enabled, each user may register ONE endpoint that receives the two
    // notification-class events (library.new_episode, request.available).
    //
    // DEFAULT OFF, and the default is the feature's security posture rather than
    // conservatism about a new surface: a user-supplied URL is an egress vector an
    // operator-configured hook is not. The SSRF guard (assertPublicHttpUrl +
    // safeFetch's DNS pinning, tasks/url-safety.ts) is applied at save time AND at
    // every delivery hop, but "the server will make outbound requests to addresses
    // its users choose" is an operator decision, not a default.
    get FEATURE_USER_NOTIFICATION_WEBHOOKS(): boolean {
        return getBool(
            'FEATURE_USER_NOTIFICATION_WEBHOOKS',
            env.FEATURE_USER_NOTIFICATION_WEBHOOKS,
            false,
        );
    },

    // Hostnames OPERATOR webhooks may target even though they are private
    // (in-cluster services, LAN hosts such as n8n or Home Assistant). Entries
    // are exact hostnames or IP literals; a leading dot (`.svc.cluster.local`)
    // matches that suffix. Per-user notification webhooks NEVER consult this
    // list: a user-chosen URL reaching the cluster network is exactly the SSRF
    // the guard exists for. Empty (the default) keeps every private target
    // rejected. See `isAllowlistedPrivateWebhookHost()` in tasks/url-safety.ts.
    get WEBHOOK_PRIVATE_HOST_ALLOWLIST(): string[] {
        return getArray('WEBHOOK_PRIVATE_HOST_ALLOWLIST', env.WEBHOOK_PRIVATE_HOST_ALLOWLIST, '');
    },

    // APNs push for the iOS client. ON by default: every tier includes the
    // `push` module, and the licence refresh fetches the ≤24h relay token for
    // the default relay on its own (relay-token.store.ts), so a stock install
    // needs no configuration. Nothing is sent until a user's iOS app registers
    // a device token, and capabilities report push unavailable (so the app never
    // asks for permission) whenever no usable credential is held.
    get FEATURE_PUSH_NOTIFICATIONS(): boolean {
        return getBool('FEATURE_PUSH_NOTIFICATIONS', env.FEATURE_PUSH_NOTIFICATIONS, true);
    },

    // Base URL of the push relay. Configurable ON PURPOSE, unlike
    // LICENSE_SERVER_URL which is hardcoded — a self-hoster running their own
    // signed iOS build must be able to point at their own relay. This costs no
    // revenue: the official relay's entitlement check is the gate, not URL secrecy.
    get PUSH_RELAY_URL(): string {
        return getString('PUSH_RELAY_URL', env.PUSH_RELAY_URL, 'https://push.lumastra.org');
    },

    // Bearer credential for a SELF-HOSTED relay. Empty on a stock install: the
    // default relay is authenticated with the licence-minted ≤24h relay token
    // that `maybeRefreshLicense()` renews every 6h. Set this only when
    // PUSH_RELAY_URL points at your own relay; it always wins over the minted
    // token (see `getRelayToken()`).
    get PUSH_RELAY_TOKEN(): string {
        return getString('PUSH_RELAY_TOKEN', env.PUSH_RELAY_TOKEN, '');
    },

    // ── Operator bring-your-own Apple signing key (DirectApnsTransport) ──────
    //
    // The unpaid path that does not involve Lumastra at all: an operator who
    // signs and distributes their own iOS build puts their own Apple `.p8`
    // here, and this server talks to api.push.apple.com directly. Without it
    // the only route is a relay — ours (paid) or one they run themselves —
    // which is honest but leaves "run a second service" as the price of an
    // AGPL capability.
    //
    // PKCS#8 PEM contents of the `.p8`, inline. Secret managers and compose
    // files routinely flatten newlines to the two-character sequence `\n`, so
    // the resolver normalises those before parsing (see `apns-credential.ts`).
    // Mutually exclusive with APNS_KEY_P8_PATH.
    get APNS_KEY_P8(): string {
        return getString('APNS_KEY_P8', env.APNS_KEY_P8, '');
    },

    // Filesystem path to the `.p8` instead of its contents. Preferred where a
    // secret can be mounted as a file, since the key never enters the process
    // environment or settings.json.
    get APNS_KEY_P8_PATH(): string {
        return getString('APNS_KEY_P8_PATH', env.APNS_KEY_P8_PATH, '');
    },

    // The 10-character key identifier Apple prints next to the `.p8` download.
    // Travels in the provider JWT's `kid` header.
    get APNS_KEY_ID(): string {
        return getString('APNS_KEY_ID', env.APNS_KEY_ID, '');
    },

    // The 10-character Apple Developer team identifier. Becomes the provider
    // JWT's `iss` claim.
    get APNS_TEAM_ID(): string {
        return getString('APNS_TEAM_ID', env.APNS_TEAM_ID, '');
    },

    // Which transport the delivery pass uses.
    //
    // 'auto' (the default) picks direct whenever an Apple signing key is
    // configured and the relay otherwise, which is the right answer for every
    // install that configured exactly one of them. The explicit values exist
    // for the install that configured BOTH — a self-hoster testing their own
    // `.p8` against a relay they already had working, say — where "whichever
    // the code happens to prefer" is not an acceptable answer.
    get PUSH_TRANSPORT(): 'auto' | 'direct' | 'relay' {
        return getEnum('PUSH_TRANSPORT', env.PUSH_TRANSPORT, ['auto', 'direct', 'relay'], 'auto');
    },

    // Personal statistics page - viewing history analytics, watch patterns, etc.
    // When disabled, the "My Statistics" link is hidden from the user menu
    get FEATURE_PERSONAL_STATS(): boolean {
        return getBool('FEATURE_PERSONAL_STATS', env.FEATURE_PERSONAL_STATS, true);
    },

    // Allow users to upload a custom avatar (JPEG/PNG/WebP/GIF, max 2 MB, stored in the DB)
    // When disabled, the "Change Avatar" button is hidden from the user menu
    get FEATURE_AVATAR_UPLOAD(): boolean {
        return getBool('FEATURE_AVATAR_UPLOAD', env.FEATURE_AVATAR_UPLOAD, true);
    },

    // Gravatar fallback for user avatars when no Jellyfin avatar exists
    // Requires users to have an email address set in the users table
    get FEATURE_GRAVATAR(): boolean {
        return getBool('FEATURE_GRAVATAR', env.FEATURE_GRAVATAR, false);
    },

    // Auto-fetch lyrics from LRCLIB when a user opens the lyrics tab
    // When disabled, only manually uploaded or pre-fetched lyrics are shown
    get FEATURE_AUTO_LYRICS(): boolean {
        return getBool('FEATURE_AUTO_LYRICS', env.FEATURE_AUTO_LYRICS, true);
    },

    // Daily check for new Lumastra releases on GitHub (`lumastra-update-check`
    // task, admin notice). The only request it makes is to api.github.com.
    get UPDATE_CHECK_ENABLED(): boolean {
        return getBool('UPDATE_CHECK_ENABLED', env.UPDATE_CHECK_ENABLED, true);
    },

    // The weekly licence check-in to lumastra.org (license-check-in.ts). Off
    // skips only that call: renewals near expiry and the push relay token keep
    // contacting the licensing server when they need to.
    get LICENSE_CHECK_IN_ENABLED(): boolean {
        return getBool('LICENSE_CHECK_IN_ENABLED', env.LICENSE_CHECK_IN_ENABLED, true);
    },

    // Every call to the licensing server (license-refresh.ts): enrolment,
    // renewal, the weekly check-in and the push relay token. Off: no call at
    // all, and an install without a key runs on the free tier at once (no
    // no-key grace window). A stored key keeps working until its `exp`.
    get LICENSE_SERVER_CONTACT_ENABLED(): boolean {
        return getBool('LICENSE_SERVER_CONTACT_ENABLED', env.LICENSE_SERVER_CONTACT_ENABLED, true);
    },

    // Client diagnostics — automatic crash/hang/js_error/api_failures reports from
    // iOS/tvOS/web. Playback incidents are always recorded regardless.
    get FEATURE_CLIENT_DIAGNOSTICS(): boolean {
        return getBool('FEATURE_CLIENT_DIAGNOSTICS', env.FEATURE_CLIENT_DIAGNOSTICS, true);
    },

    // User- and admin-requested log bundles (gzip logs from a device).
    get FEATURE_CLIENT_LOG_BUNDLES(): boolean {
        return getBool('FEATURE_CLIENT_LOG_BUNDLES', env.FEATURE_CLIENT_LOG_BUNDLES, true);
    },

    // Short redacted log tail attached to crash / playback-failure reports.
    get FEATURE_CLIENT_DIAGNOSTICS_LOG_TAIL(): boolean {
        return getBool(
            'FEATURE_CLIENT_DIAGNOSTICS_LOG_TAIL',
            env.FEATURE_CLIENT_DIAGNOSTICS_LOG_TAIL,
            true,
        );
    },

    // Save fetched lyrics as .lrc files next to audio files
    get FEATURE_SAVE_LYRICS_TO_DISK(): boolean {
        return getBool('FEATURE_SAVE_LYRICS_TO_DISK', env.FEATURE_SAVE_LYRICS_TO_DISK, false);
    },

    // Bulk background lyrics fetch — sweeps tracks with no lyrics attempt yet and
    // calls resolveLyrics() (which uses LRCLIB via getLyrics, writes the .lrc sidecar
    // if FEATURE_SAVE_LYRICS_TO_DISK is on, and stores the not-found marker).
    // No-op unless FEATURE_AUTO_LYRICS is also on (resolveLyrics gates on it).
    // Default OFF — enable explicitly to start the background sweep.
    get FEATURE_MUSIC_LYRICS_FETCH(): boolean {
        return getBool('FEATURE_MUSIC_LYRICS_FETCH', env.FEATURE_MUSIC_LYRICS_FETCH, false);
    },

    // Sessions viewing - when disabled, only admins can see streaming sessions
    // Regular users will not see who is currently watching what
    get FEATURE_SESSIONS_PUBLIC(): boolean {
        return getBool('FEATURE_SESSIONS_PUBLIC', env.FEATURE_SESSIONS_PUBLIC, true);
    },

    // Show episodes whose premiere date is in the future in the series modal
    // (e.g., "Not yet aired" rows). When disabled, those rows are hidden.
    get FEATURE_SHOW_UNAIRED_EPISODES(): boolean {
        return getBool('FEATURE_SHOW_UNAIRED_EPISODES', env.FEATURE_SHOW_UNAIRED_EPISODES, true);
    },

    // Show episodes that are not present as files in the library — metadata-only rows
    // tagged "Not on disk" (air date known and passed) or "Air date TBA" (no air date
    // known at all). When disabled, both kinds are hidden.
    get FEATURE_SHOW_MISSING_EPISODES(): boolean {
        return getBool('FEATURE_SHOW_MISSING_EPISODES', env.FEATURE_SHOW_MISSING_EPISODES, true);
    },

    // Sessions device info - when disabled, only admins/watch permission groups see device info
    // Device info includes client name (e.g., "Jellyfin Web") and browser/device name (e.g., "Chrome 120")
    get FEATURE_SESSIONS_DEVICE_INFO_PUBLIC(): boolean {
        return getBool(
            'FEATURE_SESSIONS_DEVICE_INFO_PUBLIC',
            env.FEATURE_SESSIONS_DEVICE_INFO_PUBLIC,
            false,
        );
    },

    // YouTube trailers in movie/show modals
    get FEATURE_YOUTUBE_MODALS(): boolean {
        return getBool('FEATURE_YOUTUBE_MODALS', env.FEATURE_YOUTUBE_MODALS, true);
    },

    // YouTube trailers in hero slider on homepage
    get FEATURE_YOUTUBE_HERO(): boolean {
        return getBool('FEATURE_YOUTUBE_HERO', env.FEATURE_YOUTUBE_HERO, true);
    },

    // Quick Connect - allows users to link Jellyfin devices via code
    // When disabled, the Quick Connect button and API are not available
    get FEATURE_QUICK_CONNECT(): boolean {
        return getBool('FEATURE_QUICK_CONNECT', env.FEATURE_QUICK_CONNECT, true);
    },

    // Auto quality mode in player - adaptive bitrate based on network speed.
    // Still too unstable to ship: this is a dev-only feature, force-disabled outside
    // dev/preprod regardless of any stored config value so it can never be enabled in
    // production. When disabled, only Original and fixed quality options are available.
    get FEATURE_PLAYER_AUTO_QUALITY(): boolean {
        if (!devFeaturesEnabled) return false;
        return getBool('FEATURE_PLAYER_AUTO_QUALITY', env.FEATURE_PLAYER_AUTO_QUALITY, false);
    },

    // Allow users to toggle dock visibility in user menu
    // When disabled, users cannot hide the sidebar/dock
    get FEATURE_DOCK_TOGGLE(): boolean {
        return getBool('FEATURE_DOCK_TOGGLE', env.FEATURE_DOCK_TOGGLE, true);
    },

    // Show the admin "Developer" nav section and its diagnostic pages
    // (admin IA redesign, spec §3.7). Off by default in production; defaults to
    // devFeaturesEnabled so dev/preprod expose it automatically. Settings →
    // General surfaces this toggle (added in a later admin-ia step).
    get SHOW_DEVELOPER_TOOLS(): boolean {
        return getBool('SHOW_DEVELOPER_TOOLS', env.SHOW_DEVELOPER_TOOLS, devFeaturesEnabled);
    },

    // In-app request modal (vs opening Jellyseerr in new tab)
    // When enabled, clicking "Anfragen" opens a modal to request directly
    // When disabled, opens Jellyseerr URL in new tab
    get FEATURE_REQUEST_MODAL(): boolean {
        return getBool('FEATURE_REQUEST_MODAL', env.FEATURE_REQUEST_MODAL, false);
    },

    // Playlists feature - allows users to create and share media playlists
    // When disabled, playlist functionality is completely hidden
    get FEATURE_PLAYLISTS(): boolean {
        return getBool('FEATURE_PLAYLISTS', env.FEATURE_PLAYLISTS, true);
    },

    // Background Jellyfin sync — bidirectional watch state sync, session polling for "Now Streaming"
    // When enabled (and JELLYFINURL is set), watch-sync plugin pushes/pulls watch state, sessions are polled
    get FEATURE_JELLYFIN_SYNC(): boolean {
        return getBool('FEATURE_JELLYFIN_SYNC', env.FEATURE_JELLYFIN_SYNC, true);
    },

    // Jellyfin compatibility layer - exposes /j/ routes that emulate the Jellyfin API
    // Allows Jellyfin-native clients (Swiftfin, Jellyfin Android TV, etc.) to connect
    get FEATURE_JELLYFIN_COMPAT(): boolean {
        return getBool('FEATURE_JELLYFIN_COMPAT', env.FEATURE_JELLYFIN_COMPAT, true);
    },

    // Empty by default. Explicit token-only browser access, independently of native CORS.
    get JELLYFIN_COMPAT_CORS_ORIGINS(): string[] {
        return getArray(
            'JELLYFIN_COMPAT_CORS_ORIGINS',
            env.JELLYFIN_COMPAT_CORS_ORIGINS,
            '',
        ).filter(isCorsOrigin);
    },

    // OpenSubsonic compatibility layer - exposes /subsonic/rest/ routes that implement the OpenSubsonic API
    // Allows music apps (Symfonium, Ultrasonic, DSub, etc.) to connect and play the music library
    get FEATURE_SUBSONIC_COMPAT(): boolean {
        return getBool('FEATURE_SUBSONIC_COMPAT', env.FEATURE_SUBSONIC_COMPAT, false);
    },

    // Original-file download - GET /j/Items/{id}/Download and GET /api/v1/media/{id}/download
    // stream the untranscoded source file as an attachment. Independent of
    // FEATURE_JELLYFIN_COMPAT: lets an admin keep Jellyfin-client playback working
    // while refusing raw file egress (bandwidth/licensing), or vice versa expose
    // downloads via PATs without running the full compat layer. Checked once in
    // the shared handler (media-download-handler.ts), so both surfaces agree.
    get FEATURE_MEDIA_DOWNLOAD(): boolean {
        return getBool('FEATURE_MEDIA_DOWNLOAD', env.FEATURE_MEDIA_DOWNLOAD, false);
    },

    // Per-response bandwidth cap for FILE downloads, in KB/s. 0 = unlimited.
    // Covers the original-file download on both surfaces (/j/Items/{id}/Download
    // and /api/v1/media/{id}/download) plus finished download renditions — they
    // all reach the wire through serveFileByPath, which is where the cap is
    // applied. A single client pulling a 40 GB remux at line rate can otherwise
    // saturate the uplink and starve every live stream on the box.
    //
    // The cap is PER RESPONSE, not a shared pool: "how fast may one download go"
    // is the question an operator can actually reason about, whereas a global
    // pool would make one download's speed depend on how many others exist.
    get DOWNLOAD_THROTTLE_KBPS(): number {
        return getNumber('DOWNLOAD_THROTTLE_KBPS', env.DOWNLOAD_THROTTLE_KBPS, 0);
    },

    // Per-replica cap on progressive (non-HLS) transcodes served by
    // /j/Videos/{id}/stream?Static=false&container=… — what Jellyfin clients like
    // Moonfin request for a reduced-quality download. 0 disables them: such
    // requests then get the original file, as before the feature existed.
    get JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT(): number {
        return getNumber(
            'JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT',
            env.JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT,
            2,
        );
    },

    // Per-response bandwidth cap for transcoded STREAM delivery (HLS segments),
    // in KB/s. 0 = unlimited. Separate from DOWNLOAD_THROTTLE_KBPS because the
    // two have opposite requirements: a download can be slowed almost freely,
    // while a stream throttled below its own bitrate simply rebuffers forever.
    // Set this above the highest bitrate you actually serve, or leave it off.
    get TRANSCODE_THROTTLE_KBPS(): number {
        return getNumber('TRANSCODE_THROTTLE_KBPS', env.TRANSCODE_THROTTLE_KBPS, 0);
    },

    // Offline-download renditions - server-side transcode of a title into a
    // single progressive MP4 at a chosen quality, so a device that cannot direct
    // play the original can still take it offline. Separate from
    // FEATURE_MEDIA_DOWNLOAD because the cost profile is completely different:
    // that one streams bytes that already exist, this one spends CPU-minutes and
    // gigabytes of cache per (title, quality, audio track). Default off.
    get FEATURE_DOWNLOAD_RENDITIONS(): boolean {
        return getBool('FEATURE_DOWNLOAD_RENDITIONS', env.FEATURE_DOWNLOAD_RENDITIONS, false);
    },

    // Encode download renditions on the GPU when one is configured and the
    // ffmpeg build actually exposes the encoder. Only the ENCODER moves to the
    // GPU (plus decode); tone mapping and scaling stay on the CPU deliberately —
    // see hw-plan.ts. A GPU attempt that fails falls back to software for that
    // encode, so turning this off is a performance choice, never a correctness
    // requirement.
    get DOWNLOAD_RENDITION_HWACCEL(): boolean {
        return getBool('DOWNLOAD_RENDITION_HWACCEL', env.DOWNLOAD_RENDITION_HWACCEL, true);
    },

    get DOWNLOAD_RENDITION_CACHE_DIR(): string {
        return getString(
            'DOWNLOAD_RENDITION_CACHE_DIR',
            env.DOWNLOAD_RENDITION_CACHE_DIR,
            '/config/cache/download-renditions',
        );
    },

    // LRU byte budget for finished artifacts. Not a TTL: eviction is coldest-first
    // once the budget is exceeded, and an evicted rendition becomes re-requestable
    // rather than dead.
    get DOWNLOAD_RENDITION_CACHE_MAX_GB(): number {
        // Floored at 1GB. `reapToCap` turns this straight into a byte budget
        // and evicts every rendition above it, so a 0 or negative value —
        // reachable from the env or the admin config UI, neither of which
        // validates the sign — is not "no cache", it is "delete every ready
        // download artifact on the next reap, including ones being served".
        // Every sibling size getter has this floor; this one was missed.
        return Math.max(
            1,
            getNumber('DOWNLOAD_RENDITION_CACHE_MAX_GB', env.DOWNLOAD_RENDITION_CACHE_MAX_GB, 50),
        );
    },

    // Concurrent rendition encodes per pod. Deliberately 1 by default: these run
    // alongside live playback transcodes on the same CPU, and a download that
    // takes an hour instead of 40 minutes is far cheaper than a stuttering stream.
    get DOWNLOAD_RENDITION_MAX_CONCURRENT(): number {
        return getNumber(
            'DOWNLOAD_RENDITION_MAX_CONCURRENT',
            env.DOWNLOAD_RENDITION_MAX_CONCURRENT,
            1,
        );
    },

    // How long an encode may go without a progress heartbeat before another
    // replica may adopt it. Must exceed the gap between ffmpeg progress blocks
    // (~1s) by a wide margin so a busy box does not trigger takeover storms.
    get DOWNLOAD_RENDITION_STALE_SECONDS(): number {
        return getNumber(
            'DOWNLOAD_RENDITION_STALE_SECONDS',
            env.DOWNLOAD_RENDITION_STALE_SECONDS,
            180,
        );
    },

    // Release hung encoders even when no other pod polls their stale row.
    get DOWNLOAD_RENDITION_STALL_TIMEOUT_SECONDS(): number {
        return Math.max(
            30,
            getNumber(
                'DOWNLOAD_RENDITION_STALL_TIMEOUT_SECONDS',
                env.DOWNLOAD_RENDITION_STALL_TIMEOUT_SECONDS,
                600,
            ),
        );
    },

    // Byte transfers one client may run at once while filling its series pool.
    // Serving a finished rendition is a throttled static read from
    // /renditions/{id}/file — deliberately NOT derived from
    // MUSIC_TRANSCODE_MAX_PER_USER, which governs the mp3 transcoder and has
    // nothing to do with this path.
    get SERIES_DOWNLOAD_MAX_CONCURRENT_TRANSFERS(): number {
        return getNumber(
            'SERIES_DOWNLOAD_MAX_CONCURRENT_TRANSFERS',
            env.SERIES_DOWNLOAD_MAX_CONCURRENT_TRANSFERS,
            2,
        );
    },

    // Renditions one user may hold in queued|encoding when an automatic pool
    // asks for them. THE ADVERTISED VALUE AND THE ENFORCED VALUE ARE THIS ONE
    // GETTER: a contract that promises a different number than it enforces
    // hands a compliant client a stream of 503s. Default 1 matches
    // DOWNLOAD_RENDITION_MAX_CONCURRENT's default — letting one user hold more
    // than there are slots buys them nothing and starves everyone else.
    get SERIES_DOWNLOAD_MAX_PREPARATIONS_PER_USER(): number {
        return getNumber(
            'SERIES_DOWNLOAD_MAX_PREPARATIONS_PER_USER',
            env.SERIES_DOWNLOAD_MAX_PREPARATIONS_PER_USER,
            1,
        );
    },

    // Multiplier on DOWNLOAD_RENDITION_MAX_CONCURRENT above which POOL requests
    // are refused with 503 + Retry-After. Manual requests are always admitted:
    // a human tapping Download is not the workload this protects against.
    get SERIES_DOWNLOAD_QUEUE_BACKPRESSURE_FACTOR(): number {
        return getNumber(
            'SERIES_DOWNLOAD_QUEUE_BACKPRESSURE_FACTOR',
            env.SERIES_DOWNLOAD_QUEUE_BACKPRESSURE_FACTOR,
            8,
        );
    },

    // Rung used when a candidates request names none. Always clamped against
    // the source height per candidate, so this is a ceiling, never an upscale.
    get SERIES_DOWNLOAD_DEFAULT_RUNG(): string {
        return getEnum(
            'SERIES_DOWNLOAD_DEFAULT_RUNG',
            env.SERIES_DOWNLOAD_DEFAULT_RUNG,
            ['1080p', '720p', '540p', '360p'] as const,
            '720p',
        );
    },

    // Media hover popup - Netflix-style hover cards with expanded info on poster hover
    // Shows backdrop, overview, ratings, and quick actions when hovering over media cards
    get FEATURE_MEDIA_HOVER_POPUP(): boolean {
        return getBool('FEATURE_MEDIA_HOVER_POPUP', env.FEATURE_MEDIA_HOVER_POPUP, true);
    },

    // Media hover popup trailers - Auto-play YouTube trailers in hover popup
    // Requires FEATURE_MEDIA_HOVER_POPUP to be enabled
    get FEATURE_MEDIA_HOVER_POPUP_TRAILERS(): boolean {
        return getBool(
            'FEATURE_MEDIA_HOVER_POPUP_TRAILERS',
            env.FEATURE_MEDIA_HOVER_POPUP_TRAILERS,
            false,
        );
    },

    // Media hover popup video preview - Show video previews on hover for Continue Watching
    // Requires FEATURE_MEDIA_HOVER_POPUP to be enabled
    get FEATURE_MEDIA_HOVER_VIDEO_PREVIEW(): boolean {
        return getBool(
            'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW',
            env.FEATURE_MEDIA_HOVER_VIDEO_PREVIEW,
            false,
        );
    },

    // Featured Pick video - Auto-play trailers/video previews in the Featured Pick hero section
    // Supports YouTube trailers and Jellyfin video previews with fallback to backdrop
    get FEATURE_FEATURED_PICK_VIDEO(): boolean {
        return getBool('FEATURE_FEATURED_PICK_VIDEO', env.FEATURE_FEATURED_PICK_VIDEO, false);
    },

    // Preview max width (pixels)
    get PREVIEW_MAX_WIDTH(): number {
        return getNumber('PREVIEW_MAX_WIDTH', env.PREVIEW_MAX_WIDTH, 640);
    },

    // Preview max height (pixels)
    get PREVIEW_MAX_HEIGHT(): number {
        return getNumber('PREVIEW_MAX_HEIGHT', env.PREVIEW_MAX_HEIGHT, 360);
    },

    // Live TV preview support - Enable video previews for live TV channels (served via the internal stream-proxy ffmpeg pipeline)
    // Requires FEATURE_MEDIA_HOVER_VIDEO_PREVIEW to be enabled
    // NOTE: Live TV previews are resource-intensive - use strict limits below
    get FEATURE_MEDIA_HOVER_VIDEO_PREVIEW_LIVETV(): boolean {
        return getBool(
            'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW_LIVETV',
            env.FEATURE_MEDIA_HOVER_VIDEO_PREVIEW_LIVETV,
            false,
        );
    },

    // Maximum concurrent live TV previews per server (to prevent resource exhaustion)
    // Each preview consumes transcoding resources - recommended: 2-5 depending on server capacity
    get PREVIEW_MAX_LIVETV_PER_SERVER(): number {
        return getNumber('PREVIEW_MAX_LIVETV_PER_SERVER', env.PREVIEW_MAX_LIVETV_PER_SERVER, 3);
    },

    // Live TV hover delay in milliseconds before showing preview
    get PREVIEW_HOVER_DELAY_LIVETV_MS(): number {
        return getNumber('PREVIEW_HOVER_DELAY_LIVETV_MS', env.PREVIEW_HOVER_DELAY_LIVETV_MS, 2500);
    },

    // Hover delay in ms before loading the video preview / YouTube trailer
    // inside the hover popup. The popup itself opens instantly with the
    // backdrop image; only the video request waits this long. Prevents
    // request bursts when the user scrubs across a row of posters and
    // hover-steal swaps the popup card-to-card.
    get PREVIEW_HOVER_VIDEO_DELAY_MS(): number {
        return getNumber('PREVIEW_HOVER_VIDEO_DELAY_MS', env.PREVIEW_HOVER_VIDEO_DELAY_MS, 500);
    },

    // Maximum active live TV watchers before blocking previews
    get PREVIEW_MAX_LIVETV_WATCHERS(): number {
        return getNumber('PREVIEW_MAX_LIVETV_WATCHERS', env.PREVIEW_MAX_LIVETV_WATCHERS, 5);
    },

    // Preview video codec (for local FFmpeg mode): 'h264' or 'hevc'
    get PREVIEW_VIDEO_CODEC(): 'h264' | 'hevc' {
        return getEnum('PREVIEW_VIDEO_CODEC', env.PREVIEW_VIDEO_CODEC, ['h264', 'hevc'], 'h264');
    },

    // Preview encoding preset (for local FFmpeg software encoding): 'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', etc.
    // Faster presets = lower CPU usage but larger file size. Recommended: 'veryfast' or 'fast' for previews
    get PREVIEW_ENCODING_PRESET(): string {
        return getString('PREVIEW_ENCODING_PRESET', env.PREVIEW_ENCODING_PRESET, 'veryfast');
    },

    // Preview NVENC preset (for NVIDIA hardware encoding): 'p1' (fastest) to 'p7' (slowest)
    // Lower numbers = faster encoding but larger file size. Recommended: 'p2' or 'p3' for previews
    get PREVIEW_NVENC_PRESET(): string {
        return getString('PREVIEW_NVENC_PRESET', env.PREVIEW_NVENC_PRESET, 'p2');
    },

    // Peak video bitrate cap (Mbps) for preview transcodes — applied as a VBV
    // cap (-b:v/-maxrate/-bufsize) so a complex, high-motion source (e.g. a 4K
    // Bluray) can't emit multi-megabyte hover-preview segments that stall the
    // player. A 640x360–720p preview needs ~1–2 Mbps; the default keeps quality
    // while eliminating the 10+ Mbps segments an unconstrained encoder produces.
    // 0 disables the cap (falls back to CRF-only quality control).
    get PREVIEW_MAX_VIDEO_BITRATE_MBPS(): number {
        return getNumber('PREVIEW_MAX_VIDEO_BITRATE_MBPS', env.PREVIEW_MAX_VIDEO_BITRATE_MBPS, 2);
    },

    // Max number of preview transcodes allowed to use the GPU (QSV/NVENC/…)
    // concurrently. Previews are bursty (every hover); routing all of them to
    // the GPU can exhaust its limited encode sessions and starve REAL playback,
    // which shares the same GPU. Above this in-flight count, further previews
    // fall back to CPU. Requires HW_ENCODING_ENABLED + GPU_ACCELERATION != none;
    // 0 disables GPU for previews entirely (always CPU).
    get PREVIEW_MAX_GPU_JOBS(): number {
        return getNumber('PREVIEW_MAX_GPU_JOBS', env.PREVIEW_MAX_GPU_JOBS, 2);
    },

    // HLS segment length (seconds) for preview transcodes. A cold preview can't
    // show its first frame until FFmpeg has finished encoding the FIRST segment,
    // so a short segment is the biggest first-frame-latency lever — 2s makes the
    // first playable segment ready ~3x sooner than the 6s default playback uses,
    // at the cost of a few more (tiny) requests. Only affects previews.
    get PREVIEW_SEGMENT_DURATION(): number {
        return getNumber('PREVIEW_SEGMENT_DURATION', env.PREVIEW_SEGMENT_DURATION, 2);
    },

    // Hard ceiling on concurrent (non-live-TV) preview transcodes across the
    // whole server (all replicas, coordinated via Valkey). Once reached, new
    // preview requests are rejected (429) rather than evicting a running job —
    // this is the budget that stops previews from ever monopolizing the box.
    // Reuse/coalescing means one job serves many re-requests, so this counts
    // distinct in-flight previews, not requests.
    get PREVIEW_MAX_GLOBAL(): number {
        return getNumber('PREVIEW_MAX_GLOBAL', env.PREVIEW_MAX_GLOBAL, 8);
    },

    // Ceiling on concurrent (non-live-TV) preview sessions for a SINGLE user
    // (as opposed to PREVIEW_MAX_GLOBAL, the server-wide budget). Hitting this
    // evicts one of the user's existing sessions -- see pickEvictionVictim in
    // preview-eviction.ts for which one.
    //
    // The schema's min:1/max:32 (schema.ts) only governs the ConfigService/admin
    // path — the env-var path below is unvalidated, so it is clamped here too
    // (mirrors HERO_MAX_SLIDES above). Without this, PREVIEW_MAX_PER_USER=0 makes
    // `userPreviews.length >= 0` always true and pickEvictionVictim([]) throws on
    // every preview create.
    get PREVIEW_MAX_PER_USER(): number {
        const val = getNumber('PREVIEW_MAX_PER_USER', env.PREVIEW_MAX_PER_USER, 6);
        return Math.max(1, Math.min(32, val)); // Clamp: 1–32
    },

    // Playback gets CPU first: background jobs defer above this load/core ratio.
    get LUMASTRA_BACKGROUND_CPU_PSI_PERCENT(): number {
        return getFloat(
            'LUMASTRA_BACKGROUND_CPU_PSI_PERCENT',
            env.LUMASTRA_BACKGROUND_CPU_PSI_PERCENT,
            20,
        );
    },
    get LUMASTRA_BACKGROUND_CPU_LOAD_RATIO(): number {
        return getFloat(
            'LUMASTRA_BACKGROUND_CPU_LOAD_RATIO',
            env.LUMASTRA_BACKGROUND_CPU_LOAD_RATIO,
            2,
        );
    },

    // Load-shedding circuit breaker for previews. When the 1-minute load average
    // per CPU core exceeds this ratio, new preview sessions are auto-disabled for
    // PREVIEW_AUTODISABLE_SECONDS (real playback is never affected). 0 disables
    // the breaker. Default 3.0 = load of 60 on a 20-core box.
    get PREVIEW_LOAD_SHED_RATIO(): number {
        return getFloat('PREVIEW_LOAD_SHED_RATIO', env.PREVIEW_LOAD_SHED_RATIO, 3.0);
    },

    // How long previews stay auto-disabled after a load breach. The breaker
    // re-evaluates each request, so this is the minimum cool-off; it clears
    // automatically once load returns below the threshold.
    get PREVIEW_AUTODISABLE_SECONDS(): number {
        return getNumber('PREVIEW_AUTODISABLE_SECONDS', env.PREVIEW_AUTODISABLE_SECONDS, 45);
    },

    // Cross-category emergency load-shed for REAL transcodes (video + music). The
    // per-category caps (LUMASTRA_MAX_CONCURRENT_TRANSCODES, MUSIC_TRANSCODE_MAX_CONCURRENT,
    // preview, livetv) are independent and additive — nothing bounds their SUM, and only
    // the preview breaker watches system load. When the 1-min load average per core
    // exceeds this ratio, NEW real-transcode admissions are refused (503) as a last
    // resort before the box collapses (unlike previews this DOES affect playback, so it
    // must sit well above normal peak). 0 disables it — the SAFE DEFAULT for unreleased
    // software: enable it once you've measured your box's normal peak load and set this
    // above it. livetv transcodes run in the separate stream-proxy process and are not
    // gated here (they have their own per-source cap).
    get LUMASTRA_TRANSCODE_LOAD_SHED_RATIO(): number {
        return getFloat(
            'LUMASTRA_TRANSCODE_LOAD_SHED_RATIO',
            env.LUMASTRA_TRANSCODE_LOAD_SHED_RATIO,
            0,
        );
    },

    // Hard cap on how many seconds of media a single preview FFmpeg job may
    // transcode (`-t`). A preview is a short hover/hero snippet, never the whole
    // movie — without this a long-lived preview transcodes forward unboundedly,
    // wasting CPU and disk. 0 = unbounded (legacy behavior).
    get PREVIEW_TRANSCODE_MAX_SECONDS(): number {
        return getNumber('PREVIEW_TRANSCODE_MAX_SECONDS', env.PREVIEW_TRANSCODE_MAX_SECONDS, 30);
    },
    // Duration cap for full-length local trailer previews (served through the
    // preview lane with the snippet clamp lifted). Bounds mislabeled
    // full-length files. Cached trailer artifacts are ~12x a 30s snippet
    // against PREVIEW_CACHE_MAX_BYTES. 0 = unbounded.
    get TRAILER_MAX_SECONDS(): number {
        return getNumber('TRAILER_MAX_SECONDS', env.TRAILER_MAX_SECONDS, 360);
    },

    // --- Coordinated preview cache (Tier-3) ---
    get PREVIEW_CACHE_ENABLED(): boolean {
        return getBool('PREVIEW_CACHE_ENABLED', env.PREVIEW_CACHE_ENABLED, true);
    },
    // Persistent LOCAL cache root. NEVER /tmp, NEVER NFS. Default mirrors the
    // music-transcode cache convention (/config/cache/...).
    get PREVIEW_CACHE_DIR(): string {
        return getString('PREVIEW_CACHE_DIR', env.PREVIEW_CACHE_DIR, '/config/cache/preview');
    },
    get PREVIEW_CACHE_MAX_BYTES(): number {
        return getNumber(
            'PREVIEW_CACHE_MAX_BYTES',
            env.PREVIEW_CACHE_MAX_BYTES,
            10 * 1024 * 1024 * 1024,
        );
    },
    get PREVIEW_FORCE_UNIVERSAL_CODEC(): boolean {
        return getBool('PREVIEW_FORCE_UNIVERSAL_CODEC', env.PREVIEW_FORCE_UNIVERSAL_CODEC, true);
    },
    get PREVIEW_HOVER_MAX_SECONDS(): number {
        return getNumber('PREVIEW_HOVER_MAX_SECONDS', env.PREVIEW_HOVER_MAX_SECONDS, 60);
    },

    // --- tvOS Top Shelf preview + cinemagraph URLs ---
    // Master flag; gates both minting signed URLs and serving the artifact bytes.
    get FEATURE_TOPSHELF_PREVIEWS(): boolean {
        return getBool('FEATURE_TOPSHELF_PREVIEWS', env.FEATURE_TOPSHELF_PREVIEWS, false);
    },
    // Expiry (seconds) for the signed URLs minted by the Top Shelf endpoint.
    // Default 48h — long enough to survive the tvOS Top Shelf snapshot cadence
    // without a session/heartbeat.
    get TOPSHELF_PREVIEW_URL_TTL_SECONDS(): number {
        return getNumber(
            'TOPSHELF_PREVIEW_URL_TTL_SECONDS',
            env.TOPSHELF_PREVIEW_URL_TTL_SECONDS,
            172800,
        );
    },
    // Durable artifact store root (never /tmp, never NFS — same convention as
    // PREVIEW_CACHE_DIR). Distinct from the LRU preview cache: entries here are
    // pinned while a live signed URL can point at them.
    get TOPSHELF_PREVIEW_CACHE_DIR(): string {
        return getString(
            'TOPSHELF_PREVIEW_CACHE_DIR',
            env.TOPSHELF_PREVIEW_CACHE_DIR,
            '/config/cache/topshelf',
        );
    },
    // Store size cap in bytes. The pinning rule (an artifact a live signed URL
    // can point at is never evicted) overrides this cap when everything is pinned.
    get TOPSHELF_PREVIEW_CACHE_MAX_BYTES(): number {
        return getNumber(
            'TOPSHELF_PREVIEW_CACHE_MAX_BYTES',
            env.TOPSHELF_PREVIEW_CACHE_MAX_BYTES,
            2 * 1024 * 1024 * 1024,
        );
    },
    // GC TTL (days) on lastRequestedAt — variants untouched this long are eligible
    // for deletion regardless of the size cap.
    get TOPSHELF_PREVIEW_RETENTION_DAYS(): number {
        return getNumber(
            'TOPSHELF_PREVIEW_RETENTION_DAYS',
            env.TOPSHELF_PREVIEW_RETENTION_DAYS,
            14,
        );
    },
    // Sweep cadence (ms) for the Top Shelf artifact store's background GC loop.
    get TOPSHELF_GC_INTERVAL_MS(): number {
        return getNumber('TOPSHELF_GC_INTERVAL_MS', env.TOPSHELF_GC_INTERVAL_MS, 3_600_000);
    },
    // Snippet preview length (seconds) when no local trailer exists.
    get TOPSHELF_PREVIEW_DURATION_SECONDS(): number {
        return getNumber(
            'TOPSHELF_PREVIEW_DURATION_SECONDS',
            env.TOPSHELF_PREVIEW_DURATION_SECONDS,
            30,
        );
    },
    // Cap (seconds) applied to a local trailer used as the preview variant's source.
    get TOPSHELF_TRAILER_MAX_SECONDS(): number {
        return getNumber('TOPSHELF_TRAILER_MAX_SECONDS', env.TOPSHELF_TRAILER_MAX_SECONDS, 90);
    },
    // Silent looping cinemagraph clip length (seconds).
    get TOPSHELF_CINEMAGRAPH_DURATION_SECONDS(): number {
        return getNumber(
            'TOPSHELF_CINEMAGRAPH_DURATION_SECONDS',
            env.TOPSHELF_CINEMAGRAPH_DURATION_SECONDS,
            15,
        );
    },
    // Base render width (pixels) for Top Shelf artifacts. Deliberately its OWN
    // knob rather than reusing PREVIEW_MAX_WIDTH — that setting lives in the
    // 'hover' section and defaults to 640px, sized for a small web hover card.
    // A full-bleed 4K-TV Top Shelf preview upscaled from 640 looks soft; 1280
    // paired with the inherited PREVIEW_MAX_VIDEO_BITRATE_MBPS (2 Mbps) is a
    // well-matched pair. Do not raise past 1280 — 1920 at 2 Mbps looks worse
    // on motion than 1280 does.
    get TOPSHELF_RENDER_MAX_WIDTH(): number {
        return getNumber('TOPSHELF_RENDER_MAX_WIDTH', env.TOPSHELF_RENDER_MAX_WIDTH, 1280);
    },
    // Base render height (pixels) for Top Shelf artifacts, 16:9 with the width.
    // The overlay path cover-crops the base to exactly this height (tvOS
    // aspect-fills the shelf, so anything outside 16:9 is cut on the device);
    // the plain path still scales with `-2` and keeps the source aspect.
    get TOPSHELF_RENDER_MAX_HEIGHT(): number {
        return getNumber('TOPSHELF_RENDER_MAX_HEIGHT', env.TOPSHELF_RENDER_MAX_HEIGHT, 720);
    },
    // Render concurrency cap (AsyncSemaphore permits) for Top Shelf ffmpeg jobs.
    get TOPSHELF_MAX_CONCURRENT_RENDERS(): number {
        return getNumber('TOPSHELF_MAX_CONCURRENT_RENDERS', env.TOPSHELF_MAX_CONCURRENT_RENDERS, 1);
    },
    // Max number of Top Shelf renders allowed to be queued/in-flight at once.
    // Beyond this, mint responds 202 without enqueueing a new render (natural
    // retry via the next Home load).
    get TOPSHELF_MAX_PENDING_RENDERS(): number {
        return getNumber('TOPSHELF_MAX_PENDING_RENDERS', env.TOPSHELF_MAX_PENDING_RENDERS, 24);
    },
    // Mint rate limit: requests per user per 5-minute window.
    get TOPSHELF_MINT_RATE_LIMIT(): number {
        return getNumber('TOPSHELF_MINT_RATE_LIMIT', env.TOPSHELF_MINT_RATE_LIMIT, 240);
    },
    // Default corner the Top Shelf overlay anchors to when a client doesn't
    // request one explicitly.
    get TOPSHELF_OVERLAY_DEFAULT_POSITION(): 'tl' | 'tr' | 'bl' | 'br' {
        return getEnum(
            'TOPSHELF_OVERLAY_DEFAULT_POSITION',
            env.TOPSHELF_OVERLAY_DEFAULT_POSITION,
            ['tl', 'tr', 'bl', 'br'],
            'tl',
        );
    },
    // Whether the overlay draws a scrim behind its text by default, for
    // legibility over bright/high-contrast source frames.
    get TOPSHELF_OVERLAY_DEFAULT_SCRIM(): boolean {
        return getBool('TOPSHELF_OVERLAY_DEFAULT_SCRIM', env.TOPSHELF_OVERLAY_DEFAULT_SCRIM, true);
    },
    // Default overlay scale, as a fraction of the rendered frame's shorter
    // dimension.
    get TOPSHELF_OVERLAY_DEFAULT_SCALE(): number {
        return getFloat('TOPSHELF_OVERLAY_DEFAULT_SCALE', env.TOPSHELF_OVERLAY_DEFAULT_SCALE, 0.4);
    },
    // Safe-area padding (fraction of frame) kept clear of overlay content on
    // every edge, so text/logos don't bleed under tvOS's own chrome. 0.055
    // (~5.5%) matches TV overscan/title-safe convention — a real Apple TV
    // report showed a wide logo's leading edge clipped on the left at the
    // previous 0.04.
    get TOPSHELF_OVERLAY_SAFE_PADDING(): number {
        return getFloat('TOPSHELF_OVERLAY_SAFE_PADDING', env.TOPSHELF_OVERLAY_SAFE_PADDING, 0.055);
    },
    // Locales the overlay renders text for, comma-separated BCP-47-ish codes
    // (e.g. "en,de"). Normalized lowercase; blank entries dropped.
    get TOPSHELF_OVERLAY_TEXT_LOCALES(): string[] {
        return getArray(
            'TOPSHELF_OVERLAY_TEXT_LOCALES',
            env.TOPSHELF_OVERLAY_TEXT_LOCALES,
            'en',
        ).map((locale) => locale.toLowerCase());
    },

    // =========================================================================
    // FFmpeg HLS Transcoding
    // =========================================================================

    // Path to FFmpeg binary (jellyfin-ffmpeg or system FFmpeg).
    // Default: bare 'ffmpeg' so bare-metal / npm-run-dev installs that have not
    // set FFMPEG_PATH get the soft "Not verified (no absolute path set)" message
    // from checkBinary() rather than a false "Not found or not executable" CRITICAL
    // (which fired because /config/bin/ffmpeg does not exist outside Docker).
    // Docker: fetch-ffmpeg.sh sets FFMPEG_PATH=/config/bin/ffmpeg in the container
    // environment — that explicit env value takes precedence over this default, so
    // the Docker runtime path is unaffected.
    get FFMPEG_PATH(): string {
        return getString('FFMPEG_PATH', env.FFMPEG_PATH, 'ffmpeg');
    },

    // Path to FFprobe binary (for media analysis).
    // Same bare-name default rationale as FFMPEG_PATH above.
    // Docker sets FFPROBE_PATH explicitly; bare-metal falls back to 'ffprobe' (PATH).
    get FFPROBE_PATH(): string {
        return getString('FFPROBE_PATH', env.FFPROBE_PATH, 'ffprobe');
    },

    // Directory for transcode output files (should be fast storage)
    // Segments are written here during playback and cleaned up when session ends
    get FFMPEG_TRANSCODE_DIR(): string {
        return getString(
            'FFMPEG_TRANSCODE_DIR',
            env.FFMPEG_TRANSCODE_DIR,
            '/tmp/lumastra-transcode',
        );
    },

    // HLS segment duration in seconds (Apple recommends 6)
    get FFMPEG_SEGMENT_DURATION(): number {
        return getNumber('FFMPEG_SEGMENT_DURATION', env.FFMPEG_SEGMENT_DURATION, 6);
    },

    // Inactivity timeout in seconds (job killed if no segment requests AND no
    // progress reports). For a COMPLETED job (all segments already on disk,
    // no ffmpeg process running) this is the only signal the reaper has, so it
    // must comfortably outlast normal browser heartbeat gaps: the web client's
    // keepalive is a plain 30s setInterval (see playerStore.startProgressReporting),
    // which browsers throttle heavily — sometimes to ~once/minute or less — for a
    // paused, backgrounded/minimized tab (worse on mobile, where a hidden tab can
    // be frozen for many minutes). A paused-and-tabbed-away viewer is normal usage,
    // not an abandoned session, so 300s (prod incident 2026-08-18: a paused,
    // backgrounded tab was reaped after 5m29s, leaving the client with a 410 it
    // had to recover from) is too tight. 1800s matches the existing audio-drop
    // retention window's reasoning below — keeping a produced job around is cheap.
    get FFMPEG_INACTIVITY_TIMEOUT_SECONDS(): number {
        return getNumber(
            'FFMPEG_INACTIVITY_TIMEOUT_SECONDS',
            env.FFMPEG_INACTIVITY_TIMEOUT_SECONDS,
            1800,
        );
    },

    // Progress heartbeat timeout in seconds (job killed if no progress reports).
    // Only reached by a job that is STILL actively encoding (ffmpeg running) —
    // completed jobs use FFMPEG_INACTIVITY_TIMEOUT_SECONDS above instead. Heartbeats
    // are event-driven (seek/pause/resume/stop) plus a 30s keepalive interval, not a
    // steady 10s cadence, so this stays short specifically to catch a genuinely
    // stuck/crashed encoder quickly rather than a background-tab client gap.
    get FFMPEG_PROGRESS_TIMEOUT_SECONDS(): number {
        return getNumber(
            'FFMPEG_PROGRESS_TIMEOUT_SECONDS',
            env.FFMPEG_PROGRESS_TIMEOUT_SECONDS,
            120,
        );
    },

    // Retention window (seconds) for 'audio-drop' jobs (the -vn audio-only rung),
    // used in place of FFMPEG_PROGRESS_TIMEOUT_SECONDS / FFMPEG_INACTIVITY_TIMEOUT_SECONDS
    // in ALL THREE of cleanupInactiveJobs' reaper checks (the completed-job
    // check, the progress-heartbeat check, and the segment-access fallback) —
    // every one of them must use this same extended value, or an audio-drop
    // job that clears one check still falls through to a check still running
    // the normal 120s/300s timeouts. Progress heartbeats are HTTP, so an
    // offline client (e.g. mid-tunnel) can't send them, and a satisfied deep
    // client buffer can independently stop segment fetches with no tunnel at
    // all. Longer than the video defaults because a full episode of AAC audio
    // is only ~43 MB — cheap to keep around.
    get FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS(): number {
        return getNumber(
            'FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS',
            env.FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS,
            1800,
        );
    },

    // A job that has produced segments (ffmpeg is writing to disk) but has never
    // served a single segment to a client is a spawned-but-abandoned session
    // (e.g. a client that fetched the manifest but never pulled a segment).
    // The normal progress-heartbeat/inactivity timeouts above don't catch this
    // quickly because ffmpeg keeps sending progress heartbeats regardless of
    // whether anyone is reading the output. Reap these much sooner than a
    // full inactivity timeout to bound wasted disk/CPU.
    get FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS(): number {
        return getNumber(
            'FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS',
            env.FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS,
            60,
        );
    },

    // A job that is still ENCODING is stopped (dormant, restorable) once its
    // client has shown no activity for this long: no heartbeat (to any pod), no
    // segment or playlist fetch. FFmpeg's own progress does not count, so an
    // abandoned job no longer encodes the rest of the file at full speed. The
    // web player heartbeats every 30s (hidden tabs throttle to ~1/min), so 180s
    // tolerates two missed beats. 'audio-drop' jobs use
    // FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS instead.
    get FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS(): number {
        return getNumber(
            'FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS',
            env.FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS,
            180,
        );
    },

    // Maximum concurrent FFmpeg jobs per user
    get FFMPEG_MAX_JOBS_PER_USER(): number {
        return getNumber('FFMPEG_MAX_JOBS_PER_USER', env.FFMPEG_MAX_JOBS_PER_USER, 10);
    },

    // Kill-switch for the per-user concurrent-stream limit (VOD, enforced at
    // session start and at the HLS manifest). When off, that check is skipped
    // everywhere — other policy checks (IP restriction, allowed play methods)
    // still apply. Useful for debugging.
    get STREAM_LIMITS_ENFORCED(): boolean {
        return getBool('STREAM_LIMITS_ENFORCED', env.STREAM_LIMITS_ENFORCED, true);
    },

    // Whether a client's "I am playing a file I already downloaded" claim
    // (`is_local_playback` on POST /play-sessions) exempts that session from the
    // concurrent-stream limit.
    //
    // OFF BY DEFAULT, and the default is the interesting part. The claim is
    // structurally unverifiable: local playback sends the server no bytes, so
    // there is nothing to observe that would corroborate or refute it. A
    // modified client could send the flag on every session and opt itself out of
    // the limit entirely — which would quietly turn a server-enforced cap into
    // an honour system for every existing install.
    //
    // Off does NOT mean the flag is ignored: the row is still stamped
    // `source = 'local'`, so it is labelled "Downloaded" in Active Streams,
    // graded with first-party freshness, and reaped on the right schedule. Only
    // the stream-limit exemption is withheld. Operators who trust the apps their
    // users run turn it on and get the exemption too.
    get TRUST_CLIENT_LOCAL_PLAYBACK(): boolean {
        return getBool('TRUST_CLIENT_LOCAL_PLAYBACK', env.TRUST_CLIENT_LOCAL_PLAYBACK, false);
    },

    // Global default for max parallel streams per user, used when neither a
    // per-user nor a `__default__` row exists in user_stream_policies.
    // -1 (UNLIMITED_CONCURRENT_STREAMS) = no limit, the default: a self-hosted
    // server shouldn't cap its own household unless the admin asks for it.
    get DEFAULT_MAX_CONCURRENT_STREAMS(): number {
        return getNumber('DEFAULT_MAX_CONCURRENT_STREAMS', env.DEFAULT_MAX_CONCURRENT_STREAMS, -1);
    },

    // Server-wide cap on concurrently active transcode jobs across all users.
    // Sits above the per-user cap so the total process count is bounded even
    // when many users each stay below their individual limit.
    // Default: videoTranscodeConcurrencyDefault(cpuCores) — see that function's
    // doc comment; kept in sync with the admin UI's displayed default via the
    // schema's dynamicDefault for the same key.
    get LUMASTRA_MAX_CONCURRENT_TRANSCODES(): number {
        return getNumber(
            'LUMASTRA_MAX_CONCURRENT_TRANSCODES',
            env.LUMASTRA_MAX_CONCURRENT_TRANSCODES,
            videoTranscodeConcurrencyDefault(getCpuBudgetCores()),
        );
    },

    // Minimum idle time before the server-wide cap may evict a transcode job.
    // "Idle" is measured from max(heartbeat, segment fetch) — see
    // filterEvictableByIdle. Default 120s = four missed 30s play-session
    // heartbeats, well below the 5-minute stale-session reaper. <= 0 = no floor
    // (legacy: always evict the idlest job, even one still playing).
    get LUMASTRA_TRANSCODE_EVICTION_MIN_IDLE_SECONDS(): number {
        return getNumber(
            'LUMASTRA_TRANSCODE_EVICTION_MIN_IDLE_SECONDS',
            env.LUMASTRA_TRANSCODE_EVICTION_MIN_IDLE_SECONDS,
            120,
        );
    },

    // Maximum active FFmpeg generations kept per playback session.
    // current = newest seek position, previous = retained briefly for stale requests.
    get FFMPEG_MAX_GENERATIONS_PER_SESSION(): number {
        return getNumber(
            'FFMPEG_MAX_GENERATIONS_PER_SESSION',
            env.FFMPEG_MAX_GENERATIONS_PER_SESSION,
            2,
        );
    },

    // How long to keep the previous FFmpeg generation alive after its last access.
    get FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS(): number {
        return getNumber(
            'FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS',
            env.FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS,
            20,
        );
    },

    // Number of segments to keep behind playback position for rewind capability
    // At 6-second segments: 100 segments = 10 minutes of rewind buffer
    // Higher = more rewind capability, more disk usage
    // Lower = less disk usage, seeking back may require stream restart
    get FFMPEG_SEGMENT_KEEP_BEHIND(): number {
        return getNumber('FFMPEG_SEGMENT_KEEP_BEHIND', env.FFMPEG_SEGMENT_KEEP_BEHIND, 100);
    },

    // Number of segments ahead that triggers a forward seek (FFmpeg restart)
    // When client requests a segment this far ahead of current progress, FFmpeg restarts from that position
    // At 6-second segments: 15 segments = 90 seconds
    // Lower = faster response to seeks, more FFmpeg restarts
    // Higher = more waiting for transcoding to catch up, fewer restarts
    get FFMPEG_FORWARD_SEEK_THRESHOLD(): number {
        return getNumber('FFMPEG_FORWARD_SEEK_THRESHOLD', env.FFMPEG_FORWARD_SEEK_THRESHOLD, 15);
    },

    // HLS segment request tuning. These control how the segment API waits,
    // deduplicates seeks, and reports stale hls.js request pressure.
    get HLS_SEEK_WAIT_TIMEOUT_MS(): number {
        return getNumber('HLS_SEEK_WAIT_TIMEOUT_MS', env.HLS_SEEK_WAIT_TIMEOUT_MS, 45_000);
    },
    get HLS_SEGMENT_WAIT_TIMEOUT_MS(): number {
        return getNumber('HLS_SEGMENT_WAIT_TIMEOUT_MS', env.HLS_SEGMENT_WAIT_TIMEOUT_MS, 10_000);
    },
    get HLS_IFRAME_WAIT_TIMEOUT_MS(): number {
        return getNumber('HLS_IFRAME_WAIT_TIMEOUT_MS', env.HLS_IFRAME_WAIT_TIMEOUT_MS, 30_000);
    },
    get HLS_SEGMENT_POLL_INTERVAL_MS(): number {
        return getNumber('HLS_SEGMENT_POLL_INTERVAL_MS', env.HLS_SEGMENT_POLL_INTERVAL_MS, 100);
    },
    get HLS_SEGMENT_LOG_INTERVAL_MS(): number {
        return getNumber('HLS_SEGMENT_LOG_INTERVAL_MS', env.HLS_SEGMENT_LOG_INTERVAL_MS, 5_000);
    },
    get HLS_SEEK_COOLDOWN_MS(): number {
        return getNumber('HLS_SEEK_COOLDOWN_MS', env.HLS_SEEK_COOLDOWN_MS, 5_000);
    },
    get HLS_REPEATED_SEGMENT_WINDOW_MS(): number {
        return getNumber(
            'HLS_REPEATED_SEGMENT_WINDOW_MS',
            env.HLS_REPEATED_SEGMENT_WINDOW_MS,
            15_000,
        );
    },
    get HLS_REPEATED_SEGMENT_PRESSURE_THRESHOLD(): number {
        return getNumber(
            'HLS_REPEATED_SEGMENT_PRESSURE_THRESHOLD',
            env.HLS_REPEATED_SEGMENT_PRESSURE_THRESHOLD,
            2,
        );
    },
    get HLS_REPEATED_PRESSURE_FORWARD_SEEK_THRESHOLD(): number {
        return getNumber(
            'HLS_REPEATED_PRESSURE_FORWARD_SEEK_THRESHOLD',
            env.HLS_REPEATED_PRESSURE_FORWARD_SEEK_THRESHOLD,
            10,
        );
    },
    get HLS_STALE_AUDIO_WARNING_COOLDOWN_MS(): number {
        return getNumber(
            'HLS_STALE_AUDIO_WARNING_COOLDOWN_MS',
            env.HLS_STALE_AUDIO_WARNING_COOLDOWN_MS,
            10_000,
        );
    },
    get HLS_STALE_AUDIO_REQUEST_AHEAD_THRESHOLD(): number {
        return getNumber(
            'HLS_STALE_AUDIO_REQUEST_AHEAD_THRESHOLD',
            env.HLS_STALE_AUDIO_REQUEST_AHEAD_THRESHOLD,
            150,
        );
    },
    get HLS_FAR_FROM_ORIGIN_THRESHOLD(): number {
        return getNumber('HLS_FAR_FROM_ORIGIN_THRESHOLD', env.HLS_FAR_FROM_ORIGIN_THRESHOLD, 200);
    },

    // Synthetic I-frame interval in seconds for scrubbing thumbnails
    // Controls how often I-frame thumbnails appear during video scrubbing
    // Higher = fewer I-frames, less bandwidth/processing, coarser scrubbing
    // Lower = more I-frames, more bandwidth/processing, finer scrubbing
    // 0 = use all trickplay thumbnails (finest scrubbing, matches Jellyfin's interval)
    get SYNTHETIC_IFRAME_INTERVAL_SECONDS(): number {
        return getNumber(
            'SYNTHETIC_IFRAME_INTERVAL_SECONDS',
            env.SYNTHETIC_IFRAME_INTERVAL_SECONDS,
            0,
        );
    },

    // Debug subtitles mode - generates per-second timing cues instead of real subtitles
    // Shows "[MM:SS|R]" each second to diagnose AVPlayer X-TIMESTAMP-MAP timing issues
    // If displayed time matches video time = timing correct, if offset = baseline wrong
    // Display format: [MM:SS | seg:N | mpegts:0]
    // Can also be triggered with ?debug_subs=1 on master playlist URL
    get DEBUG_SUBTITLES(): boolean {
        return getBool('DEBUG_SUBTITLES', env.DEBUG_SUBTITLES, false);
    },

    /** Debug knob: 'log' validates /j JSON responses against the Jellyfin SDK contract and logs violations (dev/preprod). Unset = off. */
    get JELLYFIN_CONTRACT_VALIDATE(): 'log' | 'off' {
        return getEnum(
            'JELLYFIN_CONTRACT_VALIDATE',
            env.JELLYFIN_CONTRACT_VALIDATE,
            ['log', 'off'],
            'off',
        );
    },

    // =========================================================================
    // Full FFmpeg Transcoding Mode
    // =========================================================================
    // Single FFmpeg pipeline with local file input.
    // GPU-accelerated video encoding when available.

    get TRANSCODING_MODE(): 'full' {
        return getEnum('TRANSCODING_MODE', env.TRANSCODING_MODE, ['full'], 'full');
    },

    // GPU acceleration type: 'none', 'nvenc', 'qsv', 'vaapi', 'amf', 'videotoolbox'
    // - 'none': Software encoding only (libx264/libx265)
    // - 'nvenc': NVIDIA GPU encoding
    // - 'qsv': Intel Quick Sync Video
    // - 'vaapi': Video Acceleration API (Intel/AMD on Linux)
    // - 'amf': AMD AMF (Windows)
    // - 'videotoolbox': macOS hardware encoding
    get GPU_ACCELERATION(): 'none' | 'nvenc' | 'qsv' | 'vaapi' | 'amf' | 'videotoolbox' {
        return getEnum(
            'GPU_ACCELERATION',
            env.GPU_ACCELERATION,
            ['none', 'nvenc', 'qsv', 'vaapi', 'amf', 'videotoolbox'],
            'none',
        );
    },

    // VAAPI device path (for GPU_ACCELERATION=vaapi)
    get VAAPI_DEVICE(): string {
        return getString('VAAPI_DEVICE', env.VAAPI_DEVICE, '/dev/dri/renderD128');
    },

    // QSV device path (for GPU_ACCELERATION=qsv, leave empty for auto-detection)
    get QSV_DEVICE(): string {
        return getString('QSV_DEVICE', env.QSV_DEVICE, '');
    },

    // NVENC preset: p1 (fastest) to p7 (best quality)
    get NVENC_PRESET(): 'p1' | 'p2' | 'p3' | 'p4' | 'p5' | 'p6' | 'p7' {
        return getEnum(
            'NVENC_PRESET',
            env.NVENC_PRESET,
            ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'],
            'p4',
        );
    },

    // NVENC tune mode: optimize for specific use cases
    // - 'hq': High quality (default, best for video)
    // - 'll': Low latency (streaming)
    // - 'ull': Ultra low latency (real-time)
    // - 'lossless': Lossless encoding
    get NVENC_TUNE(): '' | 'hq' | 'll' | 'ull' | 'lossless' {
        return getEnum('NVENC_TUNE', env.NVENC_TUNE, ['', 'hq', 'll', 'ull', 'lossless'], '');
    },

    // NVENC rate control mode
    // - 'auto': Let FFmpeg decide based on other settings
    // - 'constqp': Constant QP (quality)
    // - 'vbr': Variable bitrate
    // - 'cbr': Constant bitrate
    get NVENC_RC(): 'auto' | 'constqp' | 'vbr' | 'cbr' {
        return getEnum('NVENC_RC', env.NVENC_RC, ['auto', 'constqp', 'vbr', 'cbr'], 'auto');
    },

    // NVENC constant quality (0-51, lower = better quality)
    // Only used when NVENC_RC is 'constqp' or 'vbr'
    get NVENC_CQ(): number {
        return getNumber('NVENC_CQ', env.NVENC_CQ, 23);
    },

    // VideoToolbox prio_speed (macOS): 0 = quality, 1 = speed
    // Prioritizes encoding quality or speed for Apple's hardware encoder
    get VIDEOTOOLBOX_PRIO_SPEED(): boolean {
        return getBool('VIDEOTOOLBOX_PRIO_SPEED', env.VIDEOTOOLBOX_PRIO_SPEED, false);
    },

    // AMF quality preset (AMD GPUs): 'quality', 'balanced', or 'speed'
    // Affects encoding quality vs performance tradeoff
    get AMF_QUALITY(): 'quality' | 'balanced' | 'speed' {
        return getEnum(
            'AMF_QUALITY',
            env.AMF_QUALITY,
            ['quality', 'balanced', 'speed'],
            'balanced',
        );
    },

    // Video codec for full transcode mode
    // Options: 'copy' (passthrough), 'h264', 'hevc', 'av1'
    // - 'copy': Pass through video without re-encoding (fastest, no quality loss)
    // - 'h264': Transcode to H.264 (most compatible)
    // - 'hevc': Transcode to HEVC/H.265 (better compression)
    // - 'av1': Transcode to AV1 (best compression, newest devices only)
    get VIDEO_CODEC(): string {
        return getString('VIDEO_CODEC', env.VIDEO_CODEC, 'copy');
    },

    // Auto-detect best encoder based on GPU capabilities
    // When true, the system will probe FFmpeg for available encoders and select
    // the best hardware encoder automatically (e.g., h264_nvenc, hevc_qsv, av1_vaapi)
    // When false, uses VIDEO_CODEC setting directly
    get VIDEO_CODEC_AUTO(): boolean {
        return getBool('VIDEO_CODEC_AUTO', env.VIDEO_CODEC_AUTO, true);
    },

    // Video bitrate in Mbps (for non-CRF encoding, 0 = use CRF instead)
    get VIDEO_BITRATE_MBPS(): number {
        return getNumber('VIDEO_BITRATE_MBPS', env.VIDEO_BITRATE_MBPS, 0);
    },

    // Maximum output resolution (0 = no limit, preserve source)
    get MAX_WIDTH(): number {
        return getNumber('MAX_WIDTH', env.MAX_WIDTH, 0);
    },
    get MAX_HEIGHT(): number {
        return getNumber('MAX_HEIGHT', env.MAX_HEIGHT, 0);
    },
    // When ON and the host has NO GPU, cap CPU video transcodes to 1080p for
    // sources taller than 1080p. A 4K (especially HDR/Dolby-Vision) CPU encode
    // typically runs below real-time and can't sustain HLS playback (and gets
    // reaped mid-encode → FFmpeg failure). Downscaling to 1080p keeps it
    // playable. Default ON — the right choice for a GPU-less box; turn OFF if
    // your CPU is strong enough to transcode 4K in real time.
    get TRANSCODE_DOWNSCALE_CPU_TO_1080P(): boolean {
        return getBool(
            'TRANSCODE_DOWNSCALE_CPU_TO_1080P',
            env.TRANSCODE_DOWNSCALE_CPU_TO_1080P,
            true,
        );
    },

    // HDR to SDR tonemapping (when device doesn't support HDR)
    // Enable automatic tonemapping for HDR content on SDR devices
    get ENABLE_TONEMAPPING(): boolean {
        return getBool('ENABLE_TONEMAPPING', env.ENABLE_TONEMAPPING, true);
    },

    // Tonemapping algorithm: 'bt2390', 'hable', 'mobius', 'reinhard', 'linear'
    // 'bt2390' is the most accurate for broadcast content
    get TONEMAPPING_ALGORITHM(): string {
        return getString('TONEMAPPING_ALGORITHM', env.TONEMAPPING_ALGORITHM, 'bt2390');
    },

    // How to reconcile subtitle burn-in with an HDR (10-bit) source.
    //
    // A CPU subtitle overlay forces frames through 8-bit system memory, but a GPU
    // HEVC encoder configured for an HDR source uses the Main10 (10-bit) profile.
    // Main10 over 8-bit frames makes hevc_qsv/hevc_vaapi fail to open ("Current
    // profile is unsupported") and FFmpeg exits immediately. Two ways out:
    //   'tonemap'  (default) — keep the GPU encoder; tonemap HDR→SDR before the
    //              overlay so the output is a matching 8-bit SDR (Main) stream.
    //   'software' — keep HDR by encoding in software (libx265, 10-bit). Costs CPU.
    // Demux copy-video GOP mode (services/hls/gop-grid.ts): FFmpeg writes one file
    // per keyframe and the server joins them into exact keyframe-grid segments, so
    // every seek generation declares the times it really serves. Off = the legacy
    // 10 s cut, whose declared times drift up to one GOP after a seek or resume.
    get HLS_COPY_GOP_SEGMENTS(): boolean {
        return getBool('HLS_COPY_GOP_SEGMENTS', env.HLS_COPY_GOP_SEGMENTS, true);
    },

    get HLS_BURN_IN_HDR_STRATEGY(): 'tonemap' | 'software' {
        const value = getString(
            'HLS_BURN_IN_HDR_STRATEGY',
            env.HLS_BURN_IN_HDR_STRATEGY,
            'tonemap',
        );
        return value === 'software' ? 'software' : 'tonemap';
    },

    // Audio codec for full transcode mode
    get AUDIO_CODEC(): string {
        return getString('AUDIO_CODEC', env.AUDIO_CODEC, 'aac');
    },

    // Audio bitrates for stereo and surround tracks
    get AUDIO_BITRATE_STEREO(): string {
        return getString('AUDIO_BITRATE_STEREO', env.AUDIO_BITRATE_STEREO, '128k');
    },
    get AUDIO_BITRATE_SURROUND(): string {
        return getString('AUDIO_BITRATE_SURROUND', env.AUDIO_BITRATE_SURROUND, '256k');
    },

    // =========================================================================
    // Hardware Decoding Options
    // =========================================================================

    // Enable hardware decoding for specific codecs (comma-separated)
    // Options: h264,hevc,mpeg2,vc1,vp8,vp9,av1
    get HW_DECODE_CODECS(): string {
        return getString('HW_DECODE_CODECS', env.HW_DECODE_CODECS, 'h264,hevc,mpeg2,vp9,av1');
    },

    // Enable 10-bit hardware decoding (comma-separated)
    // Options: hevc,vp9
    get HW_DECODE_10BIT(): string {
        return getString('HW_DECODE_10BIT', env.HW_DECODE_10BIT, 'hevc,vp9');
    },

    // Prefer OS native DXVA or VA-API hardware decoders
    get HW_PREFER_NATIVE_DECODERS(): boolean {
        return getBool('HW_PREFER_NATIVE_DECODERS', env.HW_PREFER_NATIVE_DECODERS, true);
    },

    // Enable enhanced NVDEC decoder (NVIDIA only)
    // Enhanced NVDEC implementation. Disable to use CUVID if you encounter decoding errors.
    get NVDEC_ENHANCED(): boolean {
        return getBool('NVDEC_ENHANCED', env.NVDEC_ENHANCED, true);
    },

    // =========================================================================
    // Hardware Encoding Options
    // =========================================================================

    // Enable hardware encoding (master switch)
    get HW_ENCODING_ENABLED(): boolean {
        return getBool('HW_ENCODING_ENABLED', env.HW_ENCODING_ENABLED, true);
    },

    // Enable Intel Low-Power H.264 encoder (QSV only)
    // Uses less power and is faster, but may have slightly lower quality on some hardware
    get INTEL_LP_H264(): boolean {
        return getBool('INTEL_LP_H264', env.INTEL_LP_H264, true);
    },

    // Enable Intel Low-Power HEVC encoder (QSV only)
    // Uses less power and is faster, but may have slightly lower quality on some hardware
    get INTEL_LP_HEVC(): boolean {
        return getBool('INTEL_LP_HEVC', env.INTEL_LP_HEVC, true);
    },

    // Allow encoding in HEVC format
    get ALLOW_HEVC_ENCODING(): boolean {
        return getBool('ALLOW_HEVC_ENCODING', env.ALLOW_HEVC_ENCODING, true);
    },

    // Allow encoding in AV1 format
    get ALLOW_AV1_ENCODING(): boolean {
        return getBool('ALLOW_AV1_ENCODING', env.ALLOW_AV1_ENCODING, true);
    },

    // Allow AV1 as transcode target for Chrome/Firefox (hls.js / MSE-HLS clients).
    // Off by default — hls.js fMP4 AV1 parsing is unreliable across browsers and
    // will trigger fragParsingError. Safari (native HLS) and direct-file clients
    // are not affected by this flag and always allow AV1 when eligible.
    get ALLOW_AV1_MSE_HLS(): boolean {
        return getBool('ALLOW_AV1_MSE_HLS', env.ALLOW_AV1_MSE_HLS, false);
    },

    // Cap output resolution when the server has no GPU encoder (software fallback
    // path). libsvtav1 and libx265 cannot meet real-time at 4K on typical CPUs;
    // libx264 is the only software encoder reliably fast enough for 4K. When the
    // source is wider than this value and only software encoding is available,
    // the codec selector forces h264. 0 = no cap.
    get SOFTWARE_ENCODE_MAX_WIDTH(): number {
        return getNumber('SOFTWARE_ENCODE_MAX_WIDTH', env.SOFTWARE_ENCODE_MAX_WIDTH, 1920);
    },

    // Codec priority order for the software-encode fallback pass (comma-separated).
    // Default prefers h264 because libx264 is the fastest software encoder by a
    // wide margin; libx265 and libsvtav1 routinely miss real-time on modest CPUs.
    get SOFTWARE_CODEC_PREFERENCE(): string {
        return getString(
            'SOFTWARE_CODEC_PREFERENCE',
            env.SOFTWARE_CODEC_PREFERENCE,
            'h264,hevc,av1',
        );
    },

    // =========================================================================
    // Tone Mapping (HDR to SDR)
    // =========================================================================

    // (No VPP_TONEMAPPING toggle: GPU HDR->SDR tonemapping is automatic for GPU
    // encoders — see enableTonemapping() in ffmpeg-args-builder.ts. The QSV
    // brightness/contrast knobs below still fine-tune the QSV vpp_qsv tonemap.)

    // VPP Tone mapping brightness gain (default: 16, recommended: 0-16)
    get VPP_TONEMAPPING_BRIGHTNESS(): number {
        return getNumber('VPP_TONEMAPPING_BRIGHTNESS', env.VPP_TONEMAPPING_BRIGHTNESS, 16);
    },

    // VPP Tone mapping contrast gain (default: 1, recommended: 1)
    get VPP_TONEMAPPING_CONTRAST(): number {
        return getFloat('VPP_TONEMAPPING_CONTRAST', env.VPP_TONEMAPPING_CONTRAST, 1.0);
    },

    // Desaturation for highlights (0-1, default: 0.5)
    // Higher values preserve more color, lower values fade to white
    get TONEMAPPING_DESAT(): number {
        return getFloat('TONEMAPPING_DESAT', env.TONEMAPPING_DESAT, 0.5);
    },

    // Override signal peak (0 = auto-detect from metadata, default: 0)
    get TONEMAPPING_PEAK(): number {
        return getNumber('TONEMAPPING_PEAK', env.TONEMAPPING_PEAK, 0);
    },

    // Tone mapping algorithm parameter (0 = use the algorithm's own default)
    get TONEMAPPING_PARAM(): number {
        return getFloat('TONEMAPPING_PARAM', env.TONEMAPPING_PARAM, 0);
    },

    // =========================================================================
    // HDR10 Output Preservation
    // =========================================================================

    // Enable HDR10 output preservation when transcoding HDR content
    // When true and device supports HDR but not DV, DV Profile 8 content will fall back to HDR10
    // When false, all HDR content will be tonemapped to SDR when transcoding
    get ENABLE_HDR10_PRESERVATION(): boolean {
        return getBool('ENABLE_HDR10_PRESERVATION', env.ENABLE_HDR10_PRESERVATION, true);
    },

    // =========================================================================
    // Transcoding Performance
    // =========================================================================

    // Maximum threads for transcoding (0 = auto, based on CPU cores)
    get TRANSCODE_THREAD_COUNT(): number {
        return getNumber('TRANSCODE_THREAD_COUNT', env.TRANSCODE_THREAD_COUNT, 0);
    },

    // Maximum threads per FFmpeg analysis operation — chromaprint, blackframe, silence (0 = auto)
    get ANALYSIS_FFMPEG_THREADS(): number {
        return getNumber('ANALYSIS_FFMPEG_THREADS', env.ANALYSIS_FFMPEG_THREADS, 2);
    },

    // Encoding preset: 'ultrafast', 'superfast', 'veryfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'
    // Faster = lower CPU usage but lower quality, Slower = higher quality but more CPU
    get ENCODING_PRESET(): string {
        return getString('ENCODING_PRESET', env.ENCODING_PRESET, 'veryfast');
    },

    // CRF for H.264 software encoding (0-51, default: 23)
    // Lower = better quality but larger files
    get H264_CRF(): number {
        return getNumber('H264_CRF', env.H264_CRF, 23);
    },

    // CRF for H.265/HEVC software encoding (0-51, default: 28)
    get H265_CRF(): number {
        return getNumber('H265_CRF', env.H265_CRF, 28);
    },

    // Max muxing queue size (default: 9999)
    // High value needed for AV1 seeking where audio decodes faster than video,
    // preventing "Too many packets buffered for output stream" crashes
    get MAX_MUXING_QUEUE_SIZE(): number {
        return getNumber('MAX_MUXING_QUEUE_SIZE', env.MAX_MUXING_QUEUE_SIZE, 9999);
    },

    // =========================================================================
    // Deinterlacing
    // =========================================================================

    // Deinterlacing method: 'yadif', 'bwdif', 'w3fdif'
    // Used for software transcoding of interlaced content
    get DEINTERLACE_METHOD(): string {
        return getString('DEINTERLACE_METHOD', env.DEINTERLACE_METHOD, 'yadif');
    },

    // Double frame rate when deinterlacing (bob deinterlacing)
    // Uses field rate instead of frame rate for full motion
    get DEINTERLACE_DOUBLE_RATE(): boolean {
        return getBool('DEINTERLACE_DOUBLE_RATE', env.DEINTERLACE_DOUBLE_RATE, false);
    },

    // =========================================================================
    // Audio Transcoding
    // =========================================================================

    // Enable VBR (Variable Bitrate) audio encoding
    // Better quality-to-size ratio but may cause buffering issues
    get AUDIO_VBR(): boolean {
        return getBool('AUDIO_VBR', env.AUDIO_VBR, true);
    },

    // Audio boost when downmixing (1.0 = preserve original volume)
    get AUDIO_BOOST(): number {
        return getFloat('AUDIO_BOOST', env.AUDIO_BOOST, 1.0);
    },

    // =========================================================================
    // Subtitle Handling
    // =========================================================================

    // Max total bytes for the extracted-subtitle cache (text .vtt + binary
    // .sup/.sub/.render). Enforced coldest-first, independent of TTL, after
    // the periodic TTL sweep — see subtitle-file-cache.service.ts cleanup().
    // Default: 2 GiB. Set to 0 to disable budget enforcement.
    get SUBTITLE_CACHE_MAX_BYTES(): number {
        return getNumber(
            'SUBTITLE_CACHE_MAX_BYTES',
            env.SUBTITLE_CACHE_MAX_BYTES,
            50 * 1024 * 1024 * 1024,
        );
    },

    // =========================================================================
    // Throttling and Segment Management
    // =========================================================================

    // Throttle transcodes when buffer is healthy
    // Pauses transcode when far ahead of playback to reduce resource usage
    get TRANSCODE_THROTTLE(): boolean {
        return getBool('TRANSCODE_THROTTLE', env.TRANSCODE_THROTTLE, true);
    },

    // Seconds after which transcoder will be throttled (default: 120)
    get THROTTLE_AFTER_SECONDS(): number {
        return getNumber('THROTTLE_AFTER_SECONDS', env.THROTTLE_AFTER_SECONDS, 120);
    },

    // Delete old segments after download
    // Prevents storing entire transcoded file on disk
    get DELETE_SEGMENTS(): boolean {
        return getBool('DELETE_SEGMENTS', env.DELETE_SEGMENTS, true);
    },

    // =========================================================================
    // OAuth 2.0 Device Authorization Grant (for TV apps, CLI tools)
    // =========================================================================

    // Enable device authorization flow for external clients (TV apps, etc.)
    // When enabled, exposes /oauth/* and the token surface on /api/v1/* endpoints.
    // Default ON since v0.1 (native apps need it); fallback must match schema.ts.
    get FEATURE_DEVICE_AUTH(): boolean {
        return getBool('FEATURE_DEVICE_AUTH', env.FEATURE_DEVICE_AUTH, true);
    },

    // JWT secret for signing tokens.
    // Required for HLS stream tokens and FEATURE_DEVICE_AUTH=true (access tokens).
    // Set explicitly with: openssl rand -hex 32 (recommended; must be stable
    // across replicas/restarts). When unset, it is derived deterministically from
    // LUMASTRA_MASTER_KEY so token features work out-of-the-box on a configured
    // install. NOTE: set via environment variable, not settings.json (security).
    get JWT_SECRET(): string {
        return env.JWT_SECRET || derivedJwtSecret();
    },

    // --- External plugin install: SECURITY keys read from ENV ONLY. [Fable-1] ---
    // ── Auth-provider plugin gates ──────────────────────────────────────────
    //
    // ALL THREE ARE ENV-ONLY and default to EMPTY, and that is the condition
    // under which an auth-provider contract is defensible at all: installing
    // such a plugin changes NOTHING until an operator names it here. That puts
    // "who can log in" back at deploy-time trust — the same act, at the same
    // tier, as configuring an OIDC issuer — rather than making it a
    // consequence of installing a plugin.
    //
    // Read from `process.env` directly, never ConfigService: the settings store
    // is admin-UI-writable, and a settings write must never become a change to
    // the authentication perimeter. Same reasoning as PLUGIN_TRUSTED_KEYS.
    //
    // They are also the operator's escape hatch. Removing an id here closes
    // that login surface on the NEXT REQUEST — no restart, and no dependence on
    // the plugin system's restart-only unload semantics.

    /** Auth providers permitted to be a login method at all. */
    get AUTH_PLUGIN_PROVIDERS(): string[] {
        return parseIdList(process.env.AUTH_PLUGIN_PROVIDERS);
    },
    /**
     * Auth providers permitted to CREATE accounts on first successful login.
     * Separate from the above because auto-provisioning is the exact point at
     * which "I installed a plugin" would otherwise become "I granted accounts".
     */
    get AUTH_PLUGIN_PROVISION(): string[] {
        return parseIdList(process.env.AUTH_PLUGIN_PROVISION);
    },
    /**
     * Auth providers whose asserted groups may confer ADMIN. Expected to be
     * empty on almost every deployment; without it the host strips every
     * admin-conferring group from a provider's claims before they are used.
     */
    get AUTH_PLUGIN_ADMIN_ASSERT(): string[] {
        return parseIdList(process.env.AUTH_PLUGIN_ADMIN_ASSERT);
    },

    get PLUGIN_TRUSTED_KEYS(): TrustedKey[] {
        return parseTrustedKeys(process.env.PLUGIN_TRUSTED_KEYS);
    },
    // DEFAULT-ON: the install endpoint is enabled unless explicitly disabled.
    // This only makes the endpoint *available* — install still hard-requires
    // PLUGIN_TRUSTED_KEYS to be configured (installer 400s with "no trusted
    // signing keys configured" otherwise), so an unset env leaves the feature
    // present but inert. Set PLUGINS_EXTERNAL_INSTALL_ENABLED=false to hard-off it.
    get PLUGINS_EXTERNAL_INSTALL_ENABLED(): boolean {
        return envNotDisabled(process.env.PLUGINS_EXTERNAL_INSTALL_ENABLED);
    },
    get PLUGIN_INSTALL_ALLOW_PRIVATE(): boolean {
        return parseBoolEnv(process.env.PLUGIN_INSTALL_ALLOW_PRIVATE);
    },
    get PLUGINS_REQUIRE_REGISTRY(): boolean {
        return parseBoolEnv(process.env.PLUGINS_REQUIRE_REGISTRY);
    },
    // Non-secret knobs — ConfigService/ENV backed (not part of the trust gate).
    get PLUGIN_INSTALL_MAX_MANIFEST_BYTES(): number {
        return getNumber(
            'PLUGIN_INSTALL_MAX_MANIFEST_BYTES',
            env.PLUGIN_INSTALL_MAX_MANIFEST_BYTES,
            64 * 1024,
        );
    },
    get PLUGIN_INSTALL_MAX_BUNDLE_BYTES(): number {
        return getNumber(
            'PLUGIN_INSTALL_MAX_BUNDLE_BYTES',
            env.PLUGIN_INSTALL_MAX_BUNDLE_BYTES,
            8 * 1024 * 1024,
        );
    },
    get PLUGIN_INSTALL_FETCH_TIMEOUT_MS(): number {
        return getNumber(
            'PLUGIN_INSTALL_FETCH_TIMEOUT_MS',
            env.PLUGIN_INSTALL_FETCH_TIMEOUT_MS,
            15_000,
        );
    },
    // Non-secret bundle caps (resource limits only — NOT part of the trust gate).
    // Read `process.env` LIVE (not the module-load `env` snapshot) so operators
    // can retune these without a restart and so they honour late overrides.
    get PLUGIN_INSTALL_MAX_EXTRACTED_BYTES(): number {
        return getNumber(
            'PLUGIN_INSTALL_MAX_EXTRACTED_BYTES',
            process.env.PLUGIN_INSTALL_MAX_EXTRACTED_BYTES,
            32 * 1024 * 1024,
        );
    },
    get PLUGIN_INSTALL_MAX_ENTRIES(): number {
        return getNumber(
            'PLUGIN_INSTALL_MAX_ENTRIES',
            process.env.PLUGIN_INSTALL_MAX_ENTRIES,
            2048,
        );
    },
    get PLUGIN_INSTALL_MAX_FILE_BYTES(): number {
        return getNumber(
            'PLUGIN_INSTALL_MAX_FILE_BYTES',
            process.env.PLUGIN_INSTALL_MAX_FILE_BYTES,
            this.PLUGIN_INSTALL_MAX_BUNDLE_BYTES,
        );
    },

    // Access token TTL in seconds (default: 1 hour)
    get JWT_ACCESS_TOKEN_TTL_SECONDS(): number {
        return getNumber('JWT_ACCESS_TOKEN_TTL_SECONDS', env.JWT_ACCESS_TOKEN_TTL_SECONDS, 3600);
    },

    // Refresh token TTL in days (default: 90 days)
    // With token rotation on each refresh, sessions stay active as long as the app is used
    // within this period. Increase to 365 for yearly persistence.
    get JWT_REFRESH_TOKEN_TTL_DAYS(): number {
        return getNumber('JWT_REFRESH_TOKEN_TTL_DAYS', env.JWT_REFRESH_TOKEN_TTL_DAYS, 90);
    },

    // Device code TTL in seconds (default: 10 minutes)
    get DEVICE_CODE_TTL_SECONDS(): number {
        return getNumber('DEVICE_CODE_TTL_SECONDS', env.DEVICE_CODE_TTL_SECONDS, 600);
    },

    // Device code polling interval in seconds (default: 5 seconds)
    get DEVICE_CODE_POLL_INTERVAL_SECONDS(): number {
        return getNumber(
            'DEVICE_CODE_POLL_INTERVAL_SECONDS',
            env.DEVICE_CODE_POLL_INTERVAL_SECONDS,
            5,
        );
    },

    // Canonical public base URL used to build device verification URIs.
    // Set this to the externally-reachable base URL, including any install path, e.g.
    //   DEVICE_VERIFICATION_BASE_URL=https://lumastra.example.com/lumastra
    // When unset, use ORIGIN or the request origin with trusted proxy protocol handling.
    get DEVICE_VERIFICATION_BASE_URL(): string {
        return getString('DEVICE_VERIFICATION_BASE_URL', env.DEVICE_VERIFICATION_BASE_URL, '');
    },

    // Empty means no minimum; advertised per platform before sign-in.
    get MIN_CLIENT_VERSION_IOS(): string {
        return getString('MIN_CLIENT_VERSION_IOS', env.MIN_CLIENT_VERSION_IOS, '');
    },

    get MIN_CLIENT_VERSION_TVOS(): string {
        return getString('MIN_CLIENT_VERSION_TVOS', env.MIN_CLIENT_VERSION_TVOS, '');
    },

    get MIN_CLIENT_VERSION_WEB(): string {
        return getString('MIN_CLIENT_VERSION_WEB', env.MIN_CLIENT_VERSION_WEB, '');
    },

    get MIN_CLIENT_VERSION_OTHER(): string {
        return getString('MIN_CLIENT_VERSION_OTHER', env.MIN_CLIENT_VERSION_OTHER, '');
    },

    // Canonical public origin of this instance (scheme + host), used by the admin
    // security self-check edge probes to reach the deployment through its real
    // public edge (Cloudflare / nginx / HAProxy), e.g.
    //   PUBLIC_BASE_URL=https://lumastra.example.com
    // The edge probes fall back to DEVICE_VERIFICATION_BASE_URL when this is unset;
    // when neither is set the edge probes are reported as skipped.
    get PUBLIC_BASE_URL(): string {
        return normalizePublicBaseUrl(getString('PUBLIC_BASE_URL', env.PUBLIC_BASE_URL, ''));
    },

    // Allow users to create their own Personal Access Tokens (PATs) via user menu
    // When disabled, only admins can create PATs for users via the admin panel
    // Does NOT require FEATURE_DEVICE_AUTH: a self-minted user PAT
    // (defs/user/tokens.ts) works on /j with only FEATURE_USER_PATS +
    // JWT_SECRET (features.userPats). It is dead on /api/v1 (503'd by
    // handlePublicApiAuth) and on the /api/admin Bearer plane
    // (forward-auth.ts's Bearer exception, fix-plan-5 Task 4) unless
    // FEATURE_DEVICE_AUTH is ALSO on — an unsupported but reachable
    // combination operators should avoid.
    get FEATURE_USER_PATS(): boolean {
        return getBool('FEATURE_USER_PATS', env.FEATURE_USER_PATS, false);
    },

    // Streaming session token expiry in hours (default: 24 hours)
    // These tokens are used for HLS playback to avoid JWT expiration during long movies/live TV
    get STREAMING_SESSION_EXPIRY_HOURS(): number {
        return getNumber('STREAMING_SESSION_EXPIRY_HOURS', env.STREAMING_SESSION_EXPIRY_HOURS, 24);
    },

    // Streaming session inactivity timeout in minutes (default: 120 = 2 hours)
    // Session ends if no segment requests for this duration
    get STREAMING_SESSION_INACTIVITY_MINUTES(): number {
        return getNumber(
            'STREAMING_SESSION_INACTIVITY_MINUTES',
            env.STREAMING_SESSION_INACTIVITY_MINUTES,
            120,
        );
    },

    // Existing admin policy gates explicitly requested cast/AirPlay grants.
    get STREAM_TOKEN_WILDCARD_IP(): boolean {
        return getBool('STREAM_TOKEN_WILDCARD_IP', env.STREAM_TOKEN_WILDCARD_IP, true);
    },

    // Audiobook downloads (Apple Watch): delivery-link lifetime, hours (default 168 = 7 days,
    // never more: grants cannot outlive ABSOLUTE_LIFETIME_MS in playback-grant.ts).
    get DOWNLOAD_SESSION_GRANT_HOURS(): number {
        const hours = getNumber(
            'DOWNLOAD_SESSION_GRANT_HOURS',
            env.DOWNLOAD_SESSION_GRANT_HOURS,
            168,
        );
        return Number.isFinite(hours) ? Math.min(168, Math.max(1, hours)) : 168;
    },

    // Audiobook downloads (Apple Watch) one user may have prepared at once (default 10).
    get DOWNLOAD_SESSIONS_MAX_PER_USER(): number {
        const max = getNumber(
            'DOWNLOAD_SESSIONS_MAX_PER_USER',
            env.DOWNLOAD_SESSIONS_MAX_PER_USER,
            10,
        );
        return Number.isFinite(max) ? Math.min(100, Math.max(1, Math.floor(max))) : 10;
    },

    // Enforce IP address validation for streaming sessions (default: true)
    // When enabled, streaming tokens can only be used from the IP that created them
    // Disable if users frequently change IPs (mobile networks, VPN reconnects)
    get STREAMING_SESSION_ENFORCE_IP(): boolean {
        return getBool('STREAMING_SESSION_ENFORCE_IP', env.STREAMING_SESSION_ENFORCE_IP, true);
    },

    // Playlist chat - allows users to chat within shared playlists
    // Simple messaging feature for collaborative playlist discussions
    // Requires FEATURE_PLAYLISTS to be enabled
    get FEATURE_PLAYLIST_CHAT(): boolean {
        return getBool('FEATURE_PLAYLIST_CHAT', env.FEATURE_PLAYLIST_CHAT, true);
    },

    // Timestamp pins and seekbar markers on any media item
    get FEATURE_MEDIA_ANNOTATIONS(): boolean {
        return getBool('FEATURE_MEDIA_ANNOTATIONS', env.FEATURE_MEDIA_ANNOTATIONS, false);
    },

    // Freeform chat sidebar on any media item (requires FEATURE_MEDIA_ANNOTATIONS)
    get FEATURE_MEDIA_CHAT(): boolean {
        return getBool('FEATURE_MEDIA_CHAT', env.FEATURE_MEDIA_CHAT, false);
    },

    // Max timestamp pins per user per media item
    get ANNOTATIONS_MAX_PINS(): number {
        return getNumber('ANNOTATIONS_MAX_PINS', env.ANNOTATIONS_MAX_PINS, 3);
    },

    // Groups with moderation privileges (can delete others' content, future: reviews, etc.)
    // Admins always have these privileges regardless
    get MODERATOR_GROUPS(): string[] {
        return getArray('MODERATOR_GROUPS', env.MODERATOR_GROUPS, '');
    },

    // Groups allowed to create public playlists (comma-separated)
    // Users not in these groups can only create private/shared playlists
    // Empty string means all users can create public playlists
    get PLAYLIST_PUBLIC_GROUPS(): string {
        return getString('PLAYLIST_PUBLIC_GROUPS', env.PLAYLIST_PUBLIC_GROUPS, '');
    },

    // Animated stars background on homepage
    // Adds a subtle twinkling star effect behind the content
    get FEATURE_STARS_BACKGROUND(): boolean {
        return getBool('FEATURE_STARS_BACKGROUND', env.FEATURE_STARS_BACKGROUND, true);
    },

    // =========================================================================
    // Image Optimization
    // =========================================================================

    // Serve images in WebP format for ~30% smaller file sizes
    // Supported by all modern browsers (Chrome, Firefox, Safari 14+, Edge)
    get IMAGE_WEBP_ENABLED(): boolean {
        return getBool('IMAGE_WEBP_ENABLED', env.IMAGE_WEBP_ENABLED, true);
    },

    // Default quality for thumbnail images (1-100)
    // Lower values = smaller files but more compression artifacts
    get IMAGE_THUMB_QUALITY(): number {
        return getNumber('IMAGE_THUMB_QUALITY', env.IMAGE_THUMB_QUALITY, 75);
    },

    // Default quality for full-size images (hero section, modals)
    // Slightly lower than max for better file sizes with minimal quality loss
    get IMAGE_FULL_QUALITY(): number {
        return getNumber('IMAGE_FULL_QUALITY', env.IMAGE_FULL_QUALITY, 85);
    },

    // Enable AVIF encoding when the client's Accept header includes image/avif.
    // AVIF is ~25-35% smaller than WebP at perceptually equivalent quality but
    // ~3-10x slower to encode (paid once per cache miss).
    get IMAGE_AVIF_ENABLED(): boolean {
        return getBool('IMAGE_AVIF_ENABLED', env.IMAGE_AVIF_ENABLED, true);
    },

    // Pre-generation strategy for AVIF variants:
    //   'eager': encode WebP + AVIF together on first cache miss. Consistent
    //            serve latency; ~2x CPU on miss; cache fills faster.
    //   'lazy':  encode WebP first; AVIF only when an AVIF-accepting client
    //            actually requests it. Less wasted CPU; first AVIF request per
    //            image pays the encode cost.
    // Default 'lazy' because eager-mode background AVIF encodes saturate the
    // libuv thread pool under burst loads (e.g. /music posters fanout at
    // page-load), pushing foreground encodes from ~150 ms to 600+ ms while
    // a non-AVIF client never sees the bytes anyway.
    get IMAGE_AVIF_PREGEN_MODE(): string {
        return getString('IMAGE_AVIF_PREGEN_MODE', env.IMAGE_AVIF_PREGEN_MODE, 'lazy');
    },

    // AVIF quality (1-100) for thumb/card variants. AVIF q=54 ≈ WebP q=75 on
    // sharp 0.35's recalibrated scale (see src/lib/config/schema.ts).
    get IMAGE_AVIF_THUMB_QUALITY(): number {
        return getNumber('IMAGE_AVIF_THUMB_QUALITY', env.IMAGE_AVIF_THUMB_QUALITY, 54);
    },

    // AVIF quality (1-100) for medium/full variants. AVIF q=67 ≈ WebP q=85 on
    // sharp 0.35's recalibrated scale (see src/lib/config/schema.ts).
    get IMAGE_AVIF_FULL_QUALITY(): number {
        return getNumber('IMAGE_AVIF_FULL_QUALITY', env.IMAGE_AVIF_FULL_QUALITY, 67);
    },

    // AVIF encode effort (0-9). Sharp/libheif scale: 0 = LEAST effort
    // (fastest), 9 = MOST effort (slowest, smallest files). Cold cache
    // misses dominate first-paint when 12+ posters fan out (e.g. /music);
    // per-request timing showed `local.encode.avif` at ~350 ms per encode
    // at effort 4. Effort 1 cuts that to ~80-120 ms for ~5-10% larger
    // files, which we trade gladly — files are cached once and served
    // many times, so the fixed extra bytes are amortized while the cold
    // latency hit is per-page.
    get IMAGE_AVIF_SPEED(): number {
        return getNumber('IMAGE_AVIF_SPEED', env.IMAGE_AVIF_SPEED, 1);
    },

    // Image cache retention in days (files older than this are deleted on cleanup)
    // Default: 30 days - balances disk usage with avoiding re-fetches
    get IMAGE_CACHE_RETENTION_DAYS(): number {
        return getNumber('IMAGE_CACHE_RETENTION_DAYS', env.IMAGE_CACHE_RETENTION_DAYS, 30);
    },

    // Enable automatic cache cleanup on startup (default: true)
    // Runs in background, deletes expired files from all image cache directories
    get IMAGE_CACHE_CLEANUP_ON_STARTUP(): boolean {
        return getBool('IMAGE_CACHE_CLEANUP_ON_STARTUP', env.IMAGE_CACHE_CLEANUP_ON_STARTUP, true);
    },

    // Max total bytes across all image cache directories. After TTL-based
    // cleanup runs, if the remaining cache is still over budget, oldest-mtime
    // files are deleted across all directories until under budget. Prevents
    // unbounded growth on small disks.
    // Default: 5 GB. Set to 0 to disable budget enforcement.
    get IMAGE_CACHE_MAX_BYTES(): number {
        return getNumber(
            'IMAGE_CACHE_MAX_BYTES',
            env.IMAGE_CACHE_MAX_BYTES,
            5 * 1024 * 1024 * 1024,
        );
    },

    // =========================================================================
    // Image Sync (Local file scanning + video extraction)
    // =========================================================================

    // Enable scanning media folders for images matching patterns
    get IMAGE_SYNC_LOCAL_FILE_SCANNING(): boolean {
        return getBool('IMAGE_SYNC_LOCAL_FILE_SCANNING', env.IMAGE_SYNC_LOCAL_FILE_SCANNING, true);
    },

    // File patterns to search for (support ## for numbers)
    get IMAGE_SYNC_LOCAL_PATTERNS(): string[] {
        return getArray(
            'IMAGE_SYNC_LOCAL_PATTERNS',
            env.IMAGE_SYNC_LOCAL_PATTERNS,
            'S##E##-backdrop,S##E##-poster,season#-backdrop,season#-poster,backdrop,poster',
        );
    },

    // Enable automatic extraction of thumbnails from video files using ffmpeg
    get IMAGE_SYNC_AUTO_VIDEO_EXTRACTION(): boolean {
        return getBool(
            'IMAGE_SYNC_AUTO_VIDEO_EXTRACTION',
            env.IMAGE_SYNC_AUTO_VIDEO_EXTRACTION,
            true,
        );
    },

    // Percentage into video to extract frame
    get IMAGE_SYNC_VIDEO_TIMESTAMP(): number {
        return getNumber('IMAGE_SYNC_VIDEO_TIMESTAMP', env.IMAGE_SYNC_VIDEO_TIMESTAMP, 10);
    },

    // Quality for extracted frames (1-100)
    get IMAGE_SYNC_VIDEO_QUALITY(): number {
        return getNumber('IMAGE_SYNC_VIDEO_QUALITY', env.IMAGE_SYNC_VIDEO_QUALITY, 80);
    },

    // Maximum width for extracted frames
    get IMAGE_SYNC_VIDEO_MAX_WIDTH(): number {
        return getNumber('IMAGE_SYNC_VIDEO_MAX_WIDTH', env.IMAGE_SYNC_VIDEO_MAX_WIDTH, 640);
    },

    // Maximum height for extracted frames
    get IMAGE_SYNC_VIDEO_MAX_HEIGHT(): number {
        return getNumber('IMAGE_SYNC_VIDEO_MAX_HEIGHT', env.IMAGE_SYNC_VIDEO_MAX_HEIGHT, 360);
    },

    // Where to store extracted video frames: 'config-dir' (BASE_PATH) or 'alongside-video' (next to the video file)
    get IMAGE_SYNC_EXTRACTION_LOCATION(): 'config-dir' | 'alongside-video' {
        return getEnum(
            'IMAGE_SYNC_EXTRACTION_LOCATION',
            env.IMAGE_SYNC_EXTRACTION_LOCATION,
            ['config-dir', 'alongside-video'],
            'config-dir',
        );
    },

    // Priority order for episode thumbnails during post-scan.
    // video = extract from episode file with ffmpeg; provider = remote still image (TMDB, etc.).
    get IMAGE_SYNC_EPISODE_THUMB_PRIORITY(): string[] {
        return getArray(
            'IMAGE_SYNC_EPISODE_THUMB_PRIORITY',
            env.IMAGE_SYNC_EPISODE_THUMB_PRIORITY,
            'video,provider',
        );
    },

    // Provider priority order for catalog image resolution. Valid values:
    // local, generic, tmdb, jellyfin, custom. Jellyfin is NOT in the default — it is a
    // watch-sync integration, not an image source — but stays a valid opt-in
    // for operators who do serve art from a Jellyfin server.
    get IMAGE_CANDIDATE_PROVIDER_ORDER(): string[] {
        return getArray(
            'IMAGE_CANDIDATE_PROVIDER_ORDER',
            env.IMAGE_CANDIDATE_PROVIDER_ORDER,
            'tmdb,tvdb,fanart,musicbrainz-caa,discogs,deezer,theaudiodb,lastfm,jellyfin,audiobookshelf,upload,unknown',
        );
    },
    get EPISODE_THUMBNAIL_PREFERENCE(): 'provider' | 'generated' {
        return getString(
            'EPISODE_THUMBNAIL_PREFERENCE',
            env.EPISODE_THUMBNAIL_PREFERENCE,
            'provider',
        ) === 'generated'
            ? 'generated'
            : 'provider';
    },
    get IMAGE_PROVIDER_PRIORITY(): string[] {
        return getArray(
            'IMAGE_PROVIDER_PRIORITY',
            env.IMAGE_PROVIDER_PRIORITY,
            'local,generic,tmdb,custom',
        );
    },

    // Override provider priority specifically for episode thumbnail (thumb) requests.
    // When set, takes precedence over IMAGE_PROVIDER_PRIORITY for episode thumbs.
    // Same vocabulary: local, tmdb, jellyfin, custom.
    get IMAGE_PROVIDER_PRIORITY_EPISODE_THUMB(): string[] | null {
        const raw = env.IMAGE_PROVIDER_PRIORITY_EPISODE_THUMB;
        if (!raw) return null;
        return getArray('IMAGE_PROVIDER_PRIORITY_EPISODE_THUMB', raw, '');
    },

    // When set, takes precedence over IMAGE_PROVIDER_PRIORITY for music items
    // (album/artist/track). Default (unset) → the service uses custom,local,jellyfin
    // (music art lives in custom_poster_url; there is no TMDB music art).
    get IMAGE_PROVIDER_PRIORITY_MUSIC(): string[] | null {
        const raw = env.IMAGE_PROVIDER_PRIORITY_MUSIC;
        if (!raw) return null;
        return getArray('IMAGE_PROVIDER_PRIORITY_MUSIC', raw, '');
    },

    // Maximum size (MB) for manually uploaded artwork files
    get MAX_IMAGE_UPLOAD_MB(): number {
        return Math.max(
            1,
            Math.min(50, getNumber('MAX_IMAGE_UPLOAD_MB', env.MAX_IMAGE_UPLOAD_MB, 10)),
        );
    },

    // =========================================================================
    // In-app Upload (non-entertainment library types)
    // =========================================================================

    // Maximum size (GB) for a primary video file upload.
    // Worker enforces this; the app container mounts /data read-only.
    get MAX_VIDEO_UPLOAD_GB(): number {
        return Math.max(1, getNumber('MAX_VIDEO_UPLOAD_GB', env.MAX_VIDEO_UPLOAD_GB, 50));
    },

    // Maximum size (MB) for an attached resource file (PDF, PPTX, ZIP).
    get MAX_RESOURCE_UPLOAD_MB(): number {
        return Math.max(1, getNumber('MAX_RESOURCE_UPLOAD_MB', env.MAX_RESOURCE_UPLOAD_MB, 500));
    },

    // Maximum size (MB) for a subtitle / caption file (.srt / .vtt / .ass).
    get MAX_SUBTITLE_UPLOAD_MB(): number {
        return Math.max(1, getNumber('MAX_SUBTITLE_UPLOAD_MB', env.MAX_SUBTITLE_UPLOAD_MB, 10));
    },

    // Maximum size (MB) for a chapter markers file (.vtt or .json).
    get MAX_CHAPTER_UPLOAD_MB(): number {
        return Math.max(1, getNumber('MAX_CHAPTER_UPLOAD_MB', env.MAX_CHAPTER_UPLOAD_MB, 1));
    },

    // Chunk size (MB) for chunked video uploads. Each PUT body is this large.
    // Must be > 0; clients split the file into ceil(totalSize / chunkBytes) chunks.
    get UPLOAD_CHUNK_SIZE_MB(): number {
        return Math.max(1, getNumber('UPLOAD_CHUNK_SIZE_MB', env.UPLOAD_CHUNK_SIZE_MB, 5));
    },

    // Override the staging directory root.  Default: sibling .upload-staging/
    // inside each library path (same filesystem → atomic rename on finalize).
    // If set to a path on a DIFFERENT filesystem from the library, the finalizer
    // will fall back to stream-copy + unlink (EXDEV fallback).
    get UPLOAD_STAGING_DIR(): string {
        return getString('UPLOAD_STAGING_DIR', env.UPLOAD_STAGING_DIR, '');
    },

    // Deployment setting: comma-separated absolute folders that library folders
    // must live under (realpath-checked). Empty = no allow-list (bare-metal
    // installs); the structural rules (absolute, exists, not '/', no overlap)
    // apply either way. See services/library-root-validation.ts.
    get LIBRARY_ALLOWED_ROOTS(): string {
        return getString('LIBRARY_ALLOWED_ROOTS', env.LIBRARY_ALLOWED_ROOTS, '');
    },

    // =========================================================================
    // Media Storage
    // =========================================================================

    // Where to store generated metadata files (trickplay, artwork, lyrics)
    // 'central' = /config only, 'alongside' = next to media, 'alongside-prefer' = alongside with central fallback
    // Auto-migrate: if the deprecated IMAGE_SYNC_EXTRACTION_LOCATION was 'alongside-video'
    // and METADATA_STORAGE_LOCATION hasn't been explicitly set, use 'alongside-prefer'.
    get METADATA_STORAGE_LOCATION(): 'central' | 'alongside' | 'alongside-prefer' {
        const explicit = getString('METADATA_STORAGE_LOCATION', env.METADATA_STORAGE_LOCATION, '')
            .trim()
            .toLowerCase();
        if (explicit === 'central' || explicit === 'alongside' || explicit === 'alongside-prefer') {
            return explicit;
        }
        // Unset (or invalid) → legacy auto-migrate path.
        return this.IMAGE_SYNC_EXTRACTION_LOCATION === 'alongside-video'
            ? 'alongside-prefer'
            : 'central';
    },

    // ── Provider artwork backfill (drain over existing libraries) ──────────
    // The drain writes into the user's media folders for hours. These three
    // knobs are the operator's brakes.

    // Kill switch. When false, every provider-artwork-* task returns
    // immediately without touching the filesystem.
    get PROVIDER_ARTWORK_BACKFILL_ENABLED(): boolean {
        return getBool(
            'PROVIDER_ARTWORK_BACKFILL_ENABLED',
            env.PROVIDER_ARTWORK_BACKFILL_ENABLED,
            true,
        );
    },

    // Per-VOLUME free-space margin. Checked against the central artwork root
    // AND every enabled library path — /config and the media mounts differ, so
    // a single global number would let the drain fill the small one.
    get PROVIDER_ARTWORK_MIN_FREE_GB(): number {
        return getNumber('PROVIDER_ARTWORK_MIN_FREE_GB', env.PROVIDER_ARTWORK_MIN_FREE_GB, 5);
    },

    /**
     * When to WARN about low disk space — deliberately separate from
     * `PROVIDER_ARTWORK_MIN_FREE_GB`, which decides when artwork writes stop.
     *
     * Sharing one knob meant an operator setting the artwork gate to 0 ("download
     * artwork regardless of free space") silently switched off the critical
     * disk-full alert as well, and any artwork retune silently moved a system
     * alert's threshold. Defaults to the same 5 GB so behaviour is unchanged
     * until someone deliberately splits them.
     */
    get STORAGE_LOW_SPACE_WARN_GB(): number {
        return getNumber('STORAGE_LOW_SPACE_WARN_GB', env.STORAGE_LOW_SPACE_WARN_GB, 5);
    },

    // Rate cap for the drain. Each run materializes ONE item, so the "per-run
    // item cap" is expressed as items per rolling hour. 0 = unlimited.
    get PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR(): number {
        return getNumber(
            'PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR',
            env.PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR,
            2000,
        );
    },

    // =========================================================================
    // Trickplay Generation
    // =========================================================================

    // Enable self-generated trickplay sprite sheets
    get TRICKPLAY_ENABLED(): boolean {
        return getBool('TRICKPLAY_ENABLED', env.TRICKPLAY_ENABLED, false);
    },

    // Trickplay provider strategy
    get TRICKPLAY_PROVIDER(): 'prefer_local' | 'local_only' | 'jellyfin_disk' {
        return getEnum(
            'TRICKPLAY_PROVIDER',
            env.TRICKPLAY_PROVIDER,
            ['prefer_local', 'local_only', 'jellyfin_disk'],
            'prefer_local',
        );
    },

    // Whether locally-stored trickplay (alongside-media or central) may be SERVED.
    // Deliberately DECOUPLED from TRICKPLAY_ENABLED, which gates *generation* only.
    // A read-only consumer replica (e.g. preprod, which mounts the media NAS ro)
    // can then serve sprite sheets another instance (prod, rw) wrote to the shared
    // alongside location — reads always probe both locations — without generating
    // its own. Still honours the explicit local-serve kill switches so operators
    // who want Jellyfin-disk-only or no-local-trickplay keep that behaviour.
    get TRICKPLAY_SERVE_LOCAL(): boolean {
        return !this.DISABLE_LOCAL_TRICKPLAY && this.TRICKPLAY_PROVIDER !== 'jellyfin_disk';
    },

    // Milliseconds between trickplay thumbnails
    get TRICKPLAY_INTERVAL_MS(): number {
        return getNumber('TRICKPLAY_INTERVAL_MS', env.TRICKPLAY_INTERVAL_MS, 10000);
    },

    // Width of trickplay images in pixels
    get TRICKPLAY_WIDTH(): number {
        return getNumber('TRICKPLAY_WIDTH', env.TRICKPLAY_WIDTH, 320);
    },

    // WebP quality for trickplay (0-100)
    get TRICKPLAY_QUALITY(): number {
        return getNumber('TRICKPLAY_QUALITY', env.TRICKPLAY_QUALITY, 80);
    },

    // Tiles per row in sprite sheet
    get TRICKPLAY_TILE_WIDTH(): number {
        return getNumber('TRICKPLAY_TILE_WIDTH', env.TRICKPLAY_TILE_WIDTH, 10);
    },

    // Tiles per column in sprite sheet
    get TRICKPLAY_TILE_HEIGHT(): number {
        return getNumber('TRICKPLAY_TILE_HEIGHT', env.TRICKPLAY_TILE_HEIGHT, 10);
    },

    // Hardware-accelerated DECODE for per-frame trickplay extraction.
    //
    // Frame extraction decodes a few frames from the nearest keyframe, once per
    // sample point. On 1080p that costs ~0.3s of CPU; on a 4K source it costs
    // 3-12s (measured on prod: 3.6s for 4K HEVC, 12.5s for 4K AV1 10-bit), which
    // is what pushed long 4K movies past the task's 30-minute cap and into a
    // permanent retry loop. Decoding on the GPU collapses that to ~0.35-0.7s and
    // is nearly thread-free, so it also removes the CPU oversubscription that
    // made every OTHER frame slower.
    //
    // 'auto' uses hardware when a render node is present and a probe frame
    // actually decodes, and silently falls back to software otherwise — a box
    // with no GPU, a passthrough-less container, or a driver that can't handle
    // the codec keeps working exactly as before. 'off' forces software.
    //
    // Correctness note: the hardware path uses the SAME one-spawn-per-frame,
    // fast-seek structure as software (see extractAllFrames) — it does not
    // reintroduce the long continuous decode pass that silently produced stale
    // frames before 2026-08-13.
    get TRICKPLAY_HWACCEL(): 'auto' | 'vaapi' | 'qsv' | 'off' {
        return getEnum(
            'TRICKPLAY_HWACCEL',
            env.TRICKPLAY_HWACCEL,
            ['auto', 'vaapi', 'qsv', 'off'],
            'auto',
        );
    },

    // DRM render node used for trickplay hardware decode. Only consulted when
    // TRICKPLAY_HWACCEL resolves to a hardware mode. Boxes with more than one
    // GPU (or an iGPU at renderD128 and a dGPU at renderD129) can point this at
    // the card that should do the work.
    get TRICKPLAY_HWACCEL_DEVICE(): string {
        return getString(
            'TRICKPLAY_HWACCEL_DEVICE',
            env.TRICKPLAY_HWACCEL_DEVICE,
            '/dev/dri/renderD128',
        );
    },

    // Parallel ffmpeg spawns WITHIN one trickplay run.
    //
    // The real ceiling is this × the cpu-class concurrency × the ffmpeg thread
    // cap. On a 20-core box the old fixed 4 meant 4 runs x 4 frames x 4 threads
    // = 64 threads competing for 20 cores, which inflated per-frame time far
    // enough to blow the per-frame timeout. The generator now derives a thread
    // budget from this value so the product stays near the core count; raise it
    // only alongside a matching LUMASTRA_CONCURRENCY_CPU review.
    get TRICKPLAY_PER_FRAME_CONCURRENCY(): number {
        return getNumber('TRICKPLAY_PER_FRAME_CONCURRENCY', env.TRICKPLAY_PER_FRAME_CONCURRENCY, 4);
    },

    // Filesystem path for trickplay sprite sheet storage
    // Must be on a volume shared between web and worker containers
    get TRICKPLAY_STORAGE_PATH(): string {
        return getString('TRICKPLAY_STORAGE_PATH', env.TRICKPLAY_STORAGE_PATH, '/config/trickplay');
    },

    // Per-feature storage-location override for trickplay sprite sheets.
    // 'inherit' (default) follows the global METADATA_STORAGE_LOCATION; the other
    // values let trickplay diverge — e.g. keep artwork/lyrics central but write
    // trickplay 'alongside' the media file (or vice-versa).
    get TRICKPLAY_STORAGE_LOCATION(): 'inherit' | 'central' | 'alongside' | 'alongside-prefer' {
        return getEnum(
            'TRICKPLAY_STORAGE_LOCATION',
            env.TRICKPLAY_STORAGE_LOCATION,
            ['inherit', 'central', 'alongside', 'alongside-prefer'],
            'inherit',
        );
    },

    // Per-feature storage-location override for extracted and rendered BITMAP
    // subtitles (PGS/VobSub). 'inherit' (default) follows the global
    // METADATA_STORAGE_LOCATION, like trickplay. Alongside files sit in a hidden
    // `.subtitle-cache/` folder next to the media file and are not subject to
    // SUBTITLE_CACHE_MAX_BYTES; text subtitles are cheap to redo and always stay
    // in the central cache.
    get SUBTITLE_STORAGE_LOCATION(): 'inherit' | 'central' | 'alongside' | 'alongside-prefer' {
        return getEnum(
            'SUBTITLE_STORAGE_LOCATION',
            env.SUBTITLE_STORAGE_LOCATION,
            ['inherit', 'central', 'alongside', 'alongside-prefer'],
            'inherit',
        );
    },

    // TMDB API metadata cache TTL in days (poster/backdrop paths, logo paths)
    // This is for in-memory cache of TMDB API responses, not image files
    // Default: 30 days - balances freshness with API rate limiting
    get TMDB_METADATA_CACHE_TTL_DAYS(): number {
        return getNumber('TMDB_METADATA_CACHE_TTL_DAYS', env.TMDB_METADATA_CACHE_TTL_DAYS, 30);
    },

    // Absolute-numbering reconciliation (absolute-numbering-reconciliation.service.ts):
    // whether a match backed only by matching episode numbers is applied on its
    // own. Off (default) writes it to sync_quarantine as a proposal. Matches
    // backed by the absolute number in the file name apply either way.
    get RECONCILE_AUTO_APPLY_NUMBER_MATCHES(): boolean {
        return getBool(
            'RECONCILE_AUTO_APPLY_NUMBER_MATCHES',
            env.RECONCILE_AUTO_APPLY_NUMBER_MATCHES,
            false,
        );
    },

    // Whether a match backed by the absolute number in the file name (and an
    // agreeing episode title, or two independent derivations of the same row)
    // is applied on its own. On (default) applies it, at most 50 pairs per
    // series per sync; off turns every such match into a proposal.
    get RECONCILE_AUTO_APPLY_FILENAME_MATCHES(): boolean {
        return getBool(
            'RECONCILE_AUTO_APPLY_FILENAME_MATCHES',
            env.RECONCILE_AUTO_APPLY_FILENAME_MATCHES,
            true,
        );
    },

    // =========================================================================
    // Service Connections
    // =========================================================================

    // Jellyfin
    get JELLYFINURL(): string {
        return getOptionalIntegrationString('JELLYFINURL', env.JELLYFINURL, '');
    },
    get JELLYFINAPIKEY(): string {
        return getOptionalIntegrationString('JELLYFINAPIKEY', env.JELLYFINAPIKEY, '');
    },

    // Audiobookshelf
    get AUDIOURL(): string {
        return getOptionalIntegrationString('AUDIOURL', env.AUDIOURL, '');
    },
    get AUDIOAPIKEY(): string {
        return getOptionalIntegrationString('AUDIOAPIKEY', env.AUDIOAPIKEY, '');
    },
    // Concurrent audiobook remuxes ONE listener may hold on this pod. A remux is
    // one ffmpeg per requested file offset (restart-on-seek), so a listener
    // dragging the scrubber can ask for several in a second. 0 disables the cap.
    get AUDIOBOOK_REMUX_MAX_PER_USER(): number {
        return getNumber('AUDIOBOOK_REMUX_MAX_PER_USER', env.AUDIOBOOK_REMUX_MAX_PER_USER, 2);
    },

    // Provision an AudiobookShelf account for a listener who has none, the first
    // time they actually open an audiobook. Without it that listener is stuck:
    // every audiobook 403s with "This account has no AudiobookShelf link", which
    // reads as a misconfiguration rather than a missing account. Off is for an
    // ABS server shared with something else, or identities managed elsewhere.
    get AUDIOBOOK_AUTO_CREATE_USERS(): boolean {
        return getBool('AUDIOBOOK_AUTO_CREATE_USERS', env.AUDIOBOOK_AUTO_CREATE_USERS, true);
    },

    // Sonarr
    get SONARRURL(): string {
        return getOptionalIntegrationString('SONARRURL', env.SONARRURL, '');
    },
    get SONARRAPIKEY(): string {
        return getOptionalIntegrationString('SONARRAPIKEY', env.SONARRAPIKEY, '');
    },

    // Radarr
    get RADARRURL(): string {
        return getOptionalIntegrationString('RADARRURL', env.RADARRURL, '');
    },
    get RADARRAPIKEY(): string {
        return getOptionalIntegrationString('RADARRAPIKEY', env.RADARRAPIKEY, '');
    },

    // Jellyseerr
    get SEERRURL(): string {
        return getOptionalIntegrationString('SEERRURL', env.SEERRURL || env.JELLYSEERRURL, '');
    },
    get SEERRAPIKEY(): string {
        return getOptionalIntegrationString(
            'SEERRAPIKEY',
            env.SEERRAPIKEY || env.JELLYSEERRAPIKEY,
            '',
        );
    },

    // Kavita (books/manga/comics)
    get KAVITAURL(): string {
        return getOptionalIntegrationString('KAVITAURL', env.KAVITAURL, '');
    },
    get KAVITAAPIKEY(): string {
        return getOptionalIntegrationString('KAVITAAPIKEY', env.KAVITAAPIKEY, '');
    },

    // TMDB
    get TMDB_API_KEY(): string {
        return getOptionalIntegrationString('TMDB_API_KEY', env.TMDB_API_KEY, '');
    },

    // BCP 47 language tag TMDB metadata (titles, overviews, artwork) is fetched in.
    get TMDB_LANGUAGE(): string {
        return getString('TMDB_LANGUAGE', env.TMDB_LANGUAGE, 'en-US');
    },

    // Country whose age-rating system (FSK, MPAA, BBFC, ...) decides the numeric
    // age of a title: 'auto' (follow TMDB_LANGUAGE) or a country code. Use
    // effectiveAgeRatingCountry() (utils/age-rating-country.ts) for the resolved country.
    get AGE_RATING_COUNTRY(): string {
        return getString('AGE_RATING_COUNTRY', env.AGE_RATING_COUNTRY, 'auto');
    },

    // Extra BCP-47 languages (max 3, normalized, deduped) to fetch and store
    // TMDB title/overview translations in, in addition to TMDB_LANGUAGE.
    //
    // Excludes entries equal to the primary language (bare OR full tag — the
    // shared `isPrimaryLanguageTag` definition, also used by the
    // settings-save diff in config.service.ts so the "did the effective set
    // gain a language" trigger agrees with what this getter actually
    // returns; same "primary" semantics as `metadata-language-resolve.ts`
    // and `playback-preferences.ts`) so an admin accidentally re-listing the
    // primary language (e.g. TMDB_LANGUAGE='en-US', additional='en, de')
    // doesn't waste one of the 3 extra-language slots on a translation
    // identical to the base row, and metadata-translations-sync doesn't
    // repeatedly fetch/store it from TMDB for nothing.
    get METADATA_ADDITIONAL_LANGUAGES(): string[] {
        const raw = getArray(
            'METADATA_ADDITIONAL_LANGUAGES',
            env.METADATA_ADDITIONAL_LANGUAGES,
            '',
        );
        const primary = this.TMDB_LANGUAGE;
        const normalized: string[] = [];
        for (const entry of raw) {
            const tag = normalizeLanguageTag(entry);
            if (!tag || normalized.includes(tag)) continue;
            if (isPrimaryLanguageTag(tag, primary)) continue;
            normalized.push(tag);
        }
        return normalized.slice(0, 3);
    },

    // MDBList (aggregated ratings from IMDB, Letterboxd, Metacritic, RT, Trakt, MAL)
    get MDBLIST_API_KEY(): string {
        return getOptionalIntegrationString('MDBLIST_API_KEY', env.MDBLIST_API_KEY, '');
    },

    // =========================================================================
    // Metadata Provider Plugin System
    // =========================================================================

    // Comma-separated list of enabled metadata providers (in priority order)
    // Available: tmdb, mdblist, imdb, trakt
    get METADATA_PROVIDERS(): string {
        return getString('METADATA_PROVIDERS', env.METADATA_PROVIDERS, 'tmdb,mdblist');
    },

    get PRIMARY_IMAGE_PROVIDER(): string {
        return getString('PRIMARY_IMAGE_PROVIDER', env.PRIMARY_IMAGE_PROVIDER, '');
    },
    get PRIMARY_SEARCH_PROVIDER(): string {
        return getString('PRIMARY_SEARCH_PROVIDER', env.PRIMARY_SEARCH_PROVIDER, '');
    },

    // OMDB API key. Unused (nothing fetches from OMDb) and hidden in the admin UI;
    // kept so existing settings and environments that set it still load.
    get OMDB_API_KEY(): string {
        return getString('OMDB_API_KEY', env.OMDB_API_KEY, '');
    },

    // Trakt API credentials (for watch history sync and metadata)
    get TRAKT_CLIENT_ID(): string {
        return getString('TRAKT_CLIENT_ID', env.TRAKT_CLIENT_ID, '');
    },
    get TRAKT_CLIENT_SECRET(): string {
        return getString('TRAKT_CLIENT_SECRET', env.TRAKT_CLIENT_SECRET, '');
    },

    // MyAnimeList OAuth app credentials (one app per deployment; users authorize their own MAL accounts against it)
    get MAL_CLIENT_ID(): string {
        return getString('MAL_CLIENT_ID', env.MAL_CLIENT_ID, '');
    },
    get MAL_CLIENT_SECRET(): string {
        return getString('MAL_CLIENT_SECRET', env.MAL_CLIENT_SECRET, '');
    },

    // =========================================================================
    // AI / LLM Configuration
    // =========================================================================

    // OpenAI (for embeddings — recommendations pipeline)
    get OPENAI_API_KEY(): string {
        return getOptionalIntegrationString('OPENAI_API_KEY', env.OPENAI_API_KEY, '');
    },
    // OpenAI (for AI-assistant chat completions). Separate from OPENAI_API_KEY
    // (embeddings) — no fallback between the two.
    get OPENAI_CHAT_API_KEY(): string {
        return getOptionalIntegrationString('OPENAI_CHAT_API_KEY', env.OPENAI_CHAT_API_KEY, '');
    },
    // Custom OpenAI-compatible endpoint (e.g., local LLM, Azure OpenAI, etc.)
    get OPENAI_BASE_URL(): string {
        return getString('OPENAI_BASE_URL', env.OPENAI_BASE_URL, '');
    },
    // Chat model to use (default: gpt-4o-mini)
    get OPENAI_CHAT_MODEL(): string {
        return getString('OPENAI_CHAT_MODEL', env.OPENAI_CHAT_MODEL, 'gpt-4o-mini');
    },

    // Anthropic (Claude) — alternative chat-completion backend for the assistant.
    // Native Messages API (not the OpenAI-compat shim), with adaptive thinking.
    get ANTHROPIC_API_KEY(): string {
        return getOptionalIntegrationString('ANTHROPIC_API_KEY', env.ANTHROPIC_API_KEY, '');
    },
    // Optional custom Anthropic base URL (proxy / gateway). Blank → SDK default.
    get ANTHROPIC_BASE_URL(): string {
        return getString('ANTHROPIC_BASE_URL', env.ANTHROPIC_BASE_URL, '');
    },
    // Claude chat model (default: claude-opus-4-8).
    get ANTHROPIC_CHAT_MODEL(): string {
        return getString('ANTHROPIC_CHAT_MODEL', env.ANTHROPIC_CHAT_MODEL, 'claude-opus-4-8');
    },

    // Embeddings configuration
    // Voyage AI (default embedding provider)
    get VOYAGE_API_KEY(): string {
        return getOptionalIntegrationString('VOYAGE_API_KEY', env.VOYAGE_API_KEY, '');
    },
    // Custom OpenAI-compatible embedding endpoint (overrides Voyage if set)
    get EMBEDDING_BASE_URL(): string {
        return getString('EMBEDDING_BASE_URL', env.EMBEDDING_BASE_URL, '');
    },
    // API key for custom embedding endpoint (separate from OpenAI/chat keys)
    get EMBEDDING_API_KEY(): string {
        return getOptionalIntegrationString('EMBEDDING_API_KEY', env.EMBEDDING_API_KEY, '');
    },
    // Embedding model name (default: voyage-3-large for Voyage, text-embedding-3-small for OpenAI)
    get EMBEDDING_MODEL(): string {
        return getString('EMBEDDING_MODEL', env.EMBEDDING_MODEL, '');
    },
    // Embedding dimensions (default: 1024 for Voyage, auto-detected for OpenAI)
    // IMPORTANT: Changing this requires database migration!
    get EMBEDDING_DIMENSIONS(): number {
        return getNumber('EMBEDDING_DIMENSIONS', env.EMBEDDING_DIMENSIONS, 0);
    },
    // Disable the SSRF public-IP guard for a self-hosted EMBEDDING_BASE_URL on
    // a trusted/LAN network (mirrors LIVETV_ALLOW_PRIVATE_URLS). Default off:
    // an operator-configured embedding endpoint is refused if it resolves to
    // a private address. When on, the interactive (non-task-scoped) embedding
    // fetch in ai/voyage.ts drops the public-IP check but keeps following
    // only same-origin redirects.
    get EMBEDDING_ALLOW_PRIVATE_URLS(): boolean {
        return getBool('EMBEDDING_ALLOW_PRIVATE_URLS', env.EMBEDDING_ALLOW_PRIVATE_URLS, false);
    },
    // Operator-defined price overrides for the admin cost page, consulted
    // BEFORE the built-in embedding pricing table so a local/unrecognised
    // embedding model (which prices at $0 by default — see ai/cost.ts) can be
    // assigned a real $/1M-token rate. Each entry is "model-prefix=usd", e.g.
    // "text-embedding-3-small=0.02". Parsed by parseCostPriceOverrides().
    get AI_COST_PRICE_OVERRIDES(): string[] {
        return getArray('AI_COST_PRICE_OVERRIDES', env.AI_COST_PRICE_OVERRIDES, '');
    },

    // =========================================================================
    // For You / Recommendations Configuration
    // =========================================================================

    // Weighted fusion of the two recommendation embeddings (library + discovery).
    // When a candidate item has BOTH a library and a discovery embedding, its
    // similarity score is a weighted blend of the two cosine similarities rather
    // than the max/COALESCE of one. When only one embedding exists, that single
    // similarity is used unchanged (no penalty). The two weights are normalized
    // at use, so only their ratio matters; library is weighted slightly higher
    // by default because library embeddings are built from richer owned-item
    // metadata. See `buildFusedSimilarityExpr`.
    get EMBEDDING_FUSION_LIBRARY_WEIGHT(): number {
        return getFloat(
            'EMBEDDING_FUSION_LIBRARY_WEIGHT',
            env.EMBEDDING_FUSION_LIBRARY_WEIGHT,
            0.6,
        );
    },
    get EMBEDDING_FUSION_DISCOVERY_WEIGHT(): number {
        return getFloat(
            'EMBEDDING_FUSION_DISCOVERY_WEIGHT',
            env.EMBEDDING_FUSION_DISCOVERY_WEIGHT,
            0.4,
        );
    },

    // Default items per section/carousel
    get FORYOU_DEFAULT_LIMIT(): number {
        return getNumber('FORYOU_DEFAULT_LIMIT', env.FORYOU_DEFAULT_LIMIT, 10);
    },

    // "Because you watched X" - number of source movies to use
    get FORYOU_SOURCES_LIMIT(): number {
        return getNumber('FORYOU_SOURCES_LIMIT', env.FORYOU_SOURCES_LIMIT, 3);
    },

    // Similar items per source movie
    get FORYOU_SIMILAR_PER_SOURCE(): number {
        return getNumber('FORYOU_SIMILAR_PER_SOURCE', env.FORYOU_SIMILAR_PER_SOURCE, 8);
    },

    // Keyword-based sections: number of rows and items per row
    get FORYOU_KEYWORD_ROWS(): number {
        return getNumber('FORYOU_KEYWORD_ROWS', env.FORYOU_KEYWORD_ROWS, 2);
    },
    get FORYOU_KEYWORD_ITEMS(): number {
        return getNumber('FORYOU_KEYWORD_ITEMS', env.FORYOU_KEYWORD_ITEMS, 8);
    },

    // Mood recommendations limit
    get FORYOU_MOOD_LIMIT(): number {
        return getNumber('FORYOU_MOOD_LIMIT', env.FORYOU_MOOD_LIMIT, 12);
    },

    // Ratio of available vs requestable content (0.0 to 1.0)
    // Higher = more available content, lower = more requestable/discovery content
    // Similar media ratio (default 0.5 = 50% available, 50% requestable)
    get FORYOU_SIMILAR_AVAILABLE_RATIO(): number {
        return getFloat('FORYOU_SIMILAR_AVAILABLE_RATIO', env.FORYOU_SIMILAR_AVAILABLE_RATIO, 0.5);
    },

    // Binge-worthy series ratio (default 0.7 = 70% available, 30% requestable)
    get FORYOU_BINGE_AVAILABLE_RATIO(): number {
        return getFloat('FORYOU_BINGE_AVAILABLE_RATIO', env.FORYOU_BINGE_AVAILABLE_RATIO, 0.7);
    },

    // Keywords section ratio (default 0.5 = 50% available)
    get FORYOU_KEYWORDS_AVAILABLE_RATIO(): number {
        return getFloat(
            'FORYOU_KEYWORDS_AVAILABLE_RATIO',
            env.FORYOU_KEYWORDS_AVAILABLE_RATIO,
            0.5,
        );
    },

    // Similar media cache TTL in hours (default 24)
    get FORYOU_SIMILAR_CACHE_HOURS(): number {
        return getNumber('FORYOU_SIMILAR_CACHE_HOURS', env.FORYOU_SIMILAR_CACHE_HOURS, 24);
    },

    // Second "Because you watched" section
    // When enabled, adds an additional "Because you watched" section further down the page
    // using a source from the minority media type (movies if mostly TV, or vice versa)
    get FORYOU_SECOND_BECAUSE_SECTION(): boolean {
        return getBool('FORYOU_SECOND_BECAUSE_SECTION', env.FORYOU_SECOND_BECAUSE_SECTION, true);
    },
    // Number of items to show in the second "Because you watched" section
    get FORYOU_SECOND_BECAUSE_LIMIT(): number {
        return getNumber('FORYOU_SECOND_BECAUSE_LIMIT', env.FORYOU_SECOND_BECAUSE_LIMIT, 8);
    },

    // Anime section thresholds
    // Minimum anime watched in recent months to show anime section
    get FORYOU_ANIME_MIN_WATCHED(): number {
        return getNumber('FORYOU_ANIME_MIN_WATCHED', env.FORYOU_ANIME_MIN_WATCHED, 3);
    },
    // Recency window in months for anime watch history
    get FORYOU_ANIME_RECENCY_MONTHS(): number {
        return getNumber('FORYOU_ANIME_RECENCY_MONTHS', env.FORYOU_ANIME_RECENCY_MONTHS, 3);
    },

    // Behavioral abandonment soft-demote in personalized buckets.
    // When enabled, items the user abandoned with >=5min real watch time AND
    // <60% completion are demoted (not blacklisted) in personalized
    // recommendations. Sessions <5min are treated as peeks and ignored.
    get FEATURE_FORYOU_ABANDONMENT_DEMOTE(): boolean {
        return getBool(
            'FEATURE_FORYOU_ABANDONMENT_DEMOTE',
            env.FEATURE_FORYOU_ABANDONMENT_DEMOTE,
            false,
        );
    },
    // Weight multiplier applied to abandoned items' contribution to the user
    // taste profile. 0.3 = 70% reduction; 1.0 = no demote.
    get FORYOU_ABANDONMENT_DEMOTE_MULTIPLIER(): number {
        return getFloat(
            'FORYOU_ABANDONMENT_DEMOTE_MULTIPLIER',
            env.FORYOU_ABANDONMENT_DEMOTE_MULTIPLIER,
            0.3,
        );
    },
    // Page-level section engagement ranker (M3). When enabled, the long-tail
    // For-You carousel sections are reordered per-user by accumulated
    // engagement (see user-section-feedback.queries.ts + section-ranker.ts)
    // instead of always rendering in their canonical order. Off by default —
    // ships dark until the ranker is verified against real engagement data.
    get FEATURE_FORYOU_SECTION_RANKER(): boolean {
        return getBool('FEATURE_FORYOU_SECTION_RANKER', env.FEATURE_FORYOU_SECTION_RANKER, false);
    },
    // Minimum user ratings required for AI recommendations
    get FORYOU_MIN_RATINGS(): number {
        return getNumber('FORYOU_MIN_RATINGS', env.FORYOU_MIN_RATINGS, 5);
    },
    // Minimum watched (movie/tv) items required when ratings < FORYOU_MIN_RATINGS.
    // Clamped to >= 1 so a misconfigured 0 can't make every request attempt a
    // (futile) profile build for users with no watch history.
    get FORYOU_MIN_WATCHED(): number {
        return Math.max(1, getNumber('FORYOU_MIN_WATCHED', env.FORYOU_MIN_WATCHED, 10));
    },

    // =========================================================================
    // For You / Scoring Weights (AI Recommendation Algorithm)
    // =========================================================================
    // These control how different factors influence recommendation scoring.
    // Higher values = more influence. Negative weights penalize matching content.

    // --- Main AI Recommendations Scoring ---
    // AI similarity weight (how much the AI embedding match matters)
    get FORYOU_WEIGHT_AI_SIMILARITY(): number {
        return getFloat('FORYOU_WEIGHT_AI_SIMILARITY', env.FORYOU_WEIGHT_AI_SIMILARITY, 0.4);
    },
    // Quality score weights (MDBList aggregated score and IMDB rating)
    get FORYOU_WEIGHT_MDBLIST_SCORE(): number {
        return getFloat('FORYOU_WEIGHT_MDBLIST_SCORE', env.FORYOU_WEIGHT_MDBLIST_SCORE, 0.12);
    },
    get FORYOU_WEIGHT_IMDB_RATING(): number {
        return getFloat('FORYOU_WEIGHT_IMDB_RATING', env.FORYOU_WEIGHT_IMDB_RATING, 0.08);
    },

    // --- Like/Dislike Penalty Weights ---
    // Keyword overlap weights (boost liked keywords, penalize disliked)
    get FORYOU_WEIGHT_LIKED_KEYWORD(): number {
        return getFloat('FORYOU_WEIGHT_LIKED_KEYWORD', env.FORYOU_WEIGHT_LIKED_KEYWORD, 0.05);
    },
    get FORYOU_WEIGHT_DISLIKED_KEYWORD(): number {
        return getFloat('FORYOU_WEIGHT_DISLIKED_KEYWORD', env.FORYOU_WEIGHT_DISLIKED_KEYWORD, 0.18);
    },
    // Genre overlap weights (boost liked genres, penalize disliked)
    get FORYOU_WEIGHT_LIKED_GENRE(): number {
        return getFloat('FORYOU_WEIGHT_LIKED_GENRE', env.FORYOU_WEIGHT_LIKED_GENRE, 0.03);
    },
    get FORYOU_WEIGHT_DISLIKED_GENRE(): number {
        return getFloat('FORYOU_WEIGHT_DISLIKED_GENRE', env.FORYOU_WEIGHT_DISLIKED_GENRE, 0.08);
    },
    // Year/era overlap weights (boost liked eras, penalize disliked)
    get FORYOU_WEIGHT_LIKED_YEAR(): number {
        return getFloat('FORYOU_WEIGHT_LIKED_YEAR', env.FORYOU_WEIGHT_LIKED_YEAR, 0.02);
    },
    get FORYOU_WEIGHT_DISLIKED_YEAR(): number {
        return getFloat('FORYOU_WEIGHT_DISLIKED_YEAR', env.FORYOU_WEIGHT_DISLIKED_YEAR, 0.06);
    },

    // --- Similar Media Scoring (vector similarity based) ---
    // Penalty for disliked keywords in similar media results
    get FORYOU_SIMILAR_WEIGHT_DISLIKED_KEYWORD(): number {
        return getFloat(
            'FORYOU_SIMILAR_WEIGHT_DISLIKED_KEYWORD',
            env.FORYOU_SIMILAR_WEIGHT_DISLIKED_KEYWORD,
            0.05,
        );
    },
    // Penalty for disliked genres in similar media results
    get FORYOU_SIMILAR_WEIGHT_DISLIKED_GENRE(): number {
        return getFloat(
            'FORYOU_SIMILAR_WEIGHT_DISLIKED_GENRE',
            env.FORYOU_SIMILAR_WEIGHT_DISLIKED_GENRE,
            0.02,
        );
    },

    // --- Keyword Section Scoring ---
    // AI similarity multiplier for keyword-based sections
    get FORYOU_KEYWORD_WEIGHT_AI(): number {
        return getFloat('FORYOU_KEYWORD_WEIGHT_AI', env.FORYOU_KEYWORD_WEIGHT_AI, 30);
    },
    // MDBList score multiplier for keyword sections
    get FORYOU_KEYWORD_WEIGHT_MDBLIST(): number {
        return getFloat('FORYOU_KEYWORD_WEIGHT_MDBLIST', env.FORYOU_KEYWORD_WEIGHT_MDBLIST, 0.5);
    },
    // Dislike penalties for keyword sections
    get FORYOU_KEYWORD_WEIGHT_DISLIKED_KEYWORD(): number {
        return getFloat(
            'FORYOU_KEYWORD_WEIGHT_DISLIKED_KEYWORD',
            env.FORYOU_KEYWORD_WEIGHT_DISLIKED_KEYWORD,
            2,
        );
    },
    get FORYOU_KEYWORD_WEIGHT_DISLIKED_GENRE(): number {
        return getFloat(
            'FORYOU_KEYWORD_WEIGHT_DISLIKED_GENRE',
            env.FORYOU_KEYWORD_WEIGHT_DISLIKED_GENRE,
            0.5,
        );
    },

    // --- Anime Section Scoring ---
    // AI similarity weight for anime recommendations
    get FORYOU_ANIME_WEIGHT_AI(): number {
        return getFloat('FORYOU_ANIME_WEIGHT_AI', env.FORYOU_ANIME_WEIGHT_AI, 0.6);
    },
    // Quality weights for anime (MDBList and IMDB)
    get FORYOU_ANIME_WEIGHT_MDBLIST(): number {
        return getFloat('FORYOU_ANIME_WEIGHT_MDBLIST', env.FORYOU_ANIME_WEIGHT_MDBLIST, 0.25);
    },
    get FORYOU_ANIME_WEIGHT_IMDB(): number {
        return getFloat('FORYOU_ANIME_WEIGHT_IMDB', env.FORYOU_ANIME_WEIGHT_IMDB, 0.15);
    },

    // =========================================================================
    // Player / Video Quality Settings
    // =========================================================================

    // Skip forward/backward duration in seconds
    get PLAYER_SKIP_SECONDS(): number {
        return getNumber('PLAYER_SKIP_SECONDS', env.PLAYER_SKIP_SECONDS, 10);
    },

    get NEXT_EPISODE_COUNTDOWN_SECONDS(): number {
        return getNumber('NEXT_EPISODE_COUNTDOWN_SECONDS', env.NEXT_EPISODE_COUNTDOWN_SECONDS, 10);
    },

    // Lead time (seconds) for showing the next-episode prompt relative to the
    // start of the credits/outro segment. Positive = show earlier (before
    // credits begin), negative = delay until after credits begin, 0 = exactly
    // at credits start. Only affects content with an Outro media segment.
    get NEXT_EPISODE_PROMPT_LEAD_SECONDS(): number {
        return Math.max(
            -30,
            Math.min(
                60,
                getNumber(
                    'NEXT_EPISODE_PROMPT_LEAD_SECONDS',
                    env.NEXT_EPISODE_PROMPT_LEAD_SECONDS,
                    0,
                ),
            ),
        );
    },

    // Default quality mode: 'original' (source quality), 'auto' (adaptive bitrate)
    // Note: 'auto' requires FEATURE_PLAYER_AUTO_QUALITY=true to be available
    get PLAYER_DEFAULT_QUALITY_MODE(): 'original' | 'auto' {
        return getEnum(
            'PLAYER_DEFAULT_QUALITY_MODE',
            env.PLAYER_DEFAULT_QUALITY_MODE,
            ['original', 'auto'],
            'original',
        );
    },

    // hls.js VOD-only buffer settings. Live TV uses the fixed live hls.js defaults.
    get PLAYER_HLS_JS_VOD_MAX_BUFFER_SIZE_BYTES(): number {
        return getNumber(
            'PLAYER_HLS_JS_VOD_MAX_BUFFER_SIZE_BYTES',
            env.PLAYER_HLS_JS_VOD_MAX_BUFFER_SIZE_BYTES,
            1_000_000_000,
        );
    },
    get PLAYER_HLS_JS_VOD_MAX_BUFFER_LENGTH_SECONDS(): number {
        return getNumber(
            'PLAYER_HLS_JS_VOD_MAX_BUFFER_LENGTH_SECONDS',
            env.PLAYER_HLS_JS_VOD_MAX_BUFFER_LENGTH_SECONDS,
            600,
        );
    },
    get PLAYER_HLS_JS_VOD_MAX_MAX_BUFFER_LENGTH_SECONDS(): number {
        return getNumber(
            'PLAYER_HLS_JS_VOD_MAX_MAX_BUFFER_LENGTH_SECONDS',
            env.PLAYER_HLS_JS_VOD_MAX_MAX_BUFFER_LENGTH_SECONDS,
            1800,
        );
    },
    get PLAYER_HLS_JS_VOD_BACK_BUFFER_LENGTH_SECONDS(): number {
        return getNumber(
            'PLAYER_HLS_JS_VOD_BACK_BUFFER_LENGTH_SECONDS',
            env.PLAYER_HLS_JS_VOD_BACK_BUFFER_LENGTH_SECONDS,
            30,
        );
    },

    // Auto quality mode settings (adaptive bitrate)
    // Initial stability period before quality switching (ms)
    get PLAYER_QUALITY_STABILITY_MS(): number {
        return getNumber('PLAYER_QUALITY_STABILITY_MS', env.PLAYER_QUALITY_STABILITY_MS, 10000);
    },
    // Cooldown after switching to lower quality (ms)
    get PLAYER_QUALITY_DOWN_COOLDOWN_MS(): number {
        return getNumber(
            'PLAYER_QUALITY_DOWN_COOLDOWN_MS',
            env.PLAYER_QUALITY_DOWN_COOLDOWN_MS,
            10000,
        );
    },
    // Cooldown after switching to higher quality (ms)
    get PLAYER_QUALITY_UP_COOLDOWN_MS(): number {
        return getNumber('PLAYER_QUALITY_UP_COOLDOWN_MS', env.PLAYER_QUALITY_UP_COOLDOWN_MS, 30000);
    },
    // Number of bandwidth samples for averaging
    get PLAYER_BANDWIDTH_SAMPLES(): number {
        return getNumber('PLAYER_BANDWIDTH_SAMPLES', env.PLAYER_BANDWIDTH_SAMPLES, 5);
    },
    // Minimum samples before first quality switch
    get PLAYER_MIN_SAMPLES_BEFORE_SWITCH(): number {
        return getNumber(
            'PLAYER_MIN_SAMPLES_BEFORE_SWITCH',
            env.PLAYER_MIN_SAMPLES_BEFORE_SWITCH,
            3,
        );
    },
    // Minimum bitrate threshold for adaptive quality (bps, default 2 Mbps)
    get PLAYER_MIN_ADAPTIVE_BITRATE(): number {
        return getNumber('PLAYER_MIN_ADAPTIVE_BITRATE', env.PLAYER_MIN_ADAPTIVE_BITRATE, 2000000);
    },
    // Subtitle size multiplier - global boost for all subtitle types
    get PLAYER_SUBTITLE_SIZE_MULTIPLIER(): number {
        return getFloat(
            'PLAYER_SUBTITLE_SIZE_MULTIPLIER',
            env.PLAYER_SUBTITLE_SIZE_MULTIPLIER,
            1.2,
        );
    },
    // PGS subtitle scale (percentage) - aligns bitmap subtitles with SRT sizing
    get PLAYER_SUBTITLE_PGS_SCALE(): number {
        return getNumber('PLAYER_SUBTITLE_PGS_SCALE', env.PLAYER_SUBTITLE_PGS_SCALE, 55);
    },
    // SRT subtitle scale - percentage factor for text subtitles
    get PLAYER_SUBTITLE_SRT_SCALE(): number {
        return getNumber('PLAYER_SUBTITLE_SRT_SCALE', env.PLAYER_SUBTITLE_SRT_SCALE, 140);
    },
    // Volume curve for the volume slider — how slider position maps to actual
    // playback volume. 'quadratic'/'quartic' front-load precision at low volume
    // to match human hearing; 'linear' disables the transform.
    get PLAYER_VOLUME_CURVE(): 'linear' | 'quadratic' | 'quartic' {
        return getEnum(
            'PLAYER_VOLUME_CURVE',
            env.PLAYER_VOLUME_CURVE,
            ['linear', 'quadratic', 'quartic'],
            'quadratic',
        );
    },

    // =========================================================================
    // Browse Page Settings
    // =========================================================================

    // Search input debounce delay (ms)
    get BROWSE_SEARCH_DEBOUNCE_MS(): number {
        return getNumber('BROWSE_SEARCH_DEBOUNCE_MS', env.BROWSE_SEARCH_DEBOUNCE_MS, 200);
    },
    // Items per page in A-Z browse mode
    get BROWSE_AZ_PAGE_SIZE(): number {
        return getNumber('BROWSE_AZ_PAGE_SIZE', env.BROWSE_AZ_PAGE_SIZE, 50);
    },
    // Initial keyword sections to load
    get BROWSE_KEYWORDS_INITIAL(): number {
        return getNumber('BROWSE_KEYWORDS_INITIAL', env.BROWSE_KEYWORDS_INITIAL, 5);
    },
    // Keyword sections per pagination page
    get BROWSE_KEYWORDS_PAGE_SIZE(): number {
        return getNumber('BROWSE_KEYWORDS_PAGE_SIZE', env.BROWSE_KEYWORDS_PAGE_SIZE, 5);
    },
    // Intersection observer margins for lazy loading (px)
    get BROWSE_SCROLL_MARGIN(): string {
        return getString('BROWSE_SCROLL_MARGIN', env.BROWSE_SCROLL_MARGIN, '400px');
    },
    // Trigram similarity threshold for fuzzy search (0.0-1.0)
    // Lower = more lenient (catches more typos but more false positives)
    // Default 0.25 catches typos like "milo farow" -> "Milo Farrow"
    get SEARCH_TRIGRAM_THRESHOLD(): number {
        return getFloat('SEARCH_TRIGRAM_THRESHOLD', env.SEARCH_TRIGRAM_THRESHOLD, 0.25);
    },
    // Typo tolerance mode: 'off' = FTS only, 'fallback' = trigram when FTS insufficient, 'always' = both in parallel
    get SEARCH_TYPO_TOLERANCE(): 'off' | 'fallback' | 'always' {
        return getEnum(
            'SEARCH_TYPO_TOLERANCE',
            env.SEARCH_TYPO_TOLERANCE,
            ['off', 'fallback', 'always'],
            'fallback',
        );
    },
    // Minimum FTS results before skipping trigram fallback (only for 'fallback' mode)
    get SEARCH_TYPO_MIN_RESULTS(): number {
        return getNumber('SEARCH_TYPO_MIN_RESULTS', env.SEARCH_TYPO_MIN_RESULTS, 3);
    },

    // =========================================================================
    // Homepage Widget Settings
    // =========================================================================

    // Trending section items limit
    get HOMEPAGE_TRENDING_LIMIT(): number {
        return getNumber('HOMEPAGE_TRENDING_LIMIT', env.HOMEPAGE_TRENDING_LIMIT, 20);
    },
    // Holiday recommendations limit
    get HOMEPAGE_HOLIDAY_LIMIT(): number {
        return getNumber('HOMEPAGE_HOLIDAY_LIMIT', env.HOMEPAGE_HOLIDAY_LIMIT, 20);
    },
    // Widget drag-and-drop animation duration (ms)
    get HOMEPAGE_DND_ANIMATION_MS(): number {
        return getNumber('HOMEPAGE_DND_ANIMATION_MS', env.HOMEPAGE_DND_ANIMATION_MS, 300);
    },
    // Search input debounce delay (ms)
    get HOMEPAGE_SEARCH_DEBOUNCE_MS(): number {
        return getNumber('HOMEPAGE_SEARCH_DEBOUNCE_MS', env.HOMEPAGE_SEARCH_DEBOUNCE_MS, 300);
    },

    // =========================================================================
    // Trending Widget Settings
    // =========================================================================

    // Enable/disable trending widget (MDBList content)
    get FEATURE_TRENDING(): boolean {
        return getBool('FEATURE_TRENDING', env.FEATURE_TRENDING, true);
    },

    // =========================================================================
    // Background Sync Intervals (hours)
    // =========================================================================

    // Curated lists sync interval
    get SYNC_CURATED_LISTS_HOURS(): number {
        return getNumber('SYNC_CURATED_LISTS_HOURS', env.SYNC_CURATED_LISTS_HOURS, 12);
    },

    // =========================================================================
    // Toast / Notification Settings
    // =========================================================================

    // Default toast notification timeout (ms)
    get TOAST_DEFAULT_TIMEOUT_MS(): number {
        return getNumber('TOAST_DEFAULT_TIMEOUT_MS', env.TOAST_DEFAULT_TIMEOUT_MS, 5000);
    },

    // =========================================================================
    // SSE connection budgets (P1, 2026-09-13 fix plan)
    // =========================================================================

    // Max concurrent SSE connections one user may hold on a single SSE hub
    // (createSseReplayHub) — /events, /runs/stream, /admin/ingest/stream each
    // enforce this independently.
    //
    // ⚠️ PER-PRODUCER, not a single account-wide total (2026-09-16 fix plan,
    // batch A fix round 1): every SSE producer — each `createSseReplayHub`
    // instance, watch-together, play-sessions/[id]/events, runs/[id]/logs,
    // and /api/plugins/[featureId]/realtime — reads this same config value
    // and enforces it against its OWN registry (see
    // `sse-connection-guard.ts`'s `acquireSseConnectGuard` and each
    // producer's own `getActive*SSECount()`). A user can therefore hold up
    // to this many connections on EACH producer simultaneously, not this
    // many in total across the whole app. The name is operator-facing
    // shorthand, not a literal per-account cap — there is no cross-producer
    // total today.
    get SSE_MAX_CONNECTIONS_PER_USER(): number {
        return getNumber('SSE_MAX_CONNECTIONS_PER_USER', env.SSE_MAX_CONNECTIONS_PER_USER, 16);
    },
    // Process-wide ceiling on concurrent SSE connections a single replica will
    // hold for one SSE hub instance.
    //
    // ⚠️ Same per-producer caveat as SSE_MAX_CONNECTIONS_PER_USER above: each
    // producer's own registry is capped independently, not the replica's
    // total SSE connection count across every producer combined.
    get SSE_MAX_CONNECTIONS(): number {
        return getNumber('SSE_MAX_CONNECTIONS', env.SSE_MAX_CONNECTIONS, 5000);
    },
    // Request notification expiry for available items (hours)
    get REQUEST_AVAILABLE_EXPIRE_HOURS(): number {
        return getNumber('REQUEST_AVAILABLE_EXPIRE_HOURS', env.REQUEST_AVAILABLE_EXPIRE_HOURS, 24);
    },
    // =========================================================================
    // Watch Together / Sync Settings
    // =========================================================================

    // Ceiling on the watch-together SSE reconnect backoff (ms). NOT a give-up
    // deadline — `maxReconnectAttempts` ends the retry loop. Read in the
    // browser via $lib/stores/client-tuning.
    get WATCH_TOGETHER_MAX_RECONNECT_MS(): number {
        return getNumber(
            'WATCH_TOGETHER_MAX_RECONNECT_MS',
            env.WATCH_TOGETHER_MAX_RECONNECT_MS,
            30000,
        );
    },
    // A party whose host has had no stream connection and no heartbeat for this
    // many minutes is ended for everyone (session_ended). Long enough that a host
    // briefly leaving the app (Apple TV Home button) keeps the party.
    get WATCH_TOGETHER_HOST_ABSENT_MINUTES(): number {
        return Math.max(
            1,
            Math.min(
                1440,
                getNumber(
                    'WATCH_TOGETHER_HOST_ABSENT_MINUTES',
                    env.WATCH_TOGETHER_HOST_ABSENT_MINUTES,
                    10,
                ),
            ),
        );
    },
    // Watch parties list refresh interval (ms)
    get WATCH_PARTIES_REFRESH_MS(): number {
        return getNumber('WATCH_PARTIES_REFRESH_MS', env.WATCH_PARTIES_REFRESH_MS, 15000);
    },

    // =========================================================================
    // AI Dashboard Settings
    // =========================================================================

    // Music autoplay persistent cool-down window (hours).
    // 0 disables the cool-down; session-level filter still applies.
    get MUSIC_AUTOPLAY_COOLDOWN_HOURS(): number {
        return getNumber('MUSIC_AUTOPLAY_COOLDOWN_HOURS', env.MUSIC_AUTOPLAY_COOLDOWN_HOURS, 24);
    },
    // How many top scored candidates autoNext is sampled from (weighted by
    // similarity). 1 = deterministic (legacy). Higher trades quality for variety.
    get MUSIC_AUTOPLAY_TOP_K(): number {
        return getNumber('MUSIC_AUTOPLAY_TOP_K', env.MUSIC_AUTOPLAY_TOP_K, 5);
    },
    // Additive weight on similarity to the session-start track. Slows the
    // drift toward the user's dominant taste cluster after many hops by
    // keeping gentle gravity back to the seed. 0 = disabled (legacy).
    get MUSIC_AUTOPLAY_SEED_ANCHOR_WEIGHT(): number {
        return getFloat(
            'MUSIC_AUTOPLAY_SEED_ANCHOR_WEIGHT',
            env.MUSIC_AUTOPLAY_SEED_ANCHOR_WEIGHT,
            0.15,
        );
    },
    // Minimum track length (seconds) for autoplay candidates — keeps album
    // intros / interludes / skits out of the queue. 0 disables. NULL
    // runtimes are kept (treated as long enough) to avoid losing tracks
    // with missing metadata.
    get MUSIC_AUTOPLAY_MIN_TRACK_SECONDS(): number {
        return getNumber(
            'MUSIC_AUTOPLAY_MIN_TRACK_SECONDS',
            env.MUSIC_AUTOPLAY_MIN_TRACK_SECONDS,
            90,
        );
    },
    // Maximum track length (seconds) for autoplay/quick-pick candidates —
    // keeps full compilations and DJ mixes out of short-form recommendations.
    // 0 disables. NULL runtimes are kept to avoid losing tracks with missing
    // metadata.
    get MUSIC_AUTOPLAY_MAX_TRACK_SECONDS(): number {
        return getNumber(
            'MUSIC_AUTOPLAY_MAX_TRACK_SECONDS',
            env.MUSIC_AUTOPLAY_MAX_TRACK_SECONDS,
            900,
        );
    },
    // Popularity-aware smart-queue ranking (dark-shipped; ramp WEIGHT above 0
    // only after inspecting coverage in admin diagnostics).
    //   factor = (1 - WEIGHT) + WEIGHT * GREATEST(POWER(score, EXPONENT), FLOOR)
    // WEIGHT=0 → factor always 1 (feature off). WEIGHT=1 → full influence.
    //
    // ⚠️ MEASURED HARMFUL ON A REAL LIBRARY — LEAVE AT 0 UNLESS YOU HAVE A
    // BETTER SIGNAL. Tested on prod 2026-08-19 at WEIGHT=0.3 (24k tracks): a
    // hands-up seed drifted straight out of its genre into Lady Luma, Katie
    // Vale, Eli Fenwick, Mariner 5 and Kyra Fenwick within a few hops.
    // Reverted the same day.
    //
    // WHY it fails: media_popularity.normalized_score is GLOBAL artist
    // popularity, unconditioned on the seed. Among sonically-similar
    // candidates the globally-famous artist therefore wins every tiebreak
    // regardless of scene, so the term trades genre fidelity for fame. The
    // commercial services this was meant to imitate do not have this problem
    // because their signal is co-listening CONDITIONED on the seed
    // ("people who played this also played…"), which is a different quantity
    // that merely correlates with global fame when the seed is mainstream.
    //
    // A scene-conditioned signal would be sound — the Last.fm similar_artists
    // data already fetched for music-lane-affinity.ts is the obvious source —
    // as would a crude bottom-tail cut (demote only artists under ~1k
    // listeners) rather than a continuous global scale. Neither is built.
    //
    // The SHAPE of the existing implementation is worth keeping if this is
    // revisited: the sonic path uses the ARTIST-level score (100% coverage on
    // that library vs 57% for track-level, so a track-first formula demotes
    // ~43% of a library for MISSING data), and treats no-data as NEUTRAL
    // rather than the floor (149/2650 artist rows carry score 0 with NULL
    // raw_listeners — a failed provider match, not an unpopular artist;
    // flooring those demotes acts the services actively recommend). NOTE the
    // metadata path's own formula still gets that second point wrong
    // (`WHEN artist_pop_score IS NOT NULL THEN floor`); it is dormant only
    // because this weight defaults to 0.
    get MUSIC_POPULARITY_WEIGHT(): number {
        return getFloat('MUSIC_POPULARITY_WEIGHT', env.MUSIC_POPULARITY_WEIGHT, 0);
    },
    // Exponent on the normalized popularity score. 1.0 = linear, 0.5 = gentle
    // demotion (sqrt), lower values flatten the curve further.
    get MUSIC_POPULARITY_EXPONENT(): number {
        return getFloat('MUSIC_POPULARITY_EXPONENT', env.MUSIC_POPULARITY_EXPONENT, 0.5);
    },
    // Floor applied when artist was fetched but this specific track wasn't in
    // the provider's top list. Prevents hard exclusion of deep cuts.
    get MUSIC_POPULARITY_FLOOR(): number {
        return getFloat('MUSIC_POPULARITY_FLOOR', env.MUSIC_POPULARITY_FLOOR, 0.1);
    },
    // Which popularity source drives smart-queue ranking. Future values:
    // 'listenbrainz', 'local'. Must match a PopularityProvider.id.
    get MUSIC_POPULARITY_PRIMARY_SOURCE(): string {
        return getString(
            'MUSIC_POPULARITY_PRIMARY_SOURCE',
            env.MUSIC_POPULARITY_PRIMARY_SOURCE,
            'lastfm',
        );
    },

    // Minimum number of MSCLAP candidates the sonic queue must return before
    // it is used. Below this threshold the pool is too small for MMR + artist +
    // album diversity to produce meaningful variety — the route falls through to
    // the metadata embedding path instead. 0 = use sonic path even for a single
    // candidate (legacy behaviour). 5 = recommended (default).
    get MUSIC_SONIC_QUEUE_MIN_CANDIDATES(): number {
        return getNumber(
            'MUSIC_SONIC_QUEUE_MIN_CANDIDATES',
            env.MUSIC_SONIC_QUEUE_MIN_CANDIDATES,
            5,
        );
    },
    // Additive weight (scaled by streak cohesion) applied to a candidate's
    // genre-affinity score during a same-genre listening streak. Symmetric:
    // candidates matching the streak's dominant genre are boosted by up to
    // this much, candidates with confirmed zero genre overlap are penalized
    // by up to this much. Untagged candidates are never affected. 0 =
    // disabled (legacy behaviour — genre never influences autoplay ranking
    // beyond the existing small overlap-with-current-track boost).
    get MUSIC_AUTOPLAY_GENRE_STREAK_WEIGHT(): number {
        return getFloat(
            'MUSIC_AUTOPLAY_GENRE_STREAK_WEIGHT',
            env.MUSIC_AUTOPLAY_GENRE_STREAK_WEIGHT,
            0.25,
        );
    },
    // Minimum genre-profile cohesion (dominance of the strongest tag across
    // recency-weighted recent session history) required before a listening
    // streak is considered "active" — i.e. before the genre-affinity score
    // adjustment and the key-compatibility gate exemption kick in. Lower =
    // triggers on looser genre consistency. 1 = only a perfectly uniform
    // recent history triggers it.
    get MUSIC_AUTOPLAY_GENRE_STREAK_COHESION_THRESHOLD(): number {
        return getFloat(
            'MUSIC_AUTOPLAY_GENRE_STREAK_COHESION_THRESHOLD',
            env.MUSIC_AUTOPLAY_GENRE_STREAK_COHESION_THRESHOLD,
            0.5,
        );
    },
    // Weight of the BPM/key "blend compatibility" smart-queue tiebreak (see
    // music-queue-scoring.ts). Only meaningful for clients that actually
    // crossfade — disabled (0) per-request when the client signals
    // crossfade=0 (hard-cut playback, e.g. iOS), since tempo/key relationship
    // between two tracks that never overlap has no audible effect. MUST stay
    // well below the typical within-pool similarity spread (~0.1) — this is
    // a tiebreak among near-equal candidates, never a decider.
    // Clamped to the schema's [0, 0.5] here because env-var overrides bypass
    // the settings-schema min/max validation (JSON-file loads enforce it,
    // parseEnvValue does not) — an unclamped typo like "5" would let this
    // tiebreak dominate similarity, resurrecting the hard-gate failure mode.
    get MUSIC_AUTOPLAY_MIX_BLEND_WEIGHT(): number {
        return Math.min(
            Math.max(
                getFloat(
                    'MUSIC_AUTOPLAY_MIX_BLEND_WEIGHT',
                    env.MUSIC_AUTOPLAY_MIX_BLEND_WEIGHT,
                    0.04,
                ),
                0,
            ),
            0.5,
        );
    },
    // Weight of the energy-continuity smart-queue tiebreak (see
    // music-queue-scoring.ts). Applies regardless of client crossfade
    // capability — an energy cliff is audible on a hard cut too, it isn't a
    // mixing-only artifact. Same ≪ similarity-spread (~0.1) invariant as
    // MUSIC_AUTOPLAY_MIX_BLEND_WEIGHT above.
    // Clamped to [0, 0.5] for the same env-var-bypass reason as
    // MUSIC_AUTOPLAY_MIX_BLEND_WEIGHT above.
    get MUSIC_AUTOPLAY_ENERGY_FLOW_WEIGHT(): number {
        return Math.min(
            Math.max(
                getFloat(
                    'MUSIC_AUTOPLAY_ENERGY_FLOW_WEIGHT',
                    env.MUSIC_AUTOPLAY_ENERGY_FLOW_WEIGHT,
                    0.04,
                ),
                0,
            ),
            0.5,
        );
    },
    // Weight of the user's sonic taste vector in the smart-queue retrieval
    // blend when no mood seed is active (the queue-context centroid gets
    // 1 − weight). Keep small: taste should tint the neighborhood around
    // what's currently playing, not co-steer retrieval — at 0.5 the taste
    // arm demonstrably dragged genre-distant seeds (mambo, 80s new wave)
    // into the user's dominant genre within a few autoplay picks. During a
    // cohesive same-genre listening streak the route additionally scales
    // this down by (1 − streak cohesion). 0 disables the taste arm.
    // Clamped to [0, 0.5] for the same env-var-bypass reason as
    // MUSIC_AUTOPLAY_MIX_BLEND_WEIGHT above.
    get MUSIC_SONIC_TASTE_WEIGHT(): number {
        return Math.min(
            Math.max(getFloat('MUSIC_SONIC_TASTE_WEIGHT', env.MUSIC_SONIC_TASTE_WEIGHT, 0.2), 0),
            0.5,
        );
    },
    // Weight of the Last.fm lane-affinity smart-queue re-rank term (see
    // music-lane-affinity.ts). Centered ±weight: same-scene artists (crowd
    // tags / similar-artist links) get boosted, disjoint scenes demoted,
    // missing data neutral. Audio similarity hears production, not scene —
    // this term separates e.g. hands-up remixes from French electro-house at
    // the same BPM. Must stay comparable to the genre boost (0.12) and below
    // clear similarity gaps so audio remains the decider. 0 disables it.
    // Clamped to [0, 0.5] for the same env-var-bypass reason as
    // MUSIC_AUTOPLAY_MIX_BLEND_WEIGHT above.
    get MUSIC_SONIC_LANE_WEIGHT(): number {
        return Math.min(
            Math.max(getFloat('MUSIC_SONIC_LANE_WEIGHT', env.MUSIC_SONIC_LANE_WEIGHT, 0.08), 0),
            0.5,
        );
    },
    // Secret for signing HMAC transcode-params tokens.
    // Falls back to a derivative of JWT_SECRET when unset.
    // NOTE: Set via environment variable only (secret).
    MUSIC_TRANSCODE_TOKEN_SECRET: env.MUSIC_TRANSCODE_TOKEN_SECRET || '',

    // =========================================================================
    // Music Transcode Settings
    // =========================================================================

    // Whether the music transcoding feature is enabled.
    get FEATURE_MUSIC_TRANSCODE(): boolean {
        return getBool('FEATURE_MUSIC_TRANSCODE', env.FEATURE_MUSIC_TRANSCODE, true);
    },
    // Filesystem path for the on-disk transcode cache.
    // Must be on a persistent volume (survives restarts).
    get MUSIC_TRANSCODE_CACHE_DIR(): string {
        return getString(
            'MUSIC_TRANSCODE_CACHE_DIR',
            env.MUSIC_TRANSCODE_CACHE_DIR,
            '/config/cache/music-transcode',
        );
    },
    // Maximum total size of the transcode cache in gigabytes before the reaper
    // evicts the least-recently-used files.
    get MUSIC_TRANSCODE_CACHE_MAX_GB(): number {
        return getNumber('MUSIC_TRANSCODE_CACHE_MAX_GB', env.MUSIC_TRANSCODE_CACHE_MAX_GB, 10);
    },
    // How often (minutes) the cache reaper plugin runs to enforce the size cap.
    get MUSIC_TRANSCODE_REAPER_INTERVAL_M(): number {
        return getNumber(
            'MUSIC_TRANSCODE_REAPER_INTERVAL_M',
            env.MUSIC_TRANSCODE_REAPER_INTERVAL_M,
            30,
        );
    },
    // How long (hours) a signed transcode token remains valid before expiry.
    get MUSIC_TRANSCODE_TOKEN_TTL_HOURS(): number {
        return getNumber('MUSIC_TRANSCODE_TOKEN_TTL_HOURS', env.MUSIC_TRANSCODE_TOKEN_TTL_HOURS, 6);
    },
    // Default output codec when the client does not specify one.
    // Supported values: 'mp3', 'aac', 'opus'.
    get MUSIC_TRANSCODE_DEFAULT_CODEC(): string {
        return getString('MUSIC_TRANSCODE_DEFAULT_CODEC', env.MUSIC_TRANSCODE_DEFAULT_CODEC, 'mp3');
    },
    // Default output bitrate (kbps) when the client does not specify one.
    get MUSIC_TRANSCODE_DEFAULT_BITRATE(): number {
        return getNumber(
            'MUSIC_TRANSCODE_DEFAULT_BITRATE',
            env.MUSIC_TRANSCODE_DEFAULT_BITRATE,
            192,
        );
    },
    // Maximum number of concurrent ffmpeg transcode jobs across this instance.
    //
    // Derived from the CPU budget like LUMASTRA_MAX_CONCURRENT_TRANSCODES, rather
    // than a flat number: an opus/mp3 audio encode costs roughly an order of
    // magnitude less than a video transcode, so a fixed default that is safe on a
    // 2-core NAS (the old 4) throttles a 16-core host for no reason — Subsonic
    // clients bulk-download whole albums for offline use and hit it constantly.
    // Clamped to 16 so a 48-core box doesn't spawn an absurd ffmpeg fleet, and
    // floored at 4 so small hosts still handle one client's parallel download.
    get MUSIC_TRANSCODE_MAX_CONCURRENT(): number {
        return getNumber(
            'MUSIC_TRANSCODE_MAX_CONCURRENT',
            env.MUSIC_TRANSCODE_MAX_CONCURRENT,
            musicTranscodeConcurrencyDefault(getCpuBudgetCores()),
        );
    },
    // Maximum number of concurrent music transcode streams a single user may
    // hold at once (per pod). Keeps one client from consuming the entire
    // MUSIC_TRANSCODE_MAX_CONCURRENT budget and starving every other user.
    //
    // Defaults to half the server-wide cap (min 4): one client may use up to
    // half the budget, leaving the rest for everyone else. The old flat 2 was
    // the binding constraint for a single user doing an offline sync — the
    // server-wide cap never even came into play.
    get MUSIC_TRANSCODE_MAX_PER_USER(): number {
        return getNumber(
            'MUSIC_TRANSCODE_MAX_PER_USER',
            env.MUSIC_TRANSCODE_MAX_PER_USER,
            musicTranscodePerUserDefault(getCpuBudgetCores()),
        );
    },
    // How long a request waits for a free transcode slot before giving up with
    // a 503. Without a wait, any cap — however high — rejects outright as soon
    // as a client opens more parallel downloads than there are slots, which is
    // exactly what bulk offline sync does. Waiting turns the cap into a
    // throughput limit (downloads slow down) instead of an error, without
    // raising the ceiling on concurrent ffmpeg processes. 0 restores the old
    // reject-immediately behaviour.
    get MUSIC_TRANSCODE_QUEUE_WAIT_MS(): number {
        return getNumber('MUSIC_TRANSCODE_QUEUE_WAIT_MS', env.MUSIC_TRANSCODE_QUEUE_WAIT_MS, 10000);
    },
    // Seconds to wait for the first bytes of a partial transcode before aborting.
    get MUSIC_TRANSCODE_PARTIAL_TIMEOUT_S(): number {
        return getNumber(
            'MUSIC_TRANSCODE_PARTIAL_TIMEOUT_S',
            env.MUSIC_TRANSCODE_PARTIAL_TIMEOUT_S,
            30,
        );
    },

    // Playlist chat poll interval (ms)
    get PLAYLIST_CHAT_POLL_MS(): number {
        return getNumber('PLAYLIST_CHAT_POLL_MS', env.PLAYLIST_CHAT_POLL_MS, 15000);
    },

    // =========================================================================
    // Worker Mode Configuration
    // =========================================================================

    // Per-process launch identity, never read from shared settings.json.
    // Web is the default even in development; consumers use the worker entrypoint.
    get WORKER_MODE(): WorkerMode {
        return parseWorkerMode(env.WORKER_MODE);
    },

    get DEDICATED_WORKER(): boolean {
        return parseBoolEnv(env.DEDICATED_WORKER);
    },

    // =========================================================================
    // Cluster Identity
    // =========================================================================

    // Unique identifier for this replica instance.
    // Defaults to os.hostname() + random 6-char suffix so co-located replicas are distinguishable.
    //
    // The value is embedded in Valkey keys (`lumastra:cluster:node:${id}`) and
    // admin UI labels, so it must be safe to round-trip through Valkey and
    // front-end HTML. See `resolveInstanceId` for the validation rule and
    // fallback behaviour.
    INSTANCE_ID: resolveInstanceId(env.INSTANCE_ID),

    // =========================================================================
    // Background Task Killswitches
    // =========================================================================
    // When true, the corresponding background task returns immediately without
    // doing any work (both scheduled and manually-triggered runs).
    // All DISABLE_* flags default to false (task enabled). Set to 'true' to
    // disable. PLUGIN_*_ENABLED flags default to false (opt-in).
    //
    // NOTE: These getters read process.env directly at call time (bypassing
    // the frozen env snapshot and ConfigService). This preserves two things:
    //   1. Test code can toggle flags via process.env mutations mid-test.
    //   2. Admin UI JSON config works: ConfigService calls mirrorToProcessEnv()
    //      at init, writing schema/JSON values back into process.env so these
    //      getters pick them up on the next read.
    // requiresRestart: true in schema means no live-reload is expected anyway.

    // Disables the database-cleanup task (orphan pruning, artist deduplication).
    get DISABLE_DATABASE_CLEANUP(): boolean {
        return parseBoolEnv(process.env.DISABLE_DATABASE_CLEANUP);
    },

    // Disables the dummy-integration plugin (reference integration for testing).
    get DISABLE_DUMMY_INTEGRATION(): boolean {
        return parseBoolEnv(process.env.DISABLE_DUMMY_INTEGRATION);
    },

    // Disables the file-library-scan task (scans local library paths for new/changed files).
    get DISABLE_FILE_LIBRARY_SCAN(): boolean {
        return parseBoolEnv(process.env.DISABLE_FILE_LIBRARY_SCAN);
    },

    // Disables the fribb-anime-sync task (enriches anime items with Fribb IDs).
    get DISABLE_FRIBB_ANIME_SYNC(): boolean {
        return parseBoolEnv(process.env.DISABLE_FRIBB_ANIME_SYNC);
    },

    // Disables holiday (seasonal) recommendations. Default TRUE (off) since
    // v0.1: the rails were buggy and not good enough to ship on by default.
    // An explicit `false` in ENV or settings.json turns them back on. Read
    // everywhere through `features.holidays`, never directly.
    get DISABLE_HOLIDAY_RECOMMENDATIONS(): boolean {
        return getBool(
            'DISABLE_HOLIDAY_RECOMMENDATIONS',
            env.DISABLE_HOLIDAY_RECOMMENDATIONS,
            true,
        );
    },

    // Disables the integrity-scanner task (detects stage_state drift and missing files).
    get DISABLE_INTEGRITY_SCANNER(): boolean {
        return parseBoolEnv(process.env.DISABLE_INTEGRITY_SCANNER);
    },

    // Disables the jellyfin-disk-trickplay provider (reads trickplay from Jellyfin's on-disk format).
    get DISABLE_JELLYFIN_DISK_TRICKPLAY(): boolean {
        return parseBoolEnv(process.env.DISABLE_JELLYFIN_DISK_TRICKPLAY);
    },

    // Disables the local-trickplay provider (reads locally-generated sprite sheets).
    get DISABLE_LOCAL_TRICKPLAY(): boolean {
        return parseBoolEnv(process.env.DISABLE_LOCAL_TRICKPLAY);
    },

    // Disables the mal-anime-enrichment task (enriches anime items with MyAnimeList IDs).
    get DISABLE_MAL_ANIME_ENRICHMENT(): boolean {
        return parseBoolEnv(process.env.DISABLE_MAL_ANIME_ENRICHMENT);
    },

    // Disables the media-probe task (probes media files for codec/stream metadata).
    get DISABLE_MEDIA_PROBE(): boolean {
        return parseBoolEnv(process.env.DISABLE_MEDIA_PROBE);
    },

    // Disables the music-analysis task (chromaprint fingerprinting and audio feature extraction).
    get DISABLE_MUSIC_ANALYSIS(): boolean {
        return parseBoolEnv(process.env.DISABLE_MUSIC_ANALYSIS);
    },

    // Disables the keyless music artwork lookups (artist-enrichment and album-enrichment:
    // TheAudioDB, Deezer, Cover Art Archive). Their schedule pause alone doesn't stop
    // them, because a music scan enqueues both directly.
    get DISABLE_MUSIC_ARTWORK_ENRICHMENT(): boolean {
        return parseBoolEnv(process.env.DISABLE_MUSIC_ARTWORK_ENRICHMENT);
    },

    // Disables the oauth-cleanup task (purges expired OAuth tokens and device codes).
    get DISABLE_OAUTH_CLEANUP(): boolean {
        return parseBoolEnv(process.env.DISABLE_OAUTH_CLEANUP);
    },

    // Disables the telemetry-cleanup task (purges old task telemetry rows).
    get DISABLE_TELEMETRY_CLEANUP(): boolean {
        return parseBoolEnv(process.env.DISABLE_TELEMETRY_CLEANUP);
    },

    // Disables the trickplay-params-sync task (syncs trickplay parameters to media_item_stage_state).
    get DISABLE_TRICKPLAY_PARAMS(): boolean {
        return parseBoolEnv(process.env.DISABLE_TRICKPLAY_PARAMS);
    },

    // Disables the curated-lists-sync task (syncs MDBList curated content lists).
    get DISABLE_CURATED_LISTS_SYNC(): boolean {
        return parseBoolEnv(process.env.DISABLE_CURATED_LISTS_SYNC);
    },

    // Enables the dummy feature plugin (reference plugin; default: enabled in dev, disabled in prod).
    get PLUGIN_DUMMY_ENABLED(): boolean {
        const v = process.env.PLUGIN_DUMMY_ENABLED;
        if (v === undefined) return process.env.NODE_ENV === 'development';
        return parseBoolEnv(v);
    },

    // Enables the dummy-integration plugin (reference integration; default: enabled in dev, disabled in prod).
    get PLUGIN_DUMMY_INTEGRATION_ENABLED(): boolean {
        const v = process.env.PLUGIN_DUMMY_INTEGRATION_ENABLED;
        if (v === undefined) return process.env.NODE_ENV === 'development';
        return parseBoolEnv(v);
    },

    // Enables the lumastra-intro-analyzer plugin (detects intro/credit segments via chromaprint).
    // Default: enabled. Set to 'false' (or '0'/'no'/'off') to disable.
    get PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED(): boolean {
        return envNotDisabled(process.env.PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED);
    },

    // Master switch for worker-thread plugin isolation (see the
    // `FEATURE_PLUGIN_WORKER_ISOLATION` export below for the full rationale).
    // Default ON: tasks declaring `isolation: 'worker'` run execute() in a
    // node:worker_threads Worker the main-thread watchdog can terminate() even
    // through a synchronous busy-loop. Mirrors the operator const so callers
    // reading `config.*` see the same value.
    get FEATURE_PLUGIN_WORKER_ISOLATION(): boolean {
        return getBool(
            'FEATURE_PLUGIN_WORKER_ISOLATION',
            env.FEATURE_PLUGIN_WORKER_ISOLATION,
            true,
        );
    },
} as const;

// =========================================================================
// Startup Validation — warn about misconfigured LiveTV settings
// =========================================================================

/**
 * Validates LiveTV configuration and logs warnings for misconfigurations.
 * Called automatically at module load; exported for testing.
 */
export function validateLiveTvConfig(
    featureEnabled: boolean,
    liveTvSource: string,
    proxyUrl: string,
    proxySecret: string,
    warn: (msg: string) => void,
): void {
    // Only warn about missing proxy config when Live TV is actually on. Since
    // LIVETV_SOURCE defaults to 'standalone', skipping this guard would spam the
    // warnings on every install that has the feature switched off.
    if (!featureEnabled || liveTvSource !== 'standalone') return;

    if (!proxyUrl) {
        warn(
            'LIVETV_SOURCE is "standalone" but STREAM_PROXY_URL is not set — LiveTV will not work',
        );
    }
    if (!proxySecret) {
        warn('STREAM_PROXY_SECRET is empty — proxy requests will be unauthenticated');
    }
}

// Run validation at startup
{
    const { Logger } = await import('./utils/logger.js');
    const startupLogger = Logger.for('Config');
    validateLiveTvConfig(
        config.FEATURE_LIVETV,
        config.LIVETV_SOURCE,
        config.STREAM_PROXY_URL,
        config.STREAM_PROXY_SECRET,
        (msg) => startupLogger.warn(msg),
    );

    // Reject obsolete auto/combined launch settings before any background startup.
    shouldStartWorkers();

    // Validate JWT_SECRET — required for Lumastra HLS stream tokens and device auth
    if (!config.JWT_SECRET) {
        if (config.FFMPEG_PATH) {
            startupLogger.warn(
                'JWT_SECRET is not set but FFmpeg HLS transcoding is configured — play session creation will fail. Generate one with: openssl rand -hex 32',
            );
        }
        if (config.FEATURE_DEVICE_AUTH) {
            startupLogger.warn(
                'JWT_SECRET is not set but FEATURE_DEVICE_AUTH is enabled — token authentication will fail. Generate one with: openssl rand -hex 32',
            );
        }
    } else {
        // Enforce minimum length and entropy: must be at least 32 characters and
        // must not be a trivially-guessable constant value. A properly-generated
        // secret (`openssl rand -hex 32`) produces 64 hex characters with high
        // entropy; anything shorter or suspiciously uniform is unsafe.
        const jwtSecret = config.JWT_SECRET;
        if (jwtSecret.length < 32) {
            startupLogger.warn(
                `JWT_SECRET is too short (${jwtSecret.length} chars) — minimum 32 characters required. Generate a secure value with: openssl rand -hex 32`,
            );
        } else {
            // Estimate entropy by counting unique characters. A uniform string
            // (e.g. all the same character) has near-zero entropy.
            const uniqueChars = new Set(jwtSecret).size;
            if (uniqueChars < 8) {
                startupLogger.warn(
                    'JWT_SECRET appears to have very low entropy (fewer than 8 unique characters) — generate a secure value with: openssl rand -hex 32',
                );
            }
        }
    }

    // Warn when LUMASTRA_TRUST_ANY_PROXY=true AND native login is enabled AND no
    // TRUSTED_PROXY_IPS allowlist is set. In this combination a forged
    // x-forwarded-for / admin header from any TCP peer is accepted, which can also
    // affect session binding and rate-limit keys that rely on the client IP. The
    // real risk is identity-header forgery (USERHEADER / GROUPHEADER), but the
    // x-forwarded-for trust amplifies the attack surface for IP-bound checks.
    // Capability-ADD via a forged group header is the primary concern; this warning
    // prompts operators to pin TRUSTED_PROXY_IPS explicitly.
    // Note: LUMASTRA_TRUST_ANY_PROXY without native login is the standard
    // forward-auth-only setup for single-host deploys and is already flagged by
    // warnIfProxyTrustImplicit() in client-ip.ts on first request; the additional
    // risk of native-login + trust-any is the target of this startup check.
    const trustAnyProxy =
        (process.env.LUMASTRA_TRUST_ANY_PROXY ?? '').trim().toLowerCase() === 'true';
    const hasTrustedProxyIps = (process.env.TRUSTED_PROXY_IPS ?? '').trim().length > 0;
    // Only while forward auth is on: off, identity headers are ignored from every peer.
    if (
        trustAnyProxy &&
        !hasTrustedProxyIps &&
        config.AUTH_NATIVE_LOGIN_ENABLED &&
        config.FORWARD_AUTH_ENABLED
    ) {
        startupLogger.warn(
            'Security: LUMASTRA_TRUST_ANY_PROXY=true AND AUTH_NATIVE_LOGIN_ENABLED=true ' +
                'with no TRUSTED_PROXY_IPS set. Identity headers (USERHEADER/GROUPHEADER) ' +
                'are trusted from ANY TCP peer — a forged header can elevate privileges. ' +
                'Pin your reverse-proxy IP(s) via TRUSTED_PROXY_IPS to restrict trust to ' +
                'known proxies. List each proxy address, never a whole LAN. Example: TRUSTED_PROXY_IPS=172.28.0.10',
        );
    }
}

// =========================================================================
// Feature availability helpers (check both flag AND required config)
// =========================================================================

/**
 * True when an embedding provider is actually usable: a first-party key, or a
 * custom OpenAI-compatible endpoint WITH its own key (a base URL alone cannot
 * embed — custom endpoints never fall back to OPENAI_API_KEY).
 *
 * Shared by `features.aiRecommendations` and the `embeddings` entry in
 * OPTIONAL_INTEGRATIONS so the feature gate and the admin nudge can never
 * disagree about whether embeddings are configured.
 */
export function hasEmbeddingProvider(): boolean {
    // `.trim()` each arm to match resolveEffectiveEmbedding()'s `trimmed(...)`
    // check exactly (src/lib/server/ai/embedding-models.ts) — a whitespace-only
    // key (e.g. VOYAGE_API_KEY="pa-xxx " from a compose stack.env) must not be
    // "configured" here while the doctor/embedding resolver treat it as unset.
    return (
        config.OPENAI_API_KEY.trim().length > 0 ||
        config.VOYAGE_API_KEY.trim().length > 0 ||
        (config.EMBEDDING_BASE_URL.trim().length > 0 && config.EMBEDDING_API_KEY.trim().length > 0)
    );
}

export const features = {
    /** AI recommendations available (flag enabled + embedding provider configured) */
    get aiRecommendations(): boolean {
        return config.FEATURE_AI_RECOMMENDATIONS && hasEmbeddingProvider();
    },

    /** AI Assistant available */
    get aiAssistant(): boolean {
        return (
            config.FEATURE_AI_ASSISTANT &&
            (config.OPENAI_CHAT_API_KEY.length > 0 || config.ANTHROPIC_API_KEY.length > 0)
        );
    },

    /** Live TV available */
    get liveTV(): boolean {
        return config.FEATURE_LIVETV && config.LIVETV_SOURCE === 'standalone';
    },

    /** Audiobooks available */
    get audiobooks(): boolean {
        return config.FEATURE_AUDIOBOOKS && !!config.AUDIOURL && !!config.AUDIOAPIKEY;
    },

    /** Kavita books/manga available */
    get kavita(): boolean {
        return config.FEATURE_KAVITA && !!config.KAVITAURL && !!config.KAVITAAPIKEY;
    },

    /** Calendar available */
    get calendar(): boolean {
        return config.FEATURE_CALENDAR && !!(config.SONARRURL || config.RADARRURL);
    },

    /** Sessions monitoring available */
    get sessions(): boolean {
        return config.FEATURE_SESSIONS;
    },

    /** Internal player — always enabled (the only player) */
    get internalPlayer(): boolean {
        return true;
    },

    /** Watch together available */
    get watchTogether(): boolean {
        return config.FEATURE_WATCH_TOGETHER;
    },

    /** Sidebar available */
    get sidebar(): boolean {
        return config.FEATURE_SIDEBAR;
    },

    /** Social features (show who watched/rated) */
    get social(): boolean {
        return config.FEATURE_SOCIAL;
    },

    /** Community reviews in the Friends' Watch Activity section (requires social) */
    get socialReviews(): boolean {
        return config.FEATURE_SOCIAL && config.FEATURE_SOCIAL_REVIEWS;
    },

    /**
     * Comments and reactions on media, playlists and people.
     *
     * Intentionally NOT `FEATURE_SOCIAL && FEATURE_COMMENTS`, unlike
     * `socialReviews` above. `FEATURE_SOCIAL` governs seeing who watched or
     * rated something — an activity-disclosure question. Comments are content a
     * user authored and addressed to a resource; an operator who turns off
     * activity disclosure has not thereby asked for comments to vanish, and
     * chaining them would make the off-switch mean two different things.
     */
    get comments(): boolean {
        return config.FEATURE_COMMENTS;
    },

    /** Personal statistics page */
    get personalStats(): boolean {
        return config.FEATURE_PERSONAL_STATS;
    },

    /** Allow users to upload a custom avatar */
    get avatarUpload(): boolean {
        return config.FEATURE_AVATAR_UPLOAD;
    },

    /** Gravatar fallback for user avatars */
    get gravatar(): boolean {
        return config.FEATURE_GRAVATAR;
    },

    /** Auto-fetch lyrics from LRCLIB on demand */
    get autoLyrics(): boolean {
        return config.FEATURE_AUTO_LYRICS;
    },

    /** Automatic client diagnostics (crash/hang/js_error/api_failures). */
    get clientDiagnostics(): boolean {
        return config.FEATURE_CLIENT_DIAGNOSTICS;
    },
    /** Log bundle uploads (user sends + admin requests). */
    get clientLogBundles(): boolean {
        return config.FEATURE_CLIENT_LOG_BUNDLES;
    },
    /** Log tails on automatic reports. */
    get clientDiagnosticsLogTail(): boolean {
        return config.FEATURE_CLIENT_DIAGNOSTICS_LOG_TAIL;
    },

    /** Save LRCLib-fetched lyrics as .lrc files next to the audio file */
    get saveLyricsToDisk(): boolean {
        return config.FEATURE_SAVE_LYRICS_TO_DISK;
    },

    /**
     * Bulk background lyrics fetch via LRCLIB.
     * True only when FEATURE_MUSIC_LYRICS_FETCH is on.
     * Note: resolveLyrics() also requires features.autoLyrics (FEATURE_AUTO_LYRICS)
     * to actually call LRCLIB — without it the bulk task is a no-op even when this
     * flag is true.
     */
    get musicLyricsFetch(): boolean {
        return config.FEATURE_MUSIC_LYRICS_FETCH;
    },

    /** Sessions public (non-admins can see streaming sessions) */
    get sessionsPublic(): boolean {
        return config.FEATURE_SESSIONS_PUBLIC && config.FEATURE_SESSIONS;
    },

    /** Show "Not yet aired" episodes in the series modal */
    get showUnairedEpisodes(): boolean {
        return config.FEATURE_SHOW_UNAIRED_EPISODES;
    },

    /** Show aired-but-not-on-disk episodes in the series modal */
    get showMissingEpisodes(): boolean {
        return config.FEATURE_SHOW_MISSING_EPISODES;
    },

    /** Sessions device info public (non-admins can see device info in sessions) */
    get sessionsDeviceInfoPublic(): boolean {
        return config.FEATURE_SESSIONS_DEVICE_INFO_PUBLIC;
    },

    /** YouTube trailers in modals */
    get youtubeModals(): boolean {
        return config.FEATURE_YOUTUBE_MODALS;
    },

    /** YouTube trailers in hero slider */
    get youtubeHero(): boolean {
        return config.FEATURE_YOUTUBE_HERO;
    },

    /** Per-user outbound notification webhook (ntfy/Gotify/Discord), admin-gated off by default */
    get userNotificationWebhooks(): boolean {
        return config.FEATURE_USER_NOTIFICATION_WEBHOOKS;
    },

    /** Quick Connect for Jellyfin device linking */
    get quickConnect(): boolean {
        return config.FEATURE_QUICK_CONNECT && !!config.JELLYFINURL && !!config.JELLYFINAPIKEY;
    },

    /** Player auto quality mode (adaptive bitrate) */
    get playerAutoQuality(): boolean {
        return config.FEATURE_PLAYER_AUTO_QUALITY;
    },

    /** Dock toggle available in user menu */
    get dockToggle(): boolean {
        return config.FEATURE_DOCK_TOGGLE && config.FEATURE_SIDEBAR;
    },

    /** Jellyseerr requests available (requires Jellyseerr configured) */
    get requests(): boolean {
        return config.FEATURE_REQUEST_MODAL && !!config.SEERRURL && !!config.SEERRAPIKEY;
    },

    /**
     * Any request path is configured: the internal Jellyseerr request modal
     * (features.requests) OR the external PUBLIC_REQUESTURL redirect. This is
     * the server-side twin of the client gate in UniversalMediaCard /
     * MediaHoverCard / MediaActionButtons (`features.requests === true ||
     * env.PUBLIC_REQUESTURL`). When false, unavailable catalog titles are
     * pure dead ends — nothing to play, nothing to request — so the
     * unavailable-media display gates and the TMDB discovery sweeps key off
     * this (see isUnavailableMediaVisible / isDiscoveryCatalogEnabled).
     * PUBLIC_REQUESTURL is envOnly (schema), so the boot-time env snapshot
     * is authoritative.
     */
    get requestsConfigured(): boolean {
        return features.requests || !!env.PUBLIC_REQUESTURL;
    },

    /** Playlists feature available */
    get playlists(): boolean {
        return config.FEATURE_PLAYLISTS;
    },

    /** Media hover popup on poster cards */
    get mediaHoverPopup(): boolean {
        return config.FEATURE_MEDIA_HOVER_POPUP;
    },

    /** Media hover popup trailers (requires mediaHoverPopup enabled) */
    get mediaHoverPopupTrailers(): boolean {
        return config.FEATURE_MEDIA_HOVER_POPUP && config.FEATURE_MEDIA_HOVER_POPUP_TRAILERS;
    },

    /** Media hover popup video preview (requires mediaHoverPopup enabled) */
    get mediaHoverVideoPreview(): boolean {
        return config.FEATURE_MEDIA_HOVER_POPUP && config.FEATURE_MEDIA_HOVER_VIDEO_PREVIEW;
    },

    /**
     * Whether the /preview-session transcode endpoint is enabled. Mirrors the
     * endpoint's OWN authorization (`FEATURE_MEDIA_HOVER_VIDEO_PREVIEW` alone —
     * it does NOT require the hover-popup UI flag). Surfaces that call
     * preview-session OUTSIDE the hover popup (e.g. the hero video player) must
     * gate on THIS, not `mediaHoverVideoPreview` (which also requires
     * `mediaHoverPopup`) — otherwise a config with video-preview on but
     * hover-popup off would suppress a request the server would happily serve.
     */
    get videoPreviewSessionEnabled(): boolean {
        return config.FEATURE_MEDIA_HOVER_VIDEO_PREVIEW;
    },

    /** Media hover popup live TV preview (requires mediaHoverVideoPreview enabled) */
    get mediaHoverLiveTvPreview(): boolean {
        return (
            config.FEATURE_MEDIA_HOVER_POPUP &&
            config.FEATURE_MEDIA_HOVER_VIDEO_PREVIEW &&
            config.FEATURE_MEDIA_HOVER_VIDEO_PREVIEW_LIVETV
        );
    },

    /** Featured Pick video - trailers/video previews in the hero section */
    get featuredPickVideo(): boolean {
        return config.FEATURE_FEATURED_PICK_VIDEO;
    },

    /** Playlist chat available (requires playlists enabled) */
    get playlistChat(): boolean {
        return config.FEATURE_PLAYLISTS && config.FEATURE_PLAYLIST_CHAT;
    },

    /** Timestamp pins and seekbar markers on media items */
    get mediaAnnotations(): boolean {
        return config.FEATURE_MEDIA_ANNOTATIONS;
    },

    /** Freeform chat sidebar on media items (requires mediaAnnotations) */
    get mediaChat(): boolean {
        return config.FEATURE_MEDIA_ANNOTATIONS && config.FEATURE_MEDIA_CHAT;
    },

    /** Animated stars background on homepage */
    get starsBackground(): boolean {
        return config.FEATURE_STARS_BACKGROUND;
    },

    /** Trending widget (MDBList content) */
    get trending(): boolean {
        return config.FEATURE_TRENDING;
    },

    /**
     * Holiday (seasonal) recommendations: the home widget, the
     * /api/recommendations/holiday endpoint, the editorial rail and the plugin
     * routes. Off unless DISABLE_HOLIDAY_RECOMMENDATIONS is explicitly false.
     */
    get holidays(): boolean {
        return !config.DISABLE_HOLIDAY_RECOMMENDATIONS;
    },

    /** Device auth for TV apps/external clients (OAuth 2.0 Device Authorization Grant) */
    get deviceAuth(): boolean {
        return config.FEATURE_DEVICE_AUTH && !!config.JWT_SECRET;
    },

    /** Allow users to create their own PATs (requires JWT_SECRET for token hashing) */
    get userPats(): boolean {
        return config.FEATURE_USER_PATS && !!config.JWT_SECRET;
    },

    /** FFmpeg available for HLS transcoding, remux, and multi-audio demux */
    get ffmpegAvailable(): boolean {
        return !!config.FFMPEG_PATH;
    },

    /** Jellyfin server configured and available */
    get jellyfin(): boolean {
        return !!config.JELLYFINURL && !!config.JELLYFINAPIKEY;
    },

    /** Background Jellyfin sync (watch state, library, sessions) */
    get jellyfinSync(): boolean {
        return config.FEATURE_JELLYFIN_SYNC && !!config.JELLYFINURL && !!config.JELLYFINAPIKEY;
    },

    /**
     * Jellyfin compatibility layer (/j/ routes for native Jellyfin clients).
     *
     * Deliberately does NOT require JELLYFINURL/JELLYFINAPIKEY: /j serves
     * Lumastra's OWN catalog and never calls out to a Jellyfin server, and
     * `routes/(proprietary)/j/` gates reachability on the raw flag alone. The
     * user-facing pieces that hang off this predicate — Settings → Connections,
     * the /j password issue/reveal/reset APIs, the per-user /j session list and
     * the compat Quick Connect authorise endpoint — are all Valkey/Postgres
     * native, so demanding Jellyfin credentials here used to leave /j serving
     * requests that no user could obtain a password for.
     *
     * Contrast `quickConnect` below, which DOES drive a real Jellyfin server.
     */
    get jellyfinCompat(): boolean {
        return config.FEATURE_JELLYFIN_COMPAT;
    },

    /** OpenSubsonic compatibility layer (/subsonic/rest/ routes for music apps) */
    get subsonicCompat(): boolean {
        return config.FEATURE_SUBSONIC_COMPAT;
    },

    /** Whether unrated content is visible to age-restricted users */
    get unratedContentVisible(): boolean {
        return config.UNRATED_CONTENT_VISIBLE;
    },

    /** Music Quick Picks taste-clustering (k-means over top-played embeddings) */
    get musicClustering(): boolean {
        return config.FEATURE_MUSIC_CLUSTERING;
    },

    /** Music transcoding (server-side FFmpeg re-encoding for incompatible formats) */
    get musicTranscode(): boolean {
        return config.FEATURE_MUSIC_TRANSCODE;
    },

    /** For-You abandonment soft-demote (down-rank abandoned recommendations) */
    get forYouAbandonmentDemote(): boolean {
        return config.FEATURE_FORYOU_ABANDONMENT_DEMOTE;
    },

    /** For-You section engagement ranker (M3) — reorders long-tail carousel sections by engagement */
    get forYouSectionRanker(): boolean {
        return config.FEATURE_FORYOU_SECTION_RANKER;
    },

    /**
     * Music Alchemy brew surface available.
     * True only when the flag is on AND the music clustering infrastructure is
     * also enabled (reuses the same bpm/energy/mood_tags path). The UI route,
     * nav entry, and brew API endpoint all gate on this getter — never on the
     * raw FEATURE_MUSIC_ALCHEMY flag directly.
     */
    get musicAlchemy(): boolean {
        return config.FEATURE_MUSIC_ALCHEMY && config.FEATURE_MUSIC_CLUSTERING;
    },

    /**
     * Music-First mode — '/' redirects to '/music' and the sidebar is
     * reordered. True only when FEATURE_MUSIC_FIRST is on.
     * Orthogonal to musicAlchemy; they compose independently.
     */
    get musicFirst(): boolean {
        return config.FEATURE_MUSIC_FIRST;
    },

    /**
     * Sonic embeddings (MSCLAP audio-level similarity).
     * True only when FEATURE_MUSIC_SONIC is on AND aiRecommendations
     * infrastructure is active (requires the embedding model environment).
     * The backfill task, kNN query, and /api/music/tracks/{id}/similar sonic basis
     * all gate on this getter — never on the raw flag directly.
     */
    get sonicEmbeddings(): boolean {
        return config.FEATURE_MUSIC_SONIC && config.FEATURE_AI_RECOMMENDATIONS;
    },

    /**
     * Music Map — 2D interactive audio-embedding starfield at /music/map.
     * True only when FEATURE_MUSIC_MAP is on AND sonic embeddings are active
     * (the map is built from media_audio_embeddings; without them there's
     * nothing to project). Nav entry, API route, and UI all gate on this getter.
     */
    get musicMap(): boolean {
        return config.FEATURE_MUSIC_MAP && features.sonicEmbeddings;
    },

    /**
     * Lyrics Search — semantic kNN search over .lrc sidecar lyrics.
     * True only when FEATURE_MUSIC_LYRICS_SEARCH is on AND aiRecommendations
     * is active (requires a configured text-embedding provider). The ingestion
     * task, kNN query, API route, and UI all gate on this getter.
     */
    get lyricsSearch(): boolean {
        return config.FEATURE_MUSIC_LYRICS_SEARCH && features.aiRecommendations;
    },

    /**
     * Sonic Clustering — KMeans auto-playlists over the MSCLAP audio-embedding
     * space. True only when FEATURE_MUSIC_CLUSTERS is on AND sonicEmbeddings
     * are active (media_audio_embeddings must exist to cluster over). The
     * 'sonic-clustering' task, GET /api/music/sonic-mixes, and /music/collections
     * UI all gate on this getter.
     */
    get musicClusters(): boolean {
        return config.FEATURE_MUSIC_CLUSTERS && features.sonicEmbeddings;
    },

    /**
     * Text-to-Sound Search — MSCLAP joint text+audio embedding space kNN.
     * True only when FEATURE_MUSIC_TEXT_SOUND is on AND sonicEmbeddings are
     * active (the text vector and audio vectors must share the same 1024-dim
     * CLAP space). The embed_text.py spawn, GET /api/music/text-search, and
     * /music/text-search UI all gate on this getter.
     */
    get textToSound(): boolean {
        return config.FEATURE_MUSIC_TEXT_SOUND && features.sonicEmbeddings;
    },

    /**
     * Sonic Taste Profile — on-demand Rocchio personalisation in the MSCLAP
     * 1024-dim vector space.
     *
     * True only when FEATURE_MUSIC_SONIC_TASTE is on AND sonicEmbeddings are
     * active (media_audio_embeddings must exist — the same table used for
     * sonic-similar and sonic-fingerprint). The Quick Picks 'sonic-taste'
     * bucket, the computeSonicTasteVector query, and getSonicTastePicks all
     * gate on this getter — never on the raw flag directly.
     *
     * Composition: FEATURE_MUSIC_SONIC_TASTE && sonicEmbeddings
     *            = FEATURE_MUSIC_SONIC_TASTE && FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS
     */
    get sonicTaste(): boolean {
        return config.FEATURE_MUSIC_SONIC_TASTE && features.sonicEmbeddings;
    },

    /**
     * Sonic Smart Queue — blended MSCLAP + taste + mood next-track picker.
     *
     * True only when FEATURE_MUSIC_SONIC_QUEUE is on AND sonicEmbeddings are
     * active (media_audio_embeddings must exist — queue centroid is computed
     * from MSCLAP embeddings of current + recent queue tracks).
     *
     * When false the queue endpoint falls back to the existing metadata-embedding
     * logic unchanged (no regression).
     *
     * Composition: FEATURE_MUSIC_SONIC_QUEUE && sonicEmbeddings
     *            = FEATURE_MUSIC_SONIC_QUEUE && FEATURE_MUSIC_SONIC && FEATURE_AI_RECOMMENDATIONS
     */
    get sonicQueue(): boolean {
        return config.FEATURE_MUSIC_SONIC_QUEUE && features.sonicEmbeddings;
    },

    /**
     * Enterprise training assignment + completion-tracking layer.
     * True only when FEATURE_TRAINING_ASSIGNMENTS=true. Default OFF.
     * Gates /my/trainings, /admin/trainings, and the Sidebar nav entries.
     */
    get trainingAssignments(): boolean {
        return config.FEATURE_TRAINING_ASSIGNMENTS;
    },

    /**
     * Enterprise assessment — native quiz + certificate layer (Phase A).
     * True only when FEATURE_ASSESSMENT=true. Default OFF.
     * Gates /learn, /admin/courses, /certificates, and the Sidebar "Learn" entry.
     */
    get assessment(): boolean {
        return config.FEATURE_ASSESSMENT;
    },
} as const;

/**
 * Exclusion set for features that should NOT be sent to the frontend.
 * Add feature getter names here to keep them server-only.
 * Currently empty because all 35 features are already frontend-exposed.
 */
export const BACKEND_ONLY_FEATURES: Set<string> = new Set([]);

/**
 * Effective "show unavailable titles on Trending / For You" gate.
 *
 * The raw SHOW_UNAVAILABLE_MEDIA toggle only takes effect when a request
 * path is configured (features.requestsConfigured): a file-less catalog
 * ghost the user can neither play nor request is a dead end, so an ON
 * toggle without any request integration is always a misconfiguration and
 * resolves to hidden. All discovery display surfaces (SearchAccessContext,
 * recommender context) must use THIS, not the raw config flag. Exception:
 * the release-calendar monitored gap-fill reads the raw flag — arr-monitored
 * titles arrive in the library regardless of request config.
 */
export function isUnavailableMediaVisible(): boolean {
    return config.SHOW_UNAVAILABLE_MEDIA && features.requestsConfigured;
}

/**
 * Effective "show unavailable titles inline in search results" gate.
 * Same requests-configured coupling as isUnavailableMediaVisible().
 */
export function isUnavailableMediaVisibleInSearch(): boolean {
    return config.SHOW_UNAVAILABLE_MEDIA_IN_SEARCH && features.requestsConfigured;
}

/**
 * Whether the TMDB discovery sweeps (tmdb-metadata-sync / metadata-sync
 * phase 1) should persist file-less catalog rows at all. If no display
 * surface can ever show them (neither discovery surfaces nor inline
 * search), creating thousands of has_files=false media_items rows only
 * burns TMDB quota and bloats the database — skip the sweep. Re-checked
 * live on every scheduled run, so flipping a toggle (or configuring
 * Jellyseerr) makes the next run proceed normally; existing ghost rows
 * are kept (they become visible again the moment the gates re-open).
 */
export function isDiscoveryCatalogEnabled(): boolean {
    return isUnavailableMediaVisible() || isUnavailableMediaVisibleInSearch();
}

/**
 * Check if a user (by their groups) can create public playlists
 * Returns true if PLAYLIST_PUBLIC_GROUPS is empty (all users allowed)
 * or if user is in one of the allowed groups (case-insensitive)
 */
export function canCreatePublicPlaylist(userGroups: string[]): boolean {
    if (!config.PLAYLIST_PUBLIC_GROUPS) {
        return true; // No restriction
    }
    const allowedGroups = parseList(config.PLAYLIST_PUBLIC_GROUPS).map((g) => g.toLowerCase());
    if (allowedGroups.length === 0) {
        return true; // Empty after parsing
    }
    const userGroupsLower = userGroups.map((g) => g.toLowerCase());
    return userGroupsLower.some((g) => allowedGroups.includes(g));
}

/** Consumers and coordinator leadership are exclusive to the dedicated task process. */
export function shouldStartWorkers(): boolean {
    return resolveTaskProcessRole(config.WORKER_MODE, config.DEDICATED_WORKER) === 'worker';
}

// ============================================================================
// Task System — Run State TTLs
// ============================================================================

// How long an active run hash survives without a heartbeat refresh (ms).
// Default 15 minutes matches the reconciler's 2-minute orphan threshold with margin.
export let LUMASTRA_RUN_STATE_TTL_ACTIVE_MS = live(
    'LUMASTRA_RUN_STATE_TTL_ACTIVE_MS',
    () =>
        getNumber(
            'LUMASTRA_RUN_STATE_TTL_ACTIVE_MS',
            env.LUMASTRA_RUN_STATE_TTL_ACTIVE_MS,
            900_000,
        ),
    (v) => {
        LUMASTRA_RUN_STATE_TTL_ACTIVE_MS = v;
    },
);

// How long a terminal run hash (completed/failed/cancelled) is kept for the cancel/retry UI (ms).
// Default 1 hour.
export let LUMASTRA_RUN_STATE_TTL_TERMINAL_MS = live(
    'LUMASTRA_RUN_STATE_TTL_TERMINAL_MS',
    () =>
        getNumber(
            'LUMASTRA_RUN_STATE_TTL_TERMINAL_MS',
            env.LUMASTRA_RUN_STATE_TTL_TERMINAL_MS,
            3_600_000,
        ),
    (v) => {
        LUMASTRA_RUN_STATE_TTL_TERMINAL_MS = v;
    },
);

// ============================================================================
// Task System — Orchestrator leader election + QueueEvents coalescing
// ============================================================================

// Per-class leader lock TTL (ms). The orchestrator extends this every
// LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS while leadership is held; if a renew is
// missed for ~(TTL - RENEW) the LeaderLock proactively relinquishes (onLost) so
// it can't split-brain.
//
// Default raised 5s -> 15s (renew 2s -> 5s) after a prod incident: under a
// fresh-install COLD-START drain (large library — intro/trickplay analysis,
// embeddings, image/series sync all draining at once) the single worker's event
// loop legitimately stalls multiple seconds, which at 5s/2s flapped leadership
// ~13x/min — stopping/restarting the reconciler every cycle ("reconciler has no
// heartbeat"). 15s/5s tolerates ~10s stalls while keeping failover reasonable. A
// single-worker deployment has no failover target anyway, so erring tolerant is
// correct there; heavy installs can raise it further via the env var.
export const LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS = getNumber(
    'LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS',
    env.LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS,
    15_000,
);

// Renew cadence for the per-class leader lock (ms). Must be < TTL.
export const LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS = getNumber(
    'LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS',
    env.LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS,
    5_000,
);

// QueueEvents batch flush window (ms). Inbound completed/failed events are
// coalesced so we issue at most one Lua transition per run per window.
export const LUMASTRA_TRANSITION_BATCH_WINDOW_MS = getNumber(
    'LUMASTRA_TRANSITION_BATCH_WINDOW_MS',
    env.LUMASTRA_TRANSITION_BATCH_WINDOW_MS,
    50,
);

// Maximum number of buffered transitions before a flush is forced regardless of the timer.
export const LUMASTRA_TRANSITION_BATCH_MAX = getNumber(
    'LUMASTRA_TRANSITION_BATCH_MAX',
    env.LUMASTRA_TRANSITION_BATCH_MAX,
    200,
);

// Hard cap on the number of descendants an admin cascade delete may remove in
// one call (DELETE /api/admin/media/[id]?cascade=true). Guards against an
// accidental whole-library wipe from a misclicked cascade on a high-level node.
export let LUMASTRA_CASCADE_DELETE_MAX = live(
    'LUMASTRA_CASCADE_DELETE_MAX',
    () => getNumber('LUMASTRA_CASCADE_DELETE_MAX', env.LUMASTRA_CASCADE_DELETE_MAX, 500),
    (v) => {
        LUMASTRA_CASCADE_DELETE_MAX = v;
    },
);

// ============================================================================
// Task System — Runner concurrency per resource class
// ============================================================================

// Concurrency caps per resource class.
//
// Defaults sized for a modest self-host (≤8 cores). The full
// `cpu+io+embedding+maintenance+ingest+bulk` sum is **8 slots** so the
// worker container fits comfortably on a 4-core host with breathing
// room for Postgres + Valkey + the SvelteKit app. Operators with
// beefier hosts should opt-up via the matching env vars — for
// example a 16-core machine could safely run double these caps:
//
//   LUMASTRA_CONCURRENCY_CPU=2 LUMASTRA_CONCURRENCY_IO=4 \
//   LUMASTRA_CONCURRENCY_EMBEDDING=2 LUMASTRA_CONCURRENCY_MAINTENANCE=2 \
//   LUMASTRA_CONCURRENCY_INGEST=4 LUMASTRA_CONCURRENCY_BULK=6
//
// Historical context: defaults used to be 2/4/2/3/4/2 = 17 slots,
// which fully saturated even the 18-core preprod host once the
// pipeline-event-system drain unblocked ~700k stuck rows and the
// workers started parallel-burning through the backlog. Halved
// because the original numbers assumed only one class ran hot at a
// time, which the ingest/bulk split broke.

// Heavy ffmpeg work (trickplay-generation, lumastra-intro-analyzer).
//
// Concurrent jobs for the cpu-class worker (trickplay-generation, intro-analyzer,
// music-analysis — Wave 8.5 folds the legacy `analysis` class into `cpu`).
//
// The DEFAULT is auto-sized to the effective CPU budget — floor(cores/2) clamped
// 1..6 (see cpuClassConcurrencyDefault) — and is cgroup-aware, so a Docker `cpus:`
// cap is honoured rather than the host's full core count. We scale only this lever
// and NOT LUMASTRA_FFMPEG_THREADS, since one cpu-class job already fans ffmpeg
// across that many cores and scaling both would multiply into quadratic load.
//
// In the running app the value comes from the ConfigService (schema dynamicDefault
// > JSON > ENV); the call below only governs standalone scripts where the
// ConfigService isn't initialised — computed the SAME way so both paths agree.
// Explicit env/admin settings always win.
export const LUMASTRA_CONCURRENCY_CPU = getNumber(
    'LUMASTRA_CONCURRENCY_CPU',
    env.LUMASTRA_CONCURRENCY_CPU,
    cpuClassConcurrencyDefault(getCpuBudgetCores()),
);

// io-class pool (file-library-scan, media-probe, chapter-sync, image-sync,
// watch-sync, tmdb/mdblist sync — the collapsed ingest+bulk classes). I/O- and
// network-bound, so it auto-sizes to the effective CPU budget (cgroup-aware,
// honours a Docker `cpus:` cap), cores clamped 4..12 — higher than the cpu class
// because these jobs mostly wait on I/O. A flat default of 2 starved this pool
// once it absorbed ingest+bulk. Explicit env/admin values still win.
export const LUMASTRA_CONCURRENCY_IO = getNumber(
    'LUMASTRA_CONCURRENCY_IO',
    env.LUMASTRA_CONCURRENCY_IO,
    ioClassConcurrencyDefault(getCpuBudgetCores()),
);

// Embedding generation (library/discovery/music). OpenAI calls dominate
// wallclock; one slot is enough to keep the rate-limiter saturated.
export const LUMASTRA_CONCURRENCY_EMBEDDING = getNumber(
    'LUMASTRA_CONCURRENCY_EMBEDDING',
    env.LUMASTRA_CONCURRENCY_EMBEDDING,
    1,
);

// Periodic housekeeping (cache cleanup, oauth cleanup, history cleanup).
// Single slot is plenty — these run on schedules, not per-item.
export const LUMASTRA_CONCURRENCY_MAINTENANCE = getNumber(
    'LUMASTRA_CONCURRENCY_MAINTENANCE',
    env.LUMASTRA_CONCURRENCY_MAINTENANCE,
    1,
);

// File-fast-path tasks (media-probe, integrity-file-present, image-sync,
// chapter-sync, file-library-scan, trickplay-params-sync). User-visible
// "new file just arrived" latency. Two slots so a single small file
// doesn't sit behind a slow probe.
export const LUMASTRA_CONCURRENCY_INGEST = getNumber(
    'LUMASTRA_CONCURRENCY_INGEST',
    env.LUMASTRA_CONCURRENCY_INGEST,
    2,
);

// Mass-enrichment / API-bound work (tmdb-metadata-sync, mdblist-sync,
// album/artist-enrichment, music-popularity, fribb/mal-anime-sync,
// series-sync). 2026-05-24: bumped 1→3 because 8 tasks competing for a
// single slot led to series-sync runs sitting pending >5min and getting
// reaped by reconciler as `pending_orphan_at_recovery` (343 such failures
// in 6h, observed on preprod). 3 concurrent fits comfortably under
// TMDB's 40 req/10s per-IP rate ceiling and MusicBrainz's even lower
// envelope (rate-limited at the dep layer regardless). If individual
// providers start 429ing, they'll back off via per-dep rate-limiter
// rather than starving the queue. Wave 8.5 (per-task queues) makes this
// knob less load-bearing — each task will have its own pop loop — but it is
// still the per-task cap for legacy bulk tasks (registry.ts) and part of the io
// budget (runner.ts defaultConcurrencyFor). The schema default MUST match this
// fallback: 6ac5d27f8 bumped only this line, so the running app (which uses the
// schema default via ConfigService) stayed on 1 until 2026-09-27.
export const LUMASTRA_CONCURRENCY_BULK = getNumber(
    'LUMASTRA_CONCURRENCY_BULK',
    env.LUMASTRA_CONCURRENCY_BULK,
    3,
);

// Long-running analysis (lumastra-intro-analyzer's chromaprint pass over
// season cohorts). Isolated from `cpu` so trickplay-generation and
// intro-analyzer never starve each other — they're both ffmpeg-heavy
// and the previous shared-pool design produced 30+ hour intro waits
// when trickplay had a backlog. One slot is sufficient because the
// task is per-season-fan-out (one job = one whole season's analysis).
export const LUMASTRA_CONCURRENCY_ANALYSIS = getNumber(
    'LUMASTRA_CONCURRENCY_ANALYSIS',
    env.LUMASTRA_CONCURRENCY_ANALYSIS,
    1,
);

// Discovery/catalog embedding backfill (`discovery-embeddings`). Isolated from
// `embedding` so the large, back-to-back catalog backfill never starves the
// user's own library/music embeddings that share the `embedding` budget. One
// slot is enough — it's OpenAI/Voyage API-bound (the dep rate-limiter governs
// throughput); the point of the separate class is fairness, not parallelism.
export const LUMASTRA_CONCURRENCY_DISCOVERY = getNumber(
    'LUMASTRA_CONCURRENCY_DISCOVERY',
    env.LUMASTRA_CONCURRENCY_DISCOVERY,
    1,
);

// Default per-task HTTP rate cap (requests/second) applied to `ctx.http`.
//
// Tasks call `ctx.http.get/post` against arbitrary external URLs. Unlike
// `ctx.dep(name).fetch()` (which honours the per-`externalDeps` rps bucket)
// and provider `ctx.http` (which honours the provider's declared `rateLimit`),
// a task's raw `ctx.http` had NO rate limiting at all — a task could hammer an
// upstream API in a tight loop, and across replicas the aggregate outbound rate
// was unbounded (TASK-C6).
//
// This is the safety-net default cap: every task with `capabilities.http`
// gets a per-task token bucket at this rps (shared cross-replica via the
// Valkey shared bucket, keyed by task id). It is intentionally generous —
// it is a guardrail against runaway loops, NOT a per-provider budget. Tasks
// that need a tighter, provider-specific limit should declare `externalDeps`
// and call `ctx.dep(name).fetch()` instead.
//
// Set to 0 to disable the default cap entirely (restores the old unbounded
// behaviour — not recommended).
export const LUMASTRA_TASK_HTTP_DEFAULT_RPS = getNumber(
    'LUMASTRA_TASK_HTTP_DEFAULT_RPS',
    env.LUMASTRA_TASK_HTTP_DEFAULT_RPS,
    10,
);

/**
 * Per-invocation thread cap for spawned ffmpeg processes. Without this,
 * ffmpeg uses all available cores for the decode + filter pipeline. On
 * preprod's 18-core host a single trickplay-generation (libwebp encode
 * of a long movie) consumed ~10 cores even though the worker's cpu-class
 * concurrency cap was 1 — the concurrency limit was per-slot, but each
 * slot's ffmpeg ran with default `-threads 0` (auto-detect → all cores).
 *
 * Default 4: enough for fast trickplay + media-probe keyframe extraction
 * without monopolizing the host. Set to 0 to restore the pre-cap "use
 * all cores" behavior (intended for dedicated transcoding hosts); set
 * higher than 4 only when you've verified the host has headroom for
 * other services.
 *
 * Applied via `spawnFFmpegSafely` which prepends `-threads N` to every
 * argv unless the caller already passed `-threads` explicitly.
 */
export let LUMASTRA_FFMPEG_THREADS = live(
    'LUMASTRA_FFMPEG_THREADS',
    () => getNumber('LUMASTRA_FFMPEG_THREADS', env.LUMASTRA_FFMPEG_THREADS, 4),
    (v) => {
        LUMASTRA_FFMPEG_THREADS = v;
    },
);

// Heartbeat cadence (ms) — runner refreshes Valkey active hash TTL and Postgres
// heartbeat_at column every interval. Boot recovery treats heartbeat_at older
// than 2 minutes as orphaned, so the default (30s) gives 4x safety margin.
export const LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS = getNumber(
    'LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS',
    env.LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS,
    30_000,
);

// Run stall thresholds (ms). When the heartbeat watchdog detects that
// `lastHeartbeatSuccessAt` is older than these limits, it acts on the run:
//   - at WARN: logs a single warning so operators can correlate the stall
//     with whatever the worker was doing.
//   - at FAIL: transitions the run to `failed` with errorKind='runtime' and
//     stops the heartbeat. The worker thread is still running (possibly stuck
//     on a blocking syscall) but is no longer tracked as "active". When the
//     wedged call eventually returns or the container restarts, runner.ts
//     skips the late terminal write because `stallFailed` is set.
//
// Defaults: warn at 2 min (matches boot-recovery orphan threshold), fail at
// 10 min. The gap gives ops a window to investigate before the runner makes
// the call.
export let LUMASTRA_RUN_STALL_WARN_MS = live(
    'LUMASTRA_RUN_STALL_WARN_MS',
    () => getNumber('LUMASTRA_RUN_STALL_WARN_MS', env.LUMASTRA_RUN_STALL_WARN_MS, 120_000),
    (v) => {
        LUMASTRA_RUN_STALL_WARN_MS = v;
    },
);
export let LUMASTRA_RUN_STALL_FAIL_MS = live(
    'LUMASTRA_RUN_STALL_FAIL_MS',
    () => getNumber('LUMASTRA_RUN_STALL_FAIL_MS', env.LUMASTRA_RUN_STALL_FAIL_MS, 600_000),
    (v) => {
        LUMASTRA_RUN_STALL_FAIL_MS = v;
    },
);

// Worker connection-wedge watchdog: if BullMQ Workers emit connection errors
// continuously for this long with NO job processed in between, the worker's
// task-Valkey connections are wedged (stuck after a Valkey partition / peer-IP
// change) and the process exits(1) so `restart: unless-stopped` recovers it with
// fresh connections. Set to 0 to disable. Default 2 min. See connection-watchdog.ts.
export const LUMASTRA_WORKER_CONN_WEDGE_MS = getNumber(
    'LUMASTRA_WORKER_CONN_WEDGE_MS',
    env.LUMASTRA_WORKER_CONN_WEDGE_MS,
    120_000,
);

// BullMQ job lock duration (ms) for task workers. BullMQ's built-in default is
// 30s, which assumes short jobs; the lock extender renews every lockDuration/2.
// Long-running tasks (file-library-scan averages ~55 min) legitimately stall the
// event loop / block on NFS I/O for >30s under host load, so the extender misses
// a renewal, BullMQ revokes the job ("could not renew lock for job …"), and the
// run wedges until it is finalized as "BullMQ job lock lost". The runner's own
// heartbeat + wall-clock stall watchdog (LUMASTRA_RUN_STALL_FAIL_MS) and
// boot-recovery are the AUTHORITATIVE liveness layer (Valkey+Postgres heartbeat,
// three-signal orphan classification), so BullMQ's lock only needs to track slot
// ownership — we widen it to tolerate transient stalls instead of false-failing
// slow-but-alive jobs. `stalledInterval` is set to match (see runner.ts) so
// BullMQ's own stalled-job check can't fire inside a single renewal gap. A
// genuinely dead worker still holds the lock for at most this long before BullMQ
// reclaims it, but the runner watchdogs + boot recovery finalize the run well
// before that. Default 5 min. Set to 0 to keep BullMQ's 30s default.
export const LUMASTRA_BULLMQ_LOCK_DURATION_MS = getNumber(
    'LUMASTRA_BULLMQ_LOCK_DURATION_MS',
    env.LUMASTRA_BULLMQ_LOCK_DURATION_MS,
    300_000,
);

// Maximum serialized task-input size (bytes). Protects task_history JSONB,
// BullMQ job data, and audit rows from slow-DoS via large payloads.
// Invalid values (non-digits, zero, NaN) fall back to 256 KiB with a warning.
// Default: 256 KiB.
export let LUMASTRA_MAX_TASK_INPUT_BYTES: number = live(
    'LUMASTRA_MAX_TASK_INPUT_BYTES',
    () =>
        (() => {
            const n = getNumber(
                'LUMASTRA_MAX_TASK_INPUT_BYTES',
                env.LUMASTRA_MAX_TASK_INPUT_BYTES,
                256 * 1024,
            );
            if (Number.isFinite(n) && n > 0) return Math.floor(n);
            console.warn(
                `[config] Invalid LUMASTRA_MAX_TASK_INPUT_BYTES=${n} ` +
                    '(expected a positive integer number of bytes) — using default 256 KiB',
            );
            return 256 * 1024;
        })(),
    (v) => {
        LUMASTRA_MAX_TASK_INPUT_BYTES = v;
    },
);

// ============================================================================
// Task System — Queue depth caps per resource class
// ============================================================================

// Maximum waiting+prioritized+delayed jobs before backpressure triggers.
export let LUMASTRA_QUEUE_DEPTH_CAP_CPU = live(
    'LUMASTRA_QUEUE_DEPTH_CAP_CPU',
    () => getNumber('LUMASTRA_QUEUE_DEPTH_CAP_CPU', env.LUMASTRA_QUEUE_DEPTH_CAP_CPU, 500),
    (v) => {
        LUMASTRA_QUEUE_DEPTH_CAP_CPU = v;
    },
);
export let LUMASTRA_QUEUE_DEPTH_CAP_IO = live(
    'LUMASTRA_QUEUE_DEPTH_CAP_IO',
    () => getNumber('LUMASTRA_QUEUE_DEPTH_CAP_IO', env.LUMASTRA_QUEUE_DEPTH_CAP_IO, 2_000),
    (v) => {
        LUMASTRA_QUEUE_DEPTH_CAP_IO = v;
    },
);
export let LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING = live(
    'LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING',
    () =>
        getNumber(
            'LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING',
            env.LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING,
            10_000,
        ),
    (v) => {
        LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING = v;
    },
);
export let LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE = live(
    'LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE',
    () =>
        getNumber(
            'LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE',
            env.LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE,
            100,
        ),
    (v) => {
        LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE = v;
    },
);
// Higher than io's 2k because a fresh library scan legitimately enqueues
// tens of thousands of fast-path file ops back-to-back.
export let LUMASTRA_QUEUE_DEPTH_CAP_INGEST = live(
    'LUMASTRA_QUEUE_DEPTH_CAP_INGEST',
    () => getNumber('LUMASTRA_QUEUE_DEPTH_CAP_INGEST', env.LUMASTRA_QUEUE_DEPTH_CAP_INGEST, 50_000),
    (v) => {
        LUMASTRA_QUEUE_DEPTH_CAP_INGEST = v;
    },
);
// Matched to io's 2k baseline — bulk enrichment is API-bound, so a deeper
// cap mostly just buys head-of-line latency without throughput gain.
export let LUMASTRA_QUEUE_DEPTH_CAP_BULK = live(
    'LUMASTRA_QUEUE_DEPTH_CAP_BULK',
    () => getNumber('LUMASTRA_QUEUE_DEPTH_CAP_BULK', env.LUMASTRA_QUEUE_DEPTH_CAP_BULK, 2_000),
    (v) => {
        LUMASTRA_QUEUE_DEPTH_CAP_BULK = v;
    },
);
// Matched to cpu's 500 baseline — analysis is ffmpeg-bound and per-season,
// so even a large library produces only a few hundred fan-out jobs at a
// time. 500 is generous; the cap mostly exists to surface a wedged backlog
// to the admin UI rather than to actually shed work in normal operation.
export let LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS = live(
    'LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS',
    () =>
        getNumber('LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS', env.LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS, 500),
    (v) => {
        LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS = v;
    },
);
// Matched to embedding's 10k — a fresh-install discovery flood legitimately
// enqueues tens of thousands of catalog embedding jobs back-to-back.
export let LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY = live(
    'LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY',
    () =>
        getNumber(
            'LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY',
            env.LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY,
            10_000,
        ),
    (v) => {
        LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY = v;
    },
);

// ============================================================================
// Task System — Circuit breaker
// ============================================================================

// Number of consecutive failures that opens the circuit.
export let LUMASTRA_CIRCUIT_FAILURE_THRESHOLD = live(
    'LUMASTRA_CIRCUIT_FAILURE_THRESHOLD',
    () =>
        getNumber('LUMASTRA_CIRCUIT_FAILURE_THRESHOLD', env.LUMASTRA_CIRCUIT_FAILURE_THRESHOLD, 5),
    (v) => {
        LUMASTRA_CIRCUIT_FAILURE_THRESHOLD = v;
    },
);

// Sliding window length for the failure-rate secondary trigger (ms). Default 30 min.
export let LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS = live(
    'LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS',
    () =>
        getNumber(
            'LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS',
            env.LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS,
            1_800_000,
        ),
    (v) => {
        LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS = v;
    },
);

// How long an admin force-enable bypass remains active (ms). Default 24 h.
export let LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS = live(
    'LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS',
    () =>
        getNumber(
            'LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS',
            env.LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS,
            86_400_000,
        ),
    (v) => {
        LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS = v;
    },
);

// ============================================================================
// Task System — Secret store
// ============================================================================

// 32-byte AES-256-GCM master key for plugin_secrets / plugin_user_credentials.
// Accepts a 64-char hex string (raw bytes) or an arbitrary passphrase (SHA-256).
//
// SECURITY: This value MUST NOT appear in mirrorToProcessEnv, config snapshots,
// admin UI exports, or any logging call. It is intentionally excluded from
// ConfigService get() — env-only, never from settings.json.
export const LUMASTRA_MASTER_KEY: string = env.LUMASTRA_MASTER_KEY ?? '';

// ============================================================================
// Task System — Metrics
// ============================================================================

// Bearer token required to scrape the /metrics endpoint.
// When set, requests must supply `Authorization: Bearer <token>`.
// When empty (the default) the endpoint is locked unless LUMASTRA_METRICS_PUBLIC
// is explicitly set to "true".
export let LUMASTRA_METRICS_BEARER_TOKEN: string = live(
    'LUMASTRA_METRICS_BEARER_TOKEN',
    () => getString('LUMASTRA_METRICS_BEARER_TOKEN', env.LUMASTRA_METRICS_BEARER_TOKEN, ''),
    (v) => {
        LUMASTRA_METRICS_BEARER_TOKEN = v;
    },
);

// Set to "true" to expose the /metrics endpoint without any authentication.
// SECURITY: Only enable this when the endpoint is protected at the network
// layer (e.g. scraper runs inside the same private network). Requires an
// explicit opt-in; the default (false) locks the endpoint when no bearer
// token is configured. Before enabling public scraping, set a distinct valid
// INSTANCE_ID on each replica (1–64 alphanumerics, dots, underscores or hyphens).
// Invalid values fall back to the hostname-bearing default, which appears
// in metric instance_id labels.
export let LUMASTRA_METRICS_PUBLIC: boolean = live(
    'LUMASTRA_METRICS_PUBLIC',
    () => getBool('LUMASTRA_METRICS_PUBLIC', env.LUMASTRA_METRICS_PUBLIC, false),
    (v) => {
        LUMASTRA_METRICS_PUBLIC = v;
    },
);

// ============================================================================
// Task System — Webhook delivery
// ============================================================================

// Maximum delivery attempts for each outbox entry before it is dead-lettered.
export let LUMASTRA_WEBHOOK_RETRY_ATTEMPTS = live(
    'LUMASTRA_WEBHOOK_RETRY_ATTEMPTS',
    () => getNumber('LUMASTRA_WEBHOOK_RETRY_ATTEMPTS', env.LUMASTRA_WEBHOOK_RETRY_ATTEMPTS, 8),
    (v) => {
        LUMASTRA_WEBHOOK_RETRY_ATTEMPTS = v;
    },
);

// Maximum concurrent outbox deliveries in-flight at once.
export let LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY = live(
    'LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY',
    () =>
        getNumber(
            'LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY',
            env.LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY,
            16,
        ),
    (v) => {
        LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY = v;
    },
);

// ============================================================================
// Task System — SSE / progress coalescing
// ============================================================================

// ============================================================================
// Task System — task_history retention tiers
// ============================================================================

// Rows younger than this many days stay in the hot task_history table.
// 30, not 90: per-item stage tasks write 15-70k runs/day, and at 90 days prod's
// hot table reached 3.7M rows / 4.2 GB, which every unindexed task_history
// scan paid for. Older runs stay queryable in task_history_archive.
export let LUMASTRA_TASK_HISTORY_HOT_DAYS = live(
    'LUMASTRA_TASK_HISTORY_HOT_DAYS',
    () => getNumber('LUMASTRA_TASK_HISTORY_HOT_DAYS', env.LUMASTRA_TASK_HISTORY_HOT_DAYS, 30),
    (v) => {
        LUMASTRA_TASK_HISTORY_HOT_DAYS = v;
    },
);

// ============================================================================
// Task System — Plugin upgrade + orphan recovery
// ============================================================================

// ============================================================================
// Task System — Failure event retention
// ============================================================================

// How many days plugin_failure_events rows are kept before the maintenance
// cleanup task purges them.
export let LUMASTRA_FAILURE_EVENT_RETENTION_DAYS = live(
    'LUMASTRA_FAILURE_EVENT_RETENTION_DAYS',
    () =>
        getNumber(
            'LUMASTRA_FAILURE_EVENT_RETENTION_DAYS',
            env.LUMASTRA_FAILURE_EVENT_RETENTION_DAYS,
            90,
        ),
    (v) => {
        LUMASTRA_FAILURE_EVENT_RETENTION_DAYS = v;
    },
);

// ============================================================================
// Database Cleanup — per-table retention periods (days)
// ============================================================================

/** Days to retain formerly available media; preserves the existing one-year policy. */
export let UNAVAILABLE_MEDIA_RETENTION_DAYS = live(
    'UNAVAILABLE_MEDIA_RETENTION_DAYS',
    () => getNumber('UNAVAILABLE_MEDIA_RETENTION_DAYS', env.UNAVAILABLE_MEDIA_RETENTION_DAYS, 30),
    (v) => {
        UNAVAILABLE_MEDIA_RETENTION_DAYS = v;
    },
);

/** Days to keep assistant_rate_limits date rows (per-day counters). Default 30. */
export let DB_CLEANUP_ASSISTANT_RATE_LIMITS_DAYS = live(
    'DB_CLEANUP_ASSISTANT_RATE_LIMITS_DAYS',
    () =>
        getNumber(
            'DB_CLEANUP_ASSISTANT_RATE_LIMITS_DAYS',
            env.DB_CLEANUP_ASSISTANT_RATE_LIMITS_DAYS,
            30,
        ),
    (v) => {
        DB_CLEANUP_ASSISTANT_RATE_LIMITS_DAYS = v;
    },
);

/** Days to keep cluster_node_events rows. Default 90. */
export let DB_CLEANUP_CLUSTER_NODE_EVENTS_DAYS = live(
    'DB_CLEANUP_CLUSTER_NODE_EVENTS_DAYS',
    () =>
        getNumber(
            'DB_CLEANUP_CLUSTER_NODE_EVENTS_DAYS',
            env.DB_CLEANUP_CLUSTER_NODE_EVENTS_DAYS,
            90,
        ),
    (v) => {
        DB_CLEANUP_CLUSTER_NODE_EVENTS_DAYS = v;
    },
);

/** Days to keep file_scanner_runs rows. Default 90. */
export let DB_CLEANUP_FILE_SCANNER_RUNS_DAYS = live(
    'DB_CLEANUP_FILE_SCANNER_RUNS_DAYS',
    () => getNumber('DB_CLEANUP_FILE_SCANNER_RUNS_DAYS', env.DB_CLEANUP_FILE_SCANNER_RUNS_DAYS, 90),
    (v) => {
        DB_CLEANUP_FILE_SCANNER_RUNS_DAYS = v;
    },
);

/** Days to keep plugin_secret_access_log rows. Default 90. */
export let DB_CLEANUP_PLUGIN_SECRET_ACCESS_LOG_DAYS = live(
    'DB_CLEANUP_PLUGIN_SECRET_ACCESS_LOG_DAYS',
    () =>
        getNumber(
            'DB_CLEANUP_PLUGIN_SECRET_ACCESS_LOG_DAYS',
            env.DB_CLEANUP_PLUGIN_SECRET_ACCESS_LOG_DAYS,
            90,
        ),
    (v) => {
        DB_CLEANUP_PLUGIN_SECRET_ACCESS_LOG_DAYS = v;
    },
);

/** Days to keep assistant_messages rows. Default 365. */
export let DB_CLEANUP_ASSISTANT_MESSAGES_DAYS = live(
    'DB_CLEANUP_ASSISTANT_MESSAGES_DAYS',
    () =>
        getNumber(
            'DB_CLEANUP_ASSISTANT_MESSAGES_DAYS',
            env.DB_CLEANUP_ASSISTANT_MESSAGES_DAYS,
            365,
        ),
    (v) => {
        DB_CLEANUP_ASSISTANT_MESSAGES_DAYS = v;
    },
);

/**
 * Days to keep transcode_failure_events rows. Default 30 — shorter than
 * plugin_failure_events' 90 because these rows are ~10-25KB (argv + stderr + env
 * jsonb) against that table's 500-char reason.
 */
export let TRANSCODE_FAILURE_RETENTION_DAYS = live(
    'TRANSCODE_FAILURE_RETENTION_DAYS',
    () => getNumber('TRANSCODE_FAILURE_RETENTION_DAYS', env.TRANSCODE_FAILURE_RETENTION_DAYS, 30),
    (v) => {
        TRANSCODE_FAILURE_RETENTION_DAYS = v;
    },
);

/**
 * Retention for segment_delivery_failures. Rows are aggregated per distinct
 * failure rather than per request, so this bounds how far back a delivery
 * investigation can reach, not how large a retry storm can grow the table.
 */
export let SEGMENT_DELIVERY_FAILURE_RETENTION_DAYS = live(
    'SEGMENT_DELIVERY_FAILURE_RETENTION_DAYS',
    () =>
        getNumber(
            'SEGMENT_DELIVERY_FAILURE_RETENTION_DAYS',
            env.SEGMENT_DELIVERY_FAILURE_RETENTION_DAYS,
            30,
        ),
    (v) => {
        SEGMENT_DELIVERY_FAILURE_RETENTION_DAYS = v;
    },
);

/**
 * Days to keep playback incidents — `client_diagnostics` rows of kind
 * 'playback_incident' (keyed by their client `occurred_at`), and, until its drop
 * migration, the frozen legacy `playback_incident_events` table. Default 30, same window
 * as transcode_failure_events. This is the primary bound; PLAYBACK_INCIDENT_MAX_ROWS_PER_USER
 * is a backstop for when the cleanup task never runs.
 */
export let PLAYBACK_INCIDENT_RETENTION_DAYS = live(
    'PLAYBACK_INCIDENT_RETENTION_DAYS',
    () => getNumber('PLAYBACK_INCIDENT_RETENTION_DAYS', env.PLAYBACK_INCIDENT_RETENTION_DAYS, 30),
    (v) => {
        PLAYBACK_INCIDENT_RETENTION_DAYS = v;
    },
);

/**
 * Hard per-user cap on playback incidents (`client_diagnostics` kind
 * 'playback_incident'), enforced independently of retention — survives a
 * maintenance task that never runs on an unattended self-hosted install. Scoped
 * per user so one misbehaving client cannot evict another user's incident
 * history. Also the per-user ceiling on NEW incidents accepted via
 * /diagnostics/events per rolling 24 h (incidents are exempt from the daily
 * byte budget, so this is their volume bound there).
 */
export let PLAYBACK_INCIDENT_MAX_ROWS_PER_USER = live(
    'PLAYBACK_INCIDENT_MAX_ROWS_PER_USER',
    () =>
        getNumber(
            'PLAYBACK_INCIDENT_MAX_ROWS_PER_USER',
            env.PLAYBACK_INCIDENT_MAX_ROWS_PER_USER,
            500,
        ),
    (v) => {
        PLAYBACK_INCIDENT_MAX_ROWS_PER_USER = v;
    },
);

/** Days to keep crash/hang/js_error/api_failures rows in client_diagnostics. */
export let CLIENT_DIAGNOSTICS_RETENTION_DAYS = live(
    'CLIENT_DIAGNOSTICS_RETENTION_DAYS',
    () => getNumber('CLIENT_DIAGNOSTICS_RETENTION_DAYS', env.CLIENT_DIAGNOSTICS_RETENTION_DAYS, 30),
    (v) => {
        CLIENT_DIAGNOSTICS_RETENTION_DAYS = v;
    },
);

/** Days to keep user/admin log bundles (rows + gzip blobs). */
export let CLIENT_LOG_BUNDLE_RETENTION_DAYS = live(
    'CLIENT_LOG_BUNDLE_RETENTION_DAYS',
    () => getNumber('CLIENT_LOG_BUNDLE_RETENTION_DAYS', env.CLIENT_LOG_BUNDLE_RETENTION_DAYS, 30),
    (v) => {
        CLIENT_LOG_BUNDLE_RETENTION_DAYS = v;
    },
);

/** Per-user cap over crash/hang/js_error/api_failures/log_bundle rows — separate from the
 *  playback incident cap so an error flood cannot evict playback history. */
export let CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER = live(
    'CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER',
    () =>
        getNumber(
            'CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER',
            env.CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER,
            1000,
        ),
    (v) => {
        CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER = v;
    },
);

/** Per-user bytes accepted per rolling 24h across all diagnostics (payload + blob). */
export let CLIENT_DIAGNOSTICS_DAILY_BYTES_PER_USER = live(
    'CLIENT_DIAGNOSTICS_DAILY_BYTES_PER_USER',
    () =>
        getNumber(
            'CLIENT_DIAGNOSTICS_DAILY_BYTES_PER_USER',
            env.CLIENT_DIAGNOSTICS_DAILY_BYTES_PER_USER,
            52_428_800,
        ),
    (v) => {
        CLIENT_DIAGNOSTICS_DAILY_BYTES_PER_USER = v;
    },
);

/**
 * Days to keep livetv_stream_failure_events rows. Default 30 — the same window as
 * transcode failures, and for the same reason: these rows carry an ~8KB stderr tail
 * plus probe/decision jsonb, and a channel failing in a loop writes steadily.
 */
export let LIVETV_FAILURE_RETENTION_DAYS = live(
    'LIVETV_FAILURE_RETENTION_DAYS',
    () => getNumber('LIVETV_FAILURE_RETENTION_DAYS', env.LIVETV_FAILURE_RETENTION_DAYS, 30),
    (v) => {
        LIVETV_FAILURE_RETENTION_DAYS = v;
    },
);

// ============================================================================
// Admin Audit Log
// ============================================================================

/**
 * Retention period for audit_log rows with source='admin' (days). Default 90.
 * Minimum 7 — guards against accidental deletion of very-recent audit data.
 * Operators in regulated industries should set this to ≥180.
 */
export let ADMIN_AUDIT_LOG_RETENTION_DAYS = live(
    'ADMIN_AUDIT_LOG_RETENTION_DAYS',
    () =>
        Math.max(
            7,
            getNumber('ADMIN_AUDIT_LOG_RETENTION_DAYS', env.ADMIN_AUDIT_LOG_RETENTION_DAYS, 90),
        ),
    (v) => {
        ADMIN_AUDIT_LOG_RETENTION_DAYS = v;
    },
);

/** Days to keep collaborative_chat_messages rows. Default 365. */
export let DB_CLEANUP_CHAT_MESSAGES_DAYS = live(
    'DB_CLEANUP_CHAT_MESSAGES_DAYS',
    () => getNumber('DB_CLEANUP_CHAT_MESSAGES_DAYS', env.DB_CLEANUP_CHAT_MESSAGES_DAYS, 365),
    (v) => {
        DB_CLEANUP_CHAT_MESSAGES_DAYS = v;
    },
);

/** Days to keep task_quota_usage rows. Default 365. */
export let DB_CLEANUP_TASK_QUOTA_USAGE_DAYS = live(
    'DB_CLEANUP_TASK_QUOTA_USAGE_DAYS',
    () => getNumber('DB_CLEANUP_TASK_QUOTA_USAGE_DAYS', env.DB_CLEANUP_TASK_QUOTA_USAGE_DAYS, 365),
    (v) => {
        DB_CLEANUP_TASK_QUOTA_USAGE_DAYS = v;
    },
);

/** Days after delivery/death to keep task_webhook_outbox rows. Default 30. */
export let DB_CLEANUP_TASK_WEBHOOK_OUTBOX_DAYS = live(
    'DB_CLEANUP_TASK_WEBHOOK_OUTBOX_DAYS',
    () =>
        getNumber(
            'DB_CLEANUP_TASK_WEBHOOK_OUTBOX_DAYS',
            env.DB_CLEANUP_TASK_WEBHOOK_OUTBOX_DAYS,
            30,
        ),
    (v) => {
        DB_CLEANUP_TASK_WEBHOOK_OUTBOX_DAYS = v;
    },
);

/**
 * Days after consume to keep pipeline event_outbox rows. Dispatcher leaves
 * consumed rows in place; without periodic pruning the table grows ~1 row
 * per pipeline event forever (557 MB after 7 days on preprod). Dead-letter
 * rows are never auto-pruned regardless of this setting. Default 7.
 */
export let DB_CLEANUP_EVENT_OUTBOX_DAYS = live(
    'DB_CLEANUP_EVENT_OUTBOX_DAYS',
    () => getNumber('DB_CLEANUP_EVENT_OUTBOX_DAYS', env.DB_CLEANUP_EVENT_OUTBOX_DAYS, 7),
    (v) => {
        DB_CLEANUP_EVENT_OUTBOX_DAYS = v;
    },
);

/**
 * Pipeline event-outbox dispatcher tuning. The dispatcher drains the outbox in a
 * loop bounded by DRAIN_BUDGET_MS each interval, then sleeps DRAIN_INTERVAL_MS.
 * The interval is the main throughput lever (more drain windows per minute); an
 * empty drain returns instantly, so a short interval is cheap on idle/small
 * installs but lets a busy one keep up with an import event-storm. Defaults
 * raised from the original 30s/100 — on a fresh install an initial library import
 * generates a burst of item.created/identity.assigned events, and 30s/100 left
 * the dispatcher hours behind. Env-overridable for per-install tuning / rollback.
 */
export const OUTBOX_DRAIN_INTERVAL_MS = getNumber(
    'LUMASTRA_OUTBOX_DRAIN_INTERVAL_MS',
    env.LUMASTRA_OUTBOX_DRAIN_INTERVAL_MS,
    10_000,
);
export const OUTBOX_DRAIN_BATCH_SIZE = getNumber(
    'LUMASTRA_OUTBOX_DRAIN_BATCH_SIZE',
    env.LUMASTRA_OUTBOX_DRAIN_BATCH_SIZE,
    500,
);
export const OUTBOX_DRAIN_BUDGET_MS = getNumber(
    'LUMASTRA_OUTBOX_DRAIN_BUDGET_MS',
    env.LUMASTRA_OUTBOX_DRAIN_BUDGET_MS,
    5_000,
);
// How many events the dispatcher drains in PARALLEL, sharded by
// hashtext(media_item_id) so per-item ordering is preserved. The serial drain
// (~1 event/DB-round-trip) cannot keep up with a full-library scan burst
// (hundreds of thousands of events → days behind); N workers give ~N× drain
// throughput. Each worker holds one connection from the shared task pool
// (LUMASTRA_DB_POOL_TASK_MAX, default 7) during its per-row tx.
//
// The DEFAULT auto-sizes to the effective CPU budget — floor(cores/2) clamped
// 1..4 (cgroup/Docker-`cpus:`-aware via getCpuBudgetCores, same as the task
// worker classes) — so a 1–2c worker stays effectively serial and an 8c+ worker
// parallel-drains, while the 1..4 cap always leaves ≥3 task-pool connections for
// the runner. Set to 1 to force the fully-serial drain; raise it (and the task
// pool) explicitly for a dedicated worker host. Explicit env always wins.
export const OUTBOX_DRAIN_CONCURRENCY = getNumber(
    'LUMASTRA_OUTBOX_DRAIN_CONCURRENCY',
    env.LUMASTRA_OUTBOX_DRAIN_CONCURRENCY,
    outboxDrainConcurrencyDefault(getCpuBudgetCores()),
);

/** Days before hard-deleting task_history_archive rows. Default 730 (2 years). */
export let DB_CLEANUP_TASK_HISTORY_ARCHIVE_DAYS = live(
    'DB_CLEANUP_TASK_HISTORY_ARCHIVE_DAYS',
    () =>
        getNumber(
            'DB_CLEANUP_TASK_HISTORY_ARCHIVE_DAYS',
            env.DB_CLEANUP_TASK_HISTORY_ARCHIVE_DAYS,
            730,
        ),
    (v) => {
        DB_CLEANUP_TASK_HISTORY_ARCHIVE_DAYS = v;
    },
);

/** Days to keep watch_history rows (by session_start_time). Default 400. */
export let DB_CLEANUP_WATCH_HISTORY_DAYS = live(
    'DB_CLEANUP_WATCH_HISTORY_DAYS',
    () => getNumber('DB_CLEANUP_WATCH_HISTORY_DAYS', env.DB_CLEANUP_WATCH_HISTORY_DAYS, 400),
    (v) => {
        DB_CLEANUP_WATCH_HISTORY_DAYS = v;
    },
);

/** Days to keep livetv_channel_watch_history rows. Default 180. */
export let DB_CLEANUP_LIVETV_WATCH_HISTORY_DAYS = live(
    'DB_CLEANUP_LIVETV_WATCH_HISTORY_DAYS',
    () =>
        getNumber(
            'DB_CLEANUP_LIVETV_WATCH_HISTORY_DAYS',
            env.DB_CLEANUP_LIVETV_WATCH_HISTORY_DAYS,
            180,
        ),
    (v) => {
        DB_CLEANUP_LIVETV_WATCH_HISTORY_DAYS = v;
    },
);

/** Days before archiving user_media_events to user_media_events_archive. Default 365. */
export let DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS = live(
    'DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS',
    () =>
        getNumber(
            'DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS',
            env.DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS,
            365,
        ),
    (v) => {
        DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS = v;
    },
);

/** Days before hard-deleting rows from user_media_events_archive. Default 1825 (5 years). */
export let DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS = live(
    'DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS',
    () =>
        getNumber(
            'DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS',
            env.DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS,
            1825,
        ),
    (v) => {
        DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS = v;
    },
);

// ============================================================================
// Task System — Audit tamper evidence (v2 placeholder)
// ============================================================================

/**
 * Activates the pipeline event outbox + dispatcher. When true, the DB
 * triggers added in migration 16.20.0 emit events into `event_outbox` on
 * every relevant DML, and the PipelineEventDispatcher service drains the
 * outbox routing each event to `StageStateService.invalidateByEvent` plus
 * any registered side-effect handlers.
 *
 * **Default true** as of the Phase C deploy (2026-05-22). Phase C added
 * `has_file` eligibility predicates to file-bound stages, which seed
 * file-less items as `skipped_permanent` at item creation. Without the
 * event flow, no path exists to flip those rows back to `pending` when
 * a file is later attached — so the system is only functional with this
 * flag on. The env var stays available as an emergency kill-switch but
 * disabling it requires manually re-flipping the affected stage_state
 * rows; do not flip OFF without operator runbook acknowledgement.
 *
 * App startup writes this value into the `feature_flags` table on every
 * boot via `syncEventOutboxFlag` (turn-on-only semantics — see
 * docstring for the rolling-deploy safety story).
 */
export const FEATURE_PIPELINE_EVENT_OUTBOX = getBool(
    'FEATURE_PIPELINE_EVENT_OUTBOX',
    env.FEATURE_PIPELINE_EVENT_OUTBOX,
    true,
);

/**
 * Wave 8.5 flag — per-task BullMQ queues + class-level budget semaphore.
 * When ON (now the default), the runner spawns one Worker per registered task
 * and class concurrency is enforced via the Valkey budget semaphore (atomic
 * acquire; budget-blocked jobs defer gracefully via moveToDelayed). When OFF,
 * the legacy one-Worker-per-resource-class model.
 *
 * Default flipped to ON 2026-05-24 after the preprod soak validated the model:
 * no budget-token leak, no fail/orphan churn, all task backlogs drain, no
 * connection leak. Production picks it up when `main` is promoted to `stable`.
 *
 * Tuning note: the legacy-class shim collapses ingest+bulk→io and analysis→cpu,
 * so the io/cpu physical budgets now carry that combined load. Size
 * LUMASTRA_CONCURRENCY_IO / _CPU per environment (via env) to absorb the
 * collapsed pools, otherwise io/cpu-heavy tasks drain slower than the old
 * separate-pool model. Operators flip the flag itself via env (no admin knob).
 */
export const FEATURE_PER_TASK_QUEUES = getBool(
    'FEATURE_PER_TASK_QUEUES',
    env.FEATURE_PER_TASK_QUEUES,
    true,
);

/**
 * Task-system connection consolidation. When ON, the task system builds one
 * shared IORedis instance per process and passes it to every Queue/Worker/
 * QueueEvents construction site instead of a fresh options object each time.
 * BullMQ marks connections built from a live IORedis instance `shared: true`
 * (verified against bullmq's own source, see connection.ts) and reuses it for
 * Queue instances and each Worker's non-blocking main connection — cutting
 * the task system's ioredis connection count roughly in half. Worker's
 * blocking pop and QueueEvents both always open their own dedicated
 * connection regardless (a BullMQ architecture requirement, not a choice
 * this flag can change) — this does NOT reduce the per-task Worker/
 * QueueEvents connection count to zero, only Queue's.
 *
 * This is purely a connection-topology change: it does not touch job
 * scheduling, fairness, concurrency, or the per-task-queue starvation-
 * avoidance model. Default follows LUMASTRA_LOW_RAM_MODE: constrained installs
 * already opt into bounded heap usage, and the per-task queue model otherwise
 * opens one Queue connection per registered task. Set
 * FEATURE_SHARED_QUEUE_CONNECTION explicitly for instant override/rollback if a
 * shared-connection hiccup (Valkey restart, network blip) affects
 * Queue/QueueEvents recovery in a way the isolated-per-instance model didn't.
 */
export const FEATURE_SHARED_QUEUE_CONNECTION = getBool(
    'FEATURE_SHARED_QUEUE_CONNECTION',
    env.FEATURE_SHARED_QUEUE_CONNECTION,
    parseBoolEnv(env.LUMASTRA_LOW_RAM_MODE),
);

/**
 * Master switch for worker-thread plugin isolation. When ON, a task that
 * declares `isolation: 'worker'` in its manifest runs `execute(ctx)` inside a
 * `node:worker_threads` Worker instead of in-process on the shared event loop.
 * This is the ONLY hard defence against a *synchronous* plugin busy-loop
 * (`while(true){}` with no `await`), which otherwise starves the heartbeat
 * interval, BullMQ lock renewal, and the wall-clock/stall watchdogs for every
 * run on that worker (those watchdogs live on the same blocked loop). With
 * isolation on, the watchdogs run on the unblocked main thread and can call
 * `worker.terminate()` to hard-kill the wedged thread.
 *
 * Default ON — a synchronous busy-loop in a CPU-heavy plugin is the one failure
 * mode the in-process path cannot defend against (the watchdogs share the
 * blocked loop), so isolation is the safe default for any task that opts in via
 * `isolation: 'worker'`. The cross-thread liveness defence (main-thread
 * heartbeat/stall watchdog → `worker.terminate()`) is already wired in
 * `runner.ts`, so default-ON has a hard recovery path. Set the env var to
 * `false` to force the legacy in-process path. Like FEATURE_PER_TASK_QUEUES this
 * is an operator/env flag (no admin-UI knob): it is an `export const` read once
 * at module load, not a runtime-editable `config` getter, so it is intentionally
 * NOT registered in `src/lib/config/schema.ts` (matching every sibling
 * LUMASTRA_* / FEATURE_ operational const). Flip it via the
 * `FEATURE_PLUGIN_WORKER_ISOLATION` env var.
 */
export const FEATURE_PLUGIN_WORKER_ISOLATION = getBool(
    'FEATURE_PLUGIN_WORKER_ISOLATION',
    env.FEATURE_PLUGIN_WORKER_ISOLATION,
    true,
);

/**
 * Per-isolated-run Postgres pool size. Each worker rebuilds a *real*
 * `ctx.sql` from `DATABASE_URL` (the hybrid design avoids the impractical
 * RPC-proxying of postgres.js tagged templates), so an isolated run opens its
 * own small pool. Bounded so N concurrent isolated runs can't exhaust
 * Postgres `max_connections`. Worst-case extra connections ≈ Σ(isolated-class
 * concurrency) × this value; with the target classes (`analysis`=1, `cpu`=2)
 * that's a handful. Operators running many isolated tasks must size Postgres
 * `max_connections` accordingly.
 */
export const LUMASTRA_ISOLATION_DB_POOL_MAX = getNumber(
    'LUMASTRA_ISOLATION_DB_POOL_MAX',
    env.LUMASTRA_ISOLATION_DB_POOL_MAX,
    2,
);

/**
 * Grace window (ms) between asking an isolated worker to stop (posting an
 * abort message so cooperative `await`s can unwind) and hard `terminate()`.
 * A cooperative plugin that honours `ctx.signal` exits within the window and
 * is never force-killed; a non-cooperative busy-loop ignores the signal and
 * is terminated after it elapses. Kept short — the terminal `task_history`
 * write already landed (watchdog path) before terminate, so this only governs
 * how long we wait for a clean unwind.
 */
export const LUMASTRA_ISOLATION_TERMINATE_GRACE_MS = getNumber(
    'LUMASTRA_ISOLATION_TERMINATE_GRACE_MS',
    env.LUMASTRA_ISOLATION_TERMINATE_GRACE_MS,
    2_000,
);

/**
 * Absolute path to the pre-built worker-thread entry bundle. Empty (default)
 * resolves to `<cwd>/build/sandbox-entry.js` — the esbuild artifact produced
 * by `scripts/build-sandbox.ts` (npm run build:sandbox) and copied into the
 * image's `build/` dir. Both the web and worker containers run `node build`
 * from `/app`, so the cwd-relative default is correct in production; override
 * only for non-standard layouts or local dev against a custom build path.
 */
export const LUMASTRA_ISOLATION_ENTRY_PATH = getString(
    'LUMASTRA_ISOLATION_ENTRY_PATH',
    env.LUMASTRA_ISOLATION_ENTRY_PATH,
    '',
);

/**
 * V8 old-generation heap cap (MiB) for isolated plugin worker threads.
 * Limits the long-lived JS heap portion; a plugin that allocates beyond this
 * triggers a V8 OOM instead of crashing the host process. Default 512 MiB is
 * generous for typical plugin workloads while protecting the host on a 2 GiB+
 * container. Override with LUMASTRA_ISOLATION_WORKER_OLD_HEAP_MB.
 */
export const LUMASTRA_ISOLATION_WORKER_OLD_HEAP_MB = getNumber(
    'LUMASTRA_ISOLATION_WORKER_OLD_HEAP_MB',
    env.LUMASTRA_ISOLATION_WORKER_OLD_HEAP_MB,
    512,
);

/**
 * V8 young-generation (nursery) heap cap (MiB) for isolated plugin worker
 * threads. Constrains short-lived allocation pressure independently of the old-
 * gen cap. Default 32 MiB matches V8's own default nursery so normal workloads
 * are unaffected while preventing extreme young-gen blowup. Override with
 * LUMASTRA_ISOLATION_WORKER_YOUNG_HEAP_MB.
 */
export const LUMASTRA_ISOLATION_WORKER_YOUNG_HEAP_MB = getNumber(
    'LUMASTRA_ISOLATION_WORKER_YOUNG_HEAP_MB',
    env.LUMASTRA_ISOLATION_WORKER_YOUNG_HEAP_MB,
    32,
);

/**
 * Stack size cap (MiB) for isolated plugin worker threads. Guards against
 * deep-recursion stack overflows escaping to the host. Default 8 MiB equals
 * the Node.js default thread stack, so well-behaved plugins see no change.
 * Override with LUMASTRA_ISOLATION_WORKER_STACK_MB.
 */
export const LUMASTRA_ISOLATION_WORKER_STACK_MB = getNumber(
    'LUMASTRA_ISOLATION_WORKER_STACK_MB',
    env.LUMASTRA_ISOLATION_WORKER_STACK_MB,
    8,
);

/**
 * Per-rule cap on findings the integrity-scanner processes in one run.
 * 2026-05-24: bumped 1000→25000 in two steps. The original 1000 was an
 * "alert threshold" framed as a throughput cap; per-finding cost is one
 * recordViolation upsert (≈1-2ms incl. round-trip), so 25000 ≈ 25-50s
 * per rule per run — comfortable. Combined with the schedule drop from
 * 24h→6h (in lumastra-intro-analyzer.ts — same commit) yields 100k drain/day
 * which clears a 108k backlog in ≈1.1 days. Operators with much larger
 * backlogs can bump higher via env; the practical ceiling is per-rule
 * wall-clock the operator is willing to spend.
 */
export let INTEGRITY_MAX_FINDINGS_PER_RULE = live(
    'INTEGRITY_MAX_FINDINGS_PER_RULE',
    () => getNumber('INTEGRITY_MAX_FINDINGS_PER_RULE', env.INTEGRITY_MAX_FINDINGS_PER_RULE, 25000),
    (v) => {
        INTEGRITY_MAX_FINDINGS_PER_RULE = v;
    },
);

// ============================================================================
// Pipeline Coverage — authoritative stage eligibility flag
// ============================================================================

/**
 * All stage_ids that have been migrated to coverage-table eligibility AND are
 * safe to enable by default. This is the default value for
 * PIPELINE_COVERAGE_AUTHORITATIVE_STAGES when the env var is not set.
 * Operators can override with a shorter list to opt specific stages back to
 * legacy predicates, or a longer list to opt-in to stages that are not safe
 * by default (e.g. `trickplay-params-sync`; see below).
 *
 * Excluded by default (write-migrated, read disabled — operator opt-in only):
 * - `trickplay-params-sync`: per-file/per-item granularity mismatch. The
 *   stage writes one `media_item_stage_state` row per (media_item,
 *   'trickplay-params-sync'), but `findCoverageTableBacklog` joins per-file.
 *   After the first file's params land, the item-level coverage row flips to
 *   `completed`, excluding all other files of the same item from the backlog
 *   query — so multi-file items (e.g. a movie with multiple cuts) would only
 *   ever sync trickplay for their first file. Operators with single-file
 *   libraries may opt in by overriding the env var. Tracked for follow-up:
 *   migrate coverage to (media_item, file) granularity for this stage.
 */
export const DEFAULT_AUTHORITATIVE_STAGES: readonly string[] = [
    // The analyzer's per-episode coverage stage. Split from the combined
    // 'lumastra-intro-analyzer' id when its visual and acoustic detector groups
    // became independently versioned; only this one is framework-swept.
    'lumastra-intro-analyzer:visual',
    'music-analysis',
    'album-enrichment',
    'artist-enrichment',
    'music-popularity',
    'mdblist-sync',
    'library-embeddings',
    'discovery-embeddings',
    'music-embedding-generation',
    'acoustid-fingerprint',
    'tmdb-metadata-sync',
    'series-sync',
    'image-sync',
    'chapter-sync',
    'metadata-update',
    'fribb-anime-sync',
    'mal-anime-id-enrichment',
] as const;

/**
 * Comma-separated list of stage_ids for which `media_item_stage_state` is
 * the authoritative eligibility source instead of the legacy
 * `processing_state` predicates.
 *
 * Defaults to {@link DEFAULT_AUTHORITATIVE_STAGES} when the env var is unset.
 * Operators may override with a shorter list to opt specific stages back to
 * legacy predicates, or a longer list to opt in to stages excluded from the
 * defaults (e.g. `trickplay-params-sync`).
 *
 * Empty-string semantics:
 * - **Unset** (env var not defined): use {@link DEFAULT_AUTHORITATIVE_STAGES}.
 * - **Set to empty string** (`PIPELINE_COVERAGE_AUTHORITATIVE_STAGES=`): treat
 *   as an explicit operator choice meaning "no stages authoritative". This
 *   disables coverage-table mode for every stage and falls back to legacy
 *   predicates everywhere. Useful for emergency rollback without redeploy.
 *
 * Example: `PIPELINE_COVERAGE_AUTHORITATIVE_STAGES=music-analysis,album-enrichment`
 *
 * Parsed once at startup; changing requires a process restart.
 */
/**
 * Parse a `PIPELINE_COVERAGE_AUTHORITATIVE_STAGES` env value into the set of
 * stage IDs that should use coverage-table eligibility.
 *
 * - `rawEnv === undefined` → use {@link DEFAULT_AUTHORITATIVE_STAGES}.
 * - `rawEnv === ''` → empty Set (operator explicitly disabled coverage mode).
 * - Otherwise → parse the comma/pipe-separated list verbatim.
 *
 * Exported for unit testing.
 */
export function parseAuthoritativeStageIds(
    rawEnv: string | undefined,
    defaults: readonly string[] = DEFAULT_AUTHORITATIVE_STAGES,
): Set<string> {
    // CRITICAL: distinguish "unset" from "set-to-empty".
    // `getString()` collapses both into the default, which silently flips
    // every stage ON when an operator writes `PIPELINE_COVERAGE_AUTHORITATIVE_STAGES=`
    // intending the opposite. Special-case this config so an explicit empty
    // value is honored as "no stages authoritative".
    if (rawEnv === undefined) {
        return new Set(defaults);
    }
    return new Set(parseList(rawEnv, '').filter((s) => s.length > 0));
}

const _authoritativeStageIds: Set<string> = parseAuthoritativeStageIds(
    env.PIPELINE_COVERAGE_AUTHORITATIVE_STAGES,
);

/**
 * Returns the set of stage_ids that should use `media_item_stage_state` for
 * backlog eligibility instead of the legacy predicates.
 *
 * The set is parsed once at module load time from
 * `PIPELINE_COVERAGE_AUTHORITATIVE_STAGES`. Callers may call this freely —
 * the same `Set` instance is returned every time.
 */
export function getAuthoritativeStageIds(): Set<string> {
    return _authoritativeStageIds;
}

/**
 * Validates the authoritative stage IDs against the set of stage IDs known
 * to the registry. Call this after the registry has been fully populated
 * (i.e. after `loadBuiltins()`).
 *
 * - Warns on any stage_id in the authoritative set that has no matching
 *   registered stage (typo or removed plugin).
 * - Logs INFO listing any known stage_id absent from the authoritative set
 *   so operators can spot drift when they override the env var.
 *
 * Exported for unit testing.
 */
export function validateAuthoritativeStageIds(
    authoritativeIds: Set<string>,
    knownStageIds: string[],
    warn: (msg: string) => void,
    info: (msg: string, meta?: Record<string, unknown>) => void,
): void {
    const knownSet = new Set(knownStageIds);

    const unknownInConfig: string[] = [];
    for (const id of authoritativeIds) {
        if (!knownSet.has(id)) {
            unknownInConfig.push(id);
        }
    }
    if (unknownInConfig.length > 0) {
        warn(
            `PIPELINE_COVERAGE_AUTHORITATIVE_STAGES contains stage_id(s) not found in the registry ` +
                `(typo or removed plugin): ${unknownInConfig.join(', ')}`,
        );
    }

    const missingFromConfig: string[] = [];
    for (const id of knownStageIds) {
        if (!authoritativeIds.has(id)) {
            missingFromConfig.push(id);
        }
    }
    if (missingFromConfig.length > 0) {
        info(
            'Known stage_id(s) not in PIPELINE_COVERAGE_AUTHORITATIVE_STAGES — ' +
                'these stages will use legacy predicates:',
            { stages: missingFromConfig },
        );
    }
}

// ============================================================================
// Cache Warming — startup pre-population of frequently-accessed data
// ============================================================================

// Read via getBool (ConfigService-aware) so admin-stored settings.json values
// apply at boot — the schema marks these requiresRestart, and these consts are
// initialized after initConfigServiceSync, so a restart is exactly what makes
// a stored change take effect.

/** Enable/disable the cache warming background job at startup. Default: true. */
export const CACHE_WARMING_ENABLED: boolean = getBool(
    'CACHE_WARMING_ENABLED',
    env.CACHE_WARMING_ENABLED,
    true,
);

/** Warm the trending list at startup. Default: true. */
export let CACHE_WARM_TRENDING: boolean = live(
    'CACHE_WARM_TRENDING',
    () => getBool('CACHE_WARM_TRENDING', env.CACHE_WARM_TRENDING, true),
    (v) => {
        CACHE_WARM_TRENDING = v;
    },
);

/** Warm item metadata at startup. Default: true. */
export let CACHE_WARM_METADATA: boolean = live(
    'CACHE_WARM_METADATA',
    () => getBool('CACHE_WARM_METADATA', env.CACHE_WARM_METADATA, true),
    (v) => {
        CACHE_WARM_METADATA = v;
    },
);

/** Warm hero Next-Up items at startup. Default: true. */
export let CACHE_WARM_HERO: boolean = live(
    'CACHE_WARM_HERO',
    () => getBool('CACHE_WARM_HERO', env.CACHE_WARM_HERO, true),
    (v) => {
        CACHE_WARM_HERO = v;
    },
);

/** Warm browse pages at startup. Default: true. */
export let CACHE_WARM_BROWSE: boolean = live(
    'CACHE_WARM_BROWSE',
    () => getBool('CACHE_WARM_BROWSE', env.CACHE_WARM_BROWSE, true),
    (v) => {
        CACHE_WARM_BROWSE = v;
    },
);

/** Max number of recently-active users to warm. Default: 20. */
export let CACHE_WARM_USERS_LIMIT: number = live(
    'CACHE_WARM_USERS_LIMIT',
    () => getNumber('CACHE_WARM_USERS_LIMIT', env.CACHE_WARM_USERS_LIMIT, 20),
    (v) => {
        CACHE_WARM_USERS_LIMIT = v;
    },
);

/** Max number of metadata items to warm per user. Default: 100. */
export let CACHE_WARM_METADATA_LIMIT: number = live(
    'CACHE_WARM_METADATA_LIMIT',
    () => getNumber('CACHE_WARM_METADATA_LIMIT', env.CACHE_WARM_METADATA_LIMIT, 100),
    (v) => {
        CACHE_WARM_METADATA_LIMIT = v;
    },
);

/** Days of activity to look back when finding recently-active users. Default: 14. */
export let CACHE_WARM_ACTIVE_DAYS: number = live(
    'CACHE_WARM_ACTIVE_DAYS',
    () => getNumber('CACHE_WARM_ACTIVE_DAYS', env.CACHE_WARM_ACTIVE_DAYS, 14),
    (v) => {
        CACHE_WARM_ACTIVE_DAYS = v;
    },
);

/** Hour of day (0–23 UTC) at which the nightly full warming run fires. Default: 3. */
export const CACHE_WARM_NIGHTLY_HOUR: number = getNumber(
    'CACHE_WARM_NIGHTLY_HOUR',
    env.CACHE_WARM_NIGHTLY_HOUR,
    3,
);

// NOTE: ConfigService is initialized at the top of this file to enable
// reading merged values (settings.json + ENV) for feature flags and other settings.

// Keep the `live()` settings current: a local save, and the reload every save
// broadcasts to the other replicas and the worker, both land here.
// (Guarded: a test that mocks the config service partially has no listener API.)
if (typeof onConfigChange === 'function') {
    onConfigChange(() => {
        for (const refresh of liveRefreshers) refresh();
    });
}
