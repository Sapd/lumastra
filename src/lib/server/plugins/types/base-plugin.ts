// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Base Plugin Types
 *
 * Foundational interfaces for the unified plugin system.
 * All plugin types extend these base interfaces.
 */

import type postgres from 'postgres';
import type { LoggerInstance } from '../../utils/logger.js';
import type {
    MediaProbeResult,
    ChapterProbeResult,
    StreamsProbeResult,
    FormatProbeResult,
} from '../../utils/ffprobe.js';
import type {
    BlackFrame,
    ExtractFrameOptions,
    ExtractFrameResult,
    DetectSilenceOptions,
    SilenceRange,
} from '../../utils/ffmpeg-analysis.js';

// =============================================================================
// Plugin Manifest
// =============================================================================

/**
 * Valid capability keys as a const array.
 * Used for runtime validation.
 * The PluginCapabilities interface uses these keys.
 */
export const PLUGIN_CAPABILITY_KEYS = [
    'database',
    'cache',
    'http',
    'scheduler',
    'api',
    'ui',
    'ffmpeg',
] as const;

/**
 * Capability key type derived from the const array.
 */
export type PluginCapabilityKey = (typeof PLUGIN_CAPABILITY_KEYS)[number];

/**
 * Capabilities that a plugin can request.
 * Used for permission checking and dependency injection.
 */
export interface PluginCapabilities {
    /** Needs SQL database access */
    database?: boolean;
    /** Needs Valkey/Redis cache access */
    cache?: boolean;
    /** Needs external HTTP calls */
    http?: boolean;
    /** Needs scheduled execution (sync plugins) */
    scheduler?: boolean;
    /** Registers API routes */
    api?: boolean;
    /** Provides UI components (future) */
    ui?: boolean;
    /** Needs FFmpeg/FFprobe for media analysis (fingerprinting, black frame detection, probing) */
    ffmpeg?: boolean;
}

/**
 * Plugin manifest - metadata and configuration schema.
 * External plugins provide this as manifest.json.
 * Built-in plugins define this in code.
 */
export interface PluginManifest {
    // Identity
    /** Unique plugin ID (e.g., "tvdb-metadata", "holiday-recommendations") */
    id: string;
    /** Human-readable name */
    name: string;
    /** Semver version (e.g., "1.0.0") */
    version: string;
    /** Description of what this plugin does */
    description: string;
    /** Plugin author */
    author?: string;

    // Classification
    /** Plugin type determines behavior and available hooks */
    type: PluginType;

    // Compatibility
    /** Minimum dashboard version required */
    minAppVersion?: string;
    /** Maximum dashboard version supported */
    maxAppVersion?: string;

    // Dependencies
    /** Other plugin IDs that must be loaded first */
    dependencies?: string[];

    // Capabilities
    /** Capabilities this plugin requires */
    capabilities: PluginCapabilities;

    // Entry point (for external plugins)
    /** Relative path to main module (e.g., "index.js") */
    main?: string;

    // Configuration
    /** JSON Schema for plugin configuration validation */
    configSchema?: Record<string, unknown>;

    // Settings UI
    /** Settings configuration for admin UI */
    settingsConfig?: PluginSettingsConfig;
}

// =============================================================================
// Plugin Types
// =============================================================================

/**
 * Supported plugin types as a const array.
 * Used for runtime validation and iteration.
 * The PluginType union is derived from this to keep them in sync.
 */
export const PLUGIN_TYPES = [
    'sync',
    'feature',
    'provider',
    'integration',
    'media-source',
    'metadata-provider',
    'trickplay-provider',
    'watch-sync',
] as const;

/**
 * Supported plugin types.
 * Each type has different lifecycle hooks and execution patterns.
 * Derived from PLUGIN_TYPES to ensure type and runtime values stay in sync.
 */
export type PluginType = (typeof PLUGIN_TYPES)[number];

// =============================================================================
// Plugin Context
// =============================================================================

/**
 * Namespaced cache interface for plugins.
 * All keys are automatically prefixed with the plugin ID.
 */
export interface NamespacedCache {
    /** Get a value from cache */
    get<T>(key: string): Promise<T | null>;
    /** Set a value in cache with optional TTL */
    set<T>(key: string, value: T, ttlMs?: number): Promise<void>;
    /** Delete a value from cache */
    delete(key: string): Promise<boolean>;
    /** Check if a key exists */
    has(key: string): Promise<boolean>;
    /** Delete all keys for this plugin */
    clear(): Promise<void>;
}

/**
 * Rate-limited HTTP client for plugins.
 * Includes automatic rate limiting and timeout handling.
 */
export interface PluginHttpClient {
    /** Make a GET request */
    get<T>(url: string, options?: PluginHttpOptions): Promise<T>;
    /** Make a POST request */
    post<T>(url: string, body: unknown, options?: PluginHttpOptions): Promise<T>;
    /** Make a PUT request */
    put<T>(url: string, body: unknown, options?: PluginHttpOptions): Promise<T>;
    /** Make a DELETE request */
    delete<T>(url: string, options?: PluginHttpOptions): Promise<T>;
}

export interface PluginHttpOptions {
    /** Request headers */
    headers?: Record<string, string>;
    /** Request timeout in milliseconds */
    timeout?: number;
    /** Whether to throw on non-2xx responses (default: true) */
    throwOnError?: boolean;
}

// =============================================================================
// FFmpeg Client
// =============================================================================

/**
 * Media analysis client for plugins.
 * Provides safe, controlled access to FFmpeg/FFprobe operations.
 * Only available when capabilities.ffmpeg is true.
 */
export interface PluginFFmpegClient {
    /**
     * Probe a media file for streams, duration, and container info.
     * Wraps FFprobe with full stream/format parsing.
     */
    probe(filePath: string): Promise<MediaProbeResult>;

    /**
     * Probe a media file for chapter metadata (title, start/end times).
     * Useful for chapter-based intro/credits detection.
     */
    probeChapters(filePath: string): Promise<ChapterProbeResult>;

    /**
     * Extract a Chromaprint audio fingerprint.
     * Requires FFmpeg built with chromaprint support.
     * Each point represents ~0.1238 seconds of audio.
     * @returns Uint32Array of raw fingerprint points
     */
    fingerprint(filePath: string, startSec: number, endSec: number): Promise<Uint32Array>;

    /**
     * Detect black frames in a time range.
     * Returns frames sorted by timestamp.
     */
    detectBlackFrames(
        filePath: string,
        startSec: number,
        endSec: number,
        options?: { minimumBlackPct?: number; threshold?: number },
    ): Promise<BlackFrame[]>;

    /**
     * Probe all streams in a media file.
     * Returns categorized video, audio, and subtitle stream arrays
     * with detailed codec, resolution, fps, language, and channel info.
     * @throws on ffprobe failure (unlike probe() which returns { success: false })
     */
    probeStreams(filePath: string): Promise<StreamsProbeResult>;

    /**
     * Probe container-level format info.
     * Returns format name, file size, bitrate, duration, and metadata tags
     * (title, encoder, creation_time, etc.).
     * @throws on ffprobe failure (unlike probe() which returns { success: false })
     */
    probeFormat(filePath: string): Promise<FormatProbeResult>;

    /**
     * Extract a single video frame as a JPEG or PNG buffer.
     * Optionally scales the output to the given dimensions.
     */
    extractFrame(
        filePath: string,
        timeSec: number,
        options?: ExtractFrameOptions,
    ): Promise<ExtractFrameResult>;

    /**
     * Detect silent audio sections in a time range.
     * Returns silence ranges sorted by start time.
     * Useful for finding ad breaks, scene transitions, or credits boundaries.
     */
    detectSilence(
        filePath: string,
        startSec: number,
        endSec: number,
        options?: DetectSilenceOptions,
    ): Promise<SilenceRange[]>;
}

/**
 * Context provided to plugins during execution.
 * Contains all dependencies and utilities needed by the plugin.
 */
export interface PluginContext {
    // Core dependencies
    /** Database connection (if database capability requested) */
    sql: postgres.Sql;
    /** Namespaced cache (all keys prefixed with plugin:${id}:) */
    cache: NamespacedCache;
    /** Scoped logger instance */
    logger: LoggerInstance;
    /** Rate-limited HTTP client (if http capability requested) */
    http: PluginHttpClient;
    /** FFmpeg/FFprobe media analysis client (if ffmpeg capability requested) */
    ffmpeg: PluginFFmpegClient;

    // Plugin metadata
    /** The plugin's manifest */
    manifest: PluginManifest;
    /** User-provided configuration (validated against configSchema) */
    config: Record<string, unknown>;
    /** Plugin-specific data directory (for file storage) */
    dataDir: string;

    // Lifecycle
    /** Abort signal for graceful shutdown */
    abortSignal: AbortSignal;

    // Inter-plugin communication
    /** Get another loaded plugin by ID */
    getPlugin<T extends BasePlugin = BasePlugin>(id: string): T | undefined;
    /** Emit an event for other plugins to consume */
    emit(event: string, data: unknown): void;
    /** Subscribe to events from other plugins */
    on(event: string, handler: (data: unknown) => void): () => void;
}

// =============================================================================
// Plugin Lifecycle
// =============================================================================

/**
 * Plugin lifecycle hooks.
 * All hooks are optional - plugins implement only what they need.
 */
export interface PluginLifecycle {
    /**
     * Called once when the plugin is first loaded.
     * Use for one-time initialization, validation, etc.
     */
    initialize?(context: PluginContext): Promise<void>;

    /**
     * Called when the plugin is being unloaded or the app is shutting down.
     * Use for cleanup, closing connections, etc.
     */
    shutdown?(context: PluginContext): Promise<void>;

    /**
     * Called when plugin configuration changes.
     * Use to apply new configuration without full restart.
     */
    onConfigChange?(newConfig: Record<string, unknown>, context: PluginContext): Promise<void>;
}

// =============================================================================
// Base Plugin Interface
// =============================================================================

/**
 * Base plugin interface that all plugin types extend.
 */
export interface BasePlugin extends PluginLifecycle {
    /** Plugin manifest containing metadata and capabilities */
    manifest: PluginManifest;

    /**
     * Check if this plugin is enabled.
     * May check environment variables, feature flags, or config.
     */
    isEnabled(): boolean;

    /**
     * Get current settings values for the admin UI.
     * Returns a flat key-value object matching the settingsConfig fields.
     */
    getSettings?(): Promise<Record<string, unknown>>;

    /**
     * Update settings from the admin UI.
     * Receives a flat key-value object with updated values.
     */
    updateSettings?(settings: Record<string, unknown>): Promise<void>;
}

// =============================================================================
// Plugin Source (for registry tracking)
// =============================================================================

/**
 * Where the plugin was loaded from.
 */
export type PluginSource = 'builtin' | 'external';

/**
 * Plugin registration entry (used by registry).
 */
export interface PluginRegistration<T extends BasePlugin = BasePlugin> {
    /** The plugin instance */
    plugin: T;
    /** Where the plugin was loaded from */
    source: PluginSource;
    /** When the plugin was registered */
    registeredAt: Date;
    /** Current status */
    status: PluginStatus;
    /** Last error if status is 'error' */
    lastError?: Error;
}

/**
 * Plugin runtime status.
 */
export type PluginStatus =
    | 'registered' // Just registered, not yet initialized
    | 'initializing' // Initialize() is running
    | 'active' // Successfully initialized and ready
    | 'disabled' // Disabled by user or config
    | 'error' // Failed to initialize or encountered error
    | 'shutdown'; // Shutdown() completed

// =============================================================================
// Plugin Settings
// =============================================================================

/**
 * Settings field definition for generic settings UI
 */
export interface PluginSettingField {
    /** Unique key for this setting */
    key: string;
    /** Field type */
    type: 'boolean' | 'string' | 'number' | 'select';
    /** Human-readable label */
    label: string;
    /** Optional description */
    description?: string;
    /** Default value */
    default?: unknown;
    /** Options for select type */
    options?: Array<{ value: string; label: string }>;
    /** Validation constraints */
    validation?: {
        min?: number;
        max?: number;
        pattern?: string;
    };
    /** Only shown while this boolean field is on (SDK `SettingField.dependsOn`). */
    dependsOn?: string;
    /** Array of user group names — rendered as a group picker. */
    groups?: boolean;
}

/**
 * Settings configuration for plugins
 * Plugins with this config will show a settings button in the admin UI
 */
export interface PluginSettingsConfig {
    /** Settings fields to render (if no custom component) */
    fields?: PluginSettingField[];
    /** Name of custom Svelte settings component (registered in modal) */
    customComponent?: string;
}
