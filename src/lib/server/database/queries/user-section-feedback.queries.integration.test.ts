// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for User Section Feedback Query Module
 *
 * Tests per-user, per-section-type engagement counter accumulation.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import { bumpFeedback, getFeedback } from './user-section-feedback.queries.js';

describe('User Section Feedback Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['user_section_feedback']);
    });

    // ========================================================================
    // bumpFeedback
    // ========================================================================

    describe('bumpFeedback', () => {
        it('creates a row on first bump', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await bumpFeedback(sql, {
                userId,
                sectionType: 'recommendations',
                event: 'impression',
            });

            const result = await getFeedback(sql, userId);
            expect(result.size).toBe(1);
            const row = result.get('recommendations');
            expect(row).toBeDefined();
            expect(row!.impressions).toBe(1);
            expect(row!.plays).toBe(0);
        });

        it('increments the correct counter per event type', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await bumpFeedback(sql, {
                userId,
                sectionType: 'trending',
                event: 'impression',
            });
            await bumpFeedback(sql, {
                userId,
                sectionType: 'trending',
                event: 'play',
            });
            await bumpFeedback(sql, {
                userId,
                sectionType: 'trending',
                event: 'abandon',
            });
            await bumpFeedback(sql, {
                userId,
                sectionType: 'trending',
                event: 'dismiss',
            });

            const result = await getFeedback(sql, userId);
            const row = result.get('trending');
            expect(row!.impressions).toBe(1);
            expect(row!.plays).toBe(1);
            expect(row!.abandonments).toBe(1);
            expect(row!.dismissals).toBe(1);
        });

        it('accumulates multiple impressions', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            for (let i = 0; i < 5; i++) {
                await bumpFeedback(sql, {
                    userId,
                    sectionType: 'new_releases',
                    event: 'impression',
                });
            }

            const result = await getFeedback(sql, userId);
            expect(result.get('new_releases')!.impressions).toBe(5);
        });

        it('leaves last_engaged_at NULL for impression', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await bumpFeedback(sql, {
                userId,
                sectionType: 'top_rated',
                event: 'impression',
            });

            const result = await getFeedback(sql, userId);
            expect(result.get('top_rated')!.lastEngagedAt).toBeNull();
        });

        it('sets last_engaged_at for play, abandon, dismiss', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await bumpFeedback(sql, {
                userId,
                sectionType: 'continue_watching',
                event: 'play',
            });

            const result = await getFeedback(sql, userId);
            expect(result.get('continue_watching')!.lastEngagedAt).not.toBeNull();
        });

        it('scopes by section_type independently', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await bumpFeedback(sql, {
                userId,
                sectionType: 'section_a',
                event: 'impression',
            });
            await bumpFeedback(sql, {
                userId,
                sectionType: 'section_b',
                event: 'impression',
            });

            const result = await getFeedback(sql, userId);
            expect(result.size).toBe(2);
            expect(result.get('section_a')!.impressions).toBe(1);
            expect(result.get('section_b')!.impressions).toBe(1);
        });
    });

    // ========================================================================
    // getFeedback
    // ========================================================================

    describe('getFeedback', () => {
        it('returns empty map when user has no feedback', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const result = await getFeedback(sql, userId);
            expect(result.size).toBe(0);
        });

        it('returns correct FeedbackRow shape', async () => {
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await bumpFeedback(sql, {
                userId,
                sectionType: 'discover',
                event: 'play',
            });

            const result = await getFeedback(sql, userId);
            const row = result.get('discover');
            expect(row).toBeDefined();
            expect(row!.sectionType).toBe('discover');
            expect(row!.impressions).toBe(0);
            expect(row!.plays).toBe(1);
            expect(row!.abandonments).toBe(0);
            expect(row!.dismissals).toBe(0);
            expect(row!.lastEngagedAt).toBeInstanceOf(Date);
            expect(row!.updatedAt).toBeInstanceOf(Date);
        });
    });
});
