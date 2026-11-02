// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Module-level settings in config.ts (`export let X = live(...)`) used to be
 * `export const` — read once at import, so every consumer kept the boot value
 * and the schema had to say "requires restart". They now follow a save.
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('fs/promises')>();
    return {
        ...actual,
        writeFile: vi.fn().mockResolvedValue(undefined),
        // settings.json is written to a temp file and renamed into place.
        rename: vi.fn().mockResolvedValue(undefined),
        mkdir: vi.fn().mockResolvedValue(undefined),
    };
});

import * as cfg from '$lib/server/config';
import { saveConfig } from '$lib/server/config/index.js';

describe('live config bindings', () => {
    it('a saved retention window reaches importers without a restart', async () => {
        const before = cfg.DB_CLEANUP_WATCH_HISTORY_DAYS;
        const next = before === 123 ? 124 : 123;

        await saveConfig({ DB_CLEANUP_WATCH_HISTORY_DAYS: next });

        expect(cfg.DB_CLEANUP_WATCH_HISTORY_DAYS).toBe(next);
    });

    it('a saved queue-depth cap reaches importers without a restart', async () => {
        await saveConfig({ LUMASTRA_QUEUE_DEPTH_CAP_IO: 777 });
        expect(cfg.LUMASTRA_QUEUE_DEPTH_CAP_IO).toBe(777);
    });
});

// These settings used to claim a restart in their descriptions. Exercise the
// same ConfigService write/getter path the admin form uses, not just metadata.
it.each([
    ['FEATURE_MUSIC_CLUSTERING', false],
    ['FEATURE_MUSIC_ALCHEMY', true],
    ['FEATURE_MUSIC_SONIC', true],
    ['FEATURE_MUSIC_MAP', true],
    ['FEATURE_MUSIC_LYRICS_SEARCH', true],
    ['FEATURE_MUSIC_CLUSTERS', true],
    ['FEATURE_MUSIC_TEXT_SOUND', true],
    ['FEATURE_MUSIC_SONIC_TASTE', true],
    ['FEATURE_MUSIC_SONIC_QUEUE', true],
    ['FEATURE_MUSIC_FIRST', true],
    ['FEATURE_MUSIC_TRANSCODE', false],
    ['INSTANCE_PRIMARY_MODE', 'music'],
    ['MUSIC_AUTOPLAY_TOP_K', 7],
    ['MUSIC_AUTOPLAY_SEED_ANCHOR_WEIGHT', 0.2],
    ['MUSIC_AUTOPLAY_MIN_TRACK_SECONDS', 60],
    ['MUSIC_AUTOPLAY_MAX_TRACK_SECONDS', 1200],
    ['MUSIC_POPULARITY_WEIGHT', 0.2],
    ['MUSIC_POPULARITY_EXPONENT', 0.6],
    ['MUSIC_POPULARITY_FLOOR', 0.2],
    ['MUSIC_POPULARITY_PRIMARY_SOURCE', 'lastfm'],
    ['MUSIC_SONIC_QUEUE_MIN_CANDIDATES', 8],
    ['MUSIC_AUTOPLAY_GENRE_STREAK_WEIGHT', 0.3],
    ['MUSIC_AUTOPLAY_GENRE_STREAK_COHESION_THRESHOLD', 0.6],
] as const)('%s reads a saved music setting live', async (key, value) => {
    const reader = cfg.config as unknown as Record<string, unknown>;
    const before = reader[key];
    try {
        await saveConfig({ [key]: value });
        expect(reader[key]).toBe(value);
    } finally {
        await saveConfig({ [key]: before } as Parameters<typeof saveConfig>[0]);
    }
});
