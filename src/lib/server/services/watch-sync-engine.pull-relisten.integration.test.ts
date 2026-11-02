// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Re-listen counting: `watch_count` must equal "times finished".
 *
 * This is what the UI renders as `3× gehört`, and it is derived — not stored.
 * `watch-state-rebuilder.service.ts` computes it as
 * `max(0, snapshot.watch_count + positives - negatives)` over the event log,
 * where positives are `completed`/`mark_watched` and negatives `mark_unwatched`.
 *
 * The obvious implementation is wrong in both directions, which is why this is
 * an integration test over the real rebuilder rather than a unit test:
 *
 *  - Incrementing on the `isFinished` true→false transition maps to
 *    `mark_unwatched`, which DECREMENTS.
 *  - Letting a restart emit `mark_unwatched` naturally makes finish → restart →
 *    finish net to +1 forever (+1, −1, +1), so `2× gehört` is unreachable.
 *
 * Requires TEST_DATABASE_URL (or DATABASE_URL).
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import type {
    WatchSyncDefinition,
    WatchStatePullItem,
    WatchSyncPullResult,
} from '@sapd/lumastra-plugin-sdk';
import { getTestDb, closeTestDb } from '../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
    derivedUsername,
} from '../../../../tests/integration/fixtures/index.js';
import { registry } from '../tasks/registry.js';
import { watchSyncEngine } from './watch-sync-engine.service.js';

const SKIP_TESTS = !process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL;

function makePullPlugin(
    providerId: string,
    providerName: string,
    pull: () => Promise<WatchSyncPullResult>,
): WatchSyncDefinition {
    return {
        id: providerId,
        name: 'Fake Re-listen Sync',
        version: '1.0.0',
        capabilities: { http: true },
        providerName,
        isAvailable: async () => true,
        pullWatchState: pull,
        resolveIds: async () => [],
        pushWatchState: async () => ({
            succeeded: 0,
            failed: 0,
            skipped: 0,
            staleIds: [],
            errors: [],
            successful: [],
            drainedAsSkipped: [],
        }),
    };
}

describe.skipIf(SKIP_TESTS)('WatchSyncEngine pull — re-listen counting', () => {
    let sql: postgres.Sql;

    beforeAll(() => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [
            'watch_sync_activity',
            'watch_state_pending_resolution',
            'watch_state_pull_log',
            'user_media_events',
            'user_media_state',
            'user_media_flags',
            'media_items',
            'external_ids',
            'user_profiles',
        ]);
    });

    const stateOf = async (userId: string, mediaId: string) => {
        const [row] = await sql<Array<{ watch_count: number; is_watched: boolean }>>`
            SELECT watch_count, is_watched FROM user_media_state
            WHERE user_id = ${userId}::uuid AND media_id = ${mediaId}::uuid
        `;
        return row ?? null;
    };

    /**
     * BLOCKED — documents the target the design asks for, which the current
     * rebuilder cannot express. Kept skipped (not deleted) so the requirement
     * stays visible and this becomes the acceptance test once the semantics
     * below are decided. See the sibling test for what actually happens today.
     *
     * The contradiction, measured rather than reasoned:
     *
     *  1. `watch_count = max(0, snapshot + positives − negatives)`
     *     (`watch-state-rebuilder.service.ts:603`), where `mark_unwatched` is
     *     the only negative.
     *  2. A restarted book must show a resume position, and the rebuilder
     *     ZEROES `resume_position_ms` for anything watched
     *     (`watch-state-rebuilder.service.ts:507`). So `is_watched` must go
     *     false on a restart.
     *  3. `is_watched` can only go false via `mark_unwatched` — a negative.
     *
     * So every restart necessarily cancels one completion: finish → restart →
     * finish nets +1, forever. Suppressing the `mark_unwatched` does not help
     * either — it leaves `is_watched` true, so the second completion fails the
     * engine's `if (!currentState?.is_watched)` gate and emits nothing at all
     * (still 1), AND the restart's position is discarded by (2), which breaks
     * Weiterhören — the thing this connector exists for.
     *
     * Fixing it means changing how `watch_count` is derived, which is shared
     * arbitration code affecting Jellyfin, Trakt and MAL rewatch counts. Three
     * candidate directions:
     *
     *  a. Count only completions with a DISTINCT `source_event_id` as
     *     positives, and stop subtracting sync-sourced `mark_unwatched`
     *     (keep subtracting deliberate `lumastra-user-mark` un-marks). The
     *     dedup index `idx_ume_dedup` already makes each ABS completion
     *     idempotently identifiable via `finishedAt`.
     *  b. Derive "times finished" at read time by counting distinct completion
     *     events, and leave `user_media_state.watch_count` as the net figure.
     *     No rebuilder change, no blast radius, but a different read path than
     *     the presentation spec assumed.
     *  c. Store completions in their own column fed by the same identity.
     *
     * (a) is the most faithful to "watch_count = times finished" and probably
     * fixes the same latent bug for the other three providers, but it changes
     * numbers users already see.
     */
    it.skip('counts two completions across a restart as watch_count = 2', async () => {
        const providerId = 'fake-relisten-audiobookshelf';
        const providerName = 'audiobookshelf';
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Re-listen Book',
        });

        const RUNTIME = 3_600_000;
        let finished = false;
        let positionMs = 0;
        let occurredAt = new Date('2026-01-01T00:00:00Z');

        const item = (): WatchStatePullItem => ({
            providerId: 'abs-relisten-item',
            tmdbId: String(tmdbId),
            imdbId: null,
            mediaType: 'movie',
            isWatched: finished,
            resumePositionMs: positionMs,
            runtimeMs: RUNTIME,
            watchCount: 0,
            providerUsername,
            title: 'Re-listen Book',
            lastWatchedAt: occurredAt,
        });
        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [item()],
                errors: [],
                newCursors: new Map(),
            })),
        );

        // 1. Listening through the book.
        positionMs = 1_800_000;
        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect((await stateOf(userId, mediaId))?.watch_count ?? 0).toBe(0);

        // 2. First completion.
        finished = true;
        positionMs = 0;
        occurredAt = new Date('2026-01-02T00:00:00Z');
        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect(await stateOf(userId, mediaId)).toMatchObject({
            watch_count: 1,
            is_watched: true,
        });

        // 3. The user restarts the book. ABS clears isFinished and the position
        //    walks forward from the beginning again.
        finished = false;
        positionMs = 15_000;
        occurredAt = new Date('2026-01-03T00:00:00Z');
        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect((await stateOf(userId, mediaId))?.watch_count).toBe(1);

        // 4. Second completion — this is the one that must land.
        finished = true;
        positionMs = 0;
        occurredAt = new Date('2026-01-04T00:00:00Z');
        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect(await stateOf(userId, mediaId)).toMatchObject({
            watch_count: 2,
            is_watched: true,
        });
    });

    /**
     * Pins CURRENT behaviour so the gap above is a measured fact rather than an
     * assumption, and so any change to the derivation shows up here loudly.
     *
     * What this proves: a restart emits `mark_unwatched`, which decrements — so
     * a second completion returns `watch_count` to 1, not 2. Everything else the
     * connector needs (the position reopening, the second completion being
     * observed at all) works; only the COUNT is wrong.
     */
    it('currently nets a restart against the completion, leaving watch_count at 1', async () => {
        const providerId = 'fake-relisten-current-behaviour';
        const providerName = 'audiobookshelf';
        const userId = generateTestUserId();
        await ensureTestUser(sql, userId);
        const providerUsername = derivedUsername(userId);

        const { id: mediaId, tmdbId } = await createAndInsertTestMovie(sql, {
            title: 'Re-listen Book Current',
        });

        const RUNTIME = 3_600_000;
        let finished = false;
        let positionMs = 1_800_000;
        let occurredAt = new Date('2026-01-01T00:00:00Z');

        registry.registerWatchSync(
            makePullPlugin(providerId, providerName, async () => ({
                items: [
                    {
                        providerId: 'abs-relisten-current',
                        tmdbId: String(tmdbId),
                        imdbId: null,
                        mediaType: 'movie',
                        isWatched: finished,
                        resumePositionMs: positionMs,
                        runtimeMs: RUNTIME,
                        watchCount: 0,
                        providerUsername,
                        title: 'Re-listen Book Current',
                        lastWatchedAt: occurredAt,
                    } satisfies WatchStatePullItem,
                ],
                errors: [],
                newCursors: new Map(),
            })),
        );

        await watchSyncEngine.runPull(providerId, undefined, sql);

        // First completion → +1.
        finished = true;
        positionMs = 0;
        occurredAt = new Date('2026-01-02T00:00:00Z');
        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect((await stateOf(userId, mediaId))?.watch_count).toBe(1);

        // Restart → mark_unwatched → −1. The position reopens correctly, which
        // is what Weiterhören needs; only the count is collateral damage.
        finished = false;
        positionMs = 15_000;
        occurredAt = new Date('2026-01-03T00:00:00Z');
        await watchSyncEngine.runPull(providerId, undefined, sql);
        const afterRestart = await stateOf(userId, mediaId);
        expect(afterRestart?.watch_count).toBe(0);
        expect(afterRestart?.is_watched).toBe(false);

        // Second completion → +1 again, netting 1 rather than 2.
        finished = true;
        positionMs = 0;
        occurredAt = new Date('2026-01-04T00:00:00Z');
        await watchSyncEngine.runPull(providerId, undefined, sql);
        expect(await stateOf(userId, mediaId)).toMatchObject({
            watch_count: 1,
            is_watched: true,
        });
    });
});
