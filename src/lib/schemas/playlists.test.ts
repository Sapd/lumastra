// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

/**
 * Unit tests for playlist request schemas (validation edge cases).
 *
 * Covers:
 *   • reorderItemsSchema — position uniqueness + bounds
 *   • playlistMemberByIdParamsSchema — Q8 UUID path params (D6)
 *   • addMemberByIdSchema — v1 invite-by-UUID schema (D6)
 */

import { describe, it, expect } from 'vitest';
import {
    reorderItemsSchema,
    playlistMemberByIdParamsSchema,
    addMemberByIdSchema,
    playbackContextResponseSchema,
    playbackContextQuerySchema,
    addPlaylistItemSchema,
    playlistEntrySchema,
} from './playlists';

describe('reorderItemsSchema', () => {
    it('requires a revision and accepts a complete order, including an empty playlist', () => {
        expect(reorderItemsSchema.safeParse({ expectedRevision: 0, entryIds: [] }).success).toBe(
            true,
        );
        expect(
            reorderItemsSchema.safeParse({ expectedRevision: 3, entryIds: [3, 1, 2] }).success,
        ).toBe(true);
    });
    it.each([-1, 0.5, '1', undefined])('rejects invalid revision %s', (expectedRevision) => {
        expect(reorderItemsSchema.safeParse({ expectedRevision, entryIds: [1] }).success).toBe(
            false,
        );
    });
    it('rejects the retired position-map payload and accepts complete large orders', () => {
        expect(reorderItemsSchema.safeParse({ items: [{ id: 1, position: 0 }] }).success).toBe(
            false,
        );
        expect(
            reorderItemsSchema.safeParse({
                expectedRevision: 0,
                entryIds: Array.from({ length: 5001 }, (_, i) => i + 1),
            }).success,
        ).toBe(false);
        expect(
            reorderItemsSchema.safeParse({
                expectedRevision: 0,
                entryIds: Array.from({ length: 5000 }, (_, i) => i + 1),
            }).success,
        ).toBe(true);
    });
});

// ── D6 / Q8 — UUID-keyed member schemas ──────────────────────────────────────

const VALID_UUID = '550e8400-e29b-41d4-a716-446655440000';

describe('playlistMemberByIdParamsSchema (D6 / Q8)', () => {
    it('accepts a positive integer id and a valid UUID userId', () => {
        const result = playlistMemberByIdParamsSchema.safeParse({
            id: '42',
            userId: VALID_UUID,
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.id).toBe(42);
            expect(result.data.userId).toBe(VALID_UUID);
        }
    });

    it('coerces string id to number', () => {
        const result = playlistMemberByIdParamsSchema.safeParse({
            id: '7',
            userId: VALID_UUID,
        });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.id).toBe(7);
    });

    it('rejects id=0 (must be positive)', () => {
        const result = playlistMemberByIdParamsSchema.safeParse({
            id: '0',
            userId: VALID_UUID,
        });
        expect(result.success).toBe(false);
    });

    it('rejects a negative id', () => {
        const result = playlistMemberByIdParamsSchema.safeParse({
            id: '-5',
            userId: VALID_UUID,
        });
        expect(result.success).toBe(false);
    });

    it('rejects a non-UUID userId', () => {
        const result = playlistMemberByIdParamsSchema.safeParse({
            id: '1',
            userId: 'alice',
        });
        expect(result.success).toBe(false);
    });

    it('rejects an empty userId', () => {
        const result = playlistMemberByIdParamsSchema.safeParse({
            id: '1',
            userId: '',
        });
        expect(result.success).toBe(false);
    });
});

describe('addMemberByIdSchema (D6 / Q8 — v1 invite-by-UUID)', () => {
    it('accepts a valid userId UUID and a known role', () => {
        const result = addMemberByIdSchema.safeParse({
            userId: VALID_UUID,
            role: 'editor',
        });
        expect(result.success).toBe(true);
        if (result.success) {
            expect(result.data.userId).toBe(VALID_UUID);
            expect(result.data.role).toBe('editor');
        }
    });

    it('accepts role=readonly', () => {
        const result = addMemberByIdSchema.safeParse({
            userId: VALID_UUID,
            role: 'readonly',
        });
        expect(result.success).toBe(true);
    });

    it('rejects a non-UUID userId', () => {
        const result = addMemberByIdSchema.safeParse({
            userId: 'alice',
            role: 'editor',
        });
        expect(result.success).toBe(false);
    });

    it('rejects an unknown role', () => {
        const result = addMemberByIdSchema.safeParse({
            userId: VALID_UUID,
            role: 'superadmin',
        });
        expect(result.success).toBe(false);
    });

    it('rejects role=owner (non-invitable, owner is the creator)', () => {
        // memberRoleSchema is z.enum(['editor', 'readonly']) — owner is not
        // an invitable role; ownership transfers are out of scope for D6.
        const result = addMemberByIdSchema.safeParse({
            userId: VALID_UUID,
            role: 'owner',
        });
        expect(result.success).toBe(false);
    });

    it('rejects missing userId', () => {
        const result = addMemberByIdSchema.safeParse({ role: 'editor' });
        expect(result.success).toBe(false);
    });

    it('rejects missing role', () => {
        const result = addMemberByIdSchema.safeParse({ userId: VALID_UUID });
        expect(result.success).toBe(false);
    });
});

// ============================================================================
// Playback state on the two playlist item surfaces
// ============================================================================

/**
 * These schemas are RESPONSE schemas declared in the endpoints' `docs.200`,
 * which activates the mount gate — anything the schema does not declare is
 * silently STRIPPED from the wire payload. So a field being present in the
 * handler is not sufficient; it must be admitted here too. These tests are the
 * guard against a field that looks implemented but never reaches the client.
 */
describe('playback state survives the response schemas', () => {
    const PLAYBACK = {
        positionSeconds: 1891,
        durationMs: 3502000,
        lastPlayedAt: '2026-07-18T12:50:24.190Z',
        playbackWatched: false,
    };

    it('playlist entry (playback-context / in-player panels) keeps all four', () => {
        const result = playlistEntrySchema.safeParse({
            id: 605,
            mediaId: '237454b4-8ddf-45cf-8345-fd5c8558f236',
            title: 'A Movie',
            mediaType: 'movie',
            addedAt: '2026-07-21T15:43:49.850Z',
            position: 0,
            watched: false,
            posterUrl: null,
            ...PLAYBACK,
        });
        expect(result.success).toBe(true);
        expect(result.success && result.data).toMatchObject(PLAYBACK);
    });

    it('playlistEntrySchema (items feed) keeps all four', () => {
        const result = playlistEntrySchema.safeParse({
            id: 605,
            mediaId: '237454b4-8ddf-45cf-8345-fd5c8558f236',
            mediaType: 'movie',
            title: 'A Movie',
            position: 0,
            addedAt: '2026-07-21T15:43:49.850Z',
            watched: false,
            ...PLAYBACK,
        });
        expect(result.success).toBe(true);
        expect(result.success && result.data).toMatchObject(PLAYBACK);
    });

    it('accepts an audiobook returned in the system Watchlist without changing its type', () => {
        const result = playlistEntrySchema.parse({
            id: 606,
            mediaId: '237454b4-8ddf-45cf-8345-fd5c8558f236',
            mediaType: 'audiobook',
            title: 'An Audiobook',
            position: 0,
            addedAt: '2026-07-21T15:43:49.850Z',
            watched: false,
        });
        expect(result.mediaType).toBe('audiobook');
    });

    it('both surfaces accept an item with no playback state (all four absent)', () => {
        const browser = playlistEntrySchema.safeParse({
            id: 605,
            mediaId: '237454b4-8ddf-45cf-8345-fd5c8558f236',
            title: 'A Movie',
            mediaType: 'movie',
            addedAt: '2026-07-21T15:43:49.850Z',
            position: 0,
            watched: false,
            posterUrl: null,
        });
        expect(browser.success).toBe(true);
        expect(browser.success && browser.data.positionSeconds).toBeUndefined();
    });
});

describe('playlist catalog input and bounded playback selectors', () => {
    const mediaId = '550e8400-e29b-41d4-a716-446655440000';
    it('accepts 1–500 catalog UUIDs only', () => {
        expect(addPlaylistItemSchema.safeParse({ mediaIds: [mediaId] }).success).toBe(true);
        expect(
            addPlaylistItemSchema.safeParse({ mediaIds: Array(500).fill(mediaId) }).success,
        ).toBe(true);
        expect(addPlaylistItemSchema.safeParse({ mediaIds: [] }).success).toBe(false);
        expect(
            addPlaylistItemSchema.safeParse({ mediaIds: Array(501).fill(mediaId) }).success,
        ).toBe(false);
        expect(addPlaylistItemSchema.safeParse({ mediaIds: ['tmdb:123'] }).success).toBe(false);
        expect(
            addPlaylistItemSchema.safeParse({ mediaIds: [mediaId], title: 'Client metadata' })
                .success,
        ).toBe(false);
    });
    it.each([{ entryId: '4' }, { position: '0' }, { mediaId }])(
        'accepts one selector %j',
        (query) => {
            expect(playbackContextQuerySchema.safeParse(query).success).toBe(true);
        },
    );
    it.each([
        {},
        { entryId: 1, position: 0 },
        { mediaId, position: 0 },
        { itemId: mediaId },
        { internalId: mediaId },
    ])('rejects ambiguous or retired selectors %j', (query) => {
        expect(playbackContextQuerySchema.safeParse(query).success).toBe(false);
    });
    it('context uses the same entry schema and has no complete items array', () => {
        const entry = {
            id: 3,
            mediaId,
            mediaType: 'movie',
            title: 'Film',
            addedAt: '2026-01-01T00:00:00Z',
            position: 0,
            watched: false,
        };
        const parsed = playbackContextResponseSchema.parse({
            playlist: { id: 1, name: 'Films', totalItems: 1 },
            current: entry,
            previous: null,
            next: null,
        });
        expect(parsed.current.mediaId).toBe(mediaId);
        expect(parsed).not.toHaveProperty('items');
    });
});
