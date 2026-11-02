// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    JELLYFIN_PLAYED_THRESHOLD,
    isJellyfinCompatSession,
    playedThresholdFor,
    completionThresholdFor,
} from './watch-constants.js';

const HOUR_MS = 60 * 60 * 1000; // 60-min runtime → tiered episode threshold 0.90

describe('isJellyfinCompatSession', () => {
    it('is true for the jellyfin-compat device_id prefix', () => {
        expect(isJellyfinCompatSession({ device_id: 'jellyfin-compat-abc' })).toBe(true);
    });
    it('is false for a native device_id', () => {
        expect(isJellyfinCompatSession({ device_id: 'device-native-1' })).toBe(false);
    });
    it('is false for a null device_id', () => {
        expect(isJellyfinCompatSession({ device_id: null })).toBe(false);
    });
});

describe('playedThresholdFor', () => {
    it('uses the 0.90 Jellyfin bar for a compat episode', () => {
        expect(playedThresholdFor({ device_id: 'jellyfin-compat-x' }, 'episode', HOUR_MS)).toBe(
            JELLYFIN_PLAYED_THRESHOLD,
        );
    });
    it('is case-insensitive on media type (Jellyfin PascalCase)', () => {
        expect(playedThresholdFor({ device_id: 'jellyfin-compat-x' }, 'Episode', HOUR_MS)).toBe(
            0.9,
        );
    });
    it('keeps the tiered bar for a compat MOVIE (episodes-only scoping)', () => {
        expect(playedThresholdFor({ device_id: 'jellyfin-compat-x' }, 'movie', HOUR_MS)).toBe(
            completionThresholdFor('movie', HOUR_MS),
        );
    });
    it('keeps the tiered bar for a native episode', () => {
        expect(playedThresholdFor({ device_id: 'device-native-1' }, 'episode', HOUR_MS)).toBe(
            completionThresholdFor('episode', HOUR_MS),
        );
    });
});
