// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { expect, it } from 'vitest';
import { configSchema } from './schema';

const keys = [
    'FEATURE_MUSIC_CLUSTERING',
    'FEATURE_MUSIC_ALCHEMY',
    'FEATURE_MUSIC_SONIC',
    'FEATURE_MUSIC_MAP',
    'FEATURE_MUSIC_LYRICS_SEARCH',
    'FEATURE_MUSIC_CLUSTERS',
    'FEATURE_MUSIC_TEXT_SOUND',
    'FEATURE_MUSIC_SONIC_TASTE',
    'FEATURE_MUSIC_SONIC_QUEUE',
    'FEATURE_MUSIC_FIRST',
    'INSTANCE_PRIMARY_MODE',
    'MUSIC_AUTOPLAY_TOP_K',
    'MUSIC_AUTOPLAY_SEED_ANCHOR_WEIGHT',
    'MUSIC_AUTOPLAY_MIN_TRACK_SECONDS',
    'MUSIC_AUTOPLAY_MAX_TRACK_SECONDS',
    'MUSIC_POPULARITY_WEIGHT',
    'MUSIC_POPULARITY_EXPONENT',
    'MUSIC_POPULARITY_FLOOR',
    'MUSIC_POPULARITY_PRIMARY_SOURCE',
    'MUSIC_SONIC_QUEUE_MIN_CANDIDATES',
    'MUSIC_AUTOPLAY_GENRE_STREAK_WEIGHT',
    'MUSIC_AUTOPLAY_GENRE_STREAK_COHESION_THRESHOLD',
    'FEATURE_MUSIC_TRANSCODE',
];
it.each(keys)('%s describes live application', (key) => {
    const setting = configSchema.find((s) => s.key === key)!;
    expect(setting.requiresRestart).not.toBe(true);
    expect(setting.description).not.toMatch(/requires server restart/i);
    expect(setting.description).toMatch(/no restart/i);
});
