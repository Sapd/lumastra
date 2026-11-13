// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Configuration Schema
 *
 * Defines all configurable settings with their types, defaults, validation rules,
 * and UI hints. Settings here can be stored in JSON config file and overridden by ENV.
 *
 * Settings that remain ENV-only (secrets/infrastructure):
 * - All *APIKEY, *_API_KEY (API keys and secrets)
 * - All *URL service connection URLs
 * - JWT_SECRET, EMBEDDING_API_KEY, MUSIC_TRANSCODE_TOKEN_SECRET
 * - DATABASE_URL, CACHE_URL
 * - PORT, NODE_ENV, USERHEADER, GROUPHEADER
 */

// `normalizeLanguageTag` is pure (no Node imports) — safe in this client-shared
// bundle, same as the pure helpers already defined below.
import * as m from '$lib/paraglide/messages.js';
import { CLIENT_VERSION_PATTERN } from '$lib/shared/client-version.js';

import { isCorsOrigin } from '$lib/shared/cors-origins.js';
import { normalizePublicBaseUrl } from '$lib/shared/public-base-url.js';
import { normalizeLanguageTag } from '$lib/shared/metadata-language.js';

// Homepage widget definitions and feature-flag helpers now live in their own
// dependency-light module (2026-09-25) so pages that only need those don't
// pull in this whole, much heavier settings schema. Re-exported here so
// existing importers of `$lib/config/schema` are unaffected.
export {
    HOMEPAGE_WIDGET_IDS,
    type HomepageWidgetId,
    type WidgetDefinition,
    WIDGET_DEFINITIONS,
    featureKeyForFlag,
    widgetFeatureKey,
} from './widget-definitions.js';

// ============================================================================
// Type Definitions
// ============================================================================

export type SettingType =
    | 'boolean'
    | 'number'
    | 'string'
    | 'select'
    | 'array'
    | 'url'
    | 'color'
    | 'path'
    | 'navigation' // Complex navigation arrays (sidebar, footer, user menu)
    | 'widgets'; // Homepage widget configuration

// Widget visibility states for admin-controlled homepage configuration
export type WidgetVisibility = 'visible' | 'hidden' | 'disabled';

// Widget visibility map (widget ID -> visibility state)
export type WidgetVisibilityMap = Record<string, WidgetVisibility>;

export interface ValidationRules {
    min?: number;
    max?: number;
    minLength?: number;
    maxLength?: number;
    pattern?: string;
    options?: Array<{ value: string | number; label: string; uiHints?: UiHints }>;
    uiHints?: UiHints;
    // Map of option value to setting key - option only shows when that setting is truthy
    optionDependencies?: Record<string, string>;
    /** Max number of entries for an `array`-type setting. */
    maxItems?: number;
    /**
     * When true, a `number`-type setting must be a whole number (day counts,
     * row caps, byte budgets). Enforced for every source — settings.json,
     * admin saves and environment variables.
     */
    integer?: boolean;
    /**
     * When true, every entry of an `array`-type setting must be a valid
     * BCP-47-ish language tag (see `normalizeLanguageTag`) — e.g.
     * `METADATA_ADDITIONAL_LANGUAGES`.
     */
    languageTags?: boolean;
    /** Entries must be exact HTTP(S) origins or an explicit '*'. */
    corsOrigins?: boolean;
    /** Validate a primary language tag on changed saves, preserving legacy loads. */
    languageTag?: boolean;
}

export interface UiHints {
    suffix?: string; // e.g., "seconds", "ms", "hours"
    prefix?: string; // e.g., "$", "#"
    placeholder?: string;
    multiline?: boolean;
    rows?: number;
    step?: number; // For number inputs
    hidden?: boolean; // Hide from UI entirely
    devOnly?: boolean; // Mark as development/debug setting (shows warning badge)
    beta?: boolean; // Mark as experimental/beta feature (shows beta badge)
    advanced?: boolean; // Mark as advanced setting (shows warning badge, only modify if you know what you're doing)
    sensitive?: boolean; // Mask input (for API keys, passwords)
    envOnly?: boolean; // Can only be set via environment variable (PUBLIC_ vars)
    /**
     * For `type: 'boolean'` settings only. The env var name and the stored
     * value keep meaning exactly what they always meant (renaming either is a
     * silent breaking change for every existing deployment) — this only tells
     * `BooleanInput` to flip what the SWITCH SHOWS, so a positively-labeled
     * setting whose underlying value is "off means running" (e.g. the
     * `DISABLE_*` task killswitches) doesn't render as a lie: the switch
     * appears ON when the task runs, OFF when it's disabled.
     */
    invert?: boolean;
    healthCheckProvider?: string; // Provider name for test connection button (calls /api/admin/providers/health)
    /**
     * This setting's VALUE references auth/user groups — a single group name or a
     * comma-separated list of group names (e.g. `ADMIN_GROUPS`, `LIVETV_HIGH_PRIORITY_GROUPS`).
     * Surfaces the setting in the Access page's aggregate "Group-based rules" audit
     * panel via {@link getGroupReferencingSettings}, without relocating it — it still
     * lives (and saves) on its own feature section. Only set this when the value
     * itself is a group name/list; do NOT set it for fields that merely mention the
     * word "group" (an HTTP header name, an OIDC claim name, or a `library_groups`
     * media-collection UUID are NOT auth-group references).
     */
    groups?: true;
    /**
     * When set to `'image'`, render a thumbnail preview of the URL value
     * (only meaningful for `type: 'url'` settings pointing at an image).
     */
    preview?: 'image';
}

/**
 * Inputs available when resolving a setting's *effective* default at runtime.
 * Kept deliberately tiny and serialisable so {@link SettingDefinition.dynamicDefault}
 * stays a pure function (no Node/FS imports) — `schema.ts` is bundled by the admin
 * UI. The server fills this in (e.g. from cgroup CPU detection) and passes it to
 * {@link getDefaultValues}; client callers omit it and get the static defaults.
 */
export interface DefaultResolutionContext {
    /** Effective CPU cores for this process (cgroup quota if capped, else host). */
    cpuCores: number;
}

/**
 * Default concurrency for the cpu-class task worker, sized to the effective CPU
 * budget: `floor(cores / 2)` clamped to 1–6 (2c→1, 4c→2, 8c→4, 16c→6). We scale
 * only this lever — not the per-process ffmpeg thread cap — because one cpu-class
 * job already fans ffmpeg across `LUMASTRA_FFMPEG_THREADS` cores, and scaling both
 * would multiply into quadratic CPU pressure. Pure function (no Node imports) so
 * it is safe in the admin bundle; the server passes the detected core count.
 */
export function cpuClassConcurrencyDefault(cpuCores: number): number {
    return Math.max(1, Math.min(6, Math.floor(cpuCores / 2)));
}

/**
 * Default server-wide cap on concurrent music transcodes, sized to the effective
 * CPU budget: `cores` clamped to 4–16 (2c→4, 8c→8, 16c→16, 48c→16). An audio
 * encode (opus/mp3) costs roughly an order of magnitude less than a video
 * transcode, so unlike the cpu-class lever we scale with cores directly rather
 * than halving. The floor of 4 matters more than the ceiling: Subsonic clients
 * bulk-download whole albums for offline use, and a cap of 1–2 makes a single
 * client throttle itself. Pure function (admin bundle safe); the server passes
 * the cgroup-detected core count.
 */
export function musicTranscodeConcurrencyDefault(cpuCores: number): number {
    return Math.max(4, Math.min(16, cpuCores));
}

/**
 * Default per-user cap on concurrent music transcodes: half the server-wide cap,
 * floored at 4. One client may take up to half the budget, leaving the rest for
 * everyone else — the point of the per-user lever — while still being high
 * enough that an offline sync isn't rejected on its own.
 */
export function musicTranscodePerUserDefault(cpuCores: number): number {
    return Math.max(4, Math.ceil(musicTranscodeConcurrencyDefault(cpuCores) / 2));
}

/**
 * Default server-wide cap on concurrent VIDEO transcode jobs, sized to the
 * effective CPU budget: `cores * 3` clamped to 12–32 (2c→12, 4c→12, 8c→24,
 * 16c→32, 48c→32). The previous default (bare `cores`, no floor above 2) let a
 * modest container — this box's cgroup quota reported 4 cores — cap out at 4
 * concurrent sessions; a household with a few devices watching (some paused,
 * some seeking) or a single sync-heavy client legitimately holds more than
 * that many play sessions open at once, and the global-cap LRU eviction (see
 * `ffmpeg-transcode.service.ts`'s `admitGlobalTranscodeSlot`) has no way to
 * tell a genuinely idle session from one that's still actively watching but
 * merely quiet on segment requests because it buffered ahead — prod
 * 2026-08-22 lost an actively-heartbeating session this way. `cores * 3`
 * (not `cores` directly, unlike the cpu-class lever) reflects that most
 * concurrent VOD sessions are cheap copy/remux passthroughs, not full CPU
 * transcodes — the same reasoning `musicTranscodeConcurrencyDefault` applies
 * for audio, just with a lower multiplier since a full transcode DOES cost a
 * real CPU-bound ffmpeg process. Pure function (admin bundle safe); the
 * server passes the cgroup-detected core count.
 */
export function videoTranscodeConcurrencyDefault(cpuCores: number): number {
    const cores = Number.isFinite(cpuCores) && cpuCores > 0 ? cpuCores : 4;
    return Math.max(12, Math.min(32, Math.round(cores * 3)));
}

/**
 * Default concurrency for the io-class task worker. Unlike the cpu class, io-class
 * work — file-library-scan, media-probe, chapter-sync, image-sync, watch-sync,
 * tmdb/mdblist metadata sync — is overwhelmingly I/O- and network-bound (the
 * per-task-queue redesign collapses the SDK `ingest`+`bulk` classes onto this
 * physical pool). It can therefore run several-fold more concurrently than
 * cpu-class jobs without saturating CPU, so we scale with the effective core
 * budget directly (not halved) but keep a sane floor (small installs still want a
 * few parallel io jobs so one long scan can't wedge the whole pool — the prod
 * incident that motivated this) and a ceiling (avoid hammering NFS or a single
 * upstream on big hosts). cores→default: ≤4→4, 8→8, ≥12→12. Pure function (admin
 * bundle safe); the server passes the cgroup-detected core count.
 */
export function ioClassConcurrencyDefault(cpuCores: number): number {
    // Guard against a NaN/fractional/non-positive core count from upstream
    // detection — fall back to the floor rather than propagating NaN into the
    // concurrency budget (which would disable the io pool).
    const cores = Number.isFinite(cpuCores) && cpuCores > 0 ? Math.floor(cpuCores) : 4;
    return Math.max(4, Math.min(12, cores));
}

/**
 * Default parallelism for the pipeline event-outbox drain, sized to the effective
 * CPU budget: `floor(cores / 2)` clamped to 1–4 (1–2c→1, 4c→2, 6c→3, ≥8c→4). Like
 * the cpu class it scales with cores (and is cgroup/Docker-`cpus:`-aware via the
 * caller's `getCpuBudgetCores`), so a small worker stays serial-ish and a big one
 * drains a scan burst in parallel. The ceiling is deliberately LOWER than the cpu
 * class (4, not 6): each drain worker checks out one connection from the shared
 * task pool (`LUMASTRA_DB_POOL_TASK_MAX`, default 7) for its per-row tx, so we cap
 * at 4 to always leave ≥3 connections for the task runner. Operators raising this
 * via `LUMASTRA_OUTBOX_DRAIN_CONCURRENCY` should raise the task pool to match.
 * Pure function (admin-bundle safe); the server passes the detected core count.
 */
export function outboxDrainConcurrencyDefault(cpuCores: number): number {
    const cores = Number.isFinite(cpuCores) && cpuCores > 0 ? Math.floor(cpuCores) : 2;
    return Math.max(1, Math.min(4, Math.floor(cores / 2)));
}

/**
 * Coerces a raw `array`-type setting value into a string list.
 *
 * The admin UI's array input (`ArrayInput.svelte`) always submits a single
 * COMMA-SEPARATED STRING (parsing happens only at config-read time via
 * `getConfig('array')` → `parseList`); programmatic/API callers may instead
 * pass a real `string[]`. This is the SINGLE shared coercion both
 * `validateSettingValue` (save-time validation) and the config-service
 * settings-save hook (added/removed diffing) use, so the two never diverge on
 * "what shape did the admin UI actually send".
 */
export function toList(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    if (typeof value === 'string') {
        return value
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
    }
    return [];
}

export interface SettingDefinition {
    key: string;
    type: SettingType;
    label: string;
    description: string;
    defaultValue: unknown;
    /**
     * Optional environment-derived default. When the server passes a
     * {@link DefaultResolutionContext} to {@link getDefaultValues}, this is used
     * instead of {@link SettingDefinition.defaultValue}. Must be a pure function
     * of `ctx` (no side effects, no Node imports) — it is part of the client
     * bundle. {@link SettingDefinition.defaultValue} remains the documented
     * baseline / fallback when no context is available.
     */
    dynamicDefault?: (ctx: DefaultResolutionContext) => unknown;
    section: string;
    validation?: ValidationRules;
    uiHints?: UiHints;
    requiresRestart?: boolean;
    // Dependency - setting only shows/applies when parent setting is truthy
    dependsOn?: string;
    // More complex condition
    showWhen?: {
        key: string;
        equals?: unknown;
        notEquals?: unknown;
    };
    // Dropdown/select options for 'string' type settings
    options?: Array<{ value: string; label: string; uiHints?: UiHints }>;
    /**
     * The value comes from the environment variable alone. ConfigService
     * ignores a settings.json value for this key (and logs that once), and
     * saveConfig refuses to change it, so the admin UI can only show it.
     * Unlike `uiHints.envOnly`, which only disables the input. Set both.
     */
    envOnlyEnforced?: true;
}

export interface SectionDefinition {
    id: string;
    label: string;
    description: string;
    icon?: string; // Hero icon name
    order: number;
    collapsedByDefault?: boolean;
    featureFlag?: string; // Primary toggle for this section (shown in header)
    helpText?: string; // Extended help/documentation shown when section is expanded
}

// Alias for backwards compatibility
export type ConfigSection = SectionDefinition;

// ============================================================================
// Section Definitions
// ============================================================================

export const configSections: SectionDefinition[] = [
    {
        id: 'branding',
        label: 'Branding',
        description: 'Application name, logos, and visual identity',
        icon: 'PaintBrush',
        order: 1,
        helpText: `Custom images via Docker

Mount your branding files to replace the defaults. Example:

volumes:
  - /path/to/favicon.png:/app/build/client/favicon.png:ro
  - /path/to/icon-192.png:/app/build/client/icon-192.png:ro
  - /path/to/icon-512.png:/app/build/client/icon-512.png:ro
  - /path/to/logo-icon.svg:/app/build/client/branding/lumastra-icon.svg:ro
  - /path/to/logo-full.svg:/app/build/client/branding/lumastra-logo-horizontal-ondark.svg:ro
  - /path/to/custom-images:/app/build/client/custom:ro

Files in /custom are accessible at /custom/filename.png. Use these paths in the URL fields below.`,
    },
    {
        id: 'metadata',
        label: 'Metadata sources',
        description: 'API keys and languages for TMDB and MDBList',
        icon: 'CircleStack',
        order: 2,
        helpText: `Keys for the metadata sources that fill titles, artwork, cast and ratings. The fallback order of these sources is set in **Metadata source order** above. API keys are never sent back to the browser: a stored key shows as **Stored**.`,
    },
    {
        id: 'conn-jellyfin',
        label: 'Jellyfin',
        description: 'Optional: watch-state sync and Jellyfin-app compatibility',
        icon: 'Server',
        order: 2.1,
        helpText: `Lumastra plays everything itself — Jellyfin is optional. Connect it to sync watch state both ways and show "Now Streaming"; turn on **Jellyfin Client Compatibility** to let Jellyfin apps (Swiftfin, Jellyfin for Android TV, …) connect to Lumastra directly — that needs no Jellyfin server. **Internal URL** is what the server uses (a local address is fine); **External URL** is the public link shown to users for "Open in…". API keys are never sent back to the browser: a stored key shows as **Stored**, and typing a new one replaces it.`,
    },
    {
        id: 'conn-audiobookshelf',
        label: 'Audiobookshelf',
        description: 'Audiobooks and listening progress',
        icon: 'BookOpen',
        order: 2.2,
        helpText: `Used by audiobook browsing and playback, listening-position sync and per-user Audiobookshelf accounts (Settings → AudiobookShelf). **Internal URL** is what the server uses (a local address is fine); **External URL** is the public link shown to users for "Open in…". API keys are never sent back to the browser: a stored key shows as **Stored**, and typing a new one replaces it.`,
    },
    {
        id: 'conn-kavita',
        label: 'Kavita',
        description: 'Books and manga',
        icon: 'BookOpen',
        order: 2.3,
        helpText: `Used by book and manga browsing. **Internal URL** is what the server uses (a local address is fine); **External URL** is the public link shown to users for "Open in…". API keys are never sent back to the browser: a stored key shows as **Stored**, and typing a new one replaces it.`,
    },
    {
        id: 'conn-sonarr',
        label: 'Sonarr',
        description: 'Series library and calendar manager',
        icon: 'Tv',
        order: 2.4,
        helpText: `Your series library manager. Lumastra reads it for the release calendar, missing-episode tracking, request progress, artwork fallbacks and Sonarr webhooks. **Internal URL** is what the server uses (a local address is fine); **External URL** is the public link shown to users for "Open in…". API keys are never sent back to the browser: a stored key shows as **Stored**, and typing a new one replaces it.`,
    },
    {
        id: 'conn-radarr',
        label: 'Radarr',
        description: 'Movie library and calendar manager',
        icon: 'Film',
        order: 2.5,
        helpText: `Your movie library manager. Lumastra reads it for the release calendar, request progress, artwork fallbacks and Radarr webhooks. **Internal URL** is what the server uses (a local address is fine); **External URL** is the public link shown to users for "Open in…". API keys are never sent back to the browser: a stored key shows as **Stored**, and typing a new one replaces it.`,
    },
    {
        id: 'conn-trakt',
        label: 'Trakt',
        description: 'Watch-history sync and Trakt ratings',
        icon: 'Link',
        order: 2.7,
        helpText: `The deployment's Trakt app. Each user then links their own Trakt account under Settings → Connections.`,
    },
    {
        id: 'conn-mal',
        label: 'MyAnimeList',
        description: 'Anime progress sync',
        icon: 'Link',
        order: 2.8,
        helpText: `The deployment's MyAnimeList app. Each user then links their own MAL account under Settings → Connections.`,
    },
    {
        id: 'features',
        label: 'Features',
        description: 'General optional functionality without a dedicated settings area',
        icon: 'Cog6Tooth',
        order: 3,
    },
    {
        id: 'localization',
        label: 'Language & Region',
        description: 'Locale override and date/time formatting defaults',
        icon: 'Language',
        order: 3.2,
    },
    {
        id: 'diagnostics',
        label: 'Diagnostics',
        description:
            'Update checks, client crash reports, log bundles, and developer-only admin tooling',
        icon: 'Bug',
        order: 3.4,
    },
    {
        id: 'requests',
        label: 'Seerr (media requests)',
        description: 'Request manager connection, request UX and who may request',
        icon: 'ClipboardDocumentList',
        order: 2.65,
        collapsedByDefault: true,
        helpText:
            'Connect the request manager where users ask the admin to add movies and shows that are not in the library yet. ' +
            'The internal URL and API key are used by Lumastra; the external URL is the public request link shown to users.',
    },
    {
        id: 'player',
        label: 'Player Settings',
        description: 'Video player behavior and quality settings',
        icon: 'PlayCircle',
        order: 4,
    },
    {
        id: 'streaming',
        label: 'Playback & Media Mode',
        description: 'Playback tracking and session monitoring',
        icon: 'Signal',
        order: 5,
        collapsedByDefault: true,
        helpText:
            'Configure playback session tracking and stream-token behavior. ' +
            'Live TV source/proxy settings live on the Live TV admin page.',
    },
    {
        // Split out of `services` (Providers page), where these settings sat
        // amid metadata/download-client provider connections despite governing
        // playback bandwidth and offline-download capacity — renders on the
        // Playback page instead, next to the other things that shape a stream.
        id: 'downloads',
        label: 'Downloads & Bandwidth',
        description:
            'Original-file downloads, per-stream/per-download speed limits, and offline download rendition capacity',
        icon: 'ArrowDownTray',
        order: 5.5,
        collapsedByDefault: true,
    },
    {
        id: 'livetv',
        label: 'Live TV',
        description: 'Live TV source, stream proxy, and viewer policy settings',
        icon: 'Tv',
        order: 6,
        collapsedByDefault: true,
        featureFlag: 'FEATURE_LIVETV',
    },
    {
        id: 'ffmpeg',
        label: 'Transcoding',
        description:
            'What gets transcoded and how it is delivered: codec policy, tonemapping, audio, subtitles, capacity limits, and HLS internals',
        icon: 'MusicalNote',
        order: 7,
        collapsedByDefault: true,
        get helpText() {
            return m.admin_hardware_transcoding_help();
        },
    },
    {
        id: 'ffmpeg-hardware',
        get label() {
            return m.admin_hardware_title();
        },
        get description() {
            return m.admin_hardware_description();
        },
        icon: 'Cog6Tooth',
        order: 7.5,
        collapsedByDefault: true,
        get helpText() {
            return m.admin_hardware_advanced_help();
        },
    },
    {
        // Renders on the Access page now — it governs WHO/WHAT may reach this
        // server via the token API surface, alongside the other "who may reach
        // this server" sections (groups/auth/social/network).
        id: 'deviceAuth',
        label: 'Public API & Device Auth',
        description:
            'Enables the /api/v1/* token API surface and OAuth 2.0 device authorization for TV apps and external clients. Required for AirPlay support.',
        icon: 'DevicePhoneMobile',
        order: 8,
        collapsedByDefault: true,
        featureFlag: 'FEATURE_DEVICE_AUTH',
    },
    {
        // Split out of `social` (Sharing & Privacy): these settings govern who/what
        // this server talks to over the network for delivery (the Lumastra push
        // relay, or the operator's own Apple signing key) — the same "who/what may
        // reach this server" question as `deviceAuth` above, not what users may see
        // about each other. Renders on the Access page, grouped with Public API
        // since push delivery also depends on the /api/v1 surface for device tokens.
        id: 'push',
        label: 'Push Notifications',
        description:
            'iOS push delivery: works out of the box via the Lumastra-operated relay, or bring your own Apple signing key',
        icon: 'BellAlert',
        order: 8.2,
        collapsedByDefault: true,
        featureFlag: 'FEATURE_PUSH_NOTIFICATIONS',
    },
    {
        // Split out of `features`, where it was 19 of that section's 26 settings and
        // the only cohesive feature in a section whose stated job is "functionality
        // without a dedicated settings area". Renders on the Media & images page —
        // it configures generated preview/cinemagraph artifacts, same as the other
        // sections there.
        id: 'topshelf',
        label: 'tvOS Top Shelf',
        description: 'Preview and cinemagraph artifacts for the tvOS Top Shelf carousel',
        icon: 'Tv',
        order: 8.5,
        collapsedByDefault: true,
        featureFlag: 'FEATURE_TOPSHELF_PREVIEWS',
    },
    {
        id: 'watchTogether',
        label: 'Watch Together',
        description: 'Synchronized watch party settings',
        icon: 'Users',
        order: 9,
        collapsedByDefault: true,
        featureFlag: 'FEATURE_WATCH_TOGETHER',
    },
    {
        id: 'foryou',
        label: 'For You / AI Recommendations (Embeddings)',
        description: 'Personalized recommendation algorithm tuning and embedding provider config',
        icon: 'Sparkles',
        order: 10,
        collapsedByDefault: true,
        featureFlag: 'FEATURE_AI_RECOMMENDATIONS',
        helpText:
            'For You blends catalog metadata, MDBList/IMDb signals, watch history, and optional embedding similarity. ' +
            'Metadata providers live on Provider Connection Settings; embedding providers are configured here.\n\n' +
            'Separate from the AI Assistant (Chat) below: different providers, different keys. The Embeddings/Voyage keys ' +
            "here do not configure the Assistant's keys, or vice versa.",
    },
    {
        id: 'ai-assistant',
        label: 'AI Assistant (Chat)',
        description: 'Chat assistant persona, limits, and its own provider/API key',
        icon: 'ChatBubbleLeftRight',
        order: 11,
        collapsedByDefault: true,
        featureFlag: 'FEATURE_AI_ASSISTANT',
        helpText:
            'The AI Assistant answers questions about your library, separate from AI Recommendations/embeddings above: ' +
            'different provider (OpenAI or Anthropic), different API key. Configuring one has no effect on the other.',
    },
    {
        id: 'groups',
        label: 'Permission Groups',
        description: 'Group-based access control',
        icon: 'UserGroup',
        order: 12,
        collapsedByDefault: true,
    },
    {
        id: 'social',
        label: 'Sharing & Privacy',
        description: 'What users may see about each other: activity, live sessions, reviews',
        icon: 'Eye',
        order: 12.5,
        collapsedByDefault: true,
        // Deliberately NO `featureFlag`. A section-level flag disables every setting
        // inside it (SettingSection.svelte: `disabled = !featureEnabled ? true : …`),
        // and FEATURE_SOCIAL governs only the activity/review surfaces — not session
        // visibility. Pinning it here would make FEATURE_SESSIONS_PUBLIC unreachable
        // for any operator who turned social features off, which is precisely the
        // operator most likely to be tightening session visibility.
        helpText:
            'These are sharing controls, not permissions: Permission Groups above governs ' +
            'what a user may ACCESS, this section governs what other users may SEE about them.\n\n' +
            'Every switch here sets the widest an audience can be. Users still control their ' +
            'own sharing, and a per-item hide always wins.\n\n' +
            'Settings that name groups draw on **Settings → Access Groups** (and any groups ' +
            'your identity provider sends). Create the group there first, then select it here.\n\n' +
            'Live-session visibility ("Public Sessions" and "Public Device Info") lives under ' +
            'Playback → Playback & Media Mode instead, since it depends on the Now Streaming ' +
            'widget toggle.',
    },
    {
        id: 'auth',
        label: 'Authentication',
        description: 'Built-in login, OIDC SSO, and auth provider selection',
        icon: 'LockClosed',
        order: 13,
        collapsedByDefault: true,
        helpText:
            'Choose how users sign in. Built-in login stores username/password accounts in Lumastra. ' +
            'OIDC sends users through an identity provider such as Authentik, Keycloak, Entra, or Okta. ' +
            'Reverse-proxy forward auth is configured outside Lumastra with USERHEADER/GROUPHEADER and can coexist, but choose one primary front door.',
    },
    {
        // Split out of `advanced` — these describe WHO may reach this server
        // over the network (CORS origins, the /metrics endpoint), so they
        // render on the Access page next to the other "who may reach this
        // server" sections instead of the general runtime-defaults grab bag.
        id: 'network',
        label: 'Network & Endpoints',
        description: 'CORS allowlist and the unauthenticated-by-default /metrics endpoint',
        icon: 'GlobeAlt',
        order: 13.5,
        collapsedByDefault: true,
    },
    {
        id: 'browse',
        label: 'Browse & Search',
        description: 'Browse page behavior and pagination',
        icon: 'MagnifyingGlass',
        order: 14,
        collapsedByDefault: true,
    },
    {
        id: 'homepage',
        label: 'Homepage Widgets',
        description: 'Homepage layout and widget settings',
        icon: 'Home',
        order: 15,
        collapsedByDefault: true,
    },
    {
        id: 'trending',
        label: 'Trending Widget',
        description: 'Configure MDBList dropdown groups and list names',
        icon: 'Fire',
        order: 16,
        collapsedByDefault: true,
        featureFlag: 'FEATURE_TRENDING',
        helpText: `**Configuration via JSON file only** (admin UI editor coming soon)

Configure these settings in your \`config/settings.json\` file:

\`\`\`json
{
  "TRENDING_DROPDOWN_GROUPS": {
    "groups": [
      { "id": "streaming", "label": "Streaming", "listIds": ["netflix-movies", "netflix-shows"] },
      { "id": "trending", "label": "Trending", "listIds": ["trending-movies", "popular-movies"] }
    ],
    "hiddenLists": ["box-office"]
  },
  "TRENDING_LIST_NAMES": {
    "netflix-movies": "🔴 Netflix Filme",
    "trending-movies": "🔥 Trending"
  }
}
\`\`\`

**TRENDING_DROPDOWN_GROUPS**: Define how lists are grouped in the dropdown and which lists to hide.
**TRENDING_LIST_NAMES**: Override display names for lists (include emoji for icon).`,
    },
    {
        id: 'hover',
        label: 'Media Hover Popup',
        description: 'Configure hover popup with trailers and video previews',
        icon: 'CursorArrowRays',
        order: 17,
        collapsedByDefault: false,
        helpText:
            'Control the Netflix-style hover popup that appears when hovering over media cards. Includes options for YouTube trailers and video previews.',
    },
    {
        id: 'sync',
        label: 'Background Sync',
        description: 'Automatic synchronization intervals',
        icon: 'ArrowPath',
        order: 18,
        collapsedByDefault: true,
    },
    {
        id: 'image',
        label: 'Image Optimization',
        description: 'Image caching and quality settings',
        icon: 'Photo',
        order: 19,
        collapsedByDefault: true,
    },
    {
        id: 'media',
        label: 'Media Storage',
        description: 'Where generated metadata (trickplay, artwork, lyrics) is stored on disk',
        icon: 'FolderOpen',
        order: 20,
        collapsedByDefault: true,
        helpText:
            'Controls where Lumastra writes persistent metadata files such as trickplay sprite sheets, custom artwork, and lyrics. ' +
            '"Central directory" keeps media folders clean but requires the config volume to have enough space. ' +
            '"Alongside media" stores files next to the video/audio so other tools (Jellyfin, Plex) can discover them, but requires write access to library paths.',
    },
    {
        // Label renamed from "Advanced" to "System" (id kept as `advanced` —
        // it is a persisted section id, not just UI text). Order moved from 21
        // to sit right after Diagnostics on the General page: Branding,
        // Features, Language & Region, Diagnostics, System, Licensing.
        id: 'advanced',
        label: 'System',
        description: 'Public URL, logging and runtime safety limits',
        icon: 'Wrench',
        order: 3.6,
        collapsedByDefault: true,
    },
    {
        id: 'navigation',
        label: 'Navigation',
        description: 'Configure sidebar, footer buttons, and user menu',
        icon: 'Bars3',
        order: 22,
        collapsedByDefault: true,
    },
    {
        id: 'enterprise',
        label: 'Enterprise & Showcase',
        description: 'Training, assessment, and public showcase feature flags',
        icon: 'AcademicCap',
        order: 23,
        collapsedByDefault: true,
    },
    {
        id: 'advanced-tasks',
        label: 'Advanced Tasks',
        description:
            'Turn background tasks on or off, and set how long old history and logs are kept',
        icon: 'Cog6Tooth',
        order: 24,
        collapsedByDefault: true,
        helpText:
            // These switches store a DISABLE_* key but render positively via
            // uiHints.invert, so ON means "running". This text used to describe
            // the pre-inversion UI and told the operator to turn a switch ON to
            // STOP a task — the exact opposite of what the panel now shows.
            'Every switch here reads the way it behaves: ON means the task runs, OFF stops it — both its ' +
            'scheduled runs and any you trigger by hand. Most are ON to begin with. Turning one off never ' +
            'deletes anything; it just stops that work happening until you turn it back on. ' +
            'The rest of this page controls how long Lumastra keeps old history, logs, ' +
            'and generated artwork before cleaning them up. ' +
            'Internal task-runner and queue-orchestrator internals (worker concurrency, lock durations, stall ' +
            'thresholds) live on the separate "Task Runner & Queue Tuning" panel — those can destabilise background ' +
            'processing if set wrong, so they are kept apart from these everyday on/off switches.',
    },
    {
        id: 'advanced-tasks-tuning',
        label: 'Task Runner & Queue Tuning',
        description:
            'Internal worker concurrency, queue, and orchestrator settings — not per-task switches',
        icon: 'AdjustmentsHorizontal',
        order: 24.5,
        collapsedByDefault: true,
        helpText:
            'These control the task runner and orchestrator machinery itself — worker concurrency, queue depth ' +
            'caps, lock durations, leader-election timeouts, and stall detection. They are NOT per-task on/off ' +
            'switches (those live on the "Advanced Tasks" panel). Getting one of these wrong can silently stall or ' +
            'wedge background processing in ways that are hard to diagnose, so only change them if you understand ' +
            'BullMQ and the task orchestrator internals. The defaults are tuned for typical deployments — most ' +
            'self-hosted installs never need to touch this panel.',
    },
    {
        id: 'licensing',
        label: 'Licensing',
        description:
            'Commercial license key for the licensed modules (the Jellyfin-compatible /j API and the AI assistant), and whether this server contacts lumastra.org',
        icon: 'Key',
        order: 25,
    },
    {
        id: 'music',
        label: 'Music',
        description: 'Music features, Music-First mode, and music playback tuning',
        icon: 'Beaker',
        order: 26,
        collapsedByDefault: false,
        helpText:
            '**Music** covers playback, lyrics, transcoding, queue tuning, and Music Alchemy.\n\n' +
            '**Music Alchemy** brews a ranked playlist from acoustic data once tracks are analysed; also requires ' +
            'Music Quick Picks Multi-Mode Taste Clustering.\n\n' +
            '**Music-First Mode** redirects `/` to `/music` and reorders the sidebar, independent of Alchemy.\n\n' +
            '**Instance Primary Mode** sets the content-mode axis: `vod` (default), `music`, or `mixed`.',
    },
];

// ============================================================================
// Setting Definitions
// ============================================================================

export const configSchema: SettingDefinition[] = [
    // =========================================================================
    // Branding
    // =========================================================================
    {
        key: 'APP_NAME',
        type: 'string',
        label: 'Application Name',
        description: 'Name shown in the UI header and browser title',
        defaultValue: 'Lumastra',
        section: 'branding',
        validation: { minLength: 1, maxLength: 50 },
    },
    {
        key: 'APP_DESCRIPTION',
        type: 'string',
        label: 'Application Description',
        description: 'Meta description for SEO and PWA',
        defaultValue: 'Media Dashboard',
        section: 'branding',
        validation: { maxLength: 200 },
    },
    {
        key: 'APP_THEME_COLOR',
        type: 'color',
        label: 'Theme Color',
        description:
            'Tints the installed PWA titlebar and the mobile browser address bar. Set to match your logo accent.',
        defaultValue: '#7c3aed',
        section: 'branding',
        uiHints: { placeholder: '#7c3aed' },
    },
    {
        key: 'APP_BACKGROUND_COLOR',
        type: 'color',
        label: 'PWA Splash Background Color',
        description: 'Background color of the PWA splash screen shown while the app boots.',
        defaultValue: '#0f172a',
        section: 'branding',
        uiHints: { placeholder: '#0f172a' },
    },
    {
        key: 'WEB_APP_INSTALL_HINT',
        type: 'boolean',
        label: 'Suggest the native app to iPhone and iPad users',
        description:
            'Shows a small, dismissible "Get the app" hint to visitors using Safari on iPhone or iPad, linking to the Lumastra app for iPhone, iPad and Apple TV. Only appears when this server is reached over HTTPS (the apps cannot connect over plain HTTP) and never inside the installed web app. Each browser that closes it does not see it again.',
        defaultValue: true,
        section: 'branding',
        requiresRestart: false,
    },
    {
        key: 'APP_LOGO_SMALL',
        type: 'url',
        label: 'Small Logo URL',
        description: 'Logo for navbar and icons (relative to /static/ or absolute URL)',
        defaultValue: '',
        section: 'branding',
        uiHints: { placeholder: 'Default logo', preview: 'image' },
    },
    {
        key: 'APP_LOGO_FULL',
        type: 'url',
        label: 'Full Logo URL',
        description: 'Full logo for splash screens',
        defaultValue: '',
        section: 'branding',
        uiHints: { placeholder: 'Default logo', preview: 'image' },
    },
    {
        key: 'APP_LOGO_PLAY',
        type: 'url',
        label: 'Play Button Logo',
        description: 'Logo shown on play buttons (optional)',
        defaultValue: '',
        section: 'branding',
        uiHints: { placeholder: 'Default play button', preview: 'image' },
    },
    {
        key: 'APP_BACKGROUND_IMAGE',
        type: 'url',
        label: 'Background Image',
        description:
            'Custom background image URL. Leave empty to use the bundled default wallpaper.',
        defaultValue: '',
        section: 'branding',
        uiHints: { placeholder: 'Default wallpaper', preview: 'image' },
    },
    {
        // Legal/compliance, not white-labeling: the app no longer ships the IMDb
        // logo (its owner restricts use). Left empty, the IMDb rating shows as a
        // plain "IMDb" text label. An operator who holds their own permission to
        // display the mark can mount a logo file and point this at it.
        key: 'RATING_LOGO_IMDB',
        type: 'url',
        label: 'IMDb Rating Logo',
        description:
            'Optional logo shown next to the IMDb rating instead of the "IMDb" text label. ' +
            'Leave empty unless you have permission to use the IMDb mark.',
        defaultValue: '',
        section: 'branding',
        uiHints: { placeholder: 'None — shows the “IMDb” text label', preview: 'image' },
    },
    {
        // Same rationale as RATING_LOGO_IMDB, for the Rotten Tomatoes mark(s)
        // used on the critic/audience score badges.
        key: 'RATING_LOGO_ROTTEN_TOMATOES',
        type: 'url',
        label: 'Rotten Tomatoes Rating Logo',
        description:
            'Optional logo shown next to Rotten Tomatoes ratings instead of the "RT" text label. ' +
            'Leave empty unless you have permission to use the Rotten Tomatoes mark.',
        defaultValue: '',
        section: 'branding',
        uiHints: { placeholder: 'None — shows the “RT” text label', preview: 'image' },
    },
    {
        // Active theme id served when a visitor has no theme cookie (or the
        // cookie names an unknown theme). Must be an enabled theme id
        // (built-in or a valid APPEARANCE_CUSTOM_THEMES entry); resolution
        // falls back to 'warp' if it isn't. The theme picker UI + SSR wiring
        // are handled outside the config layer; this key is the persisted
        // default. Hidden from the generic settings grid (dedicated picker).
        key: 'APPEARANCE_DEFAULT_THEME',
        type: 'string',
        label: 'Default Theme',
        description:
            "Theme id used for visitors without a saved theme preference (e.g. 'warp', 'marquee').",
        defaultValue: 'warp',
        section: 'branding',
        uiHints: { hidden: true },
    },
    {
        // Admin-defined custom themes: a JSON array of theme definitions
        // (id/name/accent/surfaceTint/starfield). Validated per-entry against
        // ThemeDefinitionSchema at read time; invalid entries are dropped with
        // a logged warning and customs may not override built-in ids. Stored as
        // a JSON array (navigation type). Managed by a dedicated theme editor
        // UI, so hidden from the generic settings grid.
        key: 'APPEARANCE_CUSTOM_THEMES',
        type: 'navigation',
        label: 'Custom Themes',
        description: 'Admin-defined custom themes (accent + surface tint seeds, starfield toggle).',
        defaultValue: [],
        section: 'branding',
        uiHints: { hidden: true },
    },
    {
        // Raw CSS injected into <head> of every page (right after the theme
        // tokens) as <style id="custom-css">. `</style` sequences are stripped
        // server-side so the stylesheet cannot structurally break the document;
        // NO other sanitization (deliberate admin-trust feature). Managed by a
        // dedicated appearance editor UI, so hidden from the generic grid.
        key: 'APPEARANCE_CUSTOM_CSS',
        type: 'string',
        label: 'Custom CSS',
        description:
            'Custom CSS injected into every page for every user. No sanitization beyond ' +
            'document-structure hardening: only paste styles you trust.',
        defaultValue: '',
        section: 'branding',
        uiHints: { hidden: true, multiline: true },
    },
    {
        // Raw JavaScript injected late in <body> of every page as
        // <script id="custom-js">. `</script` sequences are escaped to
        // `<\/script` server-side so the script cannot structurally break the
        // document; NO other sanitization. Managed by a dedicated appearance
        // editor UI, so hidden from the generic grid.
        key: 'APPEARANCE_CUSTOM_JS',
        type: 'string',
        label: 'Custom JavaScript',
        description:
            'WARNING: this JavaScript runs for EVERY user on EVERY page. It is persistent ' +
            'script injection with full access to user sessions and page content, with no ' +
            'sanitization: only paste code you fully trust and understand.',
        defaultValue: '',
        section: 'branding',
        uiHints: { hidden: true, multiline: true },
    },

    // =========================================================================
    // Service Connections
    // =========================================================================

    // Jellyfin
    {
        key: 'JELLYFINURL',
        type: 'url',
        label: 'Jellyfin Server URL',
        description: 'Internal URL for backend API calls (e.g., http://jellyfin:8096)',
        defaultValue: '',
        section: 'conn-jellyfin',
        uiHints: {
            placeholder: 'http://jellyfin:8096',
            healthCheckProvider: 'jellyfin',
        },
        // No restart needed: every process (web and worker) follows the change via
        // jellyfin/connection-lifecycle.ts — client rebuilt from the new value,
        // connection re-verified, sessions mirror restarted.
    },
    {
        key: 'PUBLIC_JELLYFINURL',
        type: 'url',
        label: 'Jellyfin External URL',
        description: 'Public URL for user-facing links. Set via ENV: PUBLIC_JELLYFINURL',
        defaultValue: '',
        section: 'conn-jellyfin',
        uiHints: { placeholder: 'https://jellyfin.example.com', envOnly: true },
    },
    {
        key: 'JELLYFINAPIKEY',
        type: 'string',
        label: 'Jellyfin API Key',
        description: 'API key for Jellyfin server authentication',
        defaultValue: '',
        section: 'conn-jellyfin',
        uiHints: {
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
        // No restart needed: every process (web and worker) follows the change via
        // jellyfin/connection-lifecycle.ts — client rebuilt from the new key,
        // connection re-verified, sessions mirror restarted.
    },

    // Audiobookshelf
    {
        key: 'AUDIOURL',
        type: 'url',
        label: 'Audiobookshelf Server URL',
        description: 'Internal URL for backend API calls',
        defaultValue: '',
        section: 'conn-audiobookshelf',
        uiHints: {
            placeholder: 'http://audiobookshelf:80',
            healthCheckProvider: 'audiobookshelf',
        },
    },
    {
        key: 'AUDIOBOOK_REMUX_MAX_PER_USER',
        type: 'number',
        label: 'Audiobook Remux Max Streams Per Listener',
        description:
            'Concurrent audiobook remuxes one listener may hold on a replica. Chromium cannot decode the E-AC-3 audio in some .m4b files, so Lumastra re-encodes to AAC on the fly, and scrubbing can trigger several remuxes at once. 0 removes the cap.',
        defaultValue: 2,
        section: 'conn-audiobookshelf',
        validation: { min: 0, max: 16 },
        uiHints: { advanced: true },
        dependsOn: 'FEATURE_AUDIOBOOKS',
    },
    {
        key: 'AUDIOBOOK_AUTO_CREATE_USERS',
        type: 'boolean',
        label: 'Create AudiobookShelf Accounts Automatically',
        description:
            'When a listener opens an audiobook and has no AudiobookShelf account, create one for them. Without this they cannot play anything — every audiobook is refused with "This account has no AudiobookShelf link". The account is created on first play only, gets access to all libraries, and is driven by an API key rather than a password. Turn off if your AudiobookShelf server is shared with something else or its accounts are managed elsewhere.',
        defaultValue: true,
        section: 'conn-audiobookshelf',
        uiHints: { advanced: true },
        dependsOn: 'FEATURE_AUDIOBOOKS',
    },
    {
        key: 'PUBLIC_AUDIOBOOKURL',
        type: 'url',
        label: 'Audiobookshelf External URL',
        description: 'Public URL for user-facing links. Set via ENV: PUBLIC_AUDIOBOOKURL',
        defaultValue: '',
        section: 'conn-audiobookshelf',
        uiHints: {
            placeholder: 'https://audiobooks.example.com',
            envOnly: true,
        },
    },
    {
        key: 'AUDIOAPIKEY',
        type: 'string',
        label: 'Audiobookshelf API Key',
        description: 'API key for Audiobookshelf authentication',
        defaultValue: '',
        section: 'conn-audiobookshelf',
        uiHints: {
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
    },

    // Kavita
    {
        key: 'KAVITAURL',
        type: 'url',
        label: 'Kavita Server URL',
        description: 'Internal URL for backend API calls',
        defaultValue: '',
        section: 'conn-kavita',
        uiHints: {
            placeholder: 'http://kavita:5000',
            healthCheckProvider: 'kavita',
        },
    },
    {
        key: 'PUBLIC_KAVITAURL',
        type: 'url',
        label: 'Kavita External URL',
        description: 'Public URL for user-facing links. Set via ENV: PUBLIC_KAVITAURL',
        defaultValue: '',
        section: 'conn-kavita',
        uiHints: { placeholder: 'https://kavita.example.com', envOnly: true },
    },
    {
        key: 'KAVITAAPIKEY',
        type: 'string',
        label: 'Kavita API Key',
        description: 'API key for Kavita authentication',
        defaultValue: '',
        section: 'conn-kavita',
        uiHints: {
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
    },

    // =========================================================================
    // Metadata Provider API Keys
    // =========================================================================
    {
        key: 'TMDB_API_KEY',
        type: 'string',
        label: 'TMDB API Key',
        description:
            'The Movie Database credential (metadata, images, search): the v3 API Key or the v4 API Read Access Token',
        defaultValue: '',
        section: 'metadata',
        uiHints: {
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
    },
    {
        key: 'TMDB_LANGUAGE',
        type: 'string',
        validation: { languageTag: true },
        label: 'TMDB Metadata Language',
        description:
            'Default BCP 47 language tag TMDB returns titles, overviews and artwork in (e.g. en-US, de-DE, fr-FR). Per-library Language settings override this. Applies to metadata fetched from then on.',
        defaultValue: 'en-US',
        section: 'metadata',
        uiHints: {
            placeholder: 'en-US',
        },
    },
    {
        key: 'AGE_RATING_COUNTRY',
        type: 'select',
        label: 'Age Rating Country',
        description:
            'Whose age ratings decide the minimum age of a title for age-limited users: FSK (Germany), MPAA / TV ratings (United States), BBFC (United Kingdom) and so on. "Automatic" follows the TMDB Metadata Language (de-DE uses FSK, en-US uses MPAA, en-GB uses BBFC) and falls back to the United States. This rating wins over the MDBList age rating, which only fills titles without one. Applies to metadata fetched from then on; the age-rating backfill re-derives existing titles.',
        defaultValue: 'auto',
        section: 'metadata',
        validation: {
            options: [
                { value: 'auto', label: 'Automatic (from metadata language)' },
                { value: 'US', label: 'United States (MPAA / TV Parental Guidelines)' },
                { value: 'DE', label: 'Germany (FSK)' },
                { value: 'GB', label: 'United Kingdom (BBFC)' },
                { value: 'AU', label: 'Australia (ACB)' },
                { value: 'NL', label: 'Netherlands (Kijkwijzer)' },
                { value: 'FR', label: 'France (CNC)' },
                { value: 'ES', label: 'Spain (ICAA)' },
            ],
        },
    },
    {
        key: 'METADATA_ADDITIONAL_LANGUAGES',
        type: 'array',
        label: 'Additional Metadata Languages',
        description:
            'Extra languages (max 3) to store movie/series titles and descriptions in, fetched from TMDB; users can then pick one for display. BCP-47 codes, comma-separated (e.g. "de, pt-BR"). Adding a language triggers a background backfill.',
        defaultValue: [],
        section: 'metadata',
        validation: { maxItems: 3, languageTags: true },
    },
    {
        key: 'MDBLIST_API_KEY',
        type: 'string',
        label: 'MDBList API Key',
        description:
            'API key for MDBList (aggregated ratings: IMDB, Letterboxd, Metacritic, RT, Trakt, MAL)',
        defaultValue: '',
        section: 'metadata',
        uiHints: {
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
    },
    {
        // Nothing fetches from OMDb (IMDb ratings come through MDBList), so
        // the key does nothing. Hidden rather than removed: existing
        // settings.json files and environments that still set it keep loading.
        key: 'OMDB_API_KEY',
        type: 'string',
        label: 'OMDB API Key',
        description:
            'Not used. Lumastra does not fetch from OMDb; IMDb ratings come through MDBList.',
        defaultValue: '',
        section: 'metadata',
        uiHints: {
            hidden: true,
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
    },
    {
        key: 'LICENSE_SERVER_CONTACT_ENABLED',
        type: 'boolean',
        label: 'Contact lumastra.org for the licence',
        description:
            'Lets this server fetch and renew its licence key, check in once a week, and get the token for iPhone and Apple TV push notifications through the standard relay. Off: this server never contacts lumastra.org and runs on the free tier right away, with no 30 day trial period. You lose: Jellyfin apps are limited to 2 streams at a time, no AI assistant, no iPhone or Apple TV push notifications through the standard relay, and no branding removal. A licence key that is already stored keeps working until it expires, but it is not renewed.',
        defaultValue: true,
        section: 'licensing',
        requiresRestart: false,
    },
    {
        key: 'LICENSE_CHECK_IN_ENABLED',
        type: 'boolean',
        label: 'Weekly licence check-in (contacts lumastra.org once a week)',
        description:
            'About once a week, send the install ID, the Lumastra version and the licence status code to lumastra.org, so the project can count running installs. lumastra.org keeps only pseudonymised counts, which hold no IP address. Turning it off stops only this weekly call: licence renewal, and the push relay token while iOS notifications use the standard relay, still contact lumastra.org when they need to. With "Contact lumastra.org for the licence" off there is no check-in either.',
        defaultValue: true,
        section: 'licensing',
        dependsOn: 'LICENSE_SERVER_CONTACT_ENABLED',
        requiresRestart: false,
    },
    {
        key: 'TRAKT_CLIENT_ID',
        type: 'string',
        label: 'Trakt Client ID',
        description:
            "Client ID for the deployment's Trakt app (create one at trakt.tv/oauth/applications). Used for per-user watch-history sync: users link their own Trakt account through this app. Set the app's Redirect URI to exactly {PUBLIC_BASE_URL}/api/integrations/trakt/callback; a stale value breaks linking after the user approves on Trakt.",
        defaultValue: '',
        section: 'conn-trakt',
        uiHints: { placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    },
    {
        key: 'TRAKT_CLIENT_SECRET',
        type: 'string',
        label: 'Trakt Client Secret',
        description: 'Client secret for Trakt API',
        defaultValue: '',
        section: 'conn-trakt',
        uiHints: {
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
    },
    {
        key: 'MAL_CLIENT_ID',
        type: 'string',
        label: 'MyAnimeList Client ID',
        get description() {
            return m.connections_mal_client_description();
        },
        defaultValue: '',
        section: 'conn-mal',
        uiHints: { placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx' },
    },
    {
        key: 'MAL_CLIENT_SECRET',
        type: 'string',
        label: 'MyAnimeList Client Secret',
        description: 'Client secret paired with MAL_CLIENT_ID',
        defaultValue: '',
        section: 'conn-mal',
        uiHints: {
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
    },
    {
        key: 'OPENAI_API_KEY',
        type: 'string',
        label: 'OpenAI Embeddings API Key',
        description: 'API key for OpenAI embeddings (AI recommendations)',
        defaultValue: '',
        section: 'foryou',
        uiHints: { sensitive: true, placeholder: 'sk-...' },
    },
    {
        key: 'OPENAI_CHAT_API_KEY',
        type: 'string',
        label: 'OpenAI Chat API Key',
        description:
            'API key for OpenAI chat completions (AI assistant). Separate from OPENAI_API_KEY (embeddings); no fallback.',
        defaultValue: '',
        section: 'ai-assistant',
        uiHints: { sensitive: true, placeholder: 'sk-...' },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ANTHROPIC_API_KEY',
        type: 'string',
        label: 'Anthropic API Key',
        description:
            'API key for Anthropic Claude (alternative AI assistant chat backend, native Messages API with thinking)',
        defaultValue: '',
        section: 'ai-assistant',
        uiHints: { sensitive: true, placeholder: 'sk-ant-...' },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'VOYAGE_API_KEY',
        type: 'string',
        label: 'Voyage AI Embeddings API Key',
        description: 'API key for Voyage AI (default embedding provider for AI recommendations)',
        defaultValue: '',
        section: 'foryou',
        uiHints: { sensitive: true, placeholder: 'pa-...' },
    },
    {
        key: 'EMBEDDING_API_KEY',
        type: 'string',
        label: 'Custom Embedding API Key',
        description:
            'API key for the custom embedding endpoint. Separate from OpenAI embedding and assistant chat keys.',
        defaultValue: '',
        section: 'foryou',
        uiHints: { sensitive: true },
    },
    {
        key: 'METADATA_PROVIDERS',
        type: 'string',
        label: 'Metadata Providers',
        description:
            'Metadata sources in fallback order, comma-separated (tmdb, mdblist). Edited on the Providers page as "Metadata source order"; applies without a restart.',
        defaultValue: 'tmdb,mdblist',
        section: 'metadata',
        uiHints: { placeholder: 'tmdb,mdblist', advanced: true },
    },
    {
        key: 'PRIMARY_IMAGE_PROVIDER',
        type: 'string',
        label: 'Primary Image Provider',
        description:
            'Override which provider supplies images (empty = first capable provider in list)',
        defaultValue: '',
        section: 'metadata',
        uiHints: { placeholder: 'tmdb', advanced: true },
    },
    {
        key: 'PRIMARY_SEARCH_PROVIDER',
        type: 'string',
        label: 'Primary Search Provider',
        description:
            'Override which provider handles search (empty = first capable provider in list)',
        defaultValue: '',
        section: 'metadata',
        uiHints: { placeholder: 'tmdb', advanced: true },
    },

    // Sonarr
    {
        key: 'SONARRURL',
        type: 'url',
        label: 'Sonarr Server URL',
        description: 'Internal URL for backend API calls',
        defaultValue: '',
        section: 'conn-sonarr',
        uiHints: {
            placeholder: 'http://sonarr:8989',
            healthCheckProvider: 'sonarr',
        },
    },
    {
        key: 'SONARRAPIKEY',
        type: 'string',
        label: 'Sonarr API Key',
        description: 'API key for Sonarr authentication',
        defaultValue: '',
        section: 'conn-sonarr',
        uiHints: {
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
    },

    // Radarr
    {
        key: 'RADARRURL',
        type: 'url',
        label: 'Radarr Server URL',
        description: 'Internal URL for backend API calls',
        defaultValue: '',
        section: 'conn-radarr',
        uiHints: {
            placeholder: 'http://radarr:7878',
            healthCheckProvider: 'radarr',
        },
    },
    {
        key: 'RADARRAPIKEY',
        type: 'string',
        label: 'Radarr API Key',
        description: 'API key for Radarr authentication',
        defaultValue: '',
        section: 'conn-radarr',
        uiHints: {
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
    },

    // Seerr (formerly Jellyseerr); the old key names are still read, see RENAMED_KEYS in config.service.ts
    {
        key: 'SEERRURL',
        type: 'url',
        label: 'Seerr Server URL',
        description: 'Internal URL for backend API calls',
        defaultValue: '',
        section: 'requests',
        uiHints: {
            placeholder: 'http://seerr:5055',
            healthCheckProvider: 'jellyseerr',
        },
    },
    {
        key: 'PUBLIC_REQUESTURL',
        type: 'url',
        label: 'Seerr External URL',
        description: 'Public URL for request links. Set via ENV: PUBLIC_REQUESTURL',
        defaultValue: '',
        section: 'requests',
        uiHints: { placeholder: 'https://request.example.com', envOnly: true },
    },
    {
        key: 'SEERRAPIKEY',
        type: 'string',
        label: 'Seerr API Key',
        description: 'API key for Seerr authentication',
        defaultValue: '',
        section: 'requests',
        uiHints: {
            sensitive: true,
            placeholder: 'xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx',
        },
    },

    // =========================================================================
    // Features - Main Toggles
    // =========================================================================
    {
        key: 'FEATURE_AI_RECOMMENDATIONS',
        type: 'boolean',
        label: 'AI Recommendations',
        description: 'Enable AI-powered personalized recommendations (requires API keys)',
        defaultValue: true,
        section: 'foryou',
    },
    {
        key: 'CONTINUE_WATCHING_MIN_SECONDS',
        type: 'number',
        label: 'Continue Watching: Minimum Seconds',
        description:
            'An item appears in Continue Watching only when BOTH this AND the minimum percent threshold are met. Set to 0 to disable the seconds check.',
        defaultValue: 30,
        section: 'foryou',
        validation: {
            min: 0,
            max: 600,
        },
        uiHints: { advanced: true },
    },
    {
        key: 'CONTINUE_WATCHING_MIN_PERCENT',
        type: 'number',
        label: 'Continue Watching: Minimum Percent',
        description:
            'Minimum percentage of runtime watched (0-100). Both this AND the minimum seconds must be met. Items without known runtime skip this check. Set to 0 to disable.',
        defaultValue: 10,
        section: 'foryou',
        validation: {
            min: 0,
            max: 50,
        },
        uiHints: { advanced: true },
    },
    {
        key: 'CONTINUE_WATCHING_MAX_AGE_DAYS',
        type: 'number',
        label: 'Continue Watching: Maximum Age (days)',
        description:
            'Hide items from Continue Watching that have not been touched for this many days; the resume position is preserved, so playing the title again still resumes correctly. Set to 0 to disable the cutoff.',
        defaultValue: 180,
        section: 'foryou',
        validation: {
            min: 0,
            max: 3650,
        },
        uiHints: { advanced: true },
    },
    {
        key: 'NEXT_UP_MAX_AGE_DAYS',
        type: 'number',
        label: 'Next Up: Maximum Age (days)',
        description:
            'Hide "next episode" suggestions when no episode of that series has been watched for this many days. Shorter by default than the Continue Watching cutoff (60 vs 180). Set to 0 to disable the cutoff.',
        defaultValue: 60,
        section: 'foryou',
        validation: {
            min: 0,
            max: 3650,
        },
        uiHints: { advanced: true },
    },
    {
        key: 'CONTINUE_WATCHING_SUBSTANTIAL_PERCENT',
        type: 'number',
        label: 'Continue Watching: Substantial-Progress Percent',
        description:
            'Progress percent above which an in-progress Continue Watching episode counts as substantial enough to beat a Next Up candidate. Below it, ahead-of-sequence items are treated as phantom scrubs.',
        defaultValue: 20,
        section: 'foryou',
        validation: {
            min: 0,
            max: 100,
        },
        uiHints: { advanced: true },
    },
    {
        key: 'EPISODE_PROGRESS_BAR_THRESHOLD',
        type: 'number',
        label: 'Episode Progress Bar Threshold (%)',
        description:
            'Percent below which a partially watched episode shows a progress bar instead of just a checkmark. 90 = recommended. 100 = always show the bar for any in-progress episode.',
        defaultValue: 90,
        section: 'foryou',
        validation: { min: 0, max: 100 },
        uiHints: { suffix: '%' },
    },
    {
        key: 'CONTINUE_WATCHING_PHANTOM_STALENESS_DAYS',
        type: 'number',
        label: 'Continue Watching: Phantom Staleness Window (days)',
        description:
            'How many days a low-progress, ahead-of-sequence Continue Watching item may outrank Next Up before it is treated as a stale phantom play.',
        defaultValue: 3,
        section: 'foryou',
        validation: {
            min: 0,
            max: 365,
        },
        uiHints: { advanced: true },
    },
    {
        key: 'FEATURE_AI_ASSISTANT',
        type: 'boolean',
        label: 'AI Assistant',
        description: 'Enable RAG-powered AI assistant for movie recommendations',
        defaultValue: true,
        section: 'ai-assistant',
    },
    {
        key: 'FEATURE_ASSISTANT_TOOLS',
        type: 'boolean',
        label: 'Assistant Tool-Calling',
        description:
            'Let the assistant choose typed, access-scoped tools (agentic RAG) instead of single-shot retrieval. Automatically falls back to single-shot for chat models that do not support tool-calling.',
        defaultValue: true,
        section: 'ai-assistant',
    },
    {
        key: 'ASSISTANT_TOOLS_FORCE',
        type: 'boolean',
        label: 'Force Assistant Tool-Calling',
        description:
            'Force tool-calling on even when the configured chat model name is not recognised as tool-capable. Only enable for custom OpenAI-compatible endpoints you know support function calling.',
        defaultValue: false,
        section: 'ai-assistant',
        uiHints: { advanced: true },
    },
    {
        key: 'FEATURE_ASSISTANT_WRITES',
        type: 'boolean',
        label: 'Assistant Write Actions',
        description:
            'Let the assistant CHANGE a user’s own data on request: add to or remove from their watchlist, set or clear a rating, mark a title watched or unwatched, and submit a media request (only for users who already have request permission). It only ever acts on the caller’s own data, and only when they ask. Off by default.',
        defaultValue: false,
        section: 'ai-assistant',
        dependsOn: 'FEATURE_ASSISTANT_TOOLS',
    },
    {
        key: 'FEATURE_ASSISTANT_SHARED_HISTORY',
        type: 'boolean',
        label: 'Shared Watch History in Assistant',
        description:
            'Allow the assistant to use another user’s watch history for joint recommendations. Visibility follows the Activity Audience settings under Social, which are OPT-OUT: with the default “Automatic” mode and no Activity Audience Groups named, every user on this server is in the audience and only someone who has hidden their streams is excluded. Name Activity Audience Groups first if you want a narrower circle. Off by default.',
        defaultValue: false,
        section: 'ai-assistant',
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_SHARED_HISTORY_GROUPS',
        type: 'array',
        label: 'Shared Watch History Groups',
        description:
            'Only members of these groups may ask the assistant about consented household watch history. Empty means nobody may use it.',
        defaultValue: '',
        section: 'ai-assistant',
        dependsOn: 'FEATURE_ASSISTANT_SHARED_HISTORY',
        uiHints: { placeholder: 'household,admin', groups: true },
    },
    {
        key: 'FEATURE_ASSISTANT_INCLUDE_REQUESTABLE',
        type: 'boolean',
        label: 'Show Requestable Titles in Assistant Recommendations',
        description:
            "Include requestable (not-yet-in-library, Jellyseerr) titles in the assistant's recommended cards. Off by default: cards show only titles available to watch now.",
        defaultValue: false,
        section: 'ai-assistant',
    },
    {
        key: 'FEATURE_LIVETV',
        type: 'boolean',
        label: 'Live TV',
        description:
            'Enable the Live TV section (standalone M3U/XMLTV sources plus the stream proxy). Off by default; needs a stream-proxy container and IPTV sources.',
        defaultValue: false,
        section: 'livetv',
    },
    {
        key: 'FEATURE_AUDIOBOOKS',
        type: 'boolean',
        label: 'Audiobooks',
        description: 'Enable Audiobookshelf integration',
        defaultValue: true,
        section: 'conn-audiobookshelf',
    },
    {
        key: 'FEATURE_KAVITA',
        type: 'boolean',
        label: 'Books/Manga (Kavita)',
        description: 'Enable Kavita book/manga integration',
        defaultValue: true,
        section: 'conn-kavita',
    },
    {
        key: 'FEATURE_CALENDAR',
        type: 'boolean',
        label: 'Release Calendar',
        description: 'Enable TV/movie release calendar (requires Sonarr/Radarr)',
        defaultValue: true,
        section: 'homepage',
    },
    {
        key: 'FEATURE_SESSIONS',
        type: 'boolean',
        label: 'Now Streaming Widget',
        description:
            'Show active streaming sessions on the homepage. ' +
            'Shows locally tracked active streaming sessions.',
        defaultValue: true,
        section: 'streaming',
    },
    {
        key: 'FEATURE_WATCH_TOGETHER',
        type: 'boolean',
        label: 'Watch Together',
        description: 'Enable synchronized watch parties',
        defaultValue: true,
        section: 'watchTogether',
    },
    {
        key: 'FEATURE_SIDEBAR',
        type: 'boolean',
        label: 'Sidebar Navigation',
        description: 'Show sidebar with external service links',
        defaultValue: true,
        section: 'navigation',
    },
    {
        key: 'FEATURE_SOCIAL',
        type: 'boolean',
        label: 'Social Features',
        description: 'Show who watched/rated content in modals',
        defaultValue: true,
        section: 'social',
    },
    {
        // Ships OFF. These twelve /api/v1 endpoints previously had no flag at
        // all, so an operator could not disable them without a code change —
        // and they carry no moderation, no report path, no edit and no content
        // filtering. See config.ts's FEATURE_COMMENTS getter for why off is the
        // right default (zero usage on a real 41-user instance, no first-party
        // UI consumer to break).
        key: 'FEATURE_COMMENTS',
        type: 'boolean',
        label: 'Comments & Reactions',
        description:
            'Let users post comments and emoji reactions on media, playlists and people. ' +
            'There is no moderation queue, reporting or editing — a comment can only be ' +
            'removed by its author or an admin. Leave off unless your users know each other.',
        defaultValue: false,
        section: 'social',
    },
    {
        key: 'FEATURE_SOCIAL_REVIEWS',
        type: 'boolean',
        label: 'Community Reviews',
        description:
            "Allow users to write and read short reviews in the Friends' Watch Activity section",
        defaultValue: true,
        section: 'social',
        dependsOn: 'FEATURE_SOCIAL',
    },
    {
        key: 'SOCIAL_REVIEW_GROUPS',
        type: 'array',
        label: 'Review Groups',
        description:
            'Groups that can create and edit community reviews in media modals (empty = all users allowed)',
        defaultValue: '',
        section: 'social',
        dependsOn: 'FEATURE_SOCIAL_REVIEWS',
        uiHints: { placeholder: 'reviewers,admin', groups: true },
    },
    {
        key: 'DEFAULT_ACTIVITY_SHARING',
        type: 'boolean',
        label: 'Default activity sharing for new accounts',
        description:
            'On by default. Shares watching, listening and rating activity with the configured audience. Users can change this under Settings → Privacy.',
        defaultValue: true,
        section: 'social',
        requiresRestart: false,
    },
    {
        key: 'SOCIAL_DEFAULT_AUDIENCE',
        type: 'select',
        // Named "Activity", not "Listening": this audience governs the Community
        // tab on movies and series as well as audiobook activity. It was
        // audiobook-only until movies/series were routed through the same
        // predicate, and a label that still said "Listening" would understate what
        // narrowing it does.
        label: 'Activity Audience Mode',
        description:
            'Who may see each other’s activity (audiobook progress, and who watched or rated a title). "Household" means every user on this server, the right choice for a family or small group with no setup. "Selected groups" restricts it to the groups named below. "Automatic" uses Household until any groups are named, then switches to Selected groups.',
        // 'auto' rather than a dynamic default, because `dynamicDefault` receives only
        // the CPU budget and cannot read another setting. Resolution therefore happens
        // at read time in `resolveSocialAudienceMode()`.
        //
        // Why 'auto' is the default: a fresh install has no groups, so it gets the
        // one-switch Household behaviour this whole change exists to provide. An
        // install that already NAMED groups made a deliberate narrowing decision, and
        // silently widening it on upgrade is the failure this setting must not cause —
        // verified concretely: on the production instance only 4 of 43 users are in the
        // configured circle, and all 43 have sharing switches left at their defaults,
        // so a blanket Household default would have widened the audience to 34 people
        // who never made a privacy choice.
        defaultValue: 'auto',
        section: 'social',
        dependsOn: 'FEATURE_SOCIAL',
        validation: {
            options: [
                { value: 'auto', label: 'Automatic (recommended)' },
                { value: 'household', label: 'Household (everyone on this server)' },
                { value: 'groups', label: 'Selected groups only' },
            ],
        },
    },
    {
        key: 'SOCIAL_TRUST_GROUPS',
        type: 'array',
        // NOT "circle" — that word is reserved for the deferred user-managed audiences
        // in docs/architecture/social-sharing.md. This is an admin-drawn audience over
        // existing groups; naming both "circle" makes them indistinguishable the day
        // circles ship.
        label: 'Activity Audience Groups',
        description:
            'Groups whose members may see each other’s activity (audiobook progress and chapter, and who watched or rated a title). Two users see each other only if they share a group named here; separate groups stay separate, so "family, bookclub" creates two audiences that cannot see each other. Manage the groups under Access Groups. Leave empty to keep activity private for everyone: unlike other group settings, empty means OFF here, not "everyone".',
        defaultValue: '',
        section: 'social',
        dependsOn: 'FEATURE_SOCIAL',
        uiHints: { placeholder: 'household', groups: true },
    },
    {
        // Lives in `social` (Sharing & Privacy), not `features`: the question it
        // answers is "may data about what a user watches leave this instance to an
        // endpoint the user chose", which is the same class of decision as the rest
        // of this section — the widest an audience may be. It is also the section an
        // operator tightening egress will actually look in.
        //
        // Deliberately NO `dependsOn`. It has no parent in this section, and a
        // cross-section parent is impossible (isSettingEnabled only sees values from
        // the sections the current page loaded — see docs/architecture/social-sharing.md).
        key: 'FEATURE_USER_NOTIFICATION_WEBHOOKS',
        type: 'boolean',
        label: 'Per-User Notification Webhooks',
        description:
            'Let each user register one outbound webhook URL (ntfy, Gotify, Discord, Home Assistant) for new-episode and request-available notifications. OFF by default: a user-supplied URL makes this server issue outbound requests to addresses users choose. Private, loopback, link-local, and cloud-metadata targets are rejected at save and at every delivery. Turning it off stops delivery immediately; saved URLs are kept.',
        defaultValue: false,
        section: 'social',
        requiresRestart: false,
    },
    {
        key: 'FEATURE_PUSH_NOTIFICATIONS',
        type: 'boolean',
        label: 'Push Notifications (iOS)',
        description:
            'Send new-episode and request-available notifications to the Lumastra iOS app as push notifications, in addition to the in-app inbox. Works out of the box: delivery goes through the Lumastra push relay (which holds the Apple signing key), authenticated with a short-lived token this server renews automatically with its licence refresh. Notification text is rendered on this server and the relay receives only a generic banner plus the device tokens of users who enabled notifications in the app. Turning it off stops delivery immediately and retires anything already queued.',
        defaultValue: true,
        section: 'push',
        requiresRestart: false,
    },
    {
        key: 'PUSH_RELAY_URL',
        type: 'string',
        label: 'Push Relay URL',
        description:
            'Base URL of the push relay. The default relay (push.lumastra.org) is operated by the Lumastra maintainer and receives the device tokens of your users plus a content-free banner — see https://lumastra.org/reference/data-flows/ for exactly what is sent. Leave as the default unless you run your own relay against your own Apple signing key and your own build of the iOS app.',
        defaultValue: 'https://push.lumastra.org',
        section: 'push',
        requiresRestart: false,
    },
    {
        key: 'PUSH_RELAY_TOKEN',
        type: 'string',
        label: 'Push Relay Token',
        description:
            'Leave empty for the default relay: this server obtains a short-lived relay token automatically and renews it every few hours. Set this only if you run your own relay (Push Relay URL) — then enter whatever bearer that relay expects; it always takes precedence over the automatic token.',
        defaultValue: '',
        section: 'push',
        uiHints: { sensitive: true, advanced: true },
        requiresRestart: false,
    },
    {
        key: 'PUSH_TRANSPORT',
        type: 'select',
        label: 'Push Delivery Route',
        description:
            'How push notifications reach Apple. "Automatic" uses your own Apple signing key when one is configured below and the push relay otherwise — the right answer unless you have configured both. Pick a route explicitly only when both are set up and you want to choose between them.',
        defaultValue: 'auto',
        options: [
            { value: 'auto', label: 'Automatic' },
            { value: 'direct', label: 'Direct to Apple (own signing key)' },
            { value: 'relay', label: 'Push relay' },
        ],
        section: 'push',
        uiHints: { advanced: true },
    },
    {
        key: 'APNS_KEY_P8',
        type: 'string',
        label: 'Apple Signing Key (.p8)',
        get description() {
            return m.config_apns_key_p8_description();
        },
        defaultValue: '',
        section: 'push',
        uiHints: {
            advanced: true,
            sensitive: true,
            multiline: true,
            rows: 4,
            placeholder: '-----BEGIN PRIVATE KEY-----',
        },
    },
    {
        key: 'APNS_KEY_P8_PATH',
        type: 'string',
        label: 'Apple Signing Key Path',
        get description() {
            return m.config_apns_key_p8_path_description();
        },
        defaultValue: '',
        section: 'push',
        uiHints: { advanced: true, placeholder: '/run/secrets/apns.p8' },
    },
    {
        key: 'APNS_KEY_ID',
        type: 'string',
        label: 'Apple Key ID',
        description:
            'The ten-character key identifier Apple shows next to the .p8 download. Required when you supply your own signing key.',
        defaultValue: '',
        section: 'push',
        uiHints: { advanced: true, placeholder: 'ABCDE12345' },
    },
    {
        key: 'APNS_TEAM_ID',
        type: 'string',
        label: 'Apple Team ID',
        description:
            'Your ten-character Apple Developer team identifier. Required when you supply your own signing key.',
        defaultValue: '',
        section: 'push',
        uiHints: { advanced: true, placeholder: 'TEAM123456' },
    },
    {
        key: 'FEATURE_PERSONAL_STATS',
        type: 'boolean',
        label: 'Personal Statistics',
        description: 'Enable "My Statistics" page for viewing history analytics',
        defaultValue: true,
        section: 'features',
    },
    {
        key: 'FEATURE_AVATAR_UPLOAD',
        type: 'boolean',
        label: 'Avatar Upload',
        description: 'Allow users to upload a custom avatar (JPEG/PNG/WebP/GIF, max 2 MB)',
        defaultValue: true,
        section: 'features',
        requiresRestart: false,
    },
    {
        key: 'FEATURE_GRAVATAR',
        type: 'boolean',
        label: 'Gravatar Avatars',
        description: 'Use Gravatar as fallback for user avatars (requires users to have email set)',
        defaultValue: false,
        section: 'features',
    },
    {
        key: 'UPDATE_CHECK_ENABLED',
        type: 'boolean',
        label: 'Check for Lumastra updates (contacts GitHub once a day)',
        description:
            'Once a day, read the list of Lumastra releases from api.github.com and tell admins when a newer version is out. Security releases show as a red notice until you update. No account, token or information about this server is sent.',
        defaultValue: true,
        section: 'diagnostics',
        requiresRestart: false,
    },
    {
        key: 'FEATURE_CLIENT_DIAGNOSTICS',
        type: 'boolean',
        label: 'Automatic Client Diagnostics',
        description:
            'Let the iOS, tvOS and web apps send crash reports, app hangs, JavaScript errors and API failure counts. Playback problem reports are always recorded, regardless of this switch.',
        defaultValue: true,
        section: 'diagnostics',
        requiresRestart: false,
    },
    {
        key: 'FEATURE_CLIENT_LOG_BUNDLES',
        type: 'boolean',
        label: 'Client Log Bundles',
        description:
            'Let users send their app logs ("Send diagnostics") and let admins request logs from a device. Bundles are compressed, capped at 2 MB and kept for the log bundle retention period.',
        defaultValue: true,
        section: 'diagnostics',
        requiresRestart: false,
    },
    {
        key: 'FEATURE_CLIENT_DIAGNOSTICS_LOG_TAIL',
        type: 'boolean',
        label: 'Log Tails on Automatic Reports',
        description:
            'Attach the last ~200 redacted log lines to crash reports and playback failures, so you can see what led up to them without asking for full logs.',
        defaultValue: true,
        section: 'diagnostics',
        requiresRestart: false,
    },
    {
        key: 'FEATURE_SHOW_UNAIRED_EPISODES',
        type: 'boolean',
        label: 'Show Unaired Episodes',
        description:
            'Show episodes whose premiere date is in the future in the series modal, tagged "Not yet aired". When disabled, those rows are hidden.',
        defaultValue: true,
        section: 'browse',
    },
    {
        key: 'FEATURE_SHOW_MISSING_EPISODES',
        type: 'boolean',
        label: 'Show Missing Episodes',
        description:
            'Show episodes that are not present as files in the library, tagged "Not on disk" when they have already aired or "Air date TBA" when no air date is known yet. When disabled, those rows are hidden.',
        defaultValue: true,
        section: 'browse',
    },
    {
        key: 'FEATURE_AUTO_LYRICS',
        type: 'boolean',
        label: 'Auto-Fetch Lyrics',
        description:
            'Automatically download lyrics from LRCLIB when a user opens the lyrics tab. ' +
            'When disabled, only manually uploaded or pre-fetched lyrics are shown.',
        defaultValue: true,
        section: 'music',
    },
    {
        key: 'FEATURE_SAVE_LYRICS_TO_DISK',
        type: 'boolean',
        defaultValue: false,
        label: 'Save Fetched Lyrics to Disk',
        description:
            'When lyrics are fetched from LRCLib.net, save them as .lrc files next to the audio file. ' +
            'Requires write access to library paths.',
        section: 'music',
    },
    {
        key: 'FEATURE_MUSIC_LYRICS_FETCH',
        type: 'boolean',
        defaultValue: false,
        label: 'Bulk Lyrics Background Fetch',
        description:
            'Scheduled background task (every 6h) that fetches lyrics from LRCLIB for tracks with no attempt yet, ' +
            'using the same flow as on-demand fetching. No-op unless Auto-Fetch Lyrics is also enabled. Default off.',
        section: 'music',
        dependsOn: 'FEATURE_AUTO_LYRICS',
    },
    {
        key: 'FEATURE_JELLYFIN_SYNC',
        type: 'boolean',
        label: 'Jellyfin Watch Sync',
        description:
            'Bidirectional watch state sync with Jellyfin and session polling for "Now Streaming". ' +
            'Needs the Jellyfin server URL and API key above.',
        defaultValue: true,
        section: 'conn-jellyfin',
    },
    {
        key: 'FEATURE_JELLYFIN_COMPAT',
        type: 'boolean',
        label: 'Jellyfin Client Compatibility',
        description:
            'Expose /j/ routes that emulate the Jellyfin API, allowing native Jellyfin clients ' +
            '(Swiftfin, Jellyfin Android TV, etc.) to connect directly to Lumastra. ' +
            'Serves Lumastra\u2019s own catalog \u2014 no Jellyfin server required.',
        defaultValue: true,
        section: 'conn-jellyfin',
    },
    {
        key: 'JELLYFIN_COMPAT_CORS_ORIGINS',
        type: 'array',
        defaultValue: '',
        get label() {
            return m.admin_jellyfin_cors_origins_label();
        },
        get description() {
            return m.admin_jellyfin_cors_origins_description();
        },
        section: 'conn-jellyfin',
        dependsOn: 'FEATURE_JELLYFIN_COMPAT',
        validation: { corsOrigins: true },
        uiHints: { advanced: true, placeholder: 'https://web.example' },
    },
    {
        key: 'FEATURE_SUBSONIC_COMPAT',
        type: 'boolean',
        label: 'OpenSubsonic API Compatibility',
        description:
            'Expose /subsonic/rest/ routes implementing the OpenSubsonic API. Allows music apps like ' +
            'Symfonium, Ultrasonic, and DSub to connect and play your music library.',
        defaultValue: false,
        section: 'music',
    },
    {
        key: 'FEATURE_MEDIA_DOWNLOAD',
        type: 'boolean',
        label: 'Original File Download',
        description:
            'Allow downloading the original, untranscoded media file via GET /j/Items/{id}/Download ' +
            'and GET /api/v1/media/{id}/download. Independent of Jellyfin Client Compatibility — ' +
            'controls raw file egress specifically, not streaming/playback.',
        defaultValue: false,
        section: 'downloads',
    },
    {
        key: 'DOWNLOAD_THROTTLE_KBPS',
        type: 'number',
        label: 'Download Speed Limit (KB/s)',
        description:
            'Bandwidth cap applied to each file download — original files via both the public API and ' +
            'the Jellyfin-compatible surface, plus finished offline renditions. 0 disables the limit. ' +
            'Stops a single large download from saturating your uplink and starving live playback.',
        defaultValue: 0,
        section: 'downloads',
    },
    {
        key: 'JELLYFIN_PROGRESSIVE_TRANSCODE_MAX_CONCURRENT',
        type: 'number',
        label: 'Jellyfin-Client Transcoded Downloads (per replica)',
        description:
            'How many on-the-fly transcodes each replica runs for Jellyfin clients that download at a ' +
            'reduced quality (e.g. Moonfin). Further requests wait briefly, then get a retry-later answer. ' +
            '0 disables these transcodes; such clients then receive the original file.',
        defaultValue: 2,
        section: 'downloads',
    },
    {
        key: 'TRANSCODE_THROTTLE_KBPS',
        type: 'number',
        label: 'Transcoded Stream Speed Limit (KB/s)',
        description:
            'Bandwidth cap applied to each transcoded stream (HLS segment delivery). 0 disables the ' +
            'limit. Set this ABOVE the highest bitrate you serve — a stream capped below its own ' +
            'bitrate cannot keep up and will rebuffer continuously.',
        defaultValue: 0,
        section: 'downloads',
    },
    {
        key: 'FEATURE_DOWNLOAD_RENDITIONS',
        type: 'boolean',
        label: 'Offline Download Renditions',
        description:
            'Let clients request a transcoded copy of a title at a chosen quality for offline playback, ' +
            'for devices that cannot direct play the original. Each rendition costs CPU-minutes to encode ' +
            'and gigabytes of cache per quality and audio track — see the cache cap below.',
        defaultValue: false,
        section: 'downloads',
    },
    {
        key: 'DOWNLOAD_RENDITION_HWACCEL',
        type: 'boolean',
        label: 'GPU-Encode Download Renditions',
        description:
            'Use the configured GPU to encode offline download renditions instead of the CPU. Much ' +
            'faster, and the output is the same universally-playable H.264 either way. If a GPU ' +
            'encode fails it automatically falls back to the CPU for that download, so leaving this ' +
            'on is safe.',
        defaultValue: true,
        section: 'downloads',
        dependsOn: 'FEATURE_DOWNLOAD_RENDITIONS',
    },
    {
        key: 'DOWNLOAD_RENDITION_CACHE_MAX_GB',
        type: 'number',
        label: 'Download Rendition Cache (GB)',
        description:
            'Disk budget for finished download renditions. Coldest artifacts are evicted once the budget ' +
            'is exceeded; an evicted rendition is simply re-encoded if requested again.',
        defaultValue: 50,
        section: 'downloads',
        dependsOn: 'FEATURE_DOWNLOAD_RENDITIONS',
    },
    {
        key: 'DOWNLOAD_RENDITION_MAX_CONCURRENT',
        type: 'number',
        label: 'Concurrent Rendition Encodes',
        description:
            'How many download renditions this server encodes at once. These compete with live playback ' +
            'transcodes for CPU — raise only if you have headroom.',
        defaultValue: 1,
        section: 'downloads',
        dependsOn: 'FEATURE_DOWNLOAD_RENDITIONS',
    },
    {
        key: 'DOWNLOAD_RENDITION_STALL_TIMEOUT_SECONDS',
        type: 'number',
        label: 'Rendition Stall Timeout (seconds)',
        description:
            'Kill a download encoder after this long without advancing output or FFmpeg timestamps, releasing its slot for retry.',
        defaultValue: 600,
        validation: { min: 30 },
        section: 'downloads',
        dependsOn: 'FEATURE_DOWNLOAD_RENDITIONS',
    },
    {
        key: 'SERIES_DOWNLOAD_MAX_CONCURRENT_TRANSFERS',
        type: 'number',
        label: 'Concurrent Smart-Download Transfers',
        description:
            'How many finished renditions a client may download at once when filling its offline ' +
            'series pool. This governs BYTE TRANSFERS from an already-built artifact — a throttled ' +
            'static read — not encodes, which have their own limit above.',
        defaultValue: 2,
        section: 'downloads',
        dependsOn: 'FEATURE_DOWNLOAD_RENDITIONS',
    },
    {
        key: 'SERIES_DOWNLOAD_MAX_PREPARATIONS_PER_USER',
        type: 'number',
        label: 'Pending Rendition Encodes Per User',
        description:
            'How many renditions one user may have waiting or encoding at once when an automatic ' +
            'pool requests them. Manual downloads are never throttled by this. Raising it above the ' +
            'concurrent-encode limit buys that user nothing — there is only one slot — and starves ' +
            'everyone else behind an unattended sweep.',
        defaultValue: 1,
        section: 'downloads',
        dependsOn: 'FEATURE_DOWNLOAD_RENDITIONS',
    },
    {
        key: 'SERIES_DOWNLOAD_QUEUE_BACKPRESSURE_FACTOR',
        type: 'number',
        label: 'Rendition Queue Backpressure Factor',
        description:
            'Automatic pool requests are refused once the server-wide encode queue reaches this ' +
            'many times the concurrent-encode limit. Manual downloads are always admitted. Lower ' +
            'it if background downloads are making live playback stutter.',
        defaultValue: 8,
        section: 'downloads',
        dependsOn: 'FEATURE_DOWNLOAD_RENDITIONS',
    },
    {
        key: 'SERIES_DOWNLOAD_DEFAULT_RUNG',
        type: 'select',
        label: 'Default Smart-Download Quality',
        description:
            'Quality an offline series pool uses when a client does not name one. Never exceeds the ' +
            'source: a 720p episode is offered at 720p whatever this says. Roughly 1.2 GB/hour at ' +
            '720p and 0.6 GB/hour at 540p.',
        defaultValue: '720p',
        section: 'downloads',
        dependsOn: 'FEATURE_DOWNLOAD_RENDITIONS',
        validation: {
            options: [
                { value: '1080p', label: '1080p (~1.9 GB/hour)' },
                { value: '720p', label: '720p (~1.2 GB/hour)' },
                { value: '540p', label: '540p (~0.6 GB/hour)' },
                { value: '360p', label: '360p (~0.3 GB/hour)' },
            ],
        },
    },
    {
        key: 'FEATURE_SESSIONS_PUBLIC',
        type: 'boolean',
        label: 'Public Sessions',
        description: 'Allow non-admins to see the Now Streaming widget',
        defaultValue: true,
        // Conceptually this belongs with the sharing controls in 'social' — it decides
        // whether users see EACH OTHER's live sessions. It stays here because
        // `dependsOn` cannot cross a section: `isSettingEnabled` reads
        // `values[dependsOn]`, and `values` only holds the sections the current page
        // loaded, so the parent reads as `undefined` → permanently disabled.
        // `validateSchema()` fails this at startup ("will NOT appear in the admin UI").
        //
        // Moving the parent instead is worse: FEATURE_SESSIONS also parents
        // SESSIONS_REFRESH_INTERVAL_MS and SESSIONS_POLL_INTERVAL_MS, which are polling
        // knobs with no business in a privacy section. The Sharing & Privacy helpText
        // points here instead.
        section: 'streaming',
        dependsOn: 'FEATURE_SESSIONS',
    },
    {
        key: 'FEATURE_SESSIONS_DEVICE_INFO_PUBLIC',
        type: 'boolean',
        label: 'Public Device Info',
        description: 'Show device info (client, browser) to non-admins in sessions',
        defaultValue: false,
        // Stays with its parent FEATURE_SESSIONS_PUBLIC — see the note there.
        section: 'streaming',
        dependsOn: 'FEATURE_SESSIONS_PUBLIC',
    },
    {
        key: 'STREAM_TOKEN_WILDCARD_IP',
        type: 'boolean',
        label: 'Allow Any IP for New Stream Tokens',
        description:
            'Controls whether new playback stream tokens are IP-bound. Wildcard IP (default) lets another device fetch the stream, needed for AirPlay, Chromecast, tvOS, and handoff. ' +
            "Disabling ties tokens to the requester's IP, which is stricter but breaks casting. Does not affect token expiry or authentication.",
        defaultValue: true,
        section: 'streaming',
        uiHints: { advanced: true },
    },
    {
        key: 'DOWNLOAD_SESSION_GRANT_HOURS',
        type: 'number',
        label: 'Audiobook Download Link Lifetime',
        description:
            'How long the links of an audiobook download for Apple Watch stay valid. A download ' +
            'runs in the background for hours or days and sends no progress, so it cannot use the ' +
            'short lifetime of a playing stream. Counts from the moment the download is prepared; ' +
            'the maximum is seven days.',
        defaultValue: 168,
        section: 'streaming',
        validation: { min: 1, max: 168 },
        uiHints: { advanced: true, suffix: 'h' },
    },
    {
        key: 'DOWNLOAD_SESSIONS_MAX_PER_USER',
        type: 'number',
        label: 'Concurrent Audiobook Downloads per User',
        description:
            'How many audiobook downloads (Apple Watch) one user may have prepared at the same ' +
            'time. These do not count toward the concurrent stream limit.',
        defaultValue: 10,
        section: 'streaming',
        validation: { min: 1, max: 100 },
        uiHints: { advanced: true },
    },
    {
        key: 'FEATURE_YOUTUBE_MODALS',
        type: 'boolean',
        label: 'YouTube Trailers (Modals)',
        description: 'Show YouTube trailers in movie/show detail modals',
        defaultValue: true,
        section: 'hover',
    },
    {
        key: 'FEATURE_YOUTUBE_HERO',
        type: 'boolean',
        label: 'YouTube Trailers (Hero)',
        description: 'Show YouTube trailers in homepage hero slider',
        defaultValue: true,
        section: 'homepage',
    },
    {
        key: 'HERO_AUTOPLAY_ENABLED',
        type: 'boolean',
        label: 'Hero Autoplay',
        description: 'Auto-advance the homepage hero carousel',
        defaultValue: true,
        section: 'homepage',
        requiresRestart: false,
    },
    {
        key: 'HERO_AUTOPLAY_INTERVAL_MS',
        type: 'number',
        label: 'Hero Autoplay Interval',
        description: 'Milliseconds between hero slide changes',
        defaultValue: 10000,
        section: 'homepage',
        validation: { min: 3000, max: 60000 },
        uiHints: { suffix: 'ms', advanced: true },
        dependsOn: 'HERO_AUTOPLAY_ENABLED',
        requiresRestart: false,
    },
    {
        key: 'HERO_TRANSITION_MS',
        type: 'number',
        label: 'Hero Crossfade Duration',
        description: 'Crossfade duration between hero slides (0 = instant)',
        defaultValue: 500,
        section: 'homepage',
        validation: { min: 0, max: 2000 },
        uiHints: { suffix: 'ms', advanced: true },
        requiresRestart: false,
    },
    {
        key: 'HERO_MAX_SLIDES',
        type: 'number',
        label: 'Hero Max Slides',
        description: 'Maximum number of slides shown in the homepage hero',
        defaultValue: 5,
        section: 'homepage',
        validation: { min: 1, max: 15 },
        requiresRestart: false,
    },
    {
        key: 'HERO_FALLBACK_SOURCE',
        type: 'select',
        label: 'Hero Fallback Source',
        description: 'Source for the generic hero slide when no Next Up exists',
        defaultValue: 'trending',
        section: 'homepage',
        validation: {
            options: [
                { value: 'trending', label: 'Trending' },
                { value: 'random', label: 'Random' },
            ],
        },
        requiresRestart: false,
    },
    {
        key: 'FEATURE_QUICK_CONNECT',
        type: 'boolean',
        label: 'Quick Connect',
        description: 'Allow users to link Jellyfin devices via code',
        defaultValue: true,
        section: 'deviceAuth',
    },
    {
        key: 'FEATURE_PLAYER_AUTO_QUALITY',
        type: 'boolean',
        label: 'Auto Quality Mode',
        description: 'Enable adaptive bitrate quality switching in player',
        defaultValue: false,
        section: 'player',
        // Dev-only: too unstable to ship. Hidden + force-disabled in production
        // (see devFeaturesEnabled gate in server/config.ts). Available on local dev
        // and on deployments with ALLOW_DEV_FEATURES=true (e.g. preprod).
        uiHints: { devOnly: true },
    },
    {
        key: 'FEATURE_DOCK_TOGGLE',
        type: 'boolean',
        label: 'Dock Toggle',
        description: 'Allow users to hide/show sidebar dock',
        defaultValue: true,
        section: 'navigation',
        dependsOn: 'FEATURE_SIDEBAR',
    },
    {
        key: 'FEATURE_REQUEST_MODAL',
        type: 'boolean',
        label: 'In-App Request Modal',
        description: 'Open request form in modal (vs new Seerr tab)',
        defaultValue: false,
        section: 'requests',
    },
    {
        key: 'FEATURE_PLAYLISTS',
        type: 'boolean',
        label: 'Playlists',
        description: 'Enable user playlist creation and sharing',
        defaultValue: true,
        section: 'features',
    },
    {
        // Admin IA redesign (spec §3.7): master switch for the admin "Developer"
        // nav section and its diagnostic pages. The config getter in
        // server/config.ts defaults this to `devFeaturesEnabled` (on in dev/
        // preprod, off in prod) when unset here. Surfaced on the Settings →
        // General page's Diagnostics section, alongside the client crash-report
        // switches.
        key: 'SHOW_DEVELOPER_TOOLS',
        type: 'boolean',
        label: 'Show developer tools',
        description: 'Show the admin Developer section and its low-level diagnostic pages',
        defaultValue: false,
        section: 'diagnostics',
    },
    {
        key: 'FEATURE_PLAYLIST_CHAT',
        type: 'boolean',
        label: 'Playlist Chat',
        description: 'Enable chat within shared playlists',
        defaultValue: true,
        section: 'features',
        dependsOn: 'FEATURE_PLAYLISTS',
    },
    {
        key: 'FEATURE_MEDIA_ANNOTATIONS',
        type: 'boolean',
        label: 'Media Annotations',
        description:
            'Enable Dark Souls-style timestamp pins and seekbar markers on movies and episodes',
        defaultValue: false,
        section: 'player',
    },
    {
        key: 'FEATURE_MEDIA_CHAT',
        type: 'boolean',
        label: 'Media Chat',
        description: 'Enable freeform community chat sidebar on movies and episodes',
        defaultValue: false,
        section: 'player',
        dependsOn: 'FEATURE_MEDIA_ANNOTATIONS',
    },
    {
        key: 'ANNOTATIONS_MAX_PINS',
        type: 'number',
        label: 'Max Pins Per User',
        description: 'Maximum number of timestamp pins a user can place on a single media item',
        defaultValue: 3,
        section: 'player',
        dependsOn: 'FEATURE_MEDIA_ANNOTATIONS',
    },
    {
        key: 'MEDIA_ANNOTATION_GROUPS',
        type: 'array',
        label: 'Media Annotation Groups',
        description:
            'Groups that can open the player community tab and view or create timestamp pins and chat (empty = all users allowed)',
        defaultValue: '',
        section: 'player',
        dependsOn: 'FEATURE_MEDIA_ANNOTATIONS',
        uiHints: { placeholder: 'community,admin', groups: true },
    },
    {
        key: 'MODERATOR_GROUPS',
        type: 'array',
        label: 'Moderator Groups',
        description:
            "Groups that can moderate user-generated content: delete any user's annotation pins, media chat messages, and future reviews. Does not grant metadata editing or admin access. Admins always have moderation privileges.",
        defaultValue: [],
        section: 'groups',
        uiHints: { groups: true },
    },
    {
        key: 'FEATURE_STARS_BACKGROUND',
        type: 'boolean',
        label: 'Stars Background',
        description: 'Show animated twinkling stars on homepage',
        defaultValue: true,
        section: 'homepage',
    },
    {
        key: 'FEATURE_MEDIA_HOVER_POPUP',
        type: 'boolean',
        label: 'Enable Hover Popup',
        description: 'Show Netflix-style popup with details when hovering over poster cards',
        defaultValue: true,
        section: 'hover',
    },
    {
        key: 'FEATURE_MEDIA_HOVER_POPUP_TRAILERS',
        type: 'boolean',
        label: 'YouTube Trailers',
        description: 'Auto-play YouTube trailers in the hover popup',
        defaultValue: false,
        section: 'hover',
        showWhen: { key: 'FEATURE_MEDIA_HOVER_POPUP', equals: true },
    },
    {
        key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW',
        type: 'boolean',
        label: 'Video Previews',
        description:
            'Show video previews on hover for Continue Watching items (alternative to YouTube trailers)',
        defaultValue: false,
        section: 'hover',
        showWhen: { key: 'FEATURE_MEDIA_HOVER_POPUP', equals: true },
        uiHints: {
            beta: true,
        },
    },
    {
        key: 'PREVIEW_MAX_WIDTH',
        type: 'number',
        label: 'Max Width',
        description: 'Maximum video width for previews',
        defaultValue: 640,
        section: 'hover',
        validation: {
            min: 320,
            max: 1920,
            uiHints: { advanced: true },
        },
        uiHints: {
            suffix: 'px',
            advanced: true,
        },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_MAX_HEIGHT',
        type: 'number',
        label: 'Max Height',
        description: 'Maximum video height for previews',
        defaultValue: 360,
        section: 'hover',
        validation: {
            min: 240,
            max: 1080,
            uiHints: { advanced: true },
        },
        uiHints: {
            suffix: 'px',
            advanced: true,
        },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW_LIVETV',
        type: 'boolean',
        label: 'Live TV Previews',
        description:
            'Enable video previews for live TV channels on hover. WARNING: Live TV previews are resource-intensive. Server-wide preview limits and active-viewer limits are enforced.',
        defaultValue: false,
        section: 'hover',
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
        uiHints: {
            beta: true,
            devOnly: true,
        },
    },
    {
        key: 'PREVIEW_MAX_LIVETV_PER_SERVER',
        type: 'number',
        label: 'Max Live TV Previews',
        description:
            'Maximum concurrent live TV previews server-wide (to prevent resource exhaustion). Each preview consumes transcoding resources. Recommended: 2-5 depending on server capacity.',
        defaultValue: 3,
        section: 'hover',
        validation: {
            min: 1,
            max: 10,
            uiHints: { advanced: true },
        },
        uiHints: {
            advanced: true,
            devOnly: true,
        },
        showWhen: {
            key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW_LIVETV',
            equals: true,
        },
    },
    {
        key: 'PREVIEW_HOVER_DELAY_LIVETV_MS',
        type: 'number',
        label: 'Live TV Hover Delay',
        description:
            'Delay in milliseconds before showing live TV preview on hover. Longer delay reduces accidental preview triggers when browsing channels. Recommended: 1000-3000ms.',
        defaultValue: 2500,
        section: 'hover',
        validation: {
            min: 0,
            max: 10000,
            uiHints: { advanced: true },
        },
        uiHints: {
            advanced: true,
            devOnly: true,
            suffix: 'ms',
        },
        showWhen: {
            key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW_LIVETV',
            equals: true,
        },
    },
    {
        key: 'PREVIEW_HOVER_VIDEO_DELAY_MS',
        type: 'number',
        label: 'Hover Video Delay',
        description:
            'Delay in milliseconds before loading the trailer/preview video inside the hover popup. The popup opens instantly with a still image; only the video waits. Higher values prevent request bursts when scrubbing across posters. Set to 0 to load video immediately.',
        defaultValue: 500,
        section: 'hover',
        validation: {
            min: 0,
            max: 5000,
            uiHints: { advanced: true },
        },
        uiHints: {
            advanced: true,
            suffix: 'ms',
        },
    },
    {
        key: 'PREVIEW_MAX_LIVETV_WATCHERS',
        type: 'number',
        label: 'Max Live TV Watchers',
        description:
            'Maximum number of active live TV viewers before blocking preview requests. Prevents server overload and respects IPTV provider session limits. Most IPTV providers limit concurrent streams (typically 1-5). Set to 0 to disable this limit.',
        defaultValue: 5,
        section: 'hover',
        validation: {
            min: 0,
            max: 50,
            uiHints: { advanced: true },
        },
        uiHints: {
            advanced: true,
            devOnly: true,
        },
        showWhen: {
            key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW_LIVETV',
            equals: true,
        },
    },
    {
        key: 'PREVIEW_VIDEO_CODEC',
        type: 'select',
        label: 'Video Codec',
        description: 'Video codec for transcoding (h264 recommended for compatibility)',
        defaultValue: 'h264',
        section: 'hover',
        validation: {
            options: [
                {
                    value: 'h264',
                    label: 'H.264/AVC (universal)',
                    uiHints: { advanced: true },
                },
                {
                    value: 'hevc',
                    label: 'H.265/HEVC (better compression)',
                },
            ],
        },
        uiHints: {
            advanced: true,
        },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'FEATURE_FEATURED_PICK_VIDEO',
        type: 'boolean',
        label: 'Featured Pick Video',
        description:
            'Auto-play trailers or video previews in the Featured Pick hero section. Supports YouTube trailers and local video previews with automatic fallback to backdrop image.',
        defaultValue: false,
        section: 'hover',
        // Feature ENABLE toggle — never advanced (only fine-tuning knobs are).
        uiHints: { beta: true },
    },
    {
        key: 'PREVIEW_ENCODING_PRESET',
        type: 'select',
        label: 'Preview Encoding Preset',
        description:
            'Software encoding speed preset for video previews (faster = lower CPU but less efficient)',
        defaultValue: 'veryfast',
        section: 'hover',
        validation: {
            options: [
                { value: 'ultrafast', label: 'Ultrafast (lowest CPU)' },
                { value: 'superfast', label: 'Superfast' },
                { value: 'veryfast', label: 'Veryfast (recommended)' },
                { value: 'faster', label: 'Faster' },
                { value: 'fast', label: 'Fast' },
            ],
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_NVENC_PRESET',
        type: 'select',
        label: 'Preview NVENC Preset',
        description:
            'NVIDIA encoder preset for video previews (p1=fastest, lower number = faster encoding)',
        defaultValue: 'p2',
        section: 'hover',
        validation: {
            options: [
                { value: 'p1', label: 'P1 (Fastest)' },
                { value: 'p2', label: 'P2 (Recommended for previews)' },
                { value: 'p3', label: 'P3' },
                { value: 'p4', label: 'P4 (Balanced)' },
            ],
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_MAX_GLOBAL',
        type: 'number',
        label: 'Max Concurrent Previews (Server-wide)',
        description:
            'Hard ceiling on concurrent video-preview transcodes across the whole server (all replicas). New requests are refused, not queued, once this is reached, so previews can never monopolize the server. Reuse means one job serves many re-requests, so this counts distinct in-flight previews.',
        defaultValue: 8,
        section: 'hover',
        validation: {
            min: 1,
            max: 64,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_MAX_PER_USER',
        type: 'number',
        label: 'Max Concurrent Previews (Per User)',
        description:
            'Ceiling on concurrent video-preview sessions for a single user. The homepage hero holds up to two at once and the hover popup can hold another, so a value below about four will evict a preview that is still on screen.',
        defaultValue: 6,
        section: 'hover',
        validation: {
            min: 1,
            max: 32,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_LOAD_SHED_RATIO',
        type: 'number',
        label: 'Preview Load-Shed Threshold',
        description:
            'System load average (1-minute) per CPU core above which new previews are automatically disabled until load recovers. Real playback is never affected. Example: 3.0 on a 20-core box trips at a load of 60. Set to 0 to disable the load circuit breaker.',
        defaultValue: 3.0,
        section: 'hover',
        validation: {
            min: 0,
            max: 100,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_AUTODISABLE_SECONDS',
        type: 'number',
        label: 'Preview Auto-Disable Cool-off',
        description:
            'How long previews stay auto-disabled after a load-shed breach. The breaker re-evaluates every request, so this is the minimum cool-off; it clears automatically once load returns below the threshold.',
        defaultValue: 45,
        section: 'hover',
        validation: {
            min: 5,
            max: 600,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true, suffix: 'seconds' },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_TRANSCODE_MAX_SECONDS',
        type: 'number',
        label: 'Preview Max Transcode Length',
        description:
            'Hard cap on how many seconds of media a single preview FFmpeg job transcodes. A preview is a short hover/hero snippet, never the whole movie, so without this cap a long-lived preview transcodes forward unboundedly, wasting CPU and disk. 0 = unbounded (legacy behavior).',
        defaultValue: 30,
        section: 'hover',
        validation: {
            min: 0,
            max: 300,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true, suffix: 'seconds' },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'TRAILER_MAX_SECONDS',
        type: 'number',
        label: 'Local Trailer Max Length',
        description:
            'Hard cap on how many seconds of a local trailer file the preview pipeline transcodes. Trailers play full-length through the preview lane (unlike 30-second hover snippets); this bounds mislabeled full-length files. Cached trailer artifacts are roughly 12x the size of hover snippets against the preview cache budget. 0 = unbounded.',
        defaultValue: 360,
        section: 'hover',
        validation: {
            min: 0,
            max: 1800,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true, suffix: 'seconds' },
    },
    {
        key: 'PREVIEW_MAX_VIDEO_BITRATE_MBPS',
        type: 'number',
        label: 'Preview Max Video Bitrate',
        description:
            'Peak video bitrate cap (Mbps) for preview transcodes, applied as a VBV constraint (-b:v/-maxrate/-bufsize). Without it, a complex 4K/high-motion source can emit 10+ Mbps segments that stall the hover player. A 360p-720p preview needs about 1-2 Mbps. 0 = no cap (CRF-only quality).',
        defaultValue: 2,
        section: 'hover',
        validation: {
            min: 0,
            max: 50,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true, suffix: 'Mbps' },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_MAX_GPU_JOBS',
        type: 'number',
        label: 'Max GPU Preview Transcodes',
        description:
            'How many preview transcodes may use the GPU (QSV/NVENC) at once. Previews are bursty (every hover) and share the GPU with real playback; above this in-flight count, previews fall back to CPU so they can never starve playback of GPU encode sessions. Needs hardware encoding enabled; 0 = always use CPU for previews.',
        defaultValue: 2,
        section: 'hover',
        validation: {
            min: 0,
            max: 16,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_SEGMENT_DURATION',
        type: 'number',
        label: 'Preview Segment Length',
        description:
            'HLS segment length (seconds) for preview transcodes. A cold preview shows its first frame only after FFmpeg encodes the first segment, so a shorter segment is the biggest first-frame-latency lever: 2s is about 3x faster to first frame than the 6s playback default, at the cost of a few more tiny requests.',
        defaultValue: 2,
        section: 'hover',
        validation: {
            min: 1,
            max: 10,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true, suffix: 'seconds' },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_CACHE_ENABLED',
        type: 'boolean',
        label: 'Enable Preview Caching',
        description:
            'Cache preview thumbnails locally so repeat hovers load from disk instead of regenerating.',
        defaultValue: true,
        section: 'hover',
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_CACHE_DIR',
        type: 'string',
        label: 'Preview Cache Directory',
        description:
            'Local filesystem path for cached preview files. Must be on fast, local storage (never /tmp or NFS). Mirrors music-transcode cache convention.',
        defaultValue: '/config/cache/preview',
        section: 'hover',
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_CACHE_MAX_BYTES',
        type: 'number',
        label: 'Preview Cache Size',
        description:
            'Maximum total size of preview cache in bytes before eviction occurs. Default 10 GB keeps cache manageable on most systems.',
        defaultValue: 10 * 1024 * 1024 * 1024,
        section: 'hover',
        validation: {
            min: 0,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_FORCE_UNIVERSAL_CODEC',
        type: 'boolean',
        label: 'Force Universal Codec',
        description:
            'Transcode previews to a universal codec for maximum compatibility across devices. When disabled, tries to preserve original codec if supported.',
        defaultValue: true,
        section: 'hover',
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },
    {
        key: 'PREVIEW_HOVER_MAX_SECONDS',
        type: 'number',
        label: 'Preview Max Duration',
        description:
            'Maximum duration (seconds) of video preview shown on hover. Limits the length of generated previews to keep UI responsive.',
        defaultValue: 60,
        section: 'hover',
        validation: {
            min: 5,
            max: 600,
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true, suffix: 'seconds' },
        showWhen: { key: 'FEATURE_MEDIA_HOVER_VIDEO_PREVIEW', equals: true },
    },

    // =========================================================================
    // tvOS Top Shelf preview + cinemagraph URLs
    // =========================================================================
    {
        key: 'FEATURE_TOPSHELF_PREVIEWS',
        type: 'boolean',
        label: 'tvOS Top Shelf Previews',
        description:
            'Mint signed preview/cinemagraph MP4 URLs for the tvOS Top Shelf carousel. Experimental; gates both minting and serving.',
        defaultValue: false,
        section: 'topshelf',
        // NOT advanced: this is the master on/off switch for the whole Top Shelf
        // feature. Hiding a feature's own enable toggle behind the Advanced switch
        // makes the feature undiscoverable. The knobs under it stay advanced.
        uiHints: { beta: true },
    },
    {
        key: 'TOPSHELF_PREVIEW_URL_TTL_SECONDS',
        type: 'number',
        label: 'Signed URL Expiry',
        description:
            'How long a minted Top Shelf signed URL remains valid before it must be re-minted. Default 48h.',
        defaultValue: 172800,
        section: 'topshelf',
        validation: { min: 3600 },
        uiHints: { advanced: true, suffix: 'seconds' },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_PREVIEW_CACHE_DIR',
        type: 'string',
        label: 'Top Shelf Cache Directory',
        description:
            'Local filesystem path for the durable Top Shelf artifact store. Must be on fast, local storage (never /tmp or NFS).',
        defaultValue: '/config/cache/topshelf',
        section: 'topshelf',
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_PREVIEW_CACHE_MAX_BYTES',
        type: 'number',
        label: 'Top Shelf Cache Size',
        description:
            'Maximum total size of the Top Shelf artifact store before eviction; a live signed URL always overrides this cap (pinning rule).',
        defaultValue: 2 * 1024 * 1024 * 1024,
        section: 'topshelf',
        validation: { min: 0 },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_PREVIEW_RETENTION_DAYS',
        type: 'number',
        label: 'Top Shelf Retention',
        description:
            'GC TTL (days) on an artifact’s last-requested time, once it is no longer pinned.',
        defaultValue: 14,
        section: 'topshelf',
        validation: { min: 1, integer: true },
        uiHints: { advanced: true, suffix: 'days' },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_GC_INTERVAL_MS',
        type: 'number',
        label: 'Top Shelf GC Interval',
        description: 'How often the Top Shelf artifact store’s background GC sweep runs.',
        defaultValue: 3_600_000,
        section: 'topshelf',
        validation: { min: 60_000 },
        uiHints: { advanced: true, suffix: 'ms' },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_PREVIEW_DURATION_SECONDS',
        type: 'number',
        label: 'Snippet Preview Duration',
        description: 'Length of the rendered preview snippet when no local trailer exists.',
        defaultValue: 30,
        section: 'topshelf',
        validation: { min: 5, max: 120 },
        uiHints: { advanced: true, suffix: 'seconds' },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_TRAILER_MAX_SECONDS',
        type: 'number',
        label: 'Trailer Preview Cap',
        description:
            'Duration cap applied when a local trailer is used as the preview variant’s source.',
        defaultValue: 90,
        section: 'topshelf',
        validation: { min: 10, max: 300 },
        uiHints: { advanced: true, suffix: 'seconds' },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_CINEMAGRAPH_DURATION_SECONDS',
        type: 'number',
        label: 'Cinemagraph Duration',
        description: 'Length of the silent looping cinemagraph clip.',
        defaultValue: 15,
        section: 'topshelf',
        validation: { min: 5, max: 60 },
        uiHints: { advanced: true, suffix: 'seconds' },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_RENDER_MAX_WIDTH',
        type: 'number',
        label: 'Render Max Width',
        description:
            'Base render width (pixels) for Top Shelf artifacts. Deliberately separate from the hover-preview "Max Width" (640px default), which is far too soft for a full-bleed 4K-TV surface.',
        defaultValue: 1280,
        section: 'topshelf',
        validation: { min: 640, max: 1920, uiHints: { advanced: true } },
        uiHints: { suffix: 'px', advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_RENDER_MAX_HEIGHT',
        type: 'number',
        label: 'Render Max Height',
        description:
            'Base render height (pixels) for Top Shelf artifacts, 16:9 with the width. Previews with a burned logo are cropped to exactly this size, because Apple TV crops any other shape on screen.',
        defaultValue: 720,
        section: 'topshelf',
        validation: { min: 360, max: 1080, uiHints: { advanced: true } },
        uiHints: { suffix: 'px', advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_MAX_CONCURRENT_RENDERS',
        type: 'number',
        label: 'Max Concurrent Renders',
        description: 'How many Top Shelf ffmpeg render jobs may run at once across the server.',
        defaultValue: 1,
        section: 'topshelf',
        validation: { min: 1, max: 8 },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_MAX_PENDING_RENDERS',
        type: 'number',
        label: 'Max Pending Renders',
        description:
            'Queue-depth cap for Top Shelf renders. Beyond this, a mint responds "pending" without enqueueing a new render.',
        defaultValue: 24,
        section: 'topshelf',
        validation: { min: 1, max: 200 },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_MINT_RATE_LIMIT',
        type: 'number',
        label: 'Mint Rate Limit',
        description: 'Maximum Top Shelf mint requests per user per 5-minute window.',
        defaultValue: 240,
        section: 'topshelf',
        validation: { min: 1, max: 1000 },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_OVERLAY_DEFAULT_POSITION',
        type: 'select',
        label: 'Overlay Default Position',
        description:
            'Default corner the Top Shelf overlay anchors to when a client does not request one explicitly.',
        defaultValue: 'tl',
        section: 'topshelf',
        validation: {
            options: [
                { value: 'tl', label: 'Top Left' },
                { value: 'tr', label: 'Top Right' },
                { value: 'bl', label: 'Bottom Left' },
                { value: 'br', label: 'Bottom Right' },
            ],
        },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_OVERLAY_DEFAULT_SCRIM',
        type: 'boolean',
        label: 'Overlay Default Scrim',
        description:
            'Draw a scrim behind the overlay text by default, for legibility over bright source frames.',
        defaultValue: true,
        section: 'topshelf',
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_OVERLAY_DEFAULT_SCALE',
        type: 'number',
        label: 'Overlay Default Scale',
        description:
            'Default overlay scale, as a fraction of the rendered frame’s shorter dimension.',
        defaultValue: 0.4,
        section: 'topshelf',
        validation: { min: 0.1, max: 1 },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_OVERLAY_SAFE_PADDING',
        type: 'number',
        label: 'Overlay Safe Padding',
        description:
            'Safe-area padding (fraction of frame) kept clear of overlay content on every edge. 0.055 matches TV overscan/title-safe convention (~5.5%).',
        defaultValue: 0.055,
        section: 'topshelf',
        validation: { min: 0, max: 0.5 },
        uiHints: { advanced: true },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },
    {
        key: 'TOPSHELF_OVERLAY_TEXT_LOCALES',
        type: 'array',
        label: 'Overlay Text Locales',
        description:
            'Locales the overlay renders text for, comma-separated BCP-47-ish codes (e.g. "en,de"). Normalized lowercase; blank entries dropped.',
        defaultValue: ['en'],
        section: 'topshelf',
        uiHints: { advanced: true, placeholder: 'en,de' },
        showWhen: { key: 'FEATURE_TOPSHELF_PREVIEWS', equals: true },
    },

    // =========================================================================
    // Player Settings
    // =========================================================================
    {
        key: 'PLAYER_SKIP_SECONDS',
        type: 'number',
        label: 'Skip Duration',
        description: 'Seconds to skip forward/backward',
        defaultValue: 10,
        section: 'player',
        validation: { min: 5, max: 60 },
        uiHints: { suffix: 'seconds' },
    },
    {
        key: 'NEXT_EPISODE_COUNTDOWN_SECONDS',
        type: 'number',
        label: 'Next Episode Countdown',
        description:
            'Seconds to wait before auto-playing the next episode. Users can override this in their own playback settings.',
        defaultValue: 10,
        section: 'player',
        validation: { min: 3, max: 60 },
        uiHints: { suffix: 'seconds' },
    },
    {
        key: 'NEXT_EPISODE_PROMPT_LEAD_SECONDS',
        type: 'number',
        label: 'Next Episode Prompt Lead Time',
        description:
            'When credits/outro are detected, how many seconds before the credits begin to show the next-episode prompt. Positive shows it earlier; 0 shows it exactly at the credits start; negative delays it until after the credits have started (later auto-advance). Only applies to content with an outro marker.',
        defaultValue: 0,
        section: 'player',
        validation: { min: -30, max: 60 },
        uiHints: { suffix: 'seconds', step: 1 },
    },
    {
        key: 'PLAYER_DEFAULT_QUALITY_MODE',
        type: 'select',
        label: 'Default Quality',
        description: 'Initial quality mode when starting playback',
        defaultValue: 'original',
        section: 'player',
        validation: {
            options: [
                { value: 'original', label: 'Original (source quality)' },
                { value: 'auto', label: 'Auto (adaptive bitrate)' },
            ],
            optionDependencies: {
                auto: 'FEATURE_PLAYER_AUTO_QUALITY',
            },
        },
    },
    {
        key: 'PLAYER_HLS_JS_VOD_MAX_BUFFER_SIZE_BYTES',
        type: 'number',
        label: 'HLS.js VOD Max Buffer Size',
        description:
            'Maximum video data hls.js may buffer ahead for movies and episodes, in bytes. Used only by browsers that play VOD through hls.js, such as Chrome and Firefox.',
        defaultValue: 1_000_000_000,
        section: 'player',
        validation: { min: 1_000_000, max: 5_000_000_000 },
        uiHints: { suffix: 'bytes', advanced: true },
    },
    {
        key: 'PLAYER_HLS_JS_VOD_MAX_BUFFER_LENGTH_SECONDS',
        type: 'number',
        label: 'HLS.js VOD Buffer Target',
        description:
            'Amount of movie or episode playback hls.js tries to keep buffered ahead of the current position. Used only by browsers that play VOD through hls.js, such as Chrome and Firefox.',
        defaultValue: 600,
        section: 'player',
        validation: { min: 10, max: 7200 },
        uiHints: { suffix: 'seconds', advanced: true },
    },
    {
        key: 'PLAYER_HLS_JS_VOD_MAX_MAX_BUFFER_LENGTH_SECONDS',
        type: 'number',
        label: 'HLS.js VOD Buffer Cap',
        description:
            'Hard time limit for how far ahead hls.js may buffer movies and episodes, even when the byte limit has not been reached. Used only by browsers that play VOD through hls.js, such as Chrome and Firefox.',
        defaultValue: 1800,
        section: 'player',
        validation: { min: 10, max: 14400 },
        uiHints: { suffix: 'seconds', advanced: true },
    },
    {
        key: 'PLAYER_HLS_JS_VOD_BACK_BUFFER_LENGTH_SECONDS',
        type: 'number',
        label: 'HLS.js VOD Back Buffer',
        description:
            'Amount of already watched movie or episode playback hls.js keeps behind the current position. Used only by browsers that play VOD through hls.js, such as Chrome and Firefox.',
        defaultValue: 30,
        section: 'player',
        validation: { min: 0, max: 3600 },
        uiHints: { suffix: 'seconds', advanced: true },
    },
    {
        key: 'PLAYER_QUALITY_STABILITY_MS',
        type: 'number',
        label: 'Quality Stability Period',
        description: 'Initial period before quality switching begins',
        defaultValue: 10000,
        section: 'player',
        validation: { min: 1000, max: 60000 },
        uiHints: { suffix: 'ms' },
        dependsOn: 'FEATURE_PLAYER_AUTO_QUALITY',
    },
    {
        key: 'PLAYER_QUALITY_DOWN_COOLDOWN_MS',
        type: 'number',
        label: 'Quality Down Cooldown',
        description: 'Cooldown after switching to lower quality',
        defaultValue: 10000,
        section: 'player',
        validation: { min: 1000, max: 60000 },
        uiHints: { suffix: 'ms' },
        dependsOn: 'FEATURE_PLAYER_AUTO_QUALITY',
    },
    {
        key: 'PLAYER_QUALITY_UP_COOLDOWN_MS',
        type: 'number',
        label: 'Quality Up Cooldown',
        description: 'Cooldown after switching to higher quality',
        defaultValue: 30000,
        section: 'player',
        validation: { min: 1000, max: 120000 },
        uiHints: { suffix: 'ms' },
        dependsOn: 'FEATURE_PLAYER_AUTO_QUALITY',
    },
    {
        key: 'PLAYER_BANDWIDTH_SAMPLES',
        type: 'number',
        label: 'Bandwidth Samples',
        description: 'Number of samples for bandwidth averaging',
        defaultValue: 5,
        section: 'player',
        validation: { min: 3, max: 20, integer: true },
        dependsOn: 'FEATURE_PLAYER_AUTO_QUALITY',
    },
    {
        key: 'PLAYER_MIN_SAMPLES_BEFORE_SWITCH',
        type: 'number',
        label: 'Min Samples Before Switch',
        description: 'Minimum bandwidth samples before first quality change',
        defaultValue: 3,
        section: 'player',
        validation: { min: 1, max: 10, integer: true },
        dependsOn: 'FEATURE_PLAYER_AUTO_QUALITY',
    },
    {
        key: 'PLAYER_MIN_ADAPTIVE_BITRATE',
        type: 'number',
        label: 'Min Adaptive Bitrate',
        description: 'Minimum bitrate threshold for adaptive quality',
        defaultValue: 2000000,
        section: 'player',
        validation: { min: 500000, max: 50000000 },
        uiHints: { suffix: 'bps' },
        dependsOn: 'FEATURE_PLAYER_AUTO_QUALITY',
    },
    {
        key: 'PLAYER_SUBTITLE_SIZE_MULTIPLIER',
        type: 'number',
        label: 'Subtitle Size Multiplier',
        description: 'Global size boost applied to all subtitle types',
        defaultValue: 1.2,
        section: 'player',
        validation: { min: 0.5, max: 3.0 },
        uiHints: { suffix: 'x', step: 0.1 },
    },
    {
        key: 'PLAYER_SUBTITLE_PGS_SCALE',
        type: 'number',
        label: 'PGS Subtitle Scale',
        description: 'Base scale for PGS (image-based) subtitles to align with SRT sizing',
        defaultValue: 55,
        section: 'player',
        validation: { min: 20, max: 150 },
        uiHints: { suffix: '%', step: 5, advanced: true },
    },
    {
        key: 'PLAYER_SUBTITLE_SRT_SCALE',
        type: 'number',
        label: 'SRT Subtitle Scale',
        description: 'Base scale for SRT subtitles (as percentage factor)',
        defaultValue: 140,
        section: 'player',
        validation: { min: 50, max: 300 },
        uiHints: { suffix: '%', advanced: true },
    },
    {
        key: 'PLAYER_VOLUME_CURVE',
        type: 'select',
        label: 'Volume Curve',
        description:
            'How the volume slider maps to perceived loudness. Logarithmic curves give finer control at low volume and coarser control at high volume, matching human hearing.',
        defaultValue: 'quadratic',
        section: 'player',
        validation: {
            options: [
                {
                    value: 'linear',
                    label: 'Linear (Off) - No adjustment',
                },
                {
                    value: 'quadratic',
                    label: 'Quadratic (x²) - Moderate logarithmic scaling',
                },
                {
                    value: 'quartic',
                    label: 'Quartic (x⁴) - Recommended for best perception match',
                },
            ],
        },
    },

    // =========================================================================
    // Lumastra HLS (FFmpeg Transcoding)
    // =========================================================================
    // FFmpeg transcoding detail settings (always visible when FFMPEG_PATH is set).
    {
        key: 'TRANSCODING_MODE',
        type: 'select',
        label: 'Transcoding Mode',
        description:
            'Transcodes entirely from local files with optional GPU acceleration. ' +
            'Requires library paths to be configured with matching mount points.',
        defaultValue: 'full',
        validation: {
            options: [
                {
                    value: 'full',
                    label: 'Full (from local files, GPU optional)',
                },
            ],
        },
        section: 'ffmpeg',
    },
    {
        key: 'GPU_ACCELERATION',
        type: 'select',
        label: 'GPU Acceleration',
        description: 'Hardware encoder to use for full transcoding mode',
        defaultValue: 'none',
        validation: {
            options: [
                { value: 'none', label: 'None (CPU only)' },
                { value: 'nvenc', label: 'NVIDIA NVENC' },
                { value: 'qsv', label: 'Intel Quick Sync' },
                { value: 'vaapi', label: 'VAAPI (AMD/Intel on Linux)' },
                { value: 'amf', label: 'AMD AMF (Windows) - untested' },
                {
                    value: 'videotoolbox',
                    label: 'VideoToolbox (macOS) - untested',
                },
            ],
        },
        section: 'ffmpeg-hardware',
    },
    {
        key: 'TRANSCODE_DOWNSCALE_CPU_TO_1080P',
        type: 'boolean',
        label: 'Downscale 4K to 1080p on CPU',
        description:
            'When there is no GPU, caps CPU video transcodes to 1080p for taller sources. A 4K CPU transcode usually runs below real time and stutters or fails; downscaling keeps it playable. No effect when GPU acceleration is enabled.',
        defaultValue: true,
        section: 'ffmpeg-hardware',
        showWhen: { key: 'GPU_ACCELERATION', equals: 'none' },
    },
    {
        key: 'VAAPI_DEVICE',
        type: 'string',
        label: 'VAAPI Device',
        description: 'Path to VAAPI render device (e.g., /dev/dri/renderD128)',
        defaultValue: '/dev/dri/renderD128',
        section: 'ffmpeg-hardware',
        uiHints: { placeholder: '/dev/dri/renderD128', advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'vaapi' },
    },
    {
        key: 'QSV_DEVICE',
        type: 'string',
        label: 'QSV Device',
        description: 'Path to Intel QSV device (leave empty for auto-detection)',
        defaultValue: '',
        section: 'ffmpeg-hardware',
        uiHints: {
            placeholder: '/dev/dri/renderD128 (or empty for auto)',
            advanced: true,
        },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'qsv' },
    },
    {
        key: 'NVENC_PRESET',
        type: 'select',
        label: 'NVENC Preset',
        description: 'NVIDIA encoder quality preset (p1=fastest, p7=best quality)',
        defaultValue: 'p4',
        validation: {
            options: [
                { value: 'p1', label: 'P1 (Fastest)' },
                { value: 'p2', label: 'P2' },
                { value: 'p3', label: 'P3' },
                { value: 'p4', label: 'P4 (Balanced)' },
                { value: 'p5', label: 'P5' },
                { value: 'p6', label: 'P6' },
                { value: 'p7', label: 'P7 (Best Quality)' },
            ],
        },
        section: 'ffmpeg-hardware',
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'nvenc' },
    },
    {
        key: 'NVENC_TUNE',
        type: 'select',
        label: 'NVENC Tune',
        description: 'Optimize NVENC encoder for specific use cases',
        defaultValue: '',
        validation: {
            options: [
                { value: '', label: 'Default' },
                { value: 'hq', label: 'High Quality' },
                { value: 'll', label: 'Low Latency' },
                { value: 'ull', label: 'Ultra Low Latency' },
                { value: 'lossless', label: 'Lossless' },
            ],
        },
        section: 'ffmpeg-hardware',
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'nvenc' },
    },
    {
        key: 'NVENC_RC',
        type: 'select',
        label: 'NVENC Rate Control',
        description: 'Rate control mode for NVENC encoder',
        defaultValue: 'auto',
        validation: {
            options: [
                { value: 'auto', label: 'Auto' },
                { value: 'constqp', label: 'Constant QP (Quality)' },
                { value: 'vbr', label: 'Variable Bitrate' },
                { value: 'cbr', label: 'Constant Bitrate' },
            ],
        },
        section: 'ffmpeg-hardware',
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'nvenc' },
    },
    {
        key: 'NVENC_CQ',
        type: 'number',
        label: 'NVENC CQ',
        description: 'Constant quality value for NVENC (0-51, lower = better)',
        defaultValue: 23,
        section: 'ffmpeg-hardware',
        validation: { min: 0, max: 51 },
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'nvenc' },
    },
    {
        key: 'NVDEC_ENHANCED',
        type: 'boolean',
        label: 'Enhanced NVDEC Decoder',
        description:
            'Use enhanced NVDEC implementation. Disable to use CUVID if you encounter decoding errors.',
        defaultValue: true,
        section: 'ffmpeg-hardware',
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'nvenc' },
    },

    // VideoToolbox options (macOS)
    {
        key: 'VIDEOTOOLBOX_PRIO_SPEED',
        type: 'boolean',
        label: 'VideoToolbox Speed Priority',
        description:
            'Prioritize encoding speed over quality for Apple VideoToolbox. Enable for faster encoding, disable for better quality.',
        defaultValue: false,
        section: 'ffmpeg-hardware',
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'videotoolbox' },
    },

    // AMF options (AMD GPUs)
    {
        key: 'AMF_QUALITY',
        type: 'select',
        label: 'AMF Quality Preset',
        description: 'Quality vs speed tradeoff for AMD AMF encoder.',
        defaultValue: 'balanced',
        section: 'ffmpeg-hardware',
        validation: {
            options: [
                { value: 'quality', label: 'Quality (slower, better quality)' },
                { value: 'balanced', label: 'Balanced (default)' },
                { value: 'speed', label: 'Speed (faster, lower quality)' },
            ],
        },
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'amf' },
    },

    // Hardware decode options (only shown when GPU is selected)
    {
        key: 'HW_DECODE_CODECS',
        type: 'string',
        label: 'HW Decode Codecs',
        description:
            'Codecs to hardware decode (comma-separated). Options: h264, hevc, mpeg2, vc1, vp8, vp9, av1',
        defaultValue: 'h264,hevc,mpeg2,vp9,av1',
        section: 'ffmpeg-hardware',
        uiHints: { placeholder: 'h264,hevc,mpeg2,vp9,av1', advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', notEquals: 'none' },
    },
    {
        key: 'HW_DECODE_10BIT',
        type: 'string',
        label: 'HW Decode 10-bit',
        description:
            'Codecs to hardware decode in 10-bit mode (comma-separated). Options: hevc, vp9',
        defaultValue: 'hevc,vp9',
        section: 'ffmpeg-hardware',
        uiHints: { placeholder: 'hevc,vp9', advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', notEquals: 'none' },
    },
    {
        key: 'HW_PREFER_NATIVE_DECODERS',
        type: 'boolean',
        label: 'Prefer OS Native Decoders',
        description:
            'Prefer OS native DXVA (Windows) or VA-API (Linux) hardware decoders over codec-specific ones',
        defaultValue: true,
        section: 'ffmpeg-hardware',
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', notEquals: 'none' },
    },

    // Codec-family kill switches (apply to both hardware and software paths)
    {
        key: 'ALLOW_HEVC_ENCODING',
        type: 'boolean',
        label: 'Allow HEVC Encoding',
        description:
            'Allow HEVC (H.265) as a transcode target. Disabling forces fallback ' +
            'to H.264 for clients that would otherwise receive HEVC.',
        defaultValue: true,
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    {
        key: 'ALLOW_AV1_ENCODING',
        type: 'boolean',
        label: 'Allow AV1 Encoding',
        description:
            'Allow AV1 as a transcode target. Disabling forces fallback to HEVC/H.264. ' +
            'AV1 hardware encoding is fast on modern GPUs; software AV1 (libsvtav1) ' +
            'is too slow for real-time on most CPUs.',
        defaultValue: true,
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    {
        key: 'ALLOW_AV1_MSE_HLS',
        type: 'boolean',
        label: 'Allow AV1 for Chrome/Firefox (MSE-HLS)',
        description:
            'Allow AV1 as a transcode target for Chrome/Firefox (hls.js clients). Off by default: hls.js fMP4 AV1 parsing is unreliable cross-browser ' +
            'and can trigger fragParsingError. Safari and direct-file clients are unaffected.',
        defaultValue: false,
        section: 'ffmpeg',
        uiHints: { advanced: true },
        showWhen: { key: 'ALLOW_AV1_ENCODING', equals: true },
    },
    {
        key: 'SOFTWARE_ENCODE_MAX_WIDTH',
        type: 'number',
        label: 'Software Encoder Max Width',
        description:
            'Caps the output width on the software-encode fallback path. Above it, with no GPU encoder available, the codec selector forces H.264 ' +
            'because libx265/libsvtav1 cannot keep up at 4K on typical CPUs. Set 0 to remove the cap.',
        defaultValue: 1920,
        section: 'ffmpeg-hardware',
        uiHints: { advanced: true, placeholder: '1920' },
    },
    {
        key: 'SOFTWARE_CODEC_PREFERENCE',
        type: 'string',
        label: 'Software Codec Priority',
        description:
            'Codec priority when no GPU encoder is available (comma-separated). Defaults to H.264 first since libx264 is by far the fastest software encoder. ' +
            'Distinct from Encoder Preference, which targets specific encoder IDs.',
        defaultValue: 'h264,hevc,av1',
        section: 'ffmpeg-hardware',
        uiHints: { advanced: true, placeholder: 'h264,hevc,av1' },
    },
    {
        key: 'VIDEO_CODEC',
        type: 'select',
        label: 'Video Codec',
        description:
            'Preferred video codec. "Copy" passes through the original codec when the client supports it, otherwise transcodes to a compatible codec automatically.',
        defaultValue: 'copy',
        validation: {
            options: [
                { value: 'copy', label: 'Copy (passthrough)' },
                { value: 'h264', label: 'H.264' },
                { value: 'hevc', label: 'HEVC (H.265)' },
                { value: 'av1', label: 'AV1' },
            ],
        },
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    {
        key: 'VIDEO_CODEC_AUTO',
        type: 'boolean',
        label: 'Auto-detect Video Encoder',
        description: 'Automatically select best available encoder based on GPU',
        defaultValue: true,
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    {
        key: 'HW_ENCODING_ENABLED',
        type: 'boolean',
        label: 'Hardware Encoding',
        description: 'Use GPU for video encoding when available',
        defaultValue: true,
        section: 'ffmpeg-hardware',
    },
    {
        key: 'ENABLE_TONEMAPPING',
        type: 'boolean',
        label: 'HDR to SDR Tonemapping',
        description: 'Convert HDR content to SDR for non-HDR devices',
        defaultValue: true,
        section: 'ffmpeg',
    },
    {
        key: 'TONEMAPPING_ALGORITHM',
        type: 'select',
        label: 'Tonemapping Algorithm',
        description: 'Algorithm for HDR to SDR conversion',
        defaultValue: 'bt2390',
        validation: {
            options: [
                { value: 'bt2390', label: 'BT.2390 (Recommended)' },
                { value: 'hable', label: 'Hable (Filmic)' },
                { value: 'mobius', label: 'Mobius' },
                { value: 'reinhard', label: 'Reinhard' },
                { value: 'linear', label: 'Linear' },
            ],
        },
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    {
        key: 'ENABLE_HDR10_PRESERVATION',
        type: 'boolean',
        label: 'HDR10 Preservation',
        description: 'Preserve HDR10 quality when transcoding (DV Profile 8 → HDR10 fallback)',
        defaultValue: true,
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    {
        key: 'HLS_COPY_GOP_SEGMENTS',
        type: 'boolean',
        label: 'Exact Segments for Copied Video',
        description:
            'When video is passed through unchanged, cut it on its own keyframes and join the pieces into exact segments, so the player timeline (and subtitles) match the file after seeking or resuming. Turn off only to fall back to the previous segmenting if playback of copied video misbehaves.',
        defaultValue: true,
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    {
        key: 'HLS_BURN_IN_HDR_STRATEGY',
        type: 'select',
        label: 'HDR Subtitle Burn-in Strategy',
        description:
            'How to handle subtitle burn-in on HDR video. "Tonemap to SDR" (default) keeps GPU encoding but loses HDR; "Software" preserves HDR 10-bit at a higher CPU cost. Only affects HDR titles with burned-in (bitmap) subtitles.',
        defaultValue: 'tonemap',
        validation: {
            options: [
                { value: 'tonemap', label: 'Tonemap to SDR (GPU, default)' },
                { value: 'software', label: 'Software encode (keep HDR)' },
            ],
        },
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },

    // Intel QSV specific options
    {
        key: 'INTEL_LP_H264',
        type: 'boolean',
        label: 'Intel Low-Power H.264',
        description: 'Use low-power H.264 encoder on Intel QSV (faster, uses less power)',
        defaultValue: true,
        section: 'ffmpeg-hardware',
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'qsv' },
    },
    {
        key: 'INTEL_LP_HEVC',
        type: 'boolean',
        label: 'Intel Low-Power HEVC',
        description: 'Use low-power HEVC encoder on Intel QSV (faster, uses less power)',
        defaultValue: true,
        section: 'ffmpeg-hardware',
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'qsv' },
    },
    // No on/off toggle for hardware VPP tonemapping: when a GPU encoder is
    // selected, HDR->SDR tone mapping runs on the GPU automatically
    // (tonemap_vaapi / vpp_qsv). A software tonemap can't feed a hardware
    // encoder, so it was never a real choice — the old VPP_TONEMAPPING boolean
    // was removed. The QSV brightness/contrast knobs below fine-tune it.

    // Video encoding settings
    {
        key: 'VIDEO_BITRATE_MBPS',
        type: 'number',
        label: 'Video Bitrate',
        description: 'Target video bitrate in Mbps (0 = use CRF quality)',
        defaultValue: 0,
        section: 'ffmpeg',
        validation: { min: 0, max: 100 },
        uiHints: { suffix: 'Mbps', advanced: true },
    },
    {
        key: 'TRANSCODE_THREAD_COUNT',
        type: 'number',
        label: 'Thread Count',
        description: 'Number of threads for transcoding (0 = auto)',
        defaultValue: 0,
        section: 'ffmpeg',
        validation: { min: 0, max: 64 },
        uiHints: { advanced: true },
    },
    {
        key: 'ANALYSIS_FFMPEG_THREADS',
        type: 'number',
        label: 'Analysis Thread Count',
        description:
            'Decoder and filter threads per analysis operation (chromaprint, blackframe, silence, frame extraction). Default 2 limits memory use; explicit 0 lets FFmpeg decide.',
        defaultValue: 2,
        section: 'ffmpeg',
        validation: { min: 0, max: 64 },
        uiHints: { advanced: true },
    },

    // Audio encoding settings
    {
        key: 'AUDIO_CODEC',
        type: 'select',
        label: 'Audio Codec',
        description: 'Codec for audio transcoding',
        defaultValue: 'aac',
        validation: {
            options: [
                { value: 'aac', label: 'AAC (Recommended)' },
                { value: 'ac3', label: 'AC3 (Dolby Digital)' },
                { value: 'eac3', label: 'EAC3 (Dolby Digital Plus)' },
                { value: 'libopus', label: 'Opus' },
                { value: 'mp3', label: 'MP3' },
            ],
        },
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    {
        key: 'AUDIO_BITRATE_STEREO',
        type: 'string',
        label: 'Stereo Bitrate',
        description: 'Bitrate for stereo audio transcoding',
        defaultValue: '128k',
        section: 'ffmpeg',
        uiHints: { placeholder: '128k', advanced: true },
    },
    {
        key: 'AUDIO_BITRATE_SURROUND',
        type: 'string',
        label: 'Surround Bitrate',
        description: 'Bitrate for surround sound audio transcoding',
        defaultValue: '256k',
        section: 'ffmpeg',
        uiHints: { placeholder: '256k', advanced: true },
    },
    {
        key: 'AUDIO_VBR',
        type: 'boolean',
        label: 'Audio VBR',
        description: 'Use variable bitrate for audio (better quality at same size)',
        defaultValue: true,
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    {
        key: 'AUDIO_BOOST',
        type: 'number',
        label: 'Audio Boost',
        description: 'Volume multiplier for audio (1.0 = no change, 1.5 = 50% louder)',
        defaultValue: 1.0,
        section: 'ffmpeg',
        validation: { min: 0.5, max: 3.0 },
        uiHints: { step: 0.1, advanced: true },
    },
    {
        key: 'FFMPEG_PATH',
        type: 'path',
        label: 'FFmpeg Path',
        description: 'Path to FFmpeg binary',
        defaultValue: 'ffmpeg',
        section: 'ffmpeg',
        uiHints: { placeholder: '/config/bin/ffmpeg' },
    },
    {
        key: 'FFPROBE_PATH',
        type: 'path',
        label: 'FFprobe Path',
        description: 'Path to FFprobe binary (for media analysis)',
        defaultValue: 'ffprobe',
        section: 'ffmpeg',
        uiHints: { placeholder: '/config/bin/ffprobe' },
    },
    {
        key: 'FFMPEG_TRANSCODE_DIR',
        type: 'path',
        label: 'Transcode Directory',
        description: 'Directory for transcode output (should be fast storage)',
        defaultValue: '/tmp/lumastra-transcode',
        section: 'ffmpeg',
    },
    {
        key: 'FFMPEG_SEGMENT_DURATION',
        type: 'number',
        label: 'Segment Duration',
        description: 'HLS segment duration (Apple recommends 6)',
        defaultValue: 6,
        section: 'ffmpeg',
        validation: { min: 2, max: 10 },
        uiHints: { suffix: 'seconds', advanced: true },
    },
    {
        key: 'FFMPEG_INACTIVITY_TIMEOUT_SECONDS',
        type: 'number',
        label: 'Inactivity Timeout',
        description:
            'Kill a completed job if no segment requests AND no progress reports for this duration. Keep generous — the web client only sends a 30s keepalive while paused, which browsers throttle heavily on a backgrounded/minimized tab (worse on mobile), so a paused-and-tabbed-away viewer needs real headroom here to avoid a spurious session-expired.',
        defaultValue: 1800,
        section: 'ffmpeg',
        validation: { min: 60, max: 3600 },
        uiHints: { suffix: 'seconds', advanced: true },
    },
    {
        key: 'FFMPEG_PROGRESS_TIMEOUT_SECONDS',
        type: 'number',
        label: 'Progress Timeout',
        description: 'Kill job if no progress reports for this duration',
        defaultValue: 120,
        section: 'ffmpeg',
        validation: { min: 30, max: 600 },
        uiHints: { suffix: 'seconds', advanced: true },
    },
    {
        key: 'FFMPEG_AUDIO_DROP_INACTIVITY_TIMEOUT_SECONDS',
        type: 'number',
        label: 'Audio-only transcode retention',
        description:
            'How long an audio-only transcode job survives without client activity. Longer than the video default because the client buffers far ahead and may be offline in a tunnel; a full episode of audio is only ~43 MB.',
        defaultValue: 1800,
        section: 'ffmpeg',
        validation: { min: 120, max: 7200 },
        uiHints: { suffix: 'seconds', advanced: true },
    },
    {
        key: 'FFMPEG_UNWATCHED_JOB_TIMEOUT_SECONDS',
        type: 'number',
        label: 'Unwatched Job Timeout',
        description:
            'Kill a job that has produced segments but has never served one to a client (manifest fetched, no segment requests) after this duration since it started',
        defaultValue: 60,
        section: 'ffmpeg',
        validation: { min: 15, max: 600 },
        uiHints: { suffix: 'seconds', advanced: true },
    },
    {
        key: 'FFMPEG_CLIENT_GONE_TIMEOUT_SECONDS',
        type: 'number',
        label: 'Client Gone Timeout',
        description:
            'Stop a job that is still encoding once its client has sent no heartbeat and fetched no segment for this long (the session stays resumable). Audio-only jobs use the audio-drop inactivity timeout instead',
        defaultValue: 180,
        section: 'ffmpeg',
        validation: { min: 120, max: 3600 },
        uiHints: { suffix: 'seconds', advanced: true },
    },
    {
        key: 'LUMASTRA_MAX_CONCURRENT_TRANSCODES',
        type: 'number',
        label: 'Max Concurrent Transcodes (Server-wide)',
        description:
            'Hard cap on active transcode jobs across all users; when reached, a new request evicts the job that has gone longest without a play-session heartbeat or segment fetch, but only once it has been idle for the Minimum Idle Before Eviction. If every job is still being watched, the new request is refused with 503 instead of interrupting someone. Defaults to CPU cores × 3, clamped 12–32 — most concurrent sessions are cheap copy/remux passthroughs, not full transcodes. 0 disables the cap (not recommended).',
        defaultValue: 12,
        dynamicDefault: ({ cpuCores }) => videoTranscodeConcurrencyDefault(cpuCores),
        section: 'ffmpeg',
        validation: { min: 1, max: 64 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_TRANSCODE_EVICTION_MIN_IDLE_SECONDS',
        type: 'number',
        label: 'Minimum Idle Before Eviction',
        description:
            'How long a transcode job must have gone without EITHER a play-session heartbeat OR a segment fetch before the server-wide cap may evict it to admit a new stream. A job active more recently than this counts as someone watching and is never interrupted; the new stream is refused with 503 (Retry-After) instead. A viewer replacing their own session for the same title is always admitted. 0 restores the old behaviour of always evicting the idlest job, even one that is still playing.',
        defaultValue: 120,
        section: 'ffmpeg',
        validation: { min: 0, max: 3600 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_TRANSCODE_LOAD_SHED_RATIO',
        type: 'number',
        label: 'Transcode Load-Shed Ratio',
        description:
            'Emergency backstop: when the 1-minute load average per CPU core exceeds this ratio, new transcodes (video and music) are refused with 503. Unlike the preview breaker, this affects playback, so set it above your measured peak load. 0 disables it.',
        defaultValue: 0,
        section: 'ffmpeg',
        validation: { min: 0, max: 32 },
        uiHints: { advanced: true },
    },
    {
        key: 'FFMPEG_MAX_JOBS_PER_USER',
        type: 'number',
        label: 'Max Jobs Per User',
        description:
            'Maximum concurrent transcoding streams per user. Covers all active playback sessions that require transcoding. Stale jobs are automatically evicted.',
        defaultValue: 10,
        section: 'ffmpeg',
        validation: { min: 1, max: 20 },
        uiHints: { advanced: true },
    },
    {
        key: 'STREAM_LIMITS_ENFORCED',
        type: 'boolean',
        label: 'Enforce Stream Limits',
        description:
            'When off, the per-user concurrent-stream limit is not enforced anywhere (useful for debugging). Per-user policies and other policy checks (IP restriction, allowed play methods) still apply.',
        defaultValue: true,
        section: 'ffmpeg',
    },
    {
        key: 'TRUST_CLIENT_LOCAL_PLAYBACK',
        type: 'boolean',
        label: 'Trust "Playing From Download" Claims',
        description:
            'When a client reports that it is playing a file it already downloaded, exempt that session from the concurrent-stream limit. Such playback uses no bandwidth and no transcoding, so counting it can lock another household member out of a real stream. The claim is unverifiable — the server sees no bytes either way — so a modified client could send it to bypass the limit entirely. Off by default: sessions are still labelled "Downloaded" so you can see them, they just still count. Turn it on if you trust the apps your users run.',
        defaultValue: false,
        section: 'ffmpeg',
        dependsOn: 'STREAM_LIMITS_ENFORCED',
    },
    {
        key: 'DEFAULT_MAX_CONCURRENT_STREAMS',
        type: 'number',
        label: 'Default Max Concurrent Streams',
        description:
            'Global default for max parallel streams per user. -1 means no limit (the default). Overridden by a per-user stream policy row or a `__default__` policy row (managed via the admin stream-policy API).',
        defaultValue: -1,
        section: 'ffmpeg',
        validation: { min: -1, max: 20 },
    },
    {
        key: 'FFMPEG_MAX_GENERATIONS_PER_SESSION',
        type: 'number',
        label: 'Max HLS Generations Per Session',
        description:
            'Maximum active FFmpeg generations kept for one HLS playback session. One slot is the current seek target; remaining slots retain previous positions for stale client requests.',
        defaultValue: 2,
        section: 'ffmpeg',
        validation: { min: 1, max: 5 },
        uiHints: { suffix: 'generations', advanced: true },
    },
    {
        key: 'FFMPEG_PREVIOUS_GENERATION_TTL_SECONDS',
        type: 'number',
        label: 'Previous Generation TTL',
        description:
            'How long previous HLS generations may stay alive after their last access before cleanup.',
        defaultValue: 20,
        section: 'ffmpeg',
        validation: { min: 5, max: 300 },
        uiHints: { suffix: 'seconds', advanced: true },
    },
    {
        key: 'FFMPEG_FORWARD_SEEK_THRESHOLD',
        type: 'number',
        label: 'Forward Seek Threshold',
        description:
            'How many segments beyond produced progress must be requested before the server treats it as a forward seek and starts a new generation.',
        defaultValue: 15,
        section: 'ffmpeg',
        validation: { min: 1, max: 100 },
        uiHints: { suffix: 'segments', advanced: true },
    },
    {
        key: 'FFMPEG_SEGMENT_KEEP_BEHIND',
        type: 'number',
        label: 'Segments to Keep Behind',
        description: 'Segments kept for rewind (100 @ 6s = 10 min buffer)',
        defaultValue: 100,
        section: 'ffmpeg',
        validation: { min: 10, max: 500 },
        uiHints: { suffix: 'segments', advanced: true },
        dependsOn: 'FFMPEG_SEGMENT_DURATION',
    },
    {
        key: 'HLS_SEEK_WAIT_TIMEOUT_MS',
        type: 'number',
        label: 'Seek Segment Wait Timeout',
        description:
            'Maximum time the HLS segment endpoint waits for FFmpeg to produce a segment after a seek generation starts.',
        defaultValue: 45000,
        section: 'ffmpeg',
        validation: { min: 1000, max: 120000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'HLS_SEGMENT_WAIT_TIMEOUT_MS',
        type: 'number',
        label: 'Normal Segment Wait Timeout',
        description:
            'Maximum time the HLS segment endpoint waits for a not-yet-produced segment during normal playback.',
        defaultValue: 10000,
        section: 'ffmpeg',
        validation: { min: 500, max: 60000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'HLS_IFRAME_WAIT_TIMEOUT_MS',
        type: 'number',
        label: 'I-Frame Segment Wait Timeout',
        description:
            'Maximum time the HLS segment endpoint waits for synthetic I-frame scrubbing segments.',
        defaultValue: 30000,
        section: 'ffmpeg',
        validation: { min: 1000, max: 120000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'HLS_SEGMENT_POLL_INTERVAL_MS',
        type: 'number',
        label: 'Segment Poll Interval',
        description:
            'Polling interval used while waiting for FFmpeg to create requested HLS files.',
        defaultValue: 100,
        section: 'ffmpeg',
        validation: { min: 25, max: 1000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'HLS_SEGMENT_LOG_INTERVAL_MS',
        type: 'number',
        label: 'Segment Wait Log Interval',
        description:
            'Interval for repeated wait-loop diagnostics while a segment request is blocked on FFmpeg output.',
        defaultValue: 5000,
        section: 'ffmpeg',
        validation: { min: 500, max: 60000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'HLS_SEEK_COOLDOWN_MS',
        type: 'number',
        label: 'Seek Cooldown',
        description:
            'Cooldown after starting an HLS seek generation during which stale requests are prevented from starting competing seeks.',
        defaultValue: 5000,
        section: 'ffmpeg',
        validation: { min: 500, max: 30000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'HLS_REPEATED_SEGMENT_WINDOW_MS',
        type: 'number',
        label: 'Repeated Segment Window',
        description:
            'Time window used to detect repeated HLS requests for the same missing segment.',
        defaultValue: 15000,
        section: 'ffmpeg',
        validation: { min: 1000, max: 60000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'HLS_REPEATED_SEGMENT_PRESSURE_THRESHOLD',
        type: 'number',
        label: 'Repeated Segment Pressure Threshold',
        description:
            'Number of repeated requests in the detection window before the server logs segment request pressure.',
        defaultValue: 2,
        section: 'ffmpeg',
        validation: { min: 1, max: 20 },
        uiHints: { suffix: 'requests', advanced: true },
    },
    {
        key: 'HLS_REPEATED_PRESSURE_FORWARD_SEEK_THRESHOLD',
        type: 'number',
        label: 'Repeated Pressure Forward Seek Threshold',
        description:
            'How far ahead a repeated missing request must be before pressure diagnostics classify it as forward-seek related.',
        defaultValue: 10,
        section: 'ffmpeg',
        validation: { min: 1, max: 100 },
        uiHints: { suffix: 'segments', advanced: true },
    },
    {
        key: 'HLS_STALE_AUDIO_WARNING_COOLDOWN_MS',
        type: 'number',
        label: 'Stale Audio Warning Cooldown',
        description:
            'Cooldown for repeated server warnings about stale hls.js audio requests after seek.',
        defaultValue: 10000,
        section: 'ffmpeg',
        validation: { min: 1000, max: 120000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'HLS_STALE_AUDIO_REQUEST_AHEAD_THRESHOLD',
        type: 'number',
        label: 'Stale Audio Ahead Threshold',
        description:
            'How many segments ahead of the current offset an audio request must be before stale hls.js diagnostics are emitted.',
        defaultValue: 150,
        section: 'ffmpeg',
        validation: { min: 10, max: 2000 },
        uiHints: { suffix: 'segments', advanced: true },
    },
    {
        key: 'HLS_FAR_FROM_ORIGIN_THRESHOLD',
        type: 'number',
        label: 'Far From Origin Threshold',
        description:
            'Segment distance used by HLS seek heuristics to distinguish normal startup from far seek behavior.',
        defaultValue: 200,
        section: 'ffmpeg',
        validation: { min: 10, max: 5000 },
        uiHints: { suffix: 'segments', advanced: true },
    },
    {
        key: 'SYNTHETIC_IFRAME_INTERVAL_SECONDS',
        type: 'number',
        label: 'I-Frame Interval',
        description:
            'Interval for synthetic I-frame playlist used by the /api/v1 HLS endpoint ' +
            'for scrubbing thumbnails (0 = use all keyframes)',
        defaultValue: 0,
        section: 'ffmpeg',
        validation: { min: 0, max: 30 },
        uiHints: { suffix: 'seconds', advanced: true },
        dependsOn: 'FFMPEG_SEGMENT_DURATION',
    },
    {
        key: 'DEBUG_SUBTITLES',
        type: 'boolean',
        label: 'Debug Subtitles',
        description:
            'Generate timing debug subtitle track in the /api/v1 HLS endpoint ' +
            'for AVPlayer testing and diagnostics',
        defaultValue: false,
        section: 'ffmpeg',
        dependsOn: 'FFMPEG_SEGMENT_DURATION',
    },
    // Tonemapping parameters
    {
        key: 'TONEMAPPING_DESAT',
        type: 'number',
        label: 'Tonemapping Desaturation',
        description: 'Highlight desaturation for HDR→SDR (0 = preserve color, 1 = fade to white)',
        defaultValue: 0.5,
        section: 'ffmpeg',
        validation: { min: 0, max: 1 },
        uiHints: { step: 0.05, advanced: true },
        dependsOn: 'ENABLE_TONEMAPPING',
    },
    {
        key: 'TONEMAPPING_PEAK',
        type: 'number',
        label: 'Tonemapping Peak',
        description: 'Override signal peak in nits (0 = auto-detect from stream metadata)',
        defaultValue: 0,
        section: 'ffmpeg',
        validation: { min: 0, max: 10000 },
        uiHints: { advanced: true },
        dependsOn: 'ENABLE_TONEMAPPING',
    },
    {
        key: 'TONEMAPPING_PARAM',
        type: 'number',
        label: 'Tonemapping Param',
        description: 'Algorithm-specific tuning parameter (0 = use algorithm default)',
        defaultValue: 0,
        section: 'ffmpeg',
        validation: { min: 0, max: 100 },
        uiHints: { advanced: true },
        dependsOn: 'ENABLE_TONEMAPPING',
    },
    {
        key: 'VPP_TONEMAPPING_BRIGHTNESS',
        type: 'number',
        label: 'QSV Tonemap Brightness',
        description:
            'Brightness gain for the automatic Intel QSV HDR→SDR tonemap (default 16, recommended 0-16). Only applies while HDR→SDR tonemapping is enabled (Transcoding section). VA-API tonemapping ignores this.',
        defaultValue: 16,
        section: 'ffmpeg-hardware',
        validation: { min: 0, max: 100 },
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'qsv' },
    },
    {
        key: 'VPP_TONEMAPPING_CONTRAST',
        type: 'number',
        label: 'QSV Tonemap Contrast',
        description:
            'Contrast gain for the automatic Intel QSV HDR→SDR tonemap (default 1.0). Only applies while HDR→SDR tonemapping is enabled (Transcoding section). VA-API tonemapping ignores this.',
        defaultValue: 1.0,
        section: 'ffmpeg-hardware',
        validation: { min: 0.1, max: 10 },
        uiHints: { step: 0.1, advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'qsv' },
    },
    // Deinterlacing
    {
        key: 'DEINTERLACE_METHOD',
        type: 'select',
        label: 'Deinterlace Method',
        description: 'Algorithm for software deinterlacing of interlaced content',
        defaultValue: 'yadif',
        section: 'ffmpeg',
        validation: {
            options: [
                { value: 'yadif', label: 'Yadif (default, good quality)' },
                { value: 'bwdif', label: 'Bwdif (better motion handling)' },
                { value: 'w3fdif', label: 'W3FDIF (multi-frame)' },
            ],
        },
        uiHints: { advanced: true },
    },
    {
        key: 'DEINTERLACE_DOUBLE_RATE',
        type: 'boolean',
        label: 'Deinterlace Double Rate',
        description: 'Use field rate instead of frame rate when deinterlacing (bob deinterlacing)',
        defaultValue: false,
        section: 'ffmpeg',
        uiHints: { advanced: true },
        dependsOn: 'DEINTERLACE_METHOD',
    },
    // Resolution and bitrate caps
    {
        key: 'MAX_WIDTH',
        type: 'number',
        label: 'Max Output Width',
        description: 'Maximum output resolution width (0 = no limit, preserve source)',
        defaultValue: 0,
        section: 'ffmpeg',
        validation: { min: 0, max: 7680 },
        uiHints: { suffix: 'px', advanced: true },
    },
    {
        key: 'MAX_HEIGHT',
        type: 'number',
        label: 'Max Output Height',
        description: 'Maximum output resolution height (0 = no limit, preserve source)',
        defaultValue: 0,
        section: 'ffmpeg',
        validation: { min: 0, max: 4320 },
        uiHints: { suffix: 'px', advanced: true },
    },
    {
        key: 'MAX_MUXING_QUEUE_SIZE',
        type: 'number',
        label: 'Max Muxing Queue Size',
        description: 'FFmpeg muxing queue size. High value prevents AV1 audio/video sync crashes.',
        defaultValue: 9999,
        section: 'ffmpeg',
        validation: { min: 100, max: 99999 },
        uiHints: { advanced: true },
    },
    // Subtitle and throttle
    {
        key: 'SUBTITLE_CACHE_MAX_BYTES',
        type: 'number',
        label: 'Subtitle Cache Size Budget',
        description:
            'Max total bytes for the central subtitle cache (text + binary PGS/VobSub/rendered). Least recently used files are evicted when over budget. Bitmap subtitles cost a full read of the media file to redo, so keep this generous; files stored alongside media are not counted. Set 0 to disable.',
        defaultValue: 50 * 1024 * 1024 * 1024,
        section: 'ffmpeg',
        validation: { min: 0 },
        uiHints: { suffix: 'bytes', advanced: true },
    },
    {
        key: 'TRANSCODE_THROTTLE',
        type: 'boolean',
        label: 'Transcode Throttle',
        description:
            'Pause FFmpeg while it is far enough ahead of the player, and continue it as playback catches up. Saves CPU/GPU on long transcodes; the player shows the pause in its transcode badge.',
        defaultValue: true,
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    {
        key: 'THROTTLE_AFTER_SECONDS',
        type: 'number',
        label: 'Throttle Buffer Ahead',
        description:
            'How far (in media seconds) FFmpeg may run ahead of the newest segment the player requested before it is paused. It resumes once the lead drops below half of this.',
        defaultValue: 120,
        section: 'ffmpeg',
        validation: { min: 30, max: 600 },
        uiHints: { suffix: 'seconds', advanced: true },
        dependsOn: 'TRANSCODE_THROTTLE',
    },
    {
        key: 'DELETE_SEGMENTS',
        type: 'boolean',
        label: 'Delete Old Segments',
        description: 'Delete transcoded segments after they are downloaded to save disk space',
        defaultValue: true,
        section: 'ffmpeg',
        uiHints: { advanced: true },
    },
    // Codec-specific CRF
    {
        key: 'H264_CRF',
        type: 'number',
        label: 'H.264 CRF',
        description:
            'Constant Rate Factor for H.264 software encoding (0-51, lower = better quality, 18-23 typical)',
        defaultValue: 23,
        section: 'ffmpeg-hardware',
        validation: { min: 0, max: 51 },
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'none' },
    },
    {
        key: 'H265_CRF',
        type: 'number',
        label: 'H.265 CRF',
        description:
            'Constant Rate Factor for H.265/HEVC software encoding (0-51, lower = better quality, 24-28 typical)',
        defaultValue: 28,
        section: 'ffmpeg-hardware',
        validation: { min: 0, max: 51 },
        uiHints: { advanced: true },
        showWhen: { key: 'GPU_ACCELERATION', equals: 'none' },
    },
    {
        key: 'ENCODING_PRESET',
        type: 'select',
        label: 'Global Encoding Preset',
        description: 'Overrides the per-codec software preset for all software encoders',
        defaultValue: 'veryfast',
        section: 'ffmpeg-hardware',
        validation: {
            options: [
                { value: 'ultrafast', label: 'Ultrafast' },
                { value: 'superfast', label: 'Superfast' },
                { value: 'veryfast', label: 'Veryfast (recommended)' },
                { value: 'faster', label: 'Faster' },
                { value: 'fast', label: 'Fast' },
                { value: 'medium', label: 'Medium' },
                { value: 'slow', label: 'Slow' },
            ],
        },
        uiHints: { advanced: true },
    },
    // =========================================================================
    // Device Auth (OAuth 2.0)
    // =========================================================================
    {
        key: 'FEATURE_DEVICE_AUTH',
        type: 'boolean',
        label: 'Enable Public API',
        description:
            'Enable the /api/v1/* token API surface and OAuth 2.0 device authorization for TV apps and external clients',
        // ON by default since v0.1 (2026-09-27): the native iPhone/iPad/Apple TV
        // apps sign in through the device flow and register push tokens on
        // /api/v1, so a fresh install with this off had no working native client.
        // Must match the config.ts getter fallback.
        defaultValue: true,
        section: 'deviceAuth',
    },
    {
        key: 'JWT_ACCESS_TOKEN_TTL_SECONDS',
        type: 'number',
        label: 'Access Token TTL',
        description: 'How long access tokens are valid',
        defaultValue: 3600,
        section: 'deviceAuth',
        validation: { min: 300, max: 86400 },
        uiHints: { suffix: 'seconds', advanced: true },
        dependsOn: 'FEATURE_DEVICE_AUTH',
    },
    {
        key: 'JWT_REFRESH_TOKEN_TTL_DAYS',
        type: 'number',
        label: 'Refresh Token TTL',
        description: 'How long refresh tokens are valid',
        defaultValue: 90,
        section: 'deviceAuth',
        validation: { min: 1, max: 365 },
        uiHints: { suffix: 'days', advanced: true },
        dependsOn: 'FEATURE_DEVICE_AUTH',
    },
    {
        key: 'DEVICE_CODE_TTL_SECONDS',
        type: 'number',
        label: 'Device Code TTL',
        description: 'How long device codes are valid',
        defaultValue: 600,
        section: 'deviceAuth',
        validation: { min: 60, max: 1800 },
        uiHints: { suffix: 'seconds', advanced: true },
        dependsOn: 'FEATURE_DEVICE_AUTH',
    },
    {
        key: 'DEVICE_CODE_POLL_INTERVAL_SECONDS',
        type: 'number',
        label: 'Poll Interval',
        description: 'How often devices should poll for authorization',
        defaultValue: 5,
        section: 'deviceAuth',
        validation: { min: 1, max: 30 },
        uiHints: { suffix: 'seconds', advanced: true },
        dependsOn: 'FEATURE_DEVICE_AUTH',
    },
    {
        key: 'DEVICE_VERIFICATION_BASE_URL',
        type: 'string',
        label: 'Device Verification Base URL',
        get description() {
            return m.config_device_verification_base_url_help();
        },
        defaultValue: '',
        validation: { pattern: '^(?:https?://|$)' },
        section: 'deviceAuth',
        uiHints: {
            placeholder: 'https://lumastra.example.com',
            advanced: true,
        },
        dependsOn: 'FEATURE_DEVICE_AUTH',
    },
    {
        key: 'MIN_CLIENT_VERSION_IOS',
        type: 'string',
        get label() {
            return m.config_min_client_version_label({ platform: 'iOS' });
        },
        get description() {
            return m.config_min_client_version_help();
        },
        defaultValue: '',
        section: 'deviceAuth',
        validation: { pattern: `(?:^$)|(?:${CLIENT_VERSION_PATTERN})` },
        uiHints: { placeholder: '1.2.3', advanced: true },
    },
    {
        key: 'MIN_CLIENT_VERSION_TVOS',
        type: 'string',
        get label() {
            return m.config_min_client_version_label({ platform: 'tvOS' });
        },
        get description() {
            return m.config_min_client_version_help();
        },
        defaultValue: '',
        section: 'deviceAuth',
        validation: { pattern: `(?:^$)|(?:${CLIENT_VERSION_PATTERN})` },
        uiHints: { placeholder: '1.2.3', advanced: true },
    },
    {
        key: 'MIN_CLIENT_VERSION_WEB',
        type: 'string',
        get label() {
            return m.config_min_client_version_label({ platform: 'Web' });
        },
        get description() {
            return m.config_min_client_version_help();
        },
        defaultValue: '',
        section: 'deviceAuth',
        validation: { pattern: `(?:^$)|(?:${CLIENT_VERSION_PATTERN})` },
        uiHints: { placeholder: '1.2.3', advanced: true },
    },
    {
        key: 'MIN_CLIENT_VERSION_OTHER',
        type: 'string',
        get label() {
            return m.config_min_client_version_label({
                platform: m.config_min_client_version_other(),
            });
        },
        get description() {
            return m.config_min_client_version_help();
        },
        defaultValue: '',
        section: 'deviceAuth',
        validation: { pattern: `(?:^$)|(?:${CLIENT_VERSION_PATTERN})` },
        uiHints: { placeholder: '1.2.3', advanced: true },
    },
    {
        key: 'PUBLIC_BASE_URL',
        type: 'url',
        get label() {
            return m.public_base_url_label();
        },
        get description() {
            return m.public_base_url_description();
        },
        defaultValue: '',
        section: 'network',
        requiresRestart: false,
        uiHints: { placeholder: 'https://lumastra.example.com' },
    },
    {
        key: 'FEATURE_USER_PATS',
        type: 'boolean',
        label: 'User PAT Creation',
        description: 'Allow users to create their own Personal Access Tokens',
        defaultValue: false,
        section: 'deviceAuth',
        dependsOn: 'FEATURE_DEVICE_AUTH',
    },

    // =========================================================================
    // Streaming Sessions
    // =========================================================================
    {
        key: 'SESSIONS_REFRESH_INTERVAL_MS',
        type: 'number',
        label: 'Server Refresh Interval',
        description:
            'How often the server refreshes active session data from Jellyfin (when Jellyfin sync is enabled)',
        defaultValue: 5000,
        section: 'streaming',
        validation: { min: 1000, max: 60000 },
        uiHints: { advanced: true, suffix: 'ms' },
        dependsOn: 'FEATURE_SESSIONS',
    },
    {
        key: 'SESSIONS_POLL_INTERVAL_MS',
        type: 'number',
        label: 'Client Poll Interval',
        description: 'How often the browser polls for session updates (Now Streaming widget)',
        defaultValue: 5000,
        section: 'streaming',
        validation: { min: 1000, max: 60000 },
        uiHints: { advanced: true, suffix: 'ms' },
        dependsOn: 'FEATURE_SESSIONS',
    },
    {
        key: 'LIVETV_REFRESH_INTERVAL_MS',
        type: 'number',
        label: 'Live TV Refresh Interval',
        description: 'How often to refresh Live TV program info (EPG/channel list)',
        defaultValue: 13000,
        section: 'livetv',
        validation: { min: 5000, max: 60000 },
        uiHints: { advanced: true, suffix: 'ms' },
        dependsOn: 'FEATURE_LIVETV',
    },

    // LiveTV Provider & Proxy Settings
    {
        key: 'LIVETV_SOURCE',
        type: 'select',
        label: 'Live TV Source',
        description:
            'Where Live TV channels come from. "standalone" (the default) uses M3U/XMLTV with the stream proxy; "disabled" turns the source off while leaving the feature flag on. On/off is normally controlled by FEATURE_LIVETV.',
        defaultValue: 'standalone',
        validation: {
            options: [
                { value: 'disabled', label: 'Disabled' },
                { value: 'standalone', label: 'Standalone (M3U/XMLTV)' },
            ],
        },
        section: 'livetv',
        dependsOn: 'FEATURE_LIVETV',
    },
    {
        key: 'STREAM_PROXY_URL',
        type: 'string',
        label: 'Stream Proxy URL',
        description: 'URL of the stream proxy server. Required for standalone mode.',
        defaultValue: '',
        section: 'livetv',
        uiHints: { placeholder: 'http://lumastra-proxy:3000' },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'STREAM_PROXY_SECRET',
        type: 'string',
        label: 'Stream Proxy Secret',
        description:
            'Shared authentication secret for stream proxy. Minimum 16 characters recommended.',
        defaultValue: '',
        section: 'livetv',
        uiHints: {
            sensitive: true,
            placeholder: '••••••••••••••••',
        },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_ALLOW_PRIVATE_URLS',
        type: 'boolean',
        get label() {
            return m.livetv_admin_private_urls_label();
        },
        get description() {
            return m.livetv_admin_private_urls_description();
        },
        defaultValue: false,
        section: 'livetv',
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_ADAPTIVE_LADDER_ENABLED',
        type: 'boolean',
        label: 'Adaptive Quality Ladder',
        description:
            'Enable synchronized multi-quality Live TV playback. When disabled, clients use Original and cannot request ladder encoders.',
        defaultValue: false,
        section: 'livetv',
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_DEFAULT_QUALITY',
        type: 'select',
        label: 'Default Live TV Quality',
        description:
            'Initial quality for clients that follow the server default. Users may override it on their device.',
        defaultValue: 'adaptive',
        section: 'livetv',
        validation: {
            options: [
                { value: 'adaptive', label: 'Adaptive' },
                { value: 'original', label: 'Original' },
                { value: '1080p8m', label: '1080p · 8 Mbps' },
                { value: '720p4m', label: '720p · 4 Mbps' },
                { value: '540p2m', label: '540p · 2 Mbps' },
                { value: '360p1m', label: '360p · 1 Mbps' },
            ],
        },
        dependsOn: 'LIVETV_ADAPTIVE_LADDER_ENABLED',
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_CAP_FALLBACK',
        type: 'select',
        label: 'When a Quality Cannot Be Produced',
        description:
            'What to serve when a requested quality is not possible (HDR, an unreadable source, too low a resolution for the ladder, or no encoder slots free). "Serve the original" keeps the channel watchable at source quality; "Refuse" fails the request instead.',
        defaultValue: 'source',
        section: 'livetv',
        validation: {
            options: [
                { value: 'source', label: 'Serve the original stream' },
                { value: 'refuse', label: 'Refuse playback' },
            ],
        },
        dependsOn: 'LIVETV_ADAPTIVE_LADDER_ENABLED',
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_ADAPTIVE_INCLUDE_ORIGINAL',
        type: 'boolean',
        label: 'Include Original in Adaptive (Experimental)',
        description:
            'Permit eligible source quality as the highest Adaptive variant. The server still omits it when codec, HDR, bitrate, or segment alignment is unsafe.',
        defaultValue: false,
        section: 'livetv',
        dependsOn: 'LIVETV_ADAPTIVE_LADDER_ENABLED',
        uiHints: { advanced: true },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_UPSTREAM_PROXY_URL',
        type: 'string',
        label: 'Upstream Proxy URL',
        description:
            'Forward HTTP-CONNECT proxy for outbound LiveTV→provider traffic, hiding the server IP. Leave empty for direct connections; inline credentials are supported (http://user:pass@proxy:8080). Distinct from STREAM_PROXY_URL. ' +
            'IMPORTANT: this UI value only covers M3U/XMLTV import, channel logos, and Xtream validation. The stream-proxy container reads the proxy only from its own ENVIRONMENT, so you MUST ALSO set LIVETV_UPSTREAM_PROXY_URL as an env var on the stream-proxy container, or live stream playback will NOT be proxied and will still expose your IP. SOCKS-only providers need a socks→http shim.',
        defaultValue: '',
        section: 'livetv',
        uiHints: { advanced: true, sensitive: true, placeholder: 'http://proxy.internal:8080' },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_VIEWER_TIMEOUT_SECONDS',
        type: 'number',
        label: 'Viewer heartbeat timeout (seconds)',
        description:
            'How long without a heartbeat before a viewer session expires. Increase if clients frequently disconnect (e.g. slow mobile connections).',
        defaultValue: 30,
        section: 'livetv',
        validation: { min: 10, max: 300 },
        uiHints: { suffix: 'seconds' },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_HIDE_OFFLINE_AFTER_FAILURES',
        type: 'number',
        label: 'Hide offline channels after failures',
        description:
            'Hide a channel from viewers once every feed of it failed this many times in a row. 0 keeps every channel visible. A hidden channel reappears after 6 hours so one viewer can try it again, and administrators always see all channels.',
        defaultValue: 0,
        section: 'livetv',
        validation: { min: 0, max: 50 },
        uiHints: { advanced: true, suffix: 'failures' },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_GRACE_PERIOD_SECONDS',
        type: 'number',
        label: 'Stream grace period (seconds)',
        description:
            'How long to keep FFmpeg running after the last viewer leaves, so rejoining is instant.',
        defaultValue: 30,
        section: 'livetv',
        validation: { min: 0, max: 300 },
        uiHints: { suffix: 'seconds' },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_SHOW_ACTIVE_STREAMS',
        type: 'boolean',
        label: 'Show Active Streams to Users',
        description:
            'When a stream limit is reached, show users who is currently watching. Disable for privacy.',
        defaultValue: true,
        section: 'livetv',
        showWhen: { key: 'LIVETV_SOURCE', notEquals: 'disabled' },
    },
    {
        key: 'LIVETV_VIEWER_FEED_CHOICE',
        type: 'boolean',
        label: "Let viewers choose a channel's feed",
        description:
            'A station often comes in several feeds (FHD, HD, SD, a transcoded or mobile feed), bundled in a backup group. Viewers get one of them. When this is on, viewers can right-click (or long-press) a channel, or open Feed in the player, to watch another feed of the station, including feeds you hid; feeds in hidden categories are never offered. When it is off, viewers can only play feeds you have not hidden.',
        defaultValue: true,
        section: 'livetv',
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_HIDE_QUALITY_TAGS',
        type: 'boolean',
        label: 'Clean up channel names',
        description:
            'Show viewers the station\'s name without the provider\'s section tag (a country such as "UK:" or "DE •", a "[Bouquet]", or a tag several channels share such as "SVC:") and without quality and feed markers (FHD/HD/UHD/SD and their "raw" variants such as HDraw, HEVC, 50FPS, (Alt 2), *, superscripts ¹²³, WEB, and a trailing Cable/Kabel/SAT/RAW), so "UK: Channel One HDraw Cable" becomes "Channel One". A tag stays when it tells two channels apart ("UK: History" next to "US: History"). Admin views, guide matching and search keep the provider\'s name; per-channel admin renames always take precedence.',
        defaultValue: true,
        section: 'livetv',
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_KEEP_HIDDEN_CHANNEL_NUMBERS',
        type: 'boolean',
        label: 'Keep numbers of hidden channels',
        description:
            'Every channel viewers see gets a channel number that stays the same when you reorder channels or categories, refresh the playlist or re-import it. When this is off, a channel you hide gives its number up, and it gets a new number at the end when you show it again. When this is on, the number stays reserved for it while the channel exists. Numbers you typed in yourself (pinned) are always kept.',
        defaultValue: false,
        section: 'livetv',
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_HIGH_PRIORITY_GROUPS',
        type: 'array',
        label: 'High Priority Groups',
        description:
            'Users in these groups can evict lower-priority viewers when the stream limit is reached. Default: admin.',
        defaultValue: ['admin'],
        section: 'livetv',
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
        uiHints: { groups: true },
    },
    {
        key: 'LIVETV_KICK_POLICY',
        type: 'select',
        label: 'Eviction Policy',
        description:
            'Which low-priority viewer to kick when a high-priority user needs a stream slot.',
        defaultValue: 'shortest',
        section: 'livetv',
        options: [
            {
                value: 'shortest',
                label: 'Shortest watching (kick the most recent viewer)',
            },
            {
                value: 'longest',
                label: 'Longest watching (kick the oldest viewer)',
            },
        ],
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },

    // Streaming session management
    {
        key: 'STREAMING_SESSION_EXPIRY_HOURS',
        type: 'number',
        label: 'Session Token Expiry',
        description:
            'How long HLS streaming session tokens remain valid (renewed during active playback)',
        defaultValue: 24,
        section: 'streaming',
        // streaming-session.service.ts clamps every token lifetime to 72 h.
        validation: { min: 1, max: 72 },
        uiHints: { suffix: 'hours', advanced: true },
    },
    {
        key: 'STREAMING_SESSION_INACTIVITY_MINUTES',
        type: 'number',
        label: 'Session Inactivity Timeout',
        description: 'End a streaming session after this many minutes with no segment requests',
        defaultValue: 120,
        section: 'streaming',
        validation: { min: 10, max: 1440 },
        uiHints: { suffix: 'minutes', advanced: true },
    },

    // --- Live TV Proxy Transcoding ---
    {
        key: 'LIVETV_PROXY_TRANSCODE_MODE',
        type: 'select',
        label: 'Proxy Transcode Mode',
        description:
            'How the stream proxy handles video encoding. "auto" probes each source and remuxes when possible (recommended). "always" re-encodes everything (current legacy behavior). "remux" always copies without re-encoding.',
        defaultValue: 'auto',
        section: 'livetv',
        validation: {
            options: [
                {
                    value: 'auto',
                    label: 'Auto (probe-first, remux when possible)',
                    uiHints: { advanced: true },
                },
                { value: 'always', label: 'Always transcode' },
                { value: 'remux', label: 'Always remux (copy)' },
            ],
        },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_PROXY_GPU',
        type: 'select',
        label: 'Proxy GPU Acceleration',
        description:
            'Hardware acceleration for the stream proxy. "inherit" uses the global GPU_ACCELERATION setting.',
        defaultValue: 'inherit',
        section: 'livetv',
        validation: {
            options: [
                { value: 'inherit', label: 'Inherit from GPU Acceleration' },
                { value: 'none', label: 'None (software)' },
                { value: 'nvenc', label: 'NVIDIA NVENC' },
                { value: 'qsv', label: 'Intel Quick Sync' },
                { value: 'vaapi', label: 'VAAPI' },
                { value: 'amf', label: 'AMD AMF (Windows) - untested' },
                {
                    value: 'videotoolbox',
                    label: 'VideoToolbox (macOS) - untested',
                    uiHints: { advanced: true },
                },
            ],
        },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
        requiresRestart: true,
    },
    {
        key: 'LIVETV_ALLOW_HEVC_PASSTHROUGH',
        type: 'boolean',
        label: 'Allow HEVC Passthrough',
        description:
            'When enabled, H.265/HEVC progressive streams are passed through without re-encoding. Disable to force H.264 for maximum browser compatibility.',
        defaultValue: true,
        section: 'livetv',
        uiHints: { advanced: true },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_PROXY_TARGET_CODEC',
        type: 'select',
        label: 'Target Codec (when transcoding)',
        description:
            'Codec to encode to when the source requires transcoding (interlaced, MPEG-2, etc.).',
        defaultValue: 'h264',
        section: 'livetv',
        validation: {
            options: [
                { value: 'h264', label: 'H.264 (maximum compatibility)' },
                {
                    value: 'hevc',
                    label: 'H.265/HEVC (better quality, less compatible)',
                    uiHints: { advanced: true },
                },
            ],
        },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_PROXY_CRF',
        type: 'number',
        label: 'Proxy CRF (quality)',
        description:
            'Constant Rate Factor for software/hardware encoding. Lower = better quality, higher file size. 18-23 recommended for H.264, 20-28 for H.265.',
        defaultValue: 23,
        section: 'livetv',
        validation: { min: 0, max: 51 },
        uiHints: { advanced: true },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_PROXY_PRESET',
        type: 'select',
        label: 'Proxy Encoding Preset',
        description:
            'Speed/quality trade-off for software encoding. Faster presets use less CPU but produce larger output.',
        defaultValue: 'veryfast',
        section: 'livetv',
        validation: {
            options: [
                { value: 'ultrafast', label: 'Ultrafast' },
                { value: 'superfast', label: 'Superfast' },
                { value: 'veryfast', label: 'Very Fast (recommended)' },
                { value: 'faster', label: 'Faster' },
                { value: 'fast', label: 'Fast' },
                { value: 'medium', label: 'Medium' },
                { value: 'slow', label: 'Slow' },
            ],
            uiHints: { advanced: true },
        },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_DEINTERLACE_FILTER',
        type: 'select',
        label: 'Deinterlace Filter',
        description:
            'Filter used for interlaced sources. yadif is fast and reliable. bwdif is higher quality but slower. "none" skips deinterlacing (may cause artifacts in browsers).',
        defaultValue: 'yadif',
        section: 'livetv',
        validation: {
            options: [
                { value: 'yadif', label: 'yadif (fast, recommended)' },
                { value: 'bwdif', label: 'bwdif (higher quality)' },
                { value: 'none', label: 'None (skip deinterlacing)' },
            ],
            uiHints: { advanced: true },
        },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },
    {
        key: 'LIVETV_AUDIO_PASSTHROUGH',
        type: 'boolean',
        label: 'Audio Passthrough (AAC)',
        description:
            'When enabled, AAC audio streams are passed through without re-encoding. Non-AAC audio (AC-3, MP2) is always transcoded to AAC for browser compatibility.',
        defaultValue: false,
        section: 'livetv',
        uiHints: { advanced: true },
        showWhen: { key: 'LIVETV_SOURCE', equals: 'standalone' },
    },

    {
        key: 'STREAMING_SESSION_ENFORCE_IP',
        type: 'boolean',
        label: 'Validate IP for IP-Bound Stream Sessions',
        description:
            'Validates the client IP for streaming sessions that already have one bound, so a copied stream token cannot be replayed from another network. Wildcard-IP tokens from "Allow Any IP for New Stream Tokens" skip this check. ' +
            'Disable only if legitimate clients change IP mid-playback (mobile networks, VPN reconnects, IP-rewriting proxies); for AirPlay/Chromecast, keep this enabled and use wildcard IP creation instead.',
        defaultValue: true,
        section: 'deviceAuth',
        uiHints: { advanced: true },
        dependsOn: 'FEATURE_DEVICE_AUTH',
    },

    // =========================================================================
    // Watch Together (section: watchTogether)
    // =========================================================================
    {
        key: 'WATCH_TOGETHER_HOST_ABSENT_MINUTES',
        type: 'number',
        label: 'End Party When Host Is Gone',
        description:
            'Minutes after which a watch party ends for everyone when its host has had no ' +
            'connection and sent no heartbeat. Keep it long enough for a host who briefly ' +
            'leaves the app to come back.',
        defaultValue: 10,
        section: 'watchTogether',
        validation: { min: 1, max: 1440 },
        uiHints: { suffix: 'min', advanced: true },
        dependsOn: 'FEATURE_WATCH_TOGETHER',
    },
    {
        key: 'WATCH_TOGETHER_MAX_RECONNECT_MS',
        type: 'number',
        label: 'Max Reconnect Delay',
        description:
            'Longest wait between watch-together reconnect attempts. Attempts back off ' +
            'exponentially up to this ceiling; lower it so a flaky connection retries more ' +
            'often. This is not a give-up deadline — the retry count is fixed.',
        defaultValue: 30000,
        section: 'watchTogether',
        validation: { min: 5000, max: 120000 },
        uiHints: { suffix: 'ms', advanced: true },
        dependsOn: 'FEATURE_WATCH_TOGETHER',
    },
    {
        key: 'WATCH_PARTIES_REFRESH_MS',
        type: 'number',
        label: 'Parties List Refresh',
        description: 'How often to refresh the active watch parties list',
        defaultValue: 15000,
        section: 'watchTogether',
        validation: { min: 5000, max: 60000 },
        uiHints: { suffix: 'ms', advanced: true },
        dependsOn: 'FEATURE_WATCH_TOGETHER',
    },

    // =========================================================================
    // For You / AI Recommendations - Basic Settings
    // =========================================================================
    {
        key: 'FORYOU_MIN_RATINGS',
        type: 'number',
        label: 'Minimum Ratings Required',
        description: 'User ratings needed before AI recommendations activate',
        defaultValue: 5,
        section: 'foryou',
        validation: { min: 1, max: 20 },
    },
    {
        key: 'FORYOU_MIN_WATCHED',
        type: 'number',
        label: 'Minimum Watched Items Required',
        description:
            'Watched movies/shows needed to seed AI recommendations from watch history when a user has too few ratings',
        defaultValue: 10,
        section: 'foryou',
        validation: { min: 1, max: 100 },
    },
    {
        key: 'FORYOU_DEFAULT_LIMIT',
        type: 'number',
        label: 'Default Items Per Section',
        description: 'Default number of items in recommendation sections',
        defaultValue: 10,
        section: 'foryou',
        validation: { min: 5, max: 50 },
    },
    {
        key: 'FORYOU_SIMILAR_CACHE_HOURS',
        type: 'number',
        label: 'Similar Media Cache TTL',
        description: 'Cache duration for similar media results',
        defaultValue: 24,
        section: 'foryou',
        validation: { min: 1, max: 168 },
        uiHints: { advanced: true, suffix: 'hours' },
    },

    // For You - "Because You Watched" Settings
    {
        key: 'FORYOU_SOURCES_LIMIT',
        type: 'number',
        label: '"Because You Watched" Sources',
        description: 'Number of source movies for "Because you watched X"',
        defaultValue: 3,
        section: 'foryou',
        validation: { min: 1, max: 10 },
    },
    {
        key: 'FORYOU_SIMILAR_PER_SOURCE',
        type: 'number',
        label: 'Similar Items Per Source',
        description: 'Similar items fetched per source movie',
        defaultValue: 8,
        section: 'foryou',
        validation: { min: 3, max: 20 },
        uiHints: { advanced: true },
    },
    {
        key: 'FORYOU_SECOND_BECAUSE_SECTION',
        type: 'boolean',
        label: 'Second "Because You Watched"',
        description: 'Add a second "Because You Watched" row sourced from the minority media type',
        defaultValue: true,
        section: 'foryou',
    },
    {
        key: 'FORYOU_SECOND_BECAUSE_LIMIT',
        type: 'number',
        label: 'Second Section Limit',
        description: 'Items in second "Because you watched" section',
        defaultValue: 8,
        section: 'foryou',
        validation: { min: 3, max: 20 },
        dependsOn: 'FORYOU_SECOND_BECAUSE_SECTION',
        uiHints: { advanced: true },
    },

    // For You - Keyword & Mood Sections
    {
        key: 'FORYOU_KEYWORD_ROWS',
        type: 'number',
        label: 'Keyword Section Rows',
        description: 'Number of keyword-based recommendation rows',
        defaultValue: 2,
        section: 'foryou',
        validation: { min: 1, max: 10 },
    },
    {
        key: 'FORYOU_KEYWORD_ITEMS',
        type: 'number',
        label: 'Keyword Items Per Row',
        description: 'Items per keyword recommendation row',
        defaultValue: 8,
        section: 'foryou',
        validation: { min: 3, max: 20 },
    },
    {
        key: 'FORYOU_MOOD_LIMIT',
        type: 'number',
        label: 'Mood Recommendations Limit',
        description: 'Maximum mood-based recommendations',
        defaultValue: 12,
        section: 'foryou',
        validation: { min: 5, max: 30 },
    },

    // For You - Content Mix Ratios
    {
        key: 'FORYOU_SIMILAR_AVAILABLE_RATIO',
        type: 'number',
        label: 'Similar Content Ratio',
        description: 'Ratio of available vs requestable content (0.0-1.0)',
        defaultValue: 0.5,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { advanced: true, step: 0.1 },
    },
    {
        key: 'FORYOU_BINGE_AVAILABLE_RATIO',
        type: 'number',
        label: 'Binge-worthy Ratio',
        description: 'Available content ratio for binge-worthy series',
        defaultValue: 0.7,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { step: 0.1 },
    },
    {
        key: 'FORYOU_KEYWORDS_AVAILABLE_RATIO',
        type: 'number',
        label: 'Keywords Section Ratio',
        description: 'Available content ratio for keyword sections',
        defaultValue: 0.5,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { step: 0.1 },
    },

    // For You - Anime Detection Thresholds
    {
        key: 'FORYOU_ANIME_MIN_WATCHED',
        type: 'number',
        label: 'Anime Min Watched',
        description: 'Minimum anime watched to show anime section',
        defaultValue: 3,
        section: 'foryou',
        validation: { min: 1, max: 20 },
    },
    {
        key: 'FORYOU_ANIME_RECENCY_MONTHS',
        type: 'number',
        label: 'Anime Recency Window',
        description: 'Months of anime watch history to consider',
        defaultValue: 3,
        section: 'foryou',
        validation: { min: 1, max: 12 },
        uiHints: { suffix: 'months' },
    },
    // For You - Behavioral Abandonment Soft-Demote
    {
        key: 'FEATURE_FORYOU_ABANDONMENT_DEMOTE',
        type: 'boolean',
        label: 'Behavioral Abandonment Demote',
        description:
            'Experimental: demote titles the user abandoned mid-watch (5+ min watched, under 60% complete). Quick peeks under 5 min are ignored. Off by default.',
        defaultValue: false,
        section: 'foryou',
        // Feature ENABLE toggle — never advanced (only fine-tuning knobs are).
        uiHints: { beta: true },
    },
    // For You - Section Engagement Ranker (M3)
    {
        key: 'FEATURE_FORYOU_SECTION_RANKER',
        type: 'boolean',
        label: 'Section Engagement Ranker',
        description:
            'Experimental: reorder long-tail For-You carousel sections per-user by accumulated engagement (plays, abandonments, dismissals). Off by default; ships dark.',
        defaultValue: false,
        section: 'foryou',
        // Feature ENABLE toggle — never advanced (only fine-tuning knobs are).
        uiHints: { beta: true },
    },
    {
        key: 'FORYOU_ABANDONMENT_DEMOTE_MULTIPLIER',
        type: 'number',
        label: 'Abandonment Demote Multiplier',
        description:
            'Weight multiplier applied to abandoned items. 0.3 = 70% reduction (recommended). 1.0 = no demote (effectively disables the feature).',
        defaultValue: 0.3,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        dependsOn: 'FEATURE_FORYOU_ABANDONMENT_DEMOTE',
        uiHints: { advanced: true, step: 0.05 },
    },
    // For You - Advanced Scoring (toggle to show/hide)
    {
        key: 'FORYOU_SHOW_ADVANCED_SCORING',
        type: 'boolean',
        label: 'Show Advanced Scoring Settings',
        description:
            'WARNING: only modify if you understand the recommendation algorithm. These weights control how suggestions are ranked; incorrect values can significantly degrade quality.',
        defaultValue: false,
        section: 'foryou',
        uiHints: { advanced: true },
        dependsOn: 'FEATURE_AI_RECOMMENDATIONS',
    },

    // Advanced: Base Scoring Weights
    {
        key: 'FORYOU_WEIGHT_AI_SIMILARITY',
        type: 'number',
        label: 'AI Similarity Weight',
        description: 'How much AI embedding match matters (0.0-1.0)',
        defaultValue: 0.4,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { step: 0.05, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_WEIGHT_MDBLIST_SCORE',
        type: 'number',
        label: 'MDBList Score Weight',
        description: 'Weight for aggregated quality score',
        defaultValue: 0.12,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { step: 0.02, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_WEIGHT_IMDB_RATING',
        type: 'number',
        label: 'IMDB Rating Weight',
        description: 'Weight for IMDB rating',
        defaultValue: 0.08,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { step: 0.02, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },

    // Advanced: Preference Boosts
    {
        key: 'FORYOU_WEIGHT_LIKED_KEYWORD',
        type: 'number',
        label: 'Liked Keyword Boost',
        description: 'Boost for matching liked keywords',
        defaultValue: 0.05,
        section: 'foryou',
        validation: { min: 0, max: 0.5 },
        uiHints: { step: 0.01, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_WEIGHT_LIKED_GENRE',
        type: 'number',
        label: 'Liked Genre Boost',
        description: 'Boost for matching liked genres',
        defaultValue: 0.03,
        section: 'foryou',
        validation: { min: 0, max: 0.5 },
        uiHints: { step: 0.01, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_WEIGHT_LIKED_YEAR',
        type: 'number',
        label: 'Liked Era Boost',
        description: 'Boost for matching liked release years/eras',
        defaultValue: 0.02,
        section: 'foryou',
        validation: { min: 0, max: 0.5 },
        uiHints: { step: 0.01, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },

    // Advanced: Preference Penalties
    {
        key: 'FORYOU_WEIGHT_DISLIKED_KEYWORD',
        type: 'number',
        label: 'Disliked Keyword Penalty',
        description: 'Penalty for matching disliked keywords',
        defaultValue: 0.18,
        section: 'foryou',
        validation: { min: 0, max: 0.5 },
        uiHints: { step: 0.01, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_WEIGHT_DISLIKED_GENRE',
        type: 'number',
        label: 'Disliked Genre Penalty',
        description: 'Penalty for matching disliked genres',
        defaultValue: 0.08,
        section: 'foryou',
        validation: { min: 0, max: 0.5 },
        uiHints: { step: 0.01, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_WEIGHT_DISLIKED_YEAR',
        type: 'number',
        label: 'Disliked Era Penalty',
        description: 'Penalty for matching disliked release years',
        defaultValue: 0.06,
        section: 'foryou',
        validation: { min: 0, max: 0.5 },
        uiHints: { step: 0.01, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },

    // Advanced: Similar Media Context Weights
    {
        key: 'FORYOU_SIMILAR_WEIGHT_DISLIKED_KEYWORD',
        type: 'number',
        label: 'Similar: Disliked Keyword Penalty',
        description: 'Penalty in "Because You Watched" for disliked keywords',
        defaultValue: 0.05,
        section: 'foryou',
        validation: { min: 0, max: 0.5 },
        uiHints: { step: 0.01, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_SIMILAR_WEIGHT_DISLIKED_GENRE',
        type: 'number',
        label: 'Similar: Disliked Genre Penalty',
        description: 'Penalty in "Because You Watched" for disliked genres',
        defaultValue: 0.02,
        section: 'foryou',
        validation: { min: 0, max: 0.5 },
        uiHints: { step: 0.01, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },

    // Advanced: Keyword Section Weights
    {
        key: 'FORYOU_KEYWORD_WEIGHT_AI',
        type: 'number',
        label: 'Keyword: AI Multiplier',
        description: 'AI similarity multiplier for keyword sections',
        defaultValue: 30,
        section: 'foryou',
        validation: { min: 1, max: 100 },
        uiHints: { advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_KEYWORD_WEIGHT_MDBLIST',
        type: 'number',
        label: 'Keyword: MDBList Multiplier',
        description: 'MDBList score multiplier for keyword sections',
        defaultValue: 0.5,
        section: 'foryou',
        validation: { min: 0, max: 5 },
        uiHints: { step: 0.1, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_KEYWORD_WEIGHT_DISLIKED_KEYWORD',
        type: 'number',
        label: 'Keyword: Disliked Keyword Penalty',
        description: 'Penalty for disliked keywords in keyword sections',
        defaultValue: 2,
        section: 'foryou',
        validation: { min: 0, max: 10 },
        uiHints: { step: 0.5, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_KEYWORD_WEIGHT_DISLIKED_GENRE',
        type: 'number',
        label: 'Keyword: Disliked Genre Penalty',
        description: 'Penalty for disliked genres in keyword sections',
        defaultValue: 0.5,
        section: 'foryou',
        validation: { min: 0, max: 5 },
        uiHints: { step: 0.1, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },

    // Advanced: Anime Section Weights
    {
        key: 'FORYOU_ANIME_WEIGHT_AI',
        type: 'number',
        label: 'Anime: AI Weight',
        description: 'AI similarity weight for anime recommendations',
        defaultValue: 0.6,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { step: 0.05, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_ANIME_WEIGHT_MDBLIST',
        type: 'number',
        label: 'Anime: MDBList Weight',
        description: 'MDBList score weight for anime',
        defaultValue: 0.25,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { step: 0.05, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },
    {
        key: 'FORYOU_ANIME_WEIGHT_IMDB',
        type: 'number',
        label: 'Anime: IMDB Weight',
        description: 'IMDB rating weight for anime',
        defaultValue: 0.15,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { step: 0.05, advanced: true },
        dependsOn: 'FORYOU_SHOW_ADVANCED_SCORING',
    },

    // =========================================================================
    // Chat / Chatbot
    // =========================================================================
    {
        key: 'ASSISTANT_NAME',
        type: 'string',
        label: 'Assistant Name',
        description: 'Display name for the AI assistant',
        defaultValue: 'Assistant',
        section: 'ai-assistant',
        validation: { minLength: 1, maxLength: 30 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_PERSONA',
        type: 'string',
        label: 'Assistant Persona',
        description:
            'Persona description for system prompt (leave empty for default). Tone and Proactive Observations settings still apply on top of a custom persona.',
        defaultValue: '',
        section: 'ai-assistant',
        uiHints: { multiline: true, rows: 3 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_TONE',
        type: 'select',
        label: 'Conversational Tone',
        description:
            'How the assistant talks. Concise = short and to-the-point. Balanced = friendly and natural (default). Warm = more conversational and personable. Accuracy and scope always take precedence over tone.',
        defaultValue: 'balanced',
        section: 'ai-assistant',
        validation: {
            options: [
                { value: 'concise', label: 'Concise (short, to the point)' },
                {
                    value: 'balanced',
                    label: 'Balanced (friendly and natural, default)',
                },
                { value: 'warm', label: 'Warm (conversational, personable)' },
            ],
        },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_PROACTIVITY',
        type: 'select',
        label: 'Proactive Observations',
        description:
            'When set to Light, the assistant may add a brief, data-backed remark about your activity at most once per reply, never invented. Off (default) keeps replies strictly answer-focused.',
        defaultValue: 'off',
        section: 'ai-assistant',
        validation: {
            options: [
                { value: 'off', label: 'Off (answer-focused, default)' },
                {
                    value: 'light',
                    label: 'Light (occasional data-backed remarks)',
                },
            ],
        },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_AVATAR',
        type: 'url',
        label: 'Assistant Avatar URL',
        description: 'Custom avatar image URL (optional)',
        defaultValue: '',
        section: 'ai-assistant',
        uiHints: { placeholder: '/assistant-avatar.png' },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_DAILY_LIMIT_USER',
        type: 'number',
        label: 'Daily Message Count (Users, informational)',
        description:
            'Informational message counter for regular users. The actual daily limit is enforced by token budget (see below).',
        defaultValue: 20,
        section: 'ai-assistant',
        validation: { min: 1, max: 500 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
        uiHints: { advanced: true },
    },
    {
        key: 'ASSISTANT_DAILY_LIMIT_ADMIN',
        type: 'number',
        label: 'Daily Message Count (Admins, informational)',
        description:
            'Informational message counter for admins. The actual daily limit is enforced by token budget (see below).',
        defaultValue: 100,
        section: 'ai-assistant',
        validation: { min: 1, max: 1000 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
        uiHints: { advanced: true },
    },
    {
        key: 'ASSISTANT_DAILY_TOKEN_LIMIT_USER',
        type: 'number',
        label: 'Daily Token Budget (Users)',
        description:
            'Maximum AI tokens per day for regular users. The assistant is limited by total tokens consumed (a tool-calling reply can cost several times a simple one), not by message count.',
        defaultValue: 250000,
        section: 'ai-assistant',
        validation: { min: 1000, max: 100000000 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_DAILY_TOKEN_LIMIT_ADMIN',
        type: 'number',
        label: 'Daily Token Budget (Admins)',
        description: 'Maximum AI tokens per day for admin users.',
        defaultValue: 2000000,
        section: 'ai-assistant',
        validation: { min: 1000, max: 1000000000 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_MAX_CONCURRENT',
        type: 'number',
        label: 'Max Concurrent Requests (per user)',
        description:
            'How many assistant requests one user may run at once. A per-user in-flight cap that pragmatically closes the daily-budget check-then-record race. Fails open if the cache is unavailable.',
        defaultValue: 2,
        section: 'ai-assistant',
        validation: { min: 1, max: 20 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
        uiHints: { advanced: true },
    },
    {
        key: 'ASSISTANT_REQUESTS_PER_MINUTE',
        type: 'number',
        label: 'Requests Per Minute (per user)',
        description: 'Per-user rate limit for assistant chat requests (fixed one-minute window).',
        defaultValue: 10,
        section: 'ai-assistant',
        validation: { min: 1, max: 300 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
        uiHints: { advanced: true },
    },
    {
        key: 'ASSISTANT_HISTORY_MAX_TURNS',
        type: 'number',
        label: 'Conversation History: Max Turns',
        description:
            'How many of the most recent conversation turns the assistant keeps as context. Older turns are dropped or summarized (see compaction strategy). At least the last 2 turns are always kept.',
        defaultValue: 20,
        section: 'ai-assistant',
        validation: { min: 2, max: 100 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
        uiHints: { advanced: true },
    },
    {
        key: 'ASSISTANT_HISTORY_MAX_CHARS',
        type: 'number',
        label: 'Conversation History: Max Characters',
        description:
            'Cumulative character budget for kept conversation turns. The assistant keeps the most recent turns fitting BOTH this and the max-turns cap (never splitting a turn).',
        defaultValue: 24000,
        section: 'ai-assistant',
        validation: { min: 1000, max: 500000 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
        uiHints: { advanced: true },
    },
    {
        key: 'ASSISTANT_HISTORY_COMPACTION',
        type: 'select',
        label: 'Conversation History: Compaction Strategy',
        description:
            'How dropped older turns are handled. "Truncate" simply drops the oldest turns. "Summarize" makes one cheap LLM call to condense them into a synthetic summary turn (falls back to truncate on failure).',
        defaultValue: 'truncate',
        section: 'ai-assistant',
        validation: {
            options: [
                { value: 'truncate', label: 'Truncate (drop oldest)' },
                { value: 'summarize', label: 'Summarize (condense oldest)' },
            ],
        },
        dependsOn: 'FEATURE_AI_ASSISTANT',
        uiHints: { advanced: true },
    },

    // =========================================================================
    // Browse & Search
    // =========================================================================
    {
        key: 'SHOW_UNAVAILABLE_MEDIA',
        type: 'boolean',
        label: 'Show unavailable titles on discovery surfaces',
        description:
            'Show titles not yet in your library (catalog/discovery items with no local files) on Trending and For You, so users can discover and request them. Off (default) shows only playable media. Takes effect only when a request integration is configured (Jellyseerr or an external request URL); otherwise these titles would be dead ends and stay hidden. Also includes monitored Sonarr/Radarr titles in the release calendar. Search has its own setting below.',
        defaultValue: false,
        section: 'browse',
        requiresRestart: false,
    },
    {
        key: 'SHOW_UNAVAILABLE_MEDIA_IN_SEARCH',
        type: 'boolean',
        label: 'Show unavailable titles in search results',
        description:
            'Include catalog/discovery titles with no local files inline in the main search results. Off (default) keeps search results library-only; unavailable titles are still reachable through the separate "anfragen" (requests) category.',
        defaultValue: false,
        section: 'browse',
        requiresRestart: false,
    },
    {
        key: 'BROWSE_SEARCH_DEBOUNCE_MS',
        type: 'number',
        // Labelled distinctly from HOMEPAGE_SEARCH_DEBOUNCE_MS: both used to read
        // "Search Debounce", which is ambiguous the moment search lists them side by
        // side.
        label: 'Browse Page Search Debounce',
        description: 'Delay before the browse page runs a search after typing stops',
        defaultValue: 200,
        section: 'browse',
        validation: { min: 50, max: 1000 },
        uiHints: { advanced: true, suffix: 'ms' },
    },
    {
        key: 'BROWSE_AZ_PAGE_SIZE',
        type: 'number',
        label: 'A-Z Browse Page Size',
        description: 'Items per page in alphabetical browse mode',
        defaultValue: 50,
        section: 'browse',
        validation: { min: 10, max: 200 },
        uiHints: { advanced: true },
    },
    {
        key: 'BROWSE_KEYWORDS_INITIAL',
        type: 'number',
        label: 'Initial Keyword Sections',
        description: 'Keyword sections to load initially',
        defaultValue: 5,
        section: 'browse',
        validation: { min: 1, max: 20 },
        uiHints: { advanced: true },
    },
    {
        key: 'BROWSE_KEYWORDS_PAGE_SIZE',
        type: 'number',
        label: 'Keywords Per Page',
        description: 'Keyword sections per pagination page',
        defaultValue: 5,
        section: 'browse',
        validation: { min: 1, max: 20 },
        uiHints: { advanced: true },
    },
    {
        key: 'BROWSE_SCROLL_MARGIN',
        type: 'string',
        label: 'Scroll Margin',
        description: 'Intersection observer margin for lazy loading',
        defaultValue: '400px',
        section: 'browse',
        uiHints: { advanced: true, placeholder: '400px' },
    },
    {
        key: 'SEARCH_TRIGRAM_THRESHOLD',
        type: 'number',
        label: 'Fuzzy Search Threshold',
        description:
            'Trigram similarity threshold (0.0-1.0). Lower values are more lenient and catch more typos but may return false positives. Default 0.25 catches typos like "harry rotter" → "Harry Potter"',
        defaultValue: 0.25,
        section: 'browse',
        validation: { min: 0.1, max: 0.9 },
        uiHints: { advanced: true, step: 0.05 },
    },
    {
        key: 'SEARCH_TYPO_TOLERANCE',
        type: 'select',
        label: 'Typo Tolerance',
        description:
            'How search handles misspelled queries. "Fast" tries exact matching first and only falls back to fuzzy matching when few results are found (~2ms exact, ~20ms typo). "Always" runs fuzzy matching after exact matching regardless of result count. "Off" disables fuzzy matching entirely.',
        defaultValue: 'fallback',
        section: 'browse',
        validation: {
            options: [
                { value: 'off', label: 'Off (exact matching only, fastest)' },
                {
                    value: 'fallback',
                    label: 'Fast (fuzzy only when needed, recommended)',
                    uiHints: { advanced: true },
                },
                {
                    value: 'always',
                    label: 'Always (consistent fuzzy matching)',
                },
            ],
        },
        uiHints: { advanced: true },
    },
    {
        key: 'SEARCH_TYPO_MIN_RESULTS',
        type: 'number',
        label: 'Fuzzy Fallback Threshold',
        description:
            'Minimum exact match results before fuzzy matching is skipped. Only applies in "Fast" mode. Lower values mean fuzzy matching fires less often.',
        defaultValue: 3,
        section: 'browse',
        validation: { min: 0, max: 20 },
        dependsOn: 'SEARCH_TYPO_TOLERANCE',
        showWhen: { key: 'SEARCH_TYPO_TOLERANCE', equals: 'fallback' },
        uiHints: { advanced: true },
    },

    // =========================================================================
    // Homepage Widgets
    // =========================================================================
    {
        key: 'HOMEPAGE_TRENDING_LIMIT',
        type: 'number',
        label: 'Trending Limit',
        description: 'Maximum items in trending section',
        defaultValue: 20,
        section: 'homepage',
        validation: { min: 5, max: 50 },
        uiHints: { advanced: true },
    },
    {
        key: 'HOMEPAGE_HOLIDAY_LIMIT',
        type: 'number',
        label: 'Holiday Recommendations Limit',
        description:
            'Maximum items in the holiday recommendations row. Only used when Show Holiday Recommendations is on (off by default).',
        defaultValue: 20,
        section: 'homepage',
        validation: { min: 5, max: 50 },
        uiHints: { advanced: true },
    },
    {
        key: 'HOMEPAGE_DND_ANIMATION_MS',
        type: 'number',
        label: 'Drag Animation Duration',
        description: 'Widget drag-and-drop animation duration',
        defaultValue: 300,
        section: 'homepage',
        validation: { min: 100, max: 1000 },
        uiHints: { advanced: true, suffix: 'ms' },
    },
    {
        key: 'HOMEPAGE_SEARCH_DEBOUNCE_MS',
        type: 'number',
        label: 'Search Modal Debounce',
        description: 'Delay before the search modal runs a search after typing stops',
        defaultValue: 300,
        section: 'homepage',
        validation: { min: 50, max: 1000 },
        uiHints: { advanced: true, suffix: 'ms' },
    },
    {
        key: 'HOMEPAGE_WIDGET_ORDER',
        type: 'widgets',
        label: 'Widget Order',
        description: 'Default order of homepage widgets for new users',
        defaultValue: [
            'watch-parties',
            'streaming-sessions',
            'for-you',
            'trending',
            'watchlist',
            'upcoming-episodes',
            'calendar',
        ],
        section: 'homepage',
        uiHints: { hidden: true }, // Uses custom WidgetConfigEditor
    },
    {
        key: 'HOMEPAGE_WIDGET_VISIBILITY',
        type: 'widgets',
        label: 'Widget Visibility',
        description: 'Default visibility state per widget (visible, hidden, or disabled)',
        defaultValue: {}, // Empty = all visible by default
        section: 'homepage',
        uiHints: { hidden: true }, // Uses custom WidgetConfigEditor
    },

    // =========================================================================
    // Trending Widget (MDBList Dropdown Configuration)
    // =========================================================================
    {
        key: 'FEATURE_TRENDING',
        type: 'boolean',
        label: 'Trending Widget',
        description: 'Show trending content from MDBList on homepage',
        defaultValue: true,
        section: 'trending',
    },
    {
        key: 'TRENDING_DROPDOWN_GROUPS',
        type: 'widgets',
        label: 'Dropdown Groups',
        description: 'Configure how MDBList lists are grouped in the Trending dropdown',
        defaultValue: {
            groups: [
                {
                    id: 'streaming',
                    label: 'Streaming',
                    listIds: [
                        'netflix-movies',
                        'netflix-shows',
                        'disney-movies',
                        'disney-shows',
                        'amazon-prime-movies',
                        'amazon-prime-shows',
                        'hbo-shows',
                        'apple-tv-movies',
                        'apple-tv-all',
                    ],
                },
                {
                    id: 'trending',
                    label: 'Trending',
                    listIds: [
                        'trending-movies',
                        'trending-shows',
                        'popular-movies',
                        'popular-shows',
                    ],
                },
                {
                    id: 'curated',
                    label: 'Curated',
                    listIds: ['certified-fresh', 'box-office'],
                },
                {
                    id: 'anime',
                    label: 'Anime',
                    listIds: ['latest-anime', 'latest-anime-movies'],
                },
            ],
            hiddenLists: [],
        },
        section: 'trending',
        uiHints: { hidden: true }, // Will use custom editor in the future
    },
    {
        key: 'TRENDING_LIST_NAMES',
        type: 'widgets',
        label: 'List Name Overrides',
        description:
            'Custom names for lists (include emoji for icon). Leave empty to use defaults.',
        defaultValue: {},
        section: 'trending',
        uiHints: { hidden: true }, // Will use custom editor in the future
    },

    // =========================================================================
    // Background Sync
    // =========================================================================
    {
        key: 'SYNC_CURATED_LISTS_HOURS',
        type: 'number',
        label: 'Curated Lists Sync Interval',
        description: 'How often to sync curated lists',
        defaultValue: 12,
        section: 'sync',
        validation: { min: 1, max: 168 },
        uiHints: { advanced: true, suffix: 'hours' },
    },

    // =========================================================================
    // Image Optimization
    // =========================================================================
    {
        key: 'IMAGE_CANDIDATE_PROVIDER_ORDER',
        type: 'array',
        label: 'Image candidate provider order',
        description:
            'Provider preference for every image type, after locked selections and folder/embedded art. Candidates are references until requested.',
        defaultValue:
            'tmdb,tvdb,fanart,musicbrainz-caa,discogs,deezer,theaudiodb,lastfm,jellyfin,audiobookshelf,upload,unknown',
        section: 'image',
    },
    {
        key: 'EPISODE_THUMBNAIL_PREFERENCE',
        type: 'select',
        label: 'Episode thumbnails',
        description:
            'Prefer provider stills or generated frames. When no provider still exists, use a generated frame.',
        defaultValue: 'provider',
        section: 'image',
        options: [
            { value: 'provider', label: 'Prefer provider stills' },
            { value: 'generated', label: 'Prefer generated frames' },
        ],
    },
    {
        key: 'IMAGE_PROVIDER_PRIORITY',
        type: 'array',
        label: 'Image Provider Priority',
        description:
            'Order in which image providers are tried when resolving catalog images. Comma-separated. Valid values: local, generic, tmdb, jellyfin, custom. Jellyfin is a legacy/opt-in fallback and is omitted from the default because Lumastra normally serves local, generic provider, TMDB, or custom artwork directly.',
        defaultValue: 'local,generic,tmdb,custom',
        section: 'image',
        uiHints: { advanced: true },
    },
    {
        key: 'IMAGE_PROVIDER_PRIORITY_EPISODE_THUMB',
        type: 'array',
        label: 'Episode Thumbnail Provider Priority',
        description:
            'Override provider order specifically for episode thumbnails. When set, takes precedence over Image Provider Priority for episode thumb requests. Valid values: local, generic, tmdb, jellyfin, custom. Leave empty to use Image Provider Priority.',
        defaultValue: '',
        section: 'image',
        uiHints: { advanced: true },
    },
    {
        key: 'IMAGE_PROVIDER_PRIORITY_MUSIC',
        type: 'array',
        label: 'Music Image Provider Priority',
        description:
            'Override provider order specifically for music (album/artist/track) cover art. When set, takes precedence over Image Provider Priority for music image requests. Valid values: local, generic, tmdb, jellyfin, custom. Leave empty to use the music default (local, custom).',
        defaultValue: '',
        section: 'music',
        uiHints: { advanced: true },
    },
    {
        key: 'IMAGE_WEBP_ENABLED',
        type: 'boolean',
        label: 'WebP Format',
        description: 'Serve images in WebP for roughly 30% smaller files',
        defaultValue: true,
        section: 'image',
    },
    {
        key: 'IMAGE_THUMB_QUALITY',
        type: 'number',
        label: 'Thumbnail Quality',
        description: 'Compression quality for thumbnails (1-100)',
        defaultValue: 75,
        section: 'image',
        validation: { min: 1, max: 100 },
        uiHints: { suffix: '%' },
    },
    {
        key: 'IMAGE_FULL_QUALITY',
        type: 'number',
        label: 'Full Image Quality',
        description: 'Compression quality for full-size images (1-100)',
        defaultValue: 85,
        section: 'image',
        validation: { min: 1, max: 100 },
        uiHints: { suffix: '%' },
    },
    {
        key: 'IMAGE_AVIF_ENABLED',
        type: 'boolean',
        label: 'Enable AVIF',
        description:
            'Serve AVIF instead of WebP when the client supports it. ~25-35% smaller files but ~3-10x slower encode (paid once per cache miss).',
        defaultValue: true,
        section: 'image',
        uiHints: { advanced: true },
    },
    {
        key: 'IMAGE_AVIF_PREGEN_MODE',
        type: 'string',
        label: 'AVIF Pre-generation Mode',
        description:
            "'eager' encodes WebP and AVIF together on first cache miss (consistent serve latency, more CPU upfront). 'lazy' encodes WebP first and only generates AVIF on first AVIF-client request (less wasted CPU, slower first AVIF view).",
        defaultValue: 'lazy',
        section: 'image',
        validation: {
            options: [
                { value: 'eager', label: 'Eager (encode WebP+AVIF together)' },
                { value: 'lazy', label: 'Lazy (encode AVIF on first request)' },
            ],
            uiHints: { advanced: true },
        },
        uiHints: { advanced: true },
    },
    {
        key: 'IMAGE_AVIF_THUMB_QUALITY',
        type: 'number',
        label: 'AVIF Thumb Quality',
        description:
            'AVIF quality (1-100) for thumb/card variants. AVIF q=54 is roughly equivalent to WebP q=75.',
        // Recalibrated for sharp 0.35, which retuned lossy AVIF onto SSIMULACRA2
        // metrics — the same number no longer buys the same bytes. Measured over a
        // 14-image poster/backdrop corpus at the real preset widths (250/480):
        // q=54 lands within 2.5% of what sharp 0.34 spent at q=50 while scoring
        // slightly HIGHER mean SSIM (0.9207 vs 0.9183). See IMAGE_AVIF_FULL_QUALITY.
        defaultValue: 54,
        section: 'image',
        validation: { min: 1, max: 100 },
        uiHints: { suffix: '%', advanced: true },
    },
    {
        key: 'IMAGE_AVIF_FULL_QUALITY',
        type: 'number',
        label: 'AVIF Full Quality',
        description:
            'AVIF quality (1-100) for medium/full variants. AVIF q=67 is roughly equivalent to WebP q=85.',
        // Same sharp 0.35 recalibration as IMAGE_AVIF_THUMB_QUALITY, over the
        // medium/hd/wide widths (350/1280/1920): q=67 costs +3.7% bytes against
        // sharp 0.34 at q=65 (the closest byte-neutral step — q=66 is -6.7%) and
        // scores higher mean SSIM (0.9550 vs 0.9516). Per-asset spread is wide:
        // graphic posters get bigger and visibly better, grainy scans get smaller.
        defaultValue: 67,
        section: 'image',
        validation: { min: 1, max: 100 },
        uiHints: { suffix: '%', advanced: true },
    },
    {
        key: 'IMAGE_AVIF_SPEED',
        type: 'number',
        label: 'AVIF Encoder Effort',
        description:
            'AVIF encode effort (0-9, Sharp/libheif scale). 0 = least effort (fastest, larger files), 9 = most effort (slowest, smallest files). Encoded once per cache miss then served forever, so a slower setting is usually worth it, but lower it if cold first-paint feels sluggish when many posters load at once (e.g. /music).',
        defaultValue: 1,
        section: 'image',
        validation: { min: 0, max: 9 },
        uiHints: { advanced: true },
    },
    {
        key: 'IMAGE_CACHE_RETENTION_DAYS',
        type: 'number',
        label: 'Cache Retention',
        description: 'How long to keep cached images',
        defaultValue: 30,
        section: 'image',
        validation: { min: 1, max: 365, integer: true },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'IMAGE_CACHE_CLEANUP_ON_STARTUP',
        type: 'boolean',
        label: 'Cleanup on Startup',
        description: 'Delete expired cache files when app starts',
        defaultValue: true,
        section: 'image',
    },
    {
        key: 'IMAGE_CACHE_MAX_BYTES',
        type: 'number',
        label: 'Cache Size Budget',
        description:
            'Max total bytes across all image cache directories. Oldest files are evicted when over budget. Set 0 to disable.',
        defaultValue: 5 * 1024 * 1024 * 1024,
        section: 'image',
        validation: { min: 0 },
        uiHints: { suffix: 'bytes', advanced: true },
    },

    // =========================================================================
    // Image Sync
    // =========================================================================
    {
        key: 'IMAGE_SYNC_LOCAL_FILE_SCANNING',
        type: 'boolean',
        label: 'Enable Local File Scanning',
        description: 'Scan media folders for images matching patterns (S01E01-*.jpg)',
        defaultValue: true,
        section: 'image',
        uiHints: { beta: true },
    },
    {
        key: 'IMAGE_SYNC_LOCAL_PATTERNS',
        type: 'array',
        label: 'Local File Patterns',
        description: 'File patterns to search for (S##E##-*, season#-*, backdrop, poster)',
        defaultValue: [
            'S##E##-backdrop',
            'S##E##-poster',
            'season#-backdrop',
            'season#-poster',
            'backdrop',
            'poster',
        ],
        section: 'image',
        uiHints: { beta: true, advanced: true },
        dependsOn: 'IMAGE_SYNC_LOCAL_FILE_SCANNING',
    },
    {
        key: 'IMAGE_SYNC_AUTO_VIDEO_EXTRACTION',
        type: 'boolean',
        label: 'Enable Automatic Video Extraction',
        description:
            'Automatically extract missing artwork from video files using ffmpeg during scans and background image sync',
        defaultValue: true,
        section: 'image',
        uiHints: { beta: true },
    },
    {
        key: 'IMAGE_SYNC_VIDEO_TIMESTAMP',
        type: 'number',
        label: 'Video Timestamp',
        description: 'Percentage into video to extract frame (10% = 10)',
        defaultValue: 10,
        section: 'image',
        validation: { min: 1, max: 90 },
        uiHints: { suffix: '%', beta: true, advanced: true },
        dependsOn: 'IMAGE_SYNC_AUTO_VIDEO_EXTRACTION',
    },
    {
        key: 'IMAGE_SYNC_VIDEO_QUALITY',
        type: 'number',
        label: 'Video Extraction Quality',
        description: 'Quality for extracted frames (1-100)',
        defaultValue: 80,
        section: 'image',
        validation: { min: 1, max: 100 },
        uiHints: { suffix: '%', beta: true, advanced: true },
        dependsOn: 'IMAGE_SYNC_AUTO_VIDEO_EXTRACTION',
    },
    {
        key: 'IMAGE_SYNC_VIDEO_MAX_WIDTH',
        type: 'number',
        label: 'Video Extraction Max Width',
        description: 'Maximum width for extracted frames',
        defaultValue: 640,
        section: 'image',
        validation: { min: 320, max: 1920 },
        uiHints: { suffix: 'px', beta: true, advanced: true },
        dependsOn: 'IMAGE_SYNC_AUTO_VIDEO_EXTRACTION',
    },
    {
        key: 'IMAGE_SYNC_VIDEO_MAX_HEIGHT',
        type: 'number',
        label: 'Video Extraction Max Height',
        description: 'Maximum height for extracted frames',
        defaultValue: 360,
        section: 'image',
        validation: { min: 180, max: 1080 },
        uiHints: { suffix: 'px', beta: true, advanced: true },
        dependsOn: 'IMAGE_SYNC_AUTO_VIDEO_EXTRACTION',
    },
    {
        key: 'IMAGE_SYNC_EXTRACTION_LOCATION',
        type: 'select',
        label: 'Extraction Storage Location (deprecated)',
        description:
            'Deprecated. Now controlled by METADATA_STORAGE_LOCATION in the Media Storage section.',
        defaultValue: 'config-dir',
        section: 'image',
        options: [
            {
                value: 'config-dir',
                label: 'Config directory (always writable)',
            },
            {
                value: 'alongside-video',
                label: 'Alongside video file (auto-discovered by scanner)',
            },
        ],
        uiHints: { hidden: true },
        dependsOn: 'IMAGE_SYNC_AUTO_VIDEO_EXTRACTION',
    },
    {
        key: 'IMAGE_SYNC_EPISODE_THUMB_PRIORITY',
        type: 'array',
        label: 'Episode Thumbnail Priority',
        description:
            'Order for missing episode thumbnails during post-scan. video extracts a frame from the episode file; provider uses a remote still image. Valid values: video, provider.',
        defaultValue: ['video', 'provider'],
        section: 'image',
        uiHints: { beta: true, advanced: true },
    },
    {
        key: 'MAX_IMAGE_UPLOAD_MB',
        type: 'number',
        label: 'Max Image Upload Size',
        description:
            'Maximum file size allowed when admins manually upload artwork (poster, backdrop, logo).',
        defaultValue: 10,
        section: 'image',
        validation: { min: 1, max: 50 },
        uiHints: { advanced: true, suffix: 'MB' },
    },

    // =========================================================================
    // Media Storage
    // =========================================================================
    {
        key: 'METADATA_STORAGE_LOCATION',
        type: 'select',
        label: 'Metadata Storage Location',
        description:
            'Where to store generated metadata files (trickplay, custom artwork, lyrics). Reads always check both central and alongside locations, regardless of this setting.',
        defaultValue: 'central',
        section: 'media',
        options: [
            {
                value: 'central',
                label: 'Central directory (/config)',
            },
            {
                value: 'alongside',
                label: 'Alongside media file',
            },
            {
                value: 'alongside-prefer',
                label: 'Alongside media (fall back to central)',
            },
        ],
    },

    // =========================================================================
    // Trickplay Generation
    // =========================================================================
    {
        key: 'TRICKPLAY_PROVIDER',
        type: 'select',
        label: 'Trickplay Provider',
        description:
            'Which source to use for trickplay thumbnails during scrubbing. Jellyfin-generated sprites can be imprecise since they are not self-contained and lack pacing/timestamp metadata.',
        defaultValue: 'prefer_local',
        section: 'media',
        validation: {
            options: [
                {
                    value: 'prefer_local',
                    label: 'Prefer local (Jellyfin fallback until Lumastra generates)',
                },
                {
                    value: 'local_only',
                    label: 'Local only (Lumastra-generated sprites, no Jellyfin fallback)',
                },
                {
                    value: 'jellyfin_disk',
                    label: 'Jellyfin disk (always use Jellyfin sprites)',
                },
            ],
        },
        uiHints: { advanced: true },
    },
    {
        key: 'TRICKPLAY_ENABLED',
        type: 'boolean',
        label: 'Enable Self-Generated Trickplay',
        description:
            'Generate trickplay sprite sheets from local video files. Required when Trickplay Provider is set to "Prefer local" or "Local only".',
        defaultValue: false,
        section: 'media',
    },
    {
        key: 'TRICKPLAY_INTERVAL_MS',
        type: 'number',
        label: 'Trickplay Interval',
        description: 'Milliseconds between trickplay thumbnails',
        defaultValue: 10000,
        section: 'media',
        validation: { min: 1000, max: 60000 },
        uiHints: { suffix: 'ms', advanced: true },
        dependsOn: 'TRICKPLAY_ENABLED',
    },
    {
        key: 'TRICKPLAY_HWACCEL',
        type: 'select',
        label: 'Trickplay Hardware Decode',
        description:
            'Decode frames on the GPU when extracting trickplay thumbnails. A 4K source costs 3-12 seconds of CPU per frame but under a second on the GPU, which is the difference between a long 4K movie finishing and timing out forever. "Automatic" uses the GPU only when a render node is present and a probe frame really decodes, and falls back to the CPU otherwise.',
        defaultValue: 'auto',
        section: 'media',
        validation: {
            options: [
                { value: 'auto', label: 'Automatic (use GPU when available)' },
                { value: 'vaapi', label: 'Force VAAPI' },
                { value: 'qsv', label: 'Force Intel QSV' },
                { value: 'off', label: 'CPU only' },
            ],
        },
        uiHints: { advanced: true },
        dependsOn: 'TRICKPLAY_ENABLED',
    },
    {
        key: 'TRICKPLAY_HWACCEL_DEVICE',
        type: 'path',
        label: 'Trickplay GPU Render Node',
        description:
            'Which DRM render node to decode on. Change this only when the box has more than one GPU and the wrong one is being picked.',
        defaultValue: '/dev/dri/renderD128',
        section: 'media',
        uiHints: { placeholder: '/dev/dri/renderD128', advanced: true },
        dependsOn: 'TRICKPLAY_ENABLED',
    },
    {
        key: 'TRICKPLAY_PER_FRAME_CONCURRENCY',
        type: 'number',
        label: 'Trickplay Frames In Parallel',
        description:
            'How many frames one trickplay job extracts at once. The real load is this multiplied by the CPU-class job concurrency, so raising it without also reviewing that cap makes every frame slower rather than faster.',
        defaultValue: 4,
        section: 'media',
        validation: { min: 1, max: 16 },
        uiHints: { advanced: true },
        dependsOn: 'TRICKPLAY_ENABLED',
    },
    {
        key: 'TRICKPLAY_WIDTH',
        type: 'number',
        label: 'Trickplay Width',
        description: 'Width of trickplay images in pixels',
        defaultValue: 320,
        section: 'media',
        validation: { min: 160, max: 640 },
        uiHints: { suffix: 'px', advanced: true },
        dependsOn: 'TRICKPLAY_ENABLED',
    },
    {
        key: 'TRICKPLAY_QUALITY',
        type: 'number',
        label: 'Trickplay Quality',
        description: 'WebP quality for trickplay images (0-100)',
        defaultValue: 80,
        section: 'media',
        validation: { min: 50, max: 100 },
        uiHints: { suffix: '%', advanced: true },
        dependsOn: 'TRICKPLAY_ENABLED',
    },
    {
        key: 'TRICKPLAY_TILE_WIDTH',
        type: 'number',
        label: 'Tiles Per Row',
        description: 'Number of tiles per row in sprite sheet',
        defaultValue: 10,
        section: 'media',
        validation: { min: 5, max: 20 },
        uiHints: { advanced: true },
        dependsOn: 'TRICKPLAY_ENABLED',
    },
    {
        key: 'TRICKPLAY_TILE_HEIGHT',
        type: 'number',
        label: 'Tiles Per Column',
        description: 'Number of tiles per column in sprite sheet',
        defaultValue: 10,
        section: 'media',
        validation: { min: 5, max: 20 },
        uiHints: { advanced: true },
        dependsOn: 'TRICKPLAY_ENABLED',
    },
    {
        key: 'TRICKPLAY_STORAGE_PATH',
        type: 'path',
        label: 'Trickplay Storage Path',
        description:
            'Filesystem path for trickplay sprite sheet storage. Must be on a shared volume between web and worker containers.',
        defaultValue: '/config/trickplay',
        section: 'media',
        uiHints: { placeholder: '/config/trickplay', advanced: true },
        dependsOn: 'TRICKPLAY_ENABLED',
    },
    {
        key: 'TRICKPLAY_STORAGE_LOCATION',
        type: 'select',
        label: 'Trickplay Storage Location',
        description:
            'Where to store trickplay sprite sheets, independent of the global Metadata Storage Location (e.g. keep artwork and lyrics central while writing trickplay alongside media). Reads always check both locations, regardless of this setting.',
        defaultValue: 'inherit',
        section: 'media',
        options: [
            {
                value: 'inherit',
                label: 'Inherit global Metadata Storage Location',
                uiHints: { advanced: true },
            },
            {
                value: 'central',
                label: 'Central directory (Trickplay Storage Path)',
            },
            {
                value: 'alongside',
                label: 'Alongside media file',
            },
            {
                value: 'alongside-prefer',
                label: 'Alongside media (fall back to central)',
            },
        ],
        uiHints: { advanced: true },
        dependsOn: 'TRICKPLAY_ENABLED',
    },
    {
        key: 'SUBTITLE_STORAGE_LOCATION',
        type: 'select',
        label: 'Bitmap Subtitle Storage Location',
        description:
            'Where to keep extracted and rendered bitmap subtitles (PGS/VobSub), independent of the global Metadata Storage Location. Alongside media, they go in a hidden .subtitle-cache folder next to the video and outlive the central cache and its size budget. Reads always check both locations, regardless of this setting.',
        defaultValue: 'inherit',
        section: 'media',
        options: [
            {
                value: 'inherit',
                label: 'Inherit global Metadata Storage Location',
                uiHints: { advanced: true },
            },
            {
                value: 'central',
                label: 'Central subtitle cache',
            },
            {
                value: 'alongside',
                label: 'Alongside media file',
            },
            {
                value: 'alongside-prefer',
                label: 'Alongside media (fall back to central)',
            },
        ],
        uiHints: { advanced: true },
    },

    // =========================================================================
    // Permission Groups
    // =========================================================================
    {
        key: 'WATCH_PERMISSION_GROUPS',
        type: 'array',
        label: 'Stream Monitor Groups',
        description: "Groups that can see all users' streaming sessions",
        defaultValue: 'admin,stream-monitors',
        section: 'groups',
        uiHints: { placeholder: 'admin,stream-monitors', groups: true },
    },
    {
        key: 'ADMIN_GROUPS',
        type: 'array',
        label: 'Admin Groups',
        description: 'Groups with admin access',
        defaultValue: 'admin',
        section: 'groups',
        uiHints: { placeholder: 'admin', groups: true },
    },
    {
        key: 'LIVETV_GROUPS',
        type: 'array',
        label: 'Live TV Groups',
        description: 'Groups with Live TV access (only applies when Live TV feature is enabled)',
        defaultValue: 'livetv,admin',
        section: 'groups',
        uiHints: { placeholder: 'livetv,admin', groups: true },
    },
    {
        key: 'ARR_MANAGER_GROUPS',
        type: 'array',
        label: 'Media Manager Groups',
        description: 'Groups that can manage the media-acquisition backend',
        defaultValue: 'arrmanager,admin',
        section: 'groups',
        uiHints: { placeholder: 'arrmanager,admin', groups: true },
    },
    {
        key: 'REQUEST_GROUPS',
        type: 'array',
        label: 'Request Groups',
        description: 'Groups that can request media via Seerr (empty = all users allowed)',
        defaultValue: '',
        section: 'requests',
        uiHints: { placeholder: 'requesters,admin', groups: true },
    },
    {
        key: 'AUTH_NATIVE_LOGIN_ENABLED',
        type: 'boolean',
        label: 'Enable Built-in (Native) Login',
        description:
            'When enabled, users can sign in with a username and password managed by Lumastra, and unauthenticated browsers are sent to the /login page. Coexists with forward auth. Set automatically when the first admin is created via native onboarding.',
        defaultValue: false,
        section: 'auth',
        uiHints: {},
    },
    {
        key: 'NATIVE_AUTH_SESSION_TTL_DAYS',
        type: 'number',
        label: 'Native Login Session Lifetime (days)',
        description:
            'How long a native-login session stays valid before the user must sign in again. Sessions are still rotated on login and revoked on logout or password change.',
        defaultValue: 30,
        section: 'auth',
        validation: {
            min: 1,
            max: 365,
            uiHints: { advanced: true },
        },
        uiHints: {},
    },
    // ── OIDC (OpenID Connect) single sign-on ──────────────────────────────────
    {
        key: 'AUTH_OIDC_ENABLED',
        type: 'boolean',
        label: 'Enable OIDC Single Sign-On',
        description:
            'Let users sign in through an OpenID Connect provider (Authentik, Keycloak, Entra, Okta, …). OIDC and reverse-proxy forward-auth are alternative front-door modes: pick one as your primary SSO. They can run together, but a logged-in session takes precedence and, if a forward-auth proxy fronts the app, it must allow /auth/oidc/* through unauthenticated for OIDC to be reachable. Requires Issuer + Client ID below.',
        defaultValue: false,
        section: 'auth',
        uiHints: {},
    },
    {
        key: 'AUTH_OIDC_PROVIDER_NAME',
        type: 'string',
        label: 'OIDC Provider Display Name',
        description: 'Shown on the sign-in button ("Sign in with <name>").',
        defaultValue: 'Single Sign-On',
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { advanced: true, placeholder: 'Authentik' },
    },
    {
        key: 'AUTH_OIDC_ISSUER',
        type: 'url',
        label: 'OIDC Issuer URL',
        description:
            'Issuer / discovery base URL. Discovery appends /.well-known/openid-configuration.',
        defaultValue: '',
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { placeholder: 'https://idp.example.com/application/o/lumastra/' },
    },
    {
        key: 'AUTH_OIDC_CLIENT_ID',
        type: 'string',
        label: 'OIDC Client ID',
        description: 'The client/application ID registered at your identity provider.',
        defaultValue: '',
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: {},
    },
    {
        key: 'AUTH_OIDC_CLIENT_SECRET',
        type: 'string',
        label: 'OIDC Client Secret',
        description:
            'Confidential-client secret. Leave empty only for a public client using PKCE. Stored encrypted.',
        defaultValue: '',
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { sensitive: true },
    },
    {
        key: 'AUTH_OIDC_SCOPES',
        type: 'string',
        label: 'OIDC Scopes',
        description: 'Space-separated scopes requested at login. Must include "openid".',
        defaultValue: 'openid profile email',
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { advanced: true, placeholder: 'openid profile email groups' },
    },
    {
        key: 'AUTH_OIDC_GROUPS_CLAIM',
        type: 'string',
        label: 'OIDC Groups Claim',
        description:
            'Token claim that lists the user’s groups (Authentik "groups", Entra "roles"). Synced to the user every login and used for admin/permission mapping.',
        defaultValue: 'groups',
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { advanced: true, placeholder: 'groups' },
    },
    {
        key: 'AUTH_OIDC_LINK_BY_VERIFIED_EMAIL',
        type: 'boolean',
        label: 'Link OIDC Logins by Verified Email',
        description:
            'Auto-link an OIDC login to an existing account when the provider asserts a VERIFIED email matching exactly one account. Never links on an unverified email (admin-takeover guard). Disable to require provider-subject links only.',
        defaultValue: true,
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { advanced: true },
    },
    {
        key: 'AUTH_OIDC_LINK_BY_USERNAME',
        type: 'boolean',
        label: 'Link OIDC Logins by Username (less safe)',
        description:
            'Auto-link an OIDC login to an existing account whose username matches the one derived from the token (preferred_username / email local-part). For migrating existing native accounts to OIDC. A username is not verified proof of identity: only enable this if your IdP administratively controls usernames, otherwise a user could claim another account by choosing its username. Tried only after verified-email linking.',
        defaultValue: false,
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { advanced: true },
    },
    {
        key: 'AUTH_OIDC_USERINFO',
        type: 'boolean',
        label: 'Fetch OIDC UserInfo',
        description:
            'Also call the UserInfo endpoint to read groups/email when they are absent from the ID token. Adds one request per login.',
        defaultValue: false,
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { advanced: true },
    },
    {
        key: 'AUTH_OIDC_SYNC_AVATAR',
        type: 'boolean',
        label: 'Use Avatar from Identity Provider',
        description:
            "Show the IdP's profile picture (the OIDC `picture` claim) for users who have not uploaded their own avatar. Fetched by the server at sign-in and stored, so browsers never load it from the IdP. An uploaded avatar always wins.",
        defaultValue: true,
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
    },
    {
        key: 'AUTH_OIDC_REDIRECT_URI',
        type: 'url',
        label: 'OIDC Redirect URI (override)',
        description:
            'Leave empty to derive <origin>/auth/oidc/callback from the request (set ORIGIN behind a TLS proxy). Set only if your IdP requires an exact value the app cannot infer.',
        defaultValue: '',
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { advanced: true, placeholder: 'https://lumastra.example.com/auth/oidc/callback' },
    },
    {
        key: 'AUTH_OIDC_ALLOW_INSECURE',
        type: 'boolean',
        label: 'Allow Insecure OIDC (HTTP)',
        description:
            'DANGER: permit a non-HTTPS issuer/token endpoint. For local development against a plain-HTTP test IdP only. Never enable in production.',
        defaultValue: false,
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { advanced: true, envOnly: true },
        // envOnly only disables the input; without this a settings.json value
        // (any admin form post) could turn off TLS checks for the IdP.
        envOnlyEnforced: true,
    },
    {
        key: 'AUTH_OIDC_BACKCHANNEL_LOGOUT_CASCADE',
        type: 'boolean',
        label: 'Cascade Back-Channel Logout to Device Tokens',
        description:
            "When the IdP signals a back-channel logout for the whole user (no session id), also revoke refresh and Jellyfin device tokens (TV/mobile), not just the browser session. Off by default: device clients keep their own lifecycle. Never applies to a single-session (sid) logout. Point your IdP's back-channel logout URL at <origin>/auth/oidc/backchannel-logout.",
        defaultValue: false,
        section: 'auth',
        showWhen: { key: 'AUTH_OIDC_ENABLED', equals: true },
        uiHints: { advanced: true },
    },
    {
        key: 'UNRATED_CONTENT_VISIBLE',
        type: 'boolean',
        label: 'Show Unrated Content to Age-Restricted Users',
        description:
            'When enabled, content without an age rating is visible to age-restricted users. When disabled (default), unrated content is hidden for safety.',
        defaultValue: false,
        section: 'groups',
        uiHints: {},
    },
    {
        key: 'RECENTLY_ADDED_PROPAGATE_TO_SERIES',
        type: 'boolean',
        label: 'Resurface Series When New Episodes Are Added',
        description:
            'Adding a new episode bumps the series to the top of Recently Added. Turn off to freeze each series at the date its first episode was added.',
        defaultValue: true,
        section: 'browse',
    },
    {
        key: 'AGE_RATING_GROUP_PREFIX',
        type: 'string',
        label: 'Age Rating Group Prefix',
        description:
            'IdP group name prefix for age restrictions. Users in groups matching {prefix}{number} (e.g. age-12) are restricted to content rated at or below that age. The number is the maximum allowed content age rating.',
        defaultValue: 'age-',
        section: 'groups',
        uiHints: { advanced: true, placeholder: 'age-', groups: true },
    },
    {
        key: 'PLAYLIST_PUBLIC_GROUPS',
        type: 'array',
        label: 'Public Playlist Groups',
        description:
            'Groups allowed to create public playlists (empty = all users, only applies when Playlists feature is enabled)',
        defaultValue: '',
        section: 'groups',
        uiHints: { advanced: true, placeholder: 'playlist-creators,admin', groups: true },
    },

    // =========================================================================
    // Advanced
    // =========================================================================
    {
        key: 'DEFAULT_USER',
        type: 'string',
        label: 'Default User',
        description: 'Fallback username when no auth headers present (development only)',
        defaultValue: 'admin',
        section: 'advanced',
        validation: { minLength: 1, maxLength: 50 },
        uiHints: { devOnly: true },
    },
    {
        key: 'LOG_LEVEL',
        type: 'select',
        label: 'Log Level',
        description: 'Server-side logging verbosity',
        defaultValue: 'info',
        section: 'advanced',
        validation: {
            options: [
                { value: 'debug', label: 'Debug (most verbose)' },
                { value: 'info', label: 'Info' },
                { value: 'warn', label: 'Warnings' },
                { value: 'error', label: 'Errors only' },
            ],
        },
    },
    {
        key: 'FORCE_LOCALE',
        type: 'select',
        label: 'Force Locale',
        description: 'Override browser language detection',
        defaultValue: '',
        section: 'localization',
        validation: {
            options: [
                { value: '', label: 'Auto-detect' },
                { value: 'en', label: 'English' },
                { value: 'de', label: 'German' },
            ],
        },
    },
    {
        key: 'DATE_LOCALE',
        type: 'string',
        label: 'Date Locale',
        description: 'BCP 47 language tag for date formatting (e.g., de-AT, en-US)',
        defaultValue: 'en-US',
        section: 'localization',
    },
    {
        key: 'DATE_TIMEZONE',
        type: 'string',
        label: 'Date Timezone',
        description: 'IANA timezone for date display (e.g., Europe/Vienna, America/New_York)',
        defaultValue: 'UTC',
        section: 'localization',
    },
    {
        key: 'TOAST_DEFAULT_TIMEOUT_MS',
        type: 'number',
        label: 'Toast Timeout',
        description: 'Default notification display duration',
        defaultValue: 5000,
        section: 'advanced',
        validation: { min: 1000, max: 30000 },
        uiHints: { advanced: true, suffix: 'ms' },
    },
    {
        key: 'REQUEST_AVAILABLE_EXPIRE_HOURS',
        type: 'number',
        label: 'Request Notification Expiry',
        description: 'How long to show "available" notifications',
        defaultValue: 24,
        section: 'requests',
        validation: { min: 1, max: 168 },
        uiHints: { advanced: true, suffix: 'hours' },
    },
    {
        key: 'FEATURE_MUSIC_CLUSTERING',
        type: 'boolean',
        label: 'Music Quick Picks: Multi-Mode Taste Clustering',
        get description() {
            return m.config_feature_music_clustering_description();
        },
        defaultValue: true,
        section: 'music',
    },
    {
        key: 'FEATURE_MUSIC_ALCHEMY',
        type: 'boolean',
        label: 'Music Alchemy',
        get description() {
            return m.config_feature_music_alchemy_description();
        },
        defaultValue: false,
        section: 'music',
        dependsOn: 'FEATURE_MUSIC_CLUSTERING',
    },
    {
        key: 'FEATURE_MUSIC_SONIC',
        type: 'boolean',
        label: 'Sonic Embeddings (MSCLAP)',
        get description() {
            return m.config_feature_music_sonic_description();
        },
        defaultValue: false,
        section: 'music',
    },
    {
        key: 'FEATURE_MUSIC_MAP',
        type: 'boolean',
        label: 'Music Map (UMAP Projection)',
        get description() {
            return m.config_feature_music_map_description();
        },
        defaultValue: false,
        section: 'music',
        dependsOn: 'FEATURE_MUSIC_SONIC',
    },
    {
        key: 'FEATURE_MUSIC_LYRICS_SEARCH',
        type: 'boolean',
        label: 'Lyrics Search',
        get description() {
            return m.config_feature_music_lyrics_search_description();
        },
        defaultValue: false,
        section: 'music',
    },
    {
        key: 'FEATURE_MUSIC_CLUSTERS',
        type: 'boolean',
        label: 'Sonic Collections (KMeans Auto-playlists)',
        get description() {
            return m.config_feature_music_clusters_description();
        },
        defaultValue: false,
        section: 'music',
        dependsOn: 'FEATURE_MUSIC_SONIC',
    },
    {
        key: 'FEATURE_MUSIC_TEXT_SOUND',
        type: 'boolean',
        label: 'Text-to-Sound Search',
        get description() {
            return m.config_feature_music_text_sound_description();
        },
        defaultValue: false,
        section: 'music',
        dependsOn: 'FEATURE_MUSIC_SONIC',
    },
    {
        key: 'FEATURE_MUSIC_SONIC_TASTE',
        type: 'boolean',
        label: 'Sonic Taste Profile (Personalised Quick Picks)',
        get description() {
            return m.config_feature_music_sonic_taste_description();
        },
        defaultValue: false,
        section: 'music',
        dependsOn: 'FEATURE_MUSIC_SONIC',
    },
    {
        key: 'FEATURE_MUSIC_SONIC_QUEUE',
        type: 'boolean',
        label: 'Sonic Smart Queue',
        get description() {
            return m.config_feature_music_sonic_queue_description();
        },
        defaultValue: false,
        section: 'music',
        dependsOn: 'FEATURE_MUSIC_SONIC',
    },
    {
        key: 'FEATURE_MUSIC_FIRST',
        type: 'boolean',
        label: 'Music-First Mode',
        get description() {
            return m.config_feature_music_first_description();
        },
        defaultValue: false,
        section: 'music',
    },
    {
        key: 'INSTANCE_PRIMARY_MODE',
        type: 'select',
        label: 'Instance Primary Mode',
        get description() {
            return m.config_instance_primary_mode_description();
        },
        defaultValue: 'vod',
        section: 'music',
        validation: {
            options: [
                { value: 'vod', label: 'VOD (film/TV-first)' },
                { value: 'music', label: 'Music-first' },
                { value: 'mixed', label: 'Mixed (balanced)' },
                { value: 'enterprise', label: 'Enterprise / Home & Training' },
                { value: 'showcase', label: 'Product Showcase (public + internal)' },
            ],
        },
    },
    {
        key: 'INSTANCE_LANDING_PATH',
        type: 'string',
        label: 'Landing Page Path',
        description:
            "App-relative path the home route ('/') redirects to (e.g. '/music' or '/library/home_video'). Empty = no redirect (default home). Must be an app-relative path; external URLs are rejected.",
        defaultValue: '',
        section: 'homepage',
        validation: { maxLength: 512 },
        uiHints: { advanced: true },
    },
    {
        key: 'INSTANCE_USE_CASES',
        type: 'array',
        label: 'Instance Use Cases',
        description:
            "Selected onboarding use-cases (vod | music | enterprise | showcase) that produced this instance's defaults. Managed by the Instance Profile screen.",
        defaultValue: [],
        section: 'enterprise',
        uiHints: { hidden: true },
    },
    {
        key: 'INSTANCE_PROFILE_APPLIED',
        type: 'string',
        label: 'Applied Instance Profile',
        description:
            'What the last instance-profile apply projected (JSON: use cases, the value it set for each managed key, time). Re-applying compares against it, so settings changed elsewhere since are kept. Managed by the Instance Profile screen; never edit by hand.',
        defaultValue: '',
        section: 'enterprise',
        uiHints: { hidden: true },
    },
    // ─────────────────── Enterprise: Native Quiz & Assessment ────────────────
    {
        key: 'FEATURE_ASSESSMENT',
        type: 'boolean',
        label: 'Native Quiz & Certificate (Assessment)',
        description:
            'Master switch for the native quiz + certificate-of-completion layer (Phase A). When ON, /learn, /admin/courses, and /certificates become available. Default OFF for non-enterprise installs.',
        defaultValue: false,
        section: 'enterprise',
        requiresRestart: false,
    },
    // ─────────────────── Enterprise: Training Assignments ─────────────────────
    {
        key: 'FEATURE_TRAINING_ASSIGNMENTS',
        type: 'boolean',
        label: 'Training Assignments',
        description:
            'Master switch for the enterprise training assignment and completion-tracking layer. When ON, /my/trainings and /admin/trainings become available and the Sidebar nav entries appear. Default OFF for non-enterprise installs; reads live, no restart needed.',
        defaultValue: false,
        section: 'enterprise',
        requiresRestart: false,
    },
    // ─────────────────── Product Showcase public surface ───────────────────────
    {
        key: 'FEATURE_PUBLIC_SHOWCASE',
        type: 'boolean',
        label: 'Public Showcase Surface',
        description:
            'Master switch for the /showcase public (unauthenticated) route. When OFF the public route 404s even if SHOWCASE_PUBLIC_LIBRARY_GROUP_ID is set. Default OFF (deny-by-default); reads live, so toggling is instant.',
        defaultValue: false,
        section: 'enterprise',
        requiresRestart: false,
    },
    {
        key: 'SHOWCASE_PUBLIC_LIBRARY_GROUP_ID',
        type: 'string',
        label: 'Showcase Public Library Group',
        description:
            'UUID of the single library_groups row whose items are publicly visible on /showcase. Empty = nothing is public even when FEATURE_PUBLIC_SHOWCASE is on (deny-by-default). Set this to the group you want publicly accessible.',
        defaultValue: '',
        section: 'enterprise',
        validation: { maxLength: 36 },
    },
    {
        key: 'SHOWCASE_ALLOW_EMBED',
        type: 'boolean',
        label: 'Allow Showcase Embedding (iframe)',
        description:
            "When ON, the /showcase route sets a permissive frame-ancestors CSP so it can be iframed. When OFF, frame-ancestors 'none' (default). Requires SHOWCASE_EMBED_ALLOWED_ORIGINS to be set; an empty allow-list with this flag ON is rejected (prevents frame-ancestors * wildcard).",
        defaultValue: false,
        section: 'enterprise',
        requiresRestart: false,
    },
    {
        key: 'SHOWCASE_EMBED_ALLOWED_ORIGINS',
        type: 'array',
        label: 'Showcase Embed Allowed Origins',
        description:
            "Allow-list of origins for the frame-ancestors CSP when SHOWCASE_ALLOW_EMBED is ON (e.g. ['https://acme.com']). Must not be empty when SHOWCASE_ALLOW_EMBED=true: an empty allow-list disables embedding to prevent a frame-ancestors * wildcard.",
        defaultValue: [],
        section: 'enterprise',
    },
    {
        key: 'SHOWCASE_KIOSK_MODE',
        type: 'boolean',
        label: 'Showcase Kiosk Mode',
        description:
            'Display-only flag: hides nav chrome, enables auto-advance / looping playback for showroom screens. No auth effect.',
        defaultValue: false,
        section: 'enterprise',
        requiresRestart: false,
    },
    {
        key: 'SHOWCASE_REQUIRE_TOKEN',
        type: 'boolean',
        label: 'Showcase Require Signed Token',
        description:
            "When ON, the /showcase public route additionally requires a valid signed-URL token (?expires&purpose=showcase&sig): 'link-shared' mode instead of fully open. Generate share links via POST /api/admin/showcase/share-link. Default ON (safer default; explicit opt-out for fully-open).",
        defaultValue: true,
        section: 'enterprise',
        requiresRestart: false,
    },
    {
        key: 'SHOWCASE_MAX_CONCURRENT_TRANSCODES',
        type: 'number',
        label: 'Showcase Max Concurrent Transcodes',
        description:
            'Deployment-wide hard ceiling on concurrent showcase-initiated ffmpeg transcodes (across every web replica — enforced by one shared Valkey admission, not a per-pod counter). Fails CLOSED: if Valkey is unreachable, showcase transcodes are refused rather than uncapped. Must be set to the SAME value on every replica — this is one deployment-wide figure, not a per-pod allowance. Default 4, conservative to avoid starving authenticated users of transcode capacity.',
        defaultValue: 4,
        section: 'enterprise',
        validation: { min: 1, max: 100 },
        requiresRestart: false,
    },
    // ───────────────────────────────────────────────────────────────────────────
    {
        key: 'MUSIC_AUTOPLAY_COOLDOWN_HOURS',
        type: 'number',
        label: 'Music Autoplay Cool-down (hours)',
        description:
            'How long after playing a track to avoid re-suggesting it (or its remixes/variants) in autoplay. 0 = disabled · 24 = one day (recommended) · 168 = one week · 720 = 30 days.',
        defaultValue: 24,
        section: 'music',
        validation: { min: 0, max: 8760 },
        uiHints: { suffix: 'h' },
    },
    {
        key: 'MUSIC_AUTOPLAY_TOP_K',
        type: 'number',
        label: 'Music Autoplay Variety (top-K)',
        get description() {
            return m.config_music_autoplay_top_k_description();
        },
        defaultValue: 5,
        section: 'music',
        validation: { min: 1, max: 20 },
    },
    {
        key: 'MUSIC_AUTOPLAY_SEED_ANCHOR_WEIGHT',
        type: 'number',
        label: 'Music Autoplay Seed Anchor Weight',
        get description() {
            return m.config_music_autoplay_seed_anchor_weight_description();
        },
        defaultValue: 0.15,
        section: 'music',
        validation: { min: 0, max: 1 },
    },
    {
        key: 'MUSIC_AUTOPLAY_MIN_TRACK_SECONDS',
        type: 'number',
        label: 'Music Autoplay Minimum Track Length (seconds)',
        get description() {
            return m.config_music_autoplay_min_track_seconds_description();
        },
        defaultValue: 90,
        section: 'music',
        validation: { min: 0, max: 300 },
        uiHints: { suffix: 's' },
    },
    {
        key: 'MUSIC_AUTOPLAY_MAX_TRACK_SECONDS',
        type: 'number',
        label: 'Music Autoplay Maximum Track Length (seconds)',
        get description() {
            return m.config_music_autoplay_max_track_seconds_description();
        },
        defaultValue: 900,
        section: 'music',
        validation: { min: 0, max: 14400 },
        uiHints: { suffix: 's' },
    },
    {
        key: 'MUSIC_POPULARITY_WEIGHT',
        type: 'number',
        label: 'Music Popularity Weight',
        get description() {
            return m.config_music_popularity_weight_description();
        },
        defaultValue: 0,
        section: 'music',
        validation: { min: 0, max: 1 },
    },
    {
        key: 'MUSIC_POPULARITY_EXPONENT',
        type: 'number',
        label: 'Music Popularity Curve Exponent',
        get description() {
            return m.config_music_popularity_exponent_description();
        },
        defaultValue: 0.5,
        section: 'music',
        validation: { min: 0.1, max: 2 },
        uiHints: { advanced: true },
    },
    {
        key: 'MUSIC_POPULARITY_FLOOR',
        type: 'number',
        label: 'Music Popularity Floor',
        get description() {
            return m.config_music_popularity_floor_description();
        },
        defaultValue: 0.1,
        section: 'music',
        validation: { min: 0, max: 1 },
        uiHints: { advanced: true },
    },
    {
        key: 'MUSIC_POPULARITY_PRIMARY_SOURCE',
        type: 'select',
        label: 'Music Popularity Primary Source',
        get description() {
            return m.config_music_popularity_primary_source_description();
        },
        defaultValue: 'lastfm',
        section: 'music',
        validation: {
            options: [{ value: 'lastfm', label: 'Last.fm' }],
        },
        uiHints: { advanced: true },
    },
    {
        key: 'MUSIC_SONIC_QUEUE_MIN_CANDIDATES',
        type: 'number',
        label: 'Sonic Queue Minimum Candidate Count',
        get description() {
            return m.config_music_sonic_queue_min_candidates_description();
        },
        defaultValue: 5,
        section: 'music',
        validation: { min: 0, max: 50 },
        uiHints: { advanced: true },
    },
    {
        key: 'MUSIC_AUTOPLAY_GENRE_STREAK_WEIGHT',
        type: 'number',
        label: 'Music Autoplay Genre Streak Weight',
        get description() {
            return m.config_music_autoplay_genre_streak_weight_description();
        },
        defaultValue: 0.25,
        section: 'music',
        validation: { min: 0, max: 1 },
    },
    {
        key: 'MUSIC_AUTOPLAY_GENRE_STREAK_COHESION_THRESHOLD',
        type: 'number',
        label: 'Music Autoplay Genre Streak Cohesion Threshold',
        get description() {
            return m.config_music_autoplay_genre_streak_cohesion_threshold_description();
        },
        defaultValue: 0.5,
        section: 'music',
        validation: { min: 0, max: 1 },
        uiHints: { advanced: true },
    },
    {
        key: 'MUSIC_AUTOPLAY_MIX_BLEND_WEIGHT',
        type: 'number',
        label: 'Music Autoplay Mix Blend Weight',
        description:
            'Weight of the BPM/key "blend compatibility" smart-queue tiebreak. Only meaningful for clients that crossfade; auto-disabled for hard-cut clients (e.g. iOS). Keep well below ~0.1, the typical similarity spread. 0.04 = recommended. 0 disables it.',
        defaultValue: 0.04,
        section: 'music',
        validation: { min: 0, max: 0.5 },
        uiHints: { advanced: true },
    },
    {
        key: 'MUSIC_AUTOPLAY_ENERGY_FLOW_WEIGHT',
        type: 'number',
        label: 'Music Autoplay Energy Flow Weight',
        description:
            'Weight of the energy-continuity smart-queue tiebreak. Applies regardless of client crossfade capability, since an energy cliff is audible on a hard cut too. Keep well below ~0.1, the typical similarity spread. 0.04 = recommended. 0 disables it.',
        defaultValue: 0.04,
        section: 'music',
        validation: { min: 0, max: 0.5 },
        uiHints: { advanced: true },
    },
    {
        key: 'MUSIC_SONIC_TASTE_WEIGHT',
        type: 'number',
        label: 'Music Sonic Taste Weight',
        description:
            "Weight of the user's overall taste profile in the sonic smart-queue blend (the currently-playing context gets the rest). Higher pulls autoplay toward favorite genres even off-context; lower stays in the lane of what is playing. 0.2 = recommended. 0 disables the taste pull.",
        defaultValue: 0.2,
        section: 'music',
        validation: { min: 0, max: 0.5 },
        uiHints: { advanced: true },
    },
    {
        key: 'MUSIC_SONIC_LANE_WEIGHT',
        type: 'number',
        label: 'Music Lane Affinity Weight',
        description:
            'Weight of the Last.fm scene/lane re-rank term in the sonic smart queue. Audio similarity hears production but not scene; this term uses Last.fm crowd tags to boost same-scene candidates and demote different-scene ones at the same sound. Requires the Last.fm popularity provider. 0.08 = recommended. 0 disables it.',
        defaultValue: 0.08,
        section: 'music',
        validation: { min: 0, max: 0.5 },
        uiHints: { advanced: true },
    },

    // =========================================================================
    // Music Transcoding
    // =========================================================================
    {
        key: 'FEATURE_MUSIC_TRANSCODE',
        type: 'boolean',
        label: 'Music Transcoding',
        get description() {
            return m.config_feature_music_transcode_description();
        },
        defaultValue: true,
        section: 'music',
    },
    {
        key: 'MUSIC_TRANSCODE_CACHE_DIR',
        type: 'path',
        label: 'Music Transcode Cache Directory',
        description:
            'Filesystem path where transcoded audio files are cached. Must be on a persistent volume that survives container restarts. Shared volume required when running multiple replicas with a dedicated worker.',
        defaultValue: '/config/cache/music-transcode',
        section: 'music',
        uiHints: {
            placeholder: '/config/cache/music-transcode',
            advanced: true,
        },
        dependsOn: 'FEATURE_MUSIC_TRANSCODE',
    },
    {
        key: 'MUSIC_TRANSCODE_CACHE_MAX_GB',
        type: 'number',
        label: 'Music Transcode Cache Limit (GB)',
        description:
            'Maximum total size of the music transcode cache in gigabytes. When the cache exceeds this limit the reaper evicts the least-recently-used files. Increase on hosts with ample disk space.',
        defaultValue: 10,
        section: 'music',
        validation: { min: 1, max: 500 },
        uiHints: { suffix: 'GB', advanced: true },
        dependsOn: 'FEATURE_MUSIC_TRANSCODE',
    },
    {
        key: 'MUSIC_TRANSCODE_REAPER_INTERVAL_M',
        type: 'number',
        label: 'Music Transcode Reaper Interval (minutes)',
        description:
            'How often the cache reaper plugin runs to enforce the size cap and remove stale partial files. Lower values keep cache usage tighter at the cost of slightly more I/O.',
        defaultValue: 30,
        section: 'music',
        validation: { min: 1, max: 1440 },
        uiHints: { suffix: 'min', advanced: true },
        dependsOn: 'FEATURE_MUSIC_TRANSCODE',
    },
    {
        key: 'MUSIC_TRANSCODE_TOKEN_TTL_HOURS',
        type: 'number',
        label: 'Music Transcode Token TTL (hours)',
        description:
            'How long a signed transcode-params token remains valid. Shorter values reduce the window where a leaked token can be replayed; longer values allow clients to hold a token across longer sessions.',
        defaultValue: 6,
        section: 'music',
        validation: { min: 1, max: 168 },
        uiHints: { suffix: 'h', advanced: true },
        dependsOn: 'FEATURE_MUSIC_TRANSCODE',
    },
    {
        key: 'MUSIC_TRANSCODE_DEFAULT_CODEC',
        type: 'select',
        label: 'Music Transcode Default Codec',
        description:
            'Output codec used when the client does not specify one. MP3 has the widest compatibility. AAC offers better quality at the same bitrate. Opus is best for low-bitrate streaming but has limited native browser support.',
        defaultValue: 'mp3',
        section: 'music',
        validation: {
            options: [
                { value: 'mp3', label: 'MP3' },
                { value: 'aac', label: 'AAC' },
                { value: 'opus', label: 'Opus' },
            ],
        },
        dependsOn: 'FEATURE_MUSIC_TRANSCODE',
    },
    {
        key: 'MUSIC_TRANSCODE_DEFAULT_BITRATE',
        type: 'number',
        label: 'Music Transcode Default Bitrate (kbps)',
        description:
            'Output bitrate in kbps used when the client does not specify one. 128 = compact (suitable for mobile data). 192 = balanced (recommended). 320 = high-quality (closer to lossless). Must be within the range accepted by the bitrate clamp module.',
        defaultValue: 192,
        section: 'music',
        validation: { min: 64, max: 320 },
        uiHints: { suffix: 'kbps' },
        dependsOn: 'FEATURE_MUSIC_TRANSCODE',
    },
    {
        key: 'MUSIC_TRANSCODE_MAX_CONCURRENT',
        type: 'number',
        label: 'Music Transcode Max Concurrent Jobs',
        description:
            'Maximum number of simultaneous ffmpeg transcode processes per instance. Each job spawns a ffmpeg child process. Defaults to available CPU cores (minimum 4, capped at 16). Raise on hosts with many CPU cores; keep low on shared or memory-constrained hosts.',
        defaultValue: 4,
        // Auto-scale to the effective CPU budget (cgroup-aware) — a static
        // default here would SHADOW the code-side fallback in config.ts, since
        // ConfigService is consulted before it.
        dynamicDefault: ({ cpuCores }) => musicTranscodeConcurrencyDefault(cpuCores),
        section: 'music',
        validation: { min: 1, max: 32 },
        uiHints: { advanced: true },
        dependsOn: 'FEATURE_MUSIC_TRANSCODE',
    },
    {
        key: 'MUSIC_TRANSCODE_MAX_PER_USER',
        type: 'number',
        label: 'Music Transcode Max Jobs Per User',
        description:
            'Per-user cap on simultaneous music transcodes, layered under the server-wide cap so one client (buggy retry loop or many devices) cannot consume the whole budget and starve other listeners. Defaults to half the server-wide cap (minimum 4) — set it too low and a single client doing an offline sync throttles itself.',
        defaultValue: 4,
        dynamicDefault: ({ cpuCores }) => musicTranscodePerUserDefault(cpuCores),
        section: 'music',
        validation: { min: 1, max: 16 },
        uiHints: { advanced: true },
        dependsOn: 'FEATURE_MUSIC_TRANSCODE',
    },
    {
        key: 'MUSIC_TRANSCODE_QUEUE_WAIT_MS',
        type: 'number',
        label: 'Music Transcode Queue Wait (ms)',
        description:
            'How long a request waits for a free transcode slot before giving up with HTTP 503. Waiting turns the concurrency caps into a throughput limit (bulk downloads slow down) instead of an error, without raising the ceiling on concurrent ffmpeg processes. Set to 0 to reject over-cap requests immediately.',
        defaultValue: 10000,
        section: 'music',
        validation: { min: 0, max: 120000 },
        uiHints: { advanced: true },
        dependsOn: 'FEATURE_MUSIC_TRANSCODE',
    },
    {
        key: 'MUSIC_TRANSCODE_PARTIAL_TIMEOUT_S',
        type: 'number',
        label: 'Music Transcode Partial Timeout (seconds)',
        description:
            'Seconds to wait for the first bytes of a new transcode before aborting the request. Increase on very slow storage or heavily loaded hosts; decrease to fail fast when ffmpeg stalls.',
        defaultValue: 30,
        section: 'music',
        validation: { min: 5, max: 300 },
        uiHints: { suffix: 's', advanced: true },
        dependsOn: 'FEATURE_MUSIC_TRANSCODE',
    },

    {
        key: 'PLAYLIST_CHAT_POLL_MS',
        type: 'number',
        label: 'Playlist Chat Poll Interval',
        description: 'How often to poll for new chat messages',
        defaultValue: 15000,
        section: 'features',
        validation: { min: 5000, max: 60000 },
        uiHints: { suffix: 'ms', advanced: true },
        dependsOn: 'FEATURE_PLAYLIST_CHAT',
    },
    {
        key: 'LUMASTRA_BACKGROUND_CPU_PSI_PERCENT',
        type: 'number',
        label: 'Background CPU Pod Pressure Threshold',
        description:
            'Prefer the web pod CPU PSI some avg10 over host load. Limit background CPU concurrency to one above this percentage while playback is active. Recover below 80%, hold 60 seconds, and allow 2 minutes before another load trip. 0 disables the PSI load trigger. Applies live.',
        defaultValue: 20,
        section: 'advanced-tasks',
        validation: { min: 0, max: 100 },
        uiHints: { suffix: '%' },
    },
    {
        key: 'LUMASTRA_BACKGROUND_CPU_LOAD_RATIO',
        type: 'number',
        label: 'Background CPU Load Threshold',
        description:
            'While playback is active, limit background CPU work to one job when load/core exceeds this ratio (fallback when pod CPU PSI is unavailable). Recent unthrottled CPU video playback always limits concurrency. Recover below 80%, hold 60 seconds, then allow at least 2 minutes before another load trip. Manual runs and ingest probes are exempt; deferred jobs run once after 15 minutes. Applies live; 0 disables the load fallback.',
        defaultValue: 2,
        uiHints: { step: 0.05 },
        section: 'advanced-tasks',
        validation: { min: 0, max: 10 },
    },
    {
        key: 'LUMASTRA_QUIET_HOURS_ENABLED',
        type: 'boolean',
        label: 'Quiet Hours',
        description:
            'Automatically pauses the heavy CPU and analysis background work (trickplay, intro analysis, transcoding-adjacent jobs) during a daily time window. Everyday work — file scanning, watch-sync, metadata — keeps running. Enforced live; no restart needed.',
        defaultValue: false,
        section: 'advanced-tasks',
    },
    {
        key: 'LUMASTRA_QUIET_HOURS_START',
        type: 'string',
        label: 'Quiet Hours Start',
        description:
            "24-hour local time (server timezone, see Date & Time Zone) heavy work pauses at, e.g. '01:00'.",
        defaultValue: '01:00',
        section: 'advanced-tasks',
        dependsOn: 'LUMASTRA_QUIET_HOURS_ENABLED',
        validation: { pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
        uiHints: { placeholder: '01:00' },
    },
    {
        key: 'LUMASTRA_QUIET_HOURS_END',
        type: 'string',
        label: 'Quiet Hours End',
        description:
            "24-hour local time (server timezone, see Date & Time Zone) heavy work resumes at, e.g. '07:00'. May be earlier than the start time — that wraps the window across midnight.",
        defaultValue: '07:00',
        section: 'advanced-tasks',
        dependsOn: 'LUMASTRA_QUIET_HOURS_ENABLED',
        validation: { pattern: '^([01]\\d|2[0-3]):[0-5]\\d$' },
        uiHints: { placeholder: '07:00' },
    },
    {
        key: 'LUMASTRA_WORK_PROFILE',
        type: 'select',
        label: 'Work Profile',
        description:
            'One question instead of reasoning about the individual LUMASTRA_CONCURRENCY_* knobs directly: how many background jobs Lumastra runs at once. Gentle favors leaving headroom for other uses of this machine; Fast assumes a dedicated host. Changes are saved immediately but only take effect after a restart — the same restart requirement as the underlying concurrency settings this maps to (see the Task Runner & Queue Tuning panel).',
        defaultValue: 'balanced',
        section: 'advanced-tasks',
        validation: {
            options: [
                { value: 'gentle', label: 'Gentle — I use this machine for other things too' },
                { value: 'balanced', label: 'Balanced (recommended)' },
                { value: 'fast', label: 'Fast — this machine is dedicated to Lumastra' },
            ],
        },
        // The admin "Load Controls" card writes the underlying LUMASTRA_CONCURRENCY_*
        // settings when this changes (see defs/admin/ops/work-profile.ts) — this key
        // itself is just the remembered choice, not read by the task runner directly.
        requiresRestart: true,
    },
    {
        key: 'FORWARD_AUTH_ENABLED',
        type: 'boolean',
        label: 'Forward Auth (Reverse-Proxy Sign-In)',
        description:
            'Sign users in from the identity headers a forward-auth reverse proxy (Authentik, Authelia, oauth2-proxy) sets: the User, Groups and Display Name headers below. Read only from peers listed in TRUSTED_PROXY_IPS. Off by default: setting TRUSTED_PROXY_IPS just for real client IPs then never lets a visitor sign in by sending these headers. Set FORWARD_AUTH_ENABLED=true in the environment (.env or the container environment) and restart; it cannot be changed here. Before turning it off while you are signed in through forward auth, keep built-in login or OIDC working.',
        defaultValue: false,
        section: 'auth',
        // Env-only like TRUSTED_PROXY_IPS: whoever can change it decides who may
        // sign in by header, so it is not an admin setting (2026-10-06 review).
        envOnlyEnforced: true,
        uiHints: { envOnly: true },
    },
    {
        key: 'USERHEADER',
        type: 'string',
        label: 'User Header',
        description: 'HTTP header name the reverse proxy uses to pass the authenticated username',
        defaultValue: 'X-Forwarded-User',
        section: 'auth',
        uiHints: { placeholder: 'X-Forwarded-User' },
        dependsOn: 'FORWARD_AUTH_ENABLED',
    },
    {
        key: 'GROUPHEADER',
        type: 'string',
        label: 'Groups Header',
        description:
            "HTTP header name the reverse proxy uses to pass the authenticated user's groups",
        defaultValue: 'X-Forwarded-Groups',
        section: 'auth',
        uiHints: { placeholder: 'X-Forwarded-Groups' },
        dependsOn: 'FORWARD_AUTH_ENABLED',
    },
    {
        key: 'NAMEHEADER',
        type: 'string',
        label: 'Display Name Header',
        description:
            "HTTP header name the reverse proxy uses to pass the authenticated user's full display name. Optional: if the proxy does not send it, Lumastra keeps showing the username. Trusted on exactly the same terms as the User Header (Forward Auth on, TRUSTED_PROXY_IPS peers only).",
        defaultValue: 'x-authentik-name',
        section: 'auth',
        uiHints: { placeholder: 'x-authentik-name' },
        dependsOn: 'FORWARD_AUTH_ENABLED',
    },
    {
        key: 'FORWARD_AUTH_GROUPS_ALWAYS_SENT',
        type: 'boolean',
        label: 'Proxy Always Sends the Groups Header',
        description:
            'Turn on when your reverse proxy sends the Groups Header on every signed-in request (the Authentik outpost always sets it, even when empty). A request from a trusted proxy that carries the User Header but no Groups Header is then treated as "this user has no groups": their stored groups are cleared and an admin who is not pinned loses admin, also on API tokens, devices and Jellyfin-compatible clients. Needed behind nginx, which drops an empty header, so a user removed from every IdP group would otherwise keep their old groups and admin rights on those surfaces. Leave off if some routes of your proxy forward the username without the groups, or you would lose age-rating groups there.',
        defaultValue: false,
        section: 'auth',
        uiHints: {},
        dependsOn: 'FORWARD_AUTH_ENABLED',
    },
    {
        key: 'TMDB_METADATA_CACHE_TTL_DAYS',
        type: 'number',
        label: 'TMDB Metadata Cache TTL',
        description: 'How long to cache TMDB API responses (poster/backdrop paths) in memory',
        defaultValue: 30,
        // Every other TMDB knob lives in `services`; this one sat on the general
        // settings page, away from the connection it caches.
        section: 'metadata',
        validation: { min: 1, max: 365 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'RECONCILE_AUTO_APPLY_NUMBER_MATCHES',
        type: 'boolean',
        label: 'Auto-apply episode matches based on numbers alone',
        description:
            'After a metadata sync, a file-backed episode with no provider identity can line up by episode number with a file-less episode of the provider catalog, usually in a series whose releases are numbered absolutely across seasons. When this is off, such a match is only proposed on the Library > Quarantine page and nothing is changed. When it is on, the episode is bound to the provider episode and moved into its season on its own; every applied move can be undone from the same page. Filename-backed matches follow the separate filename setting.',
        defaultValue: false,
        section: 'metadata',
        uiHints: { advanced: true },
    },
    {
        key: 'RECONCILE_AUTO_APPLY_FILENAME_MATCHES',
        type: 'boolean',
        label: 'Auto-apply episode matches based on the file name',
        description:
            'After a metadata sync, a file-backed episode with no provider identity whose file name carries the absolute episode number (for example "S09E21 - 188 - Title") is matched to the provider episode at that number, when the title in the file name agrees with the provider title. When this is on, the episode is bound and moved into its season on its own, at most 50 per series per sync (the rest follow on the next sync); every applied move can be undone from the Library > Quarantine page. When it is off, such a match is only proposed there and nothing is changed.',
        defaultValue: true,
        section: 'metadata',
        uiHints: { advanced: true },
    },

    // =========================================================================
    // LLM / Embedding Configuration (exposed for tuning, secrets stay ENV-only)
    // Moved to 'advanced' section - these are technical config, not chat UI settings
    // =========================================================================
    {
        key: 'OPENAI_BASE_URL',
        type: 'url',
        label: 'OpenAI Base URL',
        description: 'Custom OpenAI-compatible endpoint (leave empty for default)',
        defaultValue: '',
        section: 'ai-assistant',
        uiHints: {
            placeholder: 'https://api.openai.com/v1',
            healthCheckProvider: 'openai',
        },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'OPENAI_CHAT_MODEL',
        type: 'string',
        label: 'Chat Model',
        description: 'OpenAI chat model to use',
        defaultValue: 'gpt-4o-mini',
        section: 'ai-assistant',
        validation: { minLength: 1, maxLength: 50 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_PROVIDER',
        type: 'select',
        label: 'Assistant Chat Backend',
        description:
            'Which backend powers the AI assistant. "Auto" uses Claude when only the Anthropic key is set, otherwise OpenAI.',
        defaultValue: 'auto',
        section: 'ai-assistant',
        validation: {
            options: [
                { value: 'auto', label: 'Auto' },
                { value: 'openai', label: 'OpenAI' },
                { value: 'anthropic', label: 'Anthropic (Claude)' },
            ],
        },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ANTHROPIC_BASE_URL',
        type: 'url',
        label: 'Anthropic Base URL',
        description: 'Custom Anthropic endpoint / proxy (leave empty for default)',
        defaultValue: '',
        section: 'ai-assistant',
        uiHints: { placeholder: 'https://api.anthropic.com', advanced: true },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ANTHROPIC_CHAT_MODEL',
        type: 'string',
        label: 'Claude Chat Model',
        description: 'Anthropic Claude model to use when the Anthropic backend is active',
        defaultValue: 'claude-opus-4-8',
        section: 'ai-assistant',
        validation: { minLength: 1, maxLength: 50 },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_THINKING',
        type: 'boolean',
        label: 'Claude Adaptive Thinking',
        description:
            'Enable Claude thinking for the assistant (Anthropic backend only). The reasoning summary is shown in the chat. Ignored by OpenAI.',
        defaultValue: true,
        section: 'ai-assistant',
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'ASSISTANT_EFFORT',
        type: 'select',
        label: 'Claude Reasoning Effort',
        description:
            'Caps reasoning depth + token spend on effort-capable Claude models (Opus 4.5+, Sonnet 4.6). Lower = cheaper. Ignored by Haiku/Sonnet-4.5 and OpenAI.',
        defaultValue: 'medium',
        section: 'ai-assistant',
        validation: {
            options: [
                { value: 'low', label: 'Low' },
                { value: 'medium', label: 'Medium' },
                { value: 'high', label: 'High' },
                { value: 'xhigh', label: 'X-High' },
                { value: 'max', label: 'Max' },
            ],
        },
        dependsOn: 'FEATURE_AI_ASSISTANT',
    },
    {
        key: 'EMBEDDING_BASE_URL',
        type: 'url',
        label: 'Embedding Base URL',
        description: 'Custom embedding endpoint (leave empty for Voyage AI)',
        defaultValue: '',
        section: 'foryou',
        uiHints: { placeholder: '', advanced: true },
        dependsOn: 'FEATURE_AI_RECOMMENDATIONS',
    },
    {
        key: 'EMBEDDING_MODEL',
        type: 'string',
        label: 'Embedding Model',
        description: 'Embedding model name (auto-detected if empty)',
        defaultValue: '',
        section: 'foryou',
        uiHints: { placeholder: 'voyage-3-large', advanced: true },
        dependsOn: 'FEATURE_AI_RECOMMENDATIONS',
    },
    {
        key: 'EMBEDDING_DIMENSIONS',
        type: 'number',
        label: 'Embedding Dimensions',
        description: 'Vector dimensions (0 = auto-detect). Changing requires DB migration!',
        defaultValue: 0,
        section: 'foryou',
        validation: { min: 0, max: 4096 },
        uiHints: { advanced: true },
        requiresRestart: true,
        dependsOn: 'FEATURE_AI_RECOMMENDATIONS',
    },
    {
        key: 'EMBEDDING_ALLOW_PRIVATE_URLS',
        type: 'boolean',
        label: 'Allow Private Embedding URL',
        description:
            'Allow a private/local IP address for Embedding Base URL. Enable for a self-hosted embedding endpoint on a trusted network; disable for SSRF protection.',
        defaultValue: false,
        section: 'foryou',
        uiHints: { advanced: true },
        dependsOn: 'FEATURE_AI_RECOMMENDATIONS',
    },
    {
        key: 'AI_COST_PRICE_OVERRIDES',
        type: 'array',
        label: 'Cost Price Overrides',
        description:
            'Assign a USD-per-1M-tokens price to a model the built-in pricing table doesn\'t recognize, so it stops showing "no price assigned" on the Cost page. Comma-separated "model-prefix=price" entries (e.g. "text-embedding-3-small=0.02"); the longest matching prefix wins.',
        defaultValue: [],
        section: 'foryou',
        uiHints: { placeholder: 'my-local-model=0.01', advanced: true },
    },
    {
        key: 'EMBEDDING_FUSION_LIBRARY_WEIGHT',
        type: 'number',
        label: 'Embedding Fusion: Library Weight',
        description:
            'Weight of the library embedding when an item has BOTH library and discovery embeddings. Blended with the discovery weight (normalized); ratio is what matters. Single-embedding items are unaffected.',
        defaultValue: 0.6,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { advanced: true },
        dependsOn: 'FEATURE_AI_RECOMMENDATIONS',
    },
    {
        key: 'EMBEDDING_FUSION_DISCOVERY_WEIGHT',
        type: 'number',
        label: 'Embedding Fusion: Discovery Weight',
        description:
            'Weight of the discovery embedding when an item has BOTH library and discovery embeddings. Blended with the library weight (normalized); ratio is what matters. Single-embedding items are unaffected.',
        defaultValue: 0.4,
        section: 'foryou',
        validation: { min: 0, max: 1 },
        uiHints: { advanced: true },
        dependsOn: 'FEATURE_AI_RECOMMENDATIONS',
    },

    // =========================================================================
    // Navigation Configuration
    // =========================================================================
    {
        key: 'NAVIGATION_AVAILABLE_GROUPS',
        type: 'array',
        label: 'Available Groups',
        description:
            'Additional groups available in navigation permission dropdowns (beyond admin/watch permission groups)',
        defaultValue: [],
        section: 'navigation',
    },
    {
        key: 'SIDEBAR_LINKS',
        type: 'navigation',
        label: 'Sidebar Links',
        description: 'Configure the sidebar/dock navigation links',
        defaultValue: [],
        section: 'navigation',
        uiHints: { hidden: true },
    },
    {
        key: 'SIDEBAR_SECTIONS',
        type: 'navigation',
        label: 'Sidebar Sections',
        description: 'Define collapsible sections for grouping sidebar links',
        defaultValue: [],
        section: 'navigation',
        uiHints: { hidden: true },
    },
    {
        key: 'FOOTER_LINKS',
        type: 'navigation',
        label: 'Footer Links',
        description: 'Configure the footer action buttons',
        defaultValue: [],
        section: 'navigation',
        uiHints: { hidden: true },
    },
    {
        key: 'SHOW_FOOTER',
        type: 'boolean',
        label: 'Show Footer',
        description:
            'Show the footer link bar (Request, Wiki, Quick Connect, …) at the bottom of the home page. Turn off to hide it entirely.',
        defaultValue: false,
        section: 'navigation',
    },
    {
        key: 'USER_MENU_LINKS',
        type: 'navigation',
        label: 'User Menu Links',
        description: 'Configure the user profile popup menu links',
        defaultValue: [],
        section: 'navigation',
        uiHints: { hidden: true },
    },
    {
        key: 'HERO_BUTTONS',
        type: 'navigation',
        label: 'Hero Buttons',
        description:
            'Configure the homepage hero toolbar buttons (built-in actions like Search/Browse/Assistant plus custom links). Empty = hardcoded default toolbar.',
        defaultValue: [],
        section: 'navigation',
        uiHints: { hidden: true },
    },
    {
        key: 'LUMASTRA_RUN_STATE_TTL_ACTIVE_MS',
        type: 'number',
        label: 'Active Run State TTL',
        description:
            'How long (ms) an active run hash survives in Valkey without a heartbeat refresh. Default 900 000 ms (15 min).',
        defaultValue: 900_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 60_000, max: 86_400_000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'LUMASTRA_RUN_STATE_TTL_TERMINAL_MS',
        type: 'number',
        label: 'Terminal Run State TTL',
        description:
            'How long (ms) a completed/failed/cancelled run hash is kept in Valkey for the cancel/retry UI. Default 3 600 000 ms (1 h).',
        defaultValue: 3_600_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 60_000, max: 604_800_000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'LUMASTRA_ORCHESTRATOR_LEADER_TTL_MS',
        type: 'number',
        label: 'Orchestrator Leader Lock TTL',
        description:
            'How long (ms) the per-class TaskOrchestrator leader lock survives without renewal. Default 15 000 ms.',
        defaultValue: 15_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 1_000, max: 60_000 },
        uiHints: { suffix: 'ms', advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_ORCHESTRATOR_LEADER_RENEW_MS',
        type: 'number',
        label: 'Orchestrator Leader Renew Interval',
        description:
            'How often (ms) the orchestrator extends its per-class leader lock. Must be less than the TTL. Default 5 000 ms.',
        defaultValue: 5_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 500, max: 30_000 },
        uiHints: { suffix: 'ms', advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_TRANSITION_BATCH_WINDOW_MS',
        type: 'number',
        label: 'Run Transition Batch Window',
        description:
            'Coalesce QueueEvents transitions across this window (ms) to limit Lua round-trips per run. Default 50 ms.',
        defaultValue: 50,
        section: 'advanced-tasks-tuning',
        validation: { min: 0, max: 1_000 },
        uiHints: { suffix: 'ms', advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_TRANSITION_BATCH_MAX',
        type: 'number',
        label: 'Run Transition Batch Max',
        description:
            'Force a coalescing flush once this many transitions are buffered, even before the window elapses. Default 200.',
        defaultValue: 200,
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 10_000 },
        uiHints: { advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_CASCADE_DELETE_MAX',
        type: 'number',
        label: 'Admin Cascade Delete Max',
        description:
            'Hard cap on descendants one admin cascade delete can remove, guarding against a whole-library wipe from a misclick on an artist or season. Default 500.',
        defaultValue: 500,
        // An operational safety cap, not a storage-location setting: it belongs with
        // the other global runtime guards rather than on the Media page.
        section: 'advanced',
        validation: { min: 1, max: 100_000 },
        uiHints: { advanced: true },
        // Backed by the module-level `export const LUMASTRA_CASCADE_DELETE_MAX`
        // in config.ts (read once at load), so a live save cannot take effect
        // until restart — the admin UI must say so.
    },
    {
        key: 'SSE_MAX_CONNECTIONS_PER_USER',
        type: 'number',
        label: 'SSE Connections Per User',
        description:
            'Max concurrent Server-Sent Events connections one user may hold at once (across /events, /runs/stream, /admin/ingest/stream). A user over the limit gets 429 on connect. Default 16.',
        defaultValue: 16,
        section: 'advanced',
        validation: { min: 1, max: 1000 },
        uiHints: { advanced: true },
    },
    {
        key: 'SSE_MAX_CONNECTIONS',
        type: 'number',
        label: 'SSE Connections (Process-Wide)',
        description:
            'Hard ceiling on concurrent SSE connections a single replica process will hold for one SSE endpoint. A connection over the limit gets 503 rather than exhausting server resources. Default 5000.',
        defaultValue: 5000,
        section: 'advanced',
        validation: { min: 1, max: 1_000_000 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_CONCURRENCY_CPU',
        type: 'number',
        label: 'Task Runner CPU Concurrency',
        description:
            "Concurrent jobs for the cpu-class worker (trickplay generation, intro analyzer, ffmpeg, fingerprint), so a trickplay backlog can't block intro detection. Auto-sized at startup to floor(cores/2), clamped 1-6 and cgroup-aware; set it explicitly (here or via env) to override.",
        defaultValue: 2,
        // Auto-scale the default to the effective CPU budget (cgroup-aware). One
        // CPU-class job can fan ffmpeg across LUMASTRA_FFMPEG_THREADS cores, so we
        // deliberately scale only this lever (not the per-process thread cap) to
        // avoid quadratic CPU pressure. Floor(cores/2) clamped to 1..6:
        // 2c→1, 4c→2, 8c→4, 16c→6. Explicit env/admin values still win.
        dynamicDefault: ({ cpuCores }) => cpuClassConcurrencyDefault(cpuCores),
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 32 },
        uiHints: { advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_CONCURRENCY_IO',
        type: 'number',
        label: 'Task Runner IO Concurrency',
        description:
            'Concurrent jobs for the io-class worker (file-library-scan, media-probe, chapter-sync, image-sync, watch-sync, tmdb/mdblist metadata sync), mostly I/O- and network-bound. Auto-sized at startup to cores clamped 4-12 and cgroup-aware; raise it to drain large ingest backlogs faster, or lower it on slow storage.',
        defaultValue: 4,
        // Auto-scale the default to the effective CPU budget (cgroup-aware). io
        // work is I/O/network-bound (collapsed ingest+bulk pool), so we scale with
        // cores directly — not halved like cpu — clamped 4..12: ≤4c→4, 8c→8,
        // ≥12c→12. Explicit env/admin values still win.
        dynamicDefault: ({ cpuCores }) => ioClassConcurrencyDefault(cpuCores),
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 64 },
        uiHints: { advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_CONCURRENCY_EMBEDDING',
        type: 'number',
        label: 'Task Runner Embedding Concurrency',
        description:
            'Concurrent jobs for the embedding-class worker (library/discovery/music embeddings). Default 1: OpenAI rate limits mean more slots burn wallclock, not throughput.',
        defaultValue: 1,
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 16 },
        uiHints: { advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_CONCURRENCY_MAINTENANCE',
        type: 'number',
        label: 'Task Runner Maintenance Concurrency',
        description:
            'Concurrent jobs for the maintenance-class worker (cache cleanup, oauth cleanup, history cleanup). Default 1: these run on a periodic schedule, not per item.',
        defaultValue: 1,
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 16 },
        uiHints: { advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_CONCURRENCY_INGEST',
        type: 'number',
        label: 'Task Runner Ingest Concurrency',
        description:
            'Concurrent jobs for the ingest-class worker: the file-fast path (media-probe, integrity-file-present, image-sync, chapter-sync, file-library-scan, trickplay-params-sync). Default 2; raise it to drain new files faster on multi-core hosts.',
        defaultValue: 2,
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 32 },
        uiHints: { advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_CONCURRENCY_BULK',
        type: 'number',
        label: 'Task Runner Bulk Concurrency',
        description:
            'Concurrent jobs for bulk-class tasks: mass-enrichment, API-bound work (tmdb-metadata-sync, mdblist-sync, album/artist-enrichment, music-popularity, fribb/mal-anime-sync). Default 3, so series syncs do not queue behind a single slot; per-provider rate limits still cap the request rate. With per-task queues this is also the per-task cap for each bulk task.',
        // Must equal the config.ts fallback (pinned by
        // config.resource-class-defaults.test.ts). Raised 1→3 in 6ac5d27f8, which
        // only changed config.ts, so the running app kept using 1 until this fix.
        defaultValue: 3,
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 16 },
        uiHints: { advanced: true },
        requiresRestart: true,
    },
    {
        key: 'PROVIDER_ARTWORK_BACKFILL_ENABLED',
        type: 'boolean',
        label: 'Provider Artwork Backfill',
        description:
            'Downloads and saves posters, backdrops, logos, episode thumbnails, and season posters to local storage, so artwork keeps working even if the source (TMDB, etc.) becomes unreachable later. On by default. Turn off to stop new downloads immediately; artwork already saved is unaffected.',
        defaultValue: true,
        section: 'advanced-tasks',
        // The feature's on/off switch: not an expert knob, so not `advanced`.
        uiHints: {},
    },
    {
        key: 'PROVIDER_ARTWORK_MIN_FREE_GB',
        type: 'number',
        label: 'Provider Artwork: Minimum Free Space (GB)',
        description:
            'Artwork downloads pause automatically when free disk space on any target drive drops below this amount (checked separately for the config volume and each media folder).',
        defaultValue: 5,
        section: 'advanced-tasks',
        validation: { min: 0, max: 10000 },
        uiHints: { advanced: true },
    },
    {
        key: 'STORAGE_LOW_SPACE_WARN_GB',
        type: 'number',
        label: 'Warn when free disk space drops below (GB)',
        description:
            'Raises a "disk nearly full" problem on the dashboard when any drive Lumastra writes to has less than this much space left. Set to 0 to turn the warning off. This only controls the WARNING — it does not change when Lumastra stops writing, which has its own setting.',
        defaultValue: 5,
        section: 'advanced-tasks',
        validation: { min: 0, max: 10000 },
        uiHints: { advanced: true },
    },
    {
        key: 'PROVIDER_ARTWORK_MAX_ITEMS_PER_HOUR',
        type: 'number',
        label: 'Provider Artwork: Items Per Hour',
        description:
            'Limits how many artwork files are downloaded per hour, so this does not hammer your connection or the metadata provider. 0 removes the limit; the default (2000) works out to roughly 300 MB/hour.',
        defaultValue: 2000,
        section: 'advanced-tasks',
        validation: { min: 0, max: 1000000 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_CONCURRENCY_ANALYSIS',
        type: 'number',
        label: 'Task Runner Analysis Concurrency',
        description:
            "Concurrent jobs for the analysis-class worker (intro analyzer chromaprint), isolated from the cpu class so trickplay and intro analysis can't starve each other. Default 1: each job already fans out across a whole season and maximizes ffmpeg use internally.",
        defaultValue: 1,
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 8 },
        uiHints: { advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_CONCURRENCY_DISCOVERY',
        type: 'number',
        label: 'Task Runner Discovery-Embedding Concurrency',
        description:
            "Concurrent jobs for the discovery-class worker (catalog/discovery embedding backfill), isolated from the embedding class so a large backfill can't starve your library/music embeddings. Default 1: this is OpenAI/Voyage API-bound and rate-limited, so the separate class exists for fairness, not parallelism.",
        defaultValue: 1,
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 8 },
        uiHints: { advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_TASK_HTTP_DEFAULT_RPS',
        type: 'number',
        label: 'Task ctx.http Default Rate Cap',
        description:
            "Default per-task rate cap (requests/second) for `ctx.http`, applied when a task doesn't declare a provider-specific limit via `externalDeps` and `ctx.dep(name).fetch()`. Acts as a cross-replica safety net, not a per-provider budget; set to 0 to disable it (unbounded outbound HTTP, not recommended).",
        defaultValue: 10,
        section: 'advanced-tasks-tuning',
        validation: { min: 0, max: 1000 },
        uiHints: { advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_FFMPEG_THREADS',
        type: 'number',
        label: 'FFmpeg Thread Cap',
        description:
            'Per-invocation thread cap injected as `-threads N` into every spawned ffmpeg. Default 4 is enough for fast trickplay/keyframe extraction without monopolizing the host; set to 0 to let ffmpeg auto-detect and use all cores (best for dedicated transcoding hosts).',
        defaultValue: 4,
        section: 'advanced-tasks-tuning',
        validation: { min: 0, max: 64 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_RUN_HEARTBEAT_INTERVAL_MS',
        type: 'number',
        label: 'Run Heartbeat Interval',
        description:
            'How often (ms) the runner refreshes the run heartbeat in Valkey and Postgres. Boot recovery treats heartbeat_at older than 2 min as orphaned, so the default 30 000 ms gives 4× safety margin.',
        defaultValue: 30_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 5_000, max: 120_000 },
        uiHints: { suffix: 'ms', advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_RUN_STALL_WARN_MS',
        type: 'number',
        label: 'Run Stall Warn Threshold',
        description:
            'When a run has not successfully heartbeated for this long (ms), the runner logs a one-shot warning so operators can correlate the stall with whatever the worker was doing. Default 120 000 ms (2 min).',
        defaultValue: 120_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 30_000, max: 1_800_000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'LUMASTRA_RUN_STALL_FAIL_MS',
        type: 'number',
        label: 'Run Stall Auto-Fail Threshold',
        description:
            'When a run has not successfully heartbeated for this long (ms), the runner transitions it to failed with errorKind=runtime. The worker thread may still be wedged (e.g. NFS stall) but the run is no longer tracked as active. Default 600 000 ms (10 min).',
        defaultValue: 600_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 60_000, max: 7_200_000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'LUMASTRA_WORKER_CONN_WEDGE_MS',
        type: 'number',
        label: 'Worker Connection-Wedge Timeout',
        description:
            'If BullMQ workers emit connection errors continuously for this long (ms) with no job processed, their task-Valkey connections are considered wedged (e.g. after a Valkey partition or peer-IP change) and the process exits so the container restart policy can recover it with fresh connections. Set to 0 to disable. Default 120 000 ms (2 min).',
        defaultValue: 120_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 0, max: 3_600_000 },
        uiHints: { suffix: 'ms', advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_BULLMQ_LOCK_DURATION_MS',
        type: 'number',
        label: 'BullMQ Job Lock Duration',
        description:
            "How long (ms) a worker holds a BullMQ job lock before it must be renewed (stalledInterval is pinned to the same value); the runner's own heartbeat and stall watchdog are the authoritative liveness check, so this only governs lock ownership. Default 300 000 ms (5 min) avoids false-failing long I/O-bound jobs like file-library-scan when the event loop stalls under host load. Set to 0 to use BullMQ's 30 000 ms default.",
        defaultValue: 300_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 0, max: 3_600_000 },
        uiHints: { suffix: 'ms', advanced: true },
        requiresRestart: true,
    },
    {
        key: 'LUMASTRA_QUEUE_DEPTH_CAP_CPU',
        type: 'number',
        label: 'Queue Depth Cap: CPU',
        description:
            'Maximum waiting+prioritized+delayed jobs in the cpu-class queue before backpressure triggers. Default 500.',
        defaultValue: 500,
        section: 'advanced-tasks-tuning',
        validation: { min: 10, max: 100_000 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_QUEUE_DEPTH_CAP_IO',
        type: 'number',
        label: 'Queue Depth Cap: IO',
        description:
            'Maximum waiting+prioritized+delayed jobs in the io-class queue before backpressure triggers. Default 2 000.',
        defaultValue: 2_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 10, max: 100_000 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_QUEUE_DEPTH_CAP_EMBEDDING',
        type: 'number',
        label: 'Queue Depth Cap: Embedding',
        description:
            'Maximum waiting+prioritized+delayed jobs in the embedding-class queue before backpressure triggers. Default 10 000.',
        defaultValue: 10_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 10, max: 1_000_000 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_QUEUE_DEPTH_CAP_MAINTENANCE',
        type: 'number',
        label: 'Queue Depth Cap: Maintenance',
        description:
            'Maximum waiting+prioritized+delayed jobs in the maintenance-class queue before backpressure triggers. Default 100.',
        defaultValue: 100,
        section: 'advanced-tasks-tuning',
        validation: { min: 10, max: 10_000 },
        uiHints: { advanced: true },
    },
    {
        key: 'INTEGRITY_MAX_FINDINGS_PER_RULE',
        type: 'number',
        label: 'Integrity Scanner: Max Findings Per Rule',
        description:
            'Limits how many problems the integrity checker processes per issue type in each scheduled run. Higher clears a backlog of known issues faster but makes each run take longer. The default (25,000), on the 6-hour schedule, works through roughly 100,000 issues a day.',
        defaultValue: 25000,
        section: 'advanced-tasks',
        validation: { min: 100, max: 500_000 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_QUEUE_DEPTH_CAP_INGEST',
        type: 'number',
        label: 'Queue Depth Cap: Ingest',
        description:
            'Maximum waiting+prioritized+delayed jobs in the ingest-class queue before backpressure triggers. Default 50 000, higher than the io cap since a fresh library scan can enqueue tens of thousands of fast-path file ops back to back.',
        defaultValue: 50_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 10, max: 1_000_000 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_QUEUE_DEPTH_CAP_BULK',
        type: 'number',
        label: 'Queue Depth Cap: Bulk',
        description:
            'Maximum waiting+prioritized+delayed jobs in the bulk-class queue before backpressure triggers. Default 2 000, matched to the io baseline; bulk enrichment is API-bound, so a deeper cap buys head-of-line latency without more throughput.',
        defaultValue: 2_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 10, max: 100_000 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_QUEUE_DEPTH_CAP_ANALYSIS',
        type: 'number',
        label: 'Queue Depth Cap: Analysis',
        description:
            'Maximum waiting+prioritized+delayed jobs in the analysis-class queue before backpressure triggers. Default 500, matched to the cpu baseline; analysis is ffmpeg-bound and per-season, so even a large library produces only a few hundred fan-out jobs at once.',
        defaultValue: 500,
        section: 'advanced-tasks-tuning',
        validation: { min: 10, max: 100_000 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_QUEUE_DEPTH_CAP_DISCOVERY',
        type: 'number',
        label: 'Queue Depth Cap: Discovery Embeddings',
        description:
            'Maximum waiting+prioritized+delayed jobs in the discovery-class queue before backpressure triggers. Default 10000, matched to the embedding cap; a fresh-install discovery flood can enqueue tens of thousands of catalog embedding jobs back to back.',
        defaultValue: 10_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 10, max: 100_000 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_CIRCUIT_FAILURE_THRESHOLD',
        type: 'number',
        label: 'Circuit Breaker Failure Threshold',
        description:
            'Number of consecutive task failures that opens the circuit breaker. Default 5.',
        defaultValue: 5,
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 100 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_CIRCUIT_FAILURE_RATE_WINDOW_MS',
        type: 'number',
        label: 'Circuit Breaker Rate Window',
        description:
            'Sliding window length (ms) for the failure-rate secondary circuit-breaker trigger. Default 1 800 000 ms (30 min).',
        defaultValue: 1_800_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 60_000, max: 86_400_000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    {
        key: 'LUMASTRA_CIRCUIT_FORCE_ENABLE_TTL_MS',
        type: 'number',
        label: 'Circuit Breaker Force-Enable TTL',
        description:
            'How long (ms) an admin force-enable bypass remains active. Default 86 400 000 ms (24 h).',
        defaultValue: 86_400_000,
        section: 'advanced-tasks-tuning',
        validation: { min: 60_000, max: 604_800_000 },
        uiHints: { suffix: 'ms', advanced: true },
    },

    // ── Task System — Metrics ────────────────────────────────────────────────
    {
        key: 'LUMASTRA_METRICS_BEARER_TOKEN',
        type: 'string',
        label: 'Metrics Bearer Token',
        description:
            'Bearer token required to scrape the /metrics endpoint. When set, requests must supply `Authorization: Bearer <token>`. When empty the endpoint is locked unless LUMASTRA_METRICS_PUBLIC is explicitly enabled.',
        defaultValue: '',
        section: 'network',
        uiHints: { sensitive: true, advanced: true },
    },
    {
        key: 'LUMASTRA_METRICS_PUBLIC',
        type: 'boolean',
        label: 'Open Metrics Endpoint (no auth)',
        description:
            'When true, the /metrics endpoint is accessible without any authentication. Only enable this when the endpoint is protected at the network layer. Default: false (locked).',
        defaultValue: false,
        section: 'network',
        uiHints: { advanced: true },
    },

    // ── Task System — Webhook delivery ───────────────────────────────────────
    {
        key: 'LUMASTRA_WEBHOOK_RETRY_ATTEMPTS',
        type: 'number',
        label: 'Webhook Retry Attempts',
        description:
            'Maximum delivery attempts for each webhook outbox entry before dead-lettering.',
        defaultValue: 8,
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 20 },
        uiHints: { advanced: true },
    },
    {
        key: 'LUMASTRA_WEBHOOK_DELIVERY_CONCURRENCY',
        type: 'number',
        label: 'Webhook Delivery Concurrency',
        description: 'Maximum concurrent webhook outbox deliveries in-flight at once.',
        defaultValue: 16,
        section: 'advanced-tasks-tuning',
        validation: { min: 1, max: 100 },
        uiHints: { advanced: true },
    },
    {
        key: 'WEBHOOK_PRIVATE_HOST_ALLOWLIST',
        type: 'array',
        label: 'Webhook Private Host Allowlist',
        description:
            'Private hostnames that admin webhooks may deliver to, such as an in-cluster bot or a LAN Home Assistant / n8n. Comma-separated; an entry starting with a dot (.svc.cluster.local) matches every host ending in it. Empty (default) rejects all private, loopback and link-local targets. Applies to admin webhooks only; per-user notification webhooks always stay public-only.',
        defaultValue: '',
        section: 'advanced-tasks-tuning',
        uiHints: { advanced: true, placeholder: 'mediabot-notify.arr.svc.cluster.local' },
    },

    // ── Task System — SSE / progress coalescing ──────────────────────────────

    // ── Task System — task_history retention ─────────────────────────────────
    {
        key: 'LUMASTRA_TASK_HISTORY_HOT_DAYS',
        type: 'number',
        label: 'Task History Hot Retention',
        description:
            'How many days of task run history stay in fast storage for quick access in the admin dashboard. Older runs move to the slower archive below instead of being deleted right away.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 7, max: 730 },
        uiHints: { suffix: 'days', advanced: true },
    },

    // ── Task System — Plugin upgrade + orphan recovery ───────────────────────

    // ── Task System — Failure event retention ────────────────────────────────
    {
        key: 'LUMASTRA_FAILURE_EVENT_RETENTION_DAYS',
        type: 'number',
        label: 'Failure Event Retention',
        description:
            'How many days of plugin/task failure records are kept for the admin failure log before being deleted.',
        defaultValue: 90,
        section: 'advanced-tasks',
        validation: { min: 7, max: 730, integer: true },
        uiHints: { suffix: 'days', advanced: true },
    },

    // ── Database Cleanup — per-table retention periods ────────────────────────
    {
        key: 'UNAVAILABLE_MEDIA_RETENTION_DAYS',
        type: 'number',
        label: 'Unavailable Media Retention',
        description:
            'Days to retain music, video and audiobooks after their files disappear. Set to 0 to disable cleanup. The daily cleanup removes expired entries only with healthy library scans and no user data or operator curation. Ratings, favourites, playlists and listening history keep their entries. Returning files restore the existing entry during this period. When upgrading to the 30-day default, a one-time migration restarts existing loss clocks at deployment, giving currently unavailable entries a full retention window (30 days with the default). Scans with any errors or still in progress postpone cleanup.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 0, max: 3650, integer: true },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_ASSISTANT_RATE_LIMITS_DAYS',
        type: 'number',
        label: 'Rate Limit History Retention',
        description:
            'How many days of AI assistant rate-limit counters are kept. Old counters are never read again, so this is purely database housekeeping.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 7, max: 365 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'TRANSCODE_FAILURE_RETENTION_DAYS',
        type: 'number',
        label: 'Transcode Failure Retention',
        description:
            'How many days of video transcode failure details are kept for the Transcode Failures admin page before being deleted.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 1, max: 365, integer: true },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'LIVETV_FAILURE_RETENTION_DAYS',
        type: 'number',
        label: 'Live TV Failure Retention',
        description:
            'How many days of Live TV stream failure details are kept for the Failures tab under Settings → Live TV before being deleted.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 1, max: 365, integer: true },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'PLAYBACK_INCIDENT_RETENTION_DAYS',
        type: 'number',
        label: 'Playback Incident Retention',
        description:
            'How many days of client-reported playback problems (errors, reconnects, failed streams) are kept before being deleted. Playback Incident Max Rows Per User below is a backup limit for installs where this cleanup task never gets to run.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 1, max: 365, integer: true },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'SEGMENT_DELIVERY_FAILURE_RETENTION_DAYS',
        type: 'number',
        label: 'Segment Delivery Failure Retention',
        description:
            'How many days of HLS segment delivery failures (segments or playlists a player asked for and did not get) are kept before being deleted. These are recorded per play session and answer whether a stalled stream was the server failing to deliver.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 1, max: 365, integer: true },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'PLAYBACK_INCIDENT_MAX_ROWS_PER_USER',
        type: 'number',
        label: 'Playback Incident Max Rows Per User',
        description:
            "Hard cap on how many playback-problem records are kept per user, enforced independently of the retention setting above — protects an unattended install even if the cleanup task never runs. Also the most new playback-problem reports accepted per user in any 24 hours; extra reports are dropped. Scoped per user so one misbehaving device can't crowd out another user's history.",
        defaultValue: 500,
        section: 'advanced-tasks',
        validation: { min: 1, max: 10_000, integer: true },
        uiHints: { advanced: true },
    },
    {
        key: 'CLIENT_DIAGNOSTICS_RETENTION_DAYS',
        type: 'number',
        label: 'Client Diagnostics Retention',
        description:
            'How many days crash reports, app hangs, JavaScript errors and API failure counts from apps are kept.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 1, max: 365, integer: true },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'CLIENT_LOG_BUNDLE_RETENTION_DAYS',
        type: 'number',
        label: 'Client Log Bundle Retention',
        description: 'How many days log bundles sent from apps are kept.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 1, max: 365, integer: true },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'CLIENT_DIAGNOSTICS_MAX_ROWS_PER_USER',
        type: 'number',
        label: 'Client Diagnostics Max Rows Per User',
        description:
            'Hard cap on non-playback diagnostics per user, enforced independently of retention.',
        defaultValue: 1000,
        section: 'advanced-tasks',
        validation: { min: 1, max: 100_000, integer: true },
        uiHints: { advanced: true },
    },
    {
        key: 'CLIENT_DIAGNOSTICS_DAILY_BYTES_PER_USER',
        type: 'number',
        label: 'Client Diagnostics Daily Budget Per User',
        description:
            "Maximum bytes of diagnostics one user's devices may upload per rolling 24 hours. Automatic reports over budget are dropped; log bundles are refused.",
        defaultValue: 52_428_800,
        section: 'advanced-tasks',
        validation: { min: 1_048_576, max: 1_073_741_824, integer: true },
        uiHints: { suffix: 'bytes', advanced: true },
    },
    {
        key: 'DB_CLEANUP_CLUSTER_NODE_EVENTS_DAYS',
        type: 'number',
        label: 'Cluster Event Retention',
        description:
            'How many days of cluster node online/offline history are kept (only relevant if you run more than one Lumastra instance).',
        defaultValue: 90,
        section: 'advanced-tasks',
        validation: { min: 7, max: 730 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_FILE_SCANNER_RUNS_DAYS',
        type: 'number',
        label: 'Scanner Run Log Retention',
        description: 'How many days of library-scan run logs are kept.',
        defaultValue: 90,
        section: 'advanced-tasks',
        validation: { min: 7, max: 730 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_PLUGIN_SECRET_ACCESS_LOG_DAYS',
        type: 'number',
        label: 'Secret Access Audit Retention',
        description:
            'How many days of plugin secret-access audit logs are kept — records of which plugin read which stored credential, for security review.',
        defaultValue: 90,
        section: 'advanced-tasks',
        validation: { min: 7, max: 730 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'ADMIN_AUDIT_LOG_RETENTION_DAYS',
        type: 'number',
        label: 'Admin Audit Log Retention',
        description:
            'How many days of admin action history (who changed what in the admin panel) are kept. Minimum 7 days. If you are subject to compliance requirements, consider 180 days or more.',
        defaultValue: 90,
        section: 'advanced-tasks',
        validation: { min: 7, max: 3650, integer: true },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_ASSISTANT_MESSAGES_DAYS',
        type: 'number',
        label: 'AI Chat History Retention',
        description: 'How many days of AI assistant chat history are kept before being deleted.',
        defaultValue: 365,
        section: 'advanced-tasks',
        validation: { min: 30, max: 1825 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_CHAT_MESSAGES_DAYS',
        type: 'number',
        label: 'Watch Party Chat Retention',
        description:
            'How many days of watch-party and playlist chat messages are kept before being deleted.',
        defaultValue: 365,
        section: 'advanced-tasks',
        validation: { min: 30, max: 1825 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_TASK_QUOTA_USAGE_DAYS',
        type: 'number',
        label: 'Task Quota Usage Retention',
        description: 'How many days of daily task-usage/quota records are kept.',
        defaultValue: 365,
        section: 'advanced-tasks',
        validation: { min: 30, max: 1825 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_TASK_WEBHOOK_OUTBOX_DAYS',
        type: 'number',
        label: 'Webhook Outbox Retention',
        description:
            'How many days of delivered or permanently-failed webhook deliveries are kept before being deleted.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 7, max: 365 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_EVENT_OUTBOX_DAYS',
        type: 'number',
        label: 'Pipeline Event Outbox Retention',
        description:
            'How many days of already-processed internal event records are kept. Events that failed to process and were dead-lettered are never automatically deleted, regardless of this setting.',
        defaultValue: 7,
        section: 'advanced-tasks',
        validation: { min: 1, max: 90 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_TASK_HISTORY_ARCHIVE_DAYS',
        type: 'number',
        label: 'Task History Archive Retention',
        description:
            'How many days before permanently deleting archived task run history. A run explicitly marked to keep forever is never deleted by this.',
        defaultValue: 730,
        section: 'advanced-tasks',
        validation: { min: 365, max: 3650 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_WATCH_HISTORY_DAYS',
        type: 'number',
        label: 'Watch History Retention',
        description:
            'How many days of watch history (what was played and when) are kept, measured from when playback started. ' +
            'Older entries are deleted in the background. Default 400 days.',
        defaultValue: 400,
        section: 'advanced-tasks',
        validation: { min: 30, max: 3650 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_LIVETV_WATCH_HISTORY_DAYS',
        type: 'number',
        label: 'LiveTV Watch History Retention',
        description: 'How many days of Live TV channel-watching history are kept per user.',
        defaultValue: 180,
        section: 'advanced-tasks',
        validation: { min: 7, max: 1825 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_MEDIA_EVENTS_ARCHIVE_DAYS',
        type: 'number',
        label: 'Media Event Archive Threshold',
        description:
            'How many days before recent playback activity events are moved out of fast storage into a cold archive — still kept, just slower to query.',
        defaultValue: 365,
        section: 'advanced-tasks',
        validation: { min: 30, max: 1825 },
        uiHints: { suffix: 'days', advanced: true },
    },
    {
        key: 'DB_CLEANUP_MEDIA_EVENTS_PURGE_DAYS',
        type: 'number',
        label: 'Media Event Purge Threshold',
        description:
            'How many days before archived playback activity events are permanently deleted. Must be set higher than the archive threshold above.',
        defaultValue: 1825,
        section: 'advanced-tasks',
        validation: { min: 90, max: 7300 },
        uiHints: { suffix: 'days', advanced: true },
    },

    // ── Never-owned media cleanup ─────────────────────────────────────────────
    {
        key: 'NEVER_OWNED_MEDIA_GC_ENABLED',
        type: 'boolean',
        label: 'Delete Never-Owned Catalog Entries',
        description:
            'The daily "Remove Never-Owned Catalog Entries" task deletes movies and series that were never in your library (discovery and catalog entries without files, with their seasons and episodes) once they are older than the age below and nothing references them: ratings, watchlists, playlists, watch history, comments, mutes, admin edits and Live TV all keep an entry. Off (default): the task only reports what it would delete, in its run log under Admin → Tasks. Turn this on after checking that report.',
        defaultValue: false,
        section: 'advanced-tasks',
        requiresRestart: false,
    },
    {
        key: 'NEVER_OWNED_MEDIA_GC_MIN_AGE_DAYS',
        type: 'number',
        label: 'Never-Owned Entry Minimum Age',
        description:
            'How many days a never-owned movie or series must exist before the cleanup may delete it. Younger entries are kept, so a title found by discovery stays around long enough to be used. Titles still refreshed by discovery are kept.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 7, max: 3650, integer: true },
        uiHints: { suffix: 'days', advanced: true },
        requiresRestart: false,
    },

    // ── Task System — Audit tamper evidence ──────────────────────────────────

    // =========================================================================
    // Background Task Killswitches
    // =========================================================================
    {
        key: 'DISABLE_DATABASE_CLEANUP',
        type: 'boolean',
        label: 'Run Database Cleanup',
        description:
            'Runs on a schedule to tidy up the database — removing orphaned catalogue entries, merging duplicate artists, and clearing out old internal bookkeeping. On by default. Turn this off to stop it (both scheduled and manually-triggered runs); your library keeps working either way, but the database accumulates more clutter over time.',
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_DUMMY_INTEGRATION',
        type: 'boolean',
        label: 'Enable Dummy Integration',
        description:
            'Keeps the built-in example webhook/notification integration available, used to test the plugin system. On by default. Turn this off to hide it — most self-hosters have no reason to touch this; it never sends or receives real notifications.',
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_FILE_LIBRARY_SCAN',
        type: 'boolean',
        label: 'Scan Library Folders on a Schedule',
        description:
            'Scans your library folders for new, changed, or removed files so new content shows up automatically. On by default. Turn this off to stop the scan (both scheduled and manually-triggered runs, including its file-reconcile companion) — files you add to disk will no longer be picked up until you turn it back on or trigger a scan by hand.',
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_FRIBB_ANIME_SYNC',
        type: 'boolean',
        label: 'Sync Anime Cross-Reference IDs',
        description:
            'Looks up cross-reference IDs for anime titles so they link correctly to other anime databases. On by default. Turn this off to stop the lookups — anime metadata matching against those external sources gets less accurate, but nothing else is affected.',
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_HOLIDAY_RECOMMENDATIONS',
        type: 'boolean',
        label: 'Show Holiday Recommendations',
        description:
            'Shows seasonal recommendation rows (for example around Halloween or the winter holidays) on the home page. Off by default. Turn this on to show them; the rest of the home page is unaffected.',
        defaultValue: true,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_INTEGRITY_SCANNER',
        type: 'boolean',
        label: 'Run Integrity Scanner',
        description:
            "Periodically checks your library for problems — missing files, stuck processing, and other inconsistencies — and reports them on the admin dashboard. On by default. Turn this off to stop the checks; existing problems won't be found automatically, and you'll need to notice them yourself.",
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_JELLYFIN_DISK_TRICKPLAY',
        type: 'boolean',
        label: 'Reuse Jellyfin Trickplay Thumbnails',
        description:
            "Lets Lumastra reuse the scrubbing-preview thumbnails Jellyfin already generated on disk, instead of relying only on its own. On by default (Jellyfin's thumbnails are used when present). Turn this off to stop reading them — scrub-bar previews then depend entirely on Lumastra's own generator, if that's enabled.",
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_LOCAL_TRICKPLAY',
        type: 'boolean',
        label: 'Serve Local Trickplay Thumbnails',
        description:
            'Serves the scrubbing-preview thumbnails that Lumastra generates itself. On by default. Turn this off to stop serving them — the video scrub bar shows no preview thumbnails unless Jellyfin-generated ones are available instead.',
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_MAL_ANIME_ENRICHMENT',
        type: 'boolean',
        label: 'Enrich Anime via MyAnimeList',
        description:
            'Looks up MyAnimeList IDs and details for your anime titles, used for richer metadata and cross-linking. On by default. Turn this off to stop it — anime metadata from MyAnimeList will no longer update.',
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_MEDIA_PROBE',
        type: 'boolean',
        label: 'Probe Media Files',
        description:
            "Reads resolution, codecs, and audio/subtitle tracks from your media files so Lumastra knows what's actually in them. On by default. Turn this off to stop it — quality badges go missing and the player may pick the wrong audio or subtitle track for new files.",
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_MUSIC_ANALYSIS',
        type: 'boolean',
        label: 'Analyse Music Files',
        description:
            "Analyses your music files to fingerprint tracks and pull out audio characteristics (tempo, energy, mood) used for recommendations and duplicate detection. On by default. Turn this off to stop it — new tracks won't get these features, so music recommendations involving them will be weaker.",
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_MUSIC_ARTWORK_ENRICHMENT',
        type: 'boolean',
        label: 'Look Up Music Artwork Online',
        description:
            'Fetches artist photos and album covers your files lack from TheAudioDB, Deezer and the Cover Art Archive, sending them artist and album names. No API key needed; on by default. Turn this off to keep music artwork lookups on this server — artists and albums without embedded or folder artwork stay without a picture.',
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'MUSIC_ANALYSIS_ENGINE',
        type: 'select',
        label: 'Music Analysis Engine',
        description:
            "Which engine analyses your music files for audio features (tempo, loudness, mood) used in recommendations. 'Built-in' (default) works out of the box everywhere except arm64/WSL2, where it can crash — switch to 'Sidecar service' there, which also measures loudness more accurately. Automatically falls back to the built-in engine if no sidecar is configured.",
        defaultValue: 'essentia',
        section: 'advanced-tasks',
        validation: {
            options: [
                { value: 'essentia', label: 'Built-in analyzer (default)' },
                { value: 'sidecar', label: 'Sidecar service (for arm64/WSL2)' },
            ],
        },
        uiHints: {
            advanced: true,
        },
    },
    {
        key: 'MUSIC_ANALYSIS_MAX_DURATION_MINUTES',
        type: 'number',
        label: 'Skip Music Analysis Above (minutes)',
        description:
            'Tracks longer than this are not analysed for tempo, key, energy and mood — DJ mixes and full-album rips have no single tempo or key, and the analyser usually gives up on them anyway. They are marked as skipped rather than failed, so they no longer show up as errors. 0 analyses every track regardless of length. Raising the limit re-queues the tracks it had skipped.',
        defaultValue: 30,
        section: 'advanced-tasks',
        validation: { min: 0, max: 1440 },
        uiHints: { advanced: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_OAUTH_CLEANUP',
        type: 'boolean',
        label: 'Run OAuth Cleanup',
        description:
            'Regularly purges expired sign-in tokens, device codes, and stale sessions from the database. On by default. Turn this off to stop the cleanup — expired records pile up in the database, but nothing user-facing breaks.',
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_TELEMETRY_CLEANUP',
        type: 'boolean',
        label: 'Run Telemetry Cleanup',
        description:
            'Regularly purges old task telemetry and run-history rows once they age out. On by default. Turn this off to stop the cleanup — old task history sticks around longer, using more database storage over time.',
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_TRICKPLAY_PARAMS',
        type: 'boolean',
        label: 'Sync Trickplay Params',
        description:
            'Keeps scrubbing-preview (trickplay) settings up to date after your media files change. On by default. Turn this off to stop it — the video scrub bar may show stale or missing preview thumbnails for recently-changed files.',
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'DISABLE_CURATED_LISTS_SYNC',
        type: 'boolean',
        label: 'Sync Curated Lists',
        description:
            "Syncs curated content lists from MDBList into your catalogue (for example 'Best of' collections). On by default. Turn this off to stop the sync — lists you already have stay as they are, but stop receiving updates.",
        defaultValue: false,
        section: 'advanced-tasks',
        uiHints: { invert: true },
        requiresRestart: false,
    },
    {
        key: 'PLUGIN_DUMMY_ENABLED',
        type: 'boolean',
        label: 'Enable Dummy Feature Plugin',
        description:
            'Turns on the built-in example HTTP-route plugin, used as a reference for plugin development. On by default in development, off in production. Most self-hosters have no reason to enable this.',
        defaultValue: false,
        section: 'advanced-tasks',
    },
    {
        key: 'PLUGIN_DUMMY_INTEGRATION_ENABLED',
        type: 'boolean',
        label: 'Enable Dummy Integration Plugin',
        description:
            'Turns on the built-in example webhook/notification plugin, used as a reference for plugin development. On by default in development, off in production. Most self-hosters have no reason to enable this — it is separate from the kill switch above, which fully disables it even when this is on.',
        defaultValue: false,
        section: 'advanced-tasks',
    },
    {
        key: 'PLUGIN_LUMASTRA_INTRO_ANALYZER_ENABLED',
        type: 'boolean',
        label: 'Enable Lumastra Intro Analyzer',
        description:
            "Detects intro and end-credit segments in your videos automatically, so players can offer a 'Skip Intro' button. On by default. Turn off to stop detecting new segments; segments already found keep working.",
        defaultValue: true,
        section: 'advanced-tasks',
    },
    // -------------------------------------------------------------------------
    // CORS
    // -------------------------------------------------------------------------
    {
        key: 'CORS_ALLOWED_ORIGINS',
        type: 'array',
        label: 'CORS Allowed Origins',
        description:
            'Comma-separated list of additional CORS origins (e.g. your Jellyfin URL). These are appended to the built-in allowlist. In development the Jellyfin dev origin (localhost:8096) is added automatically.',
        defaultValue: '',
        section: 'network',
        uiHints: { advanced: true },
    },
    // -------------------------------------------------------------------------
    // Cache Warming
    // -------------------------------------------------------------------------
    {
        key: 'CACHE_WARMING_ENABLED',
        type: 'boolean',
        label: 'Cache Warming Enabled',
        description:
            'Enable background cache warming at startup. Pre-populates frequently-accessed data (trending, metadata, AI suggestions, hero) so the first real requests are fast.',
        defaultValue: true,
        section: 'advanced-tasks',
        requiresRestart: true,
    },
    {
        key: 'CACHE_WARM_TRENDING',
        type: 'boolean',
        label: 'Cache Warming: Trending',
        description: 'Warm the trending content list at startup.',
        defaultValue: true,
        section: 'advanced-tasks',
        uiHints: { advanced: true },
        dependsOn: 'CACHE_WARMING_ENABLED',
    },
    {
        key: 'CACHE_WARM_METADATA',
        type: 'boolean',
        label: 'Cache Warming: Metadata',
        description: 'Warm item metadata for recently-active users at startup.',
        defaultValue: true,
        section: 'advanced-tasks',
        uiHints: { advanced: true },
        dependsOn: 'CACHE_WARMING_ENABLED',
    },
    {
        key: 'CACHE_WARM_HERO',
        type: 'boolean',
        label: 'Cache Warming: Hero Next-Up',
        description: 'Warm hero Next-Up items for recently-active users at startup.',
        defaultValue: true,
        section: 'advanced-tasks',
        uiHints: { advanced: true },
        dependsOn: 'CACHE_WARMING_ENABLED',
    },
    {
        key: 'CACHE_WARM_BROWSE',
        type: 'boolean',
        label: 'Cache Warming: Browse Pages',
        description: 'Warm browse pages at startup.',
        defaultValue: true,
        section: 'advanced-tasks',
        uiHints: { advanced: true },
        dependsOn: 'CACHE_WARMING_ENABLED',
    },
    {
        key: 'CACHE_WARM_USERS_LIMIT',
        type: 'number',
        label: 'Cache Warming: Max Active Users',
        description: 'Maximum number of recently-active users whose data is warmed at startup.',
        defaultValue: 20,
        section: 'advanced-tasks',
        validation: { min: 1, max: 500 },
        uiHints: { advanced: true },
        dependsOn: 'CACHE_WARMING_ENABLED',
    },
    {
        key: 'CACHE_WARM_METADATA_LIMIT',
        type: 'number',
        label: 'Cache Warming: Metadata Items per User',
        description: 'Maximum number of metadata items to warm per active user.',
        defaultValue: 100,
        section: 'advanced-tasks',
        validation: { min: 1, max: 5000 },
        uiHints: { advanced: true },
        dependsOn: 'CACHE_WARMING_ENABLED',
    },
    {
        key: 'CACHE_WARM_ACTIVE_DAYS',
        type: 'number',
        label: 'Cache Warming: Active User Window (days)',
        description: 'How many days back to look when finding recently-active users to warm.',
        defaultValue: 14,
        section: 'advanced-tasks',
        validation: { min: 1, max: 365 },
        uiHints: { advanced: true, suffix: 'd' },
        dependsOn: 'CACHE_WARMING_ENABLED',
    },
    {
        key: 'CACHE_WARM_NIGHTLY_HOUR',
        type: 'number',
        label: 'Cache Warming: Nightly Run Hour',
        description: 'Hour of day (0-23 UTC) at which the nightly full cache warming run fires.',
        defaultValue: 3,
        section: 'advanced-tasks',
        validation: { min: 0, max: 23 },
        uiHints: { advanced: true, suffix: 'h UTC' },
        dependsOn: 'CACHE_WARMING_ENABLED',
        requiresRestart: true,
    },
    // -------------------------------------------------------------------------
    // Task System — Input size cap
    // -------------------------------------------------------------------------
    {
        key: 'LUMASTRA_MAX_TASK_INPUT_BYTES',
        type: 'number',
        label: 'Max Task Input Size',
        description:
            'Maximum size of the data passed into a single background task run. Protects the database and job queue from oversized payloads. Invalid values fall back to 256 KiB. Default: 262,144 bytes (256 KiB).',
        defaultValue: 262144,
        section: 'advanced-tasks',
        validation: { min: 1024, max: 104857600 },
        uiHints: { suffix: 'bytes', advanced: true },
    },
    // -------------------------------------------------------------------------
    // External plugin install — non-secret fetch limits (trust keys/gate flags
    // are ENV-only and deliberately NOT registered here). [Fable-1]
    // -------------------------------------------------------------------------
    {
        key: 'PLUGIN_INSTALL_MAX_MANIFEST_BYTES',
        type: 'number',
        label: 'Plugin Manifest Size Cap',
        description:
            'Maximum size (bytes) of a fetched external-plugin manifest before the install fetch aborts. Default: 65 536 (64 KiB).',
        defaultValue: 65536,
        section: 'advanced-tasks',
        validation: { min: 1024, max: 10485760 },
        uiHints: { suffix: 'bytes', advanced: true },
    },
    {
        key: 'PLUGIN_INSTALL_MAX_BUNDLE_BYTES',
        type: 'number',
        label: 'Plugin Bundle Size Cap',
        description:
            'Maximum size (bytes) of a fetched external-plugin bundle before the install fetch aborts. Default: 8 388 608 (8 MiB).',
        defaultValue: 8388608,
        section: 'advanced-tasks',
        validation: { min: 1024, max: 268435456 },
        uiHints: { suffix: 'bytes', advanced: true },
    },
    {
        key: 'PLUGIN_INSTALL_FETCH_TIMEOUT_MS',
        type: 'number',
        label: 'Plugin Install Fetch Timeout',
        description:
            'Per-request timeout (ms) for fetching an external-plugin manifest or bundle during install. Default: 15 000.',
        defaultValue: 15000,
        section: 'advanced-tasks',
        validation: { min: 1000, max: 120000 },
        uiHints: { suffix: 'ms', advanced: true },
    },
    // NOTE: the multi-file bundle caps (PLUGIN_INSTALL_MAX_EXTRACTED_BYTES /
    // _MAX_ENTRIES / _MAX_FILE_BYTES) are intentionally ENV-only resource knobs
    // read LIVE from process.env (see config.ts + ENV_ONLY_KEYS in the
    // config-schema-registered lint rule) — they are tuned per-deployment and
    // must honour a late env change, so they are deliberately NOT
    // ConfigService-snapshotted here.
];

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Get all settings for a specific section
 */
export function getSettingsBySection(sectionId: string): SettingDefinition[] {
    return configSchema.filter((s) => s.section === sectionId);
}

/**
 * Flags that control which settings are shown in the admin UI.
 * - `devFeaturesEnabled`: dev/preprod deployments expose `uiHints.devOnly` settings.
 * - `showAdvanced`: the "Show advanced settings" toggle reveals `uiHints.advanced` settings.
 */
export interface SettingVisibilityFlags {
    devFeaturesEnabled: boolean;
    showAdvanced: boolean;
}

/**
 * Whether a single setting is hidden from the admin UI under the given flags.
 * `uiHints.hidden` is always hidden; `devOnly`/`advanced` are conditional.
 */
export function isSettingHidden(
    setting: SettingDefinition,
    flags: SettingVisibilityFlags,
): boolean {
    if (setting.uiHints?.hidden) return true;
    if (setting.uiHints?.devOnly && !flags.devFeaturesEnabled) return true;
    if (setting.uiHints?.advanced && !flags.showAdvanced) return true;
    return false;
}

/**
 * Settings for a section that remain visible under the given flags. A setting is
 * also hidden when any of its `dependsOn`/`showWhen` ancestors is hidden, so child
 * settings never render orphaned after their parent is filtered out.
 */
export function getVisibleSettingsBySection(
    sectionId: string,
    flags: SettingVisibilityFlags,
): SettingDefinition[] {
    const settings = getSettingsBySection(sectionId);
    const byKey = new Map(settings.map((s) => [s.key, s]));
    const hiddenCache = new Map<string, boolean>();

    function isHidden(setting: SettingDefinition): boolean {
        const cached = hiddenCache.get(setting.key);
        if (cached !== undefined) return cached;
        // Mark in-progress as not-hidden to guard against cyclic dependsOn definitions.
        hiddenCache.set(setting.key, false);

        let hidden = isSettingHidden(setting, flags);
        if (!hidden) {
            const parentKey = setting.dependsOn ?? setting.showWhen?.key;
            const parent = parentKey ? byKey.get(parentKey) : undefined;
            if (parent) hidden = isHidden(parent);
        }

        hiddenCache.set(setting.key, hidden);
        return hidden;
    }

    return settings.filter((s) => !isHidden(s));
}

/**
 * Settings whose value references auth/user groups (`uiHints.groups`), across every
 * section. Powers the Access page's aggregate "Group-based rules" panel — an AUDIT
 * VIEW that answers "what do my groups control?" in one place, without relocating
 * the underlying settings (each one still lives, and saves, on its own feature
 * section — e.g. `LIVETV_HIGH_PRIORITY_GROUPS` stays conceptually part of Live TV;
 * see each `SettingDefinition.section`). Deliberately NOT filtered by
 * advanced/devOnly visibility flags: this panel is the audit view, so an
 * advanced-tagged group setting (e.g. `AGE_RATING_GROUP_PREFIX`) must still appear
 * here even when the caller's page-level "Show advanced" toggle is off elsewhere.
 */
export function getGroupReferencingSettings(): SettingDefinition[] {
    return configSchema.filter((s) => s.uiHints?.groups === true);
}

/**
 * Get a setting definition by key
 */
export function getSettingDefinition(key: string): SettingDefinition | undefined {
    return configSchema.find((s) => s.key === key);
}

/**
 * Get all root settings (no dependencies) for a section
 */
export function getRootSettings(sectionId: string): SettingDefinition[] {
    return configSchema.filter(
        (s) => s.section === sectionId && !s.dependsOn && !s.showWhen && !s.uiHints?.hidden,
    );
}

/**
 * Get child settings that depend on a parent key
 */
export function getChildSettings(parentKey: string): SettingDefinition[] {
    return configSchema.filter((s) => s.dependsOn === parentKey && !s.uiHints?.hidden);
}

/**
 * Group settings by parent for hierarchical rendering
 */
export function groupSettingsByParent(sectionId: string): {
    roots: SettingDefinition[];
    children: Map<string, SettingDefinition[]>;
} {
    const sectionSettings = getSettingsBySection(sectionId);
    const roots: SettingDefinition[] = [];
    const children = new Map<string, SettingDefinition[]>();

    for (const setting of sectionSettings) {
        // Skip hidden settings (they use custom editors)
        if (setting.uiHints?.hidden) {
            continue;
        }

        if (setting.dependsOn) {
            const existing = children.get(setting.dependsOn) || [];
            existing.push(setting);
            children.set(setting.dependsOn, existing);
        } else if (setting.showWhen?.key) {
            const parentKey = setting.showWhen.key;
            const existing = children.get(parentKey) || [];
            existing.push(setting);
            children.set(parentKey, existing);
        } else {
            roots.push(setting);
        }
    }

    return { roots, children };
}

/**
 * Check if a setting should be visible based on current values.
 * Note: Settings with `dependsOn` are always visible (but may be disabled).
 * Only `showWhen` controls actual visibility.
 */
export function isSettingVisible(
    setting: SettingDefinition,
    values: Record<string, unknown>,
): boolean {
    // Hidden settings are never shown in the UI (they use custom editors)
    if (setting.uiHints?.hidden) {
        return false;
    }

    // dependsOn settings are always visible (but may be greyed out when disabled)
    // Only showWhen controls actual visibility

    if (setting.showWhen) {
        const { key, equals, notEquals } = setting.showWhen;
        const currentValue = values[key];

        if (equals !== undefined) {
            return currentValue === equals;
        }
        if (notEquals !== undefined) {
            return currentValue !== notEquals;
        }
    }

    return true;
}

/**
 * Check if a setting should be enabled (interactive) based on current values.
 * Settings with `dependsOn` are disabled when their dependency is not met.
 */
export function isSettingEnabled(
    setting: SettingDefinition,
    values: Record<string, unknown>,
): boolean {
    if (setting.dependsOn) {
        return !!values[setting.dependsOn];
    }
    return true;
}

/**
 * Validate schema for common configuration errors.
 * Logs warnings for issues that would cause settings to not display correctly.
 */
export function validateSchema(): { warnings: string[] } {
    const warnings: string[] = [];

    // Build a map of key -> section for quick lookup
    const keyToSection = new Map<string, string>();
    for (const setting of configSchema) {
        keyToSection.set(setting.key, setting.section);
    }

    // Check for cross-section dependsOn (settings won't show in UI)
    for (const setting of configSchema) {
        if (setting.dependsOn) {
            const parentSection = keyToSection.get(setting.dependsOn);
            if (parentSection && parentSection !== setting.section) {
                warnings.push(
                    `[Schema Warning] "${setting.key}" has dependsOn="${setting.dependsOn}" but they are in different sections ` +
                        `("${setting.section}" vs "${parentSection}"). This setting will NOT appear in the admin UI. ` +
                        `Remove dependsOn or move the setting to the "${parentSection}" section.`,
                );
            }

            // Check if dependsOn target exists
            if (!keyToSection.has(setting.dependsOn)) {
                warnings.push(
                    `[Schema Warning] "${setting.key}" has dependsOn="${setting.dependsOn}" but that key does not exist in the schema.`,
                );
            }
        }

        // Check showWhen references
        if (setting.showWhen) {
            if (!keyToSection.has(setting.showWhen.key)) {
                warnings.push(
                    `[Schema Warning] "${setting.key}" has showWhen.key="${setting.showWhen.key}" but that key does not exist in the schema.`,
                );
            }
        }
    }

    return { warnings };
}

// Run schema validation on module load (development warning)
if (typeof process !== 'undefined' && process.env?.NODE_ENV !== 'production') {
    const { warnings } = validateSchema();
    for (const warning of warnings) {
        console.warn(warning);
    }
}

/**
 * Get default values for all settings.
 *
 * When a {@link DefaultResolutionContext} is supplied (server-side), settings
 * with a {@link SettingDefinition.dynamicDefault} resolve their default from it
 * (e.g. CPU-budget-aware task concurrency); otherwise the static
 * {@link SettingDefinition.defaultValue} is used. Pass the SAME context wherever
 * defaults are compared (seeding vs. "reset to default") so they stay consistent.
 */
export function getDefaultValues(ctx?: DefaultResolutionContext): Record<string, unknown> {
    const defaults: Record<string, unknown> = {};
    for (const setting of configSchema) {
        defaults[setting.key] =
            ctx && setting.dynamicDefault ? setting.dynamicDefault(ctx) : setting.defaultValue;
    }
    return defaults;
}

/** `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`. */
export const HEX_COLOR_PATTERN = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * Format rules for `color`, `url` and primary language values, applied when an admin SAVES a
 * changed value — deliberately not part of `validateSettingValue`, which also
 * runs at load time and DROPS a failing value back to its default. Tightening
 * that path would silently rewrite existing installs' config on the next boot
 * (e.g. a colour stored as `purple`); rejecting only new input cannot.
 *
 * A `url` may be empty, an absolute http(s) URL, or a root-relative path such
 * as `/custom/logo.webp` (the branding fields document that form).
 */
export function validateSettingFormat(
    setting: Pick<SettingDefinition, 'type' | 'validation'> & { key?: string },
    value: unknown,
): { valid: boolean; error?: string } {
    // Type/default handling belongs to validateSettingValue.
    if (typeof value !== 'string') return { valid: true };
    if (setting.validation?.languageTag && !normalizeLanguageTag(value)) {
        return { valid: false, error: m.setup_metadata_lang_error() };
    }
    if (value === '') return { valid: true };
    if (setting.key === 'PUBLIC_BASE_URL' && !normalizePublicBaseUrl(value)) {
        return { valid: false, error: m.public_base_url_invalid() };
    }
    if (setting.type === 'color' && !HEX_COLOR_PATTERN.test(value.trim())) {
        return { valid: false, error: 'Must be a hex colour such as #7c3aed' };
    }
    if (setting.type === 'url' && !/^(?:https?:\/\/\S+|\/\S*)$/i.test(value.trim())) {
        return {
            valid: false,
            error: 'Must be an http(s) URL or a path starting with / (e.g. /custom/logo.png)',
        };
    }
    return { valid: true };
}

/**
 * Validate a setting value against its definition
 */
export function validateSettingValue(
    setting: SettingDefinition,
    value: unknown,
): { valid: boolean; error?: string } {
    const { validation, type } = setting;

    if (value === undefined || value === null) {
        return { valid: true }; // Will use default
    }

    // Type checking
    if (type === 'boolean' && typeof value !== 'boolean') {
        return { valid: false, error: 'Must be a boolean' };
    }

    if (type === 'number' && typeof value !== 'number') {
        return { valid: false, error: 'Must be a number' };
    }

    // NaN/Infinity slip past the min/max comparisons below (every comparison
    // with NaN is false; Infinity passes any `min` and any key without `max`).
    if (type === 'number' && !Number.isFinite(value)) {
        return { valid: false, error: 'Must be a finite number' };
    }

    if ((type === 'string' || type === 'url' || type === 'path') && typeof value !== 'string') {
        return { valid: false, error: 'Must be a string' };
    }

    // Validation rules
    if (validation && type === 'number' && typeof value === 'number') {
        if (validation.integer && !Number.isInteger(value)) {
            return { valid: false, error: 'Must be a whole number' };
        }
        if (validation.min !== undefined && value < validation.min) {
            return {
                valid: false,
                error: `Must be at least ${validation.min}`,
            };
        }
        if (validation.max !== undefined && value > validation.max) {
            return { valid: false, error: `Must be at most ${validation.max}` };
        }
    }

    if (validation && typeof value === 'string') {
        if (validation.minLength !== undefined && value.length < validation.minLength) {
            return {
                valid: false,
                error: `Must be at least ${validation.minLength} characters`,
            };
        }
        if (validation.maxLength !== undefined && value.length > validation.maxLength) {
            return {
                valid: false,
                error: `Must be at most ${validation.maxLength} characters`,
            };
        }
        if (validation.pattern && !new RegExp(validation.pattern).test(value)) {
            return { valid: false, error: 'Invalid format' };
        }
    }

    // Navigation type must be an array of link objects. The root layout reads
    // `.icon`/`.href` off every entry on every request, so one null entry from a
    // hand-written save took down every page for every user.
    if (type === 'navigation') {
        if (!Array.isArray(value)) return { valid: false, error: 'Must be an array' };
        if (
            value.some((item) => typeof item !== 'object' || item === null || Array.isArray(item))
        ) {
            return { valid: false, error: 'Every navigation entry must be an object' };
        }
    }

    // Array type: the admin UI's ArrayInput submits a comma-separated STRING
    // (see `toList`), while programmatic callers may send a real string[] —
    // accept both shapes, then validate the coerced list.
    if (type === 'array') {
        if (typeof value !== 'string' && !Array.isArray(value)) {
            return { valid: false, error: 'Must be an array' };
        }
        const list = toList(value);
        if (validation?.corsOrigins && list.some((origin) => !isCorsOrigin(origin))) {
            return {
                valid: false,
                error: "Use exact HTTP(S) origins (no paths or credentials), or '*'",
            };
        }

        // maxItems is checked against `effectiveLength`, which for
        // `languageTags` settings is the NORMALIZED + DEDUPED count — the
        // same shape the runtime getter persists (e.g.
        // `config.METADATA_ADDITIONAL_LANGUAGES`, which also
        // normalizes+dedupes before slicing to 3) — not the raw
        // pre-normalize `list.length`. Without this, 'de,de,de,fr' (2 unique
        // languages after normalizing) is rejected by a `maxItems: 3` rule
        // purely because of casing/duplicate noise that would never actually
        // reach storage — a confusing false rejection. Generic
        // (non-languageTags) array settings have no normalization step, so
        // "unique after normalizing" isn't a meaningful concept for them —
        // they keep counting the raw list, preserving existing semantics.
        //
        // DELIBERATE non-alignment with the getter: primary-language
        // exclusion (`isPrimaryLanguageTag`) is NOT applied here, so
        // 'en, de, fr, ja' under TMDB_LANGUAGE='en-US' counts 4 and is
        // rejected even though the getter would store only 3 effective
        // entries. This module is client-shared and cannot import server
        // config; `validateSettingValue`'s generic signature is also invoked
        // from load-time file validation and per-key save loops where "the
        // primary in effect" is ambiguous (TMDB_LANGUAGE may be changing in
        // the same batch). The rejection is conservative and actionable
        // (drop the primary from the list); the save-hook diff in
        // config.service.ts and the runtime getter — the places where the
        // asymmetry had a real cost — DO share the exclusion.
        let effectiveLength = list.length;
        if (validation?.languageTags) {
            const invalid = list.filter((tag) => !normalizeLanguageTag(tag));
            if (invalid.length > 0) {
                return {
                    valid: false,
                    error: `Invalid language tag(s): ${invalid.join(', ')}`,
                };
            }
            effectiveLength = new Set(list.map((tag) => normalizeLanguageTag(tag))).size;
        }
        if (validation?.maxItems !== undefined && effectiveLength > validation.maxItems) {
            return {
                valid: false,
                error: `Must have at most ${validation.maxItems} item${validation.maxItems === 1 ? '' : 's'}`,
            };
        }
    }

    if (validation?.options && type === 'select') {
        const validValues = validation.options.map((o) => o.value);
        if (!validValues.includes(value as string | number)) {
            return {
                valid: false,
                error: `Must be one of: ${validValues.join(', ')}`,
            };
        }
    }

    return { valid: true };
}
