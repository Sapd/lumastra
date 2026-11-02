// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Holiday Plugin Configuration Loader
 *
 * Provides runtime-configurable holiday settings loaded from JSON.
 * Supports:
 * - External JSON configuration file (static/config/holidays.json)
 * - Environment variable for custom config path (HOLIDAY_CONFIG_PATH)
 * - Hot-reload in development mode
 * - Validation and defaults
 */

import { readFileSync, writeFileSync, existsSync, statSync } from 'fs';
import { resolve, join } from 'path';
import type {
    HolidayPluginConfig,
    HolidayConfig,
    HolidayPluginSettings,
    ContentSource,
} from './types';
import { Logger } from '$lib/server/utils/logger';

const logger = Logger.for('HolidayConfigLoader');

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_SETTINGS: HolidayPluginSettings = {
    enabled: true,
    defaultLimit: 20,
    enableAiPersonalization: true,
    cacheTtlMinutes: 30,
    jellyfinCacheTtlHours: 6,
};

/**
 * Built-in default holidays (used if no config file exists)
 * These match the original hardcoded holidays for backward compatibility
 */
const DEFAULT_HOLIDAYS: HolidayConfig[] = [
    {
        id: 'christmas',
        name: 'Christmas',
        localizedNames: { de: 'Weihnachten' },
        emoji: '🎄',
        startMonth: 11,
        startDay: 20,
        endMonth: 12,
        endDay: 27,
        sources: [
            {
                type: 'tmdb',
                keywordIds: [207317, 6152, 4270, 207335, 10683, 191469, 258261, 283373, 312042],
                keywords: ['christmas', 'santa claus', 'xmas'],
                genreIds: [10751, 35, 16],
                collectionIds: [9888, 743824, 1570, 108693, 53159, 642638, 201873, 526203],
                includeNewReleases: true,
                minVoteCount: 50,
                minVoteAverage: 5.5,
            },
        ],
        backgroundColor: '#165B33',
        textColor: '#FFFFFF',
        preHoliday: {
            name: 'Getting into Christmas spirit?',
            localizedNames: { de: 'Schon in Weihnachtsstimmung?' },
            emoji: '🕯️',
            startMonth: 11,
            startDay: 20,
            endMonth: 12,
            endDay: 22,
        },
        validation: {
            requiredTerms: [
                'christmas',
                'weihnacht',
                'xmas',
                'santa claus',
                'nikolaus',
                'weihnachtsmann',
                'advent',
                'noel',
                'navidad',
                'natale',
                'heiligabend',
                'rudolph',
                'reindeer',
                'rentier',
                'snowman',
                'schneemann',
                'grinch',
                'scrooge',
                'carol',
                'nutcracker',
                'nussknacker',
                'north pole',
                'nordpol',
                'mistletoe',
                'mistel',
                'christmas tree',
                'weihnachtsbaum',
                'christbaum',
                'home alone',
                'allein zu hause',
                'jingle',
                'krampus',
            ],
            skipForFeatured: true,
        },
        priority: 10,
    },
    {
        id: 'halloween',
        name: 'Halloween',
        localizedNames: { de: 'Halloween' },
        emoji: '🎃',
        startMonth: 10,
        startDay: 15,
        endMonth: 11,
        endDay: 3,
        sources: [
            {
                type: 'tmdb',
                keywordIds: [3335, 180193, 40931, 3358],
                keywords: ['halloween', 'horror', 'scary', 'ghost', 'monster', 'vampire', 'zombie'],
                genreIds: [27, 53],
                collectionIds: [91361, 8581, 1733, 751156, 945475, 11716, 185103, 8819],
                featuredMovieIds: [10439, 4011, 2907, 14836, 76492, 3933, 9297, 8839, 6435],
                includeNewReleases: true,
            },
        ],
        backgroundColor: '#FF6B35',
        textColor: '#000000',
        priority: 9,
    },
    {
        id: 'newyear',
        name: "New Year's",
        localizedNames: { de: 'Neujahr' },
        emoji: '🎆',
        startMonth: 12,
        startDay: 28,
        endMonth: 1,
        endDay: 7,
        sources: [
            {
                type: 'tmdb',
                keywordIds: [613, 252123],
                keywords: ['new year', 'celebration', 'party', 'new years eve', 'silvester'],
                genreIds: [35, 18],
                featuredMovieIds: [6166, 878, 62838, 639, 551, 634, 1621, 1581],
                featuredTvIds: [11578],
            },
        ],
        backgroundColor: '#4ECDC4',
        textColor: '#000000',
        priority: 8,
    },
    {
        id: 'valentines',
        name: "Valentine's Day",
        localizedNames: { de: 'Valentinstag' },
        emoji: '❤️',
        startMonth: 2,
        startDay: 1,
        endMonth: 2,
        endDay: 14,
        sources: [
            {
                type: 'tmdb',
                keywordIds: [160404, 212796, 9840, 818],
                keywords: ['valentine', 'romance', 'love', 'romantic'],
                genreIds: [10749, 35],
                featuredMovieIds: [11036, 114, 858, 313369, 509, 639],
            },
        ],
        backgroundColor: '#FF6B9D',
        textColor: '#FFFFFF',
        priority: 7,
    },
    {
        id: 'easter',
        name: 'Easter',
        localizedNames: { de: 'Ostern' },
        emoji: '🐰',
        startMonth: 3,
        startDay: 15,
        endMonth: 4,
        endDay: 25,
        sources: [
            {
                type: 'tmdb',
                keywordIds: [9923],
                keywords: ['easter', 'spring', 'bunny', 'egg'],
                genreIds: [10751, 16, 35],
                collectionIds: [595693],
                featuredMovieIds: [50359, 381719, 81188],
            },
        ],
        backgroundColor: '#FFE66D',
        textColor: '#000000',
        priority: 6,
    },
    {
        id: 'oktoberfest',
        name: 'Oktoberfest',
        localizedNames: { de: 'Oktoberfest' },
        emoji: '🍺',
        startMonth: 9,
        startDay: 16,
        endMonth: 9,
        endDay: 20,
        sources: [
            {
                type: 'tmdb',
                keywordIds: [8971, 2279, 4552],
                keywords: ['oktoberfest', 'beer', 'munich', 'bavaria', 'germany', 'festival'],
                genreIds: [35, 99, 10402],
            },
        ],
        backgroundColor: '#0099CC',
        textColor: '#FFFFFF',
        priority: 5,
    },
    {
        id: 'german-unity',
        name: 'German Unity Day',
        localizedNames: { de: 'Tag der Deutschen Einheit' },
        emoji: '🇩🇪',
        startMonth: 10,
        startDay: 1,
        endMonth: 10,
        endDay: 5,
        sources: [
            {
                type: 'tmdb',
                keywordIds: [156026, 74, 292, 2106, 6421, 220],
                keywords: ['germany', 'german', 'berlin', 'history', 'reunification', 'deutsche'],
                genreIds: [18, 99, 36],
                featuredMovieIds: [338, 582, 296098, 483983, 341013],
            },
        ],
        backgroundColor: '#DD0000',
        textColor: '#FFCC00',
        priority: 4,
    },
    {
        id: 'europe-day',
        name: 'Europe Day',
        localizedNames: { de: 'Europatag' },
        emoji: '🇪🇺',
        startMonth: 5,
        startDay: 5,
        endMonth: 5,
        endDay: 12,
        sources: [
            {
                type: 'tmdb',
                keywordIds: [181046, 3023, 230255, 6740],
                keywords: ['europe', 'european', 'union', 'eu', 'unity', 'peace', 'democracy'],
                genreIds: [99, 18, 36],
            },
        ],
        backgroundColor: '#003399',
        textColor: '#FFCC00',
        priority: 3,
    },
    {
        id: 'karneval',
        name: 'Carnival',
        localizedNames: { de: 'Karneval' },
        emoji: '🎭',
        startMonth: 2,
        startDay: 10,
        endMonth: 2,
        endDay: 14,
        sources: [
            {
                type: 'tmdb',
                keywordIds: [3473, 220511, 5497, 281505, 223368, 2404, 188404],
                keywords: ['carnival', 'karneval', 'party', 'costume', 'celebration', 'masquerade'],
                genreIds: [35, 10402, 10751],
                collectionIds: [229932],
                featuredMovieIds: [40423, 46195, 10198],
            },
        ],
        backgroundColor: '#9C27B0',
        textColor: '#FFFFFF',
        priority: 2,
    },
];

// ============================================================================
// Configuration State
// ============================================================================

let currentConfig: HolidayPluginConfig | null = null;
let configFilePath: string | null = null;
let lastModified: number = 0;

// Use globalThis to persist interval reference across HMR reloads
// This prevents memory leaks from orphaned intervals during development
const INTERVAL_KEY = '__holiday_config_check_interval__';
declare global {
    var __holiday_config_check_interval__: ReturnType<typeof setInterval> | null | undefined;
}
globalThis[INTERVAL_KEY] = globalThis[INTERVAL_KEY] ?? null;

function getCheckInterval(): ReturnType<typeof setInterval> | null {
    return globalThis[INTERVAL_KEY] ?? null;
}

function setCheckInterval(interval: ReturnType<typeof setInterval> | null): void {
    globalThis[INTERVAL_KEY] = interval;
}

// ============================================================================
// Configuration Loading
// ============================================================================

/**
 * Determine the configuration file path
 * Priority: 1. Environment variable 2. static/config/ 3. Built-in defaults
 */
function getConfigPath(): string | null {
    // Check environment variable first (highest priority for production overrides)
    const envPath = process.env.HOLIDAY_CONFIG_PATH;
    if (envPath) {
        const resolved = resolve(envPath);
        if (existsSync(resolved)) {
            logger.debug('Using config from environment variable', {
                path: resolved,
            });
            return resolved;
        }
        logger.warn('Config path from environment not found', {
            path: resolved,
        });
    }

    // Get working directory - handle both dev and production
    const cwd = process.cwd();

    // Check standard locations
    const possiblePaths = [
        // Production: Docker volume mount (preferred)
        '/config/holidays.json',
        // Development: static/ directory
        join(cwd, 'static', 'config', 'holidays.json'),
        // Legacy: root config directory
        join(cwd, 'config', 'holidays.json'),
        // Legacy: SvelteKit build output
        join(cwd, 'build', 'client', 'config', 'holidays.json'),
    ];

    for (const path of possiblePaths) {
        if (existsSync(path)) {
            logger.debug('Found config file', { path });
            return path;
        }
    }

    logger.debug('No config file found, using built-in defaults');
    return null;
}

/**
 * Parse localized names from config
 * Returns undefined if no valid entries exist
 */
function parseLocalizedNames(raw: unknown): Record<string, string> | undefined {
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }

    const record = raw as Record<string, unknown>;
    const result: Record<string, string> = {};

    for (const [key, value] of Object.entries(record)) {
        if (typeof value === 'string' && value.trim()) {
            result[key] = value;
        }
    }

    return Object.keys(result).length > 0 ? result : undefined;
}

/**
 * Validate a content source configuration
 */
function validateContentSource(source: unknown, index: number): ContentSource | null {
    if (!source || typeof source !== 'object') {
        logger.warn('Invalid content source', { index, source });
        return null;
    }

    const s = source as Record<string, unknown>;
    const type = s.type;

    if (type === 'tmdb') {
        return {
            type: 'tmdb',
            keywordIds: Array.isArray(s.keywordIds)
                ? s.keywordIds.filter((id) => typeof id === 'number')
                : undefined,
            keywords: Array.isArray(s.keywords)
                ? s.keywords.filter((k) => typeof k === 'string')
                : undefined,
            collectionIds: Array.isArray(s.collectionIds)
                ? s.collectionIds.filter((id) => typeof id === 'number')
                : undefined,
            genreIds: Array.isArray(s.genreIds)
                ? s.genreIds.filter((id) => typeof id === 'number')
                : undefined,
            featuredMovieIds: Array.isArray(s.featuredMovieIds)
                ? s.featuredMovieIds.filter((id) => typeof id === 'number')
                : undefined,
            featuredTvIds: Array.isArray(s.featuredTvIds)
                ? s.featuredTvIds.filter((id) => typeof id === 'number')
                : undefined,
            includeNewReleases:
                typeof s.includeNewReleases === 'boolean' ? s.includeNewReleases : undefined,
            minVoteCount: typeof s.minVoteCount === 'number' ? s.minVoteCount : undefined,
            minVoteAverage: typeof s.minVoteAverage === 'number' ? s.minVoteAverage : undefined,
        };
    }

    if (type === 'mdblist') {
        if (typeof s.listPath !== 'string' || !s.listPath) {
            logger.warn('MDBList source missing listPath', { index });
            return null;
        }
        return {
            type: 'mdblist',
            listPath: s.listPath,
            limit: typeof s.limit === 'number' ? s.limit : undefined,
            boostFactor: typeof s.boostFactor === 'number' ? s.boostFactor : undefined,
        };
    }

    if (type === 'custom') {
        return {
            type: 'custom',
            movieIds: Array.isArray(s.movieIds)
                ? s.movieIds.filter((id) => typeof id === 'number')
                : undefined,
            tvIds: Array.isArray(s.tvIds)
                ? s.tvIds.filter((id) => typeof id === 'number')
                : undefined,
            boostFactor: typeof s.boostFactor === 'number' ? s.boostFactor : undefined,
        };
    }

    logger.warn('Unknown content source type', { index, type });
    return null;
}

/**
 * Validate and normalize a holiday configuration
 */
function validateHoliday(holiday: unknown): HolidayConfig | null {
    if (!holiday || typeof holiday !== 'object') {
        return null;
    }

    const h = holiday as Record<string, unknown>;

    // Required fields
    if (typeof h.id !== 'string' || !h.id) {
        logger.warn('Holiday missing id');
        return null;
    }
    if (typeof h.name !== 'string' || !h.name) {
        logger.warn('Holiday missing name', { id: h.id });
        return null;
    }
    if (
        typeof h.startMonth !== 'number' ||
        typeof h.startDay !== 'number' ||
        typeof h.endMonth !== 'number' ||
        typeof h.endDay !== 'number'
    ) {
        logger.warn('Holiday missing date range', { id: h.id });
        return null;
    }

    // Validate date ranges
    if (h.startMonth < 1 || h.startMonth > 12 || h.endMonth < 1 || h.endMonth > 12) {
        logger.warn('Holiday has invalid month', {
            id: h.id,
            startMonth: h.startMonth,
            endMonth: h.endMonth,
        });
        return null;
    }
    if (
        ![h.startMonth, h.startDay, h.endMonth, h.endDay].every(Number.isInteger) ||
        h.startDay < 1 ||
        h.startDay > DAYS_IN_MONTH[h.startMonth - 1] ||
        h.endDay < 1 ||
        h.endDay > DAYS_IN_MONTH[h.endMonth - 1]
    ) {
        logger.warn('Holiday has invalid day', {
            id: h.id,
            startDay: h.startDay,
            endDay: h.endDay,
        });
        return null;
    }

    // Validate sources
    const sources: ContentSource[] = [];
    let skippedSources = 0;
    if (Array.isArray(h.sources)) {
        h.sources.forEach((source, index) => {
            const validated = validateContentSource(source, index);
            if (validated) {
                sources.push(validated);
            } else {
                skippedSources++;
            }
        });
    }
    if (skippedSources > 0) {
        logger.warn('Holiday has invalid sources that were skipped', {
            id: h.id,
            skipped: skippedSources,
            valid: sources.length,
        });
    }

    if (sources.length === 0) {
        logger.warn('Holiday has no valid sources', { id: h.id });
        return null;
    }

    return {
        id: h.id,
        name: h.name,
        localizedNames: parseLocalizedNames(h.localizedNames),
        emoji: typeof h.emoji === 'string' ? h.emoji : '📅',
        startMonth: h.startMonth,
        startDay: h.startDay,
        endMonth: h.endMonth,
        endDay: h.endDay,
        sources,
        backgroundColor: typeof h.backgroundColor === 'string' ? h.backgroundColor : '#333333',
        textColor: typeof h.textColor === 'string' ? h.textColor : '#FFFFFF',
        backgroundImage: typeof h.backgroundImage === 'string' ? h.backgroundImage : undefined,
        preHoliday: (() => {
            if (!h.preHoliday || typeof h.preHoliday !== 'object') return undefined;
            const pre = h.preHoliday as Record<string, unknown>;

            // Validate required date fields
            const startMonth = Number(pre.startMonth);
            const startDay = Number(pre.startDay);
            const endMonth = Number(pre.endMonth);
            const endDay = Number(pre.endDay);

            // Check for NaN or invalid ranges
            if (
                !Number.isFinite(startMonth) ||
                startMonth < 1 ||
                startMonth > 12 ||
                !Number.isFinite(startDay) ||
                startDay < 1 ||
                startDay > 31 ||
                !Number.isFinite(endMonth) ||
                endMonth < 1 ||
                endMonth > 12 ||
                !Number.isFinite(endDay) ||
                endDay < 1 ||
                endDay > 31
            ) {
                logger.warn('Holiday preHoliday has invalid date fields, skipping', { id: h.id });
                return undefined;
            }

            // Validate name exists
            const name = String(pre.name || '');
            if (!name) {
                logger.warn('Holiday preHoliday missing name, skipping', {
                    id: h.id,
                });
                return undefined;
            }

            // Use pre.emoji if valid, else fall back to h.emoji if string, else default emoji
            const preEmoji =
                typeof pre.emoji === 'string' && pre.emoji
                    ? pre.emoji
                    : typeof h.emoji === 'string' && h.emoji
                      ? h.emoji
                      : '📅';

            return {
                name,
                localizedNames: parseLocalizedNames(pre.localizedNames),
                emoji: preEmoji,
                startMonth,
                startDay,
                endMonth,
                endDay,
            };
        })(),
        validation: (() => {
            if (!h.validation || typeof h.validation !== 'object') {
                return undefined;
            }
            const record = h.validation as Record<string, unknown>;
            const requiredTerms = Array.isArray(record.requiredTerms)
                ? record.requiredTerms.filter((t): t is string => typeof t === 'string')
                : undefined;
            const excludeTerms = Array.isArray(record.excludeTerms)
                ? record.excludeTerms.filter((t): t is string => typeof t === 'string')
                : undefined;
            const skipForFeatured =
                typeof record.skipForFeatured === 'boolean' ? record.skipForFeatured : true;
            return {
                requiredTerms,
                excludeTerms,
                skipForFeatured,
            };
        })(),
        enabled: typeof h.enabled === 'boolean' ? h.enabled : true,
        priority: typeof h.priority === 'number' ? h.priority : 0,
    };
}

/** Max day per month (February allows 29 so leap-day ranges stay valid). */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

/** A finite number within [min, max], else the fallback. */
function numberInRange(value: unknown, min: number, max: number, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
        ? value
        : fallback;
}

/**
 * Load and parse configuration from file
 */
function loadConfigFromFile(filePath: string): HolidayPluginConfig | null {
    try {
        if (!existsSync(filePath)) {
            logger.debug('Config file not found', { filePath });
            return null;
        }

        // Record the mtime BEFORE parsing: a file that fails to parse would
        // otherwise look "changed" to the dev poller every 10 s forever.
        try {
            lastModified = statSync(filePath).mtimeMs;
        } catch {
            // Ignore stat errors
        }

        const content = readFileSync(filePath, 'utf-8');
        const parsed = JSON.parse(content) as Record<string, unknown>;

        // Validate settings (ranges match the admin settings UI)
        const raw =
            parsed.settings && typeof parsed.settings === 'object'
                ? (parsed.settings as Record<string, unknown>)
                : {};
        const settings: HolidayPluginSettings = {
            enabled: typeof raw.enabled === 'boolean' ? raw.enabled : DEFAULT_SETTINGS.enabled,
            defaultLimit: Math.trunc(
                numberInRange(raw.defaultLimit, 1, 100, DEFAULT_SETTINGS.defaultLimit),
            ),
            enableAiPersonalization:
                typeof raw.enableAiPersonalization === 'boolean'
                    ? raw.enableAiPersonalization
                    : DEFAULT_SETTINGS.enableAiPersonalization,
            cacheTtlMinutes: numberInRange(
                raw.cacheTtlMinutes,
                1,
                1440,
                DEFAULT_SETTINGS.cacheTtlMinutes,
            ),
            jellyfinCacheTtlHours: numberInRange(
                raw.jellyfinCacheTtlHours,
                1,
                168,
                DEFAULT_SETTINGS.jellyfinCacheTtlHours,
            ),
        };

        // Validate holidays
        const holidays: HolidayConfig[] = [];
        if (Array.isArray(parsed.holidays)) {
            for (const holiday of parsed.holidays) {
                const validated = validateHoliday(holiday);
                if (validated) {
                    holidays.push(validated);
                }
            }
        }

        logger.info('Loaded holiday config from file', {
            filePath,
            holidayCount: holidays.length,
            enabled: settings.enabled,
        });

        return { settings, holidays };
    } catch (error) {
        logger.error('Failed to load config file', error as Error, {
            filePath,
        });
        return null;
    }
}

/**
 * Get the default configuration (built-in holidays)
 */
function getDefaultConfig(): HolidayPluginConfig {
    return {
        settings: DEFAULT_SETTINGS,
        holidays: DEFAULT_HOLIDAYS,
    };
}

/**
 * Check if config file has changed (for polling-based reload)
 */
function checkForConfigChanges(): void {
    if (!configFilePath) return;

    try {
        const stats = statSync(configFilePath);
        if (stats.mtimeMs > lastModified) {
            logger.info('Config file changed, reloading', {
                path: configFilePath,
            });
            const newConfig = loadConfigFromFile(configFilePath);
            if (newConfig && newConfig.holidays.length > 0) {
                currentConfig = newConfig;
            }
        }
    } catch {
        // File may have been deleted, ignore
    }
}

// ============================================================================
// Public API
// ============================================================================

/**
 * Initialize the configuration loader
 * Should be called once at application startup
 */
export function initHolidayConfig(): void {
    configFilePath = getConfigPath();

    if (configFilePath) {
        const fileConfig = loadConfigFromFile(configFilePath);
        if (fileConfig && fileConfig.holidays.length > 0) {
            currentConfig = fileConfig;
        } else {
            currentConfig = getDefaultConfig();
        }
    } else {
        currentConfig = getDefaultConfig();
    }

    // Set up polling for config changes (development only)
    // In production, use the reload endpoint or restart the server
    // Explicitly check for 'development' to avoid accidentally enabling in production
    const isDev = process.env.NODE_ENV === 'development';
    if (isDev && configFilePath) {
        // Clear any existing interval to prevent HMR memory leaks
        const existingInterval = getCheckInterval();
        if (existingInterval) {
            clearInterval(existingInterval);
        }
        setCheckInterval(setInterval(checkForConfigChanges, 10000)); // Check every 10 seconds
        logger.debug('Config file polling enabled (development mode)');
    }
}

/**
 * Reload configuration from file
 * Can be called manually to force a reload (e.g., from an admin API)
 */
export function reloadConfig(): boolean {
    const path = configFilePath || getConfigPath();
    if (path) {
        const newConfig = loadConfigFromFile(path);
        if (newConfig && newConfig.holidays.length > 0) {
            currentConfig = newConfig;
            configFilePath = path;
            logger.info('Configuration reloaded successfully');
            return true;
        }
    }
    logger.warn('Failed to reload configuration, keeping current');
    return false;
}

/**
 * Get the current configuration
 * Initializes with defaults if not already loaded
 */
export function getHolidayConfig(): HolidayPluginConfig {
    if (!currentConfig) {
        initHolidayConfig();
    }
    return currentConfig || getDefaultConfig();
}

/**
 * Get plugin settings
 */
export function getHolidaySettings(): HolidayPluginSettings {
    return getHolidayConfig().settings;
}

/**
 * Get all configured holidays
 */
export function getHolidays(): HolidayConfig[] {
    return getHolidayConfig().holidays.filter((h) => h.enabled !== false);
}

/**
 * Get a specific holiday by ID
 */
export function getHolidayById(id: string): HolidayConfig | null {
    return getHolidays().find((h) => h.id === id) || null;
}

/**
 * Clean up resources (call on shutdown)
 */
export function cleanupHolidayConfig(): void {
    const interval = getCheckInterval();
    if (interval) {
        clearInterval(interval);
        setCheckInterval(null);
    }
    currentConfig = null;
}

/**
 * Get the path where config is loaded from (for debugging/admin)
 */
export function getConfigFilePath(): string | null {
    return configFilePath;
}

/**
 * Save holiday configuration to file
 * Creates the config file if it doesn't exist
 *
 * @param config - The complete holiday configuration to save
 * @returns true if save was successful
 */
export function saveHolidayConfig(config: HolidayPluginConfig): boolean {
    // Determine config path - use current or default
    let savePath = configFilePath;
    if (!savePath) {
        const cwd = process.cwd();
        savePath = join(cwd, 'static', 'config', 'holidays.json');
    }

    try {
        // Add schema reference for IDE support
        const configWithSchema = {
            $schema: './holidays.schema.json',
            settings: config.settings,
            holidays: config.holidays,
        };

        writeFileSync(savePath, JSON.stringify(configWithSchema, null, 4), 'utf-8');

        // Update cached config
        currentConfig = config;
        configFilePath = savePath;

        // Update last modified time
        try {
            lastModified = statSync(savePath).mtimeMs;
        } catch {
            // Ignore stat errors
        }

        logger.info('Holiday config saved', {
            path: savePath,
            holidayCount: config.holidays.length,
        });
        return true;
    } catch (error) {
        logger.error('Failed to save holiday config', error as Error, {
            path: savePath,
        });
        return false;
    }
}

/**
 * Export default holidays for reference/documentation
 */
export { DEFAULT_HOLIDAYS, DEFAULT_SETTINGS };
