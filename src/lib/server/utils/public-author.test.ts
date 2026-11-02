// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getDb } from '$lib/server/database/connection.js';
import { getUserDisplayInfoByIds } from '$lib/server/database/queries/users.queries.js';
import { publicAuthorSchema } from '$lib/schemas/public-author.js';
import { userAvatarSet } from '$lib/shared/image-descriptor.js';
import { userImageSets } from '$lib/server/services/image-descriptor/avatars.js';
import { loadPublicAuthors, toPublicAuthor } from './public-author.js';

vi.mock('$app/paths', () => ({ base: '/lumastra' }));
vi.mock('$lib/server/database/connection.js', () => ({ getDb: vi.fn() }));
vi.mock('$lib/server/services/image-descriptor/avatars.js', () => ({
    userImageSets: vi.fn(),
}));
vi.mock('$lib/server/database/queries/users.queries.js', () => ({
    getUserDisplayInfoByIds: vi.fn(),
}));

const id = '00000000-0000-4000-8000-000000000001';
const other = '00000000-0000-4000-8000-000000000002';
const missing = '00000000-0000-4000-8000-000000000003';

describe('toPublicAuthor', () => {
    it('builds the generated avatar descriptor using the API base path', () => {
        const author = toPublicAuthor({ userId: id, displayName: 'Public name' });
        expect(author).toEqual({
            userId: id,
            displayName: 'Public name',
            images: {
                primary: expect.objectContaining({
                    href: `/lumastra/api/v1/users/${id}/images/avatar?size=card&v=0&fallback=initials`,
                    variants: expect.objectContaining({
                        thumb: `/lumastra/api/v1/users/${id}/images/avatar?size=thumb&v=0&fallback=initials`,
                    }),
                    revision: '0',
                    source: 'generated',
                }),
            },
        });
        expect(publicAuthorSchema.parse(author)).toEqual(author);
    });

    it('retains null names and supports the internal surface', () => {
        const author = toPublicAuthor({ userId: id, displayName: null }, 'internal');
        expect(author.displayName).toBeNull();
        expect(author.images.primary.href).toBe(
            `/lumastra/api/users/${id}/images/avatar?size=card&v=0&fallback=initials`,
        );
    });

    it('uses a given image set', () => {
        const images = userAvatarSet('v1', { userId: id, version: '7' });
        expect(toPublicAuthor({ userId: id, displayName: null }, 'v1', images).images.primary).toBe(
            images.primary,
        );
    });
});

describe('loadPublicAuthors', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('loads all display info in one batch and omits missing users', async () => {
        const sql = vi.fn() as unknown as NonNullable<ReturnType<typeof getDb>>;
        vi.mocked(getDb).mockReturnValue(sql);
        vi.mocked(getUserDisplayInfoByIds).mockResolvedValue([
            { id, display_name: null },
            { id: other, display_name: 'Public name' },
        ]);
        const sets = new Map([
            [id, userAvatarSet('v1', { userId: id, version: '5' })],
            [other, userAvatarSet('v1', { userId: other, version: '0', generated: true })],
        ]);
        vi.mocked(userImageSets).mockResolvedValue(sets);
        const authors = await loadPublicAuthors([id, other, id, missing]);
        expect(getUserDisplayInfoByIds).toHaveBeenCalledExactlyOnceWith(sql, [id, other, missing]);
        expect(userImageSets).toHaveBeenCalledExactlyOnceWith(sql, 'v1', [id, other, missing], { external: false });
        expect(authors.size).toBe(2);
        expect(authors.get(id)).toEqual(
            toPublicAuthor({ userId: id, displayName: null }, 'v1', sets.get(id)),
        );
        expect(authors.get(id)?.images.primary.revision).toBe('5');
        expect(authors.get(other)?.displayName).toBe('Public name');
        expect(authors.has(missing)).toBe(false);
    });

    it('does not access the database for an empty input', async () => {
        expect(await loadPublicAuthors([])).toEqual(new Map());
        expect(getDb).not.toHaveBeenCalled();
        expect(getUserDisplayInfoByIds).not.toHaveBeenCalled();
    });

    it('reports an unavailable database instead of silently omitting existing users', async () => {
        vi.mocked(getDb).mockReturnValue(null);
        await expect(loadPublicAuthors([id])).rejects.toThrow('Database is not available');
    });
});

describe('authorOrPlaceholder', () => {
    it('returns the loaded author, or a placeholder for a hard-deleted user', async () => {
        const { authorOrPlaceholder } = await import('./public-author.js');
        const known = toPublicAuthor({ userId: id, displayName: 'Known' });
        const map = new Map([[id, known]]);
        expect(authorOrPlaceholder(map, id)).toBe(known);
        const placeholder = authorOrPlaceholder(map, missing);
        expect(placeholder.userId).toBe(missing);
        expect(placeholder.displayName).toBeNull();
        expect(publicAuthorSchema.parse(placeholder)).toEqual(placeholder);
    });
});
