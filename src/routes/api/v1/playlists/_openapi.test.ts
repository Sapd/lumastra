// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    playlistResponseSchema,
    playlistsListResponseSchema,
    createPlaylistSchema,
} from '$lib/schemas/playlists';

describe('playlist schemas — GET/POST /api/v1/playlists contract parity', () => {
    describe('playlistResponseSchema (POST response)', () => {
        it('accepts the bare playlist object transformPlaylistRow() actually sends', () => {
            // Real handler output: visibility (not isPublic), plus ownerUsername/role/
            // playlistType/coverImage/coverItems — none of which the old local
            // PlaylistSchema declared.
            const result = playlistResponseSchema.safeParse({
                id: 99,
                owner: {
                    userId: '550e8400-e29b-41d4-a716-446655440000',
                    displayName: 'alice',
                    images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
                },
                revision: 0,
                memberCount: 0,
                isSystem: false,
                description: null,
                name: 'My Public List',
                visibility: 'public',
                playlistType: 'general',
                images: {
                    primary: {
                        href: 'https://example.com/cover.jpg?v=1',
                        revision: '1',
                        source: 'self',
                    },
                },
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                role: 'owner',
                itemCount: 0,
                coverItems: [],
            });
            expect(result.success).toBe(true);
        });

        it('rejects a response wrapped in {playlist: {...}} — handler returns the object bare', () => {
            const result = playlistResponseSchema.safeParse({
                playlist: {
                    id: 99,
                    owner: {
                        userId: '550e8400-e29b-41d4-a716-446655440000',
                        displayName: 'alice',
                        images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
                    },
                    revision: 0,
                    memberCount: 0,
                    isSystem: false,
                    description: null,
                    images: {},
                    name: 'My Public List',
                    visibility: 'public',
                    playlistType: 'general',
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                    role: 'owner',
                    itemCount: 0,
                },
            });
            expect(result.success).toBe(false);
        });
    });

    describe('playlistsListResponseSchema (GET response)', () => {
        it('accepts the {items, page} envelope with visibility-based playlist items', () => {
            const result = playlistsListResponseSchema.safeParse({
                items: [
                    {
                        id: 1,
                        owner: {
                            userId: '550e8400-e29b-41d4-a716-446655440000',
                            displayName: 'alice',
                            images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
                        },
                        revision: 0,
                        memberCount: 0,
                        isSystem: false,
                        description: null,
                        images: {},
                        name: 'Shared List',
                        visibility: 'private',
                        playlistType: 'music',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        role: 'editor',
                        itemCount: 3,
                    },
                ],
                page: { limit: 50, offset: 0, hasMore: false },
            });
            expect(result.success).toBe(true);
        });

        it('rejects items using isPublic instead of visibility', () => {
            const result = playlistsListResponseSchema.safeParse({
                items: [
                    {
                        id: 1,
                        owner: {
                            userId: '550e8400-e29b-41d4-a716-446655440000',
                            displayName: 'alice',
                            images: { primary: { href: '/avatar', revision: '0', source: 'self' } },
                        },
                        revision: 0,
                        memberCount: 0,
                        isSystem: false,
                        description: null,
                        images: {},
                        name: 'Shared List',
                        isPublic: false,
                        playlistType: 'music',
                        createdAt: new Date().toISOString(),
                        updatedAt: new Date().toISOString(),
                        role: 'editor',
                        itemCount: 3,
                    },
                ],
                page: { limit: 50, offset: 0, hasMore: false },
            });
            expect(result.success).toBe(false);
        });
    });

    describe('createPlaylistSchema (POST body)', () => {
        it('accepts visibility (not isPublic) as the create-body field', () => {
            const result = createPlaylistSchema.safeParse({
                name: 'My Public List',
                visibility: 'public',
            });
            expect(result.success).toBe(true);
            expect(result.data?.visibility).toBe('public');
        });
    });
});
