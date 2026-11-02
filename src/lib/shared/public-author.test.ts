// SPDX-FileCopyrightText: 2026 Denis Arnst (Sapd)
// SPDX-License-Identifier: AGPL-3.0-only

import { describe, expect, it, vi } from 'vitest';
import { publicAuthorSchema } from '$lib/schemas/public-author';
import { userAvatarSet } from './image-descriptor';
import { buildPublicAuthor } from './public-author';

vi.mock('$app/paths', () => ({ base: '' }));

const id = '00000000-0000-4000-8000-000000000001';

describe('buildPublicAuthor', () => {
    it('advertises a generated avatar descriptor that resolves for users without an avatar', () => {
        const { primary } = buildPublicAuthor(id, null, 'v1').images;
        // The bare byte route answers 404 when there is no avatar anywhere; the initials
        // fallback makes the advertised href always resolvable.
        expect(primary.href).toBe(`/api/v1/users/${id}/images/avatar?size=card&v=0&fallback=initials`);
        expect(primary.variants?.thumb).toBe(
            `/api/v1/users/${id}/images/avatar?size=thumb&v=0&fallback=initials`,
        );
        expect(primary.source).toBe('generated');
        expect(primary.revision).toBe('0');
    });

    it('uses the given image set verbatim, so the avatar matches GET /users', () => {
        const images = userAvatarSet('v1', { userId: id, version: '42' });
        const author = buildPublicAuthor(id, 'Anna', 'v1', images);
        expect(author.images.primary).toBe(images.primary);
        expect(author.images.primary.source).toBe('self');
        expect(author.images.primary.revision).toBe('42');
    });

    it('builds a schema-valid author and keeps a null display name', () => {
        const author = buildPublicAuthor(id, null, 'internal');
        expect(author.displayName).toBeNull();
        expect(publicAuthorSchema.parse(author)).toEqual(author);
        expect(author.images.primary.href).toContain('fallback=initials');
    });
});
