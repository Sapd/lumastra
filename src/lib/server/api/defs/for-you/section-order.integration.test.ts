// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration tests for the `/api/for-you/section-order` def wiring — flag-off
 * canonical passthrough vs flag-on engagement reordering, via the exported
 * `getRankedSectionOrder()` composition function (the GET handler is a thin
 * wrapper around it, mirroring `defs/for-you/taste.ts`'s `getTasteRailPage`).
 *
 * config.ts snapshots `process.env` into a module-level object at import time
 * (see config.test.ts's discovery-catalog-gate suite), so toggling
 * `FEATURE_FORYOU_SECTION_RANKER` between scenarios requires `vi.resetModules()`
 * + a fresh dynamic `import()` of the def per scenario.
 */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../../tests/integration/helpers/cleanup.js';
import {
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../tests/integration/fixtures/index.js';
import { bumpFeedback } from '../../../database/queries/user-section-feedback.queries.js';
import { FORYOU_LONG_TAIL_ORDER } from '$lib/shared/feed-section-kinds.js';
import type { UserId } from '$lib/shared/user-id.js';

describe('GET /api/for-you/section-order — getRankedSectionOrder (integration)', () => {
    let sql: postgres.Sql;
    let userId: UserId;
    const savedFlag = process.env.FEATURE_FORYOU_SECTION_RANKER;

    beforeAll(async () => {
        sql = getTestDb();
        await truncateTables(sql, ['user_section_feedback']);
        userId = generateTestUserId('itest-section-order');
        await ensureTestUser(sql, userId);

        // 'trending' — heavy plays, no abandon/dismiss => high engagement score.
        await Promise.all([
            ...Array.from({ length: 20 }, () =>
                bumpFeedback(sql, { userId, sectionType: 'trending', event: 'impression' }),
            ),
            ...Array.from({ length: 15 }, () =>
                bumpFeedback(sql, { userId, sectionType: 'trending', event: 'play' }),
            ),
        ]);

        // 'anime' — heavy dismissals => low (negative) engagement score.
        await Promise.all([
            ...Array.from({ length: 20 }, () =>
                bumpFeedback(sql, { userId, sectionType: 'anime', event: 'impression' }),
            ),
            ...Array.from({ length: 15 }, () =>
                bumpFeedback(sql, { userId, sectionType: 'anime', event: 'dismiss' }),
            ),
        ]);
    });

    afterAll(async () => {
        await truncateTables(sql, ['user_section_feedback']);
        await closeTestDb();
        if (savedFlag === undefined) delete process.env.FEATURE_FORYOU_SECTION_RANKER;
        else process.env.FEATURE_FORYOU_SECTION_RANKER = savedFlag;
    });

    afterEach(() => {
        vi.resetModules();
    });

    it('flag OFF returns the canonical long-tail order unchanged', async () => {
        delete process.env.FEATURE_FORYOU_SECTION_RANKER;
        vi.resetModules();
        const { getRankedSectionOrder } = await import('./section-order.js');

        const order = await getRankedSectionOrder(sql, userId);
        expect(order).toEqual([...FORYOU_LONG_TAIL_ORDER]);
    });

    it('flag ON: the high-play section (trending) ranks before the high-dismiss section (anime)', async () => {
        process.env.FEATURE_FORYOU_SECTION_RANKER = 'true';
        vi.resetModules();
        const { getRankedSectionOrder } = await import('./section-order.js');

        const order = await getRankedSectionOrder(sql, userId);
        expect(order.indexOf('trending')).toBeLessThan(order.indexOf('anime'));
        // Every canonical section still present exactly once.
        expect(order).toHaveLength(FORYOU_LONG_TAIL_ORDER.length);
        expect(new Set(order)).toEqual(new Set(FORYOU_LONG_TAIL_ORDER));
    });

    it('revert: flipping the flag back off restores the canonical order (revert -> fail -> restore)', async () => {
        // ON: reordered.
        process.env.FEATURE_FORYOU_SECTION_RANKER = 'true';
        vi.resetModules();
        const onModule = await import('./section-order.js');
        const rankedOrder = await onModule.getRankedSectionOrder(sql, userId);
        expect(rankedOrder.indexOf('trending')).toBeLessThan(rankedOrder.indexOf('anime'));
        expect(rankedOrder).not.toEqual([...FORYOU_LONG_TAIL_ORDER]);

        // OFF again: canonical passthrough, no residual reordering state.
        delete process.env.FEATURE_FORYOU_SECTION_RANKER;
        vi.resetModules();
        const offModule = await import('./section-order.js');
        const canonicalOrder = await offModule.getRankedSectionOrder(sql, userId);
        expect(canonicalOrder).toEqual([...FORYOU_LONG_TAIL_ORDER]);
    });
});
