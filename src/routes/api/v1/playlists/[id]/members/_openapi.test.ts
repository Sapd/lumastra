// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, it, expect } from 'vitest';
import {
    membersListResponseSchema,
    memberAddedResponseSchema,
    addMemberByIdSchema,
} from '$lib/schemas/playlists';

describe('playlist member schemas — GET/POST /api/v1/playlists/{id}/members contract parity', () => {
    describe('membersListResponseSchema (GET response)', () => {
        it('accepts the real member shape {author, role, status, invitedAt}', () => {
            const result = membersListResponseSchema.safeParse({
                items: [
                    {
                        author: {
                            userId: '550e8400-e29b-41d4-a716-446655440000',
                            displayName: 'Bob',
                            images: {
                                primary: { href: '/api/v1/users/550e8400-e29b-41d4-a716-446655440000/images/avatar', revision: '0', source: 'self' },
                            },
                        },
                        role: 'editor',
                        status: 'accepted',
                        invitedAt: new Date().toISOString(),
                    },
                ],
                page: { limit: 100, offset: 0, hasMore: false },
            });
            expect(result.success).toBe(true);
        });

        it('rejects the old copy-pasted playlist-item shape {id, mediaId, sortOrder, addedAt}', () => {
            const result = membersListResponseSchema.safeParse({
                items: [
                    {
                        id: 'item-1',
                        mediaId: 'media-1',
                        sortOrder: 0,
                        addedAt: new Date().toISOString(),
                    },
                ],
                page: { limit: 100, offset: 0, hasMore: false },
            });
            expect(result.success).toBe(false);
        });
    });

    describe('memberAddedResponseSchema (POST response)', () => {
        it('accepts the bare member object the handler actually sends', () => {
            const result = memberAddedResponseSchema.safeParse({
                author: {
                    userId: '550e8400-e29b-41d4-a716-446655440000',
                    displayName: 'Bob',
                    images: {
                        primary: { href: '/api/v1/users/550e8400-e29b-41d4-a716-446655440000/images/avatar', revision: '0', source: 'self' },
                    },
                },
                role: 'editor',
                status: 'pending',
                invitedAt: new Date().toISOString(),
            });
            expect(result.success).toBe(true);
        });

        it('rejects a response wrapped in {member: {...}} — handler returns the object bare', () => {
            const result = memberAddedResponseSchema.safeParse({
                member: {
                    author: {
                        userId: '550e8400-e29b-41d4-a716-446655440000',
                        displayName: 'Bob',
                        images: {
                            primary: { href: '/api/v1/users/550e8400-e29b-41d4-a716-446655440000/images/avatar', revision: '0', source: 'self' },
                        },
                    },
                    role: 'editor',
                    status: 'pending',
                    invitedAt: new Date().toISOString(),
                },
            });
            expect(result.success).toBe(false);
        });
    });

    describe('addMemberByIdSchema (POST body)', () => {
        it('accepts {userId, role} — not {mediaId, sortOrder}', () => {
            const result = addMemberByIdSchema.safeParse({
                userId: '550e8400-e29b-41d4-a716-446655440000',
                role: 'readonly',
            });
            expect(result.success).toBe(true);
        });

        it('rejects the old copy-pasted playlist-item body shape {mediaId, sortOrder}', () => {
            const result = addMemberByIdSchema.safeParse({
                mediaId: 'media-1',
                sortOrder: 0,
            });
            expect(result.success).toBe(false);
        });
    });
});
