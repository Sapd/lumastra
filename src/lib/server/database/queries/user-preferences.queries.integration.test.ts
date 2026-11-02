// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for User Preferences Query Module
 *
 * Tests widget order and playback preferences operations.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

// Import query functions to test
import {
    getWidgetOrder,
    upsertWidgetOrderFull,
    upsertWidgetOrderOnly,
    upsertHiddenWidgetsOnly,
    deleteAllWidgetOrder,
    getPlaybackPreferences,
    upsertPlaybackPreferences,
    deletePlaybackPreferences,
} from './user-preferences.queries.js';

describe('User Preferences Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, TEST_TABLES.preferences);
    });

    async function ensureUser(userId: string): Promise<void> {
        await ensureTestUser(sql, userId);
    }

    it('defaults episode languages on and preserves an explicit off value across unrelated updates', async () => {
        const userId = generateTestUserId();
        await ensureUser(userId);
        await upsertPlaybackPreferences(sql, userId, {});
        expect((await getPlaybackPreferences.one(sql, { userId }))?.show_episode_languages).toBe(
            true,
        );
        await upsertPlaybackPreferences(sql, userId, { showEpisodeLanguages: false });
        await upsertPlaybackPreferences(sql, userId, { audioLanguage: 'de' });
        expect((await getPlaybackPreferences.one(sql, { userId }))?.show_episode_languages).toBe(
            false,
        );
        await upsertPlaybackPreferences(sql, userId, { showEpisodeLanguages: true });
        expect((await getPlaybackPreferences.one(sql, { userId }))?.show_episode_languages).toBe(
            true,
        );
        const otherUserId = generateTestUserId();
        await ensureUser(otherUserId);
        await upsertPlaybackPreferences(sql, otherUserId, {});
        await upsertPlaybackPreferences(sql, userId, { showEpisodeLanguages: false });
        expect(
            (await getPlaybackPreferences.one(sql, { userId: otherUserId }))
                ?.show_episode_languages,
        ).toBe(true);
    });

    it('round trips the beat pulse preference and preserves it during unrelated updates', async () => {
        const userId = generateTestUserId();
        await ensureUser(userId);
        await upsertPlaybackPreferences(sql, userId, { musicAlwaysShowBeatPulse: true });
        expect(
            (await getPlaybackPreferences.one(sql, { userId }))?.music_always_show_beat_pulse,
        ).toBe(true);
        await upsertPlaybackPreferences(sql, userId, { musicShowBpm: false });
        const updated = await getPlaybackPreferences.one(sql, { userId });
        expect(updated?.music_always_show_beat_pulse).toBe(true);
        expect(updated?.music_show_bpm).toBe(false);
        await upsertPlaybackPreferences(sql, userId, { musicAlwaysShowBeatPulse: false });
        expect(
            (await getPlaybackPreferences.one(sql, { userId }))?.music_always_show_beat_pulse,
        ).toBe(false);
    });

    // ==========================================================================
    // Widget Order Queries
    // ==========================================================================

    describe('getWidgetOrder', () => {
        it('returns widget order for a user', async () => {
            const username = generateTestUserId();
            await ensureUser(username);
            const widgetOrder = ['hero', 'continue-watching', 'trending', 'for-you'];
            const hiddenWidgets = ['upcoming'];

            await upsertWidgetOrderFull.execute(sql, {
                userId: username,
                widgetOrder,
                hiddenWidgets,
            });

            const result = await getWidgetOrder.one(sql, { userId: username });

            expect(result).not.toBeNull();
            expect(result?.widget_order).toEqual(widgetOrder);
            expect(result?.hidden_widgets).toEqual(hiddenWidgets);
        });

        it('returns null for user with no widget preferences', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            const result = await getWidgetOrder.one(sql, { userId: username });

            expect(result).toBeNull();
        });
    });

    describe('upsertWidgetOrderFull', () => {
        it('inserts new widget order', async () => {
            const username = generateTestUserId();
            await ensureUser(username);
            const widgetOrder = ['a', 'b', 'c'];
            const hiddenWidgets = ['d', 'e'];

            const result = await upsertWidgetOrderFull.execute(sql, {
                userId: username,
                widgetOrder,
                hiddenWidgets,
            });

            expect(result.length).toBe(1);
            expect(result[0].widget_order).toEqual(widgetOrder);
            expect(result[0].hidden_widgets).toEqual(hiddenWidgets);
        });

        it('updates existing widget order', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            // Initial
            await upsertWidgetOrderFull.execute(sql, {
                userId: username,
                widgetOrder: ['old1', 'old2'],
                hiddenWidgets: ['hidden1'],
            });

            // Update
            const result = await upsertWidgetOrderFull.execute(sql, {
                userId: username,
                widgetOrder: ['new1', 'new2', 'new3'],
                hiddenWidgets: ['hidden2', 'hidden3'],
            });

            expect(result[0].widget_order).toEqual(['new1', 'new2', 'new3']);
            expect(result[0].hidden_widgets).toEqual(['hidden2', 'hidden3']);
        });
    });

    describe('deleteAllWidgetOrder', () => {
        it('deletes every user row and returns the affected user ids', async () => {
            const userA = generateTestUserId();
            const userB = generateTestUserId();
            await ensureUser(userA);
            await ensureUser(userB);
            await upsertWidgetOrderFull.execute(sql, {
                userId: userA,
                widgetOrder: ['a', 'b'],
                hiddenWidgets: ['x'],
            });
            await upsertWidgetOrderFull.execute(sql, {
                userId: userB,
                widgetOrder: ['c'],
                hiddenWidgets: [],
            });

            const deleted = await deleteAllWidgetOrder.execute(sql, {});

            expect(deleted.length).toBe(2);
            expect(await getWidgetOrder.one(sql, { userId: userA })).toBeNull();
            expect(await getWidgetOrder.one(sql, { userId: userB })).toBeNull();
        });

        it('is a no-op (returns empty) when no rows exist', async () => {
            const deleted = await deleteAllWidgetOrder.execute(sql, {});
            expect(deleted.length).toBe(0);
        });
    });

    describe('upsertWidgetOrderOnly', () => {
        it('updates widget order while preserving hidden widgets', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            // Initial with both
            await upsertWidgetOrderFull.execute(sql, {
                userId: username,
                widgetOrder: ['initial1', 'initial2'],
                hiddenWidgets: ['preserve-hidden'],
            });

            // Update only widget order
            await upsertWidgetOrderOnly.execute(sql, {
                userId: username,
                widgetOrder: ['updated1', 'updated2', 'updated3'],
            });

            const result = await getWidgetOrder.one(sql, { userId: username });

            expect(result?.widget_order).toEqual(['updated1', 'updated2', 'updated3']);
            expect(result?.hidden_widgets).toEqual(['preserve-hidden']);
        });

        it('creates new record if none exists', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            await upsertWidgetOrderOnly.execute(sql, {
                userId: username,
                widgetOrder: ['first', 'second'],
            });

            const result = await getWidgetOrder.one(sql, { userId: username });

            expect(result?.widget_order).toEqual(['first', 'second']);
            // hidden_widgets defaults to empty array per schema
            expect(result?.hidden_widgets).toEqual([]);
        });
    });

    describe('upsertHiddenWidgetsOnly', () => {
        it('updates hidden widgets while preserving widget order', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            // Initial
            await upsertWidgetOrderFull.execute(sql, {
                userId: username,
                widgetOrder: ['preserve-order'],
                hiddenWidgets: ['old-hidden'],
            });

            // Update only hidden widgets
            await upsertHiddenWidgetsOnly.execute(sql, {
                userId: username,
                hiddenWidgets: ['new-hidden-1', 'new-hidden-2'],
            });

            const result = await getWidgetOrder.one(sql, { userId: username });

            expect(result?.widget_order).toEqual(['preserve-order']);
            expect(result?.hidden_widgets).toEqual(['new-hidden-1', 'new-hidden-2']);
        });

        it('creates new record with empty widget_order if none exists', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            await upsertHiddenWidgetsOnly.execute(sql, {
                userId: username,
                hiddenWidgets: ['hidden-only'],
            });

            const result = await getWidgetOrder.one(sql, { userId: username });

            expect(result?.widget_order).toEqual([]);
            expect(result?.hidden_widgets).toEqual(['hidden-only']);
        });
    });

    // ==========================================================================
    // Playback Preferences Queries
    // ==========================================================================

    describe('getPlaybackPreferences', () => {
        it('returns playback preferences for a user', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            await upsertPlaybackPreferences(sql, username, {
                audioLanguage: 'de',
                subtitleLanguage: 'en',
                subtitlesEnabled: true,
                qualityMode: 'auto',
                maxBitrateBps: 20000,
            });

            const result = await getPlaybackPreferences.one(sql, {
                userId: username,
            });

            expect(result).not.toBeNull();
            expect(result?.audio_language).toBe('de');
            expect(result?.subtitle_language).toBe('en');
            expect(result?.subtitles_enabled).toBe(true);
            expect(result?.quality_mode).toBe('auto');
            expect(result?.max_bitrate).toBe(20000);
        });

        it('returns null for user with no preferences', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            const result = await getPlaybackPreferences.one(sql, {
                userId: username,
            });

            expect(result).toBeNull();
        });
    });

    describe('upsertPlaybackPreferences', () => {
        it('inserts new playback preferences', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            const result = await upsertPlaybackPreferences(sql, username, {
                audioLanguage: 'en',
                subtitlesEnabled: false,
                qualityMode: 'original',
            });

            expect(result).not.toBeNull();
            expect(result?.audio_language).toBe('en');
            expect(result?.subtitles_enabled).toBe(false);
            expect(result?.quality_mode).toBe('original');
        });

        it('updates existing preferences with COALESCE', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            // Initial preferences
            await upsertPlaybackPreferences(sql, username, {
                audioLanguage: 'de',
                subtitleLanguage: 'de',
                subtitlesEnabled: true,
                maxBitrateBps: 10000,
            });

            // Partial update - should preserve unspecified fields
            await upsertPlaybackPreferences(sql, username, {
                audioLanguage: 'en', // Only update audio language
            });

            const result = await getPlaybackPreferences.one(sql, {
                userId: username,
            });

            expect(result?.audio_language).toBe('en'); // Updated
            expect(result?.subtitle_language).toBe('de'); // Preserved
            expect(result?.subtitles_enabled).toBe(true); // Preserved
            expect(result?.max_bitrate).toBe(10000); // Preserved
        });

        it('handles all preference fields', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            const result = await upsertPlaybackPreferences(sql, username, {
                audioLanguage: 'ja',
                subtitleLanguage: 'en',
                subtitlesEnabled: true,
                forcedSubtitlesEnabled: false,
                subtitleStyle: JSON.stringify({ fontSize: 'medium' }),
                qualityMode: 'fixed',
                maxBitrateBps: 15000,
                preferredResolution: '1080p',
                autoplayNextEpisode: true,
                skipIntroAutomatically: true,
                skipCreditsAutomatically: false,
                stillWatchingEnabled: true,
            });

            expect(result?.audio_language).toBe('ja');
            expect(result?.forced_subtitles_enabled).toBe(false);
            expect(result?.preferred_resolution).toBe('1080p');
            expect(result?.autoplay_next_episode).toBe(true);
            expect(result?.skip_intro_automatically).toBe(true);
            expect(result?.skip_credits_automatically).toBe(false);
            expect(result?.still_watching_enabled).toBe(true);
        });

        it('leaves the still-watching prompt off for a row that never set it', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            // The column DEFAULT is what makes every existing row and every
            // fresh one keep today's behaviour. A writer that bound an explicit
            // null here instead of omitting the key would defeat it silently.
            const result = await upsertPlaybackPreferences(sql, username, {
                autoplayNextEpisode: true,
            });

            expect(result?.still_watching_enabled).toBe(false);
        });

        it('persists and clears metadata language prefs', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            const row = await upsertPlaybackPreferences(sql, username, {
                metadataLanguage: 'de',
                metadataTitleLanguage: null,
            });
            expect(row?.metadata_language).toBe('de');
            expect(row?.metadata_title_language).toBeNull();

            // presence-preserving: omitting the key leaves it untouched
            const row2 = await upsertPlaybackPreferences(sql, username, { seekStepSeconds: 15 });
            expect(row2?.metadata_language).toBe('de');
        });
    });

    describe('deletePlaybackPreferences', () => {
        it('deletes playback preferences', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            await upsertPlaybackPreferences(sql, username, {
                audioLanguage: 'de',
                subtitlesEnabled: true,
            });

            const result = await deletePlaybackPreferences.execute(sql, {
                userId: username,
            });

            expect(result.length).toBe(1);
            expect(result[0].user_id).toBe(username);

            // Verify deleted
            const remaining = await getPlaybackPreferences.one(sql, {
                userId: username,
            });
            expect(remaining).toBeNull();
        });

        it('returns empty array if no preferences to delete', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            const result = await deletePlaybackPreferences.execute(sql, {
                userId: username,
            });

            expect(result).toEqual([]);
        });
    });

    // ==========================================================================
    // Edge Cases
    // ==========================================================================

    describe('edge cases', () => {
        it('handles empty widget arrays', async () => {
            const username = generateTestUserId();
            await ensureUser(username);

            await upsertWidgetOrderFull.execute(sql, {
                userId: username,
                widgetOrder: [],
                hiddenWidgets: [],
            });

            const result = await getWidgetOrder.one(sql, { userId: username });

            expect(result?.widget_order).toEqual([]);
            expect(result?.hidden_widgets).toEqual([]);
        });

        it('handles widget order with many items', async () => {
            const username = generateTestUserId();
            await ensureUser(username);
            const manyWidgets = Array.from({ length: 20 }, (_, i) => `widget-${i}`);

            await upsertWidgetOrderFull.execute(sql, {
                userId: username,
                widgetOrder: manyWidgets,
                hiddenWidgets: [],
            });

            const result = await getWidgetOrder.one(sql, { userId: username });

            expect(result?.widget_order).toEqual(manyWidgets);
            expect(result?.widget_order?.length).toBe(20);
        });

        it('handles special characters in widget names', async () => {
            const username = generateTestUserId();
            await ensureUser(username);
            const specialWidgets = [
                'widget-with-dash',
                'widget_with_underscore',
                'widget.with.dots',
            ];

            await upsertWidgetOrderFull.execute(sql, {
                userId: username,
                widgetOrder: specialWidgets,
                hiddenWidgets: [],
            });

            const result = await getWidgetOrder.one(sql, { userId: username });

            expect(result?.widget_order).toEqual(specialWidgets);
        });
    });
});
