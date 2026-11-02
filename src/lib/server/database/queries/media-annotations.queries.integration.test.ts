// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import type postgres from 'postgres';
import { getTestDb, closeTestDb } from '../../../../../tests/integration/setup/test-database.js';
import { truncateTables, TEST_TABLES } from '../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    generateTestUserId,
    ensureTestUser,
} from '../../../../../tests/integration/fixtures/index.js';
import {
    getAnnotations,
    createAnnotation,
    deleteAnnotation,
    getUserPinCount,
    upsertReview,
} from './media-annotations.queries.js';

describe('Media Annotations Queries', () => {
    let sql: postgres.Sql;

    beforeAll(async () => {
        sql = getTestDb();
    });

    afterAll(async () => {
        await closeTestDb();
    });

    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'media_annotations']);
    });

    describe('createAnnotation', () => {
        it('creates a chat message without timestamp', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const username = generateTestUserId();
            await ensureTestUser(sql, username);

            const result = await createAnnotation(sql, {
                mediaId,
                userId: username,
                type: 'chat',
                content: 'Great episode!',
            });

            expect(result.id).toBeDefined();
            expect(result.content).toBe('Great episode!');
            expect(result.type).toBe('chat');
            expect(result.timestamp_seconds).toBeNull();
        });

        it('creates a pin with timestamp', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const username = generateTestUserId();
            await ensureTestUser(sql, username);

            const result = await createAnnotation(sql, {
                mediaId,
                userId: username,
                type: 'pin',
                content: 'Amazing scene!',
                timestampSeconds: 143.5,
            });

            expect(result.type).toBe('pin');
            expect(Number(result.timestamp_seconds)).toBeCloseTo(143.5);
        });
    });

    describe('getAnnotations', () => {
        it('returns annotations for a media item, excluding deleted', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const username = generateTestUserId();
            await ensureTestUser(sql, username);

            await createAnnotation(sql, {
                mediaId,
                userId: username,
                type: 'chat',
                content: 'Hello',
            });
            const toDelete = await createAnnotation(sql, {
                mediaId,
                userId: username,
                type: 'chat',
                content: 'Delete me',
            });
            await deleteAnnotation(sql, {
                annotationId: toDelete.id,
                userId: username,
            });

            const results = await getAnnotations(sql, { mediaId });
            expect(results).toHaveLength(1);
            expect(results[0].content).toBe('Hello');
        });

        it('excludes hide_streams authors from chats, pins and reviews before limiting', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const hidden = generateTestUserId();
            const visible = generateTestUserId();
            await ensureTestUser(sql, hidden);
            await ensureTestUser(sql, visible);
            await sql`UPDATE users SET hide_streams = true WHERE id = ${hidden}`;

            for (const type of ['chat', 'pin', 'review'] as const) {
                await createAnnotation(sql, {
                    mediaId,
                    userId: hidden,
                    type,
                    content: `Hidden ${type}`,
                    timestampSeconds: type === 'pin' ? 10 : undefined,
                });
                const publicAnnotation = await createAnnotation(sql, {
                    mediaId,
                    userId: visible,
                    type,
                    content: `Visible ${type}`,
                    timestampSeconds: type === 'pin' ? 20 : undefined,
                });
                // Hidden rows must not consume the response limit, including
                // the review-only reader used by both API context surfaces.
                expect(await getAnnotations(sql, { mediaId, type, limit: 1 })).toEqual([
                    publicAnnotation,
                ]);
            }
            const own = await getAnnotations(sql, { mediaId, currentUser: hidden });
            expect(own).toHaveLength(6);
            expect(own.filter((row) => row.user_id === hidden)).toHaveLength(3);
            expect(
                (await getAnnotations(sql, { mediaId, currentUser: visible })).map(
                    (row) => row.user_id,
                ),
            ).toEqual([visible, visible, visible]);
        });

        it('filters by type when specified', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const username = generateTestUserId();
            await ensureTestUser(sql, username);

            await createAnnotation(sql, {
                mediaId,
                userId: username,
                type: 'chat',
                content: 'Chat msg',
            });
            await createAnnotation(sql, {
                mediaId,
                userId: username,
                type: 'pin',
                content: 'Pin!',
                timestampSeconds: 10,
            });

            const pins = await getAnnotations(sql, { mediaId, type: 'pin' });
            expect(pins).toHaveLength(1);
            expect(pins[0].type).toBe('pin');
        });
    });

    describe('getUserPinCount', () => {
        it('counts only non-deleted pins for user on a media item', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const username = generateTestUserId();
            await ensureTestUser(sql, username);

            await createAnnotation(sql, {
                mediaId,
                userId: username,
                type: 'pin',
                content: 'Pin 1',
                timestampSeconds: 10,
            });
            await createAnnotation(sql, {
                mediaId,
                userId: username,
                type: 'pin',
                content: 'Pin 2',
                timestampSeconds: 20,
            });
            const pin3 = await createAnnotation(sql, {
                mediaId,
                userId: username,
                type: 'pin',
                content: 'Pin 3',
                timestampSeconds: 30,
            });
            await deleteAnnotation(sql, {
                annotationId: pin3.id,
                userId: username,
            });

            const count = await getUserPinCount(sql, {
                mediaId,
                userId: username,
            });
            expect(count).toBe(2);
        });
    });

    describe('upsertReview', () => {
        it('creates a new review on first write', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const username = generateTestUserId();
            await ensureTestUser(sql, username);

            const result = await upsertReview(sql, {
                mediaId,
                userId: username,
                content: 'Great film!',
            });

            expect(result.id).toBeDefined();
            expect(result.type).toBe('review');
            expect(result.content).toBe('Great film!');
            expect(result.user_id).toBe(username);
        });

        it('updates existing review on second write (idempotent)', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const username = generateTestUserId();
            await ensureTestUser(sql, username);

            const first = await upsertReview(sql, {
                mediaId,
                userId: username,
                content: 'First version',
            });
            const second = await upsertReview(sql, {
                mediaId,
                userId: username,
                content: 'Updated version',
            });

            // Same row updated, not a new insert
            expect(second.id).toBe(first.id);
            expect(second.content).toBe('Updated version');

            // Only one review exists
            const all = await getAnnotations(sql, { mediaId, type: 'review' });
            expect(all).toHaveLength(1);
        });

        it('creates a fresh review after the previous one was soft-deleted', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const username = generateTestUserId();
            await ensureTestUser(sql, username);

            const first = await upsertReview(sql, {
                mediaId,
                userId: username,
                content: 'Original',
            });
            await deleteAnnotation(sql, {
                annotationId: first.id,
                userId: username,
            });

            // Verify deleted
            const afterDelete = await getAnnotations(sql, {
                mediaId,
                type: 'review',
            });
            expect(afterDelete).toHaveLength(0);

            // Re-create should work (conflict predicate excludes deleted rows)
            const second = await upsertReview(sql, {
                mediaId,
                userId: username,
                content: 'New review after delete',
            });

            expect(second.content).toBe('New review after delete');
            const afterRe = await getAnnotations(sql, {
                mediaId,
                type: 'review',
            });
            expect(afterRe).toHaveLength(1);
        });
    });

    describe('deleteAnnotation', () => {
        it('soft-deletes own annotation', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const username = generateTestUserId();
            await ensureTestUser(sql, username);
            const ann = await createAnnotation(sql, {
                mediaId,
                userId: username,
                type: 'chat',
                content: 'Hi',
            });

            await deleteAnnotation(sql, {
                annotationId: ann.id,
                userId: username,
            });

            const results = await getAnnotations(sql, { mediaId });
            expect(results).toHaveLength(0);
        });

        it('does not delete annotation belonging to another user', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const owner = generateTestUserId();
            const intruder = generateTestUserId();
            await ensureTestUser(sql, owner);
            await ensureTestUser(sql, intruder);
            const ann = await createAnnotation(sql, {
                mediaId,
                userId: owner,
                type: 'chat',
                content: 'Mine',
            });

            await deleteAnnotation(sql, {
                annotationId: ann.id,
                userId: intruder,
            });

            const results = await getAnnotations(sql, { mediaId });
            expect(results).toHaveLength(1); // untouched
        });

        it('allows moderator (isAdmin: true) to delete any annotation', async () => {
            const { id: mediaId } = await createAndInsertTestMovie(sql);
            const owner = generateTestUserId();
            const moderator = generateTestUserId();
            await ensureTestUser(sql, owner);
            await ensureTestUser(sql, moderator);
            const ann = await createAnnotation(sql, {
                mediaId,
                userId: owner,
                type: 'pin',
                content: "Someone else's pin",
                timestampSeconds: 42,
            });

            await deleteAnnotation(sql, {
                annotationId: ann.id,
                userId: moderator,
                isAdmin: true,
            });

            const results = await getAnnotations(sql, { mediaId });
            expect(results).toHaveLength(0);
        });
    });
});
