// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import type postgres from 'postgres';
import type { RequestEvent } from '@sveltejs/kit';
import type { UserContext } from '$lib/server/types.js';
import type { ApiContext } from '$lib/server/api/define.js';
import type { UserId } from '$lib/shared/user-id.js';
import { getTestDb, closeTestDb } from '../../../../../../tests/integration/setup/test-database.js';
import {
    truncateTables,
    TEST_TABLES,
} from '../../../../../../tests/integration/helpers/cleanup.js';
import {
    createAndInsertTestMovie,
    ensureTestUser,
    generateTestUserId,
} from '../../../../../../tests/integration/fixtures/index.js';
import { createAnnotation } from '$lib/server/database/queries/media-annotations.queries.js';

// Keep the annotation reader real: only unrelated endpoint dependencies are
// mocked, so removing caller propagation hides the actual seeded own content.
vi.mock('$lib/server/database/connection.js', () => ({ getDb: () => getTestDb() }));
vi.mock('$lib/server/config.js', () => ({
    features: { social: true, mediaAnnotations: true, socialReviews: true },
    config: { ANNOTATIONS_MAX_PINS: 5 },
}));
vi.mock('$lib/server/middleware/media-access.js', () => ({
    checkMediaAccess: vi.fn(async () => true),
}));
vi.mock('$lib/server/database/queries/social-activity.queries.js', () => ({
    getMediaTypeAndParent: vi.fn(async (_sql: unknown, id: string) => ({
        id,
        media_type: 'movie',
        parent_id: null,
    })),
    getRatedActivities: vi.fn(async () => []),
    getWatchedActivities: vi.fn(async () => []),
    getAudiobookListeningActivities: vi.fn(async () => []),
    getOwnAudiobookListening: vi.fn(async () => null),
    getAudiobookChapterTable: vi.fn(async () => []),
    resolveExternalIdToMediaId: vi.fn(async () => null),
}));
vi.mock('$lib/server/database/queries/media-queries.js', () => ({
    resolveMediaIdByProvider: vi.fn(async () => null),
}));
vi.mock('$lib/server/services/media-id-resolver.js', () => ({
    mediaIdResolver: { resolveAnyMediaId: vi.fn(async () => ({ internalId: null })) },
}));
vi.mock('$lib/paraglide/messages.js', async (importOriginal) => ({
    ...(await importOriginal<typeof import('$lib/paraglide/messages.js')>()),
    social_reviewed: () => 'reviewed',
}));

import { def } from './media-id-annotations.js';
import { buildWatchActivity } from '../integrations/social-watch-activity.js';

function user(userId: UserId): UserContext {
    return {
        userId,
        username: userId,
        groups: '',
        userGroups: [],
        hasWatchPermission: true,
        hasLiveTvPermission: false,
        hasRequestPermission: false,
        hasMediaAnnotationPermission: true,
        hasReviewPermission: true,
        ownerIsAdmin: false,
        maxAgeRating: null,
        isAgeRestricted: false,
        isModerator: false,
        liveTvPriority: 'low',
    };
}

describe('annotation and social callers preserve only the private author’s own content (Integration)', () => {
    let sql: postgres.Sql;
    let mediaId: string;
    let hiddenAuthor: UserId;
    let otherCaller: UserId;

    beforeAll(() => {
        sql = getTestDb();
    });
    afterAll(async () => {
        await closeTestDb();
    });
    beforeEach(async () => {
        await truncateTables(sql, [...TEST_TABLES.media, 'media_annotations']);
        ({ id: mediaId } = await createAndInsertTestMovie(sql));
        hiddenAuthor = generateTestUserId();
        otherCaller = generateTestUserId();
        await ensureTestUser(sql, hiddenAuthor);
        await ensureTestUser(sql, otherCaller);
        await sql`UPDATE users SET hide_streams = true WHERE id = ${hiddenAuthor}`;
        for (const type of ['chat', 'pin', 'review'] as const) {
            await createAnnotation(sql, {
                mediaId,
                userId: hiddenAuthor,
                type,
                content: `Private ${type}`,
                timestampSeconds: type === 'pin' ? 10 : undefined,
            });
        }
    });

    it('annotation GET returns own private chat, pin and review but hides them from another caller', async () => {
        const list = async (caller: UserId): Promise<{ items: { content: string }[] }> => {
            const url = new URL(`http://localhost/api/media/${mediaId}/annotations`);
            const event = {
                url,
                request: new Request(url),
                params: { id: mediaId },
                locals: { user: user(caller), resolvedIds: { internalId: mediaId } },
            } as unknown as RequestEvent;
            const response = (await def.handlers.GET!(event, {
                surface: 'internal',
                input: { query: { limit: 50, offset: 0 } },
            } as unknown as ApiContext)) as Response;
            expect(response.status).toBe(200);
            return response.json();
        };
        expect((await list(hiddenAuthor)).items.map((item) => item.content)).toEqual([
            'Private chat',
            'Private pin',
            'Private review',
        ]);
        expect((await list(otherCaller)).items).toEqual([]);
    });

    it.each(['internal', 'v1'] as const)(
        'social builder on %s returns own private review but hides it from another caller',
        async (surface) => {
            const own = await buildWatchActivity(sql, mediaId, user(hiddenAuthor), surface);
            expect(own.ok).toBe(true);
            if (!own.ok) throw new Error('Expected successful own social response');
            expect(own.body.activities).toEqual([
                expect.objectContaining({
                    author: expect.objectContaining({ userId: hiddenAuthor }),
                    review: 'Private review',
                    isSelf: true,
                }),
            ]);
            const other = await buildWatchActivity(sql, mediaId, user(otherCaller), surface);
            expect(other.ok).toBe(true);
            if (!other.ok) throw new Error('Expected successful other social response');
            expect(other.body.activities).toEqual([]);
        },
    );
});
