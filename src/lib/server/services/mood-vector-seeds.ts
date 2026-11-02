// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Mood Vector Seed Data
 *
 * Loads mood configurations from static/config/mood-vectors.json
 * Seeds define the direction for each mood by averaging their embeddings.
 *
 * Configuration file supports:
 * - Adding/removing moods
 * - Customizing seeds for your library
 * - Enabling/disabling specific moods
 * - JSON schema validation for editor support
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { Logger } from '$lib/server/utils/logger';
import { isMovie, isSeries } from '$lib/server/utils/media-types';
import * as m from '$lib/paraglide/messages';

const logger = Logger.for('MoodVectorSeeds');

export interface MoodSeed {
    tmdbId: number;
    mediaType: 'movie' | 'tv';
    title?: string; // For documentation/debugging only
}

export interface MoodSeedConfig {
    moodKey: string;
    displayName: string;
    displayNameDE?: string;
    description: string;
    descriptionDE?: string;
    seeds: MoodSeed[];
    enabled?: boolean;
}

export interface MoodVectorSettings {
    enabled: boolean;
    minSeedsRequired: number;
    defaultLimit: number;
    cacheTtlMinutes: number;
}

interface MoodVectorConfigFile {
    settings: MoodVectorSettings;
    moods: Array<{
        key: string;
        displayName: string;
        displayNameDE?: string;
        description: string;
        descriptionDE?: string;
        seeds: MoodSeed[];
        enabled?: boolean;
    }>;
}

// Default settings if config file is missing
const DEFAULT_SETTINGS: MoodVectorSettings = {
    enabled: true,
    minSeedsRequired: 3,
    defaultLimit: 20,
    cacheTtlMinutes: 1440,
};

// Cache for loaded config
let cachedConfig: MoodVectorConfigFile | null = null;
let cachedMoodMap: Record<string, MoodSeedConfig> | null = null;

/**
 * Validate a seed entry has valid tmdbId and mediaType
 */
function validateSeed(seed: unknown): seed is MoodSeed {
    if (!seed || typeof seed !== 'object') return false;
    const s = seed as Record<string, unknown>;
    return (
        typeof s.tmdbId === 'number' &&
        Number.isInteger(s.tmdbId) &&
        s.tmdbId > 0 &&
        (isMovie(s.mediaType as string) || isSeries(s.mediaType as string))
    );
}

/**
 * Validate a mood entry has all required fields
 */
function validateMood(mood: unknown): mood is MoodVectorConfigFile['moods'][number] {
    if (!mood || typeof mood !== 'object') return false;
    const m = mood as Record<string, unknown>;

    // Check required string fields
    if (
        typeof m.key !== 'string' ||
        m.key.length === 0 ||
        typeof m.displayName !== 'string' ||
        typeof m.description !== 'string'
    ) {
        return false;
    }

    // Check seeds array and validate each seed
    if (!Array.isArray(m.seeds) || m.seeds.length === 0) {
        return false;
    }

    // Filter out invalid seeds and check we still have enough
    const validSeeds = m.seeds.filter(validateSeed);
    if (validSeeds.length === 0) {
        logger.warn('Mood has no valid seeds', { key: m.key });
        return false;
    }

    // Replace seeds array with validated seeds only
    m.seeds = validSeeds;
    return true;
}

/**
 * Validate settings values are correct types
 */
function validateSettings(settings: unknown): settings is Partial<MoodVectorSettings> {
    if (!settings || typeof settings !== 'object') return true; // Empty is fine, uses defaults
    const s = settings as Record<string, unknown>;

    // Validate each setting if present
    if (s.enabled !== undefined && typeof s.enabled !== 'boolean') {
        logger.warn('Invalid settings.enabled, using default', {
            value: s.enabled,
        });
        delete s.enabled;
    }
    if (
        s.minSeedsRequired !== undefined &&
        (typeof s.minSeedsRequired !== 'number' ||
            s.minSeedsRequired < 1 ||
            s.minSeedsRequired > 20)
    ) {
        logger.warn('Invalid settings.minSeedsRequired, using default', {
            value: s.minSeedsRequired,
        });
        delete s.minSeedsRequired;
    }
    if (
        s.defaultLimit !== undefined &&
        (typeof s.defaultLimit !== 'number' || s.defaultLimit < 1 || s.defaultLimit > 100)
    ) {
        logger.warn('Invalid settings.defaultLimit, using default', {
            value: s.defaultLimit,
        });
        delete s.defaultLimit;
    }
    if (
        s.cacheTtlMinutes !== undefined &&
        (typeof s.cacheTtlMinutes !== 'number' || s.cacheTtlMinutes < 1)
    ) {
        logger.warn('Invalid settings.cacheTtlMinutes, using default', {
            value: s.cacheTtlMinutes,
        });
        delete s.cacheTtlMinutes;
    }

    return true;
}

/**
 * Load mood vector configuration from JSON file
 */
function loadConfig(): MoodVectorConfigFile {
    if (cachedConfig) {
        return cachedConfig;
    }

    try {
        // Try multiple paths for different environments
        const possiblePaths = [
            join(process.cwd(), 'static', 'config', 'mood-vectors.json'),
            join(process.cwd(), 'build', 'client', 'config', 'mood-vectors.json'),
            join(process.cwd(), '.svelte-kit', 'output', 'client', 'config', 'mood-vectors.json'),
        ];

        let configContent: string | null = null;
        let loadedPath: string | null = null;

        for (const configPath of possiblePaths) {
            try {
                configContent = readFileSync(configPath, 'utf-8');
                loadedPath = configPath;
                break;
            } catch {
                // Try next path
            }
        }

        if (!configContent) {
            logger.warn('Mood vectors config not found, using empty config');
            cachedConfig = { settings: DEFAULT_SETTINGS, moods: [] };
            return cachedConfig;
        }

        const parsed = JSON.parse(configContent) as Partial<MoodVectorConfigFile>;

        // Validate settings
        validateSettings(parsed.settings);

        // Validate moods and detect duplicates
        const validMoods: MoodVectorConfigFile['moods'] = [];
        const seenKeys = new Set<string>();

        if (Array.isArray(parsed.moods)) {
            for (const mood of parsed.moods) {
                if (!validateMood(mood)) continue;

                if (seenKeys.has(mood.key)) {
                    logger.warn('Duplicate mood key found, skipping', {
                        key: mood.key,
                    });
                    continue;
                }

                seenKeys.add(mood.key);
                validMoods.push(mood);
            }
        }

        // Validate and normalize the config
        cachedConfig = {
            settings: {
                ...DEFAULT_SETTINGS,
                ...(parsed.settings || {}),
            },
            moods: validMoods,
        };

        logger.info('Loaded mood vectors config', {
            path: loadedPath,
            moodCount: cachedConfig.moods.length,
            enabled: cachedConfig.settings?.enabled ?? true,
        });

        return cachedConfig;
    } catch (error) {
        logger.error('Failed to load mood vectors config', error as Error);
        cachedConfig = { settings: DEFAULT_SETTINGS, moods: [] };
        return cachedConfig;
    }
}

/**
 * Build mood map from config
 */
function buildMoodMap(): Record<string, MoodSeedConfig> {
    if (cachedMoodMap) {
        return cachedMoodMap;
    }

    const config = loadConfig();
    cachedMoodMap = {};

    for (const mood of config.moods) {
        // Skip disabled moods
        if (mood.enabled === false) {
            continue;
        }

        cachedMoodMap[mood.key] = {
            moodKey: mood.key,
            displayName: mood.displayName,
            displayNameDE: mood.displayNameDE,
            description: mood.description,
            descriptionDE: mood.descriptionDE,
            seeds: mood.seeds,
            enabled: mood.enabled,
        };
    }

    return cachedMoodMap;
}

/**
 * Get mood vector settings
 */
export function getMoodVectorSettings(): MoodVectorSettings {
    const config = loadConfig();
    return {
        ...DEFAULT_SETTINGS,
        ...config.settings,
    };
}

/**
 * Get all mood keys that have seed configurations
 */
export function getAvailableMoodKeys(): string[] {
    return Object.keys(buildMoodMap());
}

/**
 * Get seed configuration for a specific mood
 */
export function getMoodSeedConfig(moodKey: string): MoodSeedConfig | undefined {
    return buildMoodMap()[moodKey];
}

/**
 * Get all mood configurations (for API responses)
 */
export function getAllMoodConfigs(): MoodSeedConfig[] {
    return Object.values(buildMoodMap());
}

/**
 * Check if mood vectors are enabled
 */
export function isMoodVectorsEnabled(): boolean {
    return getMoodVectorSettings().enabled;
}

/**
 * Clear cached config (useful for testing or hot reloading)
 */
export function clearMoodConfigCache(): void {
    cachedConfig = null;
    cachedMoodMap = null;
    logger.info('Mood config cache cleared');
}

export const MUSIC_MOOD_SEEDS: Record<string, { description: string; keywords: string[] }> = {
    'music:chill': {
        description: m.music_mood_chill_desc(),
        keywords: ['chill', 'ambient', 'lo-fi', 'downtempo', 'relaxing'],
    },
    'music:workout': {
        description: m.music_mood_workout_desc(),
        // Seed keywords match against track genre + essentia mood_tags values.
        // The original list ('workout', 'high energy', 'uptempo', 'driving',
        // 'powerful') exists in NEITHER vocabulary — essentia's mood_tags set
        // is just electronic/aggressive/happy/sad/acoustic/relaxed/party, and
        // no genre is called "workout" — so this mood never reached
        // minSeedsRequired and generateMusicMoodVectors silently skipped it
        // (no music:workout row on prod → mood-shelf null). Seed it from the
        // hard/fast genres workout playlists are actually made of.
        keywords: [
            'workout',
            'hardstyle',
            'hard trance',
            'hands up',
            'techno',
            'eurodance',
            'drum and bass',
            'hard rock',
            'power metal',
        ],
    },
    'music:focus': {
        description: m.music_mood_focus_desc(),
        keywords: ['focus', 'instrumental', 'ambient', 'minimal', 'study'],
    },
    'music:party': {
        description: m.music_mood_party_desc(),
        keywords: ['party', 'dance', 'club', 'upbeat', 'fun'],
    },
    'music:melancholic': {
        description: m.music_mood_melancholic_desc(),
        keywords: ['sad', 'melancholic', 'emotional', 'slow', 'minor key'],
    },
    'music:sad': {
        description: m.music_mood_sad_desc(),
        keywords: ['sad', 'mournful', 'blues', 'tearful', 'heartbreak'],
    },
    'music:happy': {
        description: m.music_mood_happy_desc(),
        keywords: ['happy', 'joyful', 'cheerful', 'feel-good', 'uplifting'],
    },
    'music:energetic': {
        description: m.music_mood_energetic_desc(),
        keywords: ['energetic', 'fast', 'intense', 'aggressive', 'loud'],
    },
    'music:romantic': {
        description: m.music_mood_romantic_desc(),
        keywords: ['romantic', 'love', 'ballad', 'sweet', 'tender'],
    },
    'music:aggressive': {
        description: m.music_mood_aggressive_desc(),
        keywords: ['aggressive', 'heavy', 'metal', 'punk', 'hardcore'],
    },
    'music:ambient': {
        description: m.music_mood_ambient_desc(),
        keywords: ['ambient', 'atmospheric', 'ethereal', 'drone', 'spacious'],
    },
    'music:groovy': {
        description: m.music_mood_groovy_desc(),
        keywords: ['groovy', 'funk', 'rhythm', 'bass', 'groove'],
    },
};

// For backwards compatibility, export a MOOD_VECTOR_SEEDS constant
// This is computed lazily on first access
export const MOOD_VECTOR_SEEDS: Record<string, MoodSeedConfig> = new Proxy(
    {},
    {
        get(_target, prop: string | symbol) {
            // Ignore Symbol properties (used by JSON.stringify, spread, etc.)
            if (typeof prop === 'symbol') {
                return undefined;
            }
            return buildMoodMap()[prop];
        },
        ownKeys() {
            return Object.keys(buildMoodMap());
        },
        getOwnPropertyDescriptor(_target, prop: string | symbol) {
            // Ignore Symbol properties
            if (typeof prop === 'symbol') {
                return undefined;
            }
            const map = buildMoodMap();
            if (prop in map) {
                return {
                    enumerable: true,
                    configurable: true,
                    value: map[prop],
                };
            }
            return undefined;
        },
        has(_target, prop: string | symbol) {
            // Ignore Symbol properties
            if (typeof prop === 'symbol') {
                return false;
            }
            return prop in buildMoodMap();
        },
    },
);
