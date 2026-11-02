// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Integration Tests for User Media State Query Module
 *
 * Tests the materialized read model: single-row fetch, bulk fetch,
 * resume-state filtering, upsert semantics, and deletion.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';

import { type UserId } from '$lib/shared/user-id.js';

import {
    getState,
    batchGetStates,
    getResumeStates,
    upsertState,
    deleteState,
} from './user-media-state.queries.js';

describe('User Media State Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, ['user_media_state', 'media_items', 'external_ids']);
    });

    // ========================================================================
    // Helpers
    // ========================================================================

    function makeState(params: {
        userId: UserId;
        mediaId: string;
        isWatched?: boolean;
        resumePositionMs?: number;
        runtimeMs?: number | null;
        watchCount?: number;
        highestSessionElapsedMs?: number | null;
    }) {
        const now = new Date().toISOString();
        return {
            user_id: params.userId,
            media_id: params.mediaId,
            is_watched: params.isWatched ?? false,
            resume_position_ms: params.resumePositionMs ?? 0,
            runtime_ms: params.runtimeMs ?? null,
            watch_count: params.watchCount ?? 0,
            first_watched_at: params.isWatched ? now : null,
            last_watched_at: params.isWatched ? now : null,
            last_event_at: now,
            last_event_source: 'lumastra-user-mark',
            highest_session_elapsed_ms: params.highestSessionElapsedMs ?? null,
        };
    }

    // ========================================================================
    // getState
    // ========================================================================

    describe('getState', () => {
        it('returns state row when it exists', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const state = makeState({ userId, mediaId, isWatched: true });

            await upsertState.execute(sql, { state });

            const result = await getState.one(sql, { userId, mediaId });

            expect(result).not.toBeNull();
            expect(result!.is_watched).toBe(true);
            expect(result!.user_id).toBe(userId);
            expect(result!.media_id).toBe(mediaId);
        });

        it('returns null when no state exists', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const result = await getState.one(sql, { userId, mediaId });
            expect(result).toBeNull();
        });
    });

    // ========================================================================
    // batchGetStates
    // ========================================================================

    describe('batchGetStates', () => {
        it('returns states for multiple media ids', async () => {
            const movie1 = await createAndInsertTestMovie(sql, {
                tmdbId: 700001,
            });
            const movie2 = await createAndInsertTestMovie(sql, {
                tmdbId: 700002,
            });
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await upsertState.execute(sql, {
                state: makeState({
                    userId,
                    mediaId: movie1.id,
                    isWatched: true,
                }),
            });
            await upsertState.execute(sql, {
                state: makeState({
                    userId,
                    mediaId: movie2.id,
                    isWatched: false,
                }),
            });

            const result = await batchGetStates.all(sql, {
                userId,
                mediaIds: [movie1.id, movie2.id],
            });

            expect(result.length).toBe(2);
            const mediaIds = result.map((r) => r.media_id);
            expect(mediaIds).toContain(movie1.id);
            expect(mediaIds).toContain(movie2.id);
        });

        it('returns empty array when none of the requested ids have state', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const result = await batchGetStates.all(sql, {
                userId,
                mediaIds: [mediaId],
            });
            expect(result).toEqual([]);
        });
    });

    // ========================================================================
    // getResumeStates
    // ========================================================================

    describe('getResumeStates', () => {
        it('includes items with resume_position_ms > 0 and is_watched = false', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await upsertState.execute(sql, {
                state: makeState({
                    userId,
                    mediaId,
                    isWatched: false,
                    resumePositionMs: 300000,
                }),
            });

            const result = await getResumeStates.all(sql, { userId });

            expect(result.length).toBe(1);
            expect(result[0].media_id).toBe(mediaId);
            expect(result[0].resume_position_ms).toBe(300000);
        });

        it('excludes fully watched items', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await upsertState.execute(sql, {
                state: makeState({
                    userId,
                    mediaId,
                    isWatched: true,
                    resumePositionMs: 0,
                }),
            });

            const result = await getResumeStates.all(sql, { userId });
            expect(result.length).toBe(0);
        });

        it('excludes items with zero resume position', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await upsertState.execute(sql, {
                state: makeState({
                    userId,
                    mediaId,
                    isWatched: false,
                    resumePositionMs: 0,
                }),
            });

            const result = await getResumeStates.all(sql, { userId });
            expect(result.length).toBe(0);
        });
    });

    // ========================================================================
    // upsertState
    // ========================================================================

    describe('upsertState', () => {
        it('inserts a new state row', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);
            const state = makeState({ userId, mediaId, isWatched: true });

            const result = await upsertState.execute(sql, { state });

            expect(result.length).toBe(1);
            expect(result[0].is_watched).toBe(true);
        });

        it('updates existing state on conflict', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const initial = makeState({ userId, mediaId, isWatched: false });
            await upsertState.execute(sql, { state: initial });

            const updated = makeState({ userId, mediaId, isWatched: true });
            const result = await upsertState.execute(sql, { state: updated });

            expect(result[0].is_watched).toBe(true);

            const row = await getState.one(sql, { userId, mediaId });
            expect(row!.is_watched).toBe(true);
        });

        it('ratchets highest_session_elapsed_ms with GREATEST', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const low = makeState({
                userId,
                mediaId,
                highestSessionElapsedMs: 1000,
            });
            await upsertState.execute(sql, { state: low });

            const high = makeState({
                userId,
                mediaId,
                highestSessionElapsedMs: 5000,
            });
            await upsertState.execute(sql, { state: high });

            const row = await getState.one(sql, { userId, mediaId });
            expect(row!.highest_session_elapsed_ms).toBe(5000);
        });

        it('does not decrease highest_session_elapsed_ms on lower value', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            const high = makeState({
                userId,
                mediaId,
                highestSessionElapsedMs: 8000,
            });
            await upsertState.execute(sql, { state: high });

            const low = makeState({
                userId,
                mediaId,
                highestSessionElapsedMs: 2000,
            });
            await upsertState.execute(sql, { state: low });

            const row = await getState.one(sql, { userId, mediaId });
            expect(row!.highest_session_elapsed_ms).toBe(8000);
        });
    });

    // ========================================================================
    // deleteState
    // ========================================================================

    describe('deleteState', () => {
        it('deletes the state row', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await upsertState.execute(sql, {
                state: makeState({ userId, mediaId, isWatched: true }),
            });

            await deleteState(sql, { userId, mediaId });

            const result = await getState.one(sql, { userId, mediaId });
            expect(result).toBeNull();
        });

        it('is a no-op when state does not exist', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const userId = generateTestUserId();
            await ensureTestUser(sql, userId);

            await expect(deleteState(sql, { userId, mediaId })).resolves.toBeUndefined();
        });
    });
});
